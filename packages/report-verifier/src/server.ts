import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { attestRequestSchema, type ReportVerifierPort } from './verifier.ts';

/**
 * Minimal HTTP surface (no framework, no body logging). Logs carry a request id, a route, an outcome code and
 * a duration — never a body. Errors are reported as codes.
 */
export function createVerifierServer(verifier: ReportVerifierPort, log: (line: string) => void = (l) => process.stdout.write(l + '\n')) {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
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
    const done = (code: string) => log(`verifier req=${id} ${req.method} ${req.url} outcome=${code} ms=${Date.now() - t0}`);
    try {
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ok: true, service: 'report-verifier' });
        return done('ok');
      }
      if (req.method === 'GET' && req.url === '/keys') {
        json(res, 200, await verifier.publicKey());
        return done('ok');
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
