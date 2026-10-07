/**
 * End-to-end graduation against a local `solana-test-validator` running the real program binaries
 * shipped as test fixtures with the pinned SDK (`dynamic_bonding_curve.so`, `cp_amm.so`, `locker.so`,
 * `local`-feature builds whose admin check accepts any signer). This is the closest offline stand-in for
 * the devnet run described in docs/meteora/DEVNET_RUNBOOK.md: every instruction the script sends on devnet
 * is executed here by the same program code.
 *
 * Skipped unless a validator binary and the fixtures are present (or MERCES_LOCAL_VALIDATOR=0 disables it):
 *   SOLANA_TEST_VALIDATOR   path to solana-test-validator (default: PATH, then ~/.local/share/solana/install/...)
 *   DBC_FIXTURES_DIR        directory with the .so fixtures (default: the SDK clone used by the research memo)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  ActivationType as SdkActivationType,
  CollectFeeMode as SdkCollectFeeMode,
  createDammV2Program,
  DAMM_V2_PROGRAM_ID,
  DammV2BaseFeeMode as SdkDammV2BaseFeeMode,
  deriveDbcPoolAuthority,
  MAX_SQRT_PRICE as SDK_MAX_SQRT_PRICE,
  MIN_SQRT_PRICE as SDK_MIN_SQRT_PRICE,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { buildMercesCurveConfig } from "../src/config.js";
import { DBC_PROGRAM_ID, LOCKER_PROGRAM_ID, MIGRATION_FEE_OPTION_BPS, USDC_MINT_MAINNET } from "../src/constants.js";
import { formatReport, loadState, runGraduation, type GraduationReport } from "../src/graduation.js";
import { readPoolProgress } from "../src/state.js";
import { bpsToFeeNumerator } from "../src/math.js";
import { confirmSignature, sendAndConfirm } from "../src/cli.js";

const USDC = 1_000_000n;

function findValidator(): string | null {
  const env = process.env["SOLANA_TEST_VALIDATOR"];
  if (env && existsSync(env)) return env;
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    const p = join(dir, "solana-test-validator");
    if (dir && existsSync(p)) return p;
  }
  const home = join(homedir(), ".local/share/solana/install");
  for (const rel of ["active_release/bin/solana-test-validator", "releases/3.1.10/solana-release/bin/solana-test-validator"]) {
    const p = join(home, rel);
    if (existsSync(p)) return p;
  }
  if (existsSync(join(home, "releases"))) {
    for (const rel of readdirSync(join(home, "releases"))) {
      const p = join(home, "releases", rel, "solana-release/bin/solana-test-validator");
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const FIXTURES = process.env["DBC_FIXTURES_DIR"] ?? "/home/user/meteoraag/dynamic-bonding-curve-sdk/packages/dynamic-bonding-curve/tests/fixtures";
const VALIDATOR = findValidator();
const ENABLED =
  process.env["MERCES_LOCAL_VALIDATOR"] !== "0" &&
  VALIDATOR !== null &&
  ["dynamic_bonding_curve.so", "cp_amm.so", "locker.so"].every((f) => existsSync(join(FIXTURES, f)));

async function waitForValidator(connection: Connection, child: ChildProcess, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`solana-test-validator exited with code ${child.exitCode}`);
    try {
      await connection.getLatestBlockhash("confirmed");
      // one more second so the faucet/airdrop path is ready too
      await new Promise((r) => setTimeout(r, 1_000));
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`validator did not come up in ${timeoutMs}ms: ${String(lastErr)}`);
}

async function airdrop(connection: Connection, to: PublicKey, sol: number): Promise<void> {
  const bh = await connection.getLatestBlockhash("confirmed");
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await confirmSignature(connection, sig, bh.lastValidBlockHeight);
}

/**
 * Create a DAMM v2 migration config equivalent to Meteora's `FixedBps100` key (cliff fee 100 bps, no schedule,
 * full price range, timestamp activation, `pool_creator_authority` = DBC pool authority,
 * `CreatePoolWithoutMintValidation` permission) — the same recipe as the SDK's own localnet test
 * (dynamic-bonding-curve-sdk tests/utils/tokenBadgeFlow.ts:180-258). On devnet the real key exists already.
 */
async function createLocalDammV2Config(connection: Connection, admin: Keypair, feeBps: number): Promise<PublicKey> {
  const program = createDammV2Program(connection, "confirmed");
  const [operator] = PublicKey.findProgramAddressSync([Buffer.from("operator"), admin.publicKey.toBuffer()], DAMM_V2_PROGRAM_ID);
  const createOperatorTx = await program.methods
    .createOperatorAccount(new BN(1)) // CreateConfigKey permission bit 0
    .accountsPartial({ operator, whitelistedAddress: admin.publicKey, signer: admin.publicKey, payer: admin.publicKey })
    .transaction();
  await sendAndConfirm(connection, createOperatorTx, [admin], "damm v2 create_operator_account");
  const index = new BN(Keypair.generate().publicKey.toBuffer().subarray(0, 8), "le");
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config"), index.toArrayLike(Buffer, "le", 8)], DAMM_V2_PROGRAM_ID);
  const baseFeeData = program.coder.types.encode("borshFeeTimeScheduler", {
    cliffFeeNumerator: new BN(bpsToFeeNumerator(feeBps).toString()),
    numberOfPeriod: 0,
    periodFrequency: new BN(0),
    reductionFactor: new BN(0),
    baseFeeMode: SdkDammV2BaseFeeMode.FeeTimeSchedulerLinear,
  });
  const createConfigTx = await program.methods
    .createConfig(index, {
      poolFees: { baseFee: { data: Array.from(baseFeeData) }, compoundingFeeBps: 0, padding: 0, dynamicFee: null },
      sqrtMinPrice: SDK_MIN_SQRT_PRICE,
      sqrtMaxPrice: SDK_MAX_SQRT_PRICE,
      vaultConfigKey: PublicKey.default,
      poolCreatorAuthority: deriveDbcPoolAuthority(),
      activationType: SdkActivationType.Timestamp,
      collectFeeMode: SdkCollectFeeMode.QuoteToken,
      permission: new BN(1), // CreatePoolWithoutMintValidation
    })
    .accountsPartial({ config, operator, signer: admin.publicKey, payer: admin.publicKey })
    .transaction();
  await sendAndConfirm(connection, createConfigTx, [admin], "damm v2 create_config");
  return config;
}

describe.skipIf(!ENABLED)("local validator: end-to-end graduation with the real DBC, DAMM v2 and locker programs", () => {
  let child: ChildProcess | null = null;
  let ledger = "";
  let connection: Connection;
  let rpcPort = 0;
  const logLines: string[] = [];
  const log = (m: string) => logLines.push(m);

  beforeAll(async () => {
    ledger = mkdtempSync(join(tmpdir(), "merces-dbc-ledger-"));
    rpcPort = 18_000 + Math.floor(Math.random() * 10_000);
    const args = [
      "--reset",
      "--quiet",
      "--ledger",
      ledger,
      "--bind-address",
      "127.0.0.1",
      "--rpc-port",
      String(rpcPort),
      // the validator serves PubSub on rpc-port + 1, so keep the faucet and the dynamic range clear of it
      "--faucet-port",
      String(rpcPort + 3),
      "--dynamic-port-range",
      `${rpcPort + 10}-${rpcPort + 60}`,
      "--bpf-program",
      DBC_PROGRAM_ID,
      join(FIXTURES, "dynamic_bonding_curve.so"),
      "--bpf-program",
      DAMM_V2_PROGRAM_ID.toBase58(),
      join(FIXTURES, "cp_amm.so"),
      "--bpf-program",
      LOCKER_PROGRAM_ID,
      join(FIXTURES, "locker.so"),
    ];
    child = spawn(VALIDATOR!, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (d: Buffer) => logLines.push(`[validator] ${d.toString().trim()}`));
    connection = new Connection(`http://127.0.0.1:${rpcPort}`, { commitment: "confirmed", wsEndpoint: `ws://127.0.0.1:${rpcPort + 1}` });
    await waitForValidator(connection, child, 120_000);
  }, 180_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1_500));
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (ledger) rmSync(ledger, { recursive: true, force: true });
  });

  it("creates the config and pool, buys out the curve, locks the issuer allocation, migrates, and routes the fees", async () => {
    const admin = Keypair.generate();
    const payer = Keypair.generate(); // also Merces
    const issuer = Keypair.generate();
    for (const k of [admin, payer, issuer]) await airdrop(connection, k.publicKey, 100);

    // Local stand-in for Meteora's FixedBps100 DAMM v2 config key.
    const dammConfig = await createLocalDammV2Config(connection, admin, MIGRATION_FEE_OPTION_BPS[2]!);

    // A small series: income 400 USDC/yr, target 1,000 USDC (under the 3× cap), 100 units public, 10 units vesting to the issuer.
    const config = buildMercesCurveConfig({
      seriesLabel: "local-e2e",
      trailingAnnualIncome: 400n * USDC,
      targetRaise: 1_000n * USDC,
      unitsOnCurve: 100n,
      issuerUnits: 10n,
      issuerVesting: { cliffSeconds: 60, periods: 2, periodSeconds: 60 },
      quoteMint: USDC_MINT_MAINNET, // placeholder: replaced by the mock mint the script creates
      dammConfig: dammConfig.toBase58(),
    });
    expect(config.configParameters.migrationQuoteThreshold).toBe(1_000n * USDC);

    const stateDir = mkdtempSync(join(tmpdir(), "merces-graduation-"));
    const statePath = join(stateDir, "state.json");
    let report: GraduationReport;
    try {
      report = await runGraduation({
        connection,
        config,
        participants: { payer, issuer, merces: payer },
        statePath,
        createQuoteMint: true,
        buyers: 3,
        dammConfig,
        log,
      });
    } catch (e) {
      // surface the step log on failure
      throw new Error(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n--- log ---\n${logLines.slice(-60).join("\n")}`);
    }

    // --- graduated ---------------------------------------------------------------------------------
    expect(report.progress.isMigrated).toBe(true);
    expect(report.progress.migrationProgressName).toBe("CreatedPool");
    expect(report.progress.curveComplete).toBe(true);
    // PartialFill stops at the migration price; per-swap fee rounding (up) can leave a few lamports of surplus
    const X = config.configParameters.migrationQuoteThreshold;
    const swaps = loadState(statePath)!.txs["swaps"]!.length;
    expect(report.progress.quoteReserve >= X && report.progress.quoteReserve <= X + BigInt(swaps)).toBe(true);
    process.stdout.write(`${formatReport(report)}\n`);
    expect(report.dammV2).not.toBeNull();
    const damm = report.dammV2!;
    expect(new PublicKey(report.dammV2Pool).toBase58()).toBe(damm.pool);
    expect(damm.tokenAMint).toBe(report.baseMint);
    expect(damm.tokenBMint).toBe(report.quoteMint);

    // --- exact proceeds ------------------------------------------------------------------------------
    // Issuer: the creator migration fee, nothing else (99% of 1,000 USDC = 990 USDC).
    expect(BigInt(report.issuerQuoteReceived)).toBe(config.proceeds.creatorMigrationFee);
    expect(BigInt(report.issuerQuoteReceived)).toBe(990n * USDC);
    // Merces (= payer here): partner migration fee (0) + partner trading fees (1% fee, 80% LP share), minus the
    // test funds minted to the buyers come from the mint, not from Merces' ATA, so the delta is the fee income only.
    const mercesReceived = BigInt(report.mercesQuoteReceived);
    const est = config.proceeds.tradingFees.partner;
    expect(mercesReceived >= est - BigInt(swaps) * 2n && mercesReceived <= est + BigInt(swaps) * 2n).toBe(true);
    expect(report.progress.unclaimedFees.partnerQuote).toBe(0n);
    expect(report.progress.migrationFee.creatorWithdrawn).toBe(true);
    expect(report.progress.migrationFee.partnerWithdrawn).toBe(false); // nothing to withdraw: partner share is 0
    // The DAMM v2 pool holds the 1% that was not taken as migration fee, less Meteora's 0.2%.
    expect(damm.tokenBAmount <= config.proceeds.quoteForPoolNet).toBe(true);
    expect(damm.tokenBAmount >= config.proceeds.pool.quoteInPool - 2n).toBe(true);
    expect(damm.tokenAAmount <= config.derived.migrationBaseThreshold).toBe(true);
    expect(damm.tokenAAmount >= config.proceeds.pool.baseInPool - 2n).toBe(true);
    // Meteora's protocol liquidity migration fee is booked on the DBC pool.
    expect(report.progress.protocolMigrationFee.quote).toBe(config.proceeds.protocolLiquidityMigrationFeeQuote);

    // --- liquidity ownership: 100% permanently locked in the partner's position ------------------------
    expect(report.positions.first).not.toBeNull();
    expect(report.positions.first!.permanentLockedLiquidity).toBe(damm.liquidity);
    expect(report.positions.first!.unlockedLiquidity).toBe(0n);
    expect(damm.permanentLockLiquidity).toBe(damm.liquidity);
    expect(report.positions.second).toBeNull(); // the creator has no liquidity share, so no second position

    // --- issuer allocation sits in the locker escrow, leftover dust went to Merces --------------------
    expect(BigInt(report.baseBalances["lockerEscrow"]!)).toBe(config.derived.lockedVestingTotal);
    expect(report.progress.leftoverWithdrawn).toBe(true);
    // leftover = unsold buffer + per-swap base rounding dust + base the DAMM v2 deposit did not take
    const leftover = BigInt(report.baseBalances["merces(leftover)"]!);
    const leftoverLow = config.derived.swapBaseAmountWithBuffer - config.derived.swapBaseAmount;
    expect(leftover >= leftoverLow && leftover <= leftoverLow + config.proceeds.pool.baseLeftover + BigInt(swaps) + 2n).toBe(true);
    // buyers hold the public allocation (minus per-swap rounding dust)
    const buyerBase = Object.entries(report.baseBalances)
      .filter(([k]) => k.startsWith("buyer:"))
      .reduce((a, [, v]) => a + BigInt(v), 0n);
    expect(buyerBase <= config.derived.swapBaseAmount && buyerBase >= config.derived.swapBaseAmount - BigInt(swaps)).toBe(true);
    // conservation of base: holders + DAMM v2 vault + locker escrow + Merces leftover + what is left in the DBC vault
    // (Meteora's protocol migration base fee, claimable by Meteora only) = the fixed supply; nothing was burned (pre == post)
    const dbcBaseVault = BigInt(report.baseBalances["dbcBaseVault"]!);
    expect(dbcBaseVault).toBe(report.progress.protocolMigrationFee.base);
    expect(buyerBase + damm.tokenAAmount + config.derived.lockedVestingTotal + leftover + dbcBaseVault).toBe(config.derived.initialBaseSupply);

    // --- state reader agrees -------------------------------------------------------------------------
    const progress = await readPoolProgress(connection, new PublicKey(report.dbcPool), dammConfig);
    expect(progress.dammV2Pool).toBe(report.dammV2Pool);
    expect(progress.p0PerUnit).toBe(config.derived.p0PerUnit);

    // --- idempotent resume: a second run sends nothing and reproduces the report ---------------------
    const txCount = Object.values(loadState(statePath)!.txs).reduce((a, v) => a + v.length, 0);
    const again = await runGraduation({ connection, config, participants: { payer, issuer, merces: payer }, statePath, createQuoteMint: true, buyers: 3, dammConfig, log });
    expect(Object.values(loadState(statePath)!.txs).reduce((a, v) => a + v.length, 0)).toBe(txCount);
    expect(again.issuerQuoteReceived).toBe(report.issuerQuoteReceived);
    expect(again.mercesQuoteReceived).toBe(report.mercesQuoteReceived);
    expect(again.dammV2Pool).toBe(report.dammV2Pool);
    rmSync(stateDir, { recursive: true, force: true });
  }, 300_000);
});
