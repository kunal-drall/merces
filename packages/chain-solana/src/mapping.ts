import type { DomainEvent, EventType } from '@merces/domain';
import type { SolanaChainConfig } from './config.ts';

/**
 * Field-by-field mapping from Stage 1's Anchor events to canonical events. `stage1:sync` fills the table
 * from the IDLs and records every difference in INTERFACE_DRIFT.md; nothing is papered over silently.
 */
export interface EventMappingRule {
  canonical: EventType;
  /** Anchor event name in the IDL */
  stage1Name: string | null;
  /** canonical field -> Stage 1 field path (dot notation) */
  fields: Record<string, string>;
  /** notes recorded in INTERFACE_DRIFT.md */
  drift: string[];
}

export class SolanaEventMapper {
  readonly rules = new Map<EventType, EventMappingRule>();
  constructor(readonly config: SolanaChainConfig) {}

  register(rule: EventMappingRule): void {
    this.rules.set(rule.canonical, rule);
  }

  /** Map a decoded Anchor event (name + data) to a canonical event, or null when no rule exists. */
  map(decoded: { name: string; data: Record<string, unknown> }, envelope: Omit<DomainEvent, 'type' | 'payload'>): DomainEvent | null {
    for (const rule of this.rules.values()) {
      if (rule.stage1Name !== decoded.name) continue;
      const payload: Record<string, unknown> = {};
      for (const [canonicalField, path] of Object.entries(rule.fields)) payload[canonicalField] = path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], decoded.data);
      return { ...envelope, type: rule.canonical, payload } as DomainEvent;
    }
    return null;
  }
}
