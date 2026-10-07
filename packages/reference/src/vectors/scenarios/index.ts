import type { Vector } from "../../sim/types.js";
import { s01 } from "./s01_happy_path.js";
import { s02 } from "./s02_failed_auction.js";
import { s03 } from "./s03_auction_edges.js";

export interface Scenario {
  name: string;
  build: () => Promise<Vector>;
}

export const scenarios: Scenario[] = [s01, s02, s03];
