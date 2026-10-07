/**
 * CLI: generate a Merces curve-mode DBC config file from an issuer input file.
 *
 *   pnpm --filter @merces/meteora config -- --input ./issuer.json --out ./series-config.json
 *
 * The input file holds the fields of `MercesCurveInput` with bigints as decimal strings, e.g.
 *   { "seriesLabel": "pilot-1", "trailingAnnualIncome": "40000000000", "targetRaise": "100000000000",
 *     "unitsOnCurve": "10000", "issuerUnits": "0", "quoteMint": "<devnet USDC mint>" }
 * Every omitted field takes the default documented in `docs/assumptions/track-d.md`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { formatQuote, logger, optionalFlag, parseArgs, requireFlag } from "./cli.js";
import { buildMercesCurveConfig, mercesCurveConfigToJson, type MercesCurveInput } from "./config.js";

const BIG_FIELDS = ["trailingAnnualIncome", "targetRaise", "unitsOnCurve", "issuerUnits", "maxRaiseMultipleWad", "startValuationMultipleWad", "maxPriceRampWad", "capMultipleWad", "poolCreationFeeLamports"] as const;

export function parseInputFile(json: string): MercesCurveInput {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  for (const f of BIG_FIELDS) if (raw[f] !== undefined) out[f] = BigInt(raw[f] as string | number);
  if (raw["issuerVesting"] && typeof raw["issuerVesting"] === "object") {
    const v = raw["issuerVesting"] as Record<string, unknown>;
    out["issuerVesting"] = { ...v, ...(v["cliffUnlockUnits"] !== undefined ? { cliffUnlockUnits: BigInt(v["cliffUnlockUnits"] as string | number) } : {}) };
  }
  return out as unknown as MercesCurveInput;
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  const input = parseInputFile(readFileSync(requireFlag(args, "input"), "utf8"));
  const cfg = buildMercesCurveConfig(input);
  const json = mercesCurveConfigToJson(cfg);
  const out = optionalFlag(args, "out");
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
  const log = logger();
  const qd = cfg.input.quoteDecimals;
  log(`raise X = ${formatQuote(cfg.anchoring.migrationQuoteThreshold, qd)} quote (max ${formatQuote(cfg.anchoring.maxRaise, qd)}; capped by income: ${cfg.anchoring.raiseCappedByIncome})`);
  log(`price per unit: start ${formatQuote(cfg.anchoring.startPricePerUnit, qd)}, average/P0 ${formatQuote(cfg.derived.p0PerUnit, qd)}, migration ${formatQuote(cfg.anchoring.migrationPricePerUnit, qd)}; cap/unit ${formatQuote(cfg.derived.capPerUnit, qd)}`);
  log(`supply ${cfg.derived.totalSupplyUnits} units = ${cfg.derived.unitsSoldOnCurve} on the curve + ${formatQuote(cfg.derived.migrationBaseThreshold, cfg.input.tokenDecimals)} to DAMM v2 + ${formatQuote(cfg.derived.lockedVestingTotal, cfg.input.tokenDecimals)} issuer vesting`);
  log(`proceeds: issuer ${formatQuote(cfg.proceeds.creatorMigrationFee, qd)}, Merces ${formatQuote(cfg.proceeds.partnerMigrationFee, qd)} + trading fees ≈ ${formatQuote(cfg.proceeds.tradingFees.partner, qd)}, DAMM v2 pool ${formatQuote(cfg.proceeds.quoteForPoolNet, qd)}, Meteora ${formatQuote(cfg.proceeds.protocolLiquidityMigrationFeeQuote, qd)} + trading fees ≈ ${formatQuote(cfg.proceeds.tradingFees.protocol, qd)}`);
  if (out) log(`wrote ${out} (configHash ${cfg.configHash})`);
}

const isMain = process.argv[1] !== undefined && /cli-config\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    logger()(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
