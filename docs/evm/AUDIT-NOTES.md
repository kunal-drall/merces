# EVM audit notes (SPEC v1.1)

For the internal review and external auditors. Scope: `evm/src/**` (Solidity 0.8.30 core, 0.8.17 token
unit), `evm/script/lib/*` (deployment wiring shared with the tests). Out of scope: the vendored T-REX 4.1.6 /
ONCHAINID 2.2.1 / OpenZeppelin 5.6.1 and 4.9.6 sources (unmodified npm packages, `evm/package.json`).
Interpretations and SPEC defects referenced as C-S*/C-* are in `docs/assumptions/track-c.md`.

## 1. Architecture in one paragraph

`MercesRegistry` (immutable, admin-configured) holds every charter field and the registries; it fixes the
seven protocol contracts in its constructor. The money contracts (`MercesAuction`, `MercesTreasury`,
`MercesIncome`, `MercesRouter`, `MercesFxAccumulator`, `MercesVault`, `MercesWindow`) are UUPS proxies owned
by a `TimelockController`; they share no storage, resolve each other through the registry and call each
other only through narrow, caller-checked entry points (`_requireCaller`). Each sealed-bid series gets a
T-REX `Token` whose only transfer rule is `MercesComplianceModule` and whose owner is `MercesTokenGovernor`, a
contract with no functions: agents are fixed to {auction, vault, window} at creation, so nobody can mint,
burn, freeze, force-transfer, pause or recover units outside the protocol paths.

## 2. Roles and hard limits (SPEC §2) — where each is enforced and tested

| Role | Can | Can never | Enforcement / tests |
| --- | --- | --- | --- |
| Admin (registry `admin`) | keys, flags, defaults for future series, FX pairs, stablecoin allowlist, issuer set | touch a live series' terms, move funds, block redeem/claim/release, change an existing series' fees | registry has no per-series setter but `amendTerms` (issuer + attestor, cap down only); money paths check callers; `test/charter/Charter.t.sol` §1, §5, §7; invariant `adminAction` (balances, ledgers and supply snapshotted around every admin call) |
| Timelock (owner of proxies, T-REX IAs, fee collector) | upgrade money code after the delay; `setGroth16Verifier`, `setPyth`; withdraw fees | reach the registry (no upgrade path, C11 §7) | `test_C11_7_charterFieldsHaveNoUpgradePath` (ERC-1967 slot empty, upgrade through the timelock leaves terms bit-identical) |
| Allowlist manager | eligibility | freeze/seize units, block claims | identities never deleted; claims need registration only; invariants flag any claim / window step / release blocked by an allowlist change |
| Attestor / verifier key | sign §1.4 messages | move funds | signatures only gate reports, amendments, pauses, FX fallback, true-ups, extinguishment (two distinct keys) |
| Keeper | permissionless cranks | send value anywhere but its owner | `claimFor`, `deliverBid`, `processOrder`, `withdrawOwed` pay the owner only |
| Issuer | raise, releases, reports, payments, pauses, redemption, own issuance switch | change live terms except favourable amendments | `NotIssuer` guards; no function can pull the issuer's money except its own transaction (`test_C11_3_noFunctionCanForceAPayment`: unlimited allowances to every contract, nothing moves) |

## 3. Money flows

Every stablecoin pull is `safeTransferFrom(msg.sender, …)`: `commitBid` (auction, window), `pay`, `payTrueUp`,
`route`, `redeem`. Every push goes to its owner: refunds and units (`deliverBid`), proceeds into the treasury
(`processBid`), releases to the issuer, fees to the registry's fee collector, payouts to holders, window
proceeds/refunds (deferred to `owed` on a recipient-side failure, C-S3), cap refunds to the issuer. The only
cross-contract fund move is `moveUnreleasedToVault` (vault-only, at extinguishment). Invariants checked after
every fuzzed call (`test/invariant/`):

- refunds + proceeds + fees + auction balance == Σ escrow (exact); auction balance == its ledger;
- treasury balance == deposited − released − moved; releases ≤ vested(now) and all reach the issuer;
- vault balance == gross − fee + tail gross − tail fee + redemption deposit + unreleased − claimed (exact);
  vault balance ≥ Σ (pending + tail + final + redemption owed), with only rounding dust in excess outside a
  half-processed window (stranded-value check);
- every payment == accepted + refunded to the issuer; fee collector == auction + payout + tail + window fees;
- paid per unit + redemption price + tail per unit ≤ cap per unit;
- Σ unit balances + window escrow == supply == `units_outstanding`; balances change only through the window,
  burns and redemption; no direct transfer, forced transfer, privileged burn/mint, freeze or pause succeeds;
- each window: escrow == bid escrow in − fees − refunds − seller proceeds; charter fields frozen.

## 4. Reentrancy, external calls, token assumptions

- Every token-moving external function is `nonReentrant` (OZ 5 `ReentrancyGuard`, ERC-7201 slot, safe in
  proxies) and follows checks-effects-interactions; ledgers are written before transfers.
- External calls: the stablecoin (SafeERC20), the T-REX token (only `transfer`/`transferFrom`/`mint`/`burn`
  by the protocol agents; returns checked), sibling protocol contracts, Pyth / Chainlink (views), the
  early-draw approver (view, only when configured), Poseidon and the Groth16 verifier (views).
- Stablecoin assumptions: a standard ERC-20 with 6 decimals as allowlisted by the admin; **no fee-on-transfer
  or rebasing tokens** (accounting assumes received == sent). A token that blocks a recipient makes that
  recipient's own pull fail; in the window such pushes are deferred so others are unaffected (C-S3).
- `MercesComplianceModule` arms a transient `armedDeposit(from) = units` immediately before the window's
  `transferFrom` and clears it after, so the only accepted deposit into the window is the commit's own.

## 5. Signatures and replay

`domain = keccak256(0x02 ‖ chain_id ‖ registry)` separates chains and deployments; every message carries a
magic string (purpose), the series key and, where repeatable, a nonce (`amendment_nonce`, `pause_nonce`,
`extinguish_nonce`, `trueup_nonce`) that advances on use or on a superseding request. Raw digests, low-`s`
enforced by OZ `ECDSA.tryRecover`; malformed signatures recover to an unregistered address. Two distinct
attestors are required for extinguishment (`SameAttestor`). Key revocation is forward-only with a grace
window for periods that ended before the revocation (SPEC §1.4).

## 6. Oracles

Pyth: daily snapshots with `fx_max_staleness_seconds` and `fx_max_conf_bps` checks (`StalePrice`,
exponent bounds `UnsupportedExponent`), quarter average valid only with ≥ `fx_min_coverage_bps` coverage,
attestor-signed fallback otherwise. Chainlink cross-check: a deviation beyond `fx_deviation_band_bps` flags
the period (fallback required); a stale or broken cross-check flags nothing (C-11). Cross-check changes take
effect from the next period so a live quarter's rule never changes.

## 7. ZK verifier

`Groth16Verifier` is generated by snarkjs from the **development** ceremony (`circuits/README.md`): not for
production. Public inputs are bound in SPEC §8 order; tier-1 reports additionally bind the income
commitment to the router's Poseidon(2) checkpoints. Gas: `docs/evm/MEASUREMENTS.md`.

## 8. Upgradeability

UUPS (OZ 5.6.1), `_authorizeUpgrade` = `onlyOwner` (the timelock), implementations call
`_disableInitializers()` in their constructor, storage in ERC-7201 namespaces (`merces.storage.*`). The
registry, fee collector, token factory, compliance module and governor are not upgradeable; T-REX token and
compliance implementations change only through the timelock-owned implementation authority.

## 9. Bounds (gas / DoS)

`max_bids_per_auction = 4096`, `MAX_ORDERS_PER_WINDOW = 4096`, tally pages ≤ 200, ≤ 24 release tranches,
≤ 16 pauses, the redemption average looks at ≤ 3 `year_gross` slots (4-slot ring). No function loops over
holders; settlement is paged; processing is per bid / per order. A 4096-bid auction settles end to end in
the unit suite (`test_maxBidsPerAuction`).

## 10. Rounding

All divisions floor toward the protocol: holders' entitlements floor at each settle (< 1 base unit per
settle stays in the vault), the accumulators keep exact WAD carries (C-S1), auction marginal allocations
floor (`R` vs `alloc_sum` exact), cap truncation floors the accepted amount and refunds the rest to the
issuer, redemption `C_rem` uses `ceil(paid)` so payments + redemption + tail never exceed the cap.

## 11. Things to look at first

1. `MercesVault._receiveMain` / `_applyCap` / `_accumulate` and `_settle` with the window snapshot (C-S4) and
   `creditWindowAccrual`.
2. `MercesAuction.finalizeSettlement` (claims vs tally, uniqueness of the clearing price — fuzzed in
   `test/fuzz/AuctionFuzz.t.sol`) and `processBid` / `deliverBid`.
3. `MercesWindow.finalizeWindow` (two branches, uniqueness fuzzed in `WindowFuzz`), `_askFill` take-back with
   the keeper price index (C-S2), deferred pushes (C-S3).
4. `MercesIncome._derive` / `_isLateUnderlying` / pause arithmetic and the release block.
5. `MercesComplianceModule.moduleCheck` and the armed deposit.
6. `MercesRegistry.amendTerms` and the absence of any other per-series write after `markRaiseOpened`.
7. `script/lib/MercesDeploy.sol`: registry address prediction, ownership hand-offs.

## 12. Accepted risks and open points

- C-4: the timelock can replace the Groth16 verifier and the Pyth address (upgrade-equivalent, same delay).
- C-5: an admin can make a reporting tier unusable for future periods (key revocation, `tier4_enabled`);
  releases, claims and redemption are never admin-gated. An issuer with only that tier would fall Late.
- C-S12: T-REX `canTransfer` reverts instead of returning false for forbidden transfers.
- C-S4 divergence from the reference when a payout lands between window clearing and processing.
- Development trusted setup; mock stablecoin and mock Pyth only in local deployments.
