// Mixx by Yas (formerly Tigo Pesa), Tanzania: Push BillPay API.
//
// Yas shares its API document privately with onboarded billers, so this emulator
// follows the shape used by the open-source Tigo Pesa client libraries:
// token -> push bill pay -> callback to the URL you gave Yas at onboarding.
// See docs/providers.md for what is and is not verified.

import { deliver, parseJson } from '../core/callbacks.js';
import { isPositiveAmount, normaliseMsisdn, randomDigits } from '../core/util.js';

const ID = 'yas';
const OK = 'BILLER-18-0000-S';
const ERR = 'BILLER-18-3020-E';

const DESCRIPTION = {
  success: 'Transaction completed successfully',
  cancelled: 'Transaction cancelled by customer',
  timeout: 'Customer did not respond to the push request',
  wrong_pin: 'Customer entered an incorrect PIN',
  insufficient_funds: 'Customer has insufficient balance',
  failed: 'Transaction failed',
};

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

export default {
  id: ID,
  name: 'Mixx by Yas',
  api: 'Push BillPay (ex Tigo Pesa)',
  country: 'TZ',
  realBaseUrl: 'the URL Yas gives you at onboarding',

  routes(r, sb) {
    const cred = () => sb.credentials[ID];

    r.post('/token', (ctx) => {
      const b = ctx.body;
      if (b.grant_type !== 'password') return ctx.send(400, { error: 'unsupported_grant_type' });
      if (!String(ctx.headers['content-type'] || '').includes('x-www-form-urlencoded')) {
        ctx.warn('The token request should be sent as application/x-www-form-urlencoded.');
      }
      if (blank(b.username) || blank(b.password)) return ctx.send(400, { error: 'invalid_grant', error_description: 'The user name or password is incorrect.' });
      if (b.username !== cred().username || b.password !== cred().password) {
        if (sb.settings.strict) return ctx.send(400, { error: 'invalid_grant', error_description: 'The user name or password is incorrect.' });
        ctx.warn('Username or password does not match the sandbox credentials. Accepted because strict mode is off.');
      }
      ctx.send(200, { access_token: sb.issueToken(ID, 3600, 64), token_type: 'bearer', expires_in: 3600 });
    });

    const billPay = (ctx) => {
      const b = ctx.body;
      const refuse = (status, description) => ctx.send(status, {
        ResponseCode: ERR, ResponseStatus: false, ResponseDescription: description, ReferenceID: b.ReferenceID ?? null,
      });
      const token = ctx.bearer();
      if (!token || sb.tokenState(ID, token) !== 'valid') return refuse(401, 'Authorization has been denied for this request.');
      if (blank(ctx.headers.username) || blank(ctx.headers.password)) ctx.warn('Username and Password headers are missing. The live API expects them on every bill pay request.');
      for (const f of ['CustomerMSISDN', 'BillerMSISDN', 'Amount', 'ReferenceID']) {
        if (blank(b[f])) return refuse(400, `${f} is required`);
      }
      if (!isPositiveAmount(b.Amount)) return refuse(400, 'Invalid Amount');
      const msisdn = normaliseMsisdn(b.CustomerMSISDN, 'TZ');
      if (!/^255\d{9}$/.test(msisdn)) return refuse(400, 'Invalid CustomerMSISDN');
      if (String(b.CustomerMSISDN) !== msisdn) ctx.warn('CustomerMSISDN should be in the format 2557XXXXXXXX.');
      if (sb.settings.strict && String(b.BillerMSISDN) !== cred().billerMsisdn) return refuse(400, 'Invalid BillerMSISDN');
      if (sb.findTxn((t) => t.provider === ID && t.ids.ReferenceID === String(b.ReferenceID))) return refuse(400, 'Duplicate ReferenceID');

      const url = ctx.headers['x-pesalab-callback-url'] || sb.settings.callbackUrls.yas;
      if (!url) ctx.warn('No Yas callback URL is set, so no callback will be sent. Set it in the dashboard settings.');

      const txn = sb.newTxn({
        provider: ID, country: 'TZ', kind: 'collection', amount: b.Amount, msisdn,
        merchant: String(b.BillerMSISDN), reference: String(b.ReferenceID), description: String(b.Remarks || ''),
        ids: { ReferenceID: String(b.ReferenceID) }, request: b, warnings: ctx.warnings,
      });
      ctx.send(200, { ResponseCode: OK, ResponseStatus: true, ResponseDescription: 'Request accepted for processing', ReferenceID: String(b.ReferenceID) });

      sb.prompt(txn, ctx, async (done) => {
        const ok = done.outcome === 'success';
        if (ok) done.receipt = randomDigits(11);
        if (!url) return;
        const attempt = await deliver(sb, done, {
          label: 'Yas callback', url,
          payload: {
            Status: ok,
            Description: DESCRIPTION[done.outcome] || DESCRIPTION.failed,
            MFSTransactionID: done.receipt || '',
            ReferenceID: done.ids.ReferenceID,
            Amount: String(done.amount),
          },
        });
        // Yas expects your endpoint to acknowledge in this exact shape.
        const ack = attempt.ok ? parseJson(attempt.response) : null;
        if (attempt.ok && (!ack || ack.ResponseCode !== OK || ack.ResponseStatus !== true)) {
          done.warnings.push(`Your callback endpoint should reply {"ResponseCode":"${OK}","ResponseStatus":true,"ResponseDescription":"Callback successful","ReferenceID":"..."}.`);
          sb.changed();
        }
      });
    };
    r.post('/API/BillerPayment/BillerPay', billPay);
    r.post('/pushbillpay', billPay);
  },
};
