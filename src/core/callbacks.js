import { hex, sleep } from './util.js';

const TIMEOUT_MS = 10000;

async function post(url, payload, headers) {
  const started = Date.now();
  const attempt = { at: new Date().toISOString(), status: null, ms: 0, ok: false, error: null, response: null };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'pesalab', ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    attempt.status = res.status;
    attempt.ok = res.ok;
    attempt.response = (await res.text()).slice(0, 2000);
  } catch (e) {
    attempt.error = e.name === 'TimeoutError' ? `No response within ${TIMEOUT_MS / 1000}s` : e.cause?.code || e.cause?.message || e.message;
  }
  attempt.ms = Date.now() - started;
  return attempt;
}

/**
 * Deliver a webhook to the developer's app and keep a full record on the transaction.
 * Honours the "callback chaos" settings (delay, duplicate, drop) unless chaos is false.
 * Returns the first attempt so callers can read the app's reply.
 */
export async function deliver(sb, txn, { label, url, payload, headers = {}, chaos = true }) {
  const record = { id: `cb_${hex(8)}`, label, url: url || '', payload, headers, attempts: [] };
  txn.callbacks.push(record);
  const { delayMs, duplicate, drop } = sb.settings.callbacks;

  if (!url) {
    record.attempts.push({ at: new Date().toISOString(), ok: false, error: 'No callback URL configured', ms: 0 });
    sb.event(txn, 'callback', `${label}: no callback URL configured`);
    return record.attempts[0];
  }
  if (chaos && drop) {
    record.attempts.push({ at: new Date().toISOString(), ok: false, dropped: true, error: 'Dropped on purpose (callback chaos)', ms: 0 });
    sb.event(txn, 'callback', `${label}: dropped on purpose`);
    return record.attempts[0];
  }
  if (chaos && delayMs > 0) await sleep(delayMs);

  const first = await post(url, payload, headers);
  record.attempts.push(first);
  sb.event(txn, 'callback', `${label} -> ${first.status || first.error} in ${first.ms}ms`);

  if (chaos && duplicate) {
    await sleep(300);
    const second = await post(url, payload, headers);
    second.duplicate = true;
    record.attempts.push(second);
    sb.event(txn, 'callback', `${label} (duplicate) -> ${second.status || second.error}`);
  }
  return first;
}

/** Send a recorded callback again, exactly as it was. */
export async function replay(sb, txn, callbackId) {
  const record = txn.callbacks.find((c) => c.id === callbackId);
  if (!record || !record.url) return null;
  const attempt = await post(record.url, record.payload, record.headers);
  attempt.replay = true;
  record.attempts.push(attempt);
  sb.event(txn, 'callback', `${record.label} (replay) -> ${attempt.status || attempt.error}`);
  return attempt;
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
