import { describe, it, expect } from "vitest";
import { WAD } from "../src/index.js";
describe("smoke", () => { it("WAD", () => { expect(WAD).toBe(1000000000000000000n); }); });
