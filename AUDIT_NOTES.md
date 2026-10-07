# Audit notes

For the internal security review and the external auditors who come later. Sections marked *(filled by the tracks)*
are completed from `docs/solana/AUDIT-NOTES.md`, `docs/evm/AUDIT-NOTES.md` and the measurement files once the
implementation lands; see `SECURITY_REVIEW.md` for the review findings and their fixes.

## 1. Trust assumptions

| Actor | Trusted for | Not trusted for |
| --- | --- | --- |
| Protocol admin (multisig + timelock) | Correct registration of attestor and verifier keys; honest default parameters for *future* series; pausing new raises; upgrading money code after the delay | Any live series' terms; treasury, vault or escrow funds; blocking redemption, claims or releases |
| Allowlist manager | Eligibility decisions | Freezing or seizing units; blocking claims (claims need registration, not current allowlist membership) |
| Attestors (CPAs) | Honest signatures on tier-3 reports, favourable amendments, hardship pauses, FX fallback rates, extinguishment (two needed) | Moving funds; setting tier-1/2 amounts |
| Stage 2 verifier service | Correctly checking Reclaim zkTLS proofs off-chain and signing the income commitment | Anything else; its key can be revoked by the admin |
| Pyth | Daily FX rates (staleness and confidence checked; Chainlink cross-check on EVM; 80 % coverage rule; attestor fallback) | — |
| Keepers | Nothing: every keeper action is permissionless and either fails verification or pushes value only to its rightful owner | — |
| Issuer | Nothing beyond their own money: they can only pay, report (with proof), draw vested funds, request pauses and redeem | — |
| Upgrade authority (money code) | Delayed upgrades | The registry and the hook have no upgrade authority |

## 2. Privileged roles and what each can touch

See `SPEC.md` §2 and `ARCHITECTURE.md` §1. Tests under `evm/test/charter/` and `solana/tests/src/charter*` assert
each "can never" row.

## 3. Known limitations (by design)

- Min-raise test uses the proceeds upper bound (`ASSUMPTIONS.md` A12).
- One bid per wallet per auction and per window (A11).
- Partial payments are not supported; `pay` pulls the full due plus accrual (A13).
- Curve-mode holders must claim before selling on DAMM v2 (`ARCHITECTURE.md` §4).
- Window rounding dust returns to the asks at the clearing price in descending reveal order; those sellers keep up
  to a few units unsold.
- Tier-4 reports are disabled by flag; tier-1 series expose θ and r in the router by the issuer's choice.
- Development trusted setup for the circuit: **not for production**.

## 4. Things an auditor should look at first

1. Vault accounting (`vault_receive_gross`): cap truncation, carry, fee and the ordering of effects before transfers.
2. Auction finalize: the one-pass clearing-price verification (`ARCHITECTURE.md` §5.1) and per-bid claims.
3. Window finalize: the crossing condition and dust return (`ARCHITECTURE.md` §5.2).
4. Status derivation and the effective clock (`SPEC.md` §6.4), especially interactions between pauses, lateness
   and release blocking.
5. Hook / compliance rule: the only allowed transfers are window escrow movements.
6. Signature domains and nonces (`SPEC.md` §1.4): replay across chains, series and purposes.
7. Token-2022 handling of USDG: transfer-hook account resolution and the zero-fee assertion.
8. Registry write interface: only the protocol program/contracts can mark raise results and terminal statuses.
9. Upgrade wiring: timelock ownership of UUPS proxies and the T-REX implementation authority; registry has none.

## 5. Measurements *(filled by the tracks)*

Compute units (Solana) and gas (EVM) for: tally page, finalize, verify report, pay, claim, window fill, FX snapshot.
See `docs/solana/MEASUREMENTS.md` and `docs/evm/MEASUREMENTS.md`.
