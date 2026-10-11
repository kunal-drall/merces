import { keyGraceUntil, keyUsable, recoverSigner, seriesKeyOf, type Attestation, type SignerKeyState, type SignerKind, type SigningContext } from '@merces/domain';
import { personalitySigning } from '../addresses.ts';
import type { SimKey, SimState } from '../state.ts';
import type { EngineCore, Emit } from './core.ts';
import { fail } from './errors.ts';

/**
 * Stage 1's key registry for both kinds of key (S4 WP5 attestor keys, S4 WP6 the report verifier's keys; D5, D9):
 * register, revoke and rotate, forward-only revocation with its grace, and the last-key rule. Each kind is its own set
 * with its own count (Solana `attestor_count` / `verifier_count`, EVM `_activeAttestors` / `_activeVerifiers`), and the
 * two run the same code on both chains (merces_registry lib.rs:218-302; MercesRegistry.sol:287-345).
 *
 * Each simulator personality follows its own chain, names included (Stage 1's canonical error list has no name for
 * these cases):
 *
 * | Case | solana (merces_registry lib.rs:218-302) | monad (MercesRegistry.sol:287-345) |
 * |---|---|---|
 * | a zero address | `ZeroAttestorAddress` (the verifier path too, lib.rs:263) | `ZeroAddress` |
 * | register an active key | re-emits `*Registered`, changes nothing | `KeyAlreadyActive` |
 * | revoke a revoked key | `KeyAlreadyRevoked` | `KeyNotRegistered` |
 * | revoke a key never registered | `AccountNotInitialized` (Anchor 3012) | `KeyNotRegistered` |
 * | revoke the last active key of its kind | `LastKeyOfKind` (count >= 2) | `LastActiveKey` (`active == 1`) |
 *
 * Registering a revoked key re-activates it and clears its revocation time on both. Stage 1's reference simulator
 * (SIM:535-546) registers and revokes with no check at all, so it lets the last key go: both chains refuse it, and the
 * merces backend follows them (DIV-S1I-2, a Stage 1-internal difference resolved toward both chains).
 *
 * Rotation registers `to` then revokes `from` in one transaction (the EVM's `rotateAttestor` / `rotateVerifierKey`; on
 * Solana the same two instructions in one transaction): a refused revoke undoes the registration, as the engine's
 * transaction does.
 */

/** The 20-byte zero address: Stage 1's zero-address refusal (`addr != [0u8; 20]`; `key == address(0)`). */
export function isZeroKeyAddress(address: string): boolean {
  // every key address is a 20-byte secp256k1 address on both personalities (attestor keys since S4 WP7)
  return /^0x0{40}$/i.test(address);
}

/** The registry of one kind of key. */
function keysOf(state: SimState, kind: SignerKind): Map<string, SimKey> {
  return kind === 'attestor' ? state.attestors : state.verifierKeys;
}

function activeCount(keys: Map<string, SimKey>): number {
  let n = 0;
  for (const k of keys.values()) if (k.active) n++;
  return n;
}

/** Stage 1 `register_attestor` / `register_verifier_key` (`registerAttestor` / `registerVerifierKey`) on the chain's personality. */
export function registerKey(e: EngineCore, kind: SignerKind, address: string, emit: Emit): void {
  const solana = e.state.config.personality === 'solana';
  if (isZeroKeyAddress(address)) fail(solana ? 'ZeroAttestorAddress' : 'ZeroAddress', 'the key address is zero');
  const keys = keysOf(e.state, kind);
  const k = keys.get(address);
  // the EVM refuses an active key; Solana's init_if_needed account is set again (no count change) and the event re-emitted
  if (k?.active && !solana) fail('KeyAlreadyActive', 'the key is already active');
  keys.set(address, { active: true, revokedAt: null });
  if (kind === 'attestor') emit('AttestorRegistered', { attestor: address });
  else emit('VerifierKeyRegistered', { verifierKey: address });
}

/** Stage 1 `revoke_attestor` / `revoke_verifier_key`: forward-only (SPEC §1.4), never the last active key of its kind. */
export function revokeKey(e: EngineCore, kind: SignerKind, address: string, now: number, emit: Emit): void {
  const solana = e.state.config.personality === 'solana';
  const keys = keysOf(e.state, kind);
  const k = keys.get(address);
  if (!k?.active) {
    if (!solana) fail('KeyNotRegistered', 'the key is not an active key');
    if (!k) fail('AccountNotInitialized', 'the key was never registered');
    fail('KeyAlreadyRevoked', 'the key is already revoked');
  }
  if (activeCount(keys) < 2) fail(solana ? 'LastKeyOfKind' : 'LastActiveKey', 'the last active key of a kind cannot be revoked; rotate it instead');
  keys.set(address, { active: false, revokedAt: now });
  if (kind === 'attestor') emit('AttestorRevoked', { attestor: address, revokedAt: now });
  else emit('VerifierKeyRevoked', { verifierKey: address, revokedAt: now });
}

/** Replace `from` by `to`: register `to`, then revoke `from`, in the same transaction (EVM `rotate*`). */
export function rotateKey(e: EngineCore, kind: SignerKind, from: string, to: string, now: number, emit: Emit): void {
  registerKey(e, kind, to, emit);
  revokeKey(e, kind, from, now, emit);
}

/** A registered key as the port reports it (`ChainPort.getSignerKey`). */
export function signerKeyState(kind: SignerKind, address: string, k: SimKey): SignerKeyState {
  return { kind, address, active: k.active, revokedAt: k.revokedAt, graceUntil: keyGraceUntil(k.revokedAt) };
}

/** A registered key of `kind` (`ChainPort.getSignerKey`), or null for a key never registered. */
export function getSignerKey(state: SimState, kind: SignerKind, address: string): SignerKeyState | null {
  const k = keysOf(state, kind).get(address);
  return k ? signerKeyState(kind, address, k) : null;
}

/** Every registered key of `kind`, by address (`ChainPort.listSignerKeys`). */
export function listSignerKeys(state: SimState, kind: SignerKind): SignerKeyState[] {
  return [...keysOf(state, kind).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([a, k]) => signerKeyState(kind, a, k));
}

/**
 * Whether key `address` of `kind` may sign at `now`: active, or (with `reportPeriod`, the report and FX paths only)
 * revoked at or after the period's end and still within `revokedAt + KEY_GRACE_SECONDS` (`keyUsable`; Stage 1's
 * `reportKeyValid`, SIM:332-338; both chains also give the FX fallback this grace, DIV-S1I-3). A key never registered
 * may not (the EVM's `_keyValid` requires `registered`, MercesIncome.sol:236-242).
 */
export function keyUsableOn(state: SimState, kind: SignerKind, address: string, now: number, opts: { reportPeriod?: string } = {}): boolean {
  const k = keysOf(state, kind).get(address);
  return !!k && keyUsable(k, now, opts);
}

/** Attestor key `address` may sign at `now` (`keyUsableOn` for attestors). */
export function attestorUsable(e: EngineCore, address: string, now: number, opts: { reportPeriod?: string } = {}): boolean {
  return keyUsableOn(e.state, 'attestor', address, now, opts);
}

/**
 * A signature argument as both chains check it (S4 D8): the 65-byte signature over `digest` must recover to the named
 * signer (a malformed or non-canonical signature recovers to nobody, the EVM's `tryRecover`), and that key must be one
 * of `kind` usable at `now` (with `reportPeriod`: Stage 1's grace). Anything else is the kind's error,
 * `InvalidVerifierSignature` for the report verifier's key and `InvalidAttestorSignature` for an attestor's. A missing
 * attestation is the same error (Solana's `AttestationRequired` there, income.rs:396-399: an adapter note, S4 WP13).
 * Returns the signer.
 */
export function requireSigned(e: EngineCore, kind: SignerKind, digest: string, a: Attestation | null | undefined, now: number, opts: { reportPeriod?: string } = {}): string {
  const error = kind === 'verifier' ? 'InvalidVerifierSignature' : 'InvalidAttestorSignature';
  if (!a) return fail(error, kind === 'verifier' ? 'a verifier attestation is required' : 'an attestor signature is required');
  const who = recoverSigner(digest, a.signature);
  // the chains check recovery against the supplied address (Solana `require_signer`) or recover and look the key up (EVM)
  if (who === null || who !== a.signer) fail(error, 'the signature does not recover to the named key');
  if (!keyUsableOn(e.state, kind, who!, now, opts)) fail(error, `the key is not a usable ${kind} key`);
  return who!;
}

/**
 * What every message signed for a series of this chain binds first (SPEC §1.3-§1.4): the chain's signing domain
 * (`ChainInfo.signing`, derived from the personality and the chain key, S4 D6) and the series key (`seriesKeyOf`, as
 * `SeriesState.seriesKey`, S4 D7).
 */
export function signingContextOf(state: SimState, seriesId: string): SigningContext {
  return { domain: personalitySigning(state.config.personality, state.config.chain).domain, seriesKey: seriesKeyOf(seriesId, state.config.family) };
}
