/**
 * Regenerates packages/vectors/*.json from the scenarios (pnpm vectors at the repo root).
 * Deterministic: fixed salts and keys derived from the scenario name, deterministic proofs.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scenarios } from "./scenarios/index.js";
import { renderReadme } from "./readme.js";
import type { Vector } from "../sim/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../../../vectors");

export async function generateAll(filter?: string): Promise<Vector[]> {
  mkdirSync(OUT, { recursive: true });
  const out: Vector[] = [];
  for (const scenario of scenarios) {
    if (filter && !scenario.name.includes(filter)) continue;
    const t0 = performance.now();
    const vector = await scenario.build();
    if (vector.name !== scenario.name) throw new Error(`scenario ${scenario.name} produced ${vector.name}`);
    const path = resolve(OUT, `${vector.name}.json`);
    writeFileSync(path, JSON.stringify(vector, null, 2) + "\n");
    const reports = vector.steps.filter((s) => s.op === "submit_report").length;
    const reverts = vector.steps.filter((s) => s.op === "expect_revert").length;
    console.log(`${vector.name}: ${vector.steps.length} steps, ${reports} proofs, ${reverts} reverts (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    out.push(vector);
  }
  return out;
}

async function main(): Promise<void> {
  const filter = process.argv[2];
  if (!filter) {
    for (const f of readdirSync(OUT)) if (/^\d\d_.*\.json$/.test(f)) rmSync(resolve(OUT, f));
  }
  const vectors = await generateAll(filter);
  if (!filter) writeFileSync(resolve(OUT, "README.md"), renderReadme(vectors));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
