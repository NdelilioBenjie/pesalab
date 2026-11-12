// M-Pesa Tanzania (Vodacom OpenAPI) against pesalab.
//
//   1. node bin/pesalab.js
//   2. node examples/mpesa-tz.mjs
//   3. Answer the prompt in the dashboard. This script prints the result.
//
// The only change from production code is BASE and PUBLIC_KEY.

import crypto from 'node:crypto';

const LAB = process.env.PESALAB_URL || 'http://127.0.0.1:4010';
const BASE = `${LAB}/mpesa-tz/sandbox/ipg/v2/vodacomTZN`;

// In a real app these come from your environment. Here we read them from the sandbox.
const { credentials } = await (await fetch(`${LAB}/_pesalab/api/state`)).json();
const { apiKey: API_KEY, publicKey: PUBLIC_KEY } = credentials['mpesa-tz'];

function encrypt(value) {
  const pem = `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY}\n-----END PUBLIC KEY-----`;
  return crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(value)).toString('base64');
}

const headers = (secret) => ({ 'Content-Type': 'application/json', Origin: '*', Authorization: `Bearer ${encrypt(secret)}` });

const session = await (await fetch(`${BASE}/getSession/`, { headers: headers(API_KEY) })).json();
console.log('Session:', session.output_ResponseCode);

console.log('Payment requested. Waiting for the customer (open the dashboard)…');
const res = await fetch(`${BASE}/c2bPayment/singleStage/`, {
  method: 'POST',
  headers: headers(session.output_SessionID),
  body: JSON.stringify({
    input_Amount: '5000',
    input_Country: 'TZN',
    input_Currency: 'TZS',
    input_CustomerMSISDN: process.argv[2] || '255754123456',
    input_ServiceProviderCode: '000000',
    input_ThirdPartyConversationID: crypto.randomUUID().replaceAll('-', ''),
    input_TransactionReference: 'ORDER1042',
    input_PurchasedItemsDesc: 'Viatu',
  }),
});
console.log(res.status, await res.json());
