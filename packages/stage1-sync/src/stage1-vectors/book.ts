/**
 * The merces backend's own bookkeeping (S1 plan §5.2): what Stage 1's multi-step auction and window record and our
 * one-step canonical model does not (tally rounds, processed and delivered bids, minted units, window phases), plus
 * the runner-held terms canonical terms lack (the window durations and fee) and the actors Stage 1 lists in
 * `balances`. Fields here are shim-derived and therefore "not parity" (VECTOR_PARITY.md).
 *
 * Plain JSON (strings for amounts) so a revert check can compare it byte for byte; it changes only when a step
 * succeeds.
 */
export interface AuctionBook {
  tallyRound: number;
  roundRejected: boolean;
  rejectionReason: string | null;
  /** set by `finalize_settlement` from the round's tally (SIM:955-958) */
  qAbove: string;
  qAt: string;
  R: string;
  /** the tally of the open round (`begin_settlement`), published at `finalize_settlement` */
  round: { qAbove: string; qAt: string; R: string } | null;
  unitsMinted: string;
  bidsProcessed: number;
  /** vector names, in processing / delivery order */
  processed: string[];
  delivered: string[];
}

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
  auction: AuctionBook;
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

export function newAuctionBook(): AuctionBook {
  return { tallyRound: 0, roundRejected: false, rejectionReason: null, qAbove: '0', qAt: '0', R: '0', round: null, unitsMinted: '0', bidsProcessed: 0, processed: [], delivered: [] };
}
