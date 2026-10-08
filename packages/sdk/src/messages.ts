/**
 * The six signed-message encodings (SPEC §1.4). The signed digest is the raw keccak256 of the
 * pre-image (no EIP-191 prefix): the ASCII magic string is the domain separation.
 */
import { bytes32, concatBytes, i64, toBigInt, u16, u32, u64, u8, utf8 } from "./bytes.js";
import { keccak256 } from "./hash.js";

export const MAGIC = {
  REPORT: "MERCES_REPORT_V1",
  FX: "MERCES_FX_V1",
  AMEND: "MERCES_AMEND_V1",
  PAUSE: "MERCES_PAUSE_V1",
  EXTINGUISH: "MERCES_EXTINGUISH_V1",
  TRUEUP: "MERCES_TRUEUP_V1",
} as const;

export type MagicName = keyof typeof MAGIC;

export interface SignedMessage {
  /** Which message this is. */
  kind: MagicName;
  /** Exact bytes hashed. */
  preimage: Uint8Array;
  /** `keccak256(preimage)` — what gets signed. */
  digest: Uint8Array;
}

function message(kind: MagicName, ...fields: Uint8Array[]): SignedMessage {
  const preimage = concatBytes(utf8(MAGIC[kind]), ...fields);
  return { kind, preimage, digest: keccak256(preimage) };
}

function key32(v: Uint8Array | string | bigint, name: string): Uint8Array {
  try {
    return bytes32(v);
  } catch (e) {
    throw new RangeError(`${name}: ${(e as Error).message}`);
  }
}

/**
 * `"MERCES_REPORT_V1" ‖ domain ‖ series_key ‖ period_u32 ‖ prior_income_commitment_32 ‖ income_commitment_32 ‖ tier_u8 ‖ liquidity_event_u8`
 * (SPEC v1.1 §1.4: the attestation binds the prior commitment and the liquidity flag).
 */
export function reportAttestationMessage(args: {
  domain: Uint8Array | string;
  seriesKey: Uint8Array | string;
  period: number | bigint;
  priorIncomeCommitment: Uint8Array | string | bigint;
  incomeCommitment: Uint8Array | string | bigint;
  tier: number;
  liquidityEvent: boolean;
}): SignedMessage {
  return message(
    "REPORT",
    key32(args.domain, "domain"),
    key32(args.seriesKey, "seriesKey"),
    u32(args.period),
    key32(args.priorIncomeCommitment, "priorIncomeCommitment"),
    key32(args.incomeCommitment, "incomeCommitment"),
    u8(args.tier),
    u8(args.liquidityEvent ? 1 : 0),
  );
}

/** `"MERCES_FX_V1" ‖ domain ‖ series_key ‖ period_u32 ‖ fx_rate_wad_u64` */
export function fxFallbackMessage(args: {
  domain: Uint8Array | string;
  seriesKey: Uint8Array | string;
  period: number | bigint;
  fxRateWad: bigint;
}): SignedMessage {
  return message("FX", key32(args.domain, "domain"), key32(args.seriesKey, "seriesKey"), u32(args.period), u64(args.fxRateWad));
}

/** `"MERCES_AMEND_V1" ‖ domain ‖ series_key ‖ amendment_nonce_u64 ‖ new_terms_commitment_32 ‖ new_cap_multiple_wad_u64` */
export function amendmentMessage(args: {
  domain: Uint8Array | string;
  seriesKey: Uint8Array | string;
  amendmentNonce: bigint | number;
  newTermsCommitment: Uint8Array | string | bigint;
  newCapMultipleWad: bigint;
}): SignedMessage {
  return message(
    "AMEND",
    key32(args.domain, "domain"),
    key32(args.seriesKey, "seriesKey"),
    u64(toBigInt(args.amendmentNonce, "amendmentNonce")),
    key32(args.newTermsCommitment, "newTermsCommitment"),
    u64(args.newCapMultipleWad),
  );
}

/** `"MERCES_PAUSE_V1" ‖ domain ‖ series_key ‖ pause_nonce_u64 ‖ pause_end_u64` (the nonce identifies one request; withdrawing a request advances it) */
export function pauseApprovalMessage(args: {
  domain: Uint8Array | string;
  seriesKey: Uint8Array | string;
  pauseNonce: bigint | number;
  pauseEnd: bigint;
}): SignedMessage {
  return message(
    "PAUSE",
    key32(args.domain, "domain"),
    key32(args.seriesKey, "seriesKey"),
    u64(toBigInt(args.pauseNonce, "pauseNonce")),
    u64(args.pauseEnd),
  );
}

/** `"MERCES_EXTINGUISH_V1" ‖ domain ‖ series_key ‖ extinguish_nonce_u64` */
export function extinguishMessage(args: {
  domain: Uint8Array | string;
  seriesKey: Uint8Array | string;
  extinguishNonce: bigint | number;
}): SignedMessage {
  return message(
    "EXTINGUISH",
    key32(args.domain, "domain"),
    key32(args.seriesKey, "seriesKey"),
    u64(toBigInt(args.extinguishNonce, "extinguishNonce")),
  );
}

/** `"MERCES_TRUEUP_V1" ‖ domain ‖ series_key ‖ trueup_nonce_u64 ‖ year_u16 ‖ adjustment_i64 ‖ attestation_ts_u64` */
export function trueUpMessage(args: {
  domain: Uint8Array | string;
  seriesKey: Uint8Array | string;
  trueupNonce: bigint | number;
  year: number;
  adjustment: bigint;
  attestationTs: bigint;
}): SignedMessage {
  return message(
    "TRUEUP",
    key32(args.domain, "domain"),
    key32(args.seriesKey, "seriesKey"),
    u64(toBigInt(args.trueupNonce, "trueupNonce")),
    u16(args.year),
    i64(args.adjustment),
    u64(args.attestationTs),
  );
}
