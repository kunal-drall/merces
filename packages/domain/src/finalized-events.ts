import type { DomainEvent } from './events.ts';

/** Consecutive canonical sequence numbers, independent of gaps and expansions in finalized chain logs.
 * Rebuilding from the same deployment start reproduces the same sequence and opaque cursors.
 */
export class FinalizedEvents<T> {
  private events: DomainEvent[] = [];
  private through: string | null = null;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly endCursor: (raw: T) => string, private readonly map: (raw: T, history: T[]) => Promise<DomainEvent[]>) {}

  async update(history: T[]): Promise<void> {
    const task = this.pending.catch(() => {}).then(async () => {
      for (const raw of history) {
        const end = this.endCursor(raw);
        if (this.through !== null && end <= this.through) continue;
        // A failed decode leaves this raw log retryable; already decoded logs retain their sequence numbers.
        const mapped = await this.map(raw, history);
        for (const event of mapped) this.events.push({ ...event, seq: this.events.length + 1 });
        this.through = end;
      }
    });
    this.pending = task;
    await task;
  }

  page(cursor: string | null, limit: number): { events: DomainEvent[]; nextCursor: string | null } {
    const events = this.events.filter((e) => cursor === null || e.cursor > cursor).slice(0, limit);
    const nextCursor = events.length === limit ? events.at(-1)!.cursor : this.through;
    return { events, nextCursor: nextCursor !== null && (cursor === null || nextCursor > cursor) ? nextCursor : cursor };
  }

  transaction(txId: string): DomainEvent[] { return this.events.filter((e) => e.txId === txId); }
}
