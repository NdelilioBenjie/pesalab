# pesalab

A mobile money sandbox that runs on your laptop, built for Tanzania and Kenya.

pesalab imitates the payment APIs East African developers integrate with: M-Pesa
(both the Tanzanian and the Kenyan API, which are completely different), Airtel
Money, Mixx by Yas and AzamPay. You point your code at `localhost` instead of the
provider, and a dashboard shows each payment prompt on a simulated phone so you
can answer it as the customer: pay, cancel, mistype the PIN, or ignore it.

The official sandboxes mostly let you test the happy path. The cases that break
real apps are the other ones: the customer cancels, the prompt times out, the
callback never arrives, the callback arrives twice. pesalab makes each of those
a button, a test phone number, or one line in a test.

No account, no internet, no tunnel, no dependencies.

![A Kenyan STK push from a Node script appears on the simulated phone, the customer enters a PIN, and the payment shows as paid with its callback delivered](https://raw.githubusercontent.com/NdelilioBenjie/pesalab/main/media/demo.gif)

## Start it

Requires Node.js 18.17 or newer.

```bash
npx pesalab
```

Or add it to a project with `npm install --save-dev pesalab`, or run it from a
clone:

```bash
git clone https://github.com/NdelilioBenjie/pesalab.git
cd pesalab
node bin/pesalab.js
```

Or with Docker:

```bash
docker build -t pesalab https://github.com/NdelilioBenjie/pesalab.git
docker run --rm -p 4010:4010 pesalab
```

Open the dashboard at <http://127.0.0.1:4010/_pesalab/>. The **Connect your app**
tab has the base URL, credentials and a copy-paste terminal command for every
provider.

Then try a full payment:

```bash
node examples/mpesa-tz.mjs     # Vodacom M-Pesa, Tanzania
node examples/mpesa-ke.mjs     # Safaricom M-Pesa, Kenya
```

Each prints "waiting for the customer". Answer the prompt in the dashboard and
watch the result come back.

## What it imitates

| Provider | Country | API | Base URL in pesalab | What works |
|---|---|---|---|---|
| M-Pesa | Tanzania | Vodacom M-Pesa OpenAPI | `/mpesa-tz` | Session (RSA-encrypted key), C2B, B2C, B2B, reversal, status query |
| M-Pesa | Kenya | Safaricom Daraja | `/mpesa-ke` | OAuth, STK push and query, C2B register/validate/confirm, B2C, reversal, transaction status, account balance |
| Airtel Money | Tanzania, Kenya | Airtel Africa Open API | `/airtel` | OAuth, collection, status, refund, disbursement, KYC lookup |
| Mixx by Yas (ex Tigo Pesa) | Tanzania | Push BillPay | `/yas` | Token, push bill pay, callback |
| AzamPay | Tanzania | MNO checkout | `/azampay` | Token, checkout on Airtel, Tigo/Yas, HaloPesa, AzamPesa and M-Pesa, disbursement, status |

HaloPesa and AzamPesa have no public API of their own, so they are covered through
AzamPay, which is how most Tanzanian apps reach them. T-Pesa and T-Kash are not
covered yet.

How closely each provider is imitated, and which details are confirmed against
public documentation and which are approximations, is written down honestly in
[docs/providers.md](docs/providers.md). Read it before you rely on an exact error
code.

## Making payments fail on purpose

Every payment ends in one of six outcomes. Each provider reports them with its own
codes, exactly as your app will see them in production.

| Outcome | M-Pesa Kenya | M-Pesa Tanzania | Airtel | Yas | AzamPay |
|---|---|---|---|---|---|
| `success` | ResultCode `0` | `INS-0` | `TS` | `Status: true` | `success` |
| `cancelled` | `1032` | `INS-5` | `TF` | `Status: false` | `failure` |
| `timeout` | `1037` | `INS-9` | `TF` | `Status: false` | `failure` |
| `wrong_pin` | `2001` | `INS-2001` | `TF` | `Status: false` | `failure` |
| `insufficient_funds` | `1` | `INS-2006` | `TF` | `Status: false` | `failure` |
| `failed` | `1025` | `INS-6` | `TF` | `Status: false` | `failure` |

There are four ways to choose the outcome.

**1. The dashboard.** In the default manual mode every prompt waits on a simulated
phone. Type the PIN (1234 unless you changed it) or press Cancel, Not enough
balance, or Ignore it. Leave it alone and it times out after 60 seconds.

**2. Test phone numbers.** These customers always do the same thing, with no
clicking. Use them the way you use Stripe test cards.

| Number ends in | Tanzania | Kenya | The customer always |
|---|---|---|---|
| `00001` | 255700000001 | 254700000001 | pays |
| `00002` | 255700000002 | 254700000002 | has no balance |
| `00003` | 255700000003 | 254700000003 | enters the wrong PIN |
| `00004` | 255700000004 | 254700000004 | cancels |
| `00005` | 255700000005 | 254700000005 | never answers |

**3. A request header.** Add `X-Pesalab-Scenario: cancelled` to one request.

**4. The scenario queue.** Script the next requests in order, from the dashboard,
over HTTP, or in code:

```bash
curl -X POST http://127.0.0.1:4010/_pesalab/api/scenarios \
  -H 'Content-Type: application/json' -d '{"outcomes":["timeout","success"]}'
```

Balances are real inside the sandbox. A successful payment moves money from the
customer's wallet to your business float, a payout moves it back, and a payout
fails when the float is empty. Edit both under **Customers**.

## Breaking the callbacks

Under **Settings → Callback trouble**:

- **Drop callbacks.** The customer pays but your app is never told. This is the
  bug that loses money in production. Your app should fall back to a status query.
- **Send every callback twice.** Checks that your handler does not credit an order
  twice.
- **Delay callbacks.** Checks what your UI does while it waits.

Every delivery attempt is recorded on the payment with the status code and reply
your app gave, and any callback can be sent again with one click.

M-Pesa takes the callback URL in each request. Airtel, Yas and AzamPay use a single
URL registered with the provider, so set those in Settings, on the command line
(`--airtel-callback`, `--yas-callback`, `--azampay-callback`), or per request with
the `X-Pesalab-Callback-Url` header.

## Warnings: would this work in production?

By default pesalab is forgiving. It accepts requests the live API would refuse and
attaches a warning that says why, for example a Daraja password that is not
`base64(ShortCode + Passkey + Timestamp)`, a C2B URL containing the word "mpesa",
or a Vodacom session ID sent without encryption. Warnings show on the payment and
in the **API requests** tab.

Run with `--strict` to turn those warnings into the errors the real API returns.

## In automated tests and CI

Start a sandbox inside your test process. Nothing to click, nothing to install.

```js
import { start } from 'pesalab';

const lab = await start({ port: 0, settings: { mode: 'auto', autoDelayMs: 10 } });

lab.queue('cancelled');                    // the next customer cancels
await checkout({ baseUrl: lab.urls['mpesa-ke'] });   // your code

const [payment] = lab.transactions();
assert.equal(payment.outcome, 'cancelled');
await lab.stop();
```

See [examples/in-your-tests.test.mjs](examples/in-your-tests.test.mjs). For other
languages run `pesalab --mode auto` as a service and drive it through the control
API below.

## Command line

```
pesalab [options]

-p, --port <n>            Port (default 4010)
    --host <host>         Interface (default 127.0.0.1; use 0.0.0.0 in Docker)
    --mode <manual|auto>  manual waits for the dashboard, auto answers by itself
    --outcome <name>      Outcome in auto mode (default success)
    --delay <ms>          How long a scripted customer takes (default 1200)
    --timeout <ms>        How long a prompt waits for you (default 60000)
    --strict              Reject wrong credentials like the real APIs
    --airtel-callback, --yas-callback, --azampay-callback <url>
    --data-dir <dir>      Where the Tanzanian RSA key is kept (default ./.pesalab)
    --allow-origin <url>  Also accept browser requests from this origin ("*" for any)
    --allow-host <name>   Also accept requests addressed to this domain name
```

Both `--allow-*` flags can be repeated or given a comma-separated list, or set
through `PESALAB_ALLOWED_ORIGINS` and `PESALAB_ALLOWED_HOSTS`.

## Control API

Everything the dashboard does is a plain HTTP call under `/_pesalab/api`.

| Call | Does |
|---|---|
| `GET /state` | Settings, credentials, customers, payments, request log |
| `GET /transactions?status=pending&provider=mpesa-tz` | Find payments |
| `POST /transactions/:id/resolve` `{"outcome":"cancelled"}` or `{"pin":"1234"}` | Answer a prompt |
| `POST /transactions/:id/reverse` | Reverse a completed payment (409 if the float or the customer cannot cover it) |
| `POST /transactions/:id/callbacks/:cb/replay` | Send a callback again |
| `POST /scenarios` `{"outcomes":[...]}` · `DELETE /scenarios` | Script upcoming requests |
| `PATCH /settings` | Change mode, timing, strictness, callback trouble, callback URLs |
| `POST /wallets` `{"msisdn","name","balance","pin"}` | Add or edit a customer |
| `PATCH /floats` `{"provider","amount"}` | Set your business float |
| `POST /c2b/pay` `{"shortcode","msisdn","amount","billRef"}` | A Kenyan customer pays your paybill |
| `POST /reset` | Clear everything |

## Limits

- State lives in memory. Restarting pesalab clears payments and customers.
- It is a test tool. It binds to `127.0.0.1` by default and has no authentication
  on the dashboard, so do not expose it to a network you do not trust.
- Browser requests are only accepted from pages on your own machine, and only
  requests addressed to localhost, an IP address or a single-label name such as a
  Docker service are answered. This stops a website you visit from driving
  pesalab through your browser, including through DNS rebinding. Use
  `--allow-origin` and `--allow-host` when you mean to reach it another way.
- Reversals follow the money: a refund fails if your float cannot cover it, and
  reversing a payout fails if the customer no longer has the funds.
- It imitates request and response shapes, not provider infrastructure: there are
  no rate limits, IP allow-lists or settlement delays.
- Kenyan `SecurityCredential` values and Airtel disbursement PINs are accepted
  without being decrypted.
- Passing here does not replace the provider's own go-live testing.

## Contributing

The most valuable contributions are corrections from people with production
access: a real error payload that differs from what pesalab returns, or a provider
that is missing. Each provider is one file in `src/providers/`, and
[docs/providers.md](docs/providers.md) lists what is still unverified.

```bash
npm test
```

## Not affiliated

pesalab is an independent open-source project. It is not affiliated with, endorsed
by or connected to Safaricom, Vodacom, Vodafone, Airtel, Yas, Honora, Halotel or
AzamPay. M-PESA and the other product names are trademarks of their owners and are
used only to say which APIs this tool is compatible with. pesalab never contacts
those services and cannot move real money.

## License

MIT
