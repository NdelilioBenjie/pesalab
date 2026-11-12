// Airtel Money (Kenya and Tanzania): Airtel Africa Open API.
// Real UAT base URL: https://openapiuat.airtel.africa
//
// The country is chosen per request with the X-Country / X-Currency headers.
// Airtel posts results to ONE callback URL registered in its developer portal,
// so here it comes from the sandbox settings (or the X-Pesalab-Callback-Url header).

import { deliver } from '../core/callbacks.js';
import { eat, isPositiveAmount, normaliseMsisdn, randomAlnum, randomDigits } from '../core/util.js';

const ID = 'airtel';
const CURRENCY = { KE: 'KES', TZ: 'TZS' };
const TOKEN_TTL = 180;

// outcome -> [transaction status, response code, message]
const COLLECTION = {
  success: ['TS', 'DP00800001001', 'Transaction is successful'],
  wrong_pin: ['TF', 'DP00800001002', 'Incorrect PIN has been entered'],
  insufficient_funds: ['TF', 'DP00800001007', 'Not enough balance. User wallet does not have enough money to cover the payable amount'],
  cancelled: ['TF', 'DP00800001008', 'Refused. The transaction was refused'],
  timeout: ['TF', 'DP00800001024', 'Transaction Timed Out. The transaction was timed out'],
  failed: ['TF', 'DP00800001010', 'Transaction not permitted to Payee'],
};

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const okStatus = (response_code) => ({ code: '200', message: 'SUCCESS', result_code: 'ESB000010', response_code, success: true });
const badStatus = (code, message, result_code = 'ESB000004') => ({ code: String(code), message, result_code, success: false });

function airtelMoneyId() {
  const t = eat();
  return `MP${t.YYYY.slice(2)}${t.MM}${t.DD}.${t.hh}${t.mm}.${randomAlnum(1)}${randomDigits(5)}`;
}

function authorised(ctx) {
  const token = ctx.bearer();
  if (token && ctx.sb.tokenState(ID, token) === 'valid') return true;
  ctx.send(401, { error: 'invalid_token', error_description: token ? 'Access token is invalid or has expired' : 'Missing access token' });
  return false;
}

function market(ctx) {
  const country = String(ctx.headers['x-country'] || '').toUpperCase();
  const currency = String(ctx.headers['x-currency'] || '').toUpperCase();
  if (!CURRENCY[country]) {
    ctx.send(400, { status: badStatus(400, 'X-Country header must be KE or TZ in this sandbox') });
    return null;
  }
  if (currency !== CURRENCY[country]) {
    ctx.send(400, { status: badStatus(400, `X-Currency header must be ${CURRENCY[country]} for ${country}`) });
    return null;
  }
  return { country, currency };
}

function subscriber(ctx, raw, country) {
  const msisdn = normaliseMsisdn(raw, country);
  if (!/^25[45]\d{9}$/.test(msisdn)) {
    ctx.send(400, { status: badStatus(400, 'Invalid msisdn') });
    return null;
  }
  if (!/^\d{9}$/.test(String(raw))) ctx.warn('Airtel expects the msisdn without the country code or leading zero, e.g. 783123456.');
  return msisdn;
}

export default {
  id: ID,
  name: 'Airtel Money',
  api: 'Airtel Africa Open API',
  country: 'KE+TZ',
  realBaseUrl: 'https://openapiuat.airtel.africa',

  routes(r, sb) {
    const callbackUrl = (ctx) => ctx.headers['x-pesalab-callback-url'] || sb.settings.callbackUrls.airtel;

    r.post('/auth/oauth2/token', (ctx) => {
      const b = ctx.body;
      if (b.grant_type !== 'client_credentials') return ctx.send(400, { error: 'unsupported_grant_type', error_description: 'grant_type must be client_credentials' });
      if (blank(b.client_id) || blank(b.client_secret)) return ctx.send(401, { error: 'invalid_client', error_description: 'Invalid client authentication' });
      const c = sb.credentials[ID];
      if (b.client_id !== c.clientId || b.client_secret !== c.clientSecret) {
        if (sb.settings.strict) return ctx.send(401, { error: 'invalid_client', error_description: 'Invalid client authentication' });
        ctx.warn('client_id or client_secret does not match the sandbox credentials. Accepted because strict mode is off.');
      }
      ctx.send(200, { access_token: sb.issueToken(ID, TOKEN_TTL), expires_in: TOKEN_TTL, token_type: 'bearer' });
    });

    // ---- Collection (USSD push) --------------------------------------------
    const collect = (ctx) => {
      if (!authorised(ctx)) return;
      const m = market(ctx);
      if (!m) return;
      const b = ctx.body;
      const id = b.transaction?.id;
      if (blank(b.reference) || blank(id) || blank(b.subscriber?.msisdn)) return ctx.send(400, { status: badStatus(400, 'Missing mandatory parameters: reference, subscriber.msisdn, transaction.id') });
      if (!isPositiveAmount(b.transaction?.amount)) return ctx.send(400, { status: badStatus(400, 'Invalid amount') });
      const msisdn = subscriber(ctx, b.subscriber.msisdn, m.country);
      if (!msisdn) return;
      if (sb.findTxn((t) => t.provider === ID && t.ids.id === String(id))) return ctx.send(400, { status: badStatus(400, 'Duplicate transaction id', 'ESB000011') });
      const url = callbackUrl(ctx);
      if (!url) ctx.warn('No Airtel callback URL is set, so no callback will be sent. Set it in the dashboard settings, or poll the status endpoint.');

      const txn = sb.newTxn({
        provider: ID, country: m.country, currency: m.currency, kind: 'collection', amount: b.transaction.amount, msisdn,
        merchant: 'Pesalab Test Merchant', reference: String(b.reference), description: String(b.reference),
        ids: { id: String(id) }, request: b, warnings: ctx.warnings,
      });
      ctx.send(200, { data: { transaction: { id: String(id), status: 'SUCCESS' } }, status: okStatus('DP00800001006') });
      sb.prompt(txn, ctx, async (done) => {
        const [code, , message] = COLLECTION[done.outcome] || COLLECTION.failed;
        done.receipt = airtelMoneyId();
        done.ids.airtel_money_id = done.receipt;
        const text = done.outcome === 'success'
          ? `Paid ${done.currency} ${done.amount.toLocaleString('en-US')} to ${done.merchant}, Trans ID ${done.receipt}.`
          : message;
        if (url) {
          await deliver(sb, done, {
            label: 'Airtel callback', url,
            payload: { transaction: { id: done.ids.id, message: text, status_code: code, airtel_money_id: done.receipt } },
          });
        }
      });
    };
    r.post('/merchant/v1/payments', collect);
    r.post('/merchant/v2/payments', collect);

    const collectionStatus = (ctx) => {
      if (!authorised(ctx)) return;
      if (!market(ctx)) return;
      const txn = sb.findTxn((t) => t.provider === ID && t.kind === 'collection' && t.ids.id === ctx.params.id);
      if (!txn) return ctx.send(200, { data: {}, status: { code: '200', message: 'Transaction not found', result_code: 'ESB000045', response_code: 'DP00800001025', success: false } });
      if (txn.status === 'pending') {
        return ctx.send(200, { data: { transaction: { id: txn.ids.id, message: 'In process', status: 'TIP' } }, status: okStatus('DP00800001006') });
      }
      const [status, code, message] = COLLECTION[txn.outcome] || COLLECTION.failed;
      ctx.send(200, {
        data: { transaction: { airtel_money_id: txn.receipt, id: txn.ids.id, message: txn.status === 'reversed' ? 'Transaction refunded' : message, status } },
        status: okStatus(code),
      });
    };
    r.get('/standard/v1/payments/:id', collectionStatus);
    r.get('/standard/v2/payments/:id', collectionStatus);

    const refund = (ctx) => {
      if (!authorised(ctx)) return;
      if (!market(ctx)) return;
      const amid = ctx.body.transaction?.airtel_money_id;
      const original = sb.findTxn((t) => t.provider === ID && t.kind === 'collection' && t.receipt === amid);
      const blocker = original ? sb.reversalBlocker(original) : 'not_found';
      if (blocker || !sb.reverse(original, 'refund API')) {
        const message = {
          not_found: 'Transaction not found',
          insufficient_float: 'Insufficient balance in merchant account to refund',
        }[blocker] || 'Transaction already refunded';
        return ctx.send(200, { data: {}, status: { code: '200', message, result_code: 'ESB000045', success: false } });
      }
      ctx.send(200, { data: { transaction: { airtel_money_id: amid, status: 'SUCCESS' } }, status: okStatus(undefined) });
    };
    r.post('/standard/v1/payments/refund', refund);
    r.post('/standard/v2/payments/refund', refund);

    // ---- Disbursement --------------------------------------------------------
    const disburse = (ctx) => {
      if (!authorised(ctx)) return;
      const m = market(ctx);
      if (!m) return;
      const b = ctx.body;
      const id = b.transaction?.id;
      if (blank(b.reference) || blank(id) || blank(b.payee?.msisdn) || blank(b.pin)) return ctx.send(400, { status: badStatus(400, 'Missing mandatory parameters: payee.msisdn, reference, pin, transaction.id') });
      if (!isPositiveAmount(b.transaction?.amount)) return ctx.send(400, { status: badStatus(400, 'Invalid amount') });
      const msisdn = subscriber(ctx, b.payee.msisdn, m.country);
      if (!msisdn) return;
      if (sb.findTxn((t) => t.provider === ID && t.ids.id === String(id))) return ctx.send(400, { status: badStatus(400, 'Duplicate transaction id', 'ESB000011') });

      const txn = sb.newTxn({
        provider: ID, country: m.country, currency: m.currency, kind: 'disbursement', amount: b.transaction.amount, msisdn,
        merchant: 'Pesalab Test Merchant', reference: String(b.reference), description: `Disbursement ${b.reference}`,
        ids: { id: String(id) }, request: { ...b, pin: '(hidden)' }, warnings: ctx.warnings,
      });
      const outcome = sb.settleDisbursement(txn, ctx);
      txn.receipt = airtelMoneyId();
      txn.ids.airtel_money_id = txn.receipt;
      const transaction = { reference_id: randomDigits(12), airtel_money_id: txn.receipt, id: String(id) };
      if (outcome === 'success') return ctx.send(200, { data: { transaction: { ...transaction, status: 'TS' } }, status: okStatus('DP00900001001') });
      ctx.send(200, {
        data: { transaction: { ...transaction, status: 'TF' } },
        status: {
          code: '200',
          message: outcome === 'insufficient_funds' ? 'Insufficient funds in the disbursement wallet' : 'Transaction failed',
          result_code: 'ESB000014',
          response_code: outcome === 'insufficient_funds' ? 'DP00900001007' : 'DP00900001005',
          success: false,
        },
      });
    };
    r.post('/standard/v1/disbursements', disburse);
    r.post('/standard/v2/disbursements', disburse);

    r.get('/standard/v1/disbursements/:id', (ctx) => {
      if (!authorised(ctx)) return;
      if (!market(ctx)) return;
      const txn = sb.findTxn((t) => t.provider === ID && t.kind === 'disbursement' && t.ids.id === ctx.params.id);
      if (!txn) return ctx.send(200, { data: {}, status: { code: '200', message: 'Transaction not found', result_code: 'ESB000045', success: false } });
      const ok = txn.status === 'success';
      ctx.send(200, {
        data: { transaction: { id: txn.ids.id, message: ok ? 'Transaction is successful' : 'Transaction failed', status: ok ? 'TS' : 'TF' } },
        status: okStatus(ok ? 'DP00900001001' : 'DP00900001005'),
      });
    });

    // ---- KYC lookup ----------------------------------------------------------
    r.get('/standard/v1/users/:msisdn', (ctx) => {
      if (!authorised(ctx)) return;
      const m = market(ctx);
      if (!m) return;
      const msisdn = normaliseMsisdn(ctx.params.msisdn, m.country);
      const w = sb.wallet(msisdn);
      const [first, ...rest] = w.name.split(' ');
      ctx.send(200, {
        data: { first_name: first, last_name: rest.join(' '), msisdn: msisdn.slice(3), grade: 'SUBS', is_barred: false, is_pin_set: true, registration: { status: 'SUBS' } },
        status: okStatus(undefined),
      });
    });
  },
};
