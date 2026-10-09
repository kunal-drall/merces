// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MercesDeploy} from "../../script/lib/MercesDeploy.sol";
import {MercesRegistry} from "../../src/MercesRegistry.sol";
import {MercesAuction} from "../../src/MercesAuction.sol";
import {MercesTreasury} from "../../src/MercesTreasury.sol";
import {MercesVault} from "../../src/MercesVault.sol";
import {MercesIncome} from "../../src/MercesIncome.sol";
import {MercesRouter} from "../../src/MercesRouter.sol";
import {MercesWindow} from "../../src/MercesWindow.sol";
import {MercesFxAccumulator} from "../../src/MercesFxAccumulator.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockPyth} from "../../src/mocks/MockPyth.sol";
import {MockChainlinkAggregator} from "../../src/mocks/MockChainlinkAggregator.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {MercesConstants as C} from "../../src/libraries/MercesConstants.sol";
import {Parameters} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

/// @notice State, deployment and JSON helpers of the SPEC §11 vector runner.
abstract contract VectorStack is Test {
    struct FxInfo {
        bool exists;
        bytes32 feedId;
        address crosscheck;
    }

    // deployment (fresh per vector)
    MockUSDC internal usdc;
    MockPyth internal pyth;
    MercesRegistry internal registry;
    MercesAuction internal auction;
    MercesTreasury internal treasury;
    MercesVault internal vault;
    MercesIncome internal income;
    MercesRouter internal router;
    MercesWindow internal window;
    MercesFxAccumulator internal fx;
    address internal feeCollector;
    address internal admin;
    address internal allowlistManager;
    address internal keeper;

    // vector state
    string internal json;
    string internal vname;
    uint256 internal stepIndex;
    mapping(bytes32 => uint256) internal keyPk;
    mapping(bytes32 => uint256) internal seriesIds;
    mapping(uint256 => bool) internal knownSeries;
    uint256[] internal seriesList;
    mapping(bytes32 => FxInfo) internal pairs;

    // ---------------------------------------------------------------- deployment

    function _deploy() internal {
        admin = _addr("__admin");
        allowlistManager = _addr("__allowlistManager");
        keeper = _addr("keeper");
        usdc = new MockUSDC();
        pyth = new MockPyth(0);
        Parameters memory p = _parameters();
        MercesDeploy.Deployment memory d = MercesDeploy.deploy(
            vm,
            address(this),
            MercesDeploy.Config({
                admin: admin,
                allowlistManager: allowlistManager,
                timelockProposer: admin,
                timelockDelay: 2 days,
                pyth: address(pyth),
                defaults: p
            })
        );
        registry = MercesRegistry(d.registry);
        auction = MercesAuction(d.auction);
        treasury = MercesTreasury(d.treasury);
        vault = MercesVault(d.vault);
        income = MercesIncome(d.income);
        router = MercesRouter(d.router);
        window = MercesWindow(d.window);
        fx = MercesFxAccumulator(d.fx);
        feeCollector = d.feeCollector;
        vm.startPrank(admin);
        registry.setStablecoin(address(usdc), true);
        registry.setFlags(
            _b(".config.flags.newRaisesPaused"), _b(".config.flags.windowsEnabled"), _b(".config.flags.tier4Enabled")
        );
        vm.stopPrank();
        assertEq(_u(".config.stablecoinDecimals"), usdc.decimals(), "stablecoin decimals");
    }

    /// @dev `config.parameters` (snake case) → registry defaults; the brief-fixed values must equal the constants.
    function _parameters() internal view returns (Parameters memory p) {
        string memory b = ".config.parameters.";
        p.capMultipleWad = uint64(_u(string.concat(b, "cap_multiple_wad")));
        p.hurdleRateWad = uint64(_u(string.concat(b, "hurdle_rate_wad")));
        p.payoutMultipleK = uint16(_u(string.concat(b, "payout_multiple_k")));
        p.lockupSeconds = uint64(_u(string.concat(b, "lockup_seconds")));
        p.walletCapBps = uint16(_u(string.concat(b, "wallet_cap_bps")));
        p.auctionFeeBps = uint16(_u(string.concat(b, "auction_fee_bps")));
        p.payoutFeeBps = uint16(_u(string.concat(b, "payout_fee_bps")));
        p.windowFeeBps = uint16(_u(string.concat(b, "window_fee_bps")));
        p.nonRevealChargeBps = uint16(_u(string.concat(b, "non_reveal_charge_bps")));
        p.commitDuration = uint64(_u(string.concat(b, "commit_duration")));
        p.revealDuration = uint64(_u(string.concat(b, "reveal_duration")));
        p.windowCommitDuration = uint64(_u(string.concat(b, "window_commit_duration")));
        p.windowRevealDuration = uint64(_u(string.concat(b, "window_reveal_duration")));
        p.fxMinCoverageBps = uint16(_u(string.concat(b, "fx_min_coverage_bps")));
        p.fxMaxStalenessSeconds = uint64(_u(string.concat(b, "fx_max_staleness_seconds")));
        p.fxMaxConfBps = uint16(_u(string.concat(b, "fx_max_conf_bps")));
        p.fxDeviationBandBps = uint16(_u(string.concat(b, "fx_deviation_band_bps")));
        p.maxPauseSeconds = uint64(_u(string.concat(b, "max_pause_seconds")));
        p.maxCumulativePauseSeconds = uint64(_u(string.concat(b, "max_cumulative_pause_seconds")));
        require(_u(string.concat(b, "report_due_days")) == C.REPORT_DUE_DAYS, "report_due_days");
        require(_u(string.concat(b, "grace_days")) == C.GRACE_DAYS, "grace_days");
        require(_u(string.concat(b, "formal_notice_days")) == C.FORMAL_NOTICE_DAYS, "formal_notice_days");
        require(_u(string.concat(b, "trueup_days")) == C.TRUEUP_DAYS, "trueup_days");
        require(_u(string.concat(b, "tail_seconds")) == C.TAIL_SECONDS, "tail_seconds");
        require(_u(string.concat(b, "max_pauses")) == C.MAX_PAUSES, "max_pauses");
        require(_u(string.concat(b, "max_release_tranches")) == C.MAX_RELEASE_TRANCHES, "max_release_tranches");
    }

    /// @dev Test keys: `keccak256("MERCES_TEST_KEY" ‖ utf8(seed)) mod (n − 1) + 1`; the derived key must equal the
    /// vector's `privateKey` and its address the vector's `address`.
    function _loadKeys() internal {
        string[] memory names = vm.parseJsonKeys(json, ".keys");
        uint256 n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        for (uint256 i = 0; i < names.length; i++) {
            string memory b = string.concat(".keys.", names[i]);
            string memory seed = _s(string.concat(b, ".seed"));
            uint256 pk = uint256(keccak256(abi.encodePacked("MERCES_TEST_KEY", seed))) % (n - 1) + 1;
            assertEq(pk, uint256(_h(string.concat(b, ".privateKey"))), string.concat("key derivation ", names[i]));
            assertEq(vm.addr(pk), _a(string.concat(b, ".address")), string.concat("key address ", names[i]));
            keyPk[keccak256(bytes(names[i]))] = pk;
        }
    }

    // ---------------------------------------------------------------- actors, series, signatures

    /// @dev Actor wallets: key holders sign with their test key; everyone else is a fresh deterministic address.
    function _addr(string memory name) internal view returns (address) {
        uint256 pk = keyPk[keccak256(bytes(name))];
        if (pk != 0) return vm.addr(pk);
        return address(uint160(uint256(keccak256(abi.encodePacked("merces.vector.actor:", name)))));
    }

    function _series(string memory name) internal view returns (uint256 sid) {
        sid = seriesIds[keccak256(bytes(name))];
        require(sid != 0, string.concat("unknown series ", name));
    }

    function _token(uint256 sid) internal view returns (IERC3643Token) {
        return IERC3643Token(registry.getSeriesCore(sid).unitToken);
    }

    function _sign(string memory keyName, bytes32 digest) internal view returns (bytes memory) {
        uint256 pk = keyPk[keccak256(bytes(keyName))];
        require(pk != 0, string.concat("no test key for ", keyName));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _aggregator(bytes32 pairId) internal returns (MockChainlinkAggregator) {
        FxInfo storage info = pairs[pairId];
        if (info.crosscheck == address(0)) info.crosscheck = address(new MockChainlinkAggregator(8, "crosscheck"));
        return MockChainlinkAggregator(info.crosscheck);
    }

    // ---------------------------------------------------------------- JSON helpers

    function _u(string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(json, key);
    }

    function _i(string memory key) internal view returns (int256) {
        return vm.parseJsonInt(json, key);
    }

    function _s(string memory key) internal view returns (string memory) {
        return vm.parseJsonString(json, key);
    }

    function _b(string memory key) internal view returns (bool) {
        return vm.parseJsonBool(json, key);
    }

    function _h(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, key);
    }

    function _a(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(json, key);
    }

    function _has(string memory key) internal view returns (bool) {
        return vm.keyExistsJson(json, key);
    }

    /// @dev A JSON `null` parses to a single zero word (strings and hex values never do here).
    function _isNull(string memory key) internal view returns (bool) {
        bytes memory raw = vm.parseJson(json, key);
        return raw.length == 32 && bytes32(raw) == bytes32(0);
    }

    function _f(string memory base, string memory field) internal pure returns (string memory) {
        return string.concat(base, ".", field);
    }

    function _at(string memory base, uint256 i) internal pure returns (string memory) {
        return string.concat(base, "[", vm.toString(i), "]");
    }

    function _where(string memory what) internal view returns (string memory) {
        return string.concat(vname, " step ", vm.toString(stepIndex), ": ", what);
    }
}
