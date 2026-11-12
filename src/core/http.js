import { sleep } from './util.js';

const MAX_BODY = 1024 * 1024;

export const normalisePath = (p) => ('/' + p).replace(/\/+/g, '/').replace(/\/$/, '') || '/';

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const source = normalisePath(pattern)
      .split('/')
      .map((seg) => {
        if (seg.startsWith(':')) {
          keys.push(seg.slice(1));
          return '([^/]+)';
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, pattern, regex: new RegExp(`^${source || '/'}$`, 'i'), keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? { wrongMethod: true } : null;
  }
}

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseBody(raw, contentType = '') {
  if (!raw.trim()) return { body: {}, bad: false };
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return { body: Object.fromEntries(new URLSearchParams(raw)), bad: false };
  }
  try {
    const parsed = JSON.parse(raw);
    return { body: parsed && typeof parsed === 'object' ? parsed : {}, bad: false };
  } catch {
    // Some clients send form data without the header.
    if (/^[\w.%+-]+=/.test(raw)) return { body: Object.fromEntries(new URLSearchParams(raw)), bad: false };
    return { body: {}, bad: true };
  }
}

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
};

export function sendJson(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...headers });
  res.end(text);
}

/**
 * Run one provider request: parse, dispatch, and record it in the request log.
 * Handlers get a ctx and answer with ctx.send(status, json). A handler may hold
 * the response open (Vodacom's API answers only once the customer has responded).
 */
export async function handleProviderRequest(sb, provider, router, req, res, url, subPath) {
  const started = Date.now();
  const ctx = {
    sb,
    req,
    res,
    method: req.method,
    path: subPath,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body: {},
    badJson: false,
    params: {},
    warnings: [],
    warn(message) {
      if (!ctx.warnings.includes(message)) ctx.warnings.push(message);
    },
    bearer() {
      const h = req.headers.authorization || '';
      return /^bearer\s+/i.test(h) ? h.replace(/^bearer\s+/i, '').trim() : '';
    },
    send(status, body, headers) {
      if (ctx.sent) return;
      ctx.sent = true;
      sendJson(res, status, body, headers);
      sb.logRequest({
        at: new Date(started).toISOString(),
        provider: provider.id,
        method: req.method,
        path: subPath + (url.search || ''),
        status,
        ms: Date.now() - started,
        requestBody: ctx.body,
        responseBody: body,
        warnings: ctx.warnings,
        clientGone: ctx.clientGone || false,
      });
    },
  };
  res.on('close', () => {
    if (!ctx.sent) ctx.clientGone = true;
  });

  try {
    const raw = ['GET', 'HEAD'].includes(req.method) ? '' : await readBody(req);
    const parsed = parseBody(raw, req.headers['content-type'] || '');
    ctx.body = parsed.body;
    ctx.badJson = parsed.bad;

    const found = router.match(req.method, subPath);
    if (!found || found.wrongMethod) {
      return ctx.send(found ? 405 : 404, {
        pesalab: true,
        error: found ? `Method ${req.method} is not supported on this path` : `pesalab does not emulate ${req.method} ${subPath} for ${provider.name}`,
        hint: 'See docs/providers.md for the list of emulated endpoints.',
      });
    }
    ctx.params = found.params;
    if (sb.settings.latencyMs > 0) await sleep(sb.settings.latencyMs);
    await found.handler(ctx);
  } catch (e) {
    sb.emit('error-log', e);
    ctx.send(e.statusCode || 500, { pesalab: true, error: `pesalab internal error: ${e.message}` });
  }
}
