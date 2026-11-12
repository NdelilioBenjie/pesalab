// Control API and dashboard, served under /_pesalab.
// Everything the dashboard can do is a plain HTTP call, so tests and CI can do it too.

import fs from 'node:fs';
import { OUTCOMES } from './core/sandbox.js';
import { Router, readBody, parseBody } from './core/http.js';
import { replay } from './core/callbacks.js';
import { customerPaysBusiness } from './providers/mpesa-ke.js';
import { countryOf, currencyOf, isPositiveAmount, normaliseMsisdn } from './core/util.js';

const DASHBOARD = new URL('./dashboard/index.html', import.meta.url);

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function applySettings(sb, patch) {
  const s = sb.settings;
  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
  if (patch.mode !== undefined) {
    if (!['manual', 'auto'].includes(patch.mode)) return 'mode must be "manual" or "auto"';
    s.mode = patch.mode;
  }
  if (patch.autoOutcome !== undefined) {
    if (!OUTCOMES.includes(patch.autoOutcome)) return `autoOutcome must be one of ${OUTCOMES.join(', ')}`;
    s.autoOutcome = patch.autoOutcome;
  }
  for (const k of ['autoDelayMs', 'promptTimeoutMs', 'latencyMs']) if (patch[k] !== undefined) s[k] = num(patch[k], s[k]);
  for (const k of ['strict', 'magicNumbers']) if (patch[k] !== undefined) s[k] = Boolean(patch[k]);
  if (patch.callbacks) {
    const c = patch.callbacks;
    if (c.delayMs !== undefined) s.callbacks.delayMs = num(c.delayMs, s.callbacks.delayMs);
    if (c.duplicate !== undefined) s.callbacks.duplicate = Boolean(c.duplicate);
    if (c.drop !== undefined) s.callbacks.drop = Boolean(c.drop);
  }
  if (patch.callbackUrls) {
    for (const k of Object.keys(s.callbackUrls)) {
      if (patch.callbackUrls[k] !== undefined) s.callbackUrls[k] = String(patch.callbackUrls[k]).trim();
    }
  }
  return null;
}

export function createControl(sb, info) {
  const r = new Router();
  const clients = new Set();

  sb.on('change', () => {
    for (const res of clients) res.write('data: change\n\n');
  });
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  const state = () => ({
    ...sb.snapshot(),
    version: info.version,
    providers: info.providers,
    c2bRegistrations: [...(sb.providerState['mpesa-ke']?.c2b || [])].map(([shortcode, v]) => ({ shortcode, ...v })),
  });

  r.get('/api/state', (c) => json(c.res, 200, state()));

  r.get('/api/events', (c) => {
    c.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    c.res.write('data: hello\n\n');
    clients.add(c.res);
    c.req.on('close', () => clients.delete(c.res));
  });

  r.get('/api/transactions', (c) => {
    let list = [...sb.txns.values()];
    for (const key of ['provider', 'status', 'kind', 'msisdn', 'reference']) {
      if (c.query[key]) list = list.filter((t) => String(t[key]) === c.query[key]);
    }
    json(c.res, 200, list.reverse());
  });

  r.get('/api/transactions/:id', (c) => {
    const txn = sb.txns.get(c.params.id);
    return txn ? json(c.res, 200, txn) : json(c.res, 404, { error: 'No such transaction' });
  });

  r.post('/api/transactions/:id/resolve', (c) => {
    const input = c.body.pin !== undefined ? { pin: c.body.pin } : c.body.outcome;
    const txn = sb.resolve(c.params.id, input, c.body.via || 'dashboard');
    return txn ? json(c.res, 200, txn) : json(c.res, 409, { error: 'Transaction is not waiting for the customer, or the outcome is not valid', outcomes: OUTCOMES });
  });

  r.post('/api/transactions/:id/reverse', (c) => {
    const txn = sb.txns.get(c.params.id);
    if (!txn) return json(c.res, 404, { error: 'No such transaction' });
    return sb.reverse(txn) ? json(c.res, 200, txn) : json(c.res, 409, { error: 'Only a successful payment can be reversed' });
  });

  r.post('/api/transactions/:id/callbacks/:cb/replay', async (c) => {
    const txn = sb.txns.get(c.params.id);
    const attempt = txn && (await replay(sb, txn, c.params.cb));
    return attempt ? json(c.res, 200, attempt) : json(c.res, 404, { error: 'No such callback, or it has no URL' });
  });

  r.patch('/api/settings', (c) => {
    const error = applySettings(sb, c.body);
    sb.changed();
    return error ? json(c.res, 400, { error }) : json(c.res, 200, sb.settings);
  });

  // Script the outcome of the next N payment requests, in order.
  r.post('/api/scenarios', (c) => {
    const list = Array.isArray(c.body.outcomes) ? c.body.outcomes : Array(Number(c.body.times) || 1).fill(c.body.outcome);
    if (!list.length || list.some((o) => !OUTCOMES.includes(o))) return json(c.res, 400, { error: `Outcomes must be from: ${OUTCOMES.join(', ')}` });
    sb.queue.push(...list);
    sb.changed();
    json(c.res, 200, { queue: sb.queue });
  });

  r.delete('/api/scenarios', (c) => {
    sb.queue.length = 0;
    sb.changed();
    json(c.res, 200, { queue: [] });
  });

  r.post('/api/wallets', (c) => {
    const country = ['KE', 'TZ'].includes(c.body.country) ? c.body.country : undefined;
    const msisdn = normaliseMsisdn(c.body.msisdn, country);
    if (!/^25[45]\d{9}$/.test(msisdn)) return json(c.res, 400, { error: 'msisdn must be a Kenyan (254) or Tanzanian (255) mobile number' });
    const w = sb.wallet(msisdn);
    if (c.body.name) w.name = String(c.body.name).slice(0, 60);
    if (c.body.balance !== undefined && Number(c.body.balance) >= 0) w.balance = Number(c.body.balance);
    if (c.body.pin !== undefined && /^\d{4}$/.test(String(c.body.pin))) w.pin = String(c.body.pin);
    w.country = countryOf(msisdn);
    w.currency = currencyOf(w.country);
    sb.changed();
    json(c.res, 200, w);
  });

  r.patch('/api/floats', (c) => {
    if (!info.providers.some((p) => p.id === c.body.provider) || !(Number(c.body.amount) >= 0)) {
      return json(c.res, 400, { error: 'Send { provider, amount }' });
    }
    sb.floats[c.body.provider] = Number(c.body.amount);
    sb.changed();
    json(c.res, 200, sb.floats);
  });

  // A Kenyan customer pays a paybill/till from their own phone.
  r.post('/api/c2b/pay', async (c) => {
    const msisdn = normaliseMsisdn(c.body.msisdn, 'KE');
    if (!/^254\d{9}$/.test(msisdn) || !isPositiveAmount(c.body.amount) || !c.body.shortcode) {
      return json(c.res, 400, { error: 'Send { shortcode, msisdn (2547...), amount, billRef? }' });
    }
    const txn = await customerPaysBusiness(sb, {
      shortcode: c.body.shortcode, msisdn, amount: c.body.amount, billRef: c.body.billRef || '', commandId: c.body.commandId,
    });
    json(c.res, 200, txn);
  });

  r.get('/api/requests', (c) => json(c.res, 200, sb.requests.slice().reverse()));

  r.post('/api/reset', (c) => {
    sb.reset();
    json(c.res, 200, { ok: true });
  });

  async function handle(req, res, url, subPath) {
    if (req.method === 'GET' && (subPath === '/' || subPath === '')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(DASHBOARD));
    }
    const found = r.match(req.method, subPath);
    if (!found || found.wrongMethod) return json(res, 404, { error: `No control endpoint ${req.method} ${subPath}` });
    try {
      const raw = ['GET', 'HEAD', 'DELETE'].includes(req.method) ? '' : await readBody(req);
      const { body } = parseBody(raw, req.headers['content-type'] || '');
      await found.handler({ req, res, params: found.params, query: Object.fromEntries(url.searchParams), body });
    } catch (e) {
      sb.emit('error-log', e);
      if (!res.headersSent) json(res, 500, { error: e.message });
    }
  }

  function close() {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
  }

  return { handle, close };
}
