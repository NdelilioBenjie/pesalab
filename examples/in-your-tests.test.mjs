// Using pesalab inside your own test suite: no dashboard, no clicking, no network.
//
//   node --test examples/in-your-tests.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/index.js'; // in your project: import { start } from 'pesalab'

test('checkout marks the order unpaid when the customer cancels', async () => {
  const lab = await start({ port: 0, settings: { mode: 'auto', autoDelayMs: 10 } });

  // Tell the sandbox what the next customer will do.
  lab.queue('cancelled');

  // ...run your real checkout code here, pointed at lab.urls.azampay.
  const c = lab.credentials.azampay;
  const token = (await (await fetch(`${lab.urls.azampay}/AppRegistration/GenerateToken`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appName: c.appName, clientId: c.clientId, clientSecret: c.clientSecret }),
  })).json()).data.accessToken;
  await fetch(`${lab.urls.azampay}/azampay/mno/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-api-key': c.apiKey },
    body: JSON.stringify({ accountNumber: '255621234567', amount: '5000', currency: 'TZS', externalId: 'order-1', provider: 'Halopesa' }),
  });

  // The sandbox keeps a record you can assert on.
  await new Promise((r) => setTimeout(r, 80));
  const [txn] = lab.transactions();
  assert.equal(txn.status, 'failed');
  assert.equal(txn.outcome, 'cancelled');

  await lab.stop();
});
