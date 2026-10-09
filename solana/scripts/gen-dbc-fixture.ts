/**
 * Generates `solana/tests/fixtures/meteora/curve_config.json`: the `create_config` instruction data
 * of the Meteora DBC program for the curve-mode test series, encoded by the pinned SDK's IDL coder
 * from the Merces generator (`solana/meteora/src/config.ts`), plus the values the program derives
 * (`swap_base_amount`, `migration_base_threshold`, supply, `P0`) so the LiteSVM tests can check
 * the on-chain `PoolConfig` byte layout against them. The data is key-independent: `fee_claimer`,
 * `leftover_receiver` and the quote mint are instruction accounts.
 *
 *   node --import tsx scripts/gen-dbc-fixture.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection } from "@solana/web3.js";
import { createDbcProgram } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { buildMercesCurveConfig } from "../meteora/src/config.js";
import { toSdkConfigParameters } from "../meteora/src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
// the SDK's Anchor program object carries the DBC IDL coder; no RPC call is made
const { program } = createDbcProgram(new Connection("http://127.0.0.1:1"), "confirmed");

const USDC = 1_000_000n;
// Two configs of the same 100-unit, 1,000 USDC curve:
// - `partnerRoute` (PROCEEDS_OPTIONS §6.2): issuer = creator with a 10-unit vested allocation, the
//   whole migration fee to the Merces PDA (fee_claimer), creator share 0;
// - `pdaCreator`: no issuer allocation and a 50/50 migration-fee split, for a pool whose creator
//   is the series curve_authority PDA (both shares then reach the treasury).
function build(label: string, issuerUnits: bigint, creatorFeePercentage: number) {
  const cfg = buildMercesCurveConfig({
    seriesLabel: label,
    trailingAnnualIncome: 400n * USDC,
    targetRaise: 1_000n * USDC,
    unitsOnCurve: 100n,
    issuerUnits,
    issuerVesting: { cliffSeconds: 60, periods: 2, periodSeconds: 60 },
    migrationFee: { feePercentage: 99, creatorFeePercentage },
    quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  });
  const data = program.coder.instruction.encode("createConfig", { configParameters: toSdkConfigParameters(cfg.configParameters) });
  const d = cfg.derived;
  return {
    configHash: cfg.configHash,
    createConfigData: Buffer.from(data).toString("hex"),
    expected: {
      tokenDecimal: cfg.configParameters.tokenDecimal,
      migrationQuoteThreshold: cfg.configParameters.migrationQuoteThreshold.toString(),
      swapBaseAmount: d.swapBaseAmount.toString(),
      migrationBaseThreshold: d.migrationBaseThreshold.toString(),
      initialBaseSupply: d.initialBaseSupply.toString(),
      lockedVestingTotal: d.lockedVestingTotal.toString(),
      p0PerUnit: d.p0PerUnit.toString(),
      migrationFeePercentage: cfg.configParameters.migrationFee.feePercentage,
      creatorMigrationFeePercentage: cfg.configParameters.migrationFee.creatorFeePercentage,
      partnerMigrationFee: cfg.proceeds.partnerMigrationFee.toString(),
      creatorMigrationFee: cfg.proceeds.creatorMigrationFee.toString(),
      tradingFeeBps: 100,
    },
  };
}
const partnerRoute = build("merces-litesvm-curve", 10n, 0);
const out = {
  schema: "merces.tests.dbc-config/2",
  generator: "solana/scripts/gen-dbc-fixture.ts (buildMercesCurveConfig + @meteora-ag/dynamic-bonding-curve-sdk 1.5.13 IDL coder)",
  ...partnerRoute,
  pdaCreator: build("merces-litesvm-curve-pda-creator", 0n, 50),
};
const path = join(here, "../tests/fixtures/meteora/curve_config.json");
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${path}`);
console.log(JSON.stringify({ partnerRoute: out.expected, pdaCreator: out.pdaCreator.expected }, null, 2));
