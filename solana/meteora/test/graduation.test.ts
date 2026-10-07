import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  createDbcProgram,
  DAMM_V2_PROGRAM_ID,
  deriveDammV2PoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  LOCKER_PROGRAM_ID,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { buildMercesCurveConfig } from "../src/config.js";
import { CREATOR_MIGRATION_FEE_MASK, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationProgress, PARTNER_MIGRATION_FEE_MASK, USDC_MINT_MAINNET } from "../src/constants.js";
import {
  buildBuyTx,
  buildClaimTradingFeeTx,
  buildCreateConfigTx,
  buildCreateLockerTx,
  buildCreatePoolTx,
  buildMigrateTx,
  buildWithdrawLeftoverTx,
  buildWithdrawMigrationFeeTx,
  checkQuoteMint,
  loadState,
  nextBuyAmount,
  planBuyerFunding,
  restoreKeypair,
  saveState,
  storeKeypair,
  verifyOnChainConfig,
  type GraduationState,
} from "../src/graduation.js";
import { parseArgs, resolveRpcUrl, formatQuote } from "../src/cli.js";
import { projectPoolProgress } from "../src/state.js";
import { encodeAccount, mintAccount, poolConfigObject, scenario, virtualPoolObject } from "./helpers/stub.js";
import { getIncludedFeeAmount } from "../src/math.js";

const USDC = 1_000_000n;
const CFG = buildMercesCurveConfig({
  seriesLabel: "stub",
  trailingAnnualIncome: 40_000n * USDC,
  targetRaise: 100_000n * USDC,
  unitsOnCurve: 10_000n,
  issuerUnits: 1_000n,
  quoteMint: USDC_MINT_MAINNET,
});

function decodeIx(connection: Parameters<typeof DynamicBondingCurveClient.create>[0], ix: TransactionInstruction) {
  const { program } = createDbcProgram(connection, "confirmed");
  const coder = program.coder.instruction as unknown as { decode(data: Buffer, encoding?: string): { name: string; data: unknown } | null };
  return coder.decode(ix.data);
}

function programIxs(ixs: TransactionInstruction[], program: PublicKey): TransactionInstruction[] {
  return ixs.filter((ix) => ix.programId.equals(program));
}

describe("transaction builders against a stub connection", () => {
  it("create_config: Merces is fee_claimer and leftover_receiver, the config keypair signs, parameters round-trip", async () => {
    const s = await scenario(CFG);
    const built = await buildCreateConfigTx({ client: DynamicBondingCurveClient.create(s.connection, "confirmed"), config: CFG, payer: s.payer, merces: s.merces, quoteMint: s.addresses.quoteMint }, s.configKeypair);
    expect(built.signers.map((k) => k.publicKey.toBase58())).toEqual([s.payer.publicKey.toBase58(), s.configKeypair.publicKey.toBase58()]);
    const [ix] = programIxs(built.transaction.instructions, DYNAMIC_BONDING_CURVE_PROGRAM_ID);
    expect(ix).toBeDefined();
    const decoded = decodeIx(s.connection, ix!);
    expect(decoded?.name).toBe("createConfig"); // Anchor decodes to camelCase
    const args = (decoded!.data as { configParameters: Record<string, unknown> }).configParameters;
    expect((args["migrationQuoteThreshold"] as BN).toString()).toBe(CFG.configParameters.migrationQuoteThreshold.toString());
    expect((args["sqrtStartPrice"] as BN).toString()).toBe(CFG.configParameters.sqrtStartPrice.toString());
    expect(args["tokenDecimal"]).toBe(6);
    expect(args["migrationOption"]).toBe(1);
    expect(args["migrationFee"]).toEqual({ feePercentage: 99, creatorFeePercentage: 100 });
    const curve = args["curve"] as { sqrtPrice: BN; liquidity: BN }[];
    expect(curve).toHaveLength(1);
    expect(curve[0]!.sqrtPrice.toString()).toBe(CFG.configParameters.curve[0]!.sqrtPrice.toString());
    // accounts: config (signer, writable), fee_claimer, leftover_receiver, quote_mint, payer (signer)
    const keys = ix!.keys;
    expect(keys[0]!.pubkey.equals(s.configKeypair.publicKey) && keys[0]!.isSigner).toBe(true);
    expect(keys[1]!.pubkey.equals(s.merces.publicKey)).toBe(true);
    expect(keys[2]!.pubkey.equals(s.merces.publicKey)).toBe(true);
    expect(keys[3]!.pubkey.equals(s.addresses.quoteMint)).toBe(true);
    expect(keys[4]!.pubkey.equals(s.payer.publicKey) && keys[4]!.isSigner).toBe(true);
  });

  it("initialize_virtual_pool_with_token2022: issuer is the creator and the base mint keypair signs", async () => {
    const s = await scenario(CFG);
    const client = DynamicBondingCurveClient.create(s.connection, "confirmed");
    const built = await buildCreatePoolTx({ client, payer: s.payer, issuer: s.issuer, tokenMetadata: { name: "Merces HEU", symbol: "HEU", uri: "https://x/y.json" } }, s.configKeypair.publicKey, s.baseMintKeypair);
    expect(built.signers.map((k) => k.publicKey.toBase58())).toEqual([s.payer.publicKey.toBase58(), s.issuer.publicKey.toBase58(), s.baseMintKeypair.publicKey.toBase58()]);
    const [ix] = programIxs(built.transaction.instructions, DYNAMIC_BONDING_CURVE_PROGRAM_ID);
    const decoded = decodeIx(s.connection, ix!);
    expect(decoded?.name).toBe("initializeVirtualPoolWithToken2022");
    expect(decoded!.data).toEqual({ params: { name: "Merces HEU", symbol: "HEU", uri: "https://x/y.json" } });
    const byKey = (pk: PublicKey) => ix!.keys.find((k) => k.pubkey.equals(pk));
    expect(byKey(s.issuer.publicKey)?.isSigner).toBe(true);
    expect(byKey(s.baseMintKeypair.publicKey)?.isSigner).toBe(true);
    expect(byKey(s.addresses.pool)?.isWritable).toBe(true);
    expect(byKey(deriveDbcTokenVaultAddress(s.addresses.pool, s.addresses.baseMint))).toBeDefined();
    expect(byKey(TOKEN_2022_PROGRAM_ID)).toBeDefined();
    expect(byKey(deriveDbcPoolAuthority())).toBeDefined();
  });

  it("swap2 PartialFill buy: creates ATAs idempotently and encodes amount/mode", async () => {
    const s = await scenario(CFG, { withPool: true });
    const client = DynamicBondingCurveClient.create(s.connection, "confirmed");
    const buyer = Keypair.generate();
    const built = await buildBuyTx({ client }, s.addresses.pool, buyer, 12_345n * USDC, 0n);
    const ataIxs = programIxs(built.transaction.instructions, ASSOCIATED_TOKEN_PROGRAM_ID);
    expect(ataIxs).toHaveLength(2); // quote in, base out
    const [ix] = programIxs(built.transaction.instructions, DYNAMIC_BONDING_CURVE_PROGRAM_ID);
    const decoded = decodeIx(s.connection, ix!);
    expect(decoded?.name).toBe("swap2");
    const params = (decoded!.data as { params: { amount0: BN; amount1: BN; swapMode: number } }).params;
    expect(params.amount0.toString()).toBe((12_345n * USDC).toString());
    expect(params.amount1.toString()).toBe("0");
    expect(params.swapMode).toBe(1); // PartialFill
    expect(ix!.keys.find((k) => k.pubkey.equals(buyer.publicKey))?.isSigner).toBe(true);
    expect(built.transaction.feePayer?.equals(buyer.publicKey)).toBe(true);
  });

  it("create_locker targets the locker program with the creator as recipient", async () => {
    const s = await scenario(CFG, { withPool: true, poolState: { migrationProgress: MigrationProgress.PostBondingCurve, quoteReserve: CFG.configParameters.migrationQuoteThreshold } });
    const client = DynamicBondingCurveClient.create(s.connection, "confirmed");
    const built = await buildCreateLockerTx({ client, payer: s.payer }, s.addresses.pool);
    const [ix] = programIxs(built.transaction.instructions, DYNAMIC_BONDING_CURVE_PROGRAM_ID);
    expect(decodeIx(s.connection, ix!)?.name).toBe("createLocker");
    expect(ix!.keys.some((k) => k.pubkey.equals(LOCKER_PROGRAM_ID))).toBe(true);
    expect(ix!.keys.some((k) => k.pubkey.equals(s.issuer.publicKey))).toBe(true);
    expect(programIxs(built.transaction.instructions, ASSOCIATED_TOKEN_PROGRAM_ID)).toHaveLength(1); // escrow ATA
  });

  it("migration_damm_v2 passes the DAMM v2 config as remaining account 0 and signs with both position NFT mints", async () => {
    const s = await scenario(CFG, { withPool: true, poolState: { migrationProgress: MigrationProgress.LockedVesting, quoteReserve: CFG.configParameters.migrationQuoteThreshold } });
    const client = DynamicBondingCurveClient.create(s.connection, "confirmed");
    const dammConfig = new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[2]!); // FixedBps100 = the Merces default
    const built = await buildMigrateTx({ client, payer: s.payer, dammConfig }, s.addresses.pool);
    const [ix] = programIxs(built.transaction.instructions, DYNAMIC_BONDING_CURVE_PROGRAM_ID);
    expect(decodeIx(s.connection, ix!)?.name).toBe("migrationDammV2");
    const last = ix!.keys[ix!.keys.length - 1]!;
    expect(last.pubkey.equals(dammConfig) && !last.isWritable && !last.isSigner).toBe(true);
    const signers = ix!.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58());
    expect(signers).toContain(s.payer.publicKey.toBase58());
    expect(signers).toContain(built.firstPositionNftMint.publicKey.toBase58());
    expect(signers).toContain(built.secondPositionNftMint.publicKey.toBase58());
    expect(built.signers).toHaveLength(3);
    const dammPool = deriveDammV2PoolAddress(dammConfig, s.addresses.baseMint, s.addresses.quoteMint);
    expect(ix!.keys.some((k) => k.pubkey.equals(dammPool))).toBe(true);
    expect(ix!.keys.some((k) => k.pubkey.equals(DAMM_V2_PROGRAM_ID))).toBe(true);
    // the SDK adds a compute budget instruction (600k CU)
    expect(built.transaction.instructions.some((i) => i.programId.toBase58() === "ComputeBudget111111111111111111111111111111")).toBe(true);
  });

  it("withdraw_migration_fee uses flag 1 for the creator (issuer) and 0 for the partner (Merces)", async () => {
    const s = await scenario(CFG, { withPool: true, poolState: { migrationProgress: MigrationProgress.CreatedPool, isMigrated: true, quoteReserve: CFG.configParameters.migrationQuoteThreshold } });
    const client = DynamicBondingCurveClient.create(s.connection, "confirmed");
    const creator = await buildWithdrawMigrationFeeTx({ client, payer: s.payer }, s.addresses.pool, "creator", s.issuer);
    const partner = await buildWithdrawMigrationFeeTx({ client, payer: s.payer }, s.addresses.pool, "partner", s.merces);
    for (const [built, flag, sender] of [
      [creator, 1, s.issuer],
      [partner, 0, s.merces],
    ] as const) {
      const [ix] = programIxs(built.transaction.instructions, DYNAMIC_BONDING_CURVE_PROGRAM_ID);
      const decoded = decodeIx(s.connection, ix!);
      expect(decoded?.name).toBe("withdrawMigrationFee");
      expect(decoded!.data).toEqual({ flag });
      expect(ix!.keys.find((k) => k.pubkey.equals(sender.publicKey))?.isSigner).toBe(true);
      expect(built.signers.map((k) => k.publicKey.toBase58())).toEqual([s.payer.publicKey.toBase58(), sender.publicKey.toBase58()]);
      // the sender's quote ATA is created when missing
      expect(programIxs(built.transaction.instructions, ASSOCIATED_TOKEN_PROGRAM_ID)).toHaveLength(1);
      expect(built.transaction.feePayer?.equals(s.payer.publicKey)).toBe(true);
    }
  });

  it("withdraw_leftover and claim_trading_fee build", async () => {
    const s = await scenario(CFG, { withPool: true, poolState: { migrationProgress: MigrationProgress.CreatedPool, isMigrated: true, quoteReserve: CFG.configParameters.migrationQuoteThreshold, partnerQuoteFee: 5n * USDC } });
    const client = DynamicBondingCurveClient.create(s.connection, "confirmed");
    const leftover = await buildWithdrawLeftoverTx({ client, payer: s.payer }, s.addresses.pool);
    expect(decodeIx(s.connection, programIxs(leftover.transaction.instructions, DYNAMIC_BONDING_CURVE_PROGRAM_ID)[0]!)?.name).toBe("withdrawLeftover");
    const claim = await buildClaimTradingFeeTx({ client, payer: s.payer }, s.addresses.pool, "partner", s.merces);
    const [ix] = programIxs(claim.transaction.instructions, DYNAMIC_BONDING_CURVE_PROGRAM_ID);
    const decoded = decodeIx(s.connection, ix!);
    expect(decoded?.name).toBe("claimTradingFee");
    const d = decoded!.data as { maxAmountA: BN; maxAmountB: BN };
    expect(d.maxAmountA.toString()).toBe("18446744073709551615");
    expect(d.maxAmountB.toString()).toBe("18446744073709551615");
  });

  it("the stub never needed anything beyond account reads", async () => {
    const s = await scenario(CFG, { withPool: true });
    expect(s.calls.every((c) => c.startsWith("getAccountInfo") || c.startsWith("getMultipleAccountsInfo"))).toBe(true);
  });
});

describe("on-chain verification and state projection", () => {
  it("verifyOnChainConfig accepts the program's stored form and rejects a mismatch", async () => {
    const s = await scenario(CFG);
    const client = DynamicBondingCurveClient.create(s.connection, "confirmed");
    const onChain = await client.state.getPoolConfig(s.configKeypair.publicKey);
    expect(onChain).not.toBeNull();
    verifyOnChainConfig({ config: CFG, merces: s.merces, quoteMint: s.addresses.quoteMint }, onChain!);
    const other = { ...onChain!, migrationSqrtPrice: onChain!.migrationSqrtPrice.addn(1) };
    expect(() => verifyOnChainConfig({ config: CFG, merces: s.merces, quoteMint: s.addresses.quoteMint }, other)).toThrow(/migration_sqrt_price/);
    expect(() => verifyOnChainConfig({ config: CFG, merces: s.payer, quoteMint: s.addresses.quoteMint }, onChain!)).toThrow(/fee_claimer/);
  });

  it("projectPoolProgress reports progress, P0 and the migration fee split", async () => {
    const X = CFG.configParameters.migrationQuoteThreshold;
    const s = await scenario(CFG, { withPool: true, poolState: { quoteReserve: X / 4n, sqrtPrice: CFG.configParameters.sqrtStartPrice + 1n } });
    const client = DynamicBondingCurveClient.create(s.connection, "confirmed");
    const pool = (await client.state.getPool(s.addresses.pool))!;
    const config = (await client.state.getPoolConfig(s.configKeypair.publicKey))!;
    const p = projectPoolProgress(s.addresses.pool, pool, config);
    expect(p.progressBps).toBe(2_500);
    expect(p.curveComplete).toBe(false);
    expect(p.p0PerUnit).toBe(CFG.derived.p0PerUnit);
    expect(p.migrationFee).toEqual({ total: 99_000n * USDC, creator: 99_000n * USDC, partner: 0n, creatorWithdrawn: false, partnerWithdrawn: false });
    expect(p.dammConfig).toBe(DAMM_V2_MIGRATION_FEE_ADDRESS[2]);
    expect(p.dammV2Pool).toBe(deriveDammV2PoolAddress(new PublicKey(DAMM_V2_MIGRATION_FEE_ADDRESS[2]!), s.addresses.baseMint, s.addresses.quoteMint).toBase58());
    expect(p.pricePerUnit.start).toBe(CFG.anchoring.startPricePerUnit);
    expect(p.pricePerUnit.migration).toBe(CFG.anchoring.migrationPricePerUnit);
    expect(p.initialBaseSupply).toBe(CFG.derived.initialBaseSupply);
    // after completion + both withdrawals
    const done = virtualPoolObject(CFG, s.addresses, { quoteReserve: X + 7n, migrationProgress: MigrationProgress.CreatedPool, isMigrated: true, migrationFeeWithdrawStatus: CREATOR_MIGRATION_FEE_MASK | PARTNER_MIGRATION_FEE_MASK, isWithdrawLeftover: true });
    s.accounts.set(s.addresses.pool, await encodeAccount(s.connection, "virtualPool", done));
    const p2 = projectPoolProgress(s.addresses.pool, (await client.state.getPool(s.addresses.pool))!, config, Keypair.generate().publicKey);
    expect(p2.curveComplete && p2.isMigrated && p2.leftoverWithdrawn).toBe(true);
    expect(p2.progressBps).toBe(10_000);
    expect(p2.surplus.total).toBe(7n);
    expect(p2.migrationFee.creatorWithdrawn && p2.migrationFee.partnerWithdrawn).toBe(true);
    expect(p2.migrationProgressName).toBe("CreatedPool");
  });

  it("the stub PoolConfig encodes to the program's 1040-byte layout (+8 discriminator)", async () => {
    const s = await scenario(CFG);
    const info = s.accounts.map.get(s.configKeypair.publicKey.toBase58())!;
    expect(info.data.length).toBe(1048);
    const poolInfo = await encodeAccount(s.connection, "virtualPool", virtualPoolObject(CFG, s.addresses));
    expect(poolInfo.data.length).toBe(424);
    expect(poolConfigObject(CFG, s.addresses).curve).toHaveLength(20);
  });
});

describe("buy planning and quote mint checks", () => {
  it("planBuyerFunding covers the gross raise plus a 2% margin", () => {
    const { perBuyer, total, gross } = planBuyerFunding(CFG, 3);
    const { included } = getIncludedFeeAmount(CFG.configParameters.poolFees.baseFee.cliffFeeNumerator, CFG.configParameters.migrationQuoteThreshold);
    expect(gross).toBe(included);
    expect(total >= (included * 102n) / 100n).toBe(true);
    expect(perBuyer * 3n).toBe(total);
    expect(() => planBuyerFunding(CFG, 0)).toThrow();
  });
  it("nextBuyAmount finishes the curve with a margin, respects caps, and is zero when complete", async () => {
    const X = CFG.configParameters.migrationQuoteThreshold;
    const fee = CFG.configParameters.poolFees.baseFee.cliffFeeNumerator;
    const s = await scenario(CFG, { withPool: true, poolState: { quoteReserve: X - 1_000n * USDC } });
    const client = DynamicBondingCurveClient.create(s.connection, "confirmed");
    const p = projectPoolProgress(s.addresses.pool, (await client.state.getPool(s.addresses.pool))!, (await client.state.getPoolConfig(s.configKeypair.publicKey))!);
    const amount = nextBuyAmount(p, fee, 10_000n * USDC, 50_000n * USDC);
    // enough gross so that the net reaches the remaining 1,000 USDC + 1% margin
    expect(amount > getIncludedFeeAmount(fee, 1_000n * USDC).included).toBe(true);
    expect(amount < 1_030n * USDC).toBe(true);
    expect(nextBuyAmount(p, fee, 500n * USDC, 50_000n * USDC)).toBe(500n * USDC); // capped by balance
    expect(nextBuyAmount(p, fee, 10_000n * USDC, 300n * USDC)).toBe(300n * USDC); // capped by maxBuy
    expect(nextBuyAmount({ ...p, quoteReserve: X }, fee, 10n, 10n)).toBe(0n);
  });
  it("checkQuoteMint mirrors the program's quote-mint rule", () => {
    const mint = Keypair.generate().publicKey;
    const spl = mintAccount(6, TOKEN_PROGRAM_ID, null);
    const r = checkQuoteMint(spl.data, spl.owner, mint);
    expect(r).toMatchObject({ decimals: 6, permissionless: true, transferFeeZero: true });
    expect(r.tokenProgram.equals(TOKEN_PROGRAM_ID)).toBe(true);
    const t22 = mintAccount(6, TOKEN_2022_PROGRAM_ID, null);
    expect(checkQuoteMint(t22.data, t22.owner, mint).tokenProgram.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(() => checkQuoteMint(spl.data, SystemProgram.programId, mint)).toThrow(/not owned by a token program/);
  });
});

describe("state file and CLI helpers", () => {
  it("state round-trips, keypairs restore, resume guards are data", () => {
    const dir = mkdtempSync(join(tmpdir(), "merces-meteora-"));
    try {
      const path = join(dir, "nested", "state.json");
      expect(loadState(path)).toBeNull();
      const k = Keypair.generate();
      const state: GraduationState = {
        schema: "merces.meteora.graduation-state/1",
        createdAt: "2026-10-07T00:00:00.000Z",
        updatedAt: "2026-10-07T00:00:00.000Z",
        rpcUrl: "http://127.0.0.1:8899",
        genesisHash: "g",
        configHash: CFG.configHash,
        payer: "p",
        issuer: "i",
        merces: "m",
        buyers: [storeKeypair(k)],
        txs: { swaps: ["sig1"] },
      };
      saveState(path, state);
      const loaded = loadState(path)!;
      expect(loaded.buyers).toHaveLength(1);
      expect(restoreKeypair(loaded.buyers[0]!).publicKey.equals(k.publicKey)).toBe(true);
      expect(loaded.txs["swaps"]).toEqual(["sig1"]);
      expect(() => restoreKeypair({ ...loaded.buyers[0]!, publicKey: Keypair.generate().publicKey.toBase58() })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("parseArgs and resolveRpcUrl", () => {
    const a = parseArgs(["--cluster", "devnet", "--buyers=4", "--json", "--payer", "p.json", "pos"]);
    expect(a.flags).toEqual({ cluster: "devnet", buyers: "4", json: true, payer: "p.json" });
    expect(a.positional).toEqual(["pos"]);
    expect(resolveRpcUrl("devnet", undefined)).toBe("https://api.devnet.solana.com");
    expect(resolveRpcUrl("localnet", undefined)).toBe("http://127.0.0.1:8899");
    expect(resolveRpcUrl(undefined, "http://my-rpc:8899")).toBe("http://my-rpc:8899");
    expect(() => resolveRpcUrl("mainnet-beta", undefined)).toThrow(/refusing mainnet/);
    expect(() => resolveRpcUrl(undefined, "https://api.mainnet-beta.solana.com")).toThrow(/refusing/);
    expect(formatQuote(1_234_567n)).toBe("1.234567");
    expect(formatQuote(-5n)).toBe("-0.000005");
  });
});
