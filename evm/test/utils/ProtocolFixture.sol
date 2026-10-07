// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MercesFixture} from "./MercesFixture.sol";
import {MercesAuction} from "../../src/MercesAuction.sol";
import {MercesTreasury} from "../../src/MercesTreasury.sol";
import {IMercesAuction} from "../../src/interfaces/IMercesAuction.sol";
import {IERC3643Token} from "../../src/interfaces/external/IERC3643Token.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {ProtocolContracts, RaiseState} from "../../src/types/MercesTypes.sol";
import {MockVault} from "../mocks/MockVault.sol";
import {MockIncome} from "../mocks/MockIncome.sol";

/// @notice Fixture with the real auction and treasury proxies and test stand-ins for the vault, income and
/// window contracts (replaced by the full-stack fixture once those modules exist).
abstract contract ProtocolFixture is MercesFixture {
    MercesAuction internal auction;
    MercesTreasury internal treasury;
    MockVault internal mockVault;
    MockIncome internal mockIncome;

    function _deployProtocol() internal virtual override {
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
        mockVault = new MockVault();
        mockIncome = new MockIncome();
        windowAddr = makeAddr("windowStub");
        auctionAddr = address(auction);
        vaultAddr = address(mockVault);
        _deployTokenUnit();
        vm.prank(admin);
        registry.setProtocolContracts(
            ProtocolContracts({
                auction: address(auction),
                treasury: address(treasury),
                income: address(mockIncome),
                vault: address(mockVault),
                window: windowAddr,
                tokenFactory: address(tokenFactory)
            })
        );
    }

    // ---------------------------------------------------------------- auction helpers

    struct BidPlan {
        address bidder;
        uint64 price;
        uint64 quantity;
        uint64 escrow;
        bytes32 salt;
    }

    function plan(address bidder, uint64 price, uint64 quantity, uint64 escrow) internal pure returns (BidPlan memory) {
        return BidPlan({bidder: bidder, price: price, quantity: quantity, escrow: escrow, salt: keccak256(abi.encode(bidder, price, quantity))});
    }

    function escrowFor(uint64 price, uint64 quantity) internal pure returns (uint64) {
        uint256 cost = uint256(price) * quantity;
        return uint64(cost + cost * 100 / 10_000);
    }

    function commit(uint256 seriesId, BidPlan memory b) internal {
        fund(b.bidder, b.escrow);
        vm.startPrank(b.bidder);
        usdc.approve(address(auction), b.escrow);
        auction.commitBid(seriesId, MercesMessages.orderCommitment(b.price, b.quantity, b.salt, b.bidder), b.escrow);
        vm.stopPrank();
    }

    function reveal(uint256 seriesId, BidPlan memory b) internal {
        vm.prank(b.bidder);
        auction.revealBid(seriesId, b.price, b.quantity, b.salt);
    }

    function openRaise(uint256 seriesId) internal {
        vm.prank(issuer);
        auction.openRaise(seriesId);
    }

    function warpToReveal(uint256 seriesId) internal {
        vm.warp(auction.getAuction(seriesId).commitEnd);
    }

    function warpToSettle(uint256 seriesId) internal {
        vm.warp(auction.getAuction(seriesId).revealEnd);
    }

    function settle(uint256 seriesId, uint64 clearingPrice) internal {
        vm.startPrank(keeper);
        auction.beginSettlement(seriesId, clearingPrice);
        uint256 n = auction.getAuction(seriesId).bidCount;
        for (uint256 from = 0; from < n; from += 200) {
            uint256 to = from + 200 > n ? n : from + 200;
            auction.tallyBids(seriesId, from, to);
        }
        auction.finalizeSettlement(seriesId);
        vm.stopPrank();
    }

    function processAll(uint256 seriesId) internal {
        uint256 n = auction.getAuction(seriesId).bidCount;
        for (uint256 i = 0; i < n; i++) {
            vm.prank(keeper);
            auction.processBid(seriesId, i);
        }
    }

    function unitToken(uint256 seriesId) internal view returns (IERC3643Token) {
        return IERC3643Token(registry.getSeriesCore(seriesId).unitToken);
    }
}
