import { SimError, Simulator, type Call } from '@merces/reference';
import { nonProtocol, RunnerError, type Raised } from './errors.ts';
import type { LoadedVector } from './load.ts';
import { verifyReportCached } from './proofs.ts';
import type { Applied, FxRequest, World } from './world.ts';

/**
 * The reference backend: Stage 1's own `Simulator` (`@merces/reference`, SIM), the executable spec. It runs every op
 * as is; the runner's comparison, invariants and revert check run on top of it, so a 25/25 pass proves the runner
 * (S1 plan D7) and that the pinned Stage 1 checkout replays its own vectors.
 *
 * Proofs are verified for real. Each proof's verdict comes from the per-process cache first (`proofs.ts`, Stage 1's
 * `verifyReport`): when it is valid, the simulator's own verification would return the same `true`, so it is skipped
 * for that call; when it is not, the simulator verifies itself and raises `InvalidProof` at its own point in the check
 * order (SIM:1110-1113).
 */
export class ReferenceWorld implements World {
  readonly backend = 'reference' as const;
  readonly label = 'reference';
  private readonly sim: Simulator;

  constructor(vector: LoadedVector) {
    this.sim = new Simulator({ parameters: vector.parameters, flags: vector.flags, verifyProofs: true });
  }

  static async create(vector: LoadedVector): Promise<ReferenceWorld> {
    return new ReferenceWorld(vector);
  }

  setTime(t: bigint): void {
    if (t < this.sim.now) throw new RunnerError(`time cursor went backwards: ${t} < ${this.sim.now}`);
    this.sim.now = t;
  }

  private setVerify(on: boolean): void {
    (this.sim as { verifyProofs: boolean }).verifyProofs = on;
  }

  async apply(call: Call): Promise<Applied> {
    if (call.op === 'submit_report') {
      const valid = await verifyReportCached(call.proof, call.publicSignals);
      this.setVerify(!valid);
    }
    try {
      await this.sim.call(call);
    } finally {
      this.setVerify(true);
    }
    return { kind: 'direct' };
  }

  classify(e: unknown): Raised {
    return e instanceof SimError ? { protocol: true, name: e.code } : nonProtocol(e);
  }

  snapshot(series: string | null, fx?: FxRequest): Record<string, unknown> {
    return this.sim.expect(series, fx ? { fx } : {}) as unknown as Record<string, unknown>;
  }

  serialize(): string {
    return this.sim.serialize();
  }

  totalStable(): bigint {
    return this.sim.totalStable();
  }

  checkUnitSupply(series: string): void {
    try {
      this.sim.checkUnitSupply(series);
    } catch (e) {
      // Stage 1's message is "unit supply mismatch for <series>: <held> != <supply>" (public counts); anything else is
      // reported by class only
      const m = e instanceof Error ? /^unit supply mismatch for [^:]+: (\d+) != (\d+)$/.exec(e.message) : null;
      throw new RunnerError(m ? `unit supply: holders and escrows hold ${m[1]}, supply is ${m[2]}` : `unit supply check raised ${nonProtocol(e).className}`);
    }
  }

  async close(): Promise<void> {}
}
