import { EventEmitter } from 'node:events';
import { hex, countryOf, currencyOf, randomAlnum } from './util.js';

/** Provider-neutral outcomes. Each provider maps these onto its own codes. */
export const OUTCOMES = ['success', 'cancelled', 'timeout', 'wrong_pin', 'insufficient_funds', 'failed'];

/** Test numbers: a phone number ending 0000N always produces the same outcome. */
export const MAGIC_SUFFIXES = {
  '00001': 'success',
  '00002': 'insufficient_funds',
  '00003': 'wrong_pin',
  '00004': 'cancelled',
  '00005': 'timeout',
};

const SEED_WALLETS = [
  // Tanzania
  ['255700000001', 'Neema Mollel', 'always pays'],
  ['255700000002', 'Juma Bakari', 'never has enough balance'],
  ['255700000003', 'Rehema Shirima', 'always enters the wrong PIN'],
  ['255700000004', 'Baraka Mushi', 'always cancels'],
  ['255700000005', 'Zawadi Komba', 'never answers the prompt'],
  ['255754123456', 'Amina Hassan', ''],
  ['255689123456', 'Emmanuel Laizer', ''],
  // Kenya
  ['254700000001', 'Wanjiru Kamau', 'always pays'],
  ['254700000002', 'Otieno Odhiambo', 'never has enough balance'],
  ['254700000003', 'Halima Abdi', 'always enters the wrong PIN'],
  ['254700000004', 'Kiprono Cheruiyot', 'always cancels'],
  ['254700000005', 'Mwende Mutua', 'never answers the prompt'],
  ['254708374149', 'John Doe', ''],
  ['254712345678', 'Achieng Atieno', ''],
];

const DEFAULT_SETTINGS = {
  mode: 'manual', // manual: wait for the dashboard. auto: resolve by itself.
  autoOutcome: 'success',
  autoDelayMs: 1200, // how long a scripted/auto customer takes to respond
  promptTimeoutMs: 60000, // how long a prompt waits for the dashboard before timing out
  latencyMs: 0, // artificial delay on every API response
  strict: false, // reject bad credentials the way the real API would
  magicNumbers: true,
  callbacks: { delayMs: 0, duplicate: false, drop: false },
  callbackUrls: { airtel: '', yas: '', azampay: '' },
};

const DEFAULT_CREDENTIALS = {
  'mpesa-ke': {
    consumerKey: 'pesalab-consumer-key',
    consumerSecret: 'pesalab-consumer-secret',
    shortcode: '174379',
    // Same passkey as Safaricom's public sandbox, so existing test configs keep working.
    passkey: 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919',
    initiatorName: 'testapi',
  },
  'mpesa-tz': {
    apiKey: 'pesalab-tz-api-key',
    serviceProviderCode: '000000',
    publicKey: '', // filled in when the provider starts
  },
  airtel: { clientId: 'pesalab-airtel-client', clientSecret: 'pesalab-airtel-secret' },
  yas: { username: 'pesalab', password: 'pesalab-yas-password', billerMsisdn: '25565000111' },
  azampay: {
    appName: 'pesalab',
    clientId: 'pesalab-azampay-client',
    clientSecret: 'pesalab-azampay-secret',
    apiKey: 'pesalab-azampay-api-key',
  },
};

function merge(base, extra) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') out[k] = merge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export class Sandbox extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.dataDir = options.dataDir || null;
    this.initialSettings = merge(DEFAULT_SETTINGS, options.settings);
    this.credentials = merge(DEFAULT_CREDENTIALS, options.credentials);
    this.timers = new Set();
    this.hooks = new Map(); // txn id -> onResolve callback
    this.tokens = new Map(); // token -> { provider, expiresAt }
    this.providerState = {};
    this.reset();
  }

  /** Back to a clean slate. Credentials and provider keys are kept. */
  reset() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.hooks.clear();
    this.settings = structuredClone(this.initialSettings);
    this.wallets = new Map();
    this.txns = new Map();
    this.requests = [];
    this.queue = [];
    this.floats = {};
    for (const [msisdn, name, note] of SEED_WALLETS) {
      this.wallets.set(msisdn, this.#makeWallet(msisdn, name, note));
    }
    for (const state of Object.values(this.providerState)) state.reset?.();
    this.changed();
  }

  #makeWallet(msisdn, name, note = '') {
    const country = countryOf(msisdn);
    const poor = MAGIC_SUFFIXES[msisdn.slice(-5)] === 'insufficient_funds';
    return {
      msisdn,
      name,
      note,
      country,
      currency: currencyOf(country),
      balance: poor ? 0 : country === 'KE' ? 50000 : 1000000,
      pin: '1234',
    };
  }

  /** Any phone number works: unknown customers are created on first use. */
  wallet(msisdn) {
    let w = this.wallets.get(msisdn);
    if (!w) {
      w = this.#makeWallet(msisdn, 'Test Customer');
      this.wallets.set(msisdn, w);
    }
    return w;
  }

  float(provider) {
    if (this.floats[provider] === undefined) this.floats[provider] = 5000000;
    return this.floats[provider];
  }

  // ---- timers -------------------------------------------------------------

  later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      try {
        const r = fn();
        if (r?.catch) r.catch((e) => this.emit('error-log', e));
      } catch (e) {
        this.emit('error-log', e);
      }
    }, ms);
    this.timers.add(t);
    return t;
  }

  cancel(t) {
    clearTimeout(t);
    this.timers.delete(t);
  }

  changed() {
    if (this._pendingChange) return;
    this._pendingChange = setTimeout(() => {
      this._pendingChange = null;
      this.emit('change');
    }, 40);
    this._pendingChange.unref?.();
  }

  // ---- tokens -------------------------------------------------------------

  issueToken(provider, ttlSeconds, length = 28) {
    const token = randomAlnum(length);
    this.tokens.set(token, { provider, expiresAt: Date.now() + ttlSeconds * 1000 });
    return token;
  }

  tokenState(provider, token) {
    const t = this.tokens.get(token);
    if (!t || t.provider !== provider) return 'unknown';
    if (t.expiresAt < Date.now()) return 'expired';
    return 'valid';
  }

  // ---- transactions -------------------------------------------------------

  newTxn(fields) {
    const txn = {
      id: `txn_${hex(12)}`,
      provider: fields.provider,
      country: fields.country,
      kind: fields.kind, // collection | disbursement | reversal | query
      status: 'pending', // pending | success | failed | reversed
      outcome: null,
      amount: Number(fields.amount) || 0,
      currency: fields.currency || currencyOf(fields.country),
      msisdn: fields.msisdn || '',
      customerName: fields.msisdn ? this.wallet(fields.msisdn).name : '',
      merchant: fields.merchant || '',
      reference: fields.reference || '',
      description: fields.description || '',
      receipt: null,
      ids: fields.ids || {},
      request: fields.request ?? null,
      warnings: fields.warnings || [],
      prompt: null,
      events: [],
      callbacks: [],
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.txns.set(txn.id, txn);
    this.event(txn, 'created', `${fields.kind} request received`);
    return txn;
  }

  event(txn, type, detail = '') {
    txn.events.push({ at: new Date().toISOString(), type, detail });
    this.changed();
  }

  findTxn(predicate) {
    for (const t of this.txns.values()) if (predicate(t)) return t;
    return null;
  }

  /** Decide up front whether this request already has a scripted outcome. */
  plan(ctx, txn) {
    const header = ctx?.headers?.['x-pesalab-scenario'];
    if (header && OUTCOMES.includes(header)) return { outcome: header, source: 'X-Pesalab-Scenario header' };
    if (this.queue.length) {
      const outcome = this.queue.shift();
      this.changed();
      return { outcome, source: 'scenario queue' };
    }
    if (this.settings.magicNumbers && txn.kind === 'collection') {
      const magic = MAGIC_SUFFIXES[txn.msisdn.slice(-5)];
      if (magic) return { outcome: magic, source: 'test phone number' };
    }
    if (this.settings.mode === 'auto') return { outcome: this.settings.autoOutcome, source: 'auto mode' };
    return null;
  }

  /**
   * Put a payment prompt on the customer's (simulated) phone.
   * onResolve(txn) fires exactly once, when the customer has answered or timed out.
   */
  prompt(txn, ctx, onResolve) {
    const planned = this.plan(ctx, txn);
    const wait = planned ? this.settings.autoDelayMs : this.settings.promptTimeoutMs;
    txn.prompt = {
      expiresAt: new Date(Date.now() + wait).toISOString(),
      planned: planned?.outcome || null,
      source: planned?.source || 'dashboard',
    };
    this.hooks.set(txn.id, onResolve);
    this.event(
      txn,
      'prompt',
      planned
        ? `Prompt sent to ${txn.msisdn}. Outcome scripted by ${planned.source}: ${planned.outcome}`
        : `Prompt sent to ${txn.msisdn}. Waiting for the dashboard`,
    );
    txn._timer = this.later(() => this.resolve(txn.id, planned?.outcome || 'timeout', planned ? planned.source : 'prompt timeout'), wait);
    Object.defineProperty(txn, '_timer', { enumerable: false });
    return txn;
  }

  /** Answer a pending prompt. `input` is an outcome name or { pin }. */
  resolve(id, input, via = 'dashboard') {
    const txn = this.txns.get(id);
    if (!txn || txn.status !== 'pending' || !this.hooks.has(id)) return null;
    const wallet = this.wallet(txn.msisdn);

    let outcome = typeof input === 'string' ? input : null;
    if (input && typeof input === 'object' && 'pin' in input) {
      outcome = String(input.pin) === wallet.pin ? 'success' : 'wrong_pin';
    }
    if (!OUTCOMES.includes(outcome)) return null;
    if (outcome === 'success' && wallet.balance < txn.amount) outcome = 'insufficient_funds';

    if (txn._timer) this.cancel(txn._timer);
    if (outcome === 'success') {
      wallet.balance -= txn.amount;
      this.floats[txn.provider] = this.float(txn.provider) + txn.amount;
    }
    txn.status = outcome === 'success' ? 'success' : 'failed';
    txn.outcome = outcome;
    txn.prompt = null;
    txn.resolvedAt = new Date().toISOString();
    this.event(txn, 'resolved', `${outcome} (${via})`);

    const hook = this.hooks.get(id);
    this.hooks.delete(id);
    Promise.resolve()
      .then(() => hook(txn))
      .catch((e) => this.emit('error-log', e));
    return txn;
  }

  /** Settle a customer-initiated payment directly (no prompt, e.g. a paybill payment). */
  finish(txn, outcome, detail = '') {
    if (txn.status !== 'pending') return txn;
    if (outcome === 'success' && txn.kind === 'collection') {
      const wallet = this.wallet(txn.msisdn);
      if (wallet.balance < txn.amount) outcome = 'insufficient_funds';
      else {
        wallet.balance -= txn.amount;
        this.floats[txn.provider] = this.float(txn.provider) + txn.amount;
      }
    }
    txn.status = outcome === 'success' ? 'success' : 'failed';
    txn.outcome = outcome;
    txn.resolvedAt = new Date().toISOString();
    this.event(txn, 'resolved', detail ? `${outcome}: ${detail}` : outcome);
    return txn;
  }

  /** Money out to a customer. No prompt involved, so it settles immediately. */
  settleDisbursement(txn, ctx) {
    const planned = this.plan(ctx, txn);
    let outcome = planned?.outcome && planned.outcome !== 'success' ? 'failed' : 'success';
    if (outcome === 'success' && this.float(txn.provider) < txn.amount) outcome = 'insufficient_funds';
    if (outcome === 'success') {
      this.floats[txn.provider] -= txn.amount;
      if (txn.msisdn) this.wallet(txn.msisdn).balance += txn.amount;
    }
    txn.status = outcome === 'success' ? 'success' : 'failed';
    txn.outcome = outcome;
    txn.resolvedAt = new Date().toISOString();
    this.event(txn, 'resolved', outcome + (planned ? ` (${planned.source})` : ''));
    return outcome;
  }

  /** Undo a completed payment. Returns false when there is nothing to reverse. */
  reverse(txn, via = 'dashboard') {
    if (!txn || txn.status !== 'success' || txn.kind === 'query') return false;
    const wallet = txn.msisdn ? this.wallet(txn.msisdn) : { balance: 0 };
    if (txn.kind === 'collection') {
      wallet.balance += txn.amount;
      this.floats[txn.provider] = this.float(txn.provider) - txn.amount;
    } else if (txn.kind === 'disbursement') {
      wallet.balance -= txn.amount;
      this.floats[txn.provider] = this.float(txn.provider) + txn.amount;
    }
    txn.status = 'reversed';
    this.event(txn, 'reversed', `Reversed (${via})`);
    return true;
  }

  // ---- request log --------------------------------------------------------

  logRequest(entry) {
    this.requests.push(entry);
    if (this.requests.length > 300) this.requests.splice(0, this.requests.length - 300);
    this.changed();
  }

  // ---- snapshot for the dashboard and the control API ----------------------

  snapshot() {
    const txns = [...this.txns.values()].slice(-250).reverse();
    return {
      settings: this.settings,
      credentials: this.credentials,
      outcomes: OUTCOMES,
      magic: MAGIC_SUFFIXES,
      queue: this.queue,
      floats: this.floats,
      wallets: [...this.wallets.values()],
      transactions: txns,
      requests: this.requests.slice(-120).reverse(),
    };
  }

  dispose() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this._pendingChange) clearTimeout(this._pendingChange);
    this.removeAllListeners();
  }
}
