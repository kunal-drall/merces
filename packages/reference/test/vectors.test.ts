import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { isErrorName } from "@merces/sdk";
import { Simulator } from "../src/sim/simulator.js";
import type { Vector } from "../src/sim/types.js";
import { scenarios } from "../src/vectors/scenarios/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "../../vectors");
const files = readdirSync(dir)
  .filter((f) => /^\d\d_.*\.json$/.test(f))
  .sort();
const schema = JSON.parse(readFileSync(resolve(dir, "schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

describe("parity vectors", () => {
  it("every registered scenario has a generated file and vice versa", () => {
    expect(files.map((f) => f.replace(/\.json$/, ""))).toEqual(scenarios.map((s) => s.name));
  });

  for (const file of files) {
    const vector = JSON.parse(readFileSync(resolve(dir, file), "utf8")) as Vector;
    describe(file, () => {
      it("matches schema.json", () => {
        const ok = validate(vector);
        if (!ok) throw new Error(JSON.stringify(validate.errors?.slice(0, 5), null, 2));
      });
      it("uses canonical error names and known actors", () => {
        const actors = new Set(vector.actors);
        for (const s of vector.steps) {
          if (s.op === "expect_revert") expect(isErrorName(s.error), s.error).toBe(true);
          const call = s.op === "expect_revert" ? s.call : s;
          if ("actor" in call && typeof call.actor === "string") expect(actors.has(call.actor), `actor ${call.actor}`).toBe(true);
        }
        for (const k of Object.values(vector.keys)) expect(actors.has(Object.keys(vector.keys).find((n) => vector.keys[n] === k)!)).toBe(true);
      });
      it("replays on a fresh simulator with every expect matching; stablecoin and units are conserved", async () => {
        const sim = new Simulator({ flags: vector.config.flags });
        let funded = 0n;
        for (const s of vector.steps) {
          if (s.op === "fund") funded += BigInt(s.amount);
          await sim.apply(s);
          expect(sim.totalStable()).toBe(funded);
          if (s.op === "expect" && s.series) sim.checkUnitSupply(s.series);
        }
        expect(sim.totalStable()).toBe(funded);
      });
      it("embedded proofs carry the public signals the report claims", () => {
        for (const s of vector.steps) {
          const call = s.op === "expect_revert" ? s.call : s;
          if (call.op !== "submit_report") continue;
          expect(call.publicSignals[5]).toBe(call.paymentUsd);
          expect(call.publicSignals[2]).toBe(call.fxAvgWad);
          expect(BigInt(call.publicSignals[4]!)).toBe(BigInt(call.incomeCommitment));
          expect(call.proofEvm.pubSignals).toEqual(call.publicSignals);
          expect(call.proofSolana.publicInputs.map((h) => BigInt(h).toString())).toEqual(call.publicSignals);
        }
      });
    });
  }
});
