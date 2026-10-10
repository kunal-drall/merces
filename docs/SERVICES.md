# Writing a service module

Every backend service (E2–E14) is a module under `packages/services/src/<module>/` with two files and a test:

```
packages/services/src/<module>/service.ts    # the logic: a class taking ServiceContext
packages/services/src/<module>/routes.ts     # export function register<Module>Routes(app, base: AppContext)
packages/db/migrations/0NN_<module>.sql      # its tables (one file, idempotent `create table if not exists`)
packages/api/src/openapi/fragments/<module>.yaml   # its operations (paths + optional components/tags)
packages/api/test/<module>.test.ts           # integration test through the HTTP API on the simulator
```

## Context
`svc(base)` upcasts the gateway's `AppContext` to `ServiceContext` (`packages/services/src/context.ts`):
`pool` (pg Pool), `chains` (registry: `chains.get(chainKey)`, `chains.chains.values()`), `chainFor(seriesId)`,
`log` (pino, redacts income-bearing keys), `sessionSecret`, `devMode`, `kms`, `vault` (AES-GCM `encrypt(plain, aad)` /
`decrypt`), `identity`, `esign`, `zktls`, `proofVerifier`, `verifier`, `reportVerifierUrl`, `signInDomain`,
`wallClock()`, `newId(prefix)`.

Chain access goes only through `ChainPort` (`packages/domain/src/port.ts`): reads (`getSeries`, `listSeries`,
`getPeriod`, `listPeriods`, `getVault`, `getTreasury`, `listPositions`, `getBalance(wallet, 'USDC')`,
`getQuarterRate`, `listAttestors`, `listVerifierKeys`, `now()` …), `build(command, signer, coSigners?)` →
`UnsignedTx` for a user/multisig to sign, `submit(serviceCommand, 'keeper' | 'allowlistManager')` for the backend's
own roles. Never sign for users; never hold funds. Admin commands (`registerAttestor`, `registerVerifierKey`,
`pauseNewRaises`, `setFeeCollector`, `registerSplitRouter`) are *built* for the admin multisig (`info().admin`).

## Routes
```ts
defineRoute(app, ctx, { method: 'GET', url: '/admin/things/:id', access: 'admin', handler: async (req, reply, session) => ({...}) });
```
Access tiers (`packages/api/src/auth/access.ts`): `public | account | backer | holder | issuer | attestor | admin |
holder-or-issuer | issuer-or-attestor`. `issuer`/`holder` resolve against the `:seriesId` path param. Validate
bodies with zod (`z.object(...).parse(req.body)`); a ZodError becomes a 400. Throw `AppError` (`@merces/core`) for
expected failures (`badRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `unprocessable`). Writes take
an `Idempotency-Key` header via `withIdempotency(ctx.pool, scope, key, body, fn)`. Admin and attestor actions call
`audit(ctx.pool, { actor, actorRole, action, target, detail })`. Anything that leaves the system (emails, webhooks)
goes through `enqueueOutbox(ctx.pool, 'notification', payload)`; the keeper's outbox job dispatches it.

## Data conventions
Money columns are `numeric(38,0)` holding base units; the API returns them as decimal strings (pg returns numerics as
strings already — never `Number()` them). Timestamps from the chain are unix seconds; DB timestamps are timestamptz.
Ids: `ctx.newId('prefix')`. Every table gets `create table if not exists`. Statuses are enums with a `check`.

## Privacy rules (ground rule: no raw income at rest)
Never store, log or return: income figures, income documents, hardship reasons, identity documents. Store
ciphertext (`ctx.vault.encrypt`) or, for attestor documents, client-side (end-to-end) ciphertext the server cannot
decrypt. A tier-3 opening is accepted only as a merces-e2e v1 envelope (`assertTier3OpeningEnvelope`; PRIVACY.md);
other attestor ciphertext goes through `assertOpaqueCiphertext`. Error messages name the field and the rule, never the
value (a share rate or θ is as private as income). Reason fields are codes. Notifications to holders carry statuses,
never reasons. The canary test scans the database and logs for the value `7317317317` and its siblings, written out or
encoded in hex or base64; a service that persists one fails CI.

## Tests
Use the rig in `packages/api/test/helpers.ts`:
```ts
const rig = await makeRig({ extraRoutes: [registerMyRoutes] });   // two simulator harnesses rig.sol / rig.mon, indexer, app
const tok = rig.token({ accountId: 'a', roles: ['admin'], wallets: [{ chain: 'solana', address: rig.sol.issuer.address }] });
await rig.get('/path', tok); await rig.post('/path', body, tok, { 'idempotency-key': 'k' }); await rig.put(...)
await rig.sol.runRaise(); await rig.sol.reportAndPay(...); await rig.sync();  // index events into the read model
```
`rig.sol.issuer`, `rig.sol.backers[i]`, `rig.sol.attestors[i]`, `rig.sol.admin` are `SimWallet`s (`.address`,
`.sign(tx)`, `.coSign(signed)`); send a signed tx with `rig.post('/tx/send', signed, tok)`. Run with
`DATABASE_URL=postgres://postgres@localhost:5432/merces pnpm vitest run packages/api/test/<module>.test.ts`.
Register the module in `packages/services/src/index.ts` (`serviceRoutes`) only when integrating; tests pass the
registrar through `extraRoutes` so modules can be developed independently.

## Contract
Add operations in a fragment (`paths:` keyed exactly like the route with `{param}`; every operation needs
`operationId`, `x-access` equal to the route's tier, `tags`, `responses`; dev-only routes carry `x-dev-only: true`).
`pnpm openapi:check` assembles base + fragments and fails when routes and spec diverge.
