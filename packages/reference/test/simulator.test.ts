import { describe, it, expect } from "vitest";
import { ScenarioBuilder, USDC, usdc, ts } from "../src/vectors/builder.js";
import { WAD } from "@merces/sdk";

describe("simulator", () => {
  it("runs a raise, a zero report, a paid report and a claim; money and units are conserved", async () => {
    const b = new ScenarioBuilder("test_sim", "simulator smoke");
    b.key("attestor1", "attestor").key("verifier1", "verifier").actor("issuer", "b1", "b2");
    b.at(ts(2026, 1, 2));
    await b.step({ op: "register_attestor", key: "attestor1" });
    await b.step({ op: "register_verifier_key", key: "verifier1" });
    await b.step({ op: "allowlist", wallets: ["issuer", "b1", "b2"] });
    await b.step({ op: "register_issuer", wallet: "issuer" });
    for (const [a, amt] of [["issuer", 50_000], ["b1", 30_000], ["b2", 30_000]] as const) await b.fund(a, usdc(amt));
    const funded = b.sim.totalStable();
    await b.createSeries({ series: "S1", issuer: "issuer", plain: { theta: usdc(80_000), rWad: WAD / 10_000n, currencyCode: 840, indexingRule: 0 }, terms: { walletCapBps: 5000, minRaise: usdc(20_000) } });
    const p = await b.raise({ series: "S1", issuer: "issuer", openAt: ts(2026, 1, 5), bids: [{ actor: "b1", price: usdc(120), quantity: 100n }, { actor: "b2", price: usdc(110), quantity: 100n }] });
    expect(p).toBe(usdc(110));
    const s = b.sim.series.get("S1")!;
    expect(s.supply).toBe(200n);
    expect(s.treasury.proceeds).toBe(usdc(22_000));
    expect(b.sim.feeCollector).toBe(usdc(220));
    expect(b.sim.totalStable()).toBe(funded);
    b.at(ts(2026, 4, 2));
    const q1 = await b.report({ series: "S1", period: 2026 * 4, incomeYtd: usdc(40_000), tier: 2 });
    expect(q1.paymentUsd).toBe(0n);
    expect(s.ledger.lastPaidPeriod).toBe(2026 * 4);
    b.at(ts(2026, 7, 3));
    const q2 = await b.report({ series: "S1", period: 2026 * 4 + 1, incomeYtd: usdc(130_000), tier: 2 });
    // r × units = 1e14 × 200 = 2% of (130k − 80k) = 1,000 USDC
    expect(q2.paymentUsd).toBe(usdc(1_000));
    await b.step({ op: "pay", actor: "issuer", series: "S1" });
    expect(s.vaultBalance).toBe(usdc(950));
    expect(b.sim.feeCollector).toBe(usdc(220) + usdc(50));
    await b.step({ op: "claim", actor: "b1", series: "S1" });
    expect(b.sim.account("b1").stable).toBe(usdc(30_000) - usdc(11_110) + usdc(475)); // cost 11,000 + 1% fee, then the claim
    expect(b.sim.totalStable()).toBe(funded);
    b.sim.checkUnitSupply("S1");
    await b.revert({ op: "transfer_units", actor: "b1", series: "S1", to: "b2", units: "1" }, "DirectTransferForbidden");
    await b.revert({ op: "claim_release", actor: "b1", series: "S1" }, "NotIssuer");
    await b.step({ op: "claim_release", actor: "issuer", series: "S1" });
    expect(s.treasury.releasedTotal).toBe(usdc(11_000)); // two tranches vested (0 and 90 d)
    const snap = b.expect("S1");
    expect(snap.ledger!.unitsOutstanding).toBe("200");
    expect(snap.ledger!.status).toBe("OnTime");
    expect(snap.balances!["b1"]!.units).toBe("100");
    const v = b.build();
    expect(v.steps.length).toBe(b.steps.length);
    expect(v.keys["attestor1"]!.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(v.seriesPrivate["S1"]!.termsCommitment).toMatch(/^0x[0-9a-f]{64}$/);
    // re-running the recorded steps on a fresh simulator reproduces the snapshot
    const { Simulator } = await import("../src/sim/simulator.js");
    const sim2 = new Simulator();
    await sim2.run(v.steps);
    expect(sim2.serialize()).toBe(b.sim.serialize());
  });

  it("reverts leave the state untouched and name the right error", async () => {
    const b = new ScenarioBuilder("test_revert", "revert atomicity");
    b.actor("issuer", "b1");
    b.at(ts(2026, 1, 2));
    await b.step({ op: "allowlist", wallets: ["issuer", "b1"] });
    await b.step({ op: "register_issuer", wallet: "issuer" });
    await b.fund("b1", usdc(1_000));
    await b.createSeries({ series: "S1", issuer: "issuer", plain: { theta: usdc(80_000), rWad: WAD / 10_000n, currencyCode: 840, indexingRule: 0 }, contractHash: null });
    await b.revert({ op: "open_raise", actor: "issuer", series: "S1" }, "ContractHashMissing");
    await b.step({ op: "set_contract_hash", actor: "issuer", series: "S1", contractHash: b.salt("S1:contract") });
    await b.revert({ op: "commit_bid", actor: "b1", series: "S1", price: "1", quantity: "1", salt: b.salt("x"), escrow: "1" }, "RaiseNotOpen");
    await b.step({ op: "open_raise", actor: "issuer", series: "S1" });
    await b.revert({ op: "commit_bid", actor: "b1", series: "S1", price: "1", quantity: "1", salt: b.salt("x"), escrow: "0" }, "ZeroEscrow");
    await b.revert({ op: "commit_bid", actor: "nobody", series: "S1", price: "1", quantity: "1", salt: b.salt("x"), escrow: "1" }, "NotAllowlisted");
    await expect(b.revert({ op: "commit_bid", actor: "b1", series: "S1", price: "1", quantity: "1", salt: b.salt("x"), escrow: "1" }, "ZeroEscrow")).rejects.toThrow(/succeeded/);
    expect(b.sim.account("b1").stable).toBe(usdc(1_000) - 1n);
    expect(USDC).toBe(1_000_000n);
  });
});
