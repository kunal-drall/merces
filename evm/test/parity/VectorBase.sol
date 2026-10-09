// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {VectorExpect} from "./VectorExpect.sol";
import {VectorErrors} from "./VectorErrors.sol";

/// @notice The SPEC §11 run loop: warp to each step's `t`, execute actions, assert `expect` steps and match
/// `expect_revert` steps against the canonical error name. A reverted call leaves the state unchanged by EVM
/// semantics (the reference asserts the same by diffing its serialized state).
abstract contract VectorBase is VectorExpect {
    function _run(string memory name) internal {
        vname = name;
        json = vm.readFile(string.concat("../packages/vectors/", name, ".json"));
        require(vm.parseJsonUint(json, ".schema") == 2, "schema 2 expected");
        _loadKeys();
        vm.warp(_u(".steps[0].t"));
        _deploy();
        uint256 n = _len(".steps");
        uint256 last;
        for (uint256 i = 0; i < n; i++) {
            stepIndex = i;
            string memory b = _at(".steps", i);
            uint256 t = _u(_f(b, "t"));
            require(t >= last, _where("time went backwards"));
            last = t;
            vm.warp(t);
            bytes32 op = keccak256(bytes(_s(_f(b, "op"))));
            if (op == keccak256("expect")) {
                _expect(b);
            } else if (op == keccak256("expect_revert")) {
                _expectRevert(b);
            } else {
                _action(b);
            }
        }
    }

    function _action(string memory b) internal {
        try this.exec(b) {}
        catch (bytes memory err) {
            revert(
                _where(
                    string.concat(_s(_f(b, "op")), " reverted unexpectedly: ", _errLabel(err), " ", vm.toString(err))
                )
            );
        }
    }

    function _expectRevert(string memory b) internal {
        string memory expected = _s(_f(b, "error"));
        bytes4 sel = VectorErrors.selector(expected);
        require(sel != bytes4(0), _where(string.concat("no EVM selector for canonical error ", expected)));
        string memory call = _f(b, "call");
        try this.exec(call) {
            revert(_where(string.concat(_s(_f(call, "op")), " should revert ", expected)));
        } catch (bytes memory err) {
            require(err.length >= 4, _where(string.concat("revert without selector, expected ", expected)));
            bytes4 got = bytes4(err);
            if (got != sel) {
                revert(_where(string.concat("expected ", expected, " got ", _errLabel(err), " ", vm.toString(err))));
            }
        }
    }

    function _errLabel(bytes memory err) internal pure returns (string memory) {
        if (err.length < 4) return "<empty>";
        return VectorErrors.name(bytes4(err));
    }
}
