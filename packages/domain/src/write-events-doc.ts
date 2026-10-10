/**
 * Generates DOMAIN_EVENTS.md from the zod sources so the document can never drift from the code.
 * Run: pnpm docs:events   (CI checks the committed file is current)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { commandGroups } from './commands.ts';
import { amountBearingEvents, eventPayloads } from './events.ts';

function fields(schema: z.ZodTypeAny): string[] {
  const js = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as { properties?: Record<string, unknown>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([k, v]) => {
    const t = describe(v as Record<string, unknown>);
    const req = (js.required ?? []).includes(k) ? '' : '?';
    return `\`${k}${req}\`: ${t}`;
  });
}
function describe(v: Record<string, unknown>): string {
  if (v.enum) return (v.enum as unknown[]).map((x) => `\`${String(x)}\``).join(' \\| ');
  if (v.const !== undefined) return `\`${String(v.const)}\``;
  if (v.anyOf) return (v.anyOf as Record<string, unknown>[]).map(describe).join(' \\| ');
  if (v.oneOf) return (v.oneOf as Record<string, unknown>[]).map(describe).join(' \\| ');
  if (v.type === 'array') return `array of ${describe((v.items as Record<string, unknown>) ?? {})}`;
  if (v.type === 'object') return 'object { ' + Object.entries((v.properties as Record<string, Record<string, unknown>>) ?? {}).map(([k, x]) => `${k}: ${describe(x)}`).join(', ') + ' }';
  if (v.pattern === '^\\d+$') return 'decimal string (base units / WAD / units)';
  if (v.pattern === '^\\d{1,78}$') return 'decimal string (field element)';
  if (v.pattern === '^0x[0-9a-f]{64}$') return 'hex32';
  if (v.pattern === '^\\d{4}Q[1-4]$') return 'period id (YYYYQn)';
  if (v.pattern === '^[A-Z]{3}\\/[A-Z]{3}$') return 'pair (XXX/USD)';
  if (Array.isArray(v.type)) return (v.type as string[]).join(' \\| ');
  return String(v.type ?? 'unknown');
}

const lines: string[] = [];
lines.push('# DOMAIN_EVENTS.md — canonical domain model v0', '');
lines.push('Generated from `packages/domain/src/{events,commands}.ts` by `pnpm docs:events`; the machine-readable form is `packages/domain/schema/domain-v0.schema.json` (JSON Schema 2020-12). Live adapters map whatever Stage 1 emits and accepts onto exactly these shapes; differences are recorded in `INTERFACE_DRIFT.md` by `stage1:sync`, never papered over.', '');
lines.push('## Conventions', '', '- Identifiers are chain-neutral strings: `seriesId = "<chain>:<address>"`, `issuerId = "<chain>:<address>"`. EVM addresses are lowercase; Solana addresses are base58.', '- Money is a decimal string in stablecoin base units (6 decimals for USDC and USDG, verified from the mint). Ratios are decimal strings in 1e18 fixed point (WAD). Unit counts are decimal strings. Never floating point.', '- Timestamps are unix seconds. Periods are calendar quarters in UTC, written `YYYYQn`.', '- Every event is wrapped in an envelope: `chain`, `cursor` (opaque, ordered within a chain), `seq` (monotonic per chain), `blockTime`, `blockRef`, `txId`, `finality` (`finalized` | `confirmed`), `type`, `payload`. Only `finalized` events reach money-bearing read models.', '- Events marked **amount-bearing** never appear in the public activity feed with amounts (R28).', '');
lines.push('## Events', '');
for (const [name, schema] of Object.entries(eventPayloads)) {
  lines.push(`### ${name}${amountBearingEvents.has(name as never) ? ' (amount-bearing)' : ''}`, '');
  for (const f of fields(schema)) lines.push(`- ${f}`);
  lines.push('');
}
lines.push('## Commands', '', 'User commands are built into unsigned transactions for the user\'s wallet (`ChainPort.build`). Service commands are submitted by the backend\'s own low-privilege roles (`ChainPort.submit` as `keeper` or `allowlistManager`). Permissionless commands (Stage 1\'s sealed-bid settlement, holder registration and the Retired burn) may be sent by anyone: the keeper submits them (`ChainPort.submit`) and any wallet may build and sign them (`ChainPort.build`). Admin commands are built for the protocol multisig. The router command is posted by a registered tier-1 split router contract.', '');
for (const { title, commands: group } of commandGroups) {
  lines.push(`### ${title}`, '');
  for (const [name, schema] of Object.entries(group)) {
    const fs = fields(schema as z.ZodTypeAny).filter((f) => !f.startsWith('`kind`'));
    lines.push(`- **${name}**${fs.length ? ': ' + fs.join('; ') : ''}`);
  }
  lines.push('');
}
lines.push('## Additions beyond the Part D2 list', '', '- Events: `IssuanceStopped` (C11.5), `VerifierKeyRegistered` (admin registers report-verifier keys); Stage 1\'s settlement events with Stage 1\'s names (S2): `SettlementProposed`, `SettlementRejected`, `UnitsAllocated`, `BidDelivered`, `RaiseMintFinalized`, `HolderRegistered`; Stage 1\'s claim events (S3): `TailClaimed`, `FinalClaimed`; Stage 1\'s curve events (S3): `CurveActivated`, `CurveProceedsCollected`.', '- Commands: `registerIssuer`, `stopIssuance`, `pauseReleases` (the issuer\'s own pause, C11.1), `crankPause`, `flagFxFallback`, `clearTransferWindow`, `commitWindowOrder`, `revealWindowOrder`, `curveSwap` (a Meteora DBC swap on live chains, not a Merces instruction), `registerVerifierKey`, `pauseNewRaises`, `setFeeCollector`, `registerSplitRouter`, `postSplitReceipt`; the permissionless group with Stage 1\'s names (S2); Stage 1\'s claims `claimTail` and `claimFinal`, the permissionless `burnRetired`, and a curve\'s permissionless `completeCurve` and `collectCurveProceeds` (S3).', '- Each addition closes a gap between the D2 list and Part C; Stage 1 wins on names and shapes, recorded in `INTERFACE_DRIFT.md`.', '');
lines.push(
  '## Meanings on Stage 1 (since S1)',
  '',
  'The shapes above are generated; these meanings changed in S1, when the simulator moved to Stage 1\'s rules (SPEC v1.1.2; Stage 1 wins for onchain behaviour). `ASSUMPTIONS.md` and `STAGE1_INTEGRATION.md` carry the details and the divergences still open.',
  '',
  '- **Errors.** Every `ChainError` raised on a Stage 1 path carries `detail.stage1`, Stage 1\'s error name (SPEC §11); the API returns it with the error.',
  '- **Sealed-bid settlement (S2).** Stage 1\'s multi-step settlement with its names: `beginSettlement` proposes a clearing price with the proposer\'s tally claims (`SettlementProposed`; the raise is `Settling`), `tallyBids` tallies pages of revealed bids (at most `ChainInfo.limits.tallyPageMax` each), `finalizeSettlement` settles (`AuctionSettled`), fails (`AuctionFailed`: NoValidBids, or MinRaise with the would-be price, units and proceeds) or rejects the round (`SettlementRejected`, and a new round may be proposed), `processBid` moves each bid\'s cost and fee to protocol accounts (`UnitsAllocated` for a winner; the last one finalises the mint, `RaiseMintFinalized`) and `deliverBid` pays the bidder its units and refund (`BidDelivered`). `registerHolder` registers an allowlisted wallet as a holder; `HolderRegistered` marks any wallet\'s first registration (by `registerHolder`, a winning `processBid` or a window purchase). Anyone may send them; `nextSettlementStep` plans them from the stored raise state (`AuctionState.raiseState`). A raise that would sell 0 units fails (MinRaise), as SPEC and both chains do. `BidRevealed.valid` records the validity Stage 1 fixes at reveal (an invalid bid is refunded in full). `AuctionSettled` carries Stage 1\'s RaiseSettled fields only: each winner\'s fee and cost move when it is processed (`FeeTaken{kind: auction}` and `TreasuryFunded` per winner). There is no one-step settlement and no pull refund: a bid\'s refund and units are pushed by `deliverBid` (the keepers deliver every bid; any wallet may deliver one), and no Merces event mints units on a curve (a curve trade is Meteora\'s). The non-reveal charge is an owner hold: no event or fee kind exists for it until the hold is lifted (`NON_REVEAL_CHARGE_HELD`).',
  '- **Raise phases and `openRaise` (S2).** `commitDurationSeconds` and `revealDurationSeconds` are series terms (Stage 1 bounds a sealed raise to 1 hour–30 days and 1 hour–7 days); `openRaise` takes the series only and sets the commit end to now + the commit duration and the reveal end to the commit end + the reveal duration (Stage 1 `open_raise`). `nonRevealChargeBps` is recorded at creation (0–1,000 bps on a sealed raise), but the charge is an owner hold: new series record 0, and 0 applies whatever a series records (`NON_REVEAL_CHARGE_HELD`).',
  '- **`SeriesTerms` deadlines.** Counted in unpaused time from the period end: OnTime while the countdown is ≤ `dueDays`, InGrace while ≤ `dueDays + graceDays`, then Late (inclusive bounds). `formalNoticeDays` counts from the **period end** (Stage 1 `formalNoticeDue`; 90 = period end + 90 days).',
  '- **`submitReport`.** Reports are strictly sequential (the next expected period, once ended, with no unpaid due). `priorIncomeCommitment` is the income commitment the report chains from (the previous quarter\'s in the same year; ZERO at a year start; a series\' first report outside Q1 supplies its own, bound only by the attestation, Stage 1 A25); the chain checks the proof against the series\' live terms commitment, so the command carries none. `proof` is Stage 1\'s Groth16 proof (`groth16-bn254`) or, only on a simulator configured for it, the mock digest; either way with Stage 1\'s six public inputs `[terms_commitment, units_outstanding, fx_avg_wad, prior_income_commitment, income_commitment, payment_usd]`. Commitments are Stage 1\'s Poseidon: terms over (θ, r, currency code, indexing rule, salt), income over (year-to-date figure, salt).',
  '- **Verifier attestation (tier 2).** Attestation v1 over series, period, prior and income commitments, tier and `liquidityEvent`; never the income source.',
  '- **`ReportAccepted`.** `paymentDue` is the due the report opened (the payment less tier-1 split credit; 0 for a tail report that is not a liquidity event), without accrual; `accrual` is always "0"; `priorIncomeCommitment` is the commitment it chained from.',
  '- **`payIn` and `PaymentReceived`.** `payIn` pays the open due in full: `periodId` names the open due period and `amount` is the due plus Stage 1\'s lateness accrual when the payment lands; anyone may pay (NothingDue when nothing is open). `PaymentReceived.gross` is what the vault accepted; from a pay-in it carries the final `paymentDue` (due + accrual) and `accrual`; `source: \'tail\'` is a tail payment (its own accumulator, outside the payout vault totals); `source: \'extinguishment\'` is the unvested treasury returned through the final pool (fee 0, not an issuer payment).',
  '- **Pauses.** `requestPause.until` and `PauseRequested.until` are advisory (Stage 1\'s request has no end); `approvePause` sets the pause end within Stage 1\'s bounds, and a pause ends by itself at that end.',
  '- **Claims (S3: Stage 1\'s claim family).** Every stablecoin amount a claim moves appears in exactly one event amount: `PayoutClaimed` (the net payout; inside a redemption, the pending payout and the tail catch-up), `RedemptionClaimed` (the redemption principal, units × price), `TailClaimed` (the tail), `FinalClaimed` (the pending payout and the final-pool share) and `BidDelivered` (a delivered refund). Claims need a registered holder (HolderNotRegistered), never current allowlist membership. A claim of nothing emits its own event with zeros (`PayoutClaimed{0, burned}`, `TailClaimed{0}`, `FinalClaimed{units, 0}`); the split-out `PayoutClaimed` inside a redemption appears only above 0. The read model never creates a position from a claim and records no money row for a zero amount.',
  '- **`claimPayout`.** Stage 1 `claim`: the net payout (the holder\'s pending payout) and nothing else, on every status; the tail is `claimTail`\'s and the final-pool share `claimFinal`\'s. HolderNotRegistered for a wallet that is not a registered holder. It always emits `PayoutClaimed{amount, burnedUnits}`, zeros included (SPEC\'s zero-amount rule: a claim of nothing succeeds and emits its event). On a Retired series the holder\'s balance burns, also when nothing is paid (`burnedUnits`, then `UnitsBurned{reason: cap}`); on any other status nothing burns (an Extinguished holder\'s units are its final-pool weight and burn at `claimFinal`). Inside a redemption, `PayoutClaimed` carries the pending payout and the tail catch-up with `burnedUnits` 0, and is emitted only above 0.',
  '- **`claimTail`.** Stage 1 `claim_tail`: NotRedeemed until the issuer redeemed (the redemption time only, not the status); HolderNotRegistered; a holder that has redeemed nothing and still has units is redeemed first (the redemption body: `PayoutClaimed`, `UnitsBurned`, `RedemptionClaimed`); NoRedeemedUnits when it has still redeemed nothing (a holder registered late with no units). It pays the tail on its redeemed units since its tail cursor and emits `TailClaimed{amount}`, the tail only, also when it is 0.',
  '- **`claimFinal`.** Stage 1 `claim_final`: TerminalStatus unless the series is Extinguished; a pending auction bid is delivered first; HolderNotRegistered. On a series that redeemed, the holder\'s remaining units are redeemed first and its share is weighed on its redeemed units; otherwise on its accrual units (undelivered auction units and window-ask units included). It pays the pending payout plus the share (the share once: a second claim pays 0) and emits `FinalClaimed{units: weight, amount}`, also with zeros, then burns the holder\'s balance (`UnitsBurned{reason: extinguishment}`).',
  '- **`burnRetired`.** Stage 1 `burn_retired`, permissionless (any wallet or the keeper): TerminalStatus unless the stored status is Retired; a wallet holding no units gives `UnitsBurned{units: 0}` before any registration check, also a wallet that never held units; otherwise HolderNotRegistered, then the holder is settled (its pending payout stays claimable) and its balance burns. It is the only burn command (the keepers send one per holder that still holds units).',
  '- **`extinguish`.** Refused unless the raise settled (RaiseNotSettled); only the unvested treasury returns to holders, and the issuer\'s estate may still draw the vested tranches.',
  '- **Curve mode (S3: Stage 1\'s curve lifecycle; Solana only).** A curve series\' units are base lamports (`SeriesState.unitScale` 10^6); prices stay per whole unit. `createSeries` is the curve\'s activation: P0 = floor(X × 10^6 / swap base) must be at least 1 (CurveThresholdMismatch), then NewRaisesPaused and the issuer\'s allowlist; it emits `CurveActivated{unitsSold, issuePrice: P0}` and `RaiseOpened{0, 0}`, and the raise is Open. `curveSwap` trades on the curve\'s venue (Meteora\'s DBC on live chains; a labelled stand-in in the simulator until S5): no allowlist, no cap, no Merces event; the money sits in the pool, never in the treasury. `completeCurve` (permissionless; CurveNotComplete until the pool filled) settles at the pool\'s finish time with the P0 and units fixed at activation (`CurveGraduated`, Stage 1 `RaiseSettled` with proceeds 0, and `RaiseMintFinalized{proceeds: 0}`); it takes no census and registers nobody. `collectCurveProceeds` (permissionless, idempotent) moves the partner migration fee and surplus into the treasury and the partner trading fee to the fee collector (`CurveProceedsCollected`, `TreasuryFunded`, `FeeTaken{curveTrading}`). On a curve series the sealed-bid paths refuse with NotSealedBid (the raise, the settlement steps, the window, no cancel), `claimRedemption` with CurveUsesTender and `burnRetired` with CurveModeNoBurn; nothing burns and only staked units earn.',
  '',
);
const out = fileURLToPath(new URL('../../../DOMAIN_EVENTS.md', import.meta.url));
writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out}`);
