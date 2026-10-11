# Merces backend: handoff

Written 2026-10-11 for whoever completes the backend, its Stage 1 integration, its devnet/testnet deployment and the
frontend integration. Read §0, then the section for your job. Every claim cites a file; line numbers move, so re-read.

| Section | For |
| --- | --- |
| §0 Start here | everyone |
| §1 What exists | everyone |
| §2 Rules that bind the work | everyone (non-negotiable) |
| §3 Working environment and gates | backend |
| §4 Remaining backend work, in order | backend |
| §5 Live adapters and `stage1:sync` | backend (chain integration) |
| §6 Deployment to Solana devnet and Monad testnet | deployment |
| §7 Frontend integration | frontend |
| §8 Open decisions (defaults in force) | everyone |
| §9 Deferred items and known risks | everyone |
| §10 Supporting files | everyone |

---

## 0. Start here

- **Repository:** `kunal-drall/merces`; backend branch `claude/jolly-tesla-8j0s7n`, Stage 1 branch
  `claude/sweet-goodall-b7acm3`. Both histories are integrated on `main` (implementation merge `4625660`) and pushed
  to GitHub. The backend branch shares the main integration; the Stage 1 branch is at `bafe1fb`, retained under the
  `stage1/` submodule (SPEC v1.1.2). The local checkout is on `main`.
- **Current work:** S4 recovery/security fixes, S5 items 1–12, registry completion and both live adapters are implemented and pushed.
  Stage 1 commit `bafe1fb` fixes reference final-share weighting for redeemed units in uncleared ask escrow, with a
  regression fixture. Chain programs and all 25 official vectors are unchanged. Every new commit is kunal-drall only.
- **Latest integration verification:** 939 tests pass with database integration; all 25 original vectors pass in full
  on both personalities, including 50/50 lockstep, with no prefix gates, shims or waivers. Reference 25/25, new
  final-share regression 88/88 on both personalities, Rust oracle 5,883/5,883, 213 matching API operations, `DEMO OK`
  and four `dev:mock` routes at HTTP 200. Simulator state is version 10; older snapshots require `sim:reset`.
  `stage1:sync --no-conformance` exits 0 but retains raw interface-diff warnings and says deployments are NOT ready.
  Exact results and limitations: `docs/handoff/verification-2026-10-11.md`. Numbers below in historical sections
  describe the original handoff.
- **What the product is:** income-share series ("units") an issuer sells in a sealed-bid raise (or, on Solana, on a
  Meteora bonding curve); the issuer proves quarterly income with a zero-knowledge report and pays holders a share above
  a threshold, up to a cap; redemption, tail, extinguishment, hardship pauses and transfer windows ("buy-back") follow
  Stage 1's SPEC. This backend never holds user funds or keys: it builds unsigned transactions, indexes the chains,
  runs permissionless keepers and serves the API the frontend uses.
- **The one-line state:** all 25 Stage 1 vectors run in full on both simulator personalities, without shims or
  waivers. Both live adapters have generated ABI/IDL builders, finalized reads, canonical event indexing and service
  signing. Public-chain deployment, provider onboarding and frontend-device proving remain separate launch work;
  see `DEPLOY_DAY.md`. No public-chain runs or hosting have been attempted.

## 1. What exists

### 1.1 Milestones done

| Milestone | What it delivered | Record |
| --- | --- | --- |
| M0-M7 | monorepo, domain model, `ChainPort`, the simulator (two personalities: `solana`, `monad`), adapter skeletons, indexer, API gateway, `openapi.yaml`, identity/sign-in/onboarding, contracts and e-sign, terms vault, ProofOfIncome (tiers 1-4, zkTLS port), auctions, keepers, thresholds, attestor service, fees/accounting, notifications, admin API, Meteora curve support, privacy canary, conformance suite, demo cycle | `docs/milestones/`, `ARCHITECTURE.md` |
| D6 | Stage 1 integration tooling: `stage1:sync` (detect, generate, diff, math, curve-port, signatures, vectors, conformance), `INTERFACE_DRIFT.md`, the vector runner | `STAGE1_INTEGRATION.md` |
| S1 | Stage 1's math imported (`@merces/math` re-exports `@merces/reference`), Stage 1's Groth16 report proof format, the vector runner (merces / reference / lockstep backends) | STAGE1_INTEGRATION.md "S1 results" |
| S2 | auctions on Stage 1's multi-step settlement (begin, tally, finalize, process, deliver, register holder) | "S2 results" |
| S3 | Stage 1's claim family (claim, tail, final, burn retired), curve mode with staking first-class (stake, unstake + claim in one transaction, tender, census), the scale-aware curve math port with a Rust-oracle gate, the non-reveal charge per series | "S3 results", "S3 review fixes" |
| S4 | Stage 1's signatures: secp256k1 attestor and verifier keys, the six `MERCES_*_V1` messages, domain/series key/nonces, revocation grace and rotation, the attestor device tool (`merces-attestor`), keccak bid commitments, signed pause/amend/extinguish/tier-3/FX/true-up flows, no co-signers | "S4 results" |
| S4 owner decisions (local) | attestor identity check enforced at registration (A-SIG-7); the Stage 1 defect report for the final-share weight with vector 26 | `5029b6f`, `c82b41a`, `docs/stage1/defects/` |

### 1.2 Historical baseline at the original handoff head

| Gate | Result |
| --- | --- |
| Test suite | 736 tests (729 at `8837dba`, + the attestor identity and vector-file tests) |
| Conformance (simulator, simulator:monad) | 20 + 11 pass |
| Privacy canary | 3 pass |
| Stage 1 vectors on our simulator | `OK: 38/42 PASS, 42/42 at expected status (12 prefix runs)` |
| Stage 1's own reference simulator | 25/25 |
| Lockstep (ours vs Stage 1 step by step, solana) | `OK: 19/21 PASS, 21/21 at expected status (6 prefix runs)` |
| Our scenarios (paths no vector takes) | `OK: 30/32 PASS, 32/32 at expected status (2 runs with accepted divergences)` |
| `stage1:sync --no-conformance` | math, curve-port (55/55 figures, 5,883/5,883 Rust oracle cases), signatures (20 messages … DER 20/20), vectors: OK; diff: WARN (until the adapters are wired) |
| OpenAPI | 190 operations (188 at `8837dba`) |
| `demo:cycle` | `DEMO OK` on both personalities |

Current parity coverage (`packages/stage1-sync/src/stage1-vectors/expected.ts`):
- **Required full passes (20):** 01–09, 11, 13, 14, 15, 17, 19, 20, 21, 23, 24, 25; no waivers.
- **Prefix gates (3):** 10 to #35, 16 to #40, 22 to #75, all waiting on multi-step windows.
- **Not replayed (2):** 12 and 18 (router).
- **Shims left (8):** SH-WIN-1…7, SH-FLG-1. New targets are promoted only after full replay evidence.

### 1.3 Repository map

| Path | What |
| --- | --- |
| `packages/domain` | canonical commands, events, state, port (`ChainPort`), signing (`signing.ts`), terms rules, notices |
| `packages/math` | gateway to Stage 1's math (`@merces/reference`, `@merces/sdk`) + the segregated curve port (`interim/` for S5 leftovers) |
| `packages/simulator` | the in-process chain (engine per area under `src/engine/`, reads, state version 7, harness, `SimWallet`, `SimSigner`) |
| `packages/chain-solana`, `packages/chain-evm` | live adapters: pinned ABI/IDL builders, finalized reads/events, wallet transport, service signing and Solana Meteora DBC |
| `packages/chains` | chain registry, mode selection (`mock|live|auto`), Stage 1 manifest locator |
| `packages/indexer` | projections of canonical events into Postgres |
| `packages/keepers` | permissionless jobs (settlement, delivery, curve lifecycle/census, pauses, FX rate, burn, reminders) |
| `packages/services` | business services and routes (identity, contracts, terms, poi, auction, lifecycle, meteora, threshold, attestor, accounting, notifications, admin) |
| `packages/api` | Fastify app, access tiers, public/me/dev routes, `openapi.yaml` (built from `src/openapi/` fragments) |
| `packages/client` | generated TypeScript client (`openapi.d.ts`) for the frontend |
| `packages/server` | process entry points: `dev-mock.ts`, `main.ts`, `openapi-check.ts` |
| `packages/db` | migrations 001-034, CLI |
| `packages/ports` | KMS (local secp256k1/ed25519; DER normaliser and provider-neutral remote adapter), zkTLS (mock), identity (mock), e-sign (mock), proof system (Groth16), wallet signature verification |
| `packages/report-verifier` | the tier-2 report verifier service (signs Stage 1's REPORT with a KMS key) |
| `packages/poi-device` | the issuer's report assembler and the attestor tool `merces-attestor` (keystore, request check, signing) |
| `packages/stage1-sync` | `stage1:sync` steps, the vector runner (`src/stage1-vectors/`), `tools/stage1-oracle` Rust oracle (repo root) |
| `packages/conformance`, `packages/privacy-tests`, `packages/scenarios` | conformance suite (simulator or live), privacy canary, seed and demo cycle |
| Root docs | `ARCHITECTURE.md`, `API.md`, `ASSUMPTIONS.md` (every decision, A-*), `STAGE1_INTEGRATION.md` (results, register, owner decisions, Stage 1 asks, adapter notes), `RUNBOOK.md`, `SECURITY.md`, `PRIVACY.md`, `VERSIONS.md` (pinned third-party facts), `DOMAIN_EVENTS.md`, `INTERFACE_DRIFT.md`, `API_CHANGELOG.md` |

## 2. Rules that bind the work

From the owner; they hold for every change, in fast mode too.

1. **Never mainnet.** Mainnet RPCs, chain ids and signing domains are refused in code (Solana genesis hash check,
   `EVM_TESTNET_CHAIN_IDS` allow-list with a mainnet tripwire in `packages/domain/src/signing.ts`; every signer refuses a
   mainnet domain). A new testnet is added in code, never by configuration.
2. **No custody.** The backend builds unsigned transactions; users sign. Attestor keys never reach the backend (they live
   in `merces-attestor` on the attestor's machine). No route signs a digest a caller supplies. Keepers send only
   permissionless commands and relay only signatures they have checked.
3. **No raw income at rest.** Income figures, income documents and hardship reasons never enter the DB, logs, queues or
   error reports (commitments and ciphertext only; the privacy canary checks it).
4. **Chain-neutral API.** `seriesId = "<chain>:<address>"`; no endpoint needs the client to know the chain.
5. **Stage 1 wins on money and charter behaviour.** Import Stage 1's code; where its reference simulator and its two
   chains disagree, follow both chains, record it in the divergence register (`STAGE1_INTEGRATION.md`,
   `packages/stage1-sync/src/stage1-vectors/divergences.ts`) and report it to Stage 1. Do not invent facts: third-party
   facts come from official sources pinned in `VERSIONS.md`; providers sit behind ports with mocks.
6. **Secrets never in the repository.** Dev and test keys are published "not for production" values and are refused
   when any chain is live.
7. **Every gate stays and must be green before each push** (§3.3). Never skip, waive or re-pin a test to current output
   without a Stage 1 citation.
8. **The frontend builds against the API:** keep `pnpm dev:mock` working at every push, keep `openapi.yaml` current
   (`pnpm openapi:client && pnpm openapi:check`), and add every changed or removed operation and field to
   `API_CHANGELOG.md` per push.
9. **Fast mode (owner, 2026-10-11):** no per-package verifiers or multi-reviewer reviews until one cross-cutting review at
   the very end; run independent work in parallel; do not wait for the owner: take the stated default, record it in
   `OPEN_DECISIONS.md` and continue; defer refactors, extra scenarios and doc polish to
   `POLISH_LATER.md`. Full text: `docs/handoff/owner-directions-2026-10-11.md`.
10. **Deployment last (owner, 2026-10-11):** Stage 1 and this backend are deployed to Solana devnet and Monad testnet only
    after the code of all four stages is complete. The deployment steps are in §6 for when that day comes.

## 3. Working environment and gates

### 3.1 Prerequisites

Node 22, pnpm 10.28.0, Postgres 16, git (with submodules), and Rust via rustup with Stage 1's toolchain
(`rustup toolchain install 1.97.1 --profile minimal`, the channel in `stage1/solana/rust-toolchain.toml`): the
`curve-port` step of `stage1:sync` builds Stage 1's `merces-common` crate offline and fails without cargo.

### 3.2 Setup

```bash
git clone https://github.com/kunal-drall/merces && cd merces
git checkout claude/jolly-tesla-8j0s7n
git submodule update --init --recursive          # stage1/ at the committed gitlink
pnpm install                                     # postinstall builds Stage 1 packages and generates pinned ABI/IDL clients
docker compose up -d postgres                    # or a local Postgres 16; createdb merces
export DATABASE_URL=postgres://postgres@localhost:5432/merces
pnpm dev:mock                                    # API on :3000, both simulator personalities, seeded personas, keepers in-process
```

Migrations run at process start. In the Claude cloud container used so far, Postgres lived in `/home/user/pgdata` and
was restarted with `rm -f /home/user/pgdata/postmaster.pid && su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D
/home/user/pgdata -l /home/user/pgdata/server.log -o '-p 5432 -k /tmp' start"`. Kill processes by PID only.

### 3.3 The gates (all must pass before a push)

```bash
pnpm typecheck
DATABASE_URL=postgres://postgres@localhost:5432/merces pnpm vitest run
CONFORMANCE_CHAIN=simulator pnpm vitest run --project conformance
CONFORMANCE_CHAIN=simulator:monad pnpm vitest run --project conformance
MERCES_TEST_DB=1 DATABASE_URL=… pnpm vitest run --project canary
pnpm stage1:vectors --personality solana,monad        # OK: 38/42 PASS, 42/42 at expected status (12 prefix runs) — or better, with the reason recorded
pnpm stage1:vectors --backend reference               # OK: 25/25 PASS
pnpm stage1:vectors --backend lockstep --personality solana
pnpm stage1:vectors --scenarios                       # OK: 30/32 PASS, 32/32 at expected status
pnpm stage1:vectors --vector-file docs/stage1/defects/vectors/26_final_share_open_ask.json   # PASS 88/88 on both personalities (commit c82b41a)
pnpm stage1:sync --no-conformance                     # math, curve-port, signatures, vectors OK; diff WARN
pnpm openapi:client && pnpm openapi:check             # record the operation count in API_CHANGELOG.md
pnpm docs:events                                      # DOMAIN_EVENTS.md and the schema stay in sync
pnpm demo:cycle                                       # DEMO OK
git log <from>..HEAD --format='%h|%an|%cn|%(trailers:only)'   # every row kunal-drall|kunal-drall| with nothing after
```

After a run, `git status` must be clean (regenerated files unchanged). CI (`.github/workflows/ci.yml`,
`stage1-sync.yml`) runs the same with the submodule and Stage 1's Rust toolchain.

## 4. Remaining backend work, in order

Sizes: S = under a day, M = 1-3 days, L = more. Each item names its acceptance.

### 4.1 Both GitHub branches integrated and pushed

`main` and `claude/jolly-tesla-8j0s7n` contain the backend implementation and both histories (merge `4625660`).
`claude/sweet-goodall-b7acm3` contains the Stage 1 reference fix at `bafe1fb`; main pins that exact commit under
`stage1/`. The Stage 1 branch was published first, then main and the backend branch atomically, with no force push.
Every new commit has kunal-drall as author and committer, with no trailers. Required checks and the clean-install
bootstrap are recorded in `docs/handoff/verification-2026-10-11.md`. This handoff's publication wording is a text-only
follow-up to the tested implementation.

### 4.2 S4 review fixes (implemented)

The eleven findings in `docs/handoff/s4-review-findings.md` are addressed: withdrawal/readdress recovery after rotation,
replaceable expired FX work and queue visibility, third-party pause projection, chain-based true-up accounting,
published-key rejection on live chains, repeat-revocation divergence, eager vector-key provenance validation,
terminal hardship guards/projection, serialized annual signing, live mock-zkTLS refusal and verifier retirement units.
Optional Solana terminal-pause cleanup remains documented in `POLISH_LATER.md`; service safety is enforced now.

### 4.3 Owner-decision records and API diff tool (implemented)

Owner answers and Stage 1 asks are recorded in `STAGE1_INTEGRATION.md`; accepted testnet risk and pre-mainnet
requirements in `SECURITY.md`; compromised-key recovery in `RUNBOOK.md`; defaults and deferred work in
`OPEN_DECISIONS.md` and `POLISH_LATER.md`. `DEPLOY_DAY.md` holds the deployment checklist. The tested
`pnpm api:changelog <from-rev> <to-rev>` command reports operation and nested schema changes from git revisions.

### 4.4 S5: the rest of Stage 1's surface (L)

**Progress:** items **1–12 are implemented**. The table retains their original scope as a checklist. Next: §5.
True-up submission/payment now includes issuer builders, signature/nonce validation, forward credit, paused lateness
accrual, annual formal notices, chain reads and indexed annual states (`signed → recorded → paid`).

**Goal:** every Stage 1 vector PASS in full on both personalities (`expected.ts` TARGETS = all 25, `PREFIX_GATES` empty,
no waivers), `--backend reference` 25/25, lockstep agreeing, **the shim table empty**, and an API route for every flow in
§7.4. The vector runner tells you exactly where each step stands (`pnpm stage1:vectors --only 10 --personality solana`;
`--backend lockstep` stops at the first disagreement).

| # | Item | Stage 1 (reference `stage1/packages/reference/src/sim/simulator.ts`, SPEC §, chains) | Unlocks | Our work |
| --- | --- | --- | --- | --- |
| 1 | **Multi-step transfer windows = buy-back** | SPEC §7; `open_window`, `commit_ask`, `window_commit_bid`, `reveal_order`, `begin_window_settlement`, `tally_window`, `finalize_window`, `process_order`, `deliver_order`; accrual at clearing (C-S4); `windows_enabled` flag; window fee; Solana `window.rs`, EVM `MercesWindow.sol` | vectors 10, 16, 22 (and 23, 25 directly); SH-WIN-1…7, SH-FLG-1 | today one-step windows (`packages/simulator/src/engine/window.ts`; S2 already has Stage 1's escrow semantics); add the multi-step commands, events, planner (like the auction's `nextSettlementStep`), keepers (`window.settle`, `window.deliver`), builders and routes (§7.4 buy-back), indexer projections; the admin `setFlags` command and route (windows ship closed, SPEC §1.6) | L |
| 2 | **Window terms on the series** | SPEC create_series bounds for `windowCommitDuration`, `windowRevealDuration`, `windowFeeBps` (sdk `PARAMETER_BOUNDS`) | SH-REG-4 | add to `SeriesTerms`, `terms-rules.ts` `BOUNDED`, the draft schema and `/terms/validate`; window fee value: Stage 1's default (owner: "a parameter; value undecided", §8) | S |
| 3 | **`pay` without amount and period** | `pay(series)` pays the open due | SH-PAY-1 | `payIn` takes neither (or the runner passes none); keep the builder's due preview | S |
| 4 | **`request_pause` without end; `end_pause`** | `request_pause` has no `until`; `end_pause` (issuer ends an approved pause early: NotIssuer, NotPaused; SPEC §6 pause; simulator `endPause`) | SH-PAU-1; vector 08 from #58 | drop `requestPause.until` (advisory today); add `endPause` user command, `PauseEnded` from it, the issuer builder `POST /series/{id}/hardship/build-end`, the indexer | S |
| 5 | **`register_issuer` admin-only** | the admin registers issuers | SH-REG-1 | `registerIssuer` as an admin command with an admin route (`POST /admin/issuers`), the application-approval flow calls it; remove the self-registration path | S |
| 6 | **FX pairs and the rate accumulator** | `set_fx_pair` (admin, write-once, pair id = keccak(feed ‖ inverted)), `fx_snapshot` (trading days), `quarter_average`, coverage and deviation fallback; inverted pairs in wide arithmetic | vectors 13, 24; SH-REP-1's remaining part | `@merces/math` `interim/` FX family → Stage 1's functions; admin routes for pairs; keeper `rate.snapshot` writes `fx_snapshot`; the runner stops deriving `fxBasis`/`pair` | M |
| 7 | **Tier-3 true-up onchain** | `submit_trueup` (TRUEUP signature, nonce, year order, bound on a credit), `pay_trueup` (60-day window, Late after) | vector 20 from #71 | commands, events, issuer builders over the TRUEUP signature already captured (S4 WP13; fix finding 9 first), the redemption blocker `TrueUpOutstanding` | M |
| 8 | **Tier-1 split router** | `route_income`, `close_router_period`, router checkpoints, reports binding to them | vectors 12, 18 | commands, router keeper, issuer flow; tier-1 public terms with the **explicit issuer consent** step the owner required (§8) | M |
| 9 | **`retire_if_capped`** | permissionless crank: MintNotFinalized, TerminalStatus, NothingDue | waiver BLK-1 (01#34, 05#42); vector 14 from #62 | permissionless command, keeper, optional wallet builder; `/retirement` shows "retirable now" | S |
| 10 | **Direct unit transfer refused** | `transfer_units` outside the protocol is refused by the transfer hook / compliance module | waiver NA-1 (01#32) | a simulator primitive for a direct token transfer that the hook refuses (`NotPermitted`), so the runner runs the step | S |
| 11 | **Report before mint finalization** | `submit_report`, `pay`, `claim_release`, `retire_if_capped`, `redeem` revert `MintNotFinalized` until every bid is processed; router receipts held | vector 18 | the gates exist for some paths (S2 "mintFinalized gates"); complete them with item 8 | S |
| 12 | **`redeem` slippage bound** | Stage 1 has none | SH-RED-1 | keep our `maxPricePerUnit` as an optional product guard and let the runner omit it (then the shim row goes) | S |

Run `pnpm stage1:sync --no-conformance` after each item (regenerates `docs/stage1/VECTOR_PARITY.md`), update
`expected.ts` (targets and gates) with the reason, and update `STAGE1_INTEGRATION.md` "S5 results" and the register.

## 5. Live adapters and `stage1:sync`

### 5.1 Where they stand

Both adapters implement `ChainPort` and have `wired = true`. `auto` still requires a deployed manifest, the correct
RPC network, deployed programs/contracts and the registry signing domain; EVM health also checks core module links.
The checked-in Stage 1 map has no deployed addresses, so normal development still selects the simulators.

Builders cover canonical registry, auction, payouts, true-up, pause, redemption/tail/final, FX, router and window
commands. Solana additionally supports curve activation, swaps, census, staking and tendering. User keys stay in
wallets. EVM exact approvals and Solana account preparation steps are explicit unsigned prerequisites. EVM creates a
draft and then binds its contract hash using the confirmed series id. Report proofs are real Groth16, with Stage 1's
public inputs and chain-specific proof ordering; tail reports preserve the redemption census.

Finalized logs become consecutive canonical event sequences, reproducible after restart, with lossless cursors for
logs that expand into several events. Accounting fixtures cover split principal/payouts and combined final claims.
Errors preserve only protocol names, never RPC request bodies. Offline fixtures cover the pinned ABI/IDL accounts,
Meteora SDK account bytes, mainnet refusals, signed-payload matching and service roles. Public RPC execution is still
unrehearsed, as required by the deployment-last instruction. Configuration and remaining launch dependencies are in
`DEPLOY_DAY.md`; frontend wallet changes are in `API_CHANGELOG.md`.

### 5.2 What Stage 1 provides to encode against

- Solana: Anchor IDLs `stage1/solana/idls/{merces_protocol,merces_registry,merces_hook}.json` (+ `types/`); programs in
  `stage1/solana/programs/*`; LiteSVM tests in `stage1/solana/tests`; deployment record `stage1/solana/deployments/localnet.json`.
- EVM: ABIs `stage1/evm/abis/*.json` (MercesRegistry, MercesAuction, MercesIncome, MercesVault, MercesWindow,
  MercesTreasury, MercesRouter, MercesFxAccumulator, FeeCollector, token factory, …); sources `stage1/evm/src`;
  `stage1/evm/deployments/{anvil,monad-testnet-rehearsal}.json` (the latter is an anvil rehearsal, not a testnet).
- `stage1/EVENTS.md`, `stage1/INTERFACES.md` (prose), `stage1/packages/sdk` (encoders for commitments, messages, domain).

### 5.3 What "code-complete" means and how to test it offline

1. `stage1:sync`'s `generate` step produces typed clients from the IDLs and ABIs (`packages/stage1-sync/generated`).
2. Each adapter implements `build` for every canonical command (`packages/domain/src/commands.ts`; the Solana adapter
   packs an ordered command list into one transaction, the EVM adapter one command per transaction), `send`, every read
   of `ChainPort` (`packages/domain/src/port.ts`), the signing domain read (`ProtocolConfig.domain` /
   `MercesRegistry.domain()`, checked against the manifest), event decoding into canonical events for the indexer, and
   the Meteora DBC venue for curve swaps and quotes on Solana (behind the Meteora port).
3. Offline tests (no validator, no RPC): Solana instruction data against Anchor discriminators and Borsh layouts from the
   IDL (and, for full confidence, a small oracle crate like `tools/stage1-oracle` that builds Stage 1's own instruction
   structs); EVM calldata against the ABIs with viem; event decoding against fixtures recorded from Stage 1's LiteSVM and
   Foundry tests; error-name mapping against `error.rs` / Solidity custom errors (`packages/simulator/src/engine/errors.ts`
   already maps every name the simulator raises).
4. Set `wired = true` only when all of the above pass; then `auto` mode can go live.

### 5.4 `stage1:sync` on manifest day

`packages/chains/src/manifest.ts` reads Stage 1's `handoff/manifest.json` (or `manifest.json`) and falls back to this
repository's hand-written `stage1.map.json`. What Stage 1 still has to supply (`stage1.map.json` "missing"): the
manifest itself; Solana devnet program ids and RPC; Monad testnet contract addresses and RPC; stablecoin mints/addresses
for devnet and testnet; the indexer's start slot/block; a machine-readable events/commands schema (optional: the IDLs and
ABIs carry the field sets). When the manifest exists: bump the submodule pin to the deployed commit, run
`pnpm stage1:sync` (with conformance), fix the drift it reports in `INTERFACE_DRIFT.md`, and record the deployment in
`stage1.map.json` or delete it in favour of the manifest.

## 6. Deployment

`DEPLOY_DAY.md` is the maintained runbook. Deployment is still last: do not run public-chain transactions or hosting
until all four stages are ready. The live conformance code now accepts funded operator wallets and real proofs;
quarterly tests need real calendar time on a public chain, or an explicitly enabled loopback EVM fork. `demo:cycle`
remains the deterministic simulator demonstration. Neither is evidence of a public deployment.

## 7. Frontend integration

### 7.1 Contract and client

- **Spec:** `packages/api/openapi.yaml` (OpenAPI 3.1; 190 operations). **Narrative:**
  `API.md` (conventions, every flow, the access matrix). **Typed client:** `packages/client`
  (`src/generated/openapi.d.ts`, regenerated with `pnpm openapi:client`). **Changes per push:** `API_CHANGELOG.md`.
- **Base URL:** `http://localhost:3000` under `pnpm dev:mock`. CORS allows any origin (`packages/api/src/app.ts`).
- **Errors:** `{ error, message, detail }`; 400 validation, 401 no session, 403 wrong tier, 404, 409 state (with
  `detail.reason`), 422 rule or chain refusal (Stage 1's error name in `detail` where the route documents it, e.g.
  `detail.stage1`), 501 live adapter not ready. Each operation's documented `detail` shapes are in `openapi.yaml`.
- **Money:** decimal strings in stablecoin base units (6 decimals); ratios 1e18 fixed point as strings; times unix
  seconds; periods `YYYYQn`; ids chain-neutral (`seriesId = "<chain>:<address>"`).
- **Access tiers** (`x-access` on every operation): `public`, `account`, `backer` (eligible), `holder`, `issuer`,
  `attestor` (a linked key registered onchain, read live), `admin`, and combinations (`API.md` "Access tiers").

### 7.2 Sign-in and transactions

1. `POST /auth/nonce {chain, address}` → a sign-in message; the wallet signs it; `POST /auth/verify {chain, address,
   message, signature}` → `{token, account {accountId, wallets, roles, eligible}, created}`; send
   `Authorization: Bearer <token>`. `POST /me/wallets/link` links the other chain's
   wallet; `POST /me/session/refresh` after role changes.
2. Every write is a **builder**: `POST …/build-*` returns `{ tx: UnsignedTx, … }` (`chain`, `family`, `signer`,
   `command`, `commands?`, `payload`, `encoding`, `summary`, `expiresAt`). The user's wallet signs it; `POST /tx/send
   { tx, signatures }` relays it and returns the canonical events. On live chains `payload` is a base64 Solana message or
   EVM `{to, data, value, chainId}`; the frontend may also send through its own RPC.
3. **Under `dev:mock`** the chains are simulated and simulator signatures are accepted: a sign-in signature is
   `"sim:" + sha256hex(address ‖ message)`; a transaction's signatures are `{ [signer]: "sim:" + signer }`
   (`packages/simulator/src/wallets.ts`, `packages/ports/src/wallet-verify.ts`). Never accepted with a live chain.
4. **Attestor signatures are not transactions:** the API returns a `SigningRequest`; the attestor signs it in
   `merces-attestor sign` (or, once Stage 1 ships the wallet-friendly form, in a wallet) and posts only `{signer,
   signature}`. MetaMask/Ledger cannot sign Stage 1's raw digests today (`VERSIONS.md`).

### 7.3 `dev:mock` personas and helpers

Seeded by `packages/server/src/dev-mock.ts` (both simulator personalities, the 12-issuer pilot cohort with settled
raises and reports, a Solana curve series): `acct-issuer-<handle>` (issuer + backer, one wallet on its chain),
`acct-backer-1` … `acct-backer-5` (eligible, one Solana and one EVM wallet each), `acct-attestor-1`, `acct-attestor-2`
(linked dev attestor keys, seeds `merces-dev-attestor:<n>`, registered on both simulators), `acct-admin`. Wallet
addresses are `new SimWallet(family, label).address` (`@merces/simulator`; labels `issuer:<handle>`, `backer-<n>`) or
`select * from account_wallets`. Dev routes: `GET /dev/time`, `POST /dev/advance-time` (skip to deadlines and quarters),
`POST /dev/faucet` (test USDC), `POST /dev/esign/complete`. Keepers run in-process every tick (settlement, delivery, curve
lifecycle and census, pause ends, reminders).

### 7.4 Flows → endpoints (what exists; ⚠ = gap listed in §4)

Detailed per-flow survey with code locations: `docs/handoff/api-coverage-survey.md`.

| Flow | Persona | Endpoints |
| --- | --- | --- |
| Onboarding | any | `POST /applications`, `…/identity/start`, `…/identity/refresh`, `…/readiness`, `…/submit`, `GET /applications/mine`; admin `GET /admin/applications`, `POST /admin/applications/{id}/decide`; ⚠ admin-only issuer registration (§4.4 #5) |
| Series creation | issuer | `POST /drafts`, `PUT /drafts/{id}/terms`, `POST /terms/validate`, `POST /terms/commitment`, `POST /drafts/{id}/contract/prepare`, `GET …/contract(/document)`, `POST /drafts/{id}/build-create-series` → `/tx/send` → `POST /drafts/{id}/link-created`; ⚠ window terms (§4.4 #2) |
| Auction (sealed bid) | issuer, backer | `POST /series/{id}/raise/build-open`, `…/raise/build-cancel`; `POST …/bids/precheck`, `…/bids/commitment`, `…/bids/build-commit`, `…/bids/build-reveal`, `PUT/GET …/bids/backup`; `POST …/auction/build-step` (anyone: next settlement step), `…/bids/build-deliver`; `GET /series/{id}/auction`, `…/auction/preview`, `GET /me/bids` |
| Claims | holder | `GET /series/{id}/position`, `POST …/payouts/build-claim`, `…/tail/build-claim`, `…/final/build-claim`, `…/redemption/build-claim`, `…/holders/build-register`; `GET /me/holdings`, `/me/payouts`, `/series/{id}/payouts`, `/vault`, `/holders`, `/periods`; ⚠ `retire_if_capped` and a wallet `burnRetired` builder (§4.4 #9) |
| Redemption | issuer, holder | `GET /series/{id}/redemption/quote`, `POST …/redemption/build-redeem`, `GET …/redemption`, `GET …/retirement` |
| Curve (Solana) | backer | `GET /series/{id}/curve`, `GET …/curve/quote` (returns `beforeYouBuy`; show "Unapproved wallets earn nothing and cannot tender." before the buy), `POST …/curve/build-swap` (needs `acknowledged: true` and the statement version), `GET …/curve/position`, `POST …/curve/build-stake`, `…/build-unstake` (one transaction: unstake + claim), `…/build-tender`, `…/build-sync`; issuer `POST …/curve/configure`; "no cap" and the buyer notice in every curve read |
| Reports | issuer | `GET /series/{id}/reporting/schedule`, `…/reporting/prior`, `…/reporting/fx/{period}`, `POST …/reporting/zktls-session`, `POST /series/{id}/reports` (assemble), `GET /reports/{id}`, `POST /reports/{id}/build-submit`, `…/submitted`, `…/build-payin`, `…/paid`; prover artifacts `GET /prover/artifacts`, `/prover/report.wasm`, `/prover/report.zkey`; ⚠ a pure-frontend report needs an in-browser prover (the artifacts are served) and a real zkTLS provider; today `@merces/poi-device` assembles in Node; ⚠ FX pairs, true-up submit/pay, tier-1 router (§4.4 #6-#8) |
| Pause (hardship) | issuer, attestor | `POST /series/{id}/hardship` (+ `/tx/send` of `requestPause`), `GET …/hardship`, `POST …/hardship/build-withdraw`; attestor `GET /attestor/hardship/{id}`, `…/message?pauseEnd`, `POST …/decide` (the keeper relays the approval); ⚠ `end_pause` builder (§4.4 #4) |
| Buy-back (transfer windows) | holder, backer | today one-step: `GET /series/{id}/window`, `POST …/window/build-commit`, `…/window/build-reveal`, `PUT/GET …/window/backup`; ⚠ **the multi-step window flow (§4.4 #1) is the largest gap**: open, commit ask/bid, reveal, settlement steps, process/deliver orders, the windows flag |
| Attestor signing | attestor | key: `POST /me/signer-keys/challenge`, `POST /me/signer-keys`, `GET /me/signer-keys`, `DELETE /me/signer-keys/{address}`, `POST/GET /me/attestor/identity-check`; work: `GET /attestor/me`, `GET /attestor/queue`; tier 3 `GET /attestor/tier3/{caseId}`, `…/message`, `POST …/sign`; FX `GET /attestor/fx-requests`, `…/{id}/messages`, `POST …/{id}/sign`; amendment `GET /attestor/amendments/{id}/message`, `POST …/attest`; extinguishment `POST /attestor/extinguish`, `GET …/{id}`, `…/message`, `POST …/sign`; true-up `GET /attestor/tier3/annual/{id}`, `…/message`, `POST …/sign`; issuer side `POST /series/{id}/tier3/{period}`, `…/tier3/annual`, `GET …/tier3`, `POST /series/{id}/amendments/inflation`, `POST /amendments/{id}/build`, `…/apply`; ⚠ S4 review findings 1-2 (stranded and dead signatures) |
| Admin | admin | `GET /admin/overview`, `/admin/attestors` (+ `POST`, `/revoke`, `/rotate`), `/admin/verifier-keys` (+ `/revoke`, `/rotate`), `/admin/tx-requests` (+ `/{id}/sent`), `/admin/flags`, `/admin/thresholds…`, `/admin/eligibility…`, `/admin/accounting/*`, `/admin/audit-log`, `/admin/notifications/*`, `/admin/keepers/runs`, `POST /admin/raises/pause`, `POST /admin/curves/monitor`, `POST /admin/contracts/templates`; ⚠ `setFlags` for windows, FX pair registration, issuer registration (§4.4) |
| Reads for everyone | public | `GET /series`, `/series/{id}`, `/series/{id}/status`, `/series/{id}/activity`, `/series/{id}/signing`, `/issuers`, `/issuers/{id}`, `/arena`, `/activity`, `/chains`, `/chains/{chain}/signer-keys`, `/thresholds`, `/income-sources`, `/health`; account `GET /me`, `/me/notifications`, `PUT /me/notification-preferences` |

### 7.5 What the frontend must not assume

- A holder tier needs a position row: a wallet that only bid, or a curve buyer that never staked, gets 403 on
  `/series/{id}/position` and the claim builders; route them to `/me/bids` and `/series/{id}/curve/position`.
- Stage 1's signed messages bind live nonces: a stale signature is 409 `stale-nonce`; fetch a fresh signing request.
- `signing` in `GET /chains` is null on a live chain until its adapter reads the domain: signing flows then answer 409
  `signing-domain-unknown`.
- Curve mode is Solana only; the EVM personality refuses curve routes.

## 8. Open decisions (defaults in force; seed for `OPEN_DECISIONS.md`)

| Decision | Default taken | Where | If the owner decides otherwise |
| --- | --- | --- | --- |
| Verifier key custody | local dev signer until staging; AWS KMS later | `packages/ports/src/kms*.ts`, `report-verifier/src/main.ts` | add the AWS adapter over `RemoteSecp256k1Kms` (facts pinned in `VERSIONS.md` "Signing keys and KMS") |
| Wallet-friendly messages | owner asks Stage 1 for EIP-712/EIP-191 forms; `merces-attestor` is the path | `poi-device`, `DigestSigner` | add a wallet signer behind `DigestSigner`; the API's signature check takes the new digest form |
| Compromised-key risk | accepted for testnet | `SECURITY.md` (§4.3) | mainnet requirements (§6.4) |
| Extinguishment accounts | two separately verified accounts, enforced at registration (commit `5029b6f`) | `admin/service.ts` `requireVerifiedAttestorAccount` | — (decided) |
| Final-share weight | follow both chains; defect report sent to Stage 1 | `simulator/src/engine/terminal.ts`; `docs/stage1/defects/` | adopt Stage 1's answer (a one-line weight change) |
| Non-reveal charge rate | per series; the rate is the owner's deployment setting `MERCES_NON_REVEAL_CHARGE_BPS`, no built-in default (the terms service refuses sealed series while unset) | `services/src/terms`, `.env.example` | set the value |
| Window fee | a series parameter; value = Stage 1's default until the owner decides | S5 #2 | set the value |
| Tier-1 public terms | accepted, with an explicit issuer consent step | S5 #8 | — |
| Formal notice | mirrors Stage 1 (period end + 90 days); owner asked Stage 1 to move it to 90 days after the deadline | `domain` status rules | follow Stage 1's change |
| Tier-2 liquidity flag | the verifier signs the device-declared flag | `report-verifier` | an attested source |
| Lost device openings | deterministic salts from the device secret | `poi-device` | — |
| Pushed claims / keeper sweeps | not built | — | a `claimFor` path |
| `issuer_accepts_public_price` | implicit on choosing a curve (consent field recorded as a question) | curve configure | an explicit field |
| Census binding at period end | ours: 409s around the issuer's report (A-CURVE-5); asked of Stage 1 | `poi/service.ts`, keepers | follow Stage 1 |
| Unstake pays | the code wins (unstake credits pending; our builder bundles a claim) | `meteora/staking.ts` | follow Stage 1 if its SPEC wins |
| Mock zkTLS on testnet | refuse on live chains (S4 review finding 10) | `report-verifier` | an explicit override for testnet |
| Anything else open | follow Stage 1's code and the default in `ASSUMPTIONS.md` | — | — |

## 9. Deferred items and known risks (seed for `POLISH_LATER.md`)

| Item | Risk if left |
| --- | --- |
| S4 review findings 6-9, 11 (`docs/handoff/s4-review-findings.md`) | wrong lift condition in the register; seed check weaker than documented; terminal-status pause edge; multi-year true-up nonce; mis-entered `retiredAt` |
| AWS KMS adapter | staging cannot use a managed key until built (owner: later) |
| EVM adapter builds one command per transaction | the curve unstake bundle is Solana only (curve mode is Solana only, so no impact now) |
| Our scenarios beyond what a vector needs | fewer regression nets for paths no vector takes |
| Live nonce read in `merces-attestor` from a public RPC | a compromised API could collect a PAUSE over a future nonce (residual risk in SECURITY.md) |
| Real identity (J.1), zkTLS (J.3), e-sign, email, price feeds, DEX providers | testnet runs on mocks; reports on testnet are forgeable with the mock zkTLS and Stage 1's development trusted setup |
| Doc polish of `STAGE1_INTEGRATION.md` (long) | slower onboarding |
| `TODO`/`S5` markers in source (`grep -rn "S5" packages/*/src`) | each is an item of §4.4 or §5 |

## 10. Supporting files

| File | What |
| --- | --- |
| `docs/handoff/s4-review-findings.md` | the eleven S4 review findings with locations, scenarios and fixes (§4.2) |
| `docs/handoff/api-coverage-survey.md` | flow-by-flow survey of the API at `8837dba`: routes, code locations, gaps, what `dev:mock` serves, client typing |
| `docs/handoff/owner-directions-2026-10-11.md` | the owner's fast-mode and deployment-last directions and answers, verbatim |
| `docs/handoff/s4-amendments.md` | the binding S4 amendments (S4 decisions D1-D17 are summarised in STAGE1_INTEGRATION.md "S4 results") |
| `docs/stage1/defects/DIV-S1I-1-final-share-open-ask.md` + `vectors/26_final_share_open_ask.json` | the Stage 1 defect report the owner forwards, with the missing vector (commit `c82b41a`); `packages/stage1-sync/scripts/compose-vector-26.mts` regenerates the vector |
| `STAGE1_INTEGRATION.md` | results per milestone, the divergence register, owner decisions, "Asked of Stage 1", adapter notes, blockers |
| `docs/stage1/VECTOR_PARITY.md` | generated vector-by-vector parity, prefix gates, waivers, shims |
| `API_CHANGELOG.md` | API changes per push |

The planning records of S1-S3 and the S5 inventory lived in a session scratchpad that is gone; their decisions are in
`STAGE1_INTEGRATION.md` and `ASSUMPTIONS.md`. The original S5 inventory was thin; §4.4 records the completed scope and §5 records the adapters. Earlier notes are
built from the parity tables, the shim table, the API survey and the adapter sources instead.
