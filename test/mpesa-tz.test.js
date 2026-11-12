import test from 'node:test';
import assert from 'node:assert/strict';
import { lab, call, until, rsaEncrypt } from '../support/helpers.js';

const PATH = '/sandbox/ipg/v2/vodacomTZN';

async function setup(settings) {
  const l = await lab(settings);
  const base = l.urls['mpesa-tz'] + PATH;
  const cred = l.credentials['mpesa-tz'];
  const origin = { origin: '*' };
  const s = await call(`${base}/getSession/`, { headers: origin, token: rsaEncrypt(cred.publicKey, cred.apiKey) });
  const session = rsaEncrypt(cred.publicKey, s.body.output_SessionID);
  let n = 0;
  const c2b = (over = {}, headers = {}) => call(`${base}/c2bPayment/singleStage/`, {
    method: 'POST', token: session, headers: { ...origin, ...headers },
    json: {
      input_Amount: '5000', input_Country: 'TZN', input_Currency: 'TZS', input_CustomerMSISDN: '255754123456',
      input_ServiceProviderCode: '000000', input_ThirdPartyConversationID: `conv-${++n}-${Date.now()}`,
      input_TransactionReference: 'T1234C', input_PurchasedItemsDesc: 'Shoes', ...over,
    },
  });
  return { l, base, cred, session, origin, sessionResponse: s, c2b, done: () => l.stop() };
}

test('getSession: decrypts the RSA-encrypted API key', async () => {
  const t = await setup({ strict: true });
  assert.equal(t.sessionResponse.status, 200);
  assert.equal(t.sessionResponse.body.output_ResponseCode, 'INS-0');
  assert.match(t.sessionResponse.body.output_SessionID, /^[a-f0-9]{32}$/);

  const wrong = await call(`${t.base}/getSession/`, { headers: t.origin, token: rsaEncrypt(t.cred.publicKey, 'not-the-key') });
  assert.equal(wrong.body.output_ResponseCode, 'INS-989');
  const garbage = await call(`${t.base}/getSession/`, { headers: t.origin, token: 'bm90LWVuY3J5cHRlZA==' });
  assert.equal(garbage.body.output_ResponseCode, 'INS-989');
  await t.done();
});

test('c2b: the request stays open until the customer answers, then returns INS-0', async () => {
  const t = await setup();
  const pendingRequest = t.c2b();
  const txn = await until(() => t.l.transactions().find((x) => x.status === 'pending'));
  assert.equal(txn.msisdn, '255754123456');
  const before = t.l.sandbox.wallet('255754123456').balance;

  await call(`${t.l.url}/_pesalab/api/transactions/${txn.id}/resolve`, { method: 'POST', json: { pin: '1234' } });
  const r = await pendingRequest;
  assert.equal(r.status, 201);
  assert.equal(r.body.output_ResponseCode, 'INS-0');
  assert.match(r.body.output_TransactionID, /^[A-Za-z0-9]{12}$/);
  assert.equal(t.l.sandbox.wallet('255754123456').balance, before - 5000);
  await t.done();
});

test('c2b: failure outcomes map to INS codes and HTTP statuses', async () => {
  const t = await setup();
  const expected = {
    cancelled: [401, 'INS-5'], timeout: [408, 'INS-9'], insufficient_funds: [422, 'INS-2006'], wrong_pin: [401, 'INS-2001'],
  };
  for (const [outcome, [status, code]] of Object.entries(expected)) {
    const r = await t.c2b({}, { 'x-pesalab-scenario': outcome });
    assert.equal(r.status, status, outcome);
    assert.equal(r.body.output_ResponseCode, code, outcome);
    assert.equal(r.body.output_TransactionID, 'N/A');
  }
  const magic = await t.c2b({ input_CustomerMSISDN: '255700000002' });
  assert.equal(magic.body.output_ResponseCode, 'INS-2006');
  await t.done();
});

test('c2b: validation errors, duplicate conversation IDs, bad session in strict mode', async () => {
  const t = await setup({ mode: 'auto', strict: true });
  assert.equal((await t.c2b({ input_Amount: '-1' })).body.output_ResponseCode, 'INS-15');
  assert.equal((await t.c2b({ input_Country: 'KEN' })).body.output_ResponseCode, 'INS-998');
  assert.equal((await t.c2b({ input_CustomerMSISDN: '12345' })).body.output_ResponseCode, 'INS-2051');
  assert.equal((await t.c2b({ input_PurchasedItemsDesc: '' })).body.output_ResponseCode, 'INS-20');

  const first = await t.c2b({ input_ThirdPartyConversationID: 'same-id' });
  assert.equal(first.status, 201);
  const dup = await t.c2b({ input_ThirdPartyConversationID: 'same-id' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.output_ResponseCode, 'INS-10');

  const bad = await call(`${t.base}/c2bPayment/singleStage/`, { method: 'POST', token: 'garbage', headers: t.origin, json: {} });
  assert.equal(bad.status, 401);
  await t.done();
});

test('query, reversal and b2c', async () => {
  const t = await setup({ mode: 'auto' });
  const paid = await t.c2b({ input_ThirdPartyConversationID: 'order-77' });
  const q = (ref) => call(`${t.base}/queryTransactionStatus/?input_QueryReference=${ref}&input_ServiceProviderCode=000000&input_ThirdPartyConversationID=q-${Math.random()}&input_Country=TZN`, { token: t.session, headers: t.origin });
  assert.equal((await q('order-77')).body.output_ResponseTransactionStatus, 'Completed');
  assert.equal((await q(paid.body.output_TransactionID)).body.output_ResponseTransactionStatus, 'Completed');
  assert.equal((await q('missing')).body.output_ResponseCode, 'INS-18');

  const rev = await call(`${t.base}/reversal/`, {
    method: 'PUT', token: t.session, headers: t.origin,
    json: { input_Country: 'TZN', input_ReversalAmount: '5000', input_ServiceProviderCode: '000000', input_ThirdPartyConversationID: 'rev-1', input_TransactionID: paid.body.output_TransactionID },
  });
  assert.equal(rev.body.output_ResponseCode, 'INS-0');
  assert.equal((await q('order-77')).body.output_ResponseTransactionStatus, 'Reversed');

  const b2c = await call(`${t.base}/b2cPayment/`, {
    method: 'POST', token: t.session, headers: t.origin,
    json: { input_Amount: '1000', input_Country: 'TZN', input_Currency: 'TZS', input_CustomerMSISDN: '255754123456', input_ServiceProviderCode: '000000', input_ThirdPartyConversationID: 'pay-1', input_TransactionReference: 'SAL1', input_PaymentItemsDesc: 'Salary' },
  });
  assert.equal(b2c.status, 201);
  assert.equal(b2c.body.output_ResponseCode, 'INS-0');
  await t.done();
});

test('a client that gives up early can still recover the result by querying', async () => {
  const t = await setup();
  const controller = new AbortController();
  const req = fetch(`${t.base}/c2bPayment/singleStage/`, {
    method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t.session}`, origin: '*' },
    body: JSON.stringify({ input_Amount: '700', input_Country: 'TZN', input_Currency: 'TZS', input_CustomerMSISDN: '255754123456', input_ServiceProviderCode: '000000', input_ThirdPartyConversationID: 'lost-1', input_TransactionReference: 'L1', input_PurchasedItemsDesc: 'Book' }),
  }).catch(() => 'aborted');
  const txn = await until(() => t.l.transactions().find((x) => x.status === 'pending'));
  controller.abort();
  assert.equal(await req, 'aborted');
  t.l.resolve(txn.id, 'success');
  const q = await call(`${t.base}/queryTransactionStatus/?input_QueryReference=lost-1&input_ServiceProviderCode=000000&input_ThirdPartyConversationID=q1&input_Country=TZN`, { token: t.session, headers: t.origin });
  assert.equal(q.body.output_ResponseTransactionStatus, 'Completed');
  await t.done();
});
