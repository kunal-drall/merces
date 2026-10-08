/**
 * DEX-aggregator port for the USDG → USDC swap route (E14, B8: "USDG enters through a swap"). Shaped after Jupiter's
 * Swap API V2 (verified 2026-10-07: GET /swap/v2/order → POST /swap/v2/execute, or GET /quote + POST /swap; `x-api-key`
 * required). Which aggregator to use is Part J.7; only the mock exists.
 */
export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  slippageBps: number;
  priceImpactBps: number;
  routePlan: { label: string; percent: number }[];
  /** opaque order id for execute */
  orderId: string;
}

export interface DexPort {
  readonly provider: 'jupiter' | 'mock';
  quote(params: { inputMint: string; outputMint: string; amount: string; slippageBps: number; taker: string }): Promise<SwapQuote>;
  /** Build the unsigned swap transaction (base64) for the taker to sign; the backend never signs. */
  buildSwap(orderId: string): Promise<{ transactionBase64: string; expiresAt: number }>;
}

export class MockDex implements DexPort {
  readonly provider = 'mock' as const;
  private readonly orders = new Map<string, SwapQuote>();
  constructor(private readonly rateBps = 9_995) {} // 1 USDG ≈ 0.9995 USDC in the mock
  async quote(params: { inputMint: string; outputMint: string; amount: string; slippageBps: number; taker: string }): Promise<SwapQuote> {
    const out = (BigInt(params.amount) * BigInt(this.rateBps)) / 10_000n;
    const orderId = `mockorder_${this.orders.size + 1}`;
    const q: SwapQuote = { inputMint: params.inputMint, outputMint: params.outputMint, inAmount: params.amount, outAmount: out.toString(), slippageBps: params.slippageBps, priceImpactBps: 1, routePlan: [{ label: 'MockStableSwap', percent: 100 }], orderId };
    this.orders.set(orderId, q);
    return q;
  }
  async buildSwap(orderId: string): Promise<{ transactionBase64: string; expiresAt: number }> {
    const q = this.orders.get(orderId);
    if (!q) throw new Error('unknown order');
    return { transactionBase64: Buffer.from(`mock-swap:${q.inputMint}>${q.outputMint}:${q.inAmount}`).toString('base64'), expiresAt: Math.floor(Date.now() / 1000) + 60 };
  }
}
