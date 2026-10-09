# STAGE1_INTEGRATION.md

How Stage 2 works without Stage 1 today, how it catches Stage 1 the moment it appears, and what happens then.
This file is updated at each catch-up with what matched, what changed and what is still open.

## Status (2026-10-09): Stage 1 @5eafd41 checked in, drift under review

Stage 1 arrived on branch `claude/sweet-goodall-b7acm3`, commit `5eafd41`, SPEC v1.1.2. `STAGE1_PATH` points at a
checkout of that commit. **The canonical model has not changed yet:** the drift below goes to the owner first.

**What the handoff was missing.** Stage 1 ships no `handoff/manifest.json`, so `stage1.map.json` at this repository's
root describes it by hand (A-SYNC-2). Missing (also listed in the map's `missing` field):

- `handoff/manifest.json` itself;
- Solana devnet program ids and RPC (only `solana/deployments/localnet.json` exists);
- Monad testnet contract addresses and RPC (`evm/deployments/monad-testnet-rehearsal.json` is an anvil rehearsal
  with anvil's default deployer, not a testnet deployment);
- a machine-readable events/commands schema (`EVENTS.md` and `INTERFACES.md` are prose; the diff reads the IDLs
  and ABIs instead);
- stablecoin mints and addresses on devnet and testnet;
- the indexer's start slot and start block.

Reports: `INTERFACE_DRIFT.md` (repository root) and snapshots of the two gitignored reports in `docs/stage1/`
(regenerate with `STAGE1_PATH=<checkout> pnpm stage1:sync --no-conformance`).

| D6 step | Result at @5eafd41 |
| --- | --- |
| 1. `stage1:sync` | runs end to end with `--no-conformance` |
| detect | ok: `stage1.map.json` (hand-written) |
| generate | ok: 4 Anchor IDLs and 28 ABIs rendered to `packages/stage1-sync/generated` |
| diff | drift: **Solana** 3 canonical items without a counterpart, 260 field mismatches, 87 extra Stage 1 items; **Monad testnet** 1 / 221 / 97. `INTERFACE_DRIFT.md`; review below |
| math | **6 of 12 function families disagree** with Stage 1 (snapshot in `docs/stage1/MATH_PARITY.md`, A-MATH-2): hurdle compounding and late accrual (ours is never lower: we would overcharge the issuer), the payout accumulator's dropped remainder, holder claims (ours can pay one base unit more), the redemption price (through the hurdle only) and the auction's marginal fill. Stage 1 wins |
| vectors | 25 vectors (2,092 steps, 143 expected reverts) inventoried, **0 replayed**: every vector settles its auction through `begin_settlement` → `tally_bids` → `finalize_settlement` → `process_bid` → `deliver_bid`, which the canonical model does in one `settleAuction`; every `expect` compares Stage 1's full state snapshot; and every report carries a Groth16 proof over Stage 1's public inputs. Estimate: 8 vectors (04, 06, 07, 09, 11, 19, 23, 25) can pass once the simulator takes Stage 1's report public inputs, with documented runner shims; the other 15 need canonical changes (B below). No vector covers curve mode. `docs/stage1/VECTOR_PARITY.md` maps each op |
| conformance | **blocked**: no devnet or testnet deployment |
| verdict | both chains NOT ready |

Stage 1's own reference suite was re-run here against its vectors: 171/171 pass (`@merces/reference`, built inside
the Stage 1 checkout with Stage 1's pinned toolchain; `node_modules` and `dist` are ignored by Stage 1's git).

### Blockers

| Blocker | Needs |
| --- | --- |
| D6.2/3: resolving drift and replaying the 25 vectors | the owner's review of the drift below (canonical model changes) |
| D6.4: wiring the adapters (`wired = true`) | the review, then program ids and addresses |
| D6.5: conformance on Solana devnet and Monad testnet | Stage 1 deployed to both (STATUS.md: both RPCs are blocked from Stage 1's build container, U5), funded test wallets |
| D6.6: full raise-to-payout cycle live | D6.5 |
| D6.7: `live` in staging | D6.6 |
| Stage 1's own open items | owner decisions H1–H8; S2 curve-redemption residual (A49); the development trusted setup must be replaced before mainnet (A37). On S2 the code is ahead of `SECURITY_REVIEW.md`, which still says "fix designed, not yet coded": `exit.rs` takes the census without the pool vault (`compute_curve_units(…, true)`), as SPEC v1.1.2 §9, STATUS.md and A49 say |

### The two curve questions, answered from the Stage 1 code

**Where do curve buyers' payments sit before graduation?** In Meteora's DBC pool `quote_vault`, owned by the DBC
pool-authority PDA. Nobody can withdraw it: not Merces, not the issuer (`docs/meteora/CURVE_MODE.md` §8, "Who holds
the raise during the sale"). The series treasury receives money only after graduation: `complete_curve` (anyone,
once `quote_reserve ≥ migration_quote_threshold`) settles the series, then `collect_curve_proceeds` moves the DBC
migration fee (99% of the threshold by default) into the treasury, released on the series schedule; the rest becomes
DAMM v2 liquidity (`solana/programs/merces_protocol/src/curve.rs`). A curve that never graduates stays Open forever:
no cancel, no failure, no deadline, no refund; buyers keep their units and can only sell back into the curve
(SPEC §9). `extinguish` requires a settled raise and a finalised mint (`exit.rs`, `RaiseNotSettled`), so an
ungraduated curve cannot be extinguished and Merces holds nothing to repay. → A-CURVE-3.

**Does the curve program enforce the wallet cap onchain?** No, in neither phase. SPEC §9: curve series store wallet
cap, lockup and raise durations as 0 (`create_series` rejects non-zero values). The DBC base mint has no transfer
hook, freeze authority or permanent delegate, and buys are DBC `swap2` calls sent straight to Meteora's program, so
Merces sees none of them. There is no buy allowlist: the allowlist gates `stake_units`, and only staked units earn.
The backend's cap can only limit buys built through Merces. → A-CURVE-2 (ASK).

Other curve facts the model has to absorb: curve mode is Solana only (EVM `createSeries` reverts
`CurveModeUnsupported`); holders earn only on units staked in the series stake vault (`stake_units`,
`unstake_units`); redemption is by tender (`tender_units`, burned in place); `P0 = floor(X × 10^6 / swap_base_amount)`;
accounting is per base lamport (6-decimal units).

### Drift review: proposed resolution (awaiting the owner)

Nothing below is applied yet. Where Stage 1 and Stage 2 disagree on onchain behaviour, Stage 1 wins; the question
for the owner is how the canonical model absorbs it.

**A. Adapter-only (no model change).** Names Stage 1 spells differently (`STAGE1_ALIASES`: `drawRelease` ↔
`claim_release`, `AuctionSettled` ↔ `RaiseSettled`, …); the series and holder passed as Solana accounts rather than
args; field renames (`price` → `pricePerUnit`, `old`/`new` → `from`/`to`, `commit_end` → `commitEndsAt`); events the
adapter can synthesise (`TreasuryFunded` on Solana from `RaiseSettled`; `FeeTaken` from `PayoutDistributed.fee`); the
redemption slippage guard (`maxPricePerUnit`) checked before submitting, since Stage 1's `redeem` takes no bound.

**B. Canonical model changes (Stage 1 wins).**

1. *Auction settlement.* Stage 1: proposer claims (`begin_settlement`), paged `tally_bids`, `finalize_settlement`
   (a wrong proposal is rejected, not reverted), then per-bid `process_bid` and a retryable `deliver_bid` that pushes
   units and refunds; uniform price with a pro-rata marginal fill `floor(R × q / q_at)` and the remainder unsold; one
   bid per wallet; a bid above the wallet cap is invalid at reveal and refunded in full; 1% non-reveal charge (H1); a
   winner removed from the allowlist after committing still receives units. Ours: one `settleAuction`, fill by price
   then commit order, cap applied at allocation, refunds pulled with `claimRefund`, de-allowlisted winners excluded.
2. *Transfer window.* The same multi-step shape (`begin_window_settlement`, `tally_orders`, `finalize_window`,
   `process_order`, `deliver_order`, take-back steps) keyed by period, two-branch clearing with first-come fills at the
   margin, a 100 bps window fee, ask units held in escrow, a terminal series forced to NoMatch (S3). Stage 1 emits
   per-order fills, so the canonical pairwise `UnitsTransferred(from, to)` has no source. **Windows ship disabled**
   (`windows_enabled = false`, A18): the keepers must not open windows until the admin enables them.
3. *Holder claims.* Separate tail and final accumulators with `claim_tail` and `claim_final`, an explicit
   `register_holder` (cursors start at 0, S1), and a tail catch-up inside the redemption claim (S6). Ours routes the
   tail and extinguishment through the payout accumulator.
4. *Signatures, commitments, proofs.* Attestor and report-verifier keys are **secp256k1** 20-byte addresses on both
   chains, signing Stage 1's `MERCES_*_V1` keccak messages (per-deployment domain, per-series nonces, low-s), and the
   signatures travel as **instruction arguments**; nobody co-signs (our `UnsignedTx.coSigners` and the attestor
   wallet check of A-M5-2 assume otherwise). Ours: ed25519 over canonical JSON. Bid and order commitments are keccak
   over packed integers; terms and income commitments are Poseidon; proofs are Groth16 with public inputs
   `[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]`, so
   `submitReport` needs the prior commitment (A25). Ours: sha256 over canonical JSON, a mock prover, our own input
   order. This touches the report verifier's KMS key type, the device prover, the terms vault and the bid flow.
5. *Extinguishment.* Two distinct attestor signatures with a nonce; only **unvested** proceeds go to holders, vested
   but undrawn tranches stay with the estate (A31, H4); refused unless the raise settled.
6. *Missing flows.* The tier-3 true-up is onchain (`submit_trueup`, `pay_trueup`; our A-C8-3 and A-M5-5 assumed it
   was not); the tier-1 income router (`init_router`, `route`, `close_router_period`) is permissionless and keeps θ
   and r in plaintext onchain for tier-1 series (Stage 1 A22: the issuer's choice; our events say θ never goes
   onchain, so this is a privacy decision for the owner); `withdraw_pause_request`; pauses without a requested end;
   key revocation with a 45-day grace (A33); `retire_if_capped`; `resume_issuance`; `request_early_draw`.
7. *Actors and admin.* `register_issuer` is **admin-only** on both chains (ours is the issuer's own command); there is
   no admin router registration; timelock-only powers need `TimelockController.schedule`/`execute`; the admin
   surface adds `set_flags` (`new_raises_paused`, `windows_enabled`, `tier4_enabled`), `set_fx_pair`, `set_defaults`,
   `set_contract_hash`, admin transfer. One user action can need several transactions (Solana `prepare_raise` then
   `open_raise`), while our builder returns one.
8. *Series parameters and identity.* `create_series` carries mode, tier flags, FX pair, release schedule (≤ 24
   tranches), `k`, hurdle, fee and non-reveal bps, lockup and wallet cap, and the terms commitment. EVM series ids are
   `uint256` counters, not addresses. Defaults differ: lockup 547.875 days (ours 540), tail 365 days (ours 360). Our
   `walletCapBps` must be positive, which rejects every Stage 1 curve series (cap 0).
9. *Status and timing.* The formal notice falls at period end + 90 days (ours + 120); OnTime lasts while the
   countdown is ≤ 30 days and InGrace while ≤ 45 days (ours switches at the boundary); `D_avg` buckets a payment by its
   period's deadline, not by when it arrived; FX coverage counts trading days, and weekend snapshots revert.
10. *Indexer and codecs.* Stage 1 events carry no stream sequence, while our indexer requires a dense `seq` (the
    adapter must keep its own counter, or the indexer accepts a strictly increasing one). Codecs: `period` u32 ↔
    `"YYYYQn"` (and a calendar year for true-up notices), `pair_id` bytes32 ↔ `"EUR/USD"`, base58/hex keys. Some enum
    codes differ between the chains (`UnitsBurned.reason`, `WindowCleared.branch`), event order inside a transaction
    differs between the chains, several canonical events are joins (`PaymentReceived` = `PaymentSettled` +
    `PayoutDistributed`), and the Solana decoder must accept only Merces program frames and skip failed transactions.
11. *Curve mode.* Solana only; no `buyCurve` in Merces (a DBC swap; the backend could still build the unsigned
    Meteora swap); `activate_curve`, `complete_curve`, `collect_curve_proceeds`, `sync_curve_units`, staking and
    tender; no cancel, failure or extinguishment before graduation; units in base lamports (6 decimals). Our Meteora
    service must generate configs with creator fee 0 and the Merces PDA as fee claimer, or activation fails (H3).
12. *Math.* Replace the six disagreeing families with Stage 1's formulas (or import `@merces/reference`), then
    replay the 25 vectors through a Stage 1 op runner on the simulator with full-state expectations.

**Stage 1 documents that disagree with Stage 1's code** (the code, IDLs and vectors win): `SECURITY_REVIEW.md` on S2;
`EVENTS.md` field lists in several places; `CURVE_MODE.md` §5 (claims are gated by staking); the vectors declare
`specVersion "1.1"` while testing v1.1.2 fixes; vector 15's notes say a non-revealer is charged while its expectations
show a full refund (the expectations match SPEC §5.2).

## What we expect from Stage 1

A handoff manifest at `$STAGE1_PATH/handoff/manifest.json` (or `manifest.json` at the root). Every field is optional;
unknown fields are kept:

```json
{
  "version": "…", "commit": "…",
  "math":    { "package": "<path or npm name exporting a MercesMath-shaped object (see packages/math/src/index.ts)>" },
  "vectors": "<path to parity vectors (format below)>",
  "events":  { "doc": "EVENTS.md", "schema": "<JSON schema: {events: {Name: {properties}}, commands: {Name: {properties}}}>" },
  "solana":  { "cluster": "devnet", "rpcUrl": "…", "programs": { "<module>": "<program id>" }, "idlDir": "<dir of Anchor IDL json>", "startSlot": 0 },
  "evm":     [ { "chain": "monad-testnet", "chainId": 10143, "rpcUrl": "…", "startBlock": 0, "contracts": { "<module>": "<address>" }, "abiDir": "<dir of ABI json>" } ],
  "stablecoins": { "solana": { "USDC": "<mint>", "USDG": "<mint>" }, "monad-testnet": { "USDC": "<address>" } }
}
```

If Stage 1 arrives without a manifest, write `stage1.map.json` (same shape) by hand at the Stage 1 root or at this
repository's root; the pipeline accepts either (the repository's copy only for a non-empty `STAGE1_PATH`, and it
reports a checkout at another commit than the map pins). Stage 1 @5eafd41 needed the hand-written map.

Stage 1's math package does not export a `MercesMath` object; `stage1:sync` then compares function families
(A-MATH-2) and needs the package built inside the Stage 1 checkout.

### Parity vector format

```json
{
  "math": [ { "fn": "owedYtd", "args": ["100000000000000", "500", "75000000000", "60000000000"], "expect": "750000000" } ],
  "scenarios": [ {
    "name": "happy-path", "genesis": 1767225600, "personalities": ["solana", "monad"],
    "steps": [
      { "at": 0,  "actor": "issuer",   "command": { "kind": "registerIssuer" } },
      { "at": 10, "actor": "keeper",   "command": { "kind": "settleAuction", "seriesId": "$series0" } },
      { "at": 20, "actor": "backer-1", "command": { "kind": "revealBid", "...": "..." }, "expectError": "WrongPhase" }
    ],
    "expect": { "balances": { "backer-1": { "USDC": "…" } }, "series": { "$series0": { "status": "OnTime", "unitsOutstanding": "500" } } }
  } ]
}
```

Actors: `issuer`, `backer-N`, `attestor-N`, `admin`, `keeper`, `allowlistManager`, `router`. `$seriesN` is the N-th
series created in the scenario. Bigint arguments are decimal strings. Every expected balance must match the simulator
to the base unit; a mismatch means the simulator is wrong and is fixed.

Math vectors are compared exactly after canonicalisation (bigints and numbers as decimal strings, object keys sorted).
A function that returns an object needs the whole expected object, every field included; a missing or extra field
is a disagreement.

## `pnpm stage1:sync`

1. **detect** — manifest or map through `STAGE1_PATH`; "Stage 1 not present" otherwise.
2. **generate** — EVM ABIs → `packages/stage1-sync/generated/evm/*.ts` (`as const` for viem); Anchor IDLs →
   `generated/solana/*.ts` (built-in renderer; Codama can replace it once Stage 1 pins an IDL spec version).
3. **diff** — `INTERFACE_DRIFT.md`: every canonical event and command, its Stage 1 counterpart, field-by-field mapping,
   and anything missing, extra or differently shaped. Only exact names (ignoring case, `_` and `-`) map; a look-alike
   (`fee` vs `feeBps`) is listed as an unverified match, and it, extra fields/args and names-only items all count as
   drift. The step is `ok` only when nothing is left to resolve.
4. **math** — Stage 1's library vs ours on every math vector, or, when Stage 1 exports its own function shapes,
   family by family on deterministic inputs (`MATH_PARITY.md` under `packages/stage1-sync/out`; A-MATH-2).
   Full agreement is reported as "eligible to replace the interim library"; it does not change what any process runs.
5. **vectors** — Stage 1's own vector directory is replayed by the Stage 1 vector runner (`pnpm stage1:vectors`,
   `packages/stage1-sync/src/stage1-vectors`): on the reference backend (Stage 1's own simulator; all 25 must pass,
   proofs verified, or the runner or the checkout is broken) and, from S1 WP9b, on the merces backend (our simulator,
   the S1 target vectors on both personalities, each at its expected status). `VECTOR_PARITY.md` lists the results,
   the findings with leaf-path diffs, waived steps, the shims used ("not parity") and the op inventory. A single JSON
   file of `scenarios` (the earlier Merces format) is replayed through the harness.
6. **conformance** — the H2 suite against each live chain (`CONFORMANCE_CHAIN=solana|evm:<chain>`).
7. **verdict** — per chain: ready for `live` only when no step failed and both **diff** and **conformance** are `ok`
   (drift left to resolve, or conformance skipped or not run, is a blocker); otherwise the blockers.

It runs in CI on a six-hour schedule and whenever `stage1/**`, `stage1.map.json` or `.gitmodules` change
(`.github/workflows/stage1-sync.yml`; set the `STAGE1_REPO` repository variable).

## After Stage 1 lands (D6 checklist)

1. Run `pnpm stage1:sync`; read `INTERFACE_DRIFT.md` first.
2. Resolve drift in the adapters' mappers (`packages/chain-solana/src/mapping.ts`, `packages/chain-evm/src/mapping.ts`).
   Change the canonical model only for a real gap, and record why here.
3. Where Stage 1 contradicts an assumption, Stage 1 wins for onchain behaviour: update the simulator and
   `ASSUMPTIONS.md`. Candidates already flagged: A-AUC-1 (tie-breaking), A-C8-1/2 (accrual), A-RED-1/2 (redemption
   precondition, tail fee), A-REP-2 (public input layout), A-FX-1/2 (weekends, Chainlink), A-C11-6 (extinguishment).
4. Wire the adapters' reads, event decoding and transaction builders to the generated clients, then set the adapter's
   `wired` flag to `true` (until then `auto` keeps the simulator; explicit `live` is what conformance uses). The
   conformance env for live chains needs funded devnet/testnet wallets (`CONFORMANCE_ISSUER_KEY`, `CONFORMANCE_BACKER_KEYS`,
   `CONFORMANCE_ATTESTOR_KEYS`, `CONFORMANCE_ADMIN_KEY`) and short durations in Stage 1's test deployment.
   If math parity is proven and Stage 1's library should replace the interim one, that is its own change: route the
   money-relevant calls through `math.<fn>()` and select the library at startup in every process.
5. Get the conformance suite green on Solana devnet and Monad testnet.
6. Run the full raise-to-payout cycle on both live chains (`pnpm demo:cycle` against `MERCES_CHAIN_*_MODE=live`).
7. Flip both chains to `live` in the staging configuration; keep `mock` for local development and Stage 3.
8. Update this file: what matched, what changed, what is still open.

## Known gaps that only Stage 1 can close

State at @5eafd41:

- Groth16 circuit, verifying key and prover artifacts: delivered (`circuits/build`), from a development trusted
  setup that must be replaced before mainnet (A37). The mock proof system stays in use until B.4 of the review lands.
- Event and instruction names, account layouts and error codes: delivered (IDLs, ABIs, `@merces/sdk` error names);
  the adapters' mappers are filled after the review.
- Pyth receiver accounts and FX feeds: Stage 1 snapshots FX daily per pair (`snapshot_fx`); feed ids for INR, JPY,
  CAD, CHF, BRL, MXN and SGD are still unverified (Stage 1 U3).
- Report-verifier signatures: Stage 1 verifies **secp256k1** report attestations onchain (SPEC §1.4), not ed25519;
  B.4 of the review.
- Curve buyers' money and the wallet cap: answered (see "The two curve questions" above).
- Devnet and testnet deployments: still missing (blockers above).
