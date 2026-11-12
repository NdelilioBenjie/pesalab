// M-Pesa Kenya (Daraja) STK push against pesalab, with a callback receiver.
//
//   1. node bin/pesalab.js
//   2. node examples/mpesa-ke.mjs
//   3. Answer the prompt in the dashboard. The callback is printed here.

import http from 'node:http';

const LAB = process.env.PESALAB_URL || 'http://127.0.0.1:4010';
const BASE = `${LAB}/mpesa-ke`; // production: https://api.safaricom.co.ke

const { credentials } = await (await fetch(`${LAB}/_pesalab/api/state`)).json();
const { consumerKey, consumerSecret, shortcode, passkey } = credentials['mpesa-ke'];

// Your app's callback endpoint.
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const cb = JSON.parse(raw).Body.stkCallback;
  console.log(`Callback: ResultCode ${cb.ResultCode} — ${cb.ResultDesc}`);
  if (cb.CallbackMetadata) console.log(cb.CallbackMetadata.Item);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }));
  server.close();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const callbackUrl = `http://127.0.0.1:${server.address().port}/callback`;

const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
const { access_token } = await (await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } })).json();

const timestamp = new Date(Date.now() + 3 * 3600e3).toISOString().replace(/\D/g, '').slice(0, 14);
const phone = process.argv[2] || '254708374149';
const res = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    BusinessShortCode: shortcode,
    Password: Buffer.from(shortcode + passkey + timestamp).toString('base64'),
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: 100,
    PartyA: phone,
    PartyB: shortcode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: 'ORDER-1042',
    TransactionDesc: 'Shoes',
  }),
});
console.log('STK push accepted:', await res.json());
console.log('Waiting for the customer (open the dashboard)…');
