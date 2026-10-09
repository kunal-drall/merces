import { expect } from 'vitest';
import { ChainError, type DomainEvent } from '@merces/domain';

export const USDC = (n: number) => BigInt(Math.round(n * 1e6));
export const types = (evs: DomainEvent[]) => evs.map((e) => e.type);
export const GENESIS = Date.UTC(2026, 0, 1) / 1000;

export async function expectChainError(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ChainError && e.code === code, `expected ChainError ${code}`);
}

/** A refusal carrying Stage 1's error name (`detail.stage1`, S1 plan D4). */
export async function expectStage1Error(p: Promise<unknown>, name: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof ChainError && e.detail?.stage1 === name, `expected Stage 1 error ${name}`);
}
