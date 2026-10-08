import { WAD } from "@merces/sdk";
import { ScenarioBuilder, usdc, ts, type TermsPlain } from "../builder.js";

export const Q = (year: number, quarter: number): number => year * 4 + quarter - 1;

/** θ = 80,000 USDC a year; 10% total share over 1,000 units offered → r = 0.01% per unit. */
export const STD_PLAIN: TermsPlain = { theta: usdc(80_000), rWad: WAD / 10_000n, currencyCode: 840, indexingRule: 0 };

export const ISSUER_FUNDS = usdc(200_000);
export const BACKER_FUNDS = usdc(50_000);

/** Registry bootstrap at 2026-01-02: keys, allowlist, issuer, funding. */
export async function bootstrap(b: ScenarioBuilder, backers: string[], opts: { issuerFunds?: bigint; backerFunds?: bigint; extraAllowlist?: string[] } = {}): Promise<void> {
  b.key("attestor1", "attestor").key("attestor2", "attestor").key("verifier1", "verifier").actor("issuer", "keeper", ...backers);
  b.at(ts(2026, 1, 2));
  await b.step({ op: "register_attestor", key: "attestor1" });
  await b.step({ op: "register_attestor", key: "attestor2" });
  await b.step({ op: "register_verifier_key", key: "verifier1" });
  await b.step({ op: "allowlist", wallets: ["issuer", ...backers, ...(opts.extraAllowlist ?? [])] });
  await b.step({ op: "register_issuer", wallet: "issuer" });
  await b.fund("issuer", opts.issuerFunds ?? ISSUER_FUNDS);
  for (const x of backers) await b.fund(x, opts.backerFunds ?? BACKER_FUNDS);
}

/** Four backers at 100 units each, prices 120/115/110/105 → undersubscribed, p* = 105, 400 units sold. */
export const FOUR_BACKER_BIDS = [
  { actor: "b1", price: usdc(120), quantity: 100n },
  { actor: "b2", price: usdc(115), quantity: 100n },
  { actor: "b3", price: usdc(110), quantity: 100n },
  { actor: "b4", price: usdc(105), quantity: 100n },
];

/** Quarterly report dates (second day after the quarter ends). */
export const QUARTER_REPORT_DATES: Record<number, [number, number, number]> = {
  0: [0, 4, 2],
  1: [0, 7, 2],
  2: [0, 10, 2],
  3: [1, 1, 3],
};

export function reportDate(period: number): bigint {
  const year = Math.floor(period / 4);
  const q = period % 4;
  const [dy, m, d] = QUARTER_REPORT_DATES[q]!;
  return ts(year + dy, m, d);
}
