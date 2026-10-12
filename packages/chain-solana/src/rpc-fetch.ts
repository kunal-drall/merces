/** One shared queue, including SDK retries. A 429 pauses already queued work too. */
export function pacedFetch(intervalMs: number, send: typeof fetch = fetch): typeof fetch {
  let next = 0, limited = 0;
  let tail: Promise<unknown> = Promise.resolve();
  return (input, init) => {
    const run = tail.then(async () => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.throwIfAborted();
      if (next > Date.now()) await new Promise(resolve => setTimeout(resolve, next - Date.now()));
      signal?.throwIfAborted();
      next = Date.now() + intervalMs;
      // Wait for headers before releasing the next request so it sees any new cooldown.
      // Do not retry here: web3 owns retries and transaction bytes must not be rebuilt.
      const response = await send(input, init);
      if (response.status === 429) {
        const value = response.headers.get('retry-after');
        const seconds = value !== null && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
        const until = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(value ?? '');
        const backoff = Math.min(30_000, 1000 * 2 ** Math.min(limited++, 5));
        next = Math.max(next, Date.now() + backoff, Number.isFinite(until) ? until : 0);
      } else if (response.ok) {
        limited = 0;
      }
      return response;
    });
    // A failed or cancelled caller cannot poison the queue for later requests.
    tail = run.catch(() => undefined);
    return run;
  };
}
