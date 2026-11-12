import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { lab } from '../support/helpers.js';
import { createGuard } from '../src/core/guard.js';

// fetch() will not let us set Host, so talk raw HTTP the way a browser or attacker would.
function raw(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('a website cannot reset the sandbox with a cross-site POST', async () => {
  const l = await lab();
  l.queue('timeout');
  // A "simple" cross-site request: text/plain needs no preflight, so only an Origin check stops it.
  const r = await raw(l.port, {
    method: 'POST', path: '/_pesalab/api/reset',
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{}',
  });
  assert.equal(r.status, 403);
  assert.match(r.json.error, /evil\.example/);
  assert.deepEqual(l.sandbox.queue, ['timeout'], 'the queue must survive the attack');
  await l.stop();
});

test('a website cannot drive the provider APIs or their preflight', async () => {
  const l = await lab();
  const post = await raw(l.port, {
    method: 'POST', path: '/mpesa-ke/mpesa/stkpush/v1/processrequest',
    headers: { origin: 'http://attacker.test', 'content-type': 'text/plain' },
    body: { CallBackURL: 'http://192.168.1.1/admin' },
  });
  assert.equal(post.status, 403);
  const preflight = await raw(l.port, {
    method: 'OPTIONS', path: '/mpesa-ke/mpesa/stkpush/v1/processrequest',
    headers: { origin: 'http://attacker.test', 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  assert.equal(l.transactions().length, 0);
  await l.stop();
});

test('DNS rebinding: requests addressed to a foreign domain are refused', async () => {
  const l = await lab();
  const r = await raw(l.port, { path: '/_pesalab/api/state', headers: { host: `rebind.attacker.test:${l.port}` } });
  assert.equal(r.status, 403);
  assert.match(r.json.hint, /--allow-host/);
  assert.equal(r.json.credentials, undefined, 'no state may leak');
  await l.stop();
});

test('normal use keeps working: dashboard, local front ends, servers, Docker names', async () => {
  const l = await lab();
  const p = l.port;
  // The dashboard itself (same origin) and a local front end on another port.
  assert.equal((await raw(p, { path: '/_pesalab/', headers: { host: `127.0.0.1:${p}` } })).status, 200);
  const local = await raw(p, {
    method: 'POST', path: '/_pesalab/api/scenarios',
    headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: { outcomes: ['success'] },
  });
  assert.equal(local.status, 200);
  // Server-side clients send no Origin.
  assert.equal((await raw(p, { path: '/_pesalab/api/state' })).status, 200);
  // Docker service names, IPs and *.localhost are fine.
  for (const host of [`pesalab:${p}`, `[::1]:${p}`, `10.0.0.5:${p}`, `app.localhost:${p}`]) {
    assert.equal((await raw(p, { path: '/_pesalab/api/state', headers: { host } })).status, 200, host);
  }
  await l.stop();
});

test('--allow-origin and --allow-host widen the rules on purpose', async () => {
  const l = await lab({}, { allowedOrigins: ['https://app.example.com'], allowedHosts: ['pesalab.dev.example.com'] });
  const okOrigin = await raw(l.port, { path: '/_pesalab/api/state', headers: { origin: 'https://app.example.com/' } });
  assert.equal(okOrigin.status, 200);
  const otherOrigin = await raw(l.port, { path: '/_pesalab/api/state', headers: { origin: 'https://other.example.com' } });
  assert.equal(otherOrigin.status, 403);
  const okHost = await raw(l.port, { path: '/_pesalab/api/state', headers: { host: 'pesalab.dev.example.com' } });
  assert.equal(okHost.status, 200);
  await l.stop();
});

test('guard rules', () => {
  const g = createGuard();
  assert.equal(g.originAllowed('null'), false);
  assert.equal(g.originAllowed('*'), true, 'Vodacom clients send Origin: * from servers');
  assert.equal(g.originAllowed('http://127.0.0.1:5173'), true);
  assert.equal(g.originAllowed('http://1.2.3.4'), false, 'a public IP page is still a foreign site');
  assert.equal(g.hostAllowed('localhost:4010'), true);
  assert.equal(g.hostAllowed('evil.com'), false);
  assert.equal(createGuard({ allowedOrigins: '*' }).originAllowed('https://anything.example'), true);
});
