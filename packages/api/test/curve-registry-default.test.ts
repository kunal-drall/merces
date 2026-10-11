import { describe, expect, it } from 'vitest';
import { nonRevealChargeOf } from '../../services/src/terms/service.ts';

describe('curve creation uses the registry charge without choosing a sealed-raise policy', () => {
  it('copies the live default instead of assuming zero', () => {
    expect(nonRevealChargeOf('curve', null, { mode: 'live', protocolDefaults: { nonRevealChargeBps: 100 } })).toBe(100);
    expect(nonRevealChargeOf('curve', null, { mode: 'live', protocolDefaults: { nonRevealChargeBps: 0 } })).toBe(0);
  });
  it('refuses missing and invalid live defaults', () => {
    expect(() => nonRevealChargeOf('curve', null, { mode: 'live' })).toThrow('unavailable');
    for (const value of [-1, 1001, NaN, 0.5]) expect(() => nonRevealChargeOf('curve', null, { mode: 'live', protocolDefaults: { nonRevealChargeBps: value } })).toThrow('unavailable');
  });
  it('keeps sealed creation blocked until the owner chooses, and never replaces that choice', () => {
    expect(() => nonRevealChargeOf('sealed', null, { mode: 'live', protocolDefaults: { nonRevealChargeBps: 100 } })).toThrow('owner');
    expect(nonRevealChargeOf('curve', 250, { mode: 'live', protocolDefaults: { nonRevealChargeBps: 100 } })).toBe(250);
    expect(nonRevealChargeOf('curve', null, { mode: 'mock' })).toBe(0);
  });
});
