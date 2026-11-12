import http from 'node:http';
import crypto from 'node:crypto';
import { start } from '../src/index.js';

/** A tiny webhook receiver standing in for the developer's app. */
export async function receiver(reply = { ResultCode: 0, ResultDesc: 'Accepted' }) {
  const calls = [];
  const waiters = [];
  const state = { reply, status: 200 };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const call = { path: req.url, body: raw ? JSON.parse(raw) : null };
    calls.push(call);
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(typeof state.reply === 'function' ? state.reply(call) : state.reply));
    waiters.splice(0).forEach((w) => w(call));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    state,
    /** Resolves with the call number `n` (1-based), waiting if it has not arrived yet. */
    async call(n = 1, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (calls.length < n) {
        if (Date.now() > deadline) throw new Error(`Expected ${n} webhook call(s), got ${calls.length}`);
        await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
      }
      return calls[n - 1];
    },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

export const lab = (settings = {}, extra = {}) =>
  start({ port: 0, onError: () => {}, settings: { autoDelayMs: 15, ...settings }, ...extra });

export async function call(url, { method = 'GET', headers = {}, json, form, token } = {}) {
  const h = { ...headers };
  let body;
  if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form !== undefined) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers: h, body });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: parsed, text };
}

export const until = async (fn, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((r) => setTimeout(r, 15));
  }
};

/** Encrypt the way Vodacom OpenAPI clients do: RSA PKCS#1 v1.5, base64. */
export function rsaEncrypt(publicKeyBase64, value) {
  const pem = `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64}\n-----END PUBLIC KEY-----`;
  return crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(value)).toString('base64');
}
