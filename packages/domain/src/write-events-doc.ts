/**
 * Generates DOMAIN_EVENTS.md from the zod sources so the document can never drift from the code.
 * Run: pnpm docs:events   (CI checks the committed file is current)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { adminCommands, routerCommands, serviceCommands, userCommands } from './commands.ts';
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
  if (v.type === 'array') return `array of ${describe((v.items as Record<string, unknown>) ?? {})}`;
  if (v.type === 'object') return 'object { ' + Object.entries((v.properties as Record<string, Record<string, unknown>>) ?? {}).map(([k, x]) => `${k}: ${describe(x)}`).join(', ') + ' }';
  if (v.pattern === '^\\d+$') return 'decimal string (base units / WAD / units)';
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
lines.push('## Commands', '', 'User commands are built into unsigned transactions for the user\'s wallet (`ChainPort.build`). Service commands are submitted by the backend\'s own low-privilege roles (`ChainPort.submit` as `keeper` or `allowlistManager`). Admin commands are built for the protocol multisig. The router command is posted by a registered tier-1 split router contract.', '');
for (const [title, group] of [['User commands', userCommands], ['Service commands (keeper / allowlist manager)', serviceCommands], ['Admin commands (multisig)', adminCommands], ['Router commands', routerCommands]] as const) {
  lines.push(`### ${title}`, '');
  for (const [name, schema] of Object.entries(group)) {
    const fs = fields(schema as z.ZodTypeAny).filter((f) => !f.startsWith('`kind`'));
    lines.push(`- **${name}**${fs.length ? ': ' + fs.join('; ') : ''}`);
  }
  lines.push('');
}
lines.push('## Additions beyond the Part D2 list', '', '- Events: `IssuanceStopped` (C11.5), `VerifierKeyRegistered` (admin registers report-verifier keys).', '- Commands: `registerIssuer`, `stopIssuance`, `pauseReleases` (the issuer\'s own pause, C11.1), `crankPause`, `flagFxFallback`, `clearTransferWindow`, `commitWindowOrder`, `revealWindowOrder`, `buyCurve`, `graduateCurve`, `registerVerifierKey`, `pauseNewRaises`, `setFeeCollector`, `registerSplitRouter`, `postSplitReceipt`.', '- Each addition closes a gap between the D2 list and Part C; Stage 1 wins on names and shapes, recorded in `INTERFACE_DRIFT.md`.', '');
const out = fileURLToPath(new URL('../../../DOMAIN_EVENTS.md', import.meta.url));
writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out}`);
