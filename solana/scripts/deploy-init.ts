/**
 * Post-deployment initialisation of the Merces Solana programs (called by deploy.sh).
 *
 *   node --import tsx scripts/deploy-init.ts --cluster <localnet|devnet|testnet> --url <rpc> --keypair <path>
 *        [--admin <pk>] [--allowlist-manager <pk>] [--fee-collector <pk>] [--curve-quote-mint <pk>] [--verify]
 *
 * Without --verify: creates the mock stablecoins (a classic SPL "USDC" and a Token-2022 "USDG" with
 * TransferHook → mock_usdg_hook, TransferFeeConfig 0 bps / 0 max and MetadataPointer, both 6
 * decimals; ASSUMPTIONS A24), the mock hook's extra-account-meta list, the fee collector's token
 * accounts, and calls merces_registry::init_protocol with the SPEC §1.6 defaults,
 * `protocol_program = merces_protocol` and `curve_quote_mint` (the cluster's USDC for curve-mode
 * series, SPEC §9: `--curve-quote-mint`, default the mock USDC). Idempotent: existing mints and an existing ProtocolConfig
 * are reused (and checked). With --verify: reads everything back from the chain (program upgrade
 * authorities included) and writes solana/deployments/<cluster>.json.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
  getTransferFeeConfig,
  getTransferHook,
} from "@solana/spl-token";
import { BorshCoder, type Idl } from "@anchor-lang/core";
import BN from "bn.js";

const here = dirname(fileURLToPath(import.meta.url));
const solanaDir = join(here, "..");

type Cluster = "localnet" | "devnet" | "testnet";
/** SPEC §1.3 cluster tags (mainnet-beta 101 is never used by these scripts). */
const CHAIN_IDS: Record<Cluster, number> = { testnet: 102, devnet: 103, localnet: 104 };

/** SPEC §1.6 defaults (identical to merces_common::params::Parameters::DEFAULT). */
const DAY = 86_400;
const DEFAULTS = {
  cap_multiple_wad: new BN("2500000000000000000"),
  hurdle_rate_wad: new BN("80000000000000000"),
  payout_multiple_k: 5,
  lockup_seconds: new BN(47_336_400),
  wallet_cap_bps: 1_000,
  auction_fee_bps: 100,
  payout_fee_bps: 500,
  window_fee_bps: 100,
  non_reveal_charge_bps: 100,
  commit_duration: new BN(7 * DAY),
  reveal_duration: new BN(2 * DAY),
  window_commit_duration: new BN(3 * DAY),
  window_reveal_duration: new BN(DAY),
  fx_min_coverage_bps: 8_000,
  fx_max_staleness_seconds: new BN(3_600),
  fx_max_conf_bps: 100,
  fx_deviation_band_bps: 200,
  max_pause_seconds: new BN(31_536_000),
  max_cumulative_pause_seconds: new BN(63_072_000),
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadKeypair(path: string): Keypair {
  const p = path.startsWith("~") ? join(process.env.HOME ?? "", path.slice(1)) : path;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

function idl(name: string): Idl {
  return JSON.parse(readFileSync(join(solanaDir, "idls", `${name}.json`), "utf8")) as Idl;
}

function programId(name: string): PublicKey {
  return loadKeypair(join(solanaDir, "keys", `${name}-keypair.json`)).publicKey;
}

async function send(conn: Connection, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = []): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, [payer, ...signers], { commitment: "confirmed" });
}

interface Deployment {
  cluster: Cluster;
  rpc: string;
  chainId: number;
  deployer: string;
  initializedAt?: string;
  verifiedAt?: string;
  programs: Record<string, { id: string; upgradeAuthority: string | null; soSha256?: string }>;
  registry: { config: string; registryAuthority: string; domain: string; admin: string; allowlistManager: string; feeCollector: string; curveQuoteMint?: string };
  stablecoins: Record<string, { mint: string; program: string; decimals: number; mintAuthority: string; feeCollectorAccount: string }>;
}

async function main(): Promise<void> {
  const cluster = arg("cluster") as Cluster;
  if (!(cluster in CHAIN_IDS)) throw new Error("--cluster must be localnet, devnet or testnet");
  const url = arg("url") ?? "http://127.0.0.1:8899";
  if (url.includes("mainnet")) throw new Error("refusing mainnet");
  const payer = loadKeypair(arg("keypair") ?? "~/.config/solana/id.json");
  const conn = new Connection(url, "confirmed");
  const outDir = join(solanaDir, "deployments");
  const outFile = join(outDir, `${cluster}.json`);
  const previous: Partial<Deployment> = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};

  const registryId = programId("merces_registry");
  const protocolId = programId("merces_protocol");
  const hookId = programId("merces_hook");
  const mockHookId = programId("mock_usdg_hook");
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], registryId);
  const [registryAuthority] = PublicKey.findProgramAddressSync([Buffer.from("registry_authority")], protocolId);
  const registryCoder = new BorshCoder(idl("merces_registry"));
  const mockHookCoder = new BorshCoder(idl("mock_usdg_hook"));

  if (process.argv.includes("--verify")) {
    await verify(conn, cluster, url, payer, previous, outFile, { registryId, protocolId, hookId, mockHookId, config, registryAuthority, registryCoder });
    return;
  }

  const admin = new PublicKey(arg("admin") ?? payer.publicKey.toBase58());
  const allowlistManager = new PublicKey(arg("allowlist-manager") ?? payer.publicKey.toBase58());
  const feeCollector = new PublicKey(arg("fee-collector") ?? payer.publicKey.toBase58());

  // ---- mock USDC (classic SPL)
  let usdc = previous.stablecoins?.usdc ? new PublicKey(previous.stablecoins.usdc.mint) : null;
  if (!usdc || !(await conn.getAccountInfo(usdc))) {
    const mint = Keypair.generate();
    const rent = await conn.getMinimumBalanceForRentExemption(82);
    await send(conn, payer, [
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: 82, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null, TOKEN_PROGRAM_ID),
    ], [mint]);
    usdc = mint.publicKey;
    console.log(`mock USDC ${usdc.toBase58()}`);
  }

  // ---- mock USDG (Token-2022: TransferHook → mock_usdg_hook, TransferFeeConfig 0/0, MetadataPointer)
  let usdg = previous.stablecoins?.usdg ? new PublicKey(previous.stablecoins.usdg.mint) : null;
  if (!usdg || !(await conn.getAccountInfo(usdg))) {
    const mint = Keypair.generate();
    const exts = [ExtensionType.TransferHook, ExtensionType.TransferFeeConfig, ExtensionType.MetadataPointer];
    const space = getMintLen(exts);
    const rent = await conn.getMinimumBalanceForRentExemption(space);
    await send(conn, payer, [
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space, programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeTransferHookInstruction(mint.publicKey, payer.publicKey, mockHookId, TOKEN_2022_PROGRAM_ID),
      createInitializeTransferFeeConfigInstruction(mint.publicKey, payer.publicKey, payer.publicKey, 0, BigInt(0), TOKEN_2022_PROGRAM_ID),
      createInitializeMetadataPointerInstruction(mint.publicKey, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
      createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ], [mint]);
    usdg = mint.publicKey;
    console.log(`mock USDG ${usdg.toBase58()}`);
  }
  const [extraMetas] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), usdg.toBuffer()], mockHookId);
  if (!(await conn.getAccountInfo(extraMetas))) {
    await send(conn, payer, [
      new TransactionInstruction({
        programId: mockHookId,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: extraMetas, isSigner: false, isWritable: true },
          { pubkey: usdg, isSigner: false, isWritable: false },
          { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: mockHookCoder.instruction.encode("initialize_extra_account_meta_list", {}),
      }),
    ]);
  }

  // the only quote mint of curve-mode series (SPEC §9): the cluster's USDC, by default the mock
  const curveQuoteMint = new PublicKey(arg("curve-quote-mint") ?? usdc.toBase58());

  // ---- fee collector token accounts (process_bid / pay / route pay fees into them)
  await send(conn, payer, [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, getAssociatedTokenAddressSync(usdc, feeCollector, true, TOKEN_PROGRAM_ID), feeCollector, usdc, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, getAssociatedTokenAddressSync(usdg, feeCollector, true, TOKEN_2022_PROGRAM_ID), feeCollector, usdg, TOKEN_2022_PROGRAM_ID),
  ]);

  // ---- init_protocol (once)
  if (!(await conn.getAccountInfo(config))) {
    const data = registryCoder.instruction.encode("init_protocol", {
      args: {
        admin,
        allowlist_manager: allowlistManager,
        fee_collector: feeCollector,
        chain_id: new BN(CHAIN_IDS[cluster]),
        defaults: DEFAULTS,
        protocol_program: protocolId,
        curve_quote_mint: curveQuoteMint,
      },
    });
    await send(conn, payer, [
      new TransactionInstruction({
        programId: registryId,
        keys: [
          { pubkey: config, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }),
    ]);
    console.log(`init_protocol: config ${config.toBase58()}`);
  } else {
    console.log(`ProtocolConfig already initialised at ${config.toBase58()}`);
  }

  const deployment: Deployment = {
    cluster,
    rpc: url,
    chainId: CHAIN_IDS[cluster],
    deployer: payer.publicKey.toBase58(),
    initializedAt: new Date().toISOString(),
    programs: {},
    registry: { config: config.toBase58(), registryAuthority: registryAuthority.toBase58(), domain: "", admin: admin.toBase58(), allowlistManager: allowlistManager.toBase58(), feeCollector: feeCollector.toBase58(), curveQuoteMint: curveQuoteMint.toBase58() },
    stablecoins: {
      usdc: { mint: usdc.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, mintAuthority: payer.publicKey.toBase58(), feeCollectorAccount: getAssociatedTokenAddressSync(usdc, feeCollector, true, TOKEN_PROGRAM_ID).toBase58() },
      usdg: { mint: usdg.toBase58(), program: TOKEN_2022_PROGRAM_ID.toBase58(), decimals: 6, mintAuthority: payer.publicKey.toBase58(), feeCollectorAccount: getAssociatedTokenAddressSync(usdg, feeCollector, true, TOKEN_2022_PROGRAM_ID).toBase58() },
    },
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, JSON.stringify(deployment, null, 2) + "\n");
}

/** Upgrade authority of an upgradeable program (null once revoked), read from its ProgramData account. */
async function upgradeAuthority(conn: Connection, program: PublicKey): Promise<string | null> {
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], loader);
  const info = await conn.getAccountInfo(programData);
  if (!info) throw new Error(`no ProgramData for ${program.toBase58()}`);
  // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority_address: Option<Pubkey> }
  const tag = info.data.readUInt32LE(0);
  if (tag !== 3) throw new Error("not a ProgramData account");
  return info.data[12] === 1 ? new PublicKey(info.data.subarray(13, 45)).toBase58() : null;
}

async function verify(
  conn: Connection,
  cluster: Cluster,
  url: string,
  payer: Keypair,
  previous: Partial<Deployment>,
  outFile: string,
  ids: { registryId: PublicKey; protocolId: PublicKey; hookId: PublicKey; mockHookId: PublicKey; config: PublicKey; registryAuthority: PublicKey; registryCoder: BorshCoder },
): Promise<void> {
  if (!previous.stablecoins || !previous.registry) throw new Error("run the initialisation first");
  const programs: Deployment["programs"] = {};
  for (const [name, id] of [
    ["merces_registry", ids.registryId],
    ["merces_hook", ids.hookId],
    ["merces_protocol", ids.protocolId],
    ["mock_usdg_hook", ids.mockHookId],
  ] as const) {
    const info = await conn.getAccountInfo(id);
    if (!info?.executable) throw new Error(`${name} is not deployed at ${id.toBase58()}`);
    const so = readFileSync(join(solanaDir, "target", "deploy", `${name}.so`));
    programs[name] = { id: id.toBase58(), upgradeAuthority: await upgradeAuthority(conn, id), soSha256: createHash("sha256").update(so).digest("hex") };
  }
  if (programs.merces_registry!.upgradeAuthority !== null) throw new Error("merces_registry still has an upgrade authority");
  const cfgInfo = await conn.getAccountInfo(ids.config);
  if (!cfgInfo) throw new Error("ProtocolConfig missing");
  const cfg = ids.registryCoder.accounts.decode("ProtocolConfig", cfgInfo.data);
  if (!cfg.protocol_program.equals(ids.protocolId)) throw new Error("protocol_program mismatch");
  if (previous.registry.curveQuoteMint && cfg.curve_quote_mint.toBase58() !== previous.registry.curveQuoteMint) throw new Error("curve_quote_mint mismatch");
  if (!cfg.protocol_authority.equals(ids.registryAuthority)) throw new Error("registry_authority mismatch");
  if (cfg.chain_id.toNumber() !== CHAIN_IDS[cluster]) throw new Error("chain_id mismatch");
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const got = cfg.defaults[k];
    if (got.toString() !== v.toString()) throw new Error(`default ${k}: ${got} != ${v}`);
  }
  const usdg = new PublicKey(previous.stablecoins.usdg!.mint);
  const usdgMint = await getMint(conn, usdg, "confirmed", TOKEN_2022_PROGRAM_ID);
  const fee = getTransferFeeConfig(usdgMint);
  if (!fee || fee.newerTransferFee.transferFeeBasisPoints !== 0 || fee.newerTransferFee.maximumFee !== BigInt(0)) throw new Error("mock USDG must have a 0/0 transfer fee");
  const hook = getTransferHook(usdgMint);
  if (!hook?.programId.equals(ids.mockHookId)) throw new Error("mock USDG hook mismatch");
  const deployment: Deployment = {
    ...(previous as Deployment),
    cluster,
    rpc: url,
    verifiedAt: new Date().toISOString(),
    programs,
    registry: {
      ...previous.registry,
      domain: "0x" + Buffer.from(cfg.domain).toString("hex"),
      admin: cfg.admin.toBase58(),
      allowlistManager: cfg.allowlist_manager.toBase58(),
      feeCollector: cfg.fee_collector.toBase58(),
    },
    deployer: payer.publicKey.toBase58(),
  };
  writeFileSync(outFile, JSON.stringify(deployment, null, 2) + "\n");
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
