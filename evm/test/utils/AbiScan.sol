// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";

/// @notice Reads a compiled contract's ABI from the build artifacts (`out/` or `out-dev/`) and extracts its
/// identifiers, so charter tests can assert properties of the whole external surface (functions, parameters,
/// struct fields, events, errors) rather than of hand-picked calls.
library AbiScan {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev The ABI text of `<out>/<name>.sol/<name>.json` (the artifact starts with `{"abi":[…],"bytecode"`).
    function abiText(string memory name) internal view returns (bytes memory text) {
        string memory profile = vm.envOr("FOUNDRY_PROFILE", string("default"));
        string memory out = keccak256(bytes(profile)) == keccak256("dev") ? "out-dev/" : "out/";
        bytes memory full = bytes(vm.readFile(string.concat(out, name, ".sol/", name, ".json")));
        uint256 end = indexOf(full, bytes("\"bytecode\""), 0);
        require(end != type(uint256).max, "artifact without bytecode key");
        text = new bytes(end);
        for (uint256 i = 0; i < end; i++) {
            text[i] = full[i];
        }
    }

    /// @dev Every `"name":"…"` value in the ABI (functions, events, errors, parameters, struct components).
    function names(bytes memory text) internal pure returns (string[] memory out) {
        return _names(text, false);
    }

    /// @dev The names of every `bytes`-typed parameter (signatures and opaque payloads).
    function bytesParams(bytes memory text) internal pure returns (string[] memory out) {
        return _names(text, true);
    }

    /// @dev Names of the ABI entries of type `function`.
    function functionNames(bytes memory text) internal pure returns (string[] memory out) {
        bytes memory key = bytes("{\"type\":\"function\",\"name\":\"");
        uint256 count;
        for (uint256 i = indexOf(text, key, 0); i != type(uint256).max; i = indexOf(text, key, i + 1)) {
            count++;
        }
        out = new string[](count);
        uint256 k;
        for (uint256 i = indexOf(text, key, 0); i != type(uint256).max; i = indexOf(text, key, i + 1)) {
            out[k++] = _readUntilQuote(text, i + key.length);
        }
    }

    function _names(bytes memory text, bool onlyBytes) private pure returns (string[] memory out) {
        bytes memory key = bytes("\"name\":\"");
        bytes memory bytesType = bytes("\",\"type\":\"bytes\"");
        string[] memory tmp = new string[](text.length / 8 + 1);
        uint256 count;
        for (uint256 i = indexOf(text, key, 0); i != type(uint256).max; i = indexOf(text, key, i + 1)) {
            string memory n = _readUntilQuote(text, i + key.length);
            if (onlyBytes && !_startsWith(text, i + key.length + bytes(n).length, bytesType)) continue;
            tmp[count++] = n;
        }
        out = new string[](count);
        for (uint256 i = 0; i < count; i++) {
            out[i] = tmp[i];
        }
    }

    /// @dev Splits an identifier into lower-case words: `issuanceStopped` → [issuance, stopped],
    /// `fxAvgWad` → [fx, avg, wad], `ERC1967InvalidImplementation` → [erc, 1967, invalid, implementation].
    function words(string memory ident) internal pure returns (string[] memory out) {
        bytes memory s = bytes(ident);
        string[] memory tmp = new string[](s.length + 1);
        uint256 count;
        bytes memory cur = new bytes(s.length);
        uint256 len;
        for (uint256 i = 0; i < s.length; i++) {
            bytes1 c = s[i];
            if (c == "_" || c == "$") {
                if (len > 0) (tmp[count++], len) = (_slice(cur, len), 0);
                continue;
            }
            if (len > 0 && _boundary(s, i)) (tmp[count++], len) = (_slice(cur, len), 0);
            cur[len++] = _lower(c);
        }
        if (len > 0) tmp[count++] = _slice(cur, len);
        out = new string[](count);
        for (uint256 i = 0; i < count; i++) {
            out[i] = tmp[i];
        }
    }

    function contains(string[] memory list, string memory item) internal pure returns (bool) {
        for (uint256 i = 0; i < list.length; i++) {
            if (keccak256(bytes(list[i])) == keccak256(bytes(item))) return true;
        }
        return false;
    }

    function indexOf(bytes memory hay, bytes memory needle, uint256 from) internal pure returns (uint256) {
        if (needle.length == 0 || hay.length < needle.length) return type(uint256).max;
        for (uint256 i = from; i + needle.length <= hay.length; i++) {
            if (_startsWith(hay, i, needle)) return i;
        }
        return type(uint256).max;
    }

    // ---------------------------------------------------------------- private

    function _boundary(bytes memory s, uint256 i) private pure returns (bool) {
        bytes1 c = s[i];
        bytes1 p = s[i - 1];
        bool cu = _isUpper(c);
        bool cd = _isDigit(c);
        if (cd != _isDigit(p)) return true;
        if (cu && !_isUpper(p)) return true;
        // acronym end: "USDValue" splits before "V" (upper followed by lower, preceded by upper)
        if (cu && _isUpper(p) && i + 1 < s.length && _isLower(s[i + 1])) return true;
        return false;
    }

    function _readUntilQuote(bytes memory text, uint256 start) private pure returns (string memory) {
        uint256 end = start;
        while (end < text.length && text[end] != "\"") {
            end++;
        }
        bytes memory out = new bytes(end - start);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = text[start + i];
        }
        return string(out);
    }

    function _startsWith(bytes memory hay, uint256 at, bytes memory needle) private pure returns (bool) {
        if (at + needle.length > hay.length) return false;
        for (uint256 j = 0; j < needle.length; j++) {
            if (hay[at + j] != needle[j]) return false;
        }
        return true;
    }

    function _slice(bytes memory b, uint256 len) private pure returns (string memory) {
        bytes memory out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = b[i];
        }
        return string(out);
    }

    function _isUpper(bytes1 c) private pure returns (bool) {
        return c >= "A" && c <= "Z";
    }

    function _isLower(bytes1 c) private pure returns (bool) {
        return c >= "a" && c <= "z";
    }

    function _isDigit(bytes1 c) private pure returns (bool) {
        return c >= "0" && c <= "9";
    }

    function _lower(bytes1 c) private pure returns (bytes1) {
        return _isUpper(c) ? bytes1(uint8(c) + 32) : c;
    }
}
