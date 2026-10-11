import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Cause code:
 *  - S4-CS: the S4 WP13 grep gates (S4 plan §3 WP13 acceptance, amendment fix 6), as tests over every TypeScript and YAML
 *    file under packages/ (generated files, dependencies and builds excluded):
 *     1. the co-signing machinery and the retired attestation formats are gone: no co-signer field or co-signing call,
 *        no EIP-191 attestation text builder, no co-signed attestor rate, and no simulator allowance for a dev-mode chain,
 *        comments included;
 *     2. ed25519 verification (node:crypto's verify, imported as ed-Verify) is Solana sign-in only:
 *        `ports/src/wallet-verify.ts`, and the ports test of the Solana fee payer's signature (`ports/test/ports.test.ts`,
 *        amendment fix 6);
 *     3. no service, API, report verifier, indexer or keeper source imports Stage 1's test-key derivation
 *        (`@merces/math/testing`; the repository-wide list is the math package's own gate, cause S4-G).
 *  The retired names are spelled in parts here so that this file does not match its own gates (nor the plan's greps).
 */

/** The repository root (packages/domain/test → ../../..). */
const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** Every .ts and .yaml file under packages/, as repository-relative paths (no generated files, dependencies or builds). */
function packageFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e === 'generated' || e === 'dist') continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|yaml)$/.test(e)) out.push(relative(REPO, p).split('\\').join('/'));
    }
  };
  walk(join(REPO, 'packages'));
  return out.sort();
}

/** `rel:line` for every line of the files matching `re`. */
function hits(files: readonly string[], re: RegExp): string[] {
  const out: string[] = [];
  for (const f of files) {
    readFileSync(join(REPO, f), 'utf8').split('\n').forEach((line, i) => {
      if (re.test(line)) out.push(`${f}:${i + 1}`);
    });
  }
  return out;
}

const j = (...parts: string[]): string => parts.join('');

/** Gate 1, as the plan's grep spells it (`\bcoSigners?\b|\.coSign\(|…`), assembled from parts. */
const RETIRED = new RegExp(
  [
    `\\b${j('co', 'Signers')}?\\b`,
    `\\.${j('co', 'Sign')}\\(`,
    j('attestation', 'Message'),
    j('fxAttestation', 'Message'),
    j('tier3Attestation', 'Text'),
    j('attestor', 'Rate'),
    j('allowSimulator: this.ctx.devMode \\|\\| ', 'chain.mode'),
  ].join('|'),
);

describe('S4 WP13 grep gates (cause S4-CS)', () => {
  const files = packageFiles();

  it('walks the whole tree: the sources, the tests and the OpenAPI fragments', () => {
    expect(files).toContain('packages/domain/src/commands.ts');
    expect(files).toContain('packages/api/src/openapi/fragments/attestor.yaml');
    expect(files).toContain('packages/api/openapi.yaml');
    expect(files.some((f) => f.includes('/generated/') || f.includes('node_modules'))).toBe(false);
  });

  it('gate 1: no co-signer, no co-signing call, no retired attestation text or co-signed rate, anywhere', () => {
    expect(hits(files, RETIRED)).toEqual([]);
    // the pattern finds what it must (the field, the call, each retired name)
    for (const line of [`tx.${j('co', 'Signers')}`, `x.${j('co', 'Signer')} = 1`, `await w.${j('co', 'Sign')}(signed)`, j('attestation', 'Message'), j('fxAttestation', 'Message'), j('tier3Attestation', 'Text'), j('attestor', 'Rate'), j('allowSimulator: this.ctx.devMode || ', 'chain.mode')]) {
      expect(RETIRED.test(line), line).toBe(true);
    }
    expect(RETIRED.test('nobody co-signs; a co-signer list')).toBe(false);
  });

  it('gate 2: ed25519 verification is Solana sign-in only (and its ports test)', () => {
    expect([...new Set(hits(files.filter((f) => f.endsWith('.ts')), new RegExp(j('ed', 'Verify'))).map((h) => h.slice(0, h.lastIndexOf(':'))))]).toEqual([
      'packages/ports/src/wallet-verify.ts',
      'packages/ports/test/ports.test.ts',
    ]);
  });

  it('gate 3: no service, API, report verifier, indexer or keeper source imports Stage 1\'s test-key derivation', () => {
    const src = files.filter((f) => /^packages\/(services|api|report-verifier|indexer|keepers)\/src\//.test(f));
    expect(src.length).toBeGreaterThan(20);
    expect(hits(src, /@merces\/math\/testing/)).toEqual([]);
  });
});
