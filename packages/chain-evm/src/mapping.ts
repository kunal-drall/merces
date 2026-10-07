import type { DomainEvent, EventType } from '@merces/domain';
import type { EvmChainConfig } from './config.ts';

export interface EvmEventMappingRule {
  canonical: EventType;
  contract: string;
  /** Solidity event name */
  stage1Name: string | null;
  fields: Record<string, string>;
  drift: string[];
}

export class EvmEventMapper {
  readonly rules = new Map<EventType, EvmEventMappingRule>();
  constructor(readonly config: EvmChainConfig) {}
  register(rule: EvmEventMappingRule): void {
    this.rules.set(rule.canonical, rule);
  }
  map(decoded: { contract: string; eventName: string; args: Record<string, unknown> }, envelope: Omit<DomainEvent, 'type' | 'payload'>): DomainEvent | null {
    for (const rule of this.rules.values()) {
      if (rule.stage1Name !== decoded.eventName || rule.contract !== decoded.contract) continue;
      const payload: Record<string, unknown> = {};
      for (const [canonicalField, path] of Object.entries(rule.fields)) {
        const v = path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], decoded.args);
        payload[canonicalField] = typeof v === 'bigint' ? v.toString() : typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v;
      }
      return { ...envelope, type: rule.canonical, payload } as DomainEvent;
    }
    return null;
  }
}
