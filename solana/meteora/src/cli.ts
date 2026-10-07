/**
 * Small, dependency-free helpers shared by the `graduate` and `state` CLIs.
 */
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  type Commitment,
  type Signer,
  type Transaction,
  type TransactionSignature,
} from "@solana/web3.js";

export type ArgValue = string | boolean;

export interface ParsedArgs {
  flags: Record<string, ArgValue>;
  positional: string[];
}

/** `--name value`, `--name=value`, `--flag` (boolean). Repeated flags keep the last value. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, ArgValue> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { flags, positional };
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const v = args.flags[name];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing --${name}`);
  return v;
}

export function optionalFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  const v = args.flags[name];
  return v === true || v === "true" || v === "1";
}

export const CLUSTER_RPC: Readonly<Record<string, string>> = {
  devnet: "https://api.devnet.solana.com",
  localnet: "http://127.0.0.1:8899",
  testnet: "https://api.testnet.solana.com",
};

/** Resolve `--cluster` / `--rpc` into an RPC url. Mainnet is refused on purpose (brief: never mainnet). */
export function resolveRpcUrl(cluster: string | undefined, rpc: string | undefined): string {
  if (rpc) {
    if (/mainnet/i.test(rpc)) throw new Error("refusing a mainnet RPC url: Stage 1 targets devnet and local validators only");
    return rpc;
  }
  const c = cluster ?? "devnet";
  if (c === "mainnet" || c === "mainnet-beta") throw new Error("refusing mainnet: Stage 1 targets devnet and local validators only");
  const url = CLUSTER_RPC[c];
  if (!url) throw new Error(`unknown cluster ${c}; use --rpc <url>`);
  return url;
}

export function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw) || raw.length !== 64) throw new Error(`${path}: expected a 64-byte secret key JSON array`);
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

export function pubkey(s: string, what = "pubkey"): PublicKey {
  try {
    return new PublicKey(s);
  } catch {
    throw new Error(`invalid ${what}: ${s}`);
  }
}

export function formatQuote(amount: bigint, decimals = 6): string {
  const d = 10n ** BigInt(decimals);
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const s = `${abs / d}.${(abs % d).toString().padStart(decimals, "0")}`;
  return neg ? `-${s}` : s;
}

export interface SendOptions {
  commitment?: Commitment;
  /** Number of attempts on blockhash expiry / transient RPC errors. */
  attempts?: number;
  log?: (msg: string) => void;
}

export class TransactionExpiredError extends Error {
  constructor(readonly signature: string) {
    super(`transaction ${signature} expired: block height exceeded`);
    this.name = "TransactionExpiredError";
  }
}

/**
 * Confirm a signature by polling `getSignatureStatuses` (no websocket: public devnet RPCs rate-limit or drop
 * PubSub connections, and the local test validator serves PubSub on a separate port). Throws
 * `TransactionExpiredError` once the chain passes `lastValidBlockHeight` without seeing the signature.
 */
export async function confirmSignature(
  connection: Connection,
  signature: TransactionSignature,
  lastValidBlockHeight: number,
  commitment: Commitment = "confirmed",
  pollMs = 400,
): Promise<void> {
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      if (status.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      const level = status.confirmationStatus;
      if (level === "finalized" || (level === "confirmed" && commitment !== "finalized") || (commitment === "processed" && level)) return;
    }
    const height = await connection.getBlockHeight(commitment);
    if (height > lastValidBlockHeight) throw new TransactionExpiredError(signature);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Sign, send and confirm a legacy `Transaction` built by the SDK. Re-fetches the blockhash on every attempt.
 * Note: an "already processed" error on a retry means the previous attempt landed; we treat it as success
 * only when the caller re-reads on-chain state (the graduation steps all do).
 */
export async function sendAndConfirm(
  connection: Connection,
  tx: Transaction,
  signers: Signer[],
  label: string,
  opts: SendOptions = {},
): Promise<TransactionSignature> {
  const commitment = opts.commitment ?? "confirmed";
  const attempts = opts.attempts ?? 3;
  const log = opts.log ?? (() => {});
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
      tx.recentBlockhash = blockhash;
      tx.lastValidBlockHeight = lastValidBlockHeight;
      if (!tx.feePayer) tx.feePayer = signers[0]!.publicKey;
      tx.signatures = [];
      tx.sign(...signers);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: commitment });
      log(`${label}: sent ${sig}`);
      await confirmSignature(connection, sig, lastValidBlockHeight, commitment);
      log(`${label}: confirmed ${sig}`);
      return sig;
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < attempts && /block height exceeded|Blockhash not found|expired|429|timeout|fetch failed|ECONNRESET/i.test(msg)) {
        log(`${label}: attempt ${attempt} failed (${msg}); retrying`);
        continue;
      }
      throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function logger(prefix = "[merces/meteora]"): (msg: string) => void {
  return (msg: string) => {
    process.stderr.write(`${prefix} ${msg}\n`);
  };
}
