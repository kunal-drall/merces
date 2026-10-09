// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {stdJson} from "forge-std/StdJson.sol";
import {VectorBase} from "./VectorBase.sol";

/// @notice SPEC §11 parity vector runner (brief F1): replays every vector of `packages/vectors` (schema 2, SPEC
/// v1.1) against a freshly deployed EVM stack and asserts every `expect` field to the base unit and every
/// `expect_revert` against the canonical error name (custom-error selector). See `VectorBase` for the step
/// semantics and docs/assumptions/track-c.md for the harness readings.
contract VectorRunnerTest is VectorBase {
    function test_vector_01_happy_path() public {
        _run("01_happy_path");
    }

    function test_vector_02_failed_auction() public {
        _run("02_failed_auction");
    }

    function test_vector_03_auction_edges() public {
        _run("03_auction_edges");
    }

    function test_vector_04_zero_quarters() public {
        _run("04_zero_quarters");
    }

    function test_vector_05_cap_hit() public {
        _run("05_cap_hit");
    }

    function test_vector_06_redemption_terms() public {
        _run("06_redemption_terms");
    }

    function test_vector_07_late_payment() public {
        _run("07_late_payment");
    }

    function test_vector_08_hardship_pause() public {
        _run("08_hardship_pause");
    }

    function test_vector_09_tail_clause() public {
        _run("09_tail_clause");
    }

    function test_vector_10_transfer_window() public {
        _run("10_transfer_window");
    }

    function test_vector_11_extinguishment() public {
        _run("11_extinguishment");
    }

    function test_vector_12_multi_series_router() public {
        _run("12_multi_series_router");
    }

    function test_vector_13_fx() public {
        _run("13_fx");
    }

    function test_vector_14_amendment() public {
        _run("14_amendment");
    }

    function test_vector_15_zero_valid_bids() public {
        _run("15_zero_valid_bids");
    }

    function test_vector_16_demand_limited_window() public {
        _run("16_demand_limited_window");
    }

    function test_vector_17_undelivered_winner() public {
        _run("17_undelivered_winner");
    }

    function test_vector_18_report_before_finalization() public {
        _run("18_report_before_finalization");
    }

    function test_vector_19_pause_while_late() public {
        _run("19_pause_while_late");
    }

    function test_vector_20_tier3_trueup() public {
        _run("20_tier3_trueup");
    }

    function test_vector_21_entry_rules() public {
        _run("21_entry_rules");
    }

    function test_vector_22_late_holder_tail_final() public {
        _run("22_late_holder_tail_final");
    }

    function test_vector_23_redeem_twice_with_tail() public {
        _run("23_redeem_twice_with_tail");
    }

    function test_vector_24_inverted_fx() public {
        _run("24_inverted_fx");
    }

    function test_vector_25_window_on_terminal() public {
        _run("25_window_on_terminal");
    }

    /// @dev Every vector file in the directory is covered by a test above (25 vectors, schema 2).
    function test_vectorSetIsComplete() public view {
        string memory readme = vm.readFile("../packages/vectors/README.md");
        assertTrue(bytes(readme).length > 0);
        for (uint256 i = 1; i <= 25; i++) {
            string memory n = _vectorName(i);
            string memory j = vm.readFile(string.concat("../packages/vectors/", n, ".json"));
            assertEq(stdJson.readUint(j, ".schema"), 2);
            assertEq(stdJson.readString(j, ".specVersion"), "1.1");
            assertEq(stdJson.readString(j, ".name"), n);
        }
    }

    function _vectorName(uint256 i) internal pure returns (string memory) {
        string[25] memory names = [
            "01_happy_path",
            "02_failed_auction",
            "03_auction_edges",
            "04_zero_quarters",
            "05_cap_hit",
            "06_redemption_terms",
            "07_late_payment",
            "08_hardship_pause",
            "09_tail_clause",
            "10_transfer_window",
            "11_extinguishment",
            "12_multi_series_router",
            "13_fx",
            "14_amendment",
            "15_zero_valid_bids",
            "16_demand_limited_window",
            "17_undelivered_winner",
            "18_report_before_finalization",
            "19_pause_while_late",
            "20_tier3_trueup",
            "21_entry_rules",
            "22_late_holder_tail_final",
            "23_redeem_twice_with_tail",
            "24_inverted_fx",
            "25_window_on_terminal"
        ];
        return names[i - 1];
    }
}
