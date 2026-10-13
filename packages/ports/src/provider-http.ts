/** Provider errors intentionally omit response bodies, tokens, URLs and applicant data. */
export async function providerRequest(url: string, init: RequestInit, fetcher: typeof fetch = fetch): Promise<Response> {
  let response: Response;
  try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) }); }
  catch { throw Error('provider-connection-failed'); }
  if (!response.ok) throw Error(`provider-http-${response.status}`);
  return response;
}

export async function providerJson(url: string, init: RequestInit, fetcher: typeof fetch = fetch): Promise<Record<string, any>> {
  const response = await providerRequest(url, init, fetcher);
  if (Number(response.headers.get('content-length') ?? 0) > 2_000_000) throw Error('provider-response-too-large');
  const reader = response.body?.getReader();
  if (!reader) throw Error('provider-empty-response');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) throw Error('provider-response-too-large'); chunks.push(value); }
  } finally { await reader.cancel(); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); return value; }
  catch { throw Error('provider-invalid-response'); }
}
