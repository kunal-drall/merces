/**
 * Stripe test-mode shaped data (field names follow the Stripe API: /v1/balance_transactions and /v1/payouts,
 * verified against the stripe/openapi spec on 2026-10-07). Amounts are in the smallest currency unit, as Stripe
 * returns them. Everything is synthetic and deterministic.
 */
export interface StripeBalanceTransaction {
  id: string;
  object: 'balance_transaction';
  amount: number;
  currency: string;
  created: number;
  available_on: number;
  fee: number;
  net: number;
  type: 'charge' | 'payout' | 'refund' | 'adjustment';
  status: 'available' | 'pending';
  description: string | null;
  source: string;
  reporting_category: string;
}

export interface StripePayout {
  id: string;
  object: 'payout';
  amount: number;
  currency: string;
  arrival_date: number;
  created: number;
  status: 'paid' | 'pending' | 'in_transit' | 'canceled' | 'failed';
  method: 'standard' | 'instant';
  type: 'bank_account' | 'card';
}

export interface StripeFixture {
  account: string;
  livemode: false;
  balance_transactions: StripeBalanceTransaction[];
  payouts: StripePayout[];
}

/** Build a year of test-mode charges that sum to the given quarterly YTD figures (cents). */
export function stripeFixtureFor(handle: string, year: number, incomeYtdByQuarter: [bigint, bigint, bigint, bigint], currency = 'usd'): StripeFixture {
  const txs: StripeBalanceTransaction[] = [];
  const payouts: StripePayout[] = [];
  let prev = 0n;
  let n = 0;
  for (let q = 0; q < 4; q++) {
    const target = incomeYtdByQuarter[q]! / 10_000n; // income base units (1e6) → cents (1e2)
    const quarterTotal = target - prev;
    prev = target;
    const months = [q * 3, q * 3 + 1, q * 3 + 2];
    let remaining = quarterTotal;
    for (const [i, m] of months.entries()) {
      const amount = i === 2 ? remaining : quarterTotal / 3n;
      remaining -= amount;
      if (amount <= 0n) continue;
      const created = Math.floor(Date.UTC(year, m, 15) / 1000);
      const fee = Number(amount) === 0 ? 0 : Math.floor(Number(amount) * 0.029) + 30;
      txs.push({ id: `txn_${handle}_${year}_${++n}`, object: 'balance_transaction', amount: Number(amount), currency, created, available_on: created + 2 * 86_400, fee, net: Number(amount) - fee, type: 'charge', status: 'available', description: `Invoice ${n}`, source: `ch_${handle}_${n}`, reporting_category: 'charge' });
      payouts.push({ id: `po_${handle}_${year}_${n}`, object: 'payout', amount: Number(amount) - fee, currency, arrival_date: created + 3 * 86_400, created: created + 2 * 86_400, status: 'paid', method: 'standard', type: 'bank_account' });
    }
  }
  return { account: `acct_test_${handle}`, livemode: false, balance_transactions: txs, payouts };
}

/** Gross covered income (cents) from charges up to and including `untilTs`, as the zkTLS provider would attest. */
export function stripeGrossUntil(f: StripeFixture, untilTs: number): bigint {
  return f.balance_transactions.filter((t) => t.type === 'charge' && t.created <= untilTs).reduce((a, t) => a + BigInt(t.amount), 0n);
}
