/**
 * Post-deployment smoke test against a live cluster (localnet / devnet), driven by the exported
 * IDLs: registers the deployer as issuer, allowlists it, creates a sealed-bid series on the mock
 * USDC, sets its contract hash, opens the raise (Token-2022 unit mint with TransferHook,
 * PermanentDelegate, MetadataPointer + TokenMetadata, hook extra-account list, escrow ATAs) and
 * commits one sealed bid. Checks the resulting on-chain state.
 *
 *   node --import tsx scripts/smoke.ts --cluster localnet [--url <rpc>] [--keypair <path>]
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getPermanentDelegate,
  getTransferHook,
} from "@solana/spl-token";
import { BorshCoder, type Idl } from "@anchor-lang/core";
import BN from "bn.js";

const here = dirname(fileURLToPath(import.meta.url));
const solanaDir = join(here, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function loadKeypair(path: string): Keypair {
  const p = path.startsWith("~") ? join(process.env.HOME ?? "", path.slice(1)) : path;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}
function readIdl(name: string): Idl & { address: string } {
  return JSON.parse(readFileSync(join(solanaDir, "idls", `${name}.json`), "utf8"));
}
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

/** Builds an instruction from the IDL: account order, signer and writable flags come from the IDL. */
function ix(idl: Idl & { address: string }, name: string, accounts: Record<string, PublicKey>, args: Record<string, unknown>): TransactionInstruction {
  const def = (idl.instructions as any[]).find((i) => i.name === name);
  if (!def) throw new Error(`no instruction ${name}`);
  const programId = new PublicKey(idl.address);
  const keys = def.accounts.map((a: any) => {
    const key = accounts[a.name] ?? (a.optional ? programId : undefined);
    if (!key) throw new Error(`${name}: account ${a.name} not supplied`);
    return { pubkey: key, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  return new TransactionInstruction({ programId, keys, data: new BorshCoder(idl).instruction.encode(name, args) });
}

async function send(conn: Connection, payer: Keypair, ixs: TransactionInstruction[]): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...ixs);
  return sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
}

async function main(): Promise<void> {
  const cluster = arg("cluster") ?? "localnet";
  const url = arg("url") ?? "http://127.0.0.1:8899";
  if (url.includes("mainnet")) throw new Error("refusing mainnet");
  const payer = loadKeypair(arg("keypair") ?? "~/.config/solana/id.json");
  const conn = new Connection(url, "confirmed");
  const dep = JSON.parse(readFileSync(join(solanaDir, "deployments", `${cluster}.json`), "utf8"));
  const registry = readIdl("merces_registry");
  const protocol = readIdl("merces_protocol");
  const hook = readIdl("merces_hook");
  const registryId = new PublicKey(registry.address);
  const protocolId = new PublicKey(protocol.address);
  const hookId = new PublicKey(hook.address);
  const usdc = new PublicKey(dep.stablecoins.usdc.mint);
  const me = payer.publicKey;
  const coder = new BorshCoder(registry);

  const config = pda([Buffer.from("config")], registryId);
  const issuerPda = pda([Buffer.from("issuer"), me.toBuffer()], registryId);
  const allow = pda([Buffer.from("allow"), me.toBuffer()], registryId);
  const sys = SystemProgram.programId;

  // registry: issuer + allowlist (the deployer is admin and allowlist manager on localnet)
  await send(conn, payer, [
    ix(registry, "register_issuer", { config, admin: me, issuer: issuerPda, system_program: sys }, { wallet: me }),
    ix(registry, "set_allowed", { config, allowlist_manager: me, entry: allow, system_program: sys }, { wallet: me, allowed: true }),
  ]);
  const cfg = coder.accounts.decode("ProtocolConfig", (await conn.getAccountInfo(config))!.data);
  const seriesId: BN = cfg.series_count;
  const series = pda([Buffer.from("series"), seriesId.toArrayLike(Buffer, "le", 8)], registryId);
  const day = 86_400;
  await send(conn, payer, [
    ix(registry, "create_series", {
      config, issuer_wallet: me, issuer: issuerPda, allowlist_entry: allow, stablecoin_mint: usdc, series, system_program: sys,
    }, {
      args: {
        units_offered: new BN(100), reserve_price: new BN(1_000_000), min_raise: new BN(50_000_000),
        cap_multiple_wad: new BN("2500000000000000000"), hurdle_rate_wad: new BN("80000000000000000"), payout_multiple_k: 5,
        lockup_seconds: new BN(47_336_400), wallet_cap_bps: 1_000,
        commit_duration: new BN(3_600), reveal_duration: new BN(3_600), window_commit_duration: new BN(3 * day), window_reveal_duration: new BN(day),
        release_schedule: [{ at_offset_seconds: new BN(0), bps: 10_000 }],
        terms_commitment: Array.from(createHash("sha256").update("merces smoke terms").digest()),
        tier_flags: 0b0110, fx_pair_id: Array(32).fill(0), mode: 0, issuer_accepts_public_price: false,
        metadata_uri: "https://merces.example/smoke.json", tier1_terms: null,
      },
    }),
    ix(registry, "set_contract_hash", { issuer_wallet: me, series }, { hash: Array.from(createHash("sha256").update("merces smoke contract").digest()) }),
  ]);
  console.log(`series ${seriesId.toString()} at ${series.toBase58()}`);

  // protocol: prepare + open the raise
  const sp = (seed: string) => pda([Buffer.from(seed), series.toBuffer()], protocolId);
  const unitMint = sp("unit_mint");
  const auctionEscrowAuth = sp("auction_escrow");
  const windowEscrowAuth = sp("window_escrow");
  const auctionEscrowAta = getAssociatedTokenAddressSync(unitMint, auctionEscrowAuth, true, TOKEN_2022_PROGRAM_ID);
  const windowEscrowAta = getAssociatedTokenAddressSync(unitMint, windowEscrowAuth, true, TOKEN_2022_PROGRAM_ID);
  await send(conn, payer, [
    ix(protocol, "prepare_raise", {
      issuer: me, series, stablecoin_mint: usdc, stablecoin_program: TOKEN_PROGRAM_ID, unit_mint: unitMint,
      vault_auth: sp("vault_auth"), escrow_auth: sp("escrow_auth"), treasury_auth: sp("treasury_auth"), window_escrow_auth: windowEscrowAuth,
      auction: sp("auction"), treasury: sp("treasury"), ledger: sp("ledger"), escrow_arm: pda([Buffer.from("escrow_arm"), unitMint.toBuffer()], protocolId),
      escrow_token: sp("escrow_token"), treasury_token: sp("treasury_token"), vault_token: sp("vault_token"), window_stable: sp("window_stable"),
      system_program: sys,
    }, {}),
  ]);
  await send(conn, payer, [
    ix(protocol, "open_raise", {
      issuer: me, config, series, issuer_allowlist: allow, unit_mint: unitMint, auction_auth: sp("auction_auth"), vault_auth: sp("vault_auth"),
      auction: sp("auction"), auction_escrow_auth: auctionEscrowAuth, auction_escrow_ata: auctionEscrowAta,
      window_escrow_auth: windowEscrowAuth, window_escrow_ata: windowEscrowAta,
      extra_account_meta_list: pda([Buffer.from("extra-account-metas"), unitMint.toBuffer()], hookId),
      registry_authority: pda([Buffer.from("registry_authority")], protocolId), hook_program: hookId, registry_program: registryId,
      token_2022_program: TOKEN_2022_PROGRAM_ID, associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID, system_program: sys,
    }, {}),
  ]);
  const mint = await getMint(conn, unitMint, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (mint.decimals !== 0) throw new Error("unit mint must have 0 decimals");
  if (!getTransferHook(mint)?.programId.equals(hookId)) throw new Error("unit mint hook mismatch");
  if (!getPermanentDelegate(mint)?.delegate.equals(sp("vault_auth"))) throw new Error("permanent delegate mismatch");
  if (!mint.mintAuthority?.equals(sp("auction_auth"))) throw new Error("mint authority mismatch");
  const s = coder.accounts.decode("Series", (await conn.getAccountInfo(series))!.data);
  if (s.raise_state !== 1 || !s.unit_mint.equals(unitMint) || !s.auction_escrow_ata.equals(auctionEscrowAta)) throw new Error("registry not updated");
  console.log(`raise opened: unit mint ${unitMint.toBase58()}`);

  // one sealed bid: commitment = keccak256(price ‖ quantity ‖ salt ‖ bidder)
  const myUsdc = getAssociatedTokenAddressSync(usdc, me, false, TOKEN_PROGRAM_ID);
  await send(conn, payer, [
    createAssociatedTokenAccountIdempotentInstruction(me, myUsdc, me, usdc, TOKEN_PROGRAM_ID),
    createMintToInstruction(usdc, myUsdc, me, 1_000_000_000, [], TOKEN_PROGRAM_ID),
  ]);
  // keccak-256 from @noble/hashes, the pinned dependency of @solana/web3.js (resolved through it so
  // the workspace lockfile needs no new entry)
  const web3Require = createRequire(createRequire(import.meta.url).resolve("@solana/web3.js"));
  const { keccak_256 } = web3Require("@noble/hashes/sha3") as { keccak_256: (m: Uint8Array) => Uint8Array };
  const salt = randomBytes(32);
  const pre = Buffer.concat([new BN(2_000_000).toArrayLike(Buffer, "be", 8), new BN(10).toArrayLike(Buffer, "be", 8), salt, me.toBuffer()]);
  const commitment = Array.from(keccak_256(pre));
  await send(conn, payer, [
    ix(protocol, "commit_bid", {
      bidder: me, series, bidder_allowlist: allow, auction: sp("auction"), bid: pda([Buffer.from("bid"), series.toBuffer(), me.toBuffer()], protocolId),
      bidder_stable: myUsdc, escrow_token: sp("escrow_token"), stablecoin_mint: usdc, stablecoin_program: TOKEN_PROGRAM_ID, system_program: sys,
    }, { commitment, escrow: new BN(30_000_000) }),
  ]);
  const escrow = await conn.getTokenAccountBalance(sp("escrow_token"));
  if (escrow.value.amount !== "30000000") throw new Error(`escrow holds ${escrow.value.amount}`);
  console.log("smoke test passed: series created, raise opened, bid committed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
