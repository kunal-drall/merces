import type { Command } from '@merces/domain';
import type { SimHarness } from '@merces/simulator';
import { SimWallet } from '@merces/simulator';

/**
 * Parity vector format (what we ask Stage 1 to publish; see STAGE1_INTEGRATION.md):
 * {
 *   "scenarios": [{
 *     "name": "happy-path",
 *     "genesis": 1767225600,
 *     "steps": [
 *       { "at": 0, "actor": "issuer", "command": { "kind": "registerIssuer" } },
 *       { "at": 10, "actor": "keeper", "command": { "kind": "finalizeSettlement", "seriesId": "$series0" } },
 *       { "at": 20, "actor": "backer-1", "command": {...}, "expectError": "WrongPhase" }
 *     ],
 *     "expect": { "balances": { "backer-1": { "USDC": "..." } }, "series": { "$series0": { "status": "OnTime", "unitsOutstanding": "500" } } }
 *   }]
 * }
 * Actors: issuer | backer-N | attestor-N | admin | keeper | allowlistManager | router. "$seriesN" refers to the N-th created series.
 */
export interface ParityStep {
  at: number;
  actor: string;
  command: Command;
  coSigners?: string[];
  expectError?: string;
}
export interface ParityScenario {
  name: string;
  genesis?: number;
  personalities?: string[];
  steps: ParityStep[];
  expect?: { balances?: Record<string, Record<string, string>>; series?: Record<string, Record<string, unknown>> };
}

export async function replayScenario(h: SimHarness, sc: ParityScenario): Promise<{ steps: number; mismatches: string[] }> {
  const mismatches: string[] = [];
  const seriesIds: string[] = [];
  const wallet = (actor: string): SimWallet | null => {
    if (actor === 'issuer') return h.issuer;
    if (actor === 'admin') return h.admin;
    const b = /^backer-(\d+)$/.exec(actor);
    if (b) return h.backers[Number(b[1]) - 1] ?? null;
    const a = /^attestor-(\d+)$/.exec(actor);
    if (a) return h.attestors[Number(a[1]) - 1] ?? null;
    return null;
  };
  const subst = (cmd: Command): Command => JSON.parse(JSON.stringify(cmd).replace(/\$series(\d+)/g, (_m, n) => seriesIds[Number(n)] ?? `$series${n}`));
  let n = 0;
  for (const step of sc.steps) {
    n++;
    await h.sim.setTime((sc.genesis ?? h.sim.clock.now()) + step.at);
    const cmd = subst(step.command);
    try {
      let events;
      if (step.actor === 'keeper' || step.actor === 'allowlistManager') {
        events = (await h.sim.submit(cmd as never, step.actor)).events;
      } else if (step.actor === 'router') {
        const c = cmd as { seriesId: string; amount: string };
        events = (await h.sim.postSplitReceipt(h.router, c.seriesId, BigInt(c.amount))).events;
      } else {
        const w = wallet(step.actor);
        if (!w) throw new Error(`unknown actor ${step.actor}`);
        const co = (step.coSigners ?? []).map((c) => wallet(c)).filter((x): x is SimWallet => !!x);
        events = (await h.exec(w, cmd as never, co)).events;
      }
      for (const e of events) if (e.type === 'SeriesCreated') seriesIds.push((e.payload as { seriesId: string }).seriesId);
      if (step.expectError) mismatches.push(`step ${n} (${cmd.kind}) expected error ${step.expectError} but succeeded`);
    } catch (e) {
      const code = (e as { code?: string }).code ?? (e as Error).message;
      if (!step.expectError) mismatches.push(`step ${n} (${cmd.kind}) failed: ${code}`);
      else if (step.expectError !== code) mismatches.push(`step ${n} (${cmd.kind}) expected ${step.expectError}, got ${code}`);
    }
  }
  for (const [actor, coins] of Object.entries(sc.expect?.balances ?? {})) {
    const w = wallet(actor);
    if (!w) {
      mismatches.push(`unknown actor in expectations: ${actor}`);
      continue;
    }
    for (const [coin, amount] of Object.entries(coins)) {
      const got = await h.sim.getBalance(w.address, coin as 'USDC' | 'USDG');
      if (got !== amount) mismatches.push(`${actor}.${coin}: expected ${amount}, simulator ${got}`);
    }
  }
  for (const [ref, fields] of Object.entries(sc.expect?.series ?? {})) {
    const id = ref.replace(/\$series(\d+)/, (_m, i) => seriesIds[Number(i)] ?? ref);
    const s = (await h.sim.getSeries(id)) as unknown as Record<string, unknown> | null;
    if (!s) {
      mismatches.push(`series ${ref} not found`);
      continue;
    }
    for (const [k, v] of Object.entries(fields)) if (JSON.stringify(s[k]) !== JSON.stringify(v)) mismatches.push(`${ref}.${k}: expected ${JSON.stringify(v)}, simulator ${JSON.stringify(s[k])}`);
  }
  return { steps: n, mismatches };
}
