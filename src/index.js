import http from 'node:http';
import fs from 'node:fs';
import { Sandbox, OUTCOMES, MAGIC_SUFFIXES } from './core/sandbox.js';
import { Router, CORS, handleProviderRequest, normalisePath } from './core/http.js';
import { createControl } from './control.js';
import mpesaKe from './providers/mpesa-ke.js';
import mpesaTz from './providers/mpesa-tz.js';
import airtel from './providers/airtel.js';
import yas from './providers/yas.js';
import azampay from './providers/azampay.js';

export { OUTCOMES, MAGIC_SUFFIXES };
export const PROVIDERS = [mpesaTz, mpesaKe, airtel, yas, azampay];
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * Start a sandbox.
 *
 *   const lab = await start({ port: 0, settings: { mode: 'auto' } });
 *   // point your payment client at lab.urls['mpesa-tz'] ...
 *   await lab.stop();
 *
 * @param {object} [options]
 * @param {number} [options.port=4010]  0 picks a free port (handy in tests)
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.dataDir]    where the Tanzanian RSA key is kept between runs
 * @param {object} [options.settings]   see docs: mode, autoOutcome, autoDelayMs, callbacks ...
 * @param {object} [options.credentials] override the default sandbox credentials
 */
export async function start(options = {}) {
  const host = options.host || '127.0.0.1';
  const sb = new Sandbox(options);
  sb.on('error-log', (e) => (options.onError || console.error)(e));

  const mounted = PROVIDERS.map((provider) => {
    provider.setup?.(sb);
    const router = new Router();
    provider.routes(router, sb);
    return { provider, router, prefix: `/${provider.id}` };
  });

  const info = {
    version: VERSION,
    providers: PROVIDERS.map((p) => ({ id: p.id, name: p.name, api: p.api, country: p.country, realBaseUrl: p.realBaseUrl, basePath: `/${p.id}` })),
  };
  const control = createControl(sb, info);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://pesalab.local');
    const path = normalisePath(url.pathname);

    if (path === '/') {
      res.writeHead(302, { location: '/_pesalab/' });
      return res.end();
    }
    if (path === '/_pesalab' || path.startsWith('/_pesalab/')) {
      return control.handle(req, res, url, path.slice('/_pesalab'.length) || '/');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    const m = mounted.find((x) => path === x.prefix || path.startsWith(`${x.prefix}/`));
    if (!m) {
      res.writeHead(404, { 'content-type': 'application/json', ...CORS });
      return res.end(JSON.stringify({
        pesalab: true,
        error: `Unknown path ${path}. Every provider lives under its own prefix.`,
        providers: Object.fromEntries(mounted.map((x) => [x.provider.name, x.prefix])),
      }));
    }
    return handleProviderRequest(sb, m.provider, m.router, req, res, url, path.slice(m.prefix.length) || '/');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4010, host, resolve);
  });
  const { port } = server.address();
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

  return {
    sandbox: sb,
    server,
    port,
    url,
    dashboard: `${url}/_pesalab/`,
    urls: Object.fromEntries(mounted.map((x) => [x.provider.id, url + x.prefix])),
    credentials: sb.credentials,
    /** Script the outcomes of the next payment requests, in order. */
    queue(...outcomes) {
      for (const o of outcomes.flat()) {
        if (!OUTCOMES.includes(o)) throw new Error(`Unknown outcome "${o}". Use one of: ${OUTCOMES.join(', ')}`);
        sb.queue.push(o);
      }
    },
    /** Answer a waiting prompt as the customer would. */
    resolve: (id, outcome) => sb.resolve(id, outcome, 'test'),
    transactions: () => [...sb.txns.values()],
    reset: () => sb.reset(),
    async stop() {
      control.close();
      sb.dispose();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
