# Interfaces

The stable call and type surface of Stage 1, for the Stage 2 backend and integrators. Equivalent operations carry
the same name on both chains; the per-stack detail (account lists on Solana, function signatures and modifiers on
EVM) and the machine-readable interfaces live in:

- **Solana:** `docs/solana/INTERFACES.md`; IDLs and TypeScript types in `solana/idls/` (`merces_registry`, `merces_protocol`, `merces_hook`, `mock_usdg_hook`).
- **EVM:** `docs/evm/INTERFACES.md`; ABIs in `evm/abis/` (28 files).
- **Events** (identical fields both chains): `EVENTS.md`, `docs/solana/EVENTS.md`, `docs/evm/EVENTS.md`.
- **Signed-message and commitment encodings:** `SPEC.md` §1.3–§1.5; reference helpers in `packages/sdk` (`commitments.ts`, `messages.ts`, `periods.ts`, `errors.ts`).

The authoritative semantics are `SPEC.md`; this file is the map, not the source of truth.

## Program and contract layout

| Module (brief) | Solana program · instruction prefix | EVM contract |
| --- | --- | --- |
| D1 charter & terms, D11 registries, fee-collector config, protocol config | `merces_registry` (immutable) | `MercesRegistry` (non-upgradeable) |
| D2 unit token | Token-2022 mint per series + `merces_hook` transfer hook | T-REX `Token` per series + `MercesComplianceModule`, deployed by `MercesTokenFactory`, owned by `MercesTokenGovernor` |
| D3 auction | `merces_protocol` (raise) | `MercesAuction` |
| D4 treasury | `merces_protocol` (treasury) | `MercesTreasury` |
| D5 split router | `merces_protocol` (router) | `MercesRouter` + `MercesRouterReceiver` |
| D6 ProofOfIncome verifier + C9 rate accumulator | `merces_protocol` (income, fx) + `src/zk` | `MercesIncome` + `MercesFxAccumulator` + `Groth16Verifier` |
| D7 payout vault | `merces_protocol` (claims) | `MercesVault` (claims behind `IPayoutClaims`) |
| D8 redemption / tail / pause / extinguishment | `merces_protocol` (exit) | `MercesVault` (exit) |
| D9 transfer window | `merces_protocol` (window) | `MercesWindow` |
| D10 curve mode (Solana only) | `merces_protocol` (curve) | — |
| Fee collector | token accounts of the fee-collector authority | `FeeCollector` (pull-only) |
| Governance | program upgrade authority = multisig+timelock | `TimelockController` owns the UUPS proxies and the T-REX implementation authority |

Program IDs (devnet-reproducible keys, `solana/keys/`): see `solana/Anchor.toml`. EVM addresses are per-deployment, written to `evm/deployments/<chain>.json`.

## Operations by actor (names identical on both chains)

**Protocol admin (registry):** `init_protocol`, `set_allowlist_manager`, `set_fee_collector`, `set_flags`, `set_early_draw_approver`, `set_defaults`, `register_attestor` / `revoke_attestor`, `register_verifier_key` / `revoke_verifier_key`, `set_fx_pair` / `set_fx_crosscheck` / `set_fx_pair_enabled`, `register_issuer` / `deactivate_issuer`, `transfer_admin` / `accept_admin`.

**Allowlist manager (registry):** `set_allowed`.

**Issuer (registry):** `create_series`, `set_contract_hash`, `stop_issuance` / `resume_issuance`, `amend_terms`. **(protocol):** `open_raise` / `cancel_raise`, `claim_release`, `set_release_pause`, `request_early_draw`, `submit_report`, `pay`, `submit_trueup` / `pay_trueup`, `request_pause` / `withdraw_pause_request` / `end_pause`, `redeem`. Curve (Solana): `prepare_curve` / `activate_curve`.

**Backer / holder (protocol):** `commit_bid`, `reveal_bid`, `claim`, `claim_redemption`, `claim_tail`, `claim_final`; window `commit_bid` / `commit_ask`, `reveal_order`; curve `stake_units` / `unstake_units` / `tender_units`.

**Keeper — permissionless (protocol):** `begin_settlement`, `tally_bids`, `finalize_settlement`, `process_bid`, `deliver_bid`; `crank_status`, `retire_if_capped`, `register_holder`, `burn_retired`; `approve_pause` (carries the attestor signature); `route` / `sweep` / `close_router_period`, `init_fx_pair` / `snapshot_fx`; `extinguish` (carries two attestor signatures); window `open_window`, `begin_window_settlement`, `tally_orders`, `finalize_window`, `process_order`, `deliver_order`, and the take-back trio (`begin_takeback` / `tally_takeback` / `finalize_takeback` on Solana, a verified price index on EVM); curve `complete_curve`, `sync_curve_units`, `collect_curve_proceeds`.

**Registry write interface — protocol only:** `mark_raise_opened`, `mark_raise_result`, `mark_mint_finalized`, `mark_curve_activated`, `mark_terminal`.

## ProofOfIncome report payload (D6, SPEC §6.2)

`submit_report(series, period, payment_usd, fx_avg_wad, fx_fallback_sig?, prior_income_commitment, income_commitment, tier, liquidity_event, proof, attestation_sig?)`. Groth16 public inputs, in order: `[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]` (circuit in `circuits/src/report.circom`, 3,432 constraints; verifying key `circuits/build/verification_key.json`, generated verifiers `evm/src/zk/Groth16Verifier.sol` and `solana/programs/merces_protocol/src/zk/vk.rs`). Proof byte encodings per chain: `docs/assumptions/track-a.md` A-5 and `circuits/README.md`.

## Signed messages (secp256k1, SPEC §1.4)

`MERCES_REPORT_V1`, `MERCES_FX_V1`, `MERCES_AMEND_V1`, `MERCES_PAUSE_V1`, `MERCES_EXTINGUISH_V1`, `MERCES_TRUEUP_V1`. Byte-exact pre-images and known-answer hashes for a Solana and an EVM test domain: `packages/vectors/known_answers.json`. Encoders: `packages/sdk/src/messages.ts`.

## Error names

Canonical list with one-line meanings: `packages/sdk/src/errors.ts` (and `ERROR_ALIASES` for the v1.0 → v1.1 renames). The parity vectors' `expect_revert` steps use these names; each chain maps them to its own codes (`solana/tests/src/vectors.rs::codes_for`, EVM custom errors).
