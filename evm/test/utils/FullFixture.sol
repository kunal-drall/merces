// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MercesFixture} from "./MercesFixture.sol";
import {Proofs} from "./Proofs.sol";
import {MercesAuction} from "../../src/MercesAuction.sol";
import {MercesTreasury} from "../../src/MercesTreasury.sol";
import {MercesIncome} from "../../src/MercesIncome.sol";
import {MercesVault} from "../../src/MercesVault.sol";
import {MercesFxAccumulator} from "../../src/MercesFxAccumulator.sol";
import {Groth16Verifier} from "../../src/zk/Groth16Verifier.sol";
import {MockPyth} from "../../src/mocks/MockPyth.sol";
import {MockChainlinkAggregator} from "../../src/mocks/MockChainlinkAggregator.sol";
import {IMercesIncome} from "../../src/interfaces/IMercesIncome.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {
    ProtocolContracts,
    RaiseState,
    ReleaseTranche,
    SeriesMode,
    SeriesParams,
    TierFlags
} from "../../src/types/MercesTypes.sol";

/// @notice Full protocol stack: real auction, treasury, income, FX accumulator and vault proxies. The window is
/// a stand-in address until the window module joins the fixture.
abstract contract FullFixture is MercesFixture {
    MercesAuction internal auction;
    MercesTreasury internal treasury;
    MercesIncome internal income;
    MercesVault internal vault;
    MercesFxAccumulator internal fx;
    Groth16Verifier internal groth16;
    MockPyth internal pyth;

    uint64 internal constant P0 = 100e6; // 100 USDC per unit
    uint64 internal constant UNITS = 300;
    uint32 internal constant Q1_2026 = 8104;

    function _deployProtocol() internal virtual override {
        groth16 = new Groth16Verifier();
        pyth = new MockPyth(0);
        auction = MercesAuction(
            deployProxy(
                address(new MercesAuction()),
                abi.encodeCall(MercesAuction.initialize, (address(timelock), address(registry)))
            )
        );
        treasury = MercesTreasury(
            deployProxy(
                address(new MercesTreasury()),
                abi.encodeCall(MercesTreasury.initialize, (address(timelock), address(registry)))
            )
        );
        vault = MercesVault(
            deployProxy(
                address(new MercesVault()), abi.encodeCall(MercesVault.initialize, (address(timelock), address(registry)))
            )
        );
        fx = MercesFxAccumulator(
            deployProxy(
                address(new MercesFxAccumulator()),
                abi.encodeCall(MercesFxAccumulator.initialize, (address(timelock), address(registry), address(pyth)))
            )
        );
        income = MercesIncome(
            deployProxy(
                address(new MercesIncome()),
                abi.encodeCall(
                    MercesIncome.initialize, (address(timelock), address(registry), address(groth16), address(fx))
                )
            )
        );
        _deployWindow();
        auctionAddr = address(auction);
        vaultAddr = address(vault);
        _deployTokenUnit();
        vm.prank(admin);
        registry.setProtocolContracts(
            ProtocolContracts({
                auction: address(auction),
                treasury: address(treasury),
                income: address(income),
                vault: address(vault),
                window: windowAddr,
                tokenFactory: address(tokenFactory)
            })
        );
    }

    /// @dev Overridden by the window fixture once the module exists.
    function _deployWindow() internal virtual {
        windowAddr = makeAddr("windowStub");
    }

    // ---------------------------------------------------------------- standard raise

    /// @dev 1000 units offered at reserve 100 USDC, min raise 20,000 USDC, tier flags as given; b1..b3 each buy
    /// 100 units at the reserve so P0 = 100 USDC, 300 units, proceeds 30,000 USDC, cap 250 USDC/unit.
    function standardSeries(uint8 tierFlags, bytes32 fxPairId) internal returns (uint256 sid) {
        SeriesParams memory p = defaultSeriesParams();
        p.unitsOffered = 1000;
        p.reservePrice = P0;
        p.minRaise = 20_000e6;
        vm.prank(issuer);
        sid = registry.createSeries(
            p, defaultSchedule(), Proofs.q1().termsCommitment, tierFlags, fxPairId, SeriesMode.SealedBid, false
        );
        vm.prank(issuer);
        registry.setContractHash(sid, keccak256("contract"));
    }

    function runStandardRaise(uint8 tierFlags, bytes32 fxPairId) internal returns (uint256 sid) {
        sid = standardSeries(tierFlags, fxPairId);
        allow(b1);
        allow(b2);
        allow(b3);
        vm.prank(issuer);
        auction.openRaise(sid);
        address[3] memory bidders = [b1, b2, b3];
        uint64 escrow = uint64(uint256(P0) * 100 * 101 / 100);
        for (uint256 i = 0; i < 3; i++) {
            fund(bidders[i], escrow);
            vm.startPrank(bidders[i]);
            usdc.approve(address(auction), escrow);
            auction.commitBid(sid, MercesMessages.orderCommitment(P0, 100, keccak256(abi.encode(i)), bidders[i]), escrow);
            vm.stopPrank();
        }
        vm.warp(auction.getAuction(sid).commitEnd);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(bidders[i]);
            auction.revealBid(sid, P0, 100, keccak256(abi.encode(i)));
        }
        vm.warp(auction.getAuction(sid).revealEnd);
        vm.startPrank(keeper);
        auction.beginSettlement(sid, P0);
        auction.tallyBids(sid, 0, 3);
        auction.finalizeSettlement(sid);
        for (uint256 i = 0; i < 3; i++) {
            auction.processBid(sid, i);
        }
        vm.stopPrank();
    }

    function runStandardRaise() internal returns (uint256 sid) {
        return runStandardRaise(TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR, bytes32(0));
    }

    function unitToken(uint256 sid) internal view returns (IERC3643Token) {
        return IERC3643Token(registry.getSeriesCore(sid).unitToken);
    }

    function settlementTs(uint256 sid) internal view returns (uint64) {
        return registry.getSeriesCore(sid).settlementTs;
    }

    // ---------------------------------------------------------------- reports

    function reportInput(uint256 sid, uint32 period, Proofs.Proof memory p, uint8 tier, bool liquidityEvent)
        internal
        view
        returns (IMercesIncome.ReportInput memory r)
    {
        r.seriesId = sid;
        r.period = period;
        r.paymentUsd = p.paymentUsd;
        r.fxAvgWad = p.fxAvgWad;
        r.incomeCommitment = p.incomeCommitment;
        r.tier = tier;
        r.liquidityEvent = liquidityEvent;
        r.proof = IMercesIncome.Groth16Proof({a: p.a, b: p.b, c: p.c});
        bytes32 digest = MercesMessages.reportDigest(registry.domain(), sid, period, p.incomeCommitment, tier);
        if (tier == 2) r.attestationSignature = sign(verifierKey, digest);
        else if (tier == 3) r.attestationSignature = sign(attestorKey, digest);
    }

    /// @dev Warps to the end of `period` (if earlier) and submits a tier-2 report.
    function submitReport(uint256 sid, uint32 period, Proofs.Proof memory p) internal {
        if (block.timestamp < Periods.periodEnd(period)) vm.warp(Periods.periodEnd(period));
        vm.prank(issuer);
        income.submitReport(reportInput(sid, period, p, 2, false));
    }

    function payDue(uint256 sid, address payer) internal returns (uint64 total) {
        (uint64 due, uint32 period) = income.openDue(sid);
        total = due + income.lateAccrual(sid, period, due, block.timestamp);
        fund(payer, total);
        vm.startPrank(payer);
        usdc.approve(address(income), total);
        income.pay(sid);
        vm.stopPrank();
    }

    function reportAndPay(uint256 sid, uint32 period, Proofs.Proof memory p) internal {
        submitReport(sid, period, p);
        (uint64 due,) = income.openDue(sid);
        if (due > 0) payDue(sid, issuer);
    }

    function pauseSig(uint256 sid, uint64 nonce, uint64 pauseEnd) internal view returns (bytes memory) {
        return sign(attestorKey, MercesMessages.pauseDigest(registry.domain(), sid, nonce, pauseEnd));
    }

    function extinguishSigs(uint256 sid, uint64 nonce) internal view returns (bytes memory a, bytes memory b) {
        bytes32 d = MercesMessages.extinguishDigest(registry.domain(), sid, nonce);
        return (sign(attestorKey, d), sign(attestor2Key, d));
    }
}
