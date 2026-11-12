# Providers: what is imitated and how closely

This file exists so you know how far to trust each response. Three labels are used:

- **Documented**: matches the provider's public documentation or widely published
  real payloads.
- **Community**: the provider does not publish this openly. The shape follows
  open-source client libraries written by developers with access.
- **Approximate**: the behaviour is right but the exact code or wording is a best
  guess. Do not hard-code against it.

If you have production access and see a difference, please open an issue with the
real payload. That is the most useful contribution this project can get.

All paths below are relative to the provider's base URL in pesalab, for example
`http://127.0.0.1:4010/mpesa-tz`.

## M-Pesa Tanzania: Vodacom M-Pesa OpenAPI (`/mpesa-tz`)

Replaces `https://openapi.m-pesa.com`. Paths under both `/sandbox/ipg/v2/vodacomTZN`
and `/openapi/ipg/v2/vodacomTZN` are served.

| Endpoint | Status |
|---|---|
| `GET /getSession/` | Documented |
| `POST /c2bPayment/singleStage/` | Documented |
| `POST /b2cPayment/` | Documented |
| `POST /b2bPayment/` | Documented |
| `PUT /reversal/` | Documented |
| `GET /queryTransactionStatus/` | Documented |
| Direct debit create / pay | Not implemented |

Things to know:

- **Encryption.** The API key, and later the session ID, must be encrypted with an
  RSA public key (PKCS#1 v1.5) and sent base64-encoded as the bearer token. pesalab
  generates its own key pair on first run and stores the private key in
  `.pesalab/`. Use the public key shown in the dashboard in place of Vodacom's.
  In lenient mode a token that cannot be decrypted is accepted with a warning.
- **C2B is synchronous.** The HTTP request stays open until the customer answers,
  and the response carries the final result. If your HTTP client gives up first,
  the payment can still succeed. pesalab reproduces this: abort the request, answer
  the prompt, and `queryTransactionStatus` reports `Completed`. Some production
  deployments also deliver results asynchronously; that variant is not imitated.
- **Session lifetime** is one hour here. The real sandbox also takes some seconds
  to activate a new session; that delay is not imitated.

| Outcome | HTTP | Code | Status |
|---|---|---|---|
| success | 201 | `INS-0` | Documented |
| cancelled | 401 | `INS-5` | Documented code, approximate mapping |
| timeout | 408 | `INS-9` | Documented |
| insufficient funds | 422 | `INS-2006` | Documented |
| wrong PIN | 401 | `INS-2001` | Approximate |
| failed | 401 | `INS-6` | Documented code, approximate mapping |

Validation errors: `INS-20` missing parameter, `INS-15` bad amount, `INS-998` wrong
market, `INS-2051` bad MSISDN, `INS-17` reference too long, `INS-10` duplicate
`input_ThirdPartyConversationID`, `INS-13` wrong service provider code (strict
mode), `INS-18` unknown transaction. Session failures return `INS-989` from
`getSession` and `INS-2` elsewhere; the second is **approximate**.

## M-Pesa Kenya: Safaricom Daraja (`/mpesa-ke`)

Replaces `https://sandbox.safaricom.co.ke`.

| Endpoint | Status |
|---|---|
| `GET /oauth/v1/generate` | Documented |
| `POST /mpesa/stkpush/v1/processrequest` | Documented |
| `POST /mpesa/stkpushquery/v1/query` | Documented |
| `POST /mpesa/c2b/v1/registerurl`, `/v2/registerurl` | Documented |
| `POST /mpesa/c2b/v1/simulate`, `/v2/simulate` | Documented |
| `POST /mpesa/b2c/v1/paymentrequest`, `/v3/paymentrequest` | Documented |
| `POST /mpesa/transactionstatus/v1/query` | Documented shape, approximate "not found" code |
| `POST /mpesa/reversal/v1/request` | Documented shape, approximate failure codes |
| `POST /mpesa/accountbalance/v1/query` | Documented |
| Dynamic QR, B2B, tax remittance, Ratiba | Not implemented |

Things to know:

- The default shortcode `174379` and passkey are the ones from Safaricom's public
  sandbox, so an existing test configuration works by changing only the base URL.
- STK callback quirks are kept on purpose: the `Balance` item arrives without a
  `Value`, `PhoneNumber` and `TransactionDate` are numbers, and the query response
  spells "successsfully" with three s's.
- A second STK push to a phone that already has a prompt open is refused with
  "Unable to lock subscriber", as in production.
- C2B confirmation and validation payloads hide the customer number: v1 URLs get a
  SHA-256 hash, v2 URLs get a masked number.
- `SecurityCredential` is accepted without being decrypted.

| Outcome | STK `ResultCode` | Status |
|---|---|---|
| success | `0` | Documented |
| cancelled | `1032` | Documented |
| timeout | `1037` | Documented |
| wrong PIN | `2001` | Documented |
| insufficient funds | `1` | Documented |
| failed | `1025` | Documented |

## Airtel Money: Airtel Africa Open API (`/airtel`)

Replaces `https://openapiuat.airtel.africa`. Send `X-Country: TZ` with
`X-Currency: TZS`, or `X-Country: KE` with `X-Currency: KES`.

| Endpoint | Status |
|---|---|
| `POST /auth/oauth2/token` | Documented |
| `POST /merchant/v1/payments/`, `/merchant/v2/payments/` | Documented |
| `GET /standard/v1/payments/{id}` | Documented |
| `POST /standard/v1/payments/refund` | Documented |
| `POST /standard/v1/disbursements/` | Documented shape, approximate failure codes |
| `GET /standard/v1/disbursements/{id}` | Approximate |
| `GET /standard/v1/users/{msisdn}` | Approximate |

Things to know:

- Tokens last 180 seconds, as on the live API, so token refresh gets exercised.
- Airtel posts results to one callback URL registered in its portal. Set it in the
  dashboard settings, or poll the status endpoint.
- The v2 API's message signing (`x-signature`, `x-key`) and encrypted disbursement
  PIN are not verified.
- Status values `TS`, `TF`, `TIP` and the success/in-progress response codes
  (`DP00800001001`, `DP00800001006`) are documented. The specific failure codes
  per outcome (`...1002` wrong PIN, `...1007` balance, `...1008` refused, `...1024`
  timed out) are **approximate**; branch on `TF`, not on the code.

## Mixx by Yas, formerly Tigo Pesa (`/yas`)

Yas shares its Push BillPay document privately with onboarded billers. This
emulator is **community** level throughout.

| Endpoint | Status |
|---|---|
| `POST /token` (form-encoded, `grant_type=password`) | Community |
| `POST /API/BillerPayment/BillerPay` | Community (the real path is given to you at onboarding) |
| Callback `{Status, Description, MFSTransactionID, ReferenceID, Amount}` | Community |

pesalab also checks that your callback endpoint replies in the shape Yas expects
(`ResponseCode: "BILLER-18-0000-S"`, `ResponseStatus: true`) and warns if it does
not. Failure descriptions are approximate.

## AzamPay (`/azampay`)

Replaces `https://authenticator-sandbox.azampay.co.tz` (token) and
`https://sandbox.azampay.co.tz` (checkout). Both live under one base URL here.

| Endpoint | Status |
|---|---|
| `POST /AppRegistration/GenerateToken` | Documented |
| `POST /azampay/mno/checkout` | Documented |
| Callback `{msisdn, amount, message, utilityref, operator, reference, transactionstatus, ...}` | Documented |
| `GET /api/v1/Partner/GetPaymentPartners` | Approximate |
| `POST /azampay/disburse` | Approximate |
| `GET /azampay/transactionstatus` | Approximate |
| Bank checkout, payment links | Not implemented |

`provider` must be one of `Airtel`, `Tigo`, `Halopesa`, `Azampesa`, `Mpesa`.

## Adding a provider

A provider is one file in `src/providers/` exporting `{ id, name, api, country,
realBaseUrl, routes(router, sandbox) }`. The shared engine gives you:

- `sandbox.newTxn({...})` to record a payment
- `sandbox.prompt(txn, ctx, onResolve)` to put a prompt on the customer's phone;
  `onResolve` runs once with `txn.outcome` set
- `sandbox.settleDisbursement(txn, ctx)` for payouts
- `deliver(sandbox, txn, { label, url, payload })` to send a webhook with full
  logging, replay and callback-trouble support

Map the six outcomes to the provider's codes, add tests, and add a section here
saying what is documented and what is approximate.
