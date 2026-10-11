# Stage 1 defect report: the TypeScript reference simulator under-pays a redeemed holder's final share when part of its units sit in an uncleared transfer-window ask

Reported by the Merces backend team. Stage 1 at commit `1bfc66b` (the same tree as `5eafd41`, SPEC v1.1.2). Our
reference: DIV-S1I-1 in our divergence register. Attached: the missing vector, `vectors/26_final_share_open_ask.json`,
and the script that composes it from vector 22 with Stage 1's own reference simulator
(`packages/stage1-sync/scripts/compose-vector-26.mts` in the Merces repository; it runs from the Merces repository root
with `pnpm exec tsx packages/stage1-sync/scripts/compose-vector-26.mts`).

## Summary

Stage 1's three implementations of `claim_final` disagree on the weight of a holder's final share when the series was
redeemed and then extinguished while some of the holder's units were held in a transfer-window ask that had not cleared.
Both chain programs (Solana and EVM) weigh the share on `redeemed_units + ask_escrow_units`; the TypeScript reference
simulator weighs it on `redeemed_units` alone. Under the reference, the escrowed units' share of the final pool is never
paid to anyone: the holder's `finalClaimed` flag is set by the first claim, and when the window returns the units they are
redeemed at `P_redeem` with a final share of 0. The money stays in the vault for good. The SPEC's §6.1 principle ("units
sitting in a protocol escrow never strand a distribution") and both chains say the escrow must count. No existing parity
vector reaches the case, so the suite does not catch it; the attached vector 26 does.

## The three implementations

All paths are relative to the Stage 1 repository at `1bfc66b`.

| Stack | Where | Weight of the final share after a redemption |
| --- | --- | --- |
| TypeScript reference | `packages/reference/src/sim/simulator.ts:1452-1461` (`claimFinal`): the comment reads "an unredeemed balance is redeemed first (pays P_redeem × balance), then weight = redeemed units"; the code sets `weight = h.redeemedUnits` | `redeemed_units` |
| Solana program | `solana/programs/merces_protocol/src/claims.rs:472-490` (`claim_final`): `let escrow = ctx.accounts.holder.ask_escrow_units;` then, after `redemption_body` for any balance, `redeemed_units.checked_add(escrow)` | `redeemed_units + ask_escrow_units` |
| EVM contract | `evm/src/MercesVault.sol:648-658` (`claimFinal`): `(base, escrow, cleared, ) = _weights(...)`; after `_redemptionBody` for any balance, `weight = uint256(h.redeemedUnits) + escrow`, with the comment "units still in an (uncleared) ask escrow come back later and are redeemed then; they carry their final share now, like every unit that existed at redemption" | `redeemed_units + ask_escrow_units` |

Both chains refuse the claim while the window has *cleared* but the ask is unprocessed (`OutOfOrder`,
`MercesVault.sol:654`; `claims.rs:468`), so the escrow they add is only that of an *uncleared* ask: units that are
certain to come back to the holder.

## What the SPEC says

- `SPEC.md:532` (§6.9, `claim_final`): "weight `w = redemption_ts != 0 ? redeemed_units + unit_balance (after running
  the claim_redemption body for any unredeemed balance, which pays P_redeem × balance) : accrual_units(holder)`". Read
  literally, after the redemption body the holder's `unit_balance` is 0, so `w = redeemed_units`: the reference's
  reading. The sentence does not mention units in an ask escrow at all.
- `SPEC.md:361` (§6.1, accrual weight): "`accrual_units(w) = unit_balance(w) + pending auction units (undelivered, §5.2)
  + ask-escrow units (open or unprocessed window ask, §7)`. Every `settle_holder` uses this weight, so units sitting in a
  protocol escrow never strand a distribution." This is the principle both chains apply to the redeemed branch too.
- `SPEC.md:657` (§12, item 13): "explicit weights, `claim_final` settles unclaimed redemptions first".

So the SPEC states the principle but its §6.9 formula does not spell the escrow term out for the redeemed branch; the
two chains apply the principle, the reference applies the formula's letter. We read the chains as correct: with the
reference's weighting a distribution is stranded, which §6.1 forbids.

## The money consequence (figures from vector 26)

Series S2 of vector 22: 400 units, extinguished right after redemption with 10,500 USDC of unreleased treasury, so the
final pool is 26.25 USDC a unit. Holder `b1` has 100 units: 60 free, 40 in an ask of a window that is still in its
reveal phase (uncleared). `P_redeem` is 118.169358 USDC; `b1` also has 1,805 USDC pending.

| `b1`'s first `claim_final` | Both chains | Reference simulator |
| --- | --- | --- |
| redemption of the 60 free units | 7,090.16148 USDC | 7,090.16148 USDC |
| pending | 1,805 USDC | 1,805 USDC |
| final share | 2,625 USDC (weight 100 = 60 + 40) | 1,575 USDC (weight 60) |
| paid | **11,520.16148 USDC** | **10,470.16148 USDC** |

The window then settles `NoMatch` on the terminal series (as vector 25 shows) and returns the 40 units. `b1`'s second
`claim_final` redeems them at `P_redeem` (4,726.77432 USDC) with a final share of 0 on every stack, because the share was
marked claimed by the first call. End state after every holder has claimed:

| | Both chains | Reference simulator |
| --- | --- | --- |
| `b1`'s total from the final pool | 2,625 USDC (100/400, like `b2`, `b3`, `b4`) | 1,575 USDC |
| vault balance | 0 | 1,050,000,000 base units (1,050 USDC), stranded |

In the vector's `expect` blocks: step #79 `balances.b1.stable` `70310161480` (chains) vs `69260161480` (reference) and
`vault` `53467581720` vs `54517581720`; step #87 `balances.b1.stable` `75036935800` vs `73986935800` and `vault` `0` vs
`1050000000`. Every other field agrees.

## Why the existing vectors do not catch it

No vector has a holder call `claim_final` while its units are still in an uncleared ask of a series that was redeemed and
then extinguished:

- `22_late_holder_tail_final`: both windows are finalized (#77, #85) before the extinguishment (#103) and the final claims
  (#104-#109); no escrow is open at claim time.
- `23_redeem_twice_with_tail`: `b1` parks 40 units in an ask across a redemption (#41, #43) and the window later `NoMatch`es
  (#52), but the series is never extinguished, so there is no final share.
- `25_window_on_terminal`: a window is mid-settlement when S2 is extinguished (#82, #86-#88), and the vector checks the
  `NoMatch` refund; nobody calls `claim_final`.

Vector 26 is vector 22's bootstrap, raises, reports and payments (#0-#70) and S2's window up to its reveals (22's
#79-#83), then `redeem`, `extinguish` and `b1`'s `claim_final` with the ask still open (#76-#78, expect #79), then the
window's `NoMatch` settlement and processing (22's #84-#86) and the remaining `claim_final`s (#83-#86, expect #87).

## Proposed fix

**Reference simulator** (`simulator.ts:1452-1461`): in the redeemed branch add the holder's units held in uncleared asks
of the series to the weight, the same ask-escrow term `accrualUnits` adds for the pre-redemption branch:

```ts
      // an unredeemed balance is redeemed first (pays P_redeem × balance), then the weight is the redeemed units plus
      // the units still held in an uncleared ask: they come back later and are redeemed then (share 0), and carry their
      // final share now, like every unit that existed at redemption (SPEC §6.1; claims.rs, MercesVault.sol)
      if (this.unitsOf(c.actor, s.id) > 0n) this.claimRedemptionBody(s, c.actor);
      h = s.holders.get(c.actor)!;
      weight = h.redeemedUnits + this.askEscrowUnits(s, c.actor);
```

(`askEscrowUnits` being whatever helper the reference uses for the ask-escrow term of `accrualUnits`; the chains also
refuse the claim while the window has cleared and the ask is unprocessed, `OutOfOrder`, which the reference should mirror
if it does not already.)

**SPEC §6.9** (`SPEC.md:532`), proposed wording: "weight `w = redemption_ts != 0 ? redeemed_units + ask_escrow_units
(after running the `claim_redemption` body for any unredeemed balance, which pays `P_redeem × balance`) :
accrual_units(holder)`. Units held in an uncleared ask at the exit carry their final share now and are redeemed at
`P_redeem` with a final share of 0 when the window returns them (§6.1: nothing strands)."

**Vectors**: add `26_final_share_open_ask.json` to `packages/vectors`, regenerated by `packages/reference/src/vectors`
once the reference is fixed (the attached file is composed by hand from 22 and carries both chains' values; its keys are
seeded `26_final_share_open_ask:<name>` as the README prescribes; it is valid against `packages/vectors/schema.json`).

## How we checked the vector

- Schema: valid against `packages/vectors/schema.json` (draft-07, with `22_late_holder_tail_final.json` as the control).
- On our backend, which follows the chains (`pnpm stage1:vectors --vector-file docs/stage1/defects/vectors/26_final_share_open_ask.json --backend merces`):
  `26_final_share_open_ask [merces/solana] PASS 88/88`, `[merces/monad] PASS 88/88`.
- On Stage 1's own reference simulator (`--backend reference`): `NOT OK: 0/1 PASS`, failing at exactly the two expects:
  `#79 balances.b1.stable: expected "70310161480", got "69260161480"`, `vault: expected "53467581720", got "54517581720"`;
  `#87 balances.b1.stable: expected "75036935800", got "73986935800"`, `vault: expected "0", got "1050000000"`.
- Side by side (`--backend lockstep`): the two part right after `b1`'s first `claim_final`, on `b1`'s balance and the vault,
  1,050,000,000 base units apart.

Stage 1's LiteSVM and Foundry harnesses load every file of `packages/vectors`; dropping the attached file there should
replay it against both programs, which we expect to PASS.

## Request

1. Confirm that both chain programs are right and the reference simulator is wrong (or tell us the opposite: we will
   follow Stage 1's decision either way).
2. Fix the reference's `claimFinal` weight and make the SPEC's §6.9 formula explicit about the ask escrow.
3. Add vector 26 to the suite so the case stays covered.

Our backend weighs the share as both chains do (`DIV-S1I-1` in our divergence register, "Stage 1 internal, resolved
toward both chains") and will adopt whatever Stage 1 decides.
