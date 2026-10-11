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
ordered resumable event stream, `build(command)` for unsigned user transactions (or `build([commands])`: an ordered
list as one all-or-nothing transaction, S3; the EVM adapter builds one command per transaction until a bundle is needed
there), and `submit(command, role)` for the backend's two low-privilege roles. The three implementations are interchangeable; `@merces/chains` picks one per chain
(`mock | live | auto`).

## The canonical model

`@merces/domain` defines the vocabulary once: 56 events, 53 commands (schema 0.4.0; S4 WP5 added Stage 1's `revokeAttestor`, `rotateAttestor` and `AttestorRevoked`, S4 WP6 `revokeVerifierKey`, `rotateVerifierKey` and `VerifierKeyRevoked`), the state shapes, the commitments (Stage 1's
Poseidon terms and income commitments; since S4 its keccak bid and order commitments), Stage 1's signed messages
(`MERCES_*_V1`, signing.ts; the verifier attestation is its REPORT message since S4 WP6, a tier-3 attestation its REPORT
message with tier 3 and the FX fallback its FX message per series since S4 WP9) and Stage 1's six report public
inputs. The sealed raise uses Stage 1's names for
its multi-step settlement (S2): the permissionless commands `beginSettlement`, `tallyBids`, `finalizeSettlement`,
`processBid`, `deliverBid` and `registerHolder`, which the keepers submit and any wallet may build, and their events.
One planner plans them for every caller (`nextSettlementStep` and the driver `runSettlement`, `settlement.ts`): the
keepers, the simulator harness, conformance and the API's `build-step` all take the next step from the chain's stored
raise state, so there is no second settlement path to drift. The holder claims are Stage 1's family (S3): `claimPayout`
(Stage 1's `claim`), `claimRedemption`, `claimTail`, `claimFinal`, and the permissionless `burnRetired`; every stablecoin
amount a claim moves appears in exactly one event amount. Curve mode (S3) has Stage 1's names too: the permissionless
`completeCurve`, `collectCurveProceeds` and `syncCurveUnits`, and the holder's `stakeUnits`, `unstakeUnits` and
`tenderUnits`; a curve trade (`curveSwap`) is Meteora's, not a Merces instruction.
Zod schemas are the single source: TypeScript types, runtime validation in the indexer and the API, the JSON schema
(`packages/domain/schema`) and `DOMAIN_EVENTS.md` are all generated from them. Live adapters are anti-corruption layers:
whatever Stage 1 emits is mapped onto these shapes by `SolanaEventMapper` / `EvmEventMapper`, with every difference
written to `INTERFACE_DRIFT.md`.

## The simulator

`SimEngine` runs the canonical commands on Stage 1's rules (SPEC v1.1.2, with Stage 1's reference simulator as the
executable spec) in TypeScript with `bigint` only, one `executeAll(commands, actor)` per transaction (one command, or an ordered list run
all or nothing, S3) with snapshot-and-rollback, and exactly the canonical events. Every error on a Stage 1 path carries Stage 1's error name
(`ChainError.detail.stage1`). A Groth16 report proof is verified asynchronously in `SimulatorChain.send` before the
synchronous engine runs; the engine takes the verdict and checks the six public signals itself. Its commands live in one module per area under
`packages/simulator/src/engine/` (registry, auction, settlement, treasury, reports, payments, holders, status,
redemption, terminal, fx, window, curve, stake), each a set of functions over the shared `EngineCore`; the `ChainPort` read
mappers live in `src/reads/`. State is a plain object, version 4 (S3), carrying Stage 1's own series ledger, payout
vault, tail and final pool, Stage 1's auction record and bids, and each series' unit scale and curve stakes; every
money path passes the unit scale to `@merces/math`'s scale-aware family, which is Stage 1's own function at scale 1
(serialisable for the Postgres persistent mode; another version is refused, and `sim:reset` clears it). Two
personalities differ only in address format and stablecoin catalogue. Time is a controllable clock (`advanceTime`,
`setTime`) exposed in mock mode through `/dev/advance-time`. The arithmetic is Stage 1's: `@merces/math` re-exports
`@merces/sdk` and `@merces/reference` (workspace packages built from the pinned `stage1` submodule) by name, plus a
few helpers Stage 1 has no counterpart for; the interim Merces math survives under `interim.*` only for the window cap and
the FX family (both S5; a curve raise has no cap at any stage since S3, `CURVE_NO_CAP`). The sealed raise's math (escrow, validity, tally, clearing, per-bid processing)
is Stage 1's auction family; the engine only checks the call order, stores the results, moves balances and emits
events. The non-reveal charge is the series' own term, applied as Stage 1 applies it (an unrevealed bid on a settled
raise pays it to the fee collector at `processBid`); its rate for new series is the owner's deployment setting
(`MERCES_NON_REVEAL_CHARGE_BPS`, no built-in default).

## Read side

The indexer reads events after a per-chain cursor, validates them, projects `finalized` ones into one Postgres read
model inside one transaction per batch, and advances the cursor in that same transaction. Duplicates are skipped by
`seq`, gaps stop the batch, `confirmed` events are parked in `events_pending`. The public `activity` table never holds an
amount. The API serves lists and histories from the read model and reads per-request precision (claimable, quotes,
period standings) live from the chain. Stage 1's reporting ledger (first and next expected period, last accepted and
paid period, the open due, the income chain head, the period whose formal notice was recorded) is projected into
`series` like everything else (migration 017; from `AuctionSettled`/`CurveGraduated`, `ReportAccepted`,
`PaymentReceived`, `SeriesRetired`, `SeriesExtinguished` and `FormalNoticeDue`), so the series views have one source;
the report prior a device must prove against is read live (`GET /series/{id}/reporting/prior`). The issue price comes
from the event that set it onchain (`AuctionSettled.clearingPrice`; a curve's P0 from `CurveActivated.issuePrice` and
`CurveGraduated.issuePrice`) and the cap per unit is Stage 1's `capPerUnit` on it (floor), at settlement, at a curve's
activation and completion, and again after each `TermsAmended`.

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
| auction | pre-checks on Stage 1's escrow and validity rules, open/cancel/commit/reveal/deliver builders and the next settlement step for any wallet, encrypted reveal backups, the settlement preview (Stage 1's math), settlement and delivery for the keepers (separate jobs, delivery retries and stuck alerts), reveal reminders |
| lifecycle | treasury draws and pause, Stage 1's claim family (payout claims behind `PayoutClaimBuilder`, so private payouts can slot in; the redemption, tail and final claim builders; none builds a claim of nothing; the holder registration), redemption quote/builders/tail, retirement and `burnRetired`, transfer windows (flag-gated); every per-unit read at the series' unit scale |
| meteora | curve-mode config generation; the curve read (the chain's `CurveState`, its census included); the lifecycle pass that completes a filled curve and collects its proceeds and, weekly, its trading fees (Stage 1's permissionless `completeCurve`, `collectCurveProceeds`; `advanceCurves`, run by the keepers' `curve.lifecycle` and the admin monitor); the census builder (`syncCurveUnits`, never while the issuer's assembled report waits: `curve-census.ts`, which also makes the report assembly, the submission builder and the tier-3 path census-aware); the pre-buy quote and its `beforeYouBuy` statements; a swap builder (`build-swap`: `curveSwap` on the chain's quote, any wallet, `earns: false` for one not approved, a buy only once the statements are acknowledged) with a USDG→USDC swap route through the DEX port; staking (`staking.ts`): the wallet's curve position read and the stake (with its registration and census steps), unstake (one transaction with the claim that pays it) and tender builders; no cap at any stage (every response carries `noCap` and the one statement) and the buyer notice (`CURVE_BUYER_NOTICE`, its trading fee and split from the pool's config) |
| threshold | admin-curated median income and inflation table with history; yearly indexing candidates |
| attestor | attestor queue, hardship review (end-to-end encrypted), tier-3 cases and annual true-up, fallback FX signing, two-attestor extinguishment |
| accounting | fee ledger, per-series statements, reconciliation of indexed totals against onchain balances, CSV export |
| notifications | outbox dispatcher → inbox rows + email channel (mock), preferences; statuses only |
| admin | overview, flags, audit log, attestor and verifier-key registration, revocation and rotation (multisig transactions), tier-4 audit sampling scaffolding |

Keepers (`@merces/keepers`) run idempotent jobs on intervals and record every run. The rate keeper takes one Pyth
snapshot per UTC day per pair per chain with a Chainlink cross-check where a feed exists. The curve jobs (S3) complete
and collect filled curves, take the census after completion and after each period end (never over an assembled report),
and remind linked wallets holding unstaked units to stake and, after a redemption, to tender (RUNBOOK.md).

## The report verifier

A separate process with one job: verify a zkTLS proof and the prior quarter's opening, recompute the income
commitments, sign the attestation: Stage 1's `MERCES_REPORT_V1` (the series' chain's signing domain from its own chain
table, the series key, period, prior and income commitments, tier 2, liquidity flag), a digest it builds itself. It has
no database, logs no payloads, and keeps its secp256k1 key behind the KMS port, pinned by address (S4 WP6, A-SIG-5). Devices call it directly; the API never sees a zkTLS
proof or a salt. `@merces/poi-device` is the device-side counterpart: it keeps the income chain (each quarter's
opening, salts derived from a device secret), computes the payment with Stage 1's formula and proves Stage 1's
ProofOfIncome circuit (Groth16) on the device; only commitments, the payment and the proof leave it. The same package
holds the attestor's side (S4 WP8, A-SIG-2): `merces-attestor` keeps the attestor's secp256k1 key in a Web3 Secret
Storage v3 keystore on the attestor's machine, checks each signing request against its own pinned network table,
rebuilds Stage 1's digest from the typed fields and signs only that; only the signature leaves it. Since S4 WP9 the
attestor service hands it the tier-3 REPORT and the per-series FX signing requests.

## Stage 1 catch-up

Stage 1 is the `stage1` git submodule, pinned. `stage1:sync` (`@merces/stage1-sync`) detects the handoff manifest or
a hand-written map, generates typed clients from IDLs and ABIs, diffs interfaces into `INTERFACE_DRIFT.md`, checks that
`@merces/math` runs Stage 1's own functions at the pinned commit and that its ported curve family agrees with Stage 1's
figures and with Stage 1's own Rust (merces-common, built into `tools/stage1-oracle`), replays Stage 1's 25 parity vectors through the Stage
1 vector runner (on Stage 1's own simulator, and the targets and prefix gates on ours on both personalities, `pnpm stage1:vectors`),
runs the conformance suite (`@merces/conformance`, written against `ChainPort` only) on each live chain, and prints a
verdict. It runs in CI on every push and on a schedule. See `STAGE1_INTEGRATION.md`.

## Conventions

TypeScript ESM, pnpm workspace, Postgres (migrations in `packages/db/migrations`), a Postgres-backed job queue and
outbox, Fastify, OpenAPI 3.1 assembled from a base file plus per-module fragments, vitest with per-test schemas. Money is
`numeric(38,0)` in Postgres and a decimal string everywhere else. Access tiers are declared per route and tested
endpoint by endpoint. See `docs/SERVICES.md` for how to add a module.
