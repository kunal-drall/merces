// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {FullFixture} from "../utils/FullFixture.sol";
import {Proofs} from "../utils/Proofs.sol";
import {AbiScan} from "../utils/AbiScan.sol";
import {MercesVault} from "../../src/MercesVault.sol";
import {MercesMessages} from "../../src/libraries/MercesMessages.sol";
import {Periods} from "../../src/libraries/Periods.sol";
import {
    Parameters,
    ReleaseTranche,
    SeriesCore,
    SeriesMode,
    SeriesStatus,
    SeriesTerms,
    TierFlags
} from "../../src/types/MercesTypes.sol";
import "../../src/types/MercesErrors.sol";

/// @notice One dedicated test per Autonomy Charter rule (brief C11, F2 last bullet; SPEC v1.1 §2 hard limits).
/// Each test states the rule it proves; the money and status details are covered again by the unit, parity and
/// invariant suites.
contract CharterTest is FullFixture {
    uint64 internal constant DAY = 86_400;
    bytes32 internal constant ERC1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint64 internal constant TRANCHE = 7_500e6; // 25% of the standard raise's 30,000 USDC proceeds

    function _merces() internal pure returns (string[12] memory) {
        return [
            "MercesRegistry",
            "MercesAuction",
            "MercesTreasury",
            "MercesIncome",
            "MercesVault",
            "MercesWindow",
            "MercesRouter",
            "MercesRouterReceiver",
            "MercesFxAccumulator",
            "FeeCollector",
            "MercesTokenFactory",
            "MercesTokenGovernor"
        ];
    }

    function _claimRelease(uint256 sid) internal returns (uint256 received) {
        uint256 before = usdc.balanceOf(issuer);
        vm.prank(issuer);
        treasury.claimRelease(sid);
        received = usdc.balanceOf(issuer) - before;
    }

    // ================================================================ C11 §1

    /// @notice C11 §1: capital releases follow the fixed schedule with no approval from anyone; the only things
    /// that pause releases are the Late status and the issuer's own request. Every admin, allowlist-manager and
    /// attestor action, and a hardship pause, leave the schedule running.
    function test_C11_1_releasesFollowScheduleWithoutApproval() public {
        uint256 sid = runStandardRaise();
        uint64 st = settlementTs(sid);
        assertEq(vm.getBlockTimestamp(), st);

        // every privileged role does everything it can that might plausibly interfere
        vm.startPrank(admin);
        registry.setFlags(true, false, false); // new raises paused, windows off
        registry.revokeAttestor(attestor2);
        registry.deactivateIssuer(issuer);
        registry.setFeeCollector(stranger);
        Parameters memory p = defaultParameters();
        p.lockupSeconds = 2 * p.lockupSeconds;
        registry.setDefaults(p);
        vm.stopPrank();
        disallow(issuer);

        // tranche 1 at settlement, tranche 2 at +90 days: claimed with no signature or approval
        assertEq(_claimRelease(sid), TRANCHE);
        vm.warp(st + 90 * DAY);
        assertEq(_claimRelease(sid), TRANCHE);
        vm.prank(issuer);
        vm.expectRevert(NothingVested.selector); // the schedule, not anyone's say-so, sets the amount
        treasury.claimRelease(sid);
        reportAndPay(sid, Q1_2026, Proofs.q1());

        // a hardship pause (issuer + attestor) does not stop releases (SPEC §6.6)
        vm.warp(st + 170 * DAY);
        vm.prank(issuer);
        income.requestPause(sid);
        income.approvePause(sid, st + 200 * DAY, pauseSig(sid, 1, st + 200 * DAY));
        vm.warp(st + 180 * DAY);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Paused));

        // the issuer's own request pauses releases, and only the issuer can lift it
        vm.prank(admin);
        vm.expectRevert(NotIssuer.selector);
        treasury.setReleasePause(sid, true);
        vm.prank(issuer);
        treasury.setReleasePause(sid, true);
        vm.prank(issuer);
        vm.expectRevert(ReleasesPaused.selector);
        treasury.claimRelease(sid);
        vm.prank(admin);
        vm.expectRevert(NotIssuer.selector);
        treasury.setReleasePause(sid, false);
        vm.prank(issuer);
        treasury.setReleasePause(sid, false);
        assertEq(_claimRelease(sid), TRANCHE); // tranche 3, during the hardship pause

        // Late status (Q2 never reported) is the only other block, and paying lifts it
        vm.warp(st + 270 * DAY);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Late));
        vm.prank(issuer);
        vm.expectRevert(SeriesLate.selector);
        treasury.claimRelease(sid);
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.OnTime));
        assertEq(_claimRelease(sid), TRANCHE); // tranche 4
        assertEq(treasury.getTreasury(sid).releasedTotal, 30_000e6);
        assertEq(usdc.balanceOf(address(treasury)), 0);
    }

    // ================================================================ C11 §2

    /// @notice C11 §2: on-chain data about an issuer is limited to series parameters, the terms commitment,
    /// payment amounts, statuses and events. The whole external surface of every Merces contract (every function,
    /// parameter, struct field, event and error name) is scanned for personal-data vocabulary, and the issuer
    /// record is exactly {registered, active, issuanceStopped, seriesCount}.
    function test_C11_2_onchainIssuerDataIsMinimal() public view {
        string[30] memory forbidden = [
            "health",
            "medical",
            "diagnosis",
            "illness",
            "disease",
            "disability",
            "death",
            "deceased",
            "location",
            "geo",
            "latitude",
            "longitude",
            "gps",
            "country",
            "city",
            "relationship",
            "spouse",
            "marital",
            "partner",
            "family",
            "career",
            "employer",
            "employment",
            "occupation",
            "job",
            "gender",
            "age",
            "birth",
            "religion",
            "email"
        ];
        // the tokenizer splits identifiers into whole words, so `page` never matches `age`
        string[] memory probe = AbiScan.words("ERC1967InvalidImplementation_fxAvgWadUSDValue");
        assertEq(probe.length, 9);
        assertEq(probe[0], "erc");
        assertEq(probe[1], "1967");
        assertEq(probe[4], "fx");
        assertEq(probe[7], "usd");
        assertEq(probe[8], "value");
        string[12] memory cs = _merces();
        uint256 scanned;
        for (uint256 c = 0; c < cs.length; c++) {
            string[] memory names = AbiScan.names(AbiScan.abiText(cs[c]));
            for (uint256 i = 0; i < names.length; i++) {
                string[] memory ws = AbiScan.words(names[i]);
                for (uint256 w = 0; w < ws.length; w++) {
                    for (uint256 f = 0; f < forbidden.length; f++) {
                        assertTrue(
                            keccak256(bytes(ws[w])) != keccak256(bytes(forbidden[f])),
                            string.concat(cs[c], ": personal-data identifier ", names[i])
                        );
                    }
                }
                scanned++;
            }
        }
        assertGt(scanned, 1000); // the scan really covered the surface

        // the issuer record: registered/active flags, the issuer's own issuance switch and a series counter
        bytes memory reg = AbiScan.abiText("MercesRegistry");
        string[] memory issuerAbi = AbiScan.names(_entry(reg, "getIssuer"));
        string[7] memory expected =
            ["getIssuer", "wallet", "", "registered", "active", "issuanceStopped", "seriesCount"];
        assertEq(issuerAbi.length, expected.length, "getIssuer ABI shape");
        for (uint256 i = 0; i < expected.length; i++) {
            assertEq(issuerAbi[i], expected[i], "getIssuer ABI field");
        }
        // registering an issuer takes nothing but a wallet
        string[] memory regAbi = AbiScan.names(_entry(reg, "registerIssuer"));
        assertEq(regAbi.length, 2);
        assertEq(regAbi[1], "wallet");
    }

    /// @dev The ABI text of one top-level entry `{"type":"function","name":"<fn>",…}`.
    function _entry(bytes memory abiText, string memory fn) internal pure returns (bytes memory out) {
        bytes memory key = bytes(string.concat("{\"type\":\"function\",\"name\":\"", fn, "\""));
        uint256 start = AbiScan.indexOf(abiText, key, 0);
        require(start != type(uint256).max, string.concat("no function ", fn));
        uint256 end = AbiScan.indexOf(abiText, bytes("{\"type\":\""), start + 1);
        if (end == type(uint256).max) end = abiText.length;
        out = new bytes(end - start);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = abiText[start + i];
        }
    }

    // ================================================================ C11 §3

    /// @notice C11 §3 (first half): no function can force a payment. The issuer grants unlimited allowances to
    /// every protocol contract, a due is open and the series falls Late: no one but the payer's own transaction
    /// moves the issuer's money (every pull in the code is `transferFrom(msg.sender, …)`).
    function test_C11_3_noFunctionCanForceAPayment() public {
        uint256 sid = runStandardRaise();
        fund(issuer, 1_000_000e6);
        address[6] memory spenders =
            [address(auction), address(treasury), address(vault), address(income), address(router), address(window)];
        vm.startPrank(issuer);
        for (uint256 i = 0; i < spenders.length; i++) {
            usdc.approve(spenders[i], type(uint256).max);
        }
        vm.stopPrank();
        uint256 balance = usdc.balanceOf(issuer);

        submitReport(sid, Q1_2026, Proofs.q1());
        (uint64 due,) = income.openDue(sid);
        assertGt(due, 0);
        // a third party cannot settle the due out of the issuer's allowance
        vm.prank(stranger);
        vm.expectRevert();
        income.pay(sid);
        // nor start a redemption that would pull the issuer's deposit
        vm.prank(stranger);
        vm.expectRevert(NotIssuer.selector);
        vault.redeem(sid);
        // time passes, the series goes Late; keepers crank everything they can
        vm.warp(vm.getBlockTimestamp() + 400 * DAY);
        vm.startPrank(keeper);
        income.crankStatus(sid);
        vm.expectRevert(NothingDue.selector);
        vault.retireIfCapped(sid);
        vm.stopPrank();
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Late));
        assertEq(usdc.balanceOf(issuer), balance, "nothing was taken from the issuer");

        // a voluntary payer pays from its own wallet; the issuer's balance is untouched
        uint64 total = due + income.lateAccrual(sid, Q1_2026, due, vm.getBlockTimestamp());
        fund(stranger, total);
        vm.startPrank(stranger);
        usdc.approve(address(income), total);
        income.pay(sid);
        vm.stopPrank();
        assertEq(usdc.balanceOf(issuer), balance);
        assertEq(usdc.balanceOf(stranger), 0);
    }

    /// @notice C11 §3 (second half): no penalty exists for reporting zero. A zero quarter settles at once with
    /// no due, no fee, no accrual, OnTime status and releases unaffected.
    function test_C11_3_zeroReportCarriesNoPenalty() public {
        uint256 sid = runStandardRaise();
        reportAndPay(sid, Q1_2026, Proofs.q1());
        reportAndPay(sid, Q1_2026 + 1, Proofs.q2());
        uint256 fees = usdc.balanceOf(address(feeCollector));
        uint256 gross = vault.getLedger(sid).grossReceived;
        uint256 issuerBalance = usdc.balanceOf(issuer);
        // report the zero quarter on its very last day of grace-free time, then wait: nothing accrues
        vm.warp(Periods.periodEnd(Q1_2026 + 2) + 29 * DAY);
        vm.prank(issuer);
        income.submitReport(reportInput(sid, Q1_2026 + 2, Proofs.q3zero(), 2, false));
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 0);
        vm.warp(vm.getBlockTimestamp() + 25 * DAY);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.OnTime));
        assertEq(income.lateAccrual(sid, Q1_2026 + 2, 0, vm.getBlockTimestamp()), 0);
        assertEq(usdc.balanceOf(address(feeCollector)), fees, "no fee on a zero quarter");
        assertEq(vault.getLedger(sid).grossReceived, gross);
        assertEq(usdc.balanceOf(issuer), issuerBalance, "nothing taken");
        assertEq(_claimRelease(sid), 4 * TRANCHE); // the schedule ran on (all four tranches vested by now)
        (bool hasPaid, uint32 lastPaid) = income.lastPaidPeriod(sid);
        assertTrue(hasPaid);
        assertEq(lastPaid, Q1_2026 + 2);
    }

    // ================================================================ C11 §4

    /// @notice C11 §4: units carry no vote, and no function whose outcome affects an issuer is gated on holder
    /// votes or signatures. The unit token has no voting surface; the only signature inputs anywhere in Merces
    /// are attestor / report-verifier signatures, and a holder's signature is refused on each of them.
    function test_C11_4_unitsCarryNoVote() public {
        string[] memory tokenFns = AbiScan.functionNames(AbiScan.abiText("Token"));
        assertGt(tokenFns.length, 30);
        string[10] memory voting = [
            "delegate",
            "delegates",
            "delegateBySig",
            "getVotes",
            "getPastVotes",
            "getPastTotalSupply",
            "numCheckpoints",
            "checkpoints",
            "castVote",
            "propose"
        ];
        for (uint256 i = 0; i < voting.length; i++) {
            assertFalse(AbiScan.contains(tokenFns, voting[i]), string.concat("unit token exposes ", voting[i]));
        }

        // every bytes-typed input in the Merces surface: attestor/verifier signatures and the UUPS upgrade payload
        string[12] memory cs = _merces();
        uint256 sigs;
        for (uint256 c = 0; c < cs.length; c++) {
            bytes memory text = AbiScan.abiText(cs[c]);
            string[] memory params = AbiScan.bytesParams(text);
            string[] memory fns = AbiScan.functionNames(text);
            for (uint256 i = 0; i < voting.length; i++) {
                assertFalse(AbiScan.contains(fns, voting[i]));
            }
            for (uint256 i = 0; i < params.length; i++) {
                string memory id = string.concat(cs[c], ".", params[i]);
                bytes32 h = keccak256(bytes(params[i]));
                if (h == keccak256("data")) continue; // upgradeToAndCall (timelock only)
                assertTrue(
                    _isAttestorSignatureParam(keccak256(bytes(id))), string.concat("unexpected signature input ", id)
                );
                sigs++;
            }
        }
        assertEq(sigs, 7);

        // behaviour: a holder's signature never counts, wherever a signature is taken
        uint256 sid = runStandardRaise();
        (, uint256 holderKey) = makeAddrAndKey("b1");
        assertEq(vm.addr(holderKey), b1);
        assertEq(unitToken(sid).balanceOf(b1), 100);
        vm.prank(issuer);
        income.requestPause(sid);
        uint64 pauseEnd = uint64(vm.getBlockTimestamp() + 30 * DAY);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, b1));
        income.approvePause(sid, pauseEnd, sign(holderKey, MercesMessages.pauseDigest(domain, sid, 1, pauseEnd)));
        bytes32 amend = MercesMessages.amendDigest(domain, sid, 0, bytes32(uint256(7)), 2.4e18);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, b1));
        registry.amendTerms(sid, bytes32(uint256(7)), 2.4e18, sign(holderKey, amend), noTier1());
        bytes32 ext = MercesMessages.extinguishDigest(domain, sid, 0);
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, b1));
        vault.extinguish(sid, sign(attestorKey, ext), sign(holderKey, ext));

        // and outcomes that affect the issuer need no holder at all: the amendment and the pause go through on the
        // issuer's and an attestor's word while every unit stays where it is
        vm.prank(issuer);
        registry.amendTerms(sid, bytes32(uint256(7)), 2.4e18, sign(attestorKey, amend), noTier1());
        income.approvePause(sid, pauseEnd, pauseSig(sid, 1, pauseEnd));
        assertEq(registry.getSeriesTerms(sid).capMultipleWad, 2.4e18);
        assertEq(uint8(income.deriveStatus(sid)), uint8(SeriesStatus.Paused));
        assertEq(unitToken(sid).balanceOf(b1), 100);
    }

    function _isAttestorSignatureParam(bytes32 id) internal pure returns (bool) {
        return id == keccak256("MercesRegistry.attestorSignature") || id == keccak256("MercesIncome.attestorSignature")
            || id == keccak256("MercesIncome.attestationSignature")
            || id == keccak256("MercesIncome.fxFallbackSignature") || id == keccak256("MercesIncome.sig")
            || id == keccak256("MercesVault.signatureA") || id == keccak256("MercesVault.signatureB");
    }

    // ================================================================ C11 §5

    /// @notice C11 §5: the issuer can stop new issuance at any time; existing series end only through the cap,
    /// redemption or extinguishment. Stopping issuance (or an admin deactivating the issuer) leaves a live series
    /// running, no role can mark a series terminal, and each of the three exits is shown ending a series.
    function test_C11_5_issuerStopsIssuanceSeriesEndOnlyByCapRedemptionOrExtinguishment() public {
        uint256 capped = runStandardRaise();
        uint256 redeemed = runStandardRaise(
            TierFlags.TIER2_ZKTLS | TierFlags.TIER3_ATTESTOR, bytes32(0), Proofs.q1().termsCommitment, P0, 0
        );
        uint256 extinguished = runStandardRaise();

        // the issuer stops issuance at any time, with no one's permission
        vm.prank(issuer);
        registry.stopIssuance();
        vm.prank(issuer);
        vm.expectRevert(RegistryErrors.IssuanceStopped.selector);
        registry.createSeries(
            defaultSeriesParams(),
            defaultSchedule(),
            bytes32(uint256(1)),
            TierFlags.TIER3_ATTESTOR,
            bytes32(0),
            SeriesMode.SealedBid,
            false,
            noTier1()
        );
        vm.prank(admin);
        registry.deactivateIssuer(issuer);

        // nobody can end a series by fiat
        address[4] memory callers = [admin, issuer, allowlistManager, stranger];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(NotProtocolContract.selector);
            registry.markTerminal(capped, SeriesStatus.Retired);
        }
        vm.prank(keeper);
        vm.expectRevert(NothingDue.selector); // cap not met: retirement is impossible
        vault.retireIfCapped(capped);

        // exit 2 — redemption by the issuer (no lockup on this series; no period has ended yet)
        (,,,, uint64 deposit) = vault.previewRedemption(redeemed, vm.getBlockTimestamp());
        fund(issuer, deposit);
        vm.startPrank(issuer);
        usdc.approve(address(vault), deposit);
        vault.redeem(redeemed);
        vm.stopPrank();
        assertEq(registry.getSeriesCore(redeemed).terminalStatus, uint8(SeriesStatus.Redeemed));

        // exit 3 — extinguishment on two attestors' confirmation (C11 §6); its dues are simply cleared
        (bytes memory a, bytes memory b) = extinguishSigs(extinguished, vault.getLedger(extinguished).extinguishNonce);
        vm.prank(keeper);
        vault.extinguish(extinguished, a, b);
        assertEq(registry.getSeriesCore(extinguished).terminalStatus, uint8(SeriesStatus.Extinguished));

        // the existing series keep running after the stop: report, pay, claim
        reportAndPay(capped, Q1_2026, Proofs.q1());
        uint256 b1Before = usdc.balanceOf(b1);
        vm.prank(b1);
        vault.claim(capped);
        assertGt(usdc.balanceOf(b1), b1Before);

        // exit 1 — the cap: pay through year 2 until the 250 USDC/unit cap is met
        reportAndPay(capped, Q1_2026 + 1, Proofs.q2());
        reportAndPay(capped, Q1_2026 + 2, Proofs.q3zero());
        reportAndPay(capped, Q1_2026 + 3, Proofs.q4());
        reportAndPay(capped, Q1_2026 + 4, Proofs.y2q1());
        reportAndPay(capped, Q1_2026 + 5, Proofs.y2q2cap());
        assertEq(registry.getSeriesCore(capped).terminalStatus, uint8(SeriesStatus.Retired));

        // the issuer resumes issuance whenever they like (an admin re-activation is a separate, admin-side switch)
        vm.prank(admin);
        registry.registerIssuer(issuer);
        vm.prank(issuer);
        registry.resumeIssuance();
        standardSeries(TierFlags.TIER3_ATTESTOR, bytes32(0));
    }

    // ================================================================ C11 §6

    /// @notice C11 §6: on death or permanent disability, confirmed by two registered attestors, all claims end;
    /// unreleased treasury funds go to holders pro rata (no fee) and nothing else is owed (assumption A4/A31,
    /// recorded for counsel: tranches vested before extinguishment stay with the issuer's estate).
    function test_C11_6_extinguishmentEndsAllClaims() public {
        uint256 sid = runStandardRaise();
        reportAndPay(sid, Q1_2026, Proofs.q1());
        submitReport(sid, Q1_2026 + 1, Proofs.q2()); // an open due the issuer never pays
        (uint64 openDue,) = income.openDue(sid);
        assertGt(openDue, 0);
        assertEq(_claimRelease(sid), 2 * TRANCHE); // two tranches vested and drawn
        vm.warp(Periods.periodEnd(Q1_2026 + 1) + 5 * DAY);
        uint256 vestedUnclaimed = treasury.claimable(sid); // tranche 3? not yet (vests at +180 days)
        assertEq(vestedUnclaimed, 0);

        uint256 fees = usdc.balanceOf(address(feeCollector));
        uint256 issuerBalance = usdc.balanceOf(issuer);
        bytes32 dg = MercesMessages.extinguishDigest(domain, sid, 0);
        // one attestor is not enough, even signing twice; an unregistered key never counts
        vm.expectRevert(SameAttestor.selector);
        vault.extinguish(sid, sign(attestorKey, dg), sign(attestorKey, dg));
        vm.expectRevert(abi.encodeWithSelector(InvalidAttestorSignature.selector, vm.addr(0xBAD)));
        vault.extinguish(sid, sign(attestorKey, dg), sign(0xBAD, dg));
        vm.prank(keeper);
        vault.extinguish(sid, sign(attestorKey, dg), sign(attestor2Key, dg));

        assertEq(registry.getSeriesCore(sid).terminalStatus, uint8(SeriesStatus.Extinguished));
        (uint64 due,) = income.openDue(sid);
        assertEq(due, 0, "open dues cleared");
        assertEq(usdc.balanceOf(address(treasury)), 0, "unreleased funds left the treasury");
        assertEq(vault.getLedger(sid).unreleasedReceived, 2 * TRANCHE);
        assertEq(usdc.balanceOf(address(feeCollector)), fees, "no fee on the unreleased funds");
        // nothing else is owed: no payment, report, true-up, release or redemption can be demanded or made
        vm.expectRevert(NothingDue.selector);
        income.pay(sid);
        vm.warp(vm.getBlockTimestamp() + 365 * DAY);
        vm.prank(issuer);
        vm.expectRevert(TerminalStatus.selector);
        income.submitReport(reportInput(sid, Q1_2026 + 2, Proofs.q3zero(), 2, false));
        vm.prank(issuer);
        vm.expectRevert(NothingVested.selector);
        treasury.claimRelease(sid);
        assertEq(usdc.balanceOf(issuer), issuerBalance);

        // holders share the unreleased 15,000 pro rata (5,000 each for 100 of 300 units) plus their payouts
        address[3] memory holders = [b1, b2, b3];
        for (uint256 i = 0; i < 3; i++) {
            uint256 pending = vault.pendingOf(sid, holders[i]);
            assertEq(vault.claimableFinal(sid, holders[i]), 5_000e6);
            uint256 before = usdc.balanceOf(holders[i]);
            vm.prank(holders[i]);
            vault.claimFinal(sid);
            assertEq(usdc.balanceOf(holders[i]) - before, pending + 5_000e6);
            assertEq(unitToken(sid).balanceOf(holders[i]), 0);
        }
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(unitToken(sid).totalSupply(), 0);
    }

    // ================================================================ C11 §7

    /// @notice C11 §7: charter-relevant fields have no upgrade path; only issuer-favourable amendments exist (C4).
    /// The registry (which holds every charter field) is not a proxy and has no upgrade entry point; every
    /// registry write other than `amendTerms` leaves a live series' charter terms bit-identical; an upgrade of the
    /// money code through the timelock cannot reach them; and amendments only lower the cap.
    function test_C11_7_charterFieldsHaveNoUpgradePath() public {
        // the registry is a plain contract: no ERC-1967 implementation slot, no upgrade or ownership-transfer hook
        assertEq(vm.load(address(registry), ERC1967_IMPLEMENTATION_SLOT), bytes32(0));
        string[] memory fns = AbiScan.functionNames(AbiScan.abiText("MercesRegistry"));
        assertFalse(AbiScan.contains(fns, "upgradeToAndCall"));
        assertFalse(AbiScan.contains(fns, "upgradeTo"));
        assertFalse(AbiScan.contains(fns, "proxiableUUID"));
        // the money contracts are proxies (upgradeable after the timelock delay) but hold no charter field
        assertTrue(vm.load(address(vault), ERC1967_IMPLEMENTATION_SLOT) != bytes32(0));

        uint256 sid = runStandardRaise();
        bytes32 snapshot = _charter(sid);

        // every other registry write, by every role
        vm.startPrank(admin);
        Parameters memory p = defaultParameters();
        p.capMultipleWad = 3e18;
        p.payoutFeeBps = 100;
        p.lockupSeconds = 1;
        p.walletCapBps = 5000;
        registry.setDefaults(p);
        registry.setFlags(true, true, true);
        registry.setFeeCollector(stranger);
        registry.setAllowlistManager(stranger);
        registry.registerAttestor(makeAddr("attestor3"));
        registry.rotateAttestor(attestor2, makeAddr("attestor4"));
        registry.registerVerifierKey(makeAddr("verifier2"));
        registry.revokeVerifierKey(verifier);
        registry.setFxPair(keccak256("EUR/USD"), false, address(0));
        registry.deactivateIssuer(issuer);
        vm.stopPrank();
        vm.prank(stranger);
        registry.setAllowed(b1, false);
        vm.startPrank(issuer);
        vm.expectRevert(); // the contract hash is write-once, in Draft only
        registry.setContractHash(sid, keccak256("another contract"));
        registry.stopIssuance();
        vm.stopPrank();
        assertEq(_charter(sid), snapshot, "charter terms changed by a non-amendment write");

        // a money-code upgrade through the timelock (the only upgrade path) cannot reach the registry's terms
        address newImpl = address(new MercesVault());
        bytes memory call = abi.encodeWithSignature("upgradeToAndCall(address,bytes)", newImpl, "");
        vm.startPrank(admin);
        timelock.schedule(address(vault), 0, call, bytes32(0), bytes32(0), 1 days);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        timelock.execute(address(vault), 0, call, bytes32(0), bytes32(0));
        vm.stopPrank();
        assertEq(address(uint160(uint256(vm.load(address(vault), ERC1967_IMPLEMENTATION_SLOT)))), newImpl, "upgraded");
        assertEq(_charter(sid), snapshot, "charter terms changed by an upgrade");
        vm.prank(admin);
        vm.expectRevert(); // and never without the timelock
        vault.upgradeToAndCall(newImpl, "");

        // amendments: a higher cap is refused; a lower one (issuer + attestor) changes the cap and commitment only
        bytes32 newCommitment = bytes32(uint256(0xC0FFEE));
        bytes memory up = sign(attestorKey, MercesMessages.amendDigest(domain, sid, 0, newCommitment, 2.6e18));
        vm.prank(issuer);
        vm.expectRevert(UnfavourableAmendment.selector);
        registry.amendTerms(sid, newCommitment, 2.6e18, up, noTier1());
        bytes memory down = sign(attestorKey, MercesMessages.amendDigest(domain, sid, 0, newCommitment, 2.2e18));
        vm.prank(issuer);
        registry.amendTerms(sid, newCommitment, 2.2e18, down, noTier1());
        SeriesTerms memory t = registry.getSeriesTerms(sid);
        assertEq(t.capMultipleWad, 2.2e18);
        assertEq(registry.getSeriesCore(sid).termsCommitment, newCommitment);
        t.capMultipleWad = 2.5e18; // everything else is unchanged
        assertEq(keccak256(abi.encode(t)), keccak256(abi.encode(_snapshotTerms)));
    }

    SeriesTerms internal _snapshotTerms;

    /// @dev Hash of every charter field of a series (SPEC §3.1 "charter terms" block, the amendable commitment and
    /// the raise results the protocol writes once).
    function _charter(uint256 sid) internal returns (bytes32) {
        SeriesCore memory c = registry.getSeriesCore(sid);
        SeriesTerms memory t = registry.getSeriesTerms(sid);
        _snapshotTerms = t;
        ReleaseTranche[] memory s = registry.getReleaseSchedule(sid);
        bytes memory identity =
            abi.encode(c.issuer, c.mode, c.stablecoin, c.stablecoinDecimals, c.tierFlags, c.fxPairId, c.contractHash);
        bytes memory results = abi.encode(
            c.issuerAcceptsPublicPrice,
            c.termsCommitment,
            c.amendmentNonce,
            c.unitToken,
            c.settlementTs,
            c.unitsSold,
            c.clearingPrice
        );
        return keccak256(abi.encode(t, s, identity, results, registry.getRouterTerms(sid)));
    }
}
