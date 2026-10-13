# Local provider integration

Status on 13 October 2026: adapters and the encrypted relay are implemented; vendor activation is **not complete**. The deployed account remains an explicitly labelled synthetic testnet trial until the prerequisites below are verified. Do not change the flag merely to remove a test label.

## Custody and activation

`MERCES_LOCAL_PROVIDERS=true` selects Stripe Identity, DocuSign's developer environment and Reclaim at the hosted API. Set `realProviders: true` in the local operator configuration only after all credentials and the reviewed provider are available. The worker rejects missing configuration; it never silently substitutes synthetic income. The API rejects a synthetic verifier heartbeat when real providers are selected, disables test identity review and test signing, and sends provider jobs through the outbound operator queue. Contract payloads, signing URLs and provider results are encrypted at rest in that queue. Income proofs use the existing device-to-local-verifier encryption and do not enter the provider queue.

Provider credentials are read from local macOS Keychain by `merces-release/scripts/local-provider-runtime.mjs`. None belong in Railway or Vercel. The exact Keychain JSON records are:

| Record | Fields |
| --- | --- |
| `reclaim-application` | `appId`, `appSecret` |
| `reclaim-income-provider` | `providerId`, exact `providerVersion`, `seriesAccounts` mapping each approved series to its authenticated Stripe account ID, `identityReturnUrl` |
| `stripe-identity` | `secretKey`, `accountId`, `testMode: true` |
| `docusign` | developer `accountId`, `integrationKey`, consenting service `userId`, local `privateKeyPem`, HTTPS `returnUrl`, `signers` mapping Merces account IDs to the consenting test signer's `name` and `email` |

DocuSign uses embedded signing; this integration does not send signature-request emails. Its developer documents carry a test-only notice. Vendor status is retrieved with authenticated API calls; unsigned public callbacks are refused. The owner polls the existing authenticated contract endpoint. Completed signed PDFs, including the completion certificate, are encrypted in the contract vault as a versioned base64 document bundle. Templates are still explanatory drafts pending counsel; this is not a production legal agreement rollout.

Stripe Identity requests only a hosted document/selfie session and status. It does not download identity images or verified identity fields. A provider session is not a stable unique-person identifier: attestor identity onboarding deliberately refuses this adapter until a reviewed person-deduplication method exists.

## Reclaim provider contract

The community “last Stripe transaction” provider is explicitly rejected. A custom, reviewed YTD provider must attest **all** of the following as SDK-verified extracted data: `accountId`, `yearStart`, `coversUntil`, `complete: "true"`, `currency: "USD"` and integer `grossIncomeCents`. These cannot be client-calculated values placed in `publicData` or arbitrary request parameters. It must bind the authenticated Stripe account, exhaust pagination, cover exactly the approved calendar interval, and refuse mixed currencies or incomplete responses. Its aggregation semantics must be reviewed before activation. A raw Stripe API sum alone is not a zkTLS proof.

The adapter pins provider ID/version, requires SDK signature/content verification and TEE attestation, matches a locally persisted session nonce and series/quarter/account context, checks freshness, and atomically spends the session. Only session metadata and a spent marker persist locally; proofs, income and salts remain in memory. USD cents are converted to six-decimal income units. A failed commitment after spending a valid session requires a new provider session.

The app starts the session, opens the provider link and accepts the exported proof JSON. It computes a private commitment on device, sends `{sessionId, proofs}` through the encrypted verifier relay and verifies the returned report signature. Client parsing does not make the income trusted; the independent local verifier does that. Only Stripe is advertised in real-provider mode; Deel/DistroKid are not implemented.

`readStripeGrossCharges` is a read-only diagnostic with account pinning, full bounded pagination, duplicate detection, integer arithmetic and currency checks. Its result explicitly says `zkTlsVerified: false` and cannot authorize a report.

## Current external prerequisites

- The signed-in Reclaim account has two applications but no custom providers. The app secret is absent from Keychain.
- The unclaimed Stripe sandbox returns HTTP 403 for account, balance transactions and Identity. It must be claimed and Identity enabled; do not substitute a fabricated identity check.
- No DocuSign developer account credentials, JWT consent or consenting test-signer mapping are installed.
- A real provider acceptance run and human completion of Identity/signing are still required. Unit tests use controlled provider responses; they do not prove vendor activation.

References: [Reclaim SDK](https://docs.reclaimprotocol.org/manual/js-sdk/usage), [proof fields](https://docs.reclaimprotocol.org/troubleshooting/anatomy), [Stripe Identity](https://docs.stripe.com/identity/verification-sessions), [Stripe balance pagination](https://docs.stripe.com/api/balance_transactions/list), [DocuSign embedded signing](https://developers.docusign.com/docs/esign-rest-api/how-to/request-signature-in-app-embedded/).
