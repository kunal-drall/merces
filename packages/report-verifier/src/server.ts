import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { familyOfChainKind, parseSeriesId, seriesKeyOf } from '@merces/domain';
import { assertSyntheticIncomeNetwork, type SyntheticIncomeZkTls } from '@merces/ports';
import { attestRequestSchema, type ReportVerifierPort } from './verifier.ts';

/**
 * Minimal HTTP surface (no framework, no body logging). Logs carry a request id, a route, an outcome code and
 * a duration — never a body. Errors are reported as codes.
 */
export function createVerifierServer(verifier: ReportVerifierPort, log: (line: string) => void = (l) => process.stdout.write(l + '\n'), options: {synthetic?: SyntheticIncomeZkTls; allowedOrigins?: readonly string[]} = {}) {
  const origins = new Set(options.allowedOrigins ?? []);
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !(parsed.protocol === 'https:' || parsed.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))) throw Error('Invalid verifier browser origin.');
  }
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage, limit = 512 * 1024): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) reject(new Error('too-large'));
        else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  return createServer(async (req, res) => {
    const id = randomUUID().slice(0, 8);
    const t0 = Date.now();
    const route = ['/health','/keys','/attest','/synthetic/fixture'].includes(req.url ?? '') ? req.url : 'unknown';
    const done = (code: string) => log(`verifier req=${id} ${req.method} ${route} outcome=${code} ms=${Date.now() - t0}`);
    try {
      if (req.headers.origin) {
        if (!origins.has(req.headers.origin)) { json(res,403,{ok:false,code:'origin-refused'});return done('origin-refused'); }
        res.setHeader('Access-Control-Allow-Origin',req.headers.origin);
        res.setHeader('Vary','Origin');
        if (req.method === 'OPTIONS') {
          if (route === 'unknown' || !['GET','POST'].includes(String(req.headers['access-control-request-method']))) {json(res,403,{ok:false,code:'origin-refused'});return done('origin-refused');}
          res.setHeader('Access-Control-Allow-Methods','GET, POST');
          res.setHeader('Access-Control-Allow-Headers','Content-Type');
          res.writeHead(204);res.end();return done('preflight');
        }
      }
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ok: true, service: 'report-verifier' });
        return done('ok');
      }
      if (req.method === 'GET' && req.url === '/keys') {
        json(res, 200, await verifier.publicKey());
        return done('ok');
      }
      if (req.method === 'POST' && req.url === '/synthetic/fixture' && options.synthetic) {
        try {
          const body = z.object({seriesId:z.string().max(160),periodId:z.string().regex(/^\d{4}Q[1-4]$/)}).strict().parse(JSON.parse(await readBody(req,4096)));
          const keys = await verifier.publicKey();
          const chain = keys.chains.find(c => c.chain === parseSeriesId(body.seriesId).chain);
          if (!keys.syntheticIncome?.testOnly || !chain) throw Error('Synthetic provider unavailable.');
          assertSyntheticIncomeNetwork(chain.domain);
          seriesKeyOf(body.seriesId,familyOfChainKind(chain.domain.chainKind));
          json(res,200,options.synthetic.fixture(body.seriesId,body.periodId));return done('synthetic-fixture');
        } catch {json(res,400,{ok:false,code:'synthetic-fixture-refused'});return done('synthetic-fixture-refused');}
      }
      if (req.method === 'POST' && req.url === '/attest') {
        let parsed;
        try {
          parsed = attestRequestSchema.safeParse(JSON.parse(await readBody(req)));
        } catch {
          json(res, 400, { ok: false, code: 'bad-request' });
          return done('bad-request');
        }
        if (!parsed.success) {
          json(res, 400, { ok: false, code: 'bad-request' });
          return done('bad-request');
        }
        const r = await verifier.attest(parsed.data);
        json(res, r.ok ? 200 : 422, r);
        return done(r.ok ? 'attested' : r.code);
      }
      json(res, 404, { ok: false, code: 'not-found' });
      done('not-found');
    } catch {
      json(res, 500, { ok: false, code: 'internal' });
      done('internal');
    }
  });
}
