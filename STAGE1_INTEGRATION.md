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
| math | **6 of 11 function families disagree** with Stage 1 (snapshot in `docs/stage1/MATH_PARITY.md`, A-MATH-2): hurdle compounding, late accrual, payout accumulator carry, holder claims, remaining-cap rounding in redemption, auction marginal fill. Stage 1 wins |
| vectors | 25 vectors inventoried, **0 replayed**: every vector settles its auction through `begin_settlement` → `tally_bids` → `finalize_settlement` → `process_bid` → `deliver_bid`, which the canonical model does in one `settleAuction`, and every `expect` compares Stage 1's full state snapshot (snapshot in `docs/stage1/VECTOR_PARITY.md` maps each of the 50 ops) |
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
| Stage 1's own open items | owner decisions H1–H8; S2 curve-redemption residual (A49); the development trusted setup must be replaced before mainnet (A37). Stage 1's documents disagree on S2: `SECURITY_REVIEW.md` says "fix designed, not yet coded" while SPEC v1.1.2 §9, STATUS.md and A49 describe the census fix as built |

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

1. *Auction settlement.* Stage 1: proposer claims (`begin_settlement`), paged `tally_bids`, `finalize_settlement`, then
   per-bid `process_bid` and `deliver_bid`; uniform price with pro-rata marginal fill `floor(R × q / q_at)`; one bid per
   wallet; a bid above the wallet cap is invalid at reveal; 1% non-reveal charge (H1). Ours: one `settleAuction`,
   fill by price then commit order, cap applied at allocation. Proposal: keeper-driven settlement steps and per-bid
   delivery in the model, Stage 1's events (`SettlementProposed/Rejected`, `UnitsAllocated`, `BidDelivered`,
   `NonRevealCharged`), and Stage 1's clearing math.
2. *Transfer window.* Same multi-step shape (`begin_window_settlement`, `tally_orders`, `finalize_window`,
   `process_order`, `deliver_order`, take-back steps), keyed by period rather than a window id, and **windows ship
   disabled** (`windows_enabled = false`, A18): the keepers must not open windows until the admin enables them.
3. *Holder claims.* Stage 1 keeps separate tail and final accumulators with `claim_tail` and `claim_final`, and an
   explicit `register_holder`; ours routes the tail and extinguishment through the payout accumulator. Proposal: add
   `claimTail`, `claimFinal`, `registerHolder` and their events.
4. *Signatures and commitments.* Attestor and report-verifier keys are **secp256k1** (20-byte addresses, 65-byte
   low-s signatures over Stage 1's `MERCES_*_V1` keccak messages bound to a per-deployment domain and per-series
   nonces, SPEC §1.4); ours signs with ed25519 over a different message. Bid and order commitments are keccak over
   packed integers; terms and income commitments are Poseidon; proofs are Groth16 over Stage 1's circuit; ours are
   sha256 over canonical JSON with a mock prover. This touches the report verifier's KMS key type, the device prover,
   the terms vault and the bid flow.
5. *Extinguishment.* Two distinct attestor signatures with a nonce; only unvested proceeds go to holders, vested but
   unclaimed tranches stay with the estate (A31, H4); requires a settled raise.
6. *Missing flows.* Tier-3 true-up (`submit_trueup`, `pay_trueup`), the income router (`init_router`, `route`,
   `close_router_period`), `withdraw_pause_request`, key revocation with a 45-day grace (A33), `retire_if_capped`,
   `resume_issuance`, `request_early_draw`, and the admin surface (`set_flags` with `windows_enabled` and
   `tier4_enabled`, `set_fx_pair`, `set_defaults`, `set_contract_hash`, admin transfer).
7. *Series parameters.* `create_series` carries mode, tier flags, FX pair, release schedule, `k`, hurdle, fee and
   non-reveal bps, lockup and wallet cap, and the terms commitment; ours carries a `terms` object.
8. *Curve mode.* As above: Solana only; no `buyCurve` in Merces (a DBC swap; the backend could still build the
   unsigned Meteora swap); `activate_curve`, `complete_curve`, `collect_curve_proceeds`, `sync_curve_units`,
   staking and tender; no cancel, failure or extinguishment before graduation.
9. *Math.* Replace the six disagreeing families with Stage 1's formulas (or import `@merces/reference`), then
   replay the 25 vectors through a Stage 1 op runner on the simulator with full-state expectations.

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
5. **vectors** — scenario replay through the simulator (`VECTOR_PARITY.md`). Stage 1's own vector directory is
   inventoried op by op against the canonical commands until the Stage 1 op runner exists.
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
