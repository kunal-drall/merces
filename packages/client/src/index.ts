import type { paths } from './generated/openapi.d.ts';

/**
 * A minimal typed client. Paths and methods come from the generated OpenAPI types; the wrapper adds the
 * session bearer token and an Idempotency-Key for writes.
 */
export type Paths = paths;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type PathsWith<M extends Method> = { [P in keyof paths]: paths[P] extends Record<M, unknown> ? P : never }[keyof paths];
type Op<P extends keyof paths, M extends Method> = paths[P] extends Record<M, infer O> ? O : never;
type Json<O> = O extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : O extends { responses: { 201: { content: { 'application/json': infer R } } } } ? R : unknown;
type Body<O> = O extends { requestBody: { content: { 'application/json': infer B } } } ? B : O extends { requestBody?: { content: { 'application/json': infer B } } } ? B | undefined : undefined;
type Query<O> = O extends { parameters: { query?: infer Q } } ? Q : undefined;
type PathParams<O> = O extends { parameters: { path: infer PP } } ? PP : undefined;

export interface ClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

export class MercesApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail: unknown,
  ) {
    super(message);
  }
}

function fill(path: string, params: Record<string, string | number> | undefined): string {
  return path.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(String(params?.[k] ?? '')));
}

export function createClient(opts: ClientOptions) {
  const f = opts.fetch ?? fetch;
  let token = opts.token;
  async function call<P extends keyof paths, M extends Method>(method: M, path: P, args: { path?: PathParams<Op<P, M>>; query?: Query<Op<P, M>>; body?: Body<Op<P, M>>; idempotencyKey?: string } = {}): Promise<Json<Op<P, M>>> {
    const url = new URL(fill(path as string, args.path as Record<string, string | number> | undefined), opts.baseUrl);
    for (const [k, v] of Object.entries((args.query ?? {}) as Record<string, unknown>)) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (args.body !== undefined) headers['content-type'] = 'application/json';
    if (args.idempotencyKey) headers['idempotency-key'] = args.idempotencyKey;
    const res = await f(url, { method: method.toUpperCase(), headers, body: args.body === undefined ? undefined : JSON.stringify(args.body) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new MercesApiError(res.status, json?.error ?? 'Error', json?.message ?? res.statusText, json?.detail ?? null);
    return json as Json<Op<P, M>>;
  }
  return {
    setToken(t: string | undefined) {
      token = t;
    },
    get: <P extends PathsWith<'get'>>(path: P, args?: { path?: PathParams<Op<P, 'get'>>; query?: Query<Op<P, 'get'>> }) => call('get', path, args ?? {}),
    post: <P extends PathsWith<'post'>>(path: P, args?: { path?: PathParams<Op<P, 'post'>>; body?: Body<Op<P, 'post'>>; idempotencyKey?: string }) => call('post', path, args ?? {}),
    put: <P extends PathsWith<'put'>>(path: P, args?: { path?: PathParams<Op<P, 'put'>>; body?: Body<Op<P, 'put'>>; idempotencyKey?: string }) => call('put', path, args ?? {}),
    delete: <P extends PathsWith<'delete'>>(path: P, args?: { path?: PathParams<Op<P, 'delete'>> }) => call('delete', path, args ?? {}),
  };
}

export type MercesClient = ReturnType<typeof createClient>;
