// AzamPay (Tanzania): one API in front of Airtel Money, Mixx by Yas (Tigo),
// HaloPesa, AzamPesa and M-Pesa. This is how most Tanzanian apps reach HaloPesa
// and AzamPesa, which have no public API of their own.
//
// Real sandbox hosts: https://authenticator-sandbox.azampay.co.tz (token)
//                     https://sandbox.azampay.co.tz              (checkout)
// Here both live under the same base URL.

import { deliver } from '../core/callbacks.js';
import { hex, isPositiveAmount, normaliseMsisdn, randomAlnum } from '../core/util.js';

const ID = 'azampay';
const PROVIDERS = ['Airtel', 'Tigo', 'Halopesa', 'Azampesa', 'Mpesa'];
const WALLET_NAME = { Airtel: 'Airtel Money', Tigo: 'Mixx by Yas', Halopesa: 'HaloPesa', Azampesa: 'AzamPesa', Mpesa: 'M-Pesa' };

const MESSAGE = {
  success: 'Transaction successful',
  cancelled: 'Transaction cancelled by customer',
  timeout: 'Customer did not authorise the transaction in time',
  wrong_pin: 'Customer entered a wrong PIN',
  insufficient_funds: 'Customer has insufficient balance',
  failed: 'Transaction failed',
};

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

function authorised(ctx) {
  const token = ctx.bearer();
  if (!token || ctx.sb.tokenState(ID, token) !== 'valid') {
    ctx.send(401, { success: false, message: 'Unauthorized', statusCode: 401 });
    return false;
  }
  const apiKey = ctx.headers['x-api-key'];
  if (blank(apiKey)) ctx.warn('X-API-Key header is missing. AzamPay requires it on checkout requests.');
  else if (apiKey !== ctx.sb.credentials[ID].apiKey && ctx.sb.settings.strict) {
    ctx.send(401, { success: false, message: 'Invalid API key', statusCode: 401 });
    return false;
  }
  return true;
}

export default {
  id: ID,
  name: 'AzamPay',
  api: 'AzamPay MNO checkout (Airtel, Yas, HaloPesa, AzamPesa, M-Pesa)',
  country: 'TZ',
  realBaseUrl: 'https://sandbox.azampay.co.tz',

  routes(r, sb) {
    r.post('/AppRegistration/GenerateToken', (ctx) => {
      const b = ctx.body;
      const c = sb.credentials[ID];
      const invalid = () => ctx.send(423, { success: false, message: 'Provided detail is not valid for this app or secret key has been expired', statusCode: 423 });
      if (blank(b.appName) || blank(b.clientId) || blank(b.clientSecret)) return invalid();
      if (b.appName !== c.appName || b.clientId !== c.clientId || b.clientSecret !== c.clientSecret) {
        if (sb.settings.strict) return invalid();
        ctx.warn('appName, clientId or clientSecret does not match the sandbox credentials. Accepted because strict mode is off.');
      }
      const ttl = 3600;
      ctx.send(200, {
        data: { accessToken: sb.issueToken(ID, ttl, 96), expire: new Date(Date.now() + ttl * 1000).toISOString() },
        message: 'Token generated successfully',
        success: true,
        statusCode: 200,
      });
    });

    r.get('/api/v1/Partner/GetPaymentPartners', (ctx) => {
      if (!authorised(ctx)) return;
      ctx.send(200, PROVIDERS.map((p, i) => ({
        id: hex(32), logoUrl: '', partnerName: p, provider: i + 1, vendorName: 'Pesalab', paymentVendorId: hex(32), paymentPartnerId: hex(32), currency: 'TZS',
      })));
    });

    // ---- Mobile checkout (USSD push on any network) --------------------------
    r.post('/azampay/mno/checkout', (ctx) => {
      if (!authorised(ctx)) return;
      const b = ctx.body;
      const refuse = (message) => ctx.send(400, { success: false, message, transactionId: null });
      for (const f of ['accountNumber', 'amount', 'currency', 'externalId', 'provider']) {
        if (blank(b[f])) return refuse(`${f} is required`);
      }
      const operator = PROVIDERS.find((p) => p.toLowerCase() === String(b.provider).toLowerCase());
      if (!operator) return refuse(`provider must be one of ${PROVIDERS.join(', ')}`);
      if (operator !== b.provider) ctx.warn(`provider is case sensitive on the live API. Send "${operator}".`);
      if (b.currency !== 'TZS') return refuse('currency must be TZS');
      if (!isPositiveAmount(b.amount)) return refuse('Invalid amount');
      const msisdn = normaliseMsisdn(b.accountNumber, 'TZ');
      if (!/^255\d{9}$/.test(msisdn)) return refuse('Invalid accountNumber');
      if (String(b.externalId).length > 128) return refuse('externalId must not exceed 128 characters');

      const url = ctx.headers['x-pesalab-callback-url'] || sb.settings.callbackUrls.azampay;
      if (!url) ctx.warn('No AzamPay callback URL is set, so no callback will be sent. Set it in the dashboard settings.');

      const transactionId = hex(32);
      const txn = sb.newTxn({
        provider: ID, country: 'TZ', kind: 'collection', amount: b.amount, msisdn,
        merchant: `Pesalab Test App (${WALLET_NAME[operator]})`, reference: String(b.externalId), description: `${WALLET_NAME[operator]} checkout`,
        ids: { transactionId, externalId: String(b.externalId), operator }, request: b, warnings: ctx.warnings,
      });
      ctx.send(200, { transactionId, message: 'Your request has been received and is being processed.', success: true });

      sb.prompt(txn, ctx, async (done) => {
        const ok = done.outcome === 'success';
        if (ok) done.receipt = randomAlnum(12);
        if (!url) return;
        await deliver(sb, done, {
          label: 'AzamPay callback', url,
          payload: {
            msisdn: done.msisdn,
            amount: String(done.amount),
            message: MESSAGE[done.outcome] || MESSAGE.failed,
            utilityref: done.ids.externalId,
            operator,
            reference: transactionId,
            transactionstatus: ok ? 'success' : 'failure',
            submerchantAcc: '01723113',
            fspReferenceId: done.receipt || null,
            additionalProperties: b.additionalProperties ?? {},
          },
        });
      });
    });

    // ---- Disbursement --------------------------------------------------------
    r.post('/azampay/disburse', (ctx) => {
      if (!authorised(ctx)) return;
      const b = ctx.body;
      const amount = b.transferDetails?.amount;
      if (blank(b.destination?.accountNumber) || blank(b.externalReferenceId) || !isPositiveAmount(amount)) {
        return ctx.send(400, { data: null, message: 'destination.accountNumber, transferDetails.amount and externalReferenceId are required', success: false, statusCode: 400 });
      }
      const msisdn = normaliseMsisdn(b.destination.accountNumber, 'TZ');
      if (!/^255\d{9}$/.test(msisdn)) return ctx.send(400, { data: null, message: 'Invalid destination.accountNumber', success: false, statusCode: 400 });
      const txn = sb.newTxn({
        provider: ID, country: 'TZ', kind: 'disbursement', amount, msisdn,
        merchant: String(b.source?.fullName || 'Pesalab Test App'), reference: String(b.externalReferenceId),
        description: `Disbursement to ${b.destination.bankName || 'wallet'}`,
        ids: { externalId: String(b.externalReferenceId), operator: String(b.destination.bankName || '') }, request: b, warnings: ctx.warnings,
      });
      const outcome = sb.settleDisbursement(txn, ctx);
      if (outcome === 'success') {
        txn.receipt = randomAlnum(12);
        return ctx.send(200, { data: 'Transaction successful.', message: 'Request successful', success: true, statusCode: 200 });
      }
      ctx.send(400, { data: null, message: outcome === 'insufficient_funds' ? 'Insufficient balance in the disbursement account' : 'Transaction failed', success: false, statusCode: 400 });
    });

    r.get('/azampay/transactionstatus', (ctx) => {
      if (!authorised(ctx)) return;
      const ref = ctx.query.reference;
      const txn = sb.findTxn((t) => t.provider === ID && (t.ids.externalId === ref || t.ids.transactionId === ref));
      if (!txn) return ctx.send(404, { data: null, message: 'Transaction not found', success: false, statusCode: 404 });
      ctx.send(200, { data: txn.status, message: 'Request successful', success: true, statusCode: 200 });
    });
  },
};
