import type { Vector } from "../../sim/types.js";
import { s01 } from "./s01_happy_path.js";
import { s02 } from "./s02_failed_auction.js";
import { s03 } from "./s03_auction_edges.js";
import { s04 } from "./s04_zero_quarters.js";
import { s05 } from "./s05_cap_hit.js";
import { s06 } from "./s06_redemption_terms.js";
import { s07 } from "./s07_late_payment.js";
import { s08 } from "./s08_hardship_pause.js";
import { s09 } from "./s09_tail_clause.js";
import { s10 } from "./s10_transfer_window.js";
import { s11 } from "./s11_extinguishment.js";
import { s12 } from "./s12_multi_series_router.js";
import { s13 } from "./s13_fx.js";
import { s14 } from "./s14_amendment.js";
import { s15 } from "./s15_zero_valid_bids.js";
import { s16 } from "./s16_demand_limited_window.js";
import { s17 } from "./s17_undelivered_winner.js";
import { s18 } from "./s18_report_before_finalization.js";
import { s19 } from "./s19_pause_while_late.js";

export interface Scenario {
  name: string;
  build: () => Promise<Vector>;
}

export const scenarios: Scenario[] = [s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12, s13, s14, s15, s16, s17, s18, s19];
