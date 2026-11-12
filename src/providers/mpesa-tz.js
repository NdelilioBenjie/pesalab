// M-Pesa Tanzania: Vodacom M-Pesa OpenAPI.
// Real base URL: https://openapi.m-pesa.com  (paths start /sandbox/ipg/v2/vodacomTZN/)
//
// Two things make this API different from Daraja and both are imitated here:
//  1. Auth is an API key encrypted with an RSA public key, exchanged for a session ID,
//     which is itself encrypted for every later call.
//  2. C2B is synchronous. The HTTP request stays open while the customer answers the
//     USSD push, and the response carries the final result.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hex, isPositiveAmount, normaliseMsisdn } from '../core/util.js';

const ID = 'mpesa-tz';
const BASES = ['/sandbox/ipg/v2/vodacomTZN', '/openapi/ipg/v2/vodacomTZN'];
const SESSION_TTL_MS = 60 * 60 * 1000;

const OUTCOME = {
  success: [201, 'INS-0', 'Request processed successfully'],
  cancelled: [401, 'INS-5', 'Transaction cancelled by customer'],
  timeout: [408, 'INS-9', 'Request timeout'],
  wrong_pin: [401, 'INS-2001', 'Initiator authentication error.'],
  insufficient_funds: [422, 'INS-2006', 'Insufficient balance'],
  failed: [401, 'INS-6', 'Transaction Failed'],
};

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const transactionId = () => crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').slice(0, 12);

function ins(ctx, status, code, desc, extra = {}) {
  ctx.send(status, { output_ResponseCode: code, output_ResponseDesc: desc, ...extra });
  return false;
}

function loadKey(sb) {
  const file = sb.dataDir ? path.join(sb.dataDir, 'mpesa-tz-private-key.pem') : null;
  if (file && fs.existsSync(file)) return crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  if (file) {
    fs.mkdirSync(sb.dataDir, { recursive: true });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  return privateKey;
}

/**
 * RSA PKCS#1 v1.5 decryption. Recent Node versions refuse this padding in
 * privateDecrypt, so the raw operation is done here and the padding removed by hand.
 * Fine for a local test tool; never do this with a real key.
 */
function decrypt(key, base64) {
  try {
    const em = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, Buffer.from(base64, 'base64'));
    if (em[0] !== 0 || em[1] !== 2) return null;
    const sep = em.indexOf(0, 2);
    return sep < 10 ? null : em.subarray(sep + 1).toString('utf8');
  } catch {
    return null;
  }
}

function authorised(ctx) {
  const { sb } = ctx;
  const state = sb.providerState[ID];
  const bearer = ctx.bearer();
  if (!ctx.headers.origin) ctx.warn('No Origin header. The real OpenAPI expects "Origin: *" on every request.');
  if (!bearer) return ins(ctx, 401, 'INS-2', 'Invalid API Key');

  const session = decrypt(state.key, bearer);
  const expiry = session && state.sessions.get(session);
  if (expiry && expiry > Date.now()) return true;
  if (sb.settings.strict) return ins(ctx, 401, 'INS-2', 'Invalid API Key');

  if (state.sessions.has(bearer)) ctx.warn('Session ID was sent unencrypted. The real API needs it RSA-encrypted with the public key.');
  else if (!session) ctx.warn('Could not decrypt the bearer token. You are probably still encrypting with Vodacom\'s public key: use the pesalab public key from the dashboard.');
  else ctx.warn('Session ID is unknown or expired. Call getSession again. Accepted because strict mode is off.');
  return true;
}

function common(ctx, fields) {
  const b = ctx.method === 'GET' ? ctx.query : ctx.body;
  if (ctx.badJson) return ins(ctx, 400, 'INS-21', 'Parameter validations failed. Please try again.');
  for (const f of fields) if (blank(b[f])) return ins(ctx, 400, 'INS-20', 'Not All Parameters Provided. Please try again.');
  if (b.input_Country !== 'TZN') return ins(ctx, 400, 'INS-998', 'Invalid Market');
  if ('input_Currency' in b && b.input_Currency !== 'TZS') return ins(ctx, 400, 'INS-21', 'Parameter validations failed. Please try again.');
  if ('input_Amount' in b && !isPositiveAmount(b.input_Amount)) return ins(ctx, 400, 'INS-15', 'Invalid Amount Used');
  if (ctx.sb.settings.strict && b.input_ServiceProviderCode !== ctx.sb.credentials[ID].serviceProviderCode) {
    return ins(ctx, 400, 'INS-13', 'Invalid Shortcode Used');
  }
  if ('input_TransactionReference' in b && String(b.input_TransactionReference).length > 20) {
    return ins(ctx, 400, 'INS-17', 'Invalid Transaction Reference. Length Should Be Between 1 and 20.');
  }
  return b;
}

function msisdnOf(ctx, raw) {
  if (/^0{11}\d$/.test(String(raw))) return String(raw); // Vodacom's own sandbox test numbers
  const m = normaliseMsisdn(raw, 'TZ');
  if (!/^255\d{9}$/.test(m)) return ins(ctx, 400, 'INS-2051', 'MSISDN invalid.');
  if (String(raw) !== m) ctx.warn('input_CustomerMSISDN should be in the format 2557XXXXXXXX.');
  return m;
}

function claimConversation(ctx, id) {
  const seen = ctx.sb.providerState[ID].conversations;
  if (seen.has(id)) return ins(ctx, 409, 'INS-10', 'Duplicate Transaction');
  seen.add(id);
  return true;
}

function reply(ctx, txn) {
  const [status, code, desc] = OUTCOME[txn.outcome] || OUTCOME.failed;
  if (ctx.clientGone) {
    ctx.sb.event(txn, 'response', 'Your client had already hung up, so it never saw this result. Recover it with queryTransactionStatus.');
  }
  ctx.send(status, {
    output_ResponseCode: code,
    output_ResponseDesc: desc,
    output_TransactionID: txn.receipt || 'N/A',
    output_ConversationID: txn.ids.ConversationID,
    output_ThirdPartyConversationID: txn.ids.ThirdPartyConversationID,
  });
}

export default {
  id: ID,
  name: 'M-Pesa Tanzania',
  api: 'Vodacom M-Pesa OpenAPI',
  country: 'TZ',
  realBaseUrl: 'https://openapi.m-pesa.com',

  setup(sb) {
    const key = loadKey(sb);
    sb.credentials[ID].publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
    sb.providerState[ID] = {
      key,
      sessions: new Map(),
      conversations: new Set(),
      reset() { this.sessions.clear(); this.conversations.clear(); },
    };
  },

  routes(r, sb) {
    const state = () => sb.providerState[ID];
    const cred = () => sb.credentials[ID];

    for (const base of BASES) {
      // ---- Session ---------------------------------------------------------
      r.get(`${base}/getSession`, (ctx) => {
        const bearer = ctx.bearer();
        if (!ctx.headers.origin) ctx.warn('No Origin header. The real OpenAPI expects "Origin: *" on every request.');
        if (!bearer) return ins(ctx, 400, 'INS-989', 'Session creation failed');
        const apiKey = decrypt(state().key, bearer);
        if (apiKey !== cred().apiKey) {
          if (sb.settings.strict) return ins(ctx, 400, 'INS-989', 'Session creation failed');
          ctx.warn(apiKey === null
            ? 'Could not decrypt the API key. Encrypt it with the pesalab public key shown in the dashboard, not Vodacom\'s.'
            : 'API key does not match the sandbox API key. Accepted because strict mode is off.');
        }
        const sessionId = hex(32);
        state().sessions.set(sessionId, Date.now() + SESSION_TTL_MS);
        ctx.send(200, { output_ResponseCode: 'INS-0', output_ResponseDesc: 'Request processed successfully', output_SessionID: sessionId });
      });

      // ---- C2B single stage: held open until the customer answers -----------
      r.post(`${base}/c2bPayment/singleStage`, (ctx) => {
        if (!authorised(ctx)) return;
        const b = common(ctx, ['input_Amount', 'input_Country', 'input_Currency', 'input_CustomerMSISDN', 'input_ServiceProviderCode', 'input_ThirdPartyConversationID', 'input_TransactionReference', 'input_PurchasedItemsDesc']);
        if (!b) return;
        const msisdn = msisdnOf(ctx, b.input_CustomerMSISDN);
        if (!msisdn) return;
        if (!claimConversation(ctx, b.input_ThirdPartyConversationID)) return;

        const txn = sb.newTxn({
          provider: ID, country: 'TZ', kind: 'collection', amount: b.input_Amount, msisdn,
          merchant: String(b.input_ServiceProviderCode), reference: String(b.input_TransactionReference),
          description: String(b.input_PurchasedItemsDesc),
          ids: { ConversationID: hex(32), ThirdPartyConversationID: String(b.input_ThirdPartyConversationID) },
          request: b, warnings: ctx.warnings,
        });
        sb.prompt(txn, ctx, (done) => {
          if (done.outcome === 'success') done.receipt = transactionId();
          reply(ctx, done);
        });
      });

      // ---- B2C and B2B: settle straight away --------------------------------
      r.post(`${base}/b2cPayment`, (ctx) => {
        if (!authorised(ctx)) return;
        const b = common(ctx, ['input_Amount', 'input_Country', 'input_Currency', 'input_CustomerMSISDN', 'input_ServiceProviderCode', 'input_ThirdPartyConversationID', 'input_TransactionReference', 'input_PaymentItemsDesc']);
        if (!b) return;
        const msisdn = msisdnOf(ctx, b.input_CustomerMSISDN);
        if (!msisdn) return;
        if (!claimConversation(ctx, b.input_ThirdPartyConversationID)) return;
        const txn = sb.newTxn({
          provider: ID, country: 'TZ', kind: 'disbursement', amount: b.input_Amount, msisdn,
          merchant: String(b.input_ServiceProviderCode), reference: String(b.input_TransactionReference),
          description: `B2C ${b.input_PaymentItemsDesc}`,
          ids: { ConversationID: hex(32), ThirdPartyConversationID: String(b.input_ThirdPartyConversationID) },
          request: b, warnings: ctx.warnings,
        });
        if (sb.settleDisbursement(txn, ctx) === 'success') txn.receipt = transactionId();
        reply(ctx, txn);
      });

      r.post(`${base}/b2bPayment`, (ctx) => {
        if (!authorised(ctx)) return;
        const b = common(ctx, ['input_Amount', 'input_Country', 'input_Currency', 'input_PrimaryPartyCode', 'input_ReceiverPartyCode', 'input_ThirdPartyConversationID', 'input_TransactionReference', 'input_PurchasedItemsDesc']);
        if (!b) return;
        if (!claimConversation(ctx, b.input_ThirdPartyConversationID)) return;
        const txn = sb.newTxn({
          provider: ID, country: 'TZ', kind: 'disbursement', amount: b.input_Amount,
          merchant: `${b.input_PrimaryPartyCode} -> ${b.input_ReceiverPartyCode}`, reference: String(b.input_TransactionReference),
          description: `B2B ${b.input_PurchasedItemsDesc}`,
          ids: { ConversationID: hex(32), ThirdPartyConversationID: String(b.input_ThirdPartyConversationID) },
          request: b, warnings: ctx.warnings,
        });
        if (sb.settleDisbursement(txn, ctx) === 'success') txn.receipt = transactionId();
        reply(ctx, txn);
      });

      // ---- Reversal ---------------------------------------------------------
      r.put(`${base}/reversal`, (ctx) => {
        if (!authorised(ctx)) return;
        const b = common(ctx, ['input_Country', 'input_ServiceProviderCode', 'input_ThirdPartyConversationID', 'input_TransactionID']);
        if (!b) return;
        if ('input_ReversalAmount' in b && !isPositiveAmount(b.input_ReversalAmount)) return ins(ctx, 400, 'INS-15', 'Invalid Amount Used');
        const original = sb.findTxn((t) => t.provider === ID && t.receipt === b.input_TransactionID && t.kind !== 'reversal');
        if (!original) return ins(ctx, 400, 'INS-18', 'Invalid TransactionID Used');
        if (!claimConversation(ctx, b.input_ThirdPartyConversationID)) return;
        const txn = sb.newTxn({
          provider: ID, country: 'TZ', kind: 'reversal', amount: b.input_ReversalAmount || original.amount, msisdn: original.msisdn,
          merchant: String(b.input_ServiceProviderCode), description: `Reversal of ${b.input_TransactionID}`,
          ids: { ConversationID: hex(32), ThirdPartyConversationID: String(b.input_ThirdPartyConversationID) },
          request: b, warnings: ctx.warnings,
        });
        const blocker = sb.reversalBlocker(original);
        if (!blocker && sb.reverse(original, 'reversal API')) {
          sb.finish(txn, 'success');
          txn.receipt = transactionId();
        } else {
          const why = {
            already_reversed: 'transaction was already reversed',
            insufficient_float: 'not enough balance in the business float to refund it',
            insufficient_customer_balance: 'the customer no longer has the money',
          }[blocker] || 'transaction cannot be reversed';
          sb.finish(txn, 'failed', why);
        }
        reply(ctx, txn);
      });

      // ---- Query transaction status -----------------------------------------
      r.get(`${base}/queryTransactionStatus`, (ctx) => {
        if (!authorised(ctx)) return;
        const q = common(ctx, ['input_QueryReference', 'input_ServiceProviderCode', 'input_ThirdPartyConversationID', 'input_Country']);
        if (!q) return;
        const ref = q.input_QueryReference;
        const txn = sb.findTxn((t) => t.provider === ID
          && (t.receipt === ref || t.ids.ThirdPartyConversationID === ref || t.ids.ConversationID === ref));
        if (!txn) return ins(ctx, 400, 'INS-18', 'Invalid TransactionID Used');
        const status = { pending: 'Pending', success: 'Completed', failed: 'Failed', reversed: 'Reversed' }[txn.status];
        ctx.send(200, {
          output_ResponseCode: 'INS-0',
          output_ResponseDesc: 'Request processed successfully',
          output_ResponseTransactionStatus: status,
          output_ConversationID: txn.ids.ConversationID,
          output_ThirdPartyConversationID: q.input_ThirdPartyConversationID,
          output_OriginalTransactionID: txn.receipt || 'N/A',
        });
      });
    }
  },
};
