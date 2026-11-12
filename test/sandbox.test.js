import test from 'node:test';
import assert from 'node:assert/strict';
import { Sandbox } from '../src/core/sandbox.js';

function paid(sb, fields) {
  const txn = sb.newTxn({ provider: 'mpesa-ke', country: 'KE', kind: 'collection', ...fields });
  sb.finish(txn, 'success');
  return txn;
}

test('refunding a payment never pushes the business float below zero', () => {
  const sb = new Sandbox();
  const txn = paid(sb, { amount: 1000, msisdn: '254712345678' });
  sb.floats['mpesa-ke'] = 400; // the merchant has since paid most of it out

  assert.equal(sb.reversalBlocker(txn), 'insufficient_float');
  assert.equal(sb.reverse(txn), false);
  assert.equal(sb.floats['mpesa-ke'], 400);
  assert.equal(txn.status, 'success', 'the payment stays settled');

  sb.floats['mpesa-ke'] = 5000;
  const before = sb.wallet('254712345678').balance;
  assert.equal(sb.reverse(txn), true);
  assert.equal(sb.floats['mpesa-ke'], 4000);
  assert.equal(sb.wallet('254712345678').balance, before + 1000);
  assert.equal(sb.reversalBlocker(txn), 'already_reversed');
  sb.dispose();
});

test('reversing a payout needs the customer to still have the money', () => {
  const sb = new Sandbox();
  const txn = sb.newTxn({ provider: 'mpesa-ke', country: 'KE', kind: 'disbursement', amount: 2000, msisdn: '254712345678' });
  assert.equal(sb.settleDisbursement(txn, null), 'success');
  sb.wallet('254712345678').balance = 500; // the customer spent it

  assert.equal(sb.reversalBlocker(txn), 'insufficient_customer_balance');
  assert.equal(sb.reverse(txn), false);
  assert.equal(sb.wallet('254712345678').balance, 500);
  sb.dispose();
});

test('expired tokens are dropped when new ones are issued', () => {
  const sb = new Sandbox();
  const old = sb.issueToken('mpesa-ke', 3600);
  sb.tokens.get(old).expiresAt = Date.now() - 1;
  const fresh = sb.issueToken('mpesa-ke', 3600);
  assert.equal(sb.tokens.has(old), false);
  assert.equal(sb.tokenState('mpesa-ke', fresh), 'valid');
  sb.dispose();
});
