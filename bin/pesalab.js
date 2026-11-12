#!/usr/bin/env node
import { parseArgs } from 'node:util';
import path from 'node:path';
import { start, OUTCOMES, VERSION } from '../src/index.js';

const HELP = `pesalab ${VERSION}
A local mobile money sandbox for Tanzania and Kenya.

Usage
  pesalab [options]

Options
  -p, --port <n>            Port to listen on (default 4010, env PESALAB_PORT)
      --host <host>         Interface to bind (default 127.0.0.1; use 0.0.0.0 in Docker)
      --mode <manual|auto>  manual: you answer prompts in the dashboard (default)
                            auto:   every prompt answers itself, for CI
      --outcome <name>      Outcome used in auto mode (default success)
                            One of: ${OUTCOMES.join(', ')}
      --delay <ms>          How long a scripted customer takes to answer (default 1200)
      --timeout <ms>        How long a prompt waits for you before timing out (default 60000)
      --strict              Reject wrong credentials the way the real APIs do
      --airtel-callback <url>   Where Airtel Money callbacks are posted
      --yas-callback <url>      Where Mixx by Yas callbacks are posted
      --azampay-callback <url>  Where AzamPay callbacks are posted
      --data-dir <dir>      Where keys are kept between runs (default ./.pesalab)
  -h, --help
  -v, --version
`;

let args;
try {
  args = parseArgs({
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      mode: { type: 'string' },
      outcome: { type: 'string' },
      delay: { type: 'string' },
      timeout: { type: 'string' },
      strict: { type: 'boolean' },
      'airtel-callback': { type: 'string' },
      'yas-callback': { type: 'string' },
      'azampay-callback': { type: 'string' },
      'data-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  }).values;
} catch (e) {
  console.error(`${e.message}\n\n${HELP}`);
  process.exit(2);
}

if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (args.version) {
  console.log(VERSION);
  process.exit(0);
}

const env = process.env;
const mode = args.mode || env.PESALAB_MODE || 'manual';
const outcome = args.outcome || env.PESALAB_OUTCOME || 'success';
if (!['manual', 'auto'].includes(mode)) {
  console.error('--mode must be manual or auto');
  process.exit(2);
}
if (!OUTCOMES.includes(outcome)) {
  console.error(`--outcome must be one of: ${OUTCOMES.join(', ')}`);
  process.exit(2);
}

const settings = {
  mode,
  autoOutcome: outcome,
  strict: Boolean(args.strict || env.PESALAB_STRICT === '1'),
  callbackUrls: {
    airtel: args['airtel-callback'] || env.PESALAB_AIRTEL_CALLBACK || '',
    yas: args['yas-callback'] || env.PESALAB_YAS_CALLBACK || '',
    azampay: args['azampay-callback'] || env.PESALAB_AZAMPAY_CALLBACK || '',
  },
};
if (args.delay) settings.autoDelayMs = Number(args.delay);
if (args.timeout) settings.promptTimeoutMs = Number(args.timeout);

try {
  const lab = await start({
    port: Number(args.port || env.PESALAB_PORT || 4010),
    host: args.host || env.PESALAB_HOST || '127.0.0.1',
    dataDir: path.resolve(args['data-dir'] || env.PESALAB_DATA_DIR || '.pesalab'),
    settings,
  });

  const pad = (s) => s.padEnd(18);
  console.log(`
  pesalab ${VERSION}  ·  mobile money sandbox for Tanzania and Kenya

  Dashboard          ${lab.dashboard}

  Point your code at these base URLs instead of the real ones:
  ${pad('M-Pesa Tanzania')} ${lab.urls['mpesa-tz']}
  ${pad('M-Pesa Kenya')} ${lab.urls['mpesa-ke']}
  ${pad('Airtel Money')} ${lab.urls.airtel}   (X-Country: TZ or KE)
  ${pad('Mixx by Yas')} ${lab.urls.yas}
  ${pad('AzamPay')} ${lab.urls.azampay}   (HaloPesa, AzamPesa and the rest)

  Mode: ${mode}${mode === 'auto' ? ` (${outcome})` : ' — open the dashboard to answer payment prompts'}
  Credentials and copy-paste examples are in the dashboard. Ctrl+C to stop.
`);

  const shutdown = async () => {
    await lab.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (e) {
  console.error(e.code === 'EADDRINUSE' ? `Port ${args.port || 4010} is already in use. Try --port 4011.` : e);
  process.exit(1);
}
