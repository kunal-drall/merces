import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * The Stage 1 handoff manifest (Part D5). We are tolerant of differences: every field is optional and
 * unknown keys are kept. If Stage 1 arrives without a manifest, `stage1.map.json` (hand-written) is used instead.
 */
export const stage1ManifestSchema = z
  .object({
    version: z.string().optional(),
    commit: z.string().optional(),
    math: z.object({ package: z.string() }).partial().optional(),
    vectors: z.string().optional(),
    events: z.object({ doc: z.string().optional(), schema: z.string().optional() }).optional(),
    solana: z
      .object({
        cluster: z.string().optional(),
        rpcUrl: z.string().optional(),
        programs: z.record(z.string(), z.string()).optional(),
        idlDir: z.string().optional(),
        startSlot: z.number().optional(),
      })
      .optional(),
    evm: z
      .array(
        z.object({
          chain: z.string(),
          chainId: z.number(),
          rpcUrl: z.string().optional(),
          startBlock: z.number().optional(),
          contracts: z.record(z.string(), z.string()).optional(),
          abiDir: z.string().optional(),
        }),
      )
      .optional(),
    stablecoins: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  })
  .passthrough();
export type Stage1Manifest = z.infer<typeof stage1ManifestSchema>;

export interface Stage1Location {
  kind: 'manifest' | 'map';
  path: string;
  root: string;
  manifest: Stage1Manifest;
  problems: string[];
}

/** The commit a Stage 1 git checkout is at, or null when it is not one (or git is unavailable). */
function checkoutCommit(root: string): string | null {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Locate Stage 1 through STAGE1_PATH (directory, submodule or package). Returns null when absent.
 * Stage 1's own manifest wins; a `stage1.map.json` in this repository is used only for a non-empty
 * checkout, and a checkout at a different commit than the map pins is reported as a problem.
 */
export function locateStage1(stage1Path: string | undefined = process.env.STAGE1_PATH): Stage1Location | null {
  if (!stage1Path) return null;
  const root = resolve(stage1Path);
  if (!existsSync(root)) return null;
  const candidates: { kind: 'manifest' | 'map'; path: string; local?: boolean }[] = [
    { kind: 'manifest', path: join(root, 'handoff', 'manifest.json') },
    { kind: 'manifest', path: join(root, 'manifest.json') },
    { kind: 'map', path: join(root, 'stage1.map.json') },
    { kind: 'map', path: resolve('stage1.map.json'), local: true },
  ];
  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    if (c.local && readdirSync(root).length === 0) continue;
    const problems: string[] = [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(c.path, 'utf8'));
    } catch (e) {
      problems.push(`unreadable JSON: ${(e as Error).message}`);
      return { kind: c.kind, path: c.path, root, manifest: {}, problems };
    }
    const parsed = stage1ManifestSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
      return { kind: c.kind, path: c.path, root, manifest: (raw as Stage1Manifest) ?? {}, problems };
    }
    if (c.local && parsed.data.commit) {
      const head = checkoutCommit(root);
      if (head && !head.startsWith(parsed.data.commit)) problems.push(`stage1.map.json pins ${parsed.data.commit} but the checkout is at ${head.slice(0, 7)}`);
    }
    return { kind: c.kind, path: c.path, root, manifest: parsed.data, problems };
  }
  return null;
}

/** Resolve a manifest-relative path against the Stage 1 root. */
export function stage1Path(loc: Stage1Location, p: string | undefined): string | null {
  if (!p) return null;
  return resolve(loc.root, p);
}
