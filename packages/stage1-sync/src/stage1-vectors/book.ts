/**
 * The merces backend's own bookkeeping (S1 plan §5.2): what Stage 1's multi-step window records and our one-step
 * canonical window does not (window phases and rounds; S5), plus the runner-held terms canonical terms lack (the
 * window durations and fee) and the actors Stage 1 lists in `balances`. Fields here are shim-derived and therefore
 * "not parity" (VECTOR_PARITY.md). The auction has no bookkeeping since S2: the engine runs Stage 1's settlement and
 * every auction and holder field of the view comes from it.
 *
 * Plain JSON (strings for amounts) so a revert check can compare it byte for byte; it changes only when a step
 * succeeds.
 */
export interface WindowBook {
  windowId: number;
  period: number;
  /** Stage 1 window state: Commit → Reveal → Settling → NoMatch | Settled → Done */
  state: 'Commit' | 'Reveal' | 'Settling' | 'NoMatch' | 'Settled' | 'Done';
  tallyRound: number;
  roundRejected: boolean;
  /** the proposed clearing price, `NO_MATCH`, or null before `begin_window_settlement` */
  proposal: string | null;
  matchedUnits: string;
}

/**
 * Terms canonical `SeriesTerms` lacks (shim SH-REG-4), held by the runner: the window's (S5). The raise durations and
 * the non-reveal bps are canonical terms since S2.
 */
export interface RunnerTerms {
  windowCommitDuration: number;
  windowRevealDuration: number;
  windowFeeBps: number;
}

export interface SeriesBook {
  seriesId: string;
  terms: RunnerTerms;
  window: WindowBook | null;
}

export interface Book {
  /** vector series name → its book */
  series: Record<string, SeriesBook>;
  /**
   * Stage 1 lists in `balances` every account it ever credited with stablecoin or units (SIM:276-309, 1765-1771):
   * the names seen holding either after a step, sorted.
   */
  seen: string[];
  /** `config.flags.windowsEnabled` (shim SH-FLG-1: no canonical flag) */
  windowsEnabled: boolean;
}
