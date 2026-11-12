import test from 'node:test';
import assert from 'node:assert/strict';
import { lab, receiver, call, until } from '../support/helpers.js';

const basic = (c) => ({ authorization: `Basic ${Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString('base64')}` });

async function setup(settings) {
  const l = await lab(settings);
  const hook = await receiver();
  const base = l.urls['mpesa-ke'];
  const cred = l.credentials['mpesa-ke'];
  const auth = await call(`${base}/oauth/v1/generate?grant_type=client_credentials`, { headers: basic(cred) });
  const token = auth.body.access_token;
  const stk = (over = {}, headers = {}) => {
    const Timestamp = '20261112093000';
    return call(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST', token, headers,
      json: {
        BusinessShortCode: cred.shortcode,
        Password: Buffer.from(cred.shortcode + cred.passkey + Timestamp).toString('base64'),
        Timestamp, TransactionType: 'CustomerPayBillOnline', Amount: 100, PartyA: '254712345678', PartyB: cred.shortcode,
        PhoneNumber: '254712345678', CallBackURL: `${hook.url}/stk`, AccountReference: 'ORDER-1', TransactionDesc: 'Test', ...over,
      },
    });
  };
  return { l, hook, base, cred, token, stk, done: async () => { await hook.close(); await l.stop(); } };
}

test('oauth: token shape and bad grant type', async () => {
  const t = await setup();
  assert.equal(typeof t.token, 'string');
  const bad = await call(`${t.base}/oauth/v1/generate`, { headers: basic(t.cred) });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errorCode, '400.008.02');
  await t.done();
});

test('stk push: rejects a missing or invalid token like Daraja', async () => {
  const t = await setup();
  const r = await call(`${t.base}/mpesa/stkpush/v1/processrequest`, { method: 'POST', token: 'nope', json: {} });
  assert.equal(r.status, 404);
  assert.equal(r.body.errorCode, '404.001.03');
  await t.done();
});

test('stk push: success delivers the callback and the query agrees', async () => {
  const t = await setup({ mode: 'auto' });
  const r = await t.stk();
  assert.equal(r.status, 200);
  assert.equal(r.body.ResponseCode, '0');
  assert.match(r.body.CheckoutRequestID, /^ws_CO_\d+$/);

  const cb = (await t.hook.call(1)).body.Body.stkCallback;
  assert.equal(cb.ResultCode, 0);
  assert.equal(cb.CheckoutRequestID, r.body.CheckoutRequestID);
  const items = Object.fromEntries(cb.CallbackMetadata.Item.map((i) => [i.Name, i.Value]));
  assert.equal(items.Amount, 100);
  assert.equal(items.PhoneNumber, 254712345678);
  assert.match(items.MpesaReceiptNumber, /^[A-Z0-9]{10}$/);

  const q = await call(`${t.base}/mpesa/stkpushquery/v1/query`, {
    method: 'POST', token: t.token,
    json: { BusinessShortCode: t.cred.shortcode, Password: 'x', Timestamp: '20261112093000', CheckoutRequestID: r.body.CheckoutRequestID },
  });
  assert.equal(q.body.ResultCode, '0');
  await t.done();
});

test('stk push: every failure outcome maps to the Daraja result code', async () => {
  const t = await setup();
  const expected = { cancelled: 1032, timeout: 1037, wrong_pin: 2001, insufficient_funds: 1 };
  let n = 0;
  for (const [outcome, code] of Object.entries(expected)) {
    t.l.queue(outcome);
    await t.stk({ PhoneNumber: `25471234567${n}`, PartyA: `25471234567${n}` });
    const cb = (await t.hook.call(++n)).body.Body.stkCallback;
    assert.equal(cb.ResultCode, code, outcome);
    assert.equal(cb.CallbackMetadata, undefined);
  }
  await t.done();
});

test('stk push: test phone numbers and the scenario header script the outcome', async () => {
  const t = await setup();
  await t.stk({ PhoneNumber: '254700000004', PartyA: '254700000004' });
  assert.equal((await t.hook.call(1)).body.Body.stkCallback.ResultCode, 1032);
  await t.stk({}, { 'x-pesalab-scenario': 'timeout' });
  assert.equal((await t.hook.call(2)).body.Body.stkCallback.ResultCode, 1037);
  await t.done();
});

test('stk push: manual mode waits for the dashboard; PIN decides; query says processing meanwhile', async () => {
  const t = await setup();
  const r = await t.stk();
  const pending = await call(`${t.l.url}/_pesalab/api/transactions?status=pending`);
  assert.equal(pending.body.length, 1);

  const q = await call(`${t.base}/mpesa/stkpushquery/v1/query`, {
    method: 'POST', token: t.token,
    json: { BusinessShortCode: t.cred.shortcode, Password: 'x', Timestamp: '20261112093000', CheckoutRequestID: r.body.CheckoutRequestID },
  });
  assert.equal(q.status, 500);
  assert.equal(q.body.errorMessage, 'The transaction is being processed');

  const busy = await t.stk();
  assert.equal(busy.status, 500);
  assert.match(busy.body.errorMessage, /Unable to lock subscriber/);

  await call(`${t.l.url}/_pesalab/api/transactions/${pending.body[0].id}/resolve`, { method: 'POST', json: { pin: '0000' } });
  assert.equal((await t.hook.call(1)).body.Body.stkCallback.ResultCode, 2001);
  await t.done();
});

test('stk push: an unanswered prompt times out', async () => {
  const t = await setup({ promptTimeoutMs: 40 });
  await t.stk();
  assert.equal((await t.hook.call(1)).body.Body.stkCallback.ResultCode, 1037);
  await t.done();
});

test('stk push: strict mode rejects a wrong password; lenient mode warns', async () => {
  const t = await setup({ mode: 'auto', strict: true });
  const r = await t.stk({ Password: 'd3Jvbmc=' });
  assert.equal(r.status, 500);
  assert.equal(r.body.errorMessage, 'Wrong credentials');
  await call(`${t.l.url}/_pesalab/api/settings`, { method: 'PATCH', json: { strict: false } });
  const ok = await t.stk({ Password: 'd3Jvbmc=' });
  assert.equal(ok.status, 200);
  const txn = t.l.transactions().at(-1);
  assert.ok(txn.warnings.some((w) => /Password/.test(w)));
  await t.done();
});

test('callback chaos: dropped callbacks can be replayed, duplicates arrive twice', async () => {
  const t = await setup({ mode: 'auto', callbacks: { drop: true } });
  await t.stk();
  const txn = await until(() => t.l.transactions().find((x) => x.callbacks.length));
  assert.equal(t.hook.calls.length, 0);
  assert.equal(txn.callbacks[0].attempts[0].dropped, true);
  await call(`${t.l.url}/_pesalab/api/transactions/${txn.id}/callbacks/${txn.callbacks[0].id}/replay`, { method: 'POST' });
  await t.hook.call(1);

  await call(`${t.l.url}/_pesalab/api/settings`, { method: 'PATCH', json: { callbacks: { drop: false, duplicate: true } } });
  await t.stk({ PhoneNumber: '254711111111' });
  const second = await t.hook.call(3);
  assert.deepEqual(second.body, t.hook.calls[1].body);
  await t.done();
});

test('c2b: validation can reject, confirmation follows acceptance, msisdn is hashed', async () => {
  const t = await setup();
  const reg = await call(`${t.base}/mpesa/c2b/v1/registerurl`, {
    method: 'POST', token: t.token,
    json: { ShortCode: '600999', ResponseType: 'Completed', ConfirmationURL: `${t.hook.url}/confirm`, ValidationURL: `${t.hook.url}/validate` },
  });
  assert.equal(reg.body.ResponseDescription, 'Success');

  const pay = (amount) => call(`${t.base}/mpesa/c2b/v1/simulate`, {
    method: 'POST', token: t.token,
    json: { ShortCode: '600999', CommandID: 'CustomerPayBillOnline', Amount: amount, Msisdn: '254708374149', BillRefNumber: 'INV-7' },
  });
  await pay(250);
  const validation = await t.hook.call(1);
  const confirmation = await t.hook.call(2);
  assert.equal(validation.path, '/validate');
  assert.equal(confirmation.path, '/confirm');
  assert.equal(confirmation.body.TransAmount, '250.00');
  assert.equal(confirmation.body.BillRefNumber, 'INV-7');
  assert.match(confirmation.body.MSISDN, /^[a-f0-9]{64}$/);

  t.hook.state.reply = { ResultCode: 'C2B00012', ResultDesc: 'Rejected' };
  await pay(300);
  await t.hook.call(3);
  const rejected = await until(() => t.l.transactions().find((x) => x.amount === 300 && x.status === 'failed'));
  assert.equal(rejected.callbacks.length, 1);
  await t.done();
});

test('b2c then reversal: results are posted and the ledger moves', async () => {
  const t = await setup();
  const common = { InitiatorName: 'testapi', SecurityCredential: 'abc', ResultURL: `${t.hook.url}/result`, QueueTimeOutURL: `${t.hook.url}/timeout` };
  const before = t.l.sandbox.wallet('254708374149').balance;
  const r = await call(`${t.base}/mpesa/b2c/v3/paymentrequest`, {
    method: 'POST', token: t.token,
    json: { ...common, OriginatorConversationID: 'my-id-1', CommandID: 'BusinessPayment', Amount: 500, PartyA: '600000', PartyB: '254708374149', Remarks: 'Refund', Occasion: '' },
  });
  assert.equal(r.body.ResponseCode, '0');
  assert.equal(r.body.OriginatorConversationID, 'my-id-1');
  const result = (await t.hook.call(1)).body.Result;
  assert.equal(result.ResultCode, 0);
  const params = Object.fromEntries(result.ResultParameters.ResultParameter.map((p) => [p.Key, p.Value]));
  assert.equal(params.TransactionAmount, 500);
  assert.equal(t.l.sandbox.wallet('254708374149').balance, before + 500);

  await call(`${t.base}/mpesa/reversal/v1/request`, {
    method: 'POST', token: t.token,
    json: { ...common, Initiator: 'testapi', CommandID: 'TransactionReversal', TransactionID: params.TransactionReceipt, Amount: 500, ReceiverParty: '600000', RecieverIdentifierType: '11', Remarks: 'oops' },
  });
  assert.equal((await t.hook.call(2)).body.Result.ResultCode, 0);
  assert.equal(t.l.sandbox.wallet('254708374149').balance, before);
  await t.done();
});
