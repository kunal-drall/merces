import { keyGraceUntil, keyUsable, type Command, type SignerKeyState } from '@merces/domain';
import type { SimKey } from '../state.ts';
import type { EngineCore, Emit } from './core.ts';
import { fail } from './errors.ts';

/**
 * Stage 1's key registry for attestor keys (S4 WP5, D5, D9): register, revoke and rotate, forward-only revocation with
 * its grace, and the last-key rule.
 *
 * Each simulator personality follows its own chain, names included (Stage 1's canonical error list has no name for
 * these cases):
 *
 * | Case | solana (merces_registry lib.rs:218-260) | monad (MercesRegistry.sol:287-345) |
 * |---|---|---|
 * | a zero address | `ZeroAttestorAddress` | `ZeroAddress` |
 * | register an active key | re-emits `AttestorRegistered`, changes nothing | `KeyAlreadyActive` |
 * | revoke a revoked key | `KeyAlreadyRevoked` | `KeyNotRegistered` |
 * | revoke a key never registered | `AccountNotInitialized` (Anchor 3012) | `KeyNotRegistered` |
 * | revoke the last active key | `LastKeyOfKind` (`attestor_count >= 2`) | `LastActiveKey` (`active == 1`) |
 *
 * Registering a revoked key re-activates it and clears its revocation time on both. Stage 1's reference simulator
 * (SIM:535-546) registers and revokes with no check at all, so it lets the last key go: both chains refuse it, and the
 * merces backend follows them (DIV-S1I-2, a Stage 1-internal difference resolved toward both chains).
 *
 * Rotation registers `to` then revokes `from` in one transaction (the EVM's `rotateAttestor`; on Solana the same two
 * instructions in one transaction): a refused revoke undoes the registration, as the engine's transaction does.
 */

/** A key address made of zero bytes: Stage 1's zero-address refusal (`addr != [0u8; 20]`; `key == address(0)`). */
export function isZeroKeyAddress(address: string): boolean {
  // the 20-byte zero address, and the 32-byte zero pubkey a Solana wallet address would be (until S4 WP7 every
  // attestor address is a 20-byte key)
  return /^0x0{40}$/i.test(address) || address === '1'.repeat(32);
}

function activeCount(keys: Map<string, SimKey>): number {
  let n = 0;
  for (const k of keys.values()) if (k.active) n++;
  return n;
}

/** Stage 1 `register_attestor` / `registerAttestor` on the chain's personality. */
export function registerAttestor(e: EngineCore, attestor: string, emit: Emit): void {
  const solana = e.state.config.personality === 'solana';
  if (isZeroKeyAddress(attestor)) fail(solana ? 'ZeroAttestorAddress' : 'ZeroAddress', 'the key address is zero');
  const k = e.state.attestors.get(attestor);
  // the EVM refuses an active key; Solana's init_if_needed account is set again (no count change) and the event re-emitted
  if (k?.active && !solana) fail('KeyAlreadyActive', 'the key is already active');
  e.state.attestors.set(attestor, { active: true, revokedAt: null });
  emit('AttestorRegistered', { attestor });
}

/** Stage 1 `revoke_attestor` / `revokeAttestor`: forward-only (SPEC §1.4), never the last active key. */
export function revokeAttestor(e: EngineCore, attestor: string, now: number, emit: Emit): void {
  const solana = e.state.config.personality === 'solana';
  const k = e.state.attestors.get(attestor);
  if (!k?.active) {
    if (!solana) fail('KeyNotRegistered', 'the key is not an active key');
    if (!k) fail('AccountNotInitialized', 'the key was never registered');
    fail('KeyAlreadyRevoked', 'the key is already revoked');
  }
  if (activeCount(e.state.attestors) < 2) fail(solana ? 'LastKeyOfKind' : 'LastActiveKey', 'the last active key of a kind cannot be revoked; rotate it instead');
  e.state.attestors.set(attestor, { active: false, revokedAt: now });
  emit('AttestorRevoked', { attestor, revokedAt: now });
}

/** Replace `from` by `to`: register `to`, then revoke `from`, in the same transaction (EVM `rotateAttestor`). */
export function rotateAttestor(e: EngineCore, cmd: Extract<Command, { kind: 'rotateAttestor' }>, now: number, emit: Emit): void {
  registerAttestor(e, cmd.to, emit);
  revokeAttestor(e, cmd.from, now, emit);
}

/** A registered attestor key as the port reports it (`ChainPort.getSignerKey`). */
export function attestorKeyState(address: string, k: SimKey): SignerKeyState {
  return { kind: 'attestor', address, active: k.active, revokedAt: k.revokedAt, graceUntil: keyGraceUntil(k.revokedAt) };
}

/**
 * Whether attestor key `address` may sign at `now`: active, or (with `reportPeriod`, the report and FX paths only)
 * revoked at or after the period's end and still within `revokedAt + KEY_GRACE_SECONDS` (`keyUsable`; Stage 1's
 * `reportKeyValid`, SIM:332-338; both chains also give the FX fallback this grace, DIV-S1I-3). A key never registered
 * may not.
 */
export function attestorUsable(e: EngineCore, address: string, now: number, opts: { reportPeriod?: string } = {}): boolean {
  const k = e.state.attestors.get(address);
  return !!k && keyUsable(k, now, opts);
}
