import type { Vector } from "../../sim/types.js";

export interface Scenario {
  name: string;
  build: () => Promise<Vector>;
}

export const scenarios: Scenario[] = [];
