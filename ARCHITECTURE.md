# ARCHITECTURE.md

## One picture

```
            issuer device ──zkTLS proof + salt──▶ report-verifier (isolated, no DB) ──attestation──▶ device
                 │                                                                                    │
  wallets ◀──unsigned tx──┐                                                                           ▼
  (sign)   ──signed tx──▶ API gateway ─── services (E2…E14) ─── Postgres read model ◀── indexer ◀── ChainPort ─┬─ SimulatorChain (solana | monad personality)
                           │                 │                                                           ├─ SolanaChain  (devnet, Stage 1 programs)
                           │                 └── outbox ──▶ keepers (cranks, reminders, rate keeper) ──▶ ChainPort  └─ EvmChain     (Monad testnet, Stage 1 contracts)
                           └── openapi.yaml ──▶ @merces/client ──▶ Stage 3 apps
```

Every service talks to a chain only through `ChainPort` (`packages/domain/src/port.ts`): reads of current state, an
ordered resumable event stream, `build(command)` for unsigned user transactions, and `submit(command, role)` for the
backend's two low-privilege roles. The three implementations are interchangeable; `@merces/chains` picks one per chain
(`mock | live | auto`).

## The canonical model

`@merces/domain` defines the vocabulary once: 43 events, 36 commands, the state shapes, canonical hashing for the terms
commitment, income commitment, bid and order commitments, the verifier attestation message and the zk public-input layout.
Zod schemas are the single source: TypeScript types, runtime validation in the indexer and the API, the JSON schema
(`packages/domain/schema`) and `DOMAIN_EVENTS.md` are all generated from them. Live adapters are anti-corruption layers:
whatever Stage 1 emits is mapped onto these shapes by `SolanaEventMapper` / `EvmEventMapper`, with every difference
written to `INTERFACE_DRIFT.md`.

## The simulator

`SimEngine` implements Part C in TypeScript with `bigint` only, one `execute(command, actor)` per transaction with
snapshot-and-rollback, and exactly the canonical events. Its commands live in one module per area under
`packages/simulator/src/engine/` (registry, auction, treasury, reports, payments, holders, status, redemption, terminal,
fx, window, curve), each a set of functions over the shared `EngineCore`; the `ChainPort` read mappers live in
`src/reads/`. State is a plain object (serialisable for the Postgres persistent mode). Two personalities differ only in address format and stablecoin catalogue. Time is a controllable clock
(`advanceTime`, `setTime`) exposed in mock mode through `/dev/advance-time`. The pure arithmetic lives in `@merces/math`
behind a `MercesMath` interface so `stage1:sync` can swap in Stage 1's reference library after vector parity.

## Read side

The indexer reads events after a per-chain cursor, validates them, projects `finalized` ones into one Postgres read
model inside one transaction per batch, and advances the cursor in that same transaction. Duplicates are skipped by
`seq`, gaps stop the batch, `confirmed` events are parked in `events_pending`. The public `activity` table never holds an
amount. The API serves lists and histories from the read model and reads per-request precision (claimable, quotes,
period standings) live from the chain. Stage 1's reporting ledger (first and next expected period, last accepted and
paid period, the open due, the income chain head, the period whose formal notice was recorded) is projected into
`series` like everything else (migration 017; from `AuctionSettled`/`CurveGraduated`, `ReportAccepted`,
`PaymentReceived`, `SeriesExtinguished` and `FormalNoticeDue`), so the series views have one source; the report
prior a device must prove against is read live (`GET /series/{id}/reporting/prior`).

## Write side

Nothing in the backend signs for a user. Services return `UnsignedTx` objects (`chain.build`); wallets sign; `POST
/tx/send` relays the signed transaction to its chain (and refuses a signer the caller does not own). Keepers use
`chain.submit` with the keeper or allowlist-manager role. Admin actions are built for the multisig and tracked.

## Services (Part E)

| Module | Owns |
| --- | --- |
| identity | wallet sign-in (both families), accounts, applications and review, identity-check port, eligibility and allowlist sync, readiness report |
| contracts | HEU contract and Autonomy Charter from templates, e-signature port, encrypted signed bundle, hash anchored in `createSeries` |
| terms | validation (bounds, defaults, threshold floor), encrypted private terms, logged disclosure, commitment recomputation, inflation amendments |
| poi | reporting schedule and deadlines, zkTLS sessions, FX basis, offchain proof and attestation verification, report store (commitments and amounts only), submit/payIn builders, tier-1 reconciliation |
| auction | pre-checks, commit/reveal/refund builders, encrypted reveal backups, clearing preview, settlement and reminders for the keeper |
| lifecycle | treasury draws and pause, payout claims behind `PayoutClaimBuilder` (private payouts can slot in), redemption quote/builders/tail, retirement, transfer windows (flag-gated) |
| meteora | curve-mode config generation, graduation monitoring, buy builder with a USDG→USDC swap route through the DEX port |
| threshold | admin-curated median income and inflation table with history; yearly indexing candidates |
| attestor | attestor queue, hardship review (end-to-end encrypted), tier-3 cases and annual true-up, fallback FX signing, two-attestor extinguishment |
| accounting | fee ledger, per-series statements, reconciliation of indexed totals against onchain balances, CSV export |
| notifications | outbox dispatcher → inbox rows + email channel (mock), preferences; statuses only |
| admin | overview, flags, audit log, attestor/verifier-key registration (multisig transactions), tier-4 audit sampling scaffolding |

Keepers (`@merces/keepers`) run idempotent jobs on intervals and record every run. The rate keeper takes one Pyth
snapshot per UTC day per pair per chain with a Chainlink cross-check where a feed exists.

## The report verifier

A separate process with one job: verify a zkTLS proof, recompute the income commitment, sign the commitment tuple. It
has no database, logs no payloads, and keeps its key behind the KMS port. Devices call it directly; the API never sees
a proof or a salt. `@merces/poi-device` is the device-side counterpart (payment, commitment, proof, assembly).

## Stage 1 catch-up

`stage1:sync` (`@merces/stage1-sync`) detects the handoff manifest or a hand-written map, generates typed clients from
IDLs and ABIs, diffs interfaces into `INTERFACE_DRIFT.md`, proves math parity before swapping, replays parity vectors
through the simulator, runs the conformance suite (`@merces/conformance`, written against `ChainPort` only) on each
live chain, and prints a verdict. It runs on a schedule in CI. See `STAGE1_INTEGRATION.md`.

## Conventions

TypeScript ESM, pnpm workspace, Postgres (migrations in `packages/db/migrations`), a Postgres-backed job queue and
outbox, Fastify, OpenAPI 3.1 assembled from a base file plus per-module fragments, vitest with per-test schemas. Money is
`numeric(38,0)` in Postgres and a decimal string everywhere else. Access tiers are declared per route and tested
endpoint by endpoint. See `docs/SERVICES.md` for how to add a module.
