import test from 'node:test';
import assert from 'node:assert/strict';
import { lab, receiver, call, until } from '../support/helpers.js';

test('airtel: collection in Tanzania and Kenya, callback, status, refund', async () => {
  const hook = await receiver({});
  const l = await lab({ mode: 'auto', callbackUrls: { airtel: `${hook.url}/airtel` } });
  const base = l.urls.airtel;
  const c = l.credentials.airtel;
  const auth = await call(`${base}/auth/oauth2/token`, { method: 'POST', json: { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials' } });
  assert.equal(auth.body.token_type, 'bearer');
  const token = auth.body.access_token;

  const tz = { 'x-country': 'TZ', 'x-currency': 'TZS' };
  const pay = await call(`${base}/merchant/v1/payments/`, {
    method: 'POST', token, headers: tz,
    json: { reference: 'Order 9', subscriber: { country: 'TZ', currency: 'TZS', msisdn: '689123456' }, transaction: { amount: 3000, country: 'TZ', currency: 'TZS', id: 'air-1' } },
  });
  assert.equal(pay.body.status.success, true);
  assert.equal(pay.body.status.response_code, 'DP00800001006');
  const cb = (await hook.call(1)).body.transaction;
  assert.equal(cb.id, 'air-1');
  assert.equal(cb.status_code, 'TS');
  assert.match(cb.airtel_money_id, /^MP\d{6}\.\d{4}\.[A-Z0-9]\d{5}$/);
  assert.match(cb.message, /Paid TZS 3,000/);

  const status = await call(`${base}/standard/v1/payments/air-1`, { token, headers: tz });
  assert.equal(status.body.data.transaction.status, 'TS');

  const refund = await call(`${base}/standard/v1/payments/refund`, { method: 'POST', token, headers: tz, json: { transaction: { airtel_money_id: cb.airtel_money_id } } });
  assert.equal(refund.body.status.success, true);

  // Kenya, failing, with a different currency
  l.queue('insufficient_funds');
  const ke = { 'x-country': 'KE', 'x-currency': 'KES' };
  await call(`${base}/merchant/v2/payments/`, {
    method: 'POST', token, headers: ke,
    json: { reference: 'Order 10', subscriber: { country: 'KE', currency: 'KES', msisdn: '733123456' }, transaction: { amount: 50, country: 'KE', currency: 'KES', id: 'air-2' } },
  });
  assert.equal((await hook.call(2)).body.transaction.status_code, 'TF');
  const failed = await call(`${base}/standard/v1/payments/air-2`, { token, headers: ke });
  assert.equal(failed.body.status.response_code, 'DP00800001007');
  assert.equal(l.transactions().at(-1).msisdn, '254733123456');

  const wrongCurrency = await call(`${base}/standard/v1/payments/air-2`, { token, headers: { 'x-country': 'KE', 'x-currency': 'TZS' } });
  assert.equal(wrongCurrency.status, 400);

  const out = await call(`${base}/standard/v1/disbursements/`, {
    method: 'POST', token, headers: tz,
    json: { payee: { msisdn: '689123456' }, reference: 'Payout', pin: 'encrypted-pin', transaction: { amount: 1000, id: 'out-1' } },
  });
  assert.equal(out.body.data.transaction.status, 'TS');
  await hook.close();
  await l.stop();
});

test('yas: form-encoded token, push bill pay, callback, and the ack check', async () => {
  const hook = await receiver({ nonsense: true });
  const l = await lab({ mode: 'auto' });
  const base = l.urls.yas;
  const c = l.credentials.yas;
  const auth = await call(`${base}/token`, { method: 'POST', form: { username: c.username, password: c.password, grant_type: 'password' } });
  assert.equal(auth.status, 200);
  const token = auth.body.access_token;

  const push = (ref, scenario) => call(`${base}/API/BillerPayment/BillerPay`, {
    method: 'POST', token,
    headers: { username: c.username, password: c.password, 'x-pesalab-callback-url': `${hook.url}/yas`, ...(scenario ? { 'x-pesalab-scenario': scenario } : {}) },
    json: { CustomerMSISDN: '255712345678', BillerMSISDN: c.billerMsisdn, Amount: 2000, Remarks: 'School fees', ReferenceID: ref },
  });
  const r = await push('REF-1');
  assert.equal(r.body.ResponseCode, 'BILLER-18-0000-S');
  assert.equal(r.body.ResponseStatus, true);
  const cb = (await hook.call(1)).body;
  assert.equal(cb.Status, true);
  assert.equal(cb.ReferenceID, 'REF-1');
  assert.ok(cb.MFSTransactionID);
  const txn = await until(() => l.transactions().find((x) => x.warnings.some((w) => /callback endpoint should reply/.test(w))));
  assert.ok(txn);

  await push('REF-2', 'cancelled');
  assert.equal((await hook.call(2)).body.Status, false);
  assert.equal((await push('REF-1')).body.ResponseStatus, false);
  await hook.close();
  await l.stop();
});

test('azampay: token, HaloPesa checkout, callback, provider validation', async () => {
  const hook = await receiver({});
  const l = await lab({ mode: 'auto', callbackUrls: { azampay: `${hook.url}/azam` } });
  const base = l.urls.azampay;
  const c = l.credentials.azampay;
  const auth = await call(`${base}/AppRegistration/GenerateToken`, { method: 'POST', json: { appName: c.appName, clientId: c.clientId, clientSecret: c.clientSecret } });
  assert.equal(auth.body.success, true);
  const token = auth.body.data.accessToken;
  const headers = { 'x-api-key': c.apiKey };

  const checkout = (over) => call(`${base}/azampay/mno/checkout`, {
    method: 'POST', token, headers,
    json: { accountNumber: '0621234567', amount: '2000', currency: 'TZS', externalId: 'ext-1', provider: 'Halopesa', ...over },
  });
  const r = await checkout();
  assert.equal(r.body.success, true);
  const cb = (await hook.call(1)).body;
  assert.equal(cb.transactionstatus, 'success');
  assert.equal(cb.operator, 'Halopesa');
  assert.equal(cb.utilityref, 'ext-1');
  assert.equal(cb.reference, r.body.transactionId);
  assert.equal(cb.msisdn, '255621234567');

  assert.equal((await checkout({ provider: 'Vodacom' })).status, 400);
  assert.equal((await call(`${base}/azampay/mno/checkout`, { method: 'POST', json: {} })).status, 401);
  const status = await call(`${base}/azampay/transactionstatus?reference=ext-1&bankName=Halopesa`, { token, headers });
  assert.equal(status.body.data, 'success');
  await hook.close();
  await l.stop();
});

test('control API: reset, wallets, unknown paths', async () => {
  const l = await lab();
  const w = await call(`${l.url}/_pesalab/api/wallets`, { method: 'POST', json: { msisdn: '0744000111', country: 'TZ', name: 'Mama Ntilie', balance: 10 } });
  assert.equal(w.body.msisdn, '255744000111');
  assert.equal(w.body.balance, 10);
  await call(`${l.url}/_pesalab/api/reset`, { method: 'POST' });
  const state = await call(`${l.url}/_pesalab/api/state`);
  assert.ok(!state.body.wallets.some((x) => x.msisdn === '255744000111'));
  assert.equal(state.body.providers.length, 5);
  assert.equal((await call(`${l.url}/nowhere`)).status, 404);
  assert.equal((await call(`${l.urls['mpesa-ke']}/mpesa/unknown`)).body.pesalab, true);
  await l.stop();
});
