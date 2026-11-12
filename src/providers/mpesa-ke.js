// M-Pesa Kenya: Safaricom Daraja API.
// Real sandbox base URL: https://sandbox.safaricom.co.ke

import crypto from 'node:crypto';
import { deliver, parseJson } from '../core/callbacks.js';
import {
  eat, hex, isHttpUrl, isLocalUrl, isPositiveAmount, normaliseMsisdn, randomAlnum, randomDigits, stamp14, stampDotted,
} from '../core/util.js';

const ID = 'mpesa-ke';

const STK_RESULT = {
  success: [0, 'The service request is processed successfully.'],
  cancelled: [1032, 'Request cancelled by user'],
  timeout: [1037, 'DS timeout user cannot be reached'],
  wrong_pin: [2001, 'The initiator information is invalid.'],
  insufficient_funds: [1, 'The balance is insufficient for the transaction.'],
  failed: [1025, 'An error occurred while sending a push request'],
};

const requestId = () => `${randomDigits(5)}-${randomDigits(8)}-1`;
const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const money = (n) => Number(n).toFixed(2);

function fail(ctx, status, errorCode, errorMessage) {
  ctx.send(status, { requestId: requestId(), errorCode, errorMessage });
  return false;
}

function authorised(ctx) {
  const token = ctx.bearer();
  if (token && ctx.sb.tokenState(ID, token) === 'valid') return true;
  return fail(ctx, 404, '404.001.03', 'Invalid Access Token');
}

function requireFields(ctx, fields) {
  if (ctx.badJson) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid JSON payload');
  for (const f of fields) {
    if (blank(ctx.body[f])) return fail(ctx, 400, '400.002.02', `Bad Request - Invalid ${f}`);
  }
  return true;
}

function lintCallbackUrl(ctx, url, field) {
  // Localhost is the whole point of a local sandbox, so only flag public URLs that are not HTTPS.
  if (url && !isLocalUrl(url) && !String(url).startsWith('https://')) {
    ctx.warn(`${field} is not HTTPS. Production Daraja requires HTTPS callback URLs.`);
  }
}

function conversationIds(given) {
  const t = eat();
  return {
    ConversationID: `AG_${t.YYYY}${t.MM}${t.DD}_${hex(20)}`,
    OriginatorConversationID: given || requestId(),
  };
}

function resultPayload(txn, code, desc, params, queueUrl) {
  const Result = {
    ResultType: 0,
    ResultCode: code,
    ResultDesc: desc,
    OriginatorConversationID: txn.ids.OriginatorConversationID,
    ConversationID: txn.ids.ConversationID,
    TransactionID: txn.receipt || randomAlnum(10),
  };
  if (params) Result.ResultParameters = { ResultParameter: Object.entries(params).map(([Key, Value]) => ({ Key, Value })) };
  Result.ReferenceData = { ReferenceItem: { Key: 'QueueTimeoutURL', Value: queueUrl } };
  return { Result };
}

function stkCallback(txn) {
  const [ResultCode, ResultDesc] = STK_RESULT[txn.outcome] || STK_RESULT.failed;
  const stkCallback = {
    MerchantRequestID: txn.ids.MerchantRequestID,
    CheckoutRequestID: txn.ids.CheckoutRequestID,
    ResultCode,
    ResultDesc,
  };
  if (txn.outcome === 'success') {
    stkCallback.CallbackMetadata = {
      Item: [
        { Name: 'Amount', Value: txn.amount },
        { Name: 'MpesaReceiptNumber', Value: txn.receipt },
        { Name: 'Balance' }, // Daraja really does send this item without a Value
        { Name: 'TransactionDate', Value: Number(stamp14(new Date(txn.resolvedAt))) },
        { Name: 'PhoneNumber', Value: Number(txn.msisdn) },
      ],
    };
  }
  return { Body: { stkCallback } };
}

/**
 * A customer pays a paybill or till from their own phone (no prompt from you).
 * Runs the validation and confirmation webhooks registered for the shortcode.
 */
export async function customerPaysBusiness(sb, { shortcode, msisdn, amount, billRef = '', commandId = 'CustomerPayBillOnline' }) {
  const state = sb.providerState[ID];
  const reg = state.c2b.get(String(shortcode));
  const wallet = sb.wallet(msisdn);
  const paybill = commandId !== 'CustomerBuyGoodsOnline';
  const txn = sb.newTxn({
    provider: ID, country: 'KE', kind: 'collection', amount, msisdn,
    merchant: String(shortcode), reference: billRef,
    description: `Customer-initiated ${paybill ? 'Pay Bill' : 'Buy Goods'}`,
    request: { ShortCode: shortcode, CommandID: commandId, Amount: amount, Msisdn: msisdn, BillRefNumber: billRef },
  });
  if (wallet.balance < txn.amount) return sb.finish(txn, 'insufficient_funds', 'customer balance too low, nothing is sent to you');

  const transId = randomAlnum(10);
  const [first, ...rest] = wallet.name.split(' ');
  const v2 = reg?.version === 'v2';
  const payload = {
    TransactionType: paybill ? 'Pay Bill' : 'Buy Goods',
    TransID: transId,
    TransTime: stamp14(),
    TransAmount: money(txn.amount),
    BusinessShortCode: String(shortcode),
    BillRefNumber: paybill ? String(billRef) : '',
    InvoiceNumber: '',
    OrgAccountBalance: '',
    ThirdPartyTransID: '',
    // Daraja no longer exposes the raw number: v1 sends a SHA-256 hash, v2 a masked number.
    MSISDN: v2 ? `${msisdn.slice(0, 4)} ***** ${msisdn.slice(-3)}` : crypto.createHash('sha256').update(msisdn).digest('hex'),
    FirstName: first.toUpperCase(),
    MiddleName: '',
    LastName: rest.join(' ').toUpperCase(),
  };

  if (!reg) {
    txn.warnings.push(`No C2B URLs are registered for shortcode ${shortcode}, so no confirmation was sent. Call /mpesa/c2b/v1/registerurl first.`);
  } else if (reg.validation) {
    const attempt = await deliver(sb, txn, { label: 'C2B validation', url: reg.validation, payload, chaos: false });
    const reply = attempt.ok ? parseJson(attempt.response) : null;
    let accepted;
    if (reply && reply.ResultCode !== undefined) accepted = String(reply.ResultCode) === '0';
    else {
      accepted = reg.responseType !== 'Cancelled';
      sb.event(txn, 'validation', `Validation URL gave no usable answer. Default action "${reg.responseType}" applied`);
    }
    if (!accepted) return sb.finish(txn, 'failed', `rejected by your validation URL (ResultCode ${reply?.ResultCode ?? 'n/a'})`);
  }

  sb.finish(txn, 'success');
  txn.receipt = transId;
  if (reg?.confirmation) {
    payload.OrgAccountBalance = money(sb.float(ID));
    await deliver(sb, txn, { label: 'C2B confirmation', url: reg.confirmation, payload });
  }
  return txn;
}

export default {
  id: ID,
  name: 'M-Pesa Kenya',
  api: 'Safaricom Daraja',
  country: 'KE',
  realBaseUrl: 'https://sandbox.safaricom.co.ke',

  setup(sb) {
    sb.providerState[ID] = {
      c2b: new Map(),
      reset() { this.c2b.clear(); },
    };
  },

  routes(r, sb) {
    const cred = () => sb.credentials[ID];

    // ---- OAuth ------------------------------------------------------------
    r.get('/oauth/v1/generate', (ctx) => {
      if (ctx.query.grant_type !== 'client_credentials') return fail(ctx, 400, '400.008.02', 'Invalid grant type passed');
      const m = /^basic\s+(.+)$/i.exec(ctx.headers.authorization || '');
      const [key, secret] = m ? Buffer.from(m[1], 'base64').toString().split(':') : [];
      if (!key || !secret) return fail(ctx, 400, '400.008.01', 'Invalid Authentication passed');
      if (key !== cred().consumerKey || secret !== cred().consumerSecret) {
        if (sb.settings.strict) return fail(ctx, 400, '400.008.01', 'Invalid Authentication passed');
        ctx.warn('Consumer key or secret does not match the sandbox credentials. Accepted because strict mode is off.');
      }
      ctx.send(200, { access_token: sb.issueToken(ID, 3599), expires_in: '3599' });
    });

    // ---- M-Pesa Express (STK push) ----------------------------------------
    r.post('/mpesa/stkpush/v1/processrequest', (ctx) => {
      if (!authorised(ctx)) return;
      const required = ['BusinessShortCode', 'Password', 'Timestamp', 'TransactionType', 'Amount', 'PartyA', 'PartyB', 'PhoneNumber', 'CallBackURL', 'AccountReference', 'TransactionDesc'];
      if (!requireFields(ctx, required)) return;
      const b = ctx.body;
      if (!['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'].includes(b.TransactionType)) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid TransactionType');
      if (!isPositiveAmount(b.Amount)) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid Amount');
      if (!/^\d{14}$/.test(String(b.Timestamp))) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid Timestamp');
      if (!isHttpUrl(b.CallBackURL)) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid CallBackURL');
      const phone = normaliseMsisdn(b.PhoneNumber, 'KE');
      if (!/^254\d{9}$/.test(phone)) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid PhoneNumber');

      if (String(b.BusinessShortCode) === cred().shortcode) {
        const expected = Buffer.from(`${cred().shortcode}${cred().passkey}${b.Timestamp}`).toString('base64');
        if (b.Password !== expected) {
          if (sb.settings.strict) return fail(ctx, 500, '500.001.1001', 'Wrong credentials');
          ctx.warn('Password is not base64(ShortCode + Passkey + Timestamp). Real Daraja answers "Wrong credentials".');
        }
      }
      if (String(b.PhoneNumber) !== phone) ctx.warn('PhoneNumber should be in the format 2547XXXXXXXX.');
      if (!Number.isInteger(Number(b.Amount))) ctx.warn('Amount should be a whole number. Daraja does not accept cents.');
      if (String(b.AccountReference).length > 12) ctx.warn('AccountReference is longer than 12 characters and will be cut off on the phone.');
      if (String(b.TransactionDesc).length > 13) ctx.warn('TransactionDesc is longer than 13 characters.');
      lintCallbackUrl(ctx, b.CallBackURL, 'CallBackURL');

      const busy = sb.findTxn((t) => t.provider === ID && t.status === 'pending' && t.msisdn === phone && t.prompt);
      if (busy) return fail(ctx, 500, '500.001.1001', 'Unable to lock subscriber, a transaction is already in process for the current subscriber');

      const t = eat();
      const ids = {
        MerchantRequestID: requestId(),
        CheckoutRequestID: `ws_CO_${t.DD}${t.MM}${t.YYYY}${t.hh}${t.mm}${t.ss}${randomDigits(9)}`,
      };
      const txn = sb.newTxn({
        provider: ID, country: 'KE', kind: 'collection', amount: b.Amount, msisdn: phone,
        merchant: String(b.PartyB), reference: String(b.AccountReference), description: String(b.TransactionDesc),
        ids, request: b, warnings: ctx.warnings,
      });
      ctx.send(200, {
        ...ids,
        ResponseCode: '0',
        ResponseDescription: 'Success. Request accepted for processing',
        CustomerMessage: 'Success. Request accepted for processing',
      });
      sb.prompt(txn, ctx, async (done) => {
        if (done.outcome === 'success') done.receipt = randomAlnum(10);
        await deliver(sb, done, { label: 'STK callback', url: b.CallBackURL, payload: stkCallback(done) });
      });
    });

    r.post('/mpesa/stkpushquery/v1/query', (ctx) => {
      if (!authorised(ctx)) return;
      if (!requireFields(ctx, ['BusinessShortCode', 'Password', 'Timestamp', 'CheckoutRequestID'])) return;
      const txn = sb.findTxn((t) => t.provider === ID && t.ids.CheckoutRequestID === ctx.body.CheckoutRequestID);
      if (!txn) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid CheckoutRequestID');
      if (txn.status === 'pending') return fail(ctx, 500, '500.001.1001', 'The transaction is being processed');
      const [code, desc] = STK_RESULT[txn.outcome] || STK_RESULT.failed;
      ctx.send(200, {
        ResponseCode: '0',
        ResponseDescription: 'The service request has been accepted successsfully', // sic, as Daraja spells it
        MerchantRequestID: txn.ids.MerchantRequestID,
        CheckoutRequestID: txn.ids.CheckoutRequestID,
        ResultCode: String(code),
        ResultDesc: desc,
      });
    });

    // ---- C2B (paybill / till payments started by the customer) --------------
    const registerUrl = (version) => (ctx) => {
      if (!authorised(ctx)) return;
      if (!requireFields(ctx, ['ShortCode', 'ResponseType', 'ConfirmationURL'])) return;
      const b = ctx.body;
      if (!['Completed', 'Cancelled'].includes(b.ResponseType)) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid ResponseType');
      for (const f of ['ConfirmationURL', 'ValidationURL']) {
        if (blank(b[f])) continue;
        if (!isHttpUrl(b[f])) return fail(ctx, 400, '400.002.02', `Bad Request - Invalid ${f}`);
        if (/mpesa|m-pesa|safaricom/i.test(b[f])) ctx.warn(`${f} contains "mpesa" or "safaricom". Daraja rejects URLs with those words.`);
        lintCallbackUrl(ctx, b[f], f);
      }
      sb.providerState[ID].c2b.set(String(b.ShortCode), {
        confirmation: b.ConfirmationURL, validation: b.ValidationURL || '', responseType: b.ResponseType, version,
      });
      sb.changed();
      // "OriginatorCoversationID" is Daraja's own spelling.
      ctx.send(200, { OriginatorCoversationID: requestId(), ResponseCode: '0', ResponseDescription: 'Success' });
    };
    r.post('/mpesa/c2b/v1/registerurl', registerUrl('v1'));
    r.post('/mpesa/c2b/v2/registerurl', registerUrl('v2'));

    const simulate = (ctx) => {
      if (!authorised(ctx)) return;
      if (!requireFields(ctx, ['ShortCode', 'CommandID', 'Amount', 'Msisdn'])) return;
      const b = ctx.body;
      if (!isPositiveAmount(b.Amount)) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid Amount');
      const msisdn = normaliseMsisdn(b.Msisdn, 'KE');
      if (!/^254\d{9}$/.test(msisdn)) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid Msisdn');
      ctx.send(200, { OriginatorCoversationID: requestId(), ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' });
      sb.later(() => customerPaysBusiness(sb, { shortcode: b.ShortCode, msisdn, amount: b.Amount, billRef: b.BillRefNumber, commandId: b.CommandID }), 50);
    };
    r.post('/mpesa/c2b/v1/simulate', simulate);
    r.post('/mpesa/c2b/v2/simulate', simulate);

    // ---- APIs that acknowledge first and post a Result later ----------------
    const asyncApi = (fields, run) => (ctx) => {
      if (!authorised(ctx)) return;
      if (!requireFields(ctx, [...fields, 'SecurityCredential', 'ResultURL', 'QueueTimeOutURL'])) return;
      const b = ctx.body;
      if (blank(b.Initiator) && blank(b.InitiatorName)) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid Initiator');
      for (const f of ['ResultURL', 'QueueTimeOutURL']) {
        if (!isHttpUrl(b[f])) return fail(ctx, 400, '400.002.02', `Bad Request - Invalid ${f}`);
        lintCallbackUrl(ctx, b[f], f);
      }
      const ids = conversationIds(b.OriginatorConversationID);
      const txn = run(ctx, b, ids);
      if (!txn) return;
      ctx.send(200, { ...ids, ResponseCode: '0', ResponseDescription: 'Accept the service request successfully.' });
    };
    const postResult = (txn, b, code, desc, params) =>
      deliver(sb, txn, { label: 'Result', url: b.ResultURL, payload: resultPayload(txn, code, desc, params, b.QueueTimeOutURL) });

    // B2C: pay a customer
    const b2c = asyncApi(['CommandID', 'Amount', 'PartyA', 'PartyB', 'Remarks'], (ctx, b, ids) => {
      if (!isPositiveAmount(b.Amount)) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid Amount');
      const msisdn = normaliseMsisdn(b.PartyB, 'KE');
      if (!/^254\d{9}$/.test(msisdn)) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid PartyB');
      const txn = sb.newTxn({
        provider: ID, country: 'KE', kind: 'disbursement', amount: b.Amount, msisdn,
        merchant: String(b.PartyA), reference: String(b.Occasion || ''), description: `B2C ${b.CommandID}`,
        ids, request: b, warnings: ctx.warnings,
      });
      sb.later(async () => {
        const outcome = sb.settleDisbursement(txn, ctx);
        if (outcome === 'success') {
          txn.receipt = randomAlnum(10);
          const float = money(sb.float(ID));
          return postResult(txn, b, 0, 'The service request is processed successfully.', {
            TransactionAmount: txn.amount,
            TransactionReceipt: txn.receipt,
            ReceiverPartyPublicName: `${msisdn} - ${sb.wallet(msisdn).name}`,
            TransactionCompletedDateTime: stampDotted(),
            B2CUtilityAccountAvailableFunds: Number(float),
            B2CWorkingAccountAvailableFunds: Number(float),
            B2CRecipientIsRegisteredCustomer: 'Y',
            B2CChargesPaidAccountAvailableFunds: 0,
          });
        }
        return outcome === 'insufficient_funds'
          ? postResult(txn, b, 1, 'The balance is insufficient for the transaction.')
          : postResult(txn, b, 2001, 'The initiator information is invalid.');
      }, sb.settings.autoDelayMs);
      return txn;
    });
    r.post('/mpesa/b2c/v1/paymentrequest', b2c);
    r.post('/mpesa/b2c/v3/paymentrequest', b2c);

    // Transaction status
    r.post('/mpesa/transactionstatus/v1/query', asyncApi(['CommandID', 'PartyA', 'IdentifierType'], (ctx, b, ids) => {
      if (blank(b.TransactionID) && blank(b.OriginalConversationID)) return fail(ctx, 400, '400.002.02', 'Bad Request - Invalid TransactionID');
      const original = sb.findTxn((t) => t.provider === ID && t.kind !== 'query'
        && ((b.TransactionID && t.receipt === b.TransactionID) || (b.OriginalConversationID && t.ids.OriginatorConversationID === b.OriginalConversationID)));
      const txn = sb.newTxn({
        provider: ID, country: 'KE', kind: 'query', description: `Transaction status query for ${b.TransactionID || b.OriginalConversationID}`,
        ids, request: b, warnings: ctx.warnings,
      });
      sb.later(() => {
        sb.finish(txn, 'success');
        if (!original || !original.receipt) return postResult(txn, b, 2032, 'The transaction receipt number does not exist.');
        txn.receipt = original.receipt;
        const customer = `${original.msisdn} - ${original.customerName}`;
        const business = `${original.merchant} - Pesalab Test Business`;
        const collected = original.kind === 'collection';
        return postResult(txn, b, 0, 'The service request is processed successfully.', {
          DebitPartyName: collected ? customer : business,
          CreditPartyName: collected ? business : customer,
          OriginatorConversationID: original.ids.OriginatorConversationID || original.ids.MerchantRequestID || '',
          InitiatedTime: Number(stamp14(new Date(original.createdAt))),
          DebitAccountType: collected ? 'MMF Account For Customer' : 'Utility Account',
          DebitPartyCharges: '',
          TransactionReason: '',
          ReasonType: collected ? 'Pay Bill Online' : 'Business Payment to Customer via API',
          TransactionStatus: original.status === 'reversed' ? 'Reversed' : 'Completed',
          FinalisedTime: Number(stamp14(new Date(original.resolvedAt))),
          Amount: original.amount,
          ConversationID: original.ids.ConversationID || '',
          ReceiptNo: original.receipt,
        });
      }, sb.settings.autoDelayMs);
      return txn;
    }));

    // Reversal
    r.post('/mpesa/reversal/v1/request', asyncApi(['CommandID', 'TransactionID', 'Amount', 'ReceiverParty'], (ctx, b, ids) => {
      const original = sb.findTxn((t) => t.provider === ID && t.kind !== 'query' && t.receipt === b.TransactionID);
      const txn = sb.newTxn({
        provider: ID, country: 'KE', kind: 'reversal', amount: b.Amount, msisdn: original?.msisdn || '',
        merchant: String(b.ReceiverParty), description: `Reversal of ${b.TransactionID}`, ids, request: b, warnings: ctx.warnings,
      });
      sb.later(() => {
        if (!original) {
          sb.finish(txn, 'failed', 'original transaction not found');
          return postResult(txn, b, 'R000002', 'The OriginalTransactionID is invalid.');
        }
        if (!sb.reverse(original, 'reversal API')) {
          sb.finish(txn, 'failed', 'already reversed');
          return postResult(txn, b, 'R000001', 'The transaction has already been reversed.');
        }
        sb.finish(txn, 'success');
        txn.receipt = randomAlnum(10);
        return postResult(txn, b, 0, 'The service request is processed successfully.', {
          DebitAccountBalance: `Utility Account|KES|${money(sb.float(ID))}|${money(sb.float(ID))}|0.00|0.00`,
          Amount: original.amount,
          TransCompletedTime: Number(stamp14()),
          OriginalTransactionID: original.receipt,
          Charge: 0,
          CreditPartyPublicName: `${original.msisdn} - ${original.customerName}`,
          DebitPartyPublicName: `${original.merchant} - Pesalab Test Business`,
        });
      }, sb.settings.autoDelayMs);
      return txn;
    }));

    // Account balance
    r.post('/mpesa/accountbalance/v1/query', asyncApi(['CommandID', 'PartyA', 'IdentifierType'], (ctx, b, ids) => {
      const txn = sb.newTxn({
        provider: ID, country: 'KE', kind: 'query', description: 'Account balance query', merchant: String(b.PartyA),
        ids, request: b, warnings: ctx.warnings,
      });
      sb.later(() => {
        sb.finish(txn, 'success');
        const f = money(sb.float(ID));
        return postResult(txn, b, 0, 'The service request is processed successfully.', {
          AccountBalance: `Working Account|KES|${f}|${f}|0.00|0.00&Utility Account|KES|${f}|${f}|0.00|0.00&Charges Paid Account|KES|0.00|0.00|0.00|0.00`,
          BOCompletedTime: Number(stamp14()),
        });
      }, sb.settings.autoDelayMs);
      return txn;
    }));
  },
};
