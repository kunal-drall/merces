/**
 * The Rust oracle (`tools/stage1-oracle`): find cargo, build the crate against the Stage 1 checkout's merces-common
 * with Stage 1's toolchain, and run a corpus through it.
 *
 * The committed crate depends on the pinned submodule (`../../stage1/solana/crates/merces-common`). For another
 * checkout (`STAGE1_PATH`) the gate builds a copy of the crate whose dependency points at that checkout, in its own
 * target directory under the sync's output, so the answers are always the checkout's own.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Answer, OracleCase } from './family.ts';
import { wire } from './family.ts';

/** The repository root (this file is packages/stage1-sync/src/curve-port/oracle.ts). */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const ORACLE_DIR = join(REPO_ROOT, 'tools', 'stage1-oracle');
/** merces-common inside a Stage 1 checkout, and the committed crate's dependency on the submodule's. */
export const MERCES_COMMON_CRATE = 'solana/crates/merces-common';
export const ORACLE_DEPENDENCY = '../../stage1/solana/crates/merces-common';
/** Stage 1's toolchain file. */
export const STAGE1_TOOLCHAIN_FILE = 'solana/rust-toolchain.toml';

export class OracleError extends Error {}

/**
 * The cargo to run: an explicit path, else `CARGO`, else `cargo` on PATH, else rustup's default `~/.cargo/bin/cargo`;
 * `missing`, naming what was tried, when none runs.
 */
export function findCargo(explicit?: string): { cargo: string } | { missing: string } {
  const tried: string[] = [];
  const candidates = explicit ? [explicit] : [process.env.CARGO, 'cargo', join(homedir(), '.cargo', 'bin', 'cargo')].filter((c): c is string => !!c);
  for (const c of candidates) {
    tried.push(c);
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!r.error && r.status === 0) return { cargo: c };
  }
  return { missing: `cargo not found (tried ${tried.join(', ')})` };
}

/** Stage 1's pinned toolchain channel (`channel = "…"` in solana/rust-toolchain.toml), or null without the file. */
export function stage1Toolchain(stage1Root: string): string | null {
  const f = join(stage1Root, STAGE1_TOOLCHAIN_FILE);
  if (!existsSync(f)) return null;
  return /^\s*channel\s*=\s*"([^"]+)"/m.exec(readFileSync(f, 'utf8'))?.[1] ?? null;
}

/**
 * The environment cargo runs in: Stage 1's channel through rustup (`RUSTUP_TOOLCHAIN`) unless the caller already set
 * one; a cargo outside rustup ignores it and the version check reports what was used.
 */
export function cargoEnv(stage1Root: string, targetDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: targetDir, CARGO_TERM_COLOR: 'never' };
  const channel = stage1Toolchain(stage1Root);
  if (channel && !process.env.RUSTUP_TOOLCHAIN) env.RUSTUP_TOOLCHAIN = channel;
  return env;
}

/** `cargo --version` and `rustc --version` under that environment (rustc next to cargo when it is a path). */
export function toolchainVersions(cargo: string, env: NodeJS.ProcessEnv): { cargo: string; rustc: string | null } {
  const run = (bin: string) => {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return !r.error && r.status === 0 ? r.stdout.trim() : null;
  };
  const c = run(cargo);
  if (!c) throw new OracleError(`\`${cargo} --version\` fails under the pinned toolchain (${env.RUSTUP_TOOLCHAIN ?? 'default'}); install it: rustup toolchain install ${env.RUSTUP_TOOLCHAIN ?? 'stable'} --profile minimal`);
  const rustc = cargo.includes('/') ? join(cargo, '..', 'rustc') : 'rustc';
  return { cargo: c, rustc: run(rustc) };
}

/**
 * The crate directory to build for a checkout: the committed crate when the checkout's merces-common is the submodule
 * it depends on, else a copy (in `scratch`) whose dependency is the checkout's merces-common.
 */
export function crateFor(stage1Root: string, scratch: string, oracleDir = ORACLE_DIR): { dir: string; targetDir: string; overlay: boolean } {
  const theirs = join(stage1Root, MERCES_COMMON_CRATE);
  if (!existsSync(join(theirs, 'Cargo.toml'))) throw new OracleError(`merces-common is not in this Stage 1 drop (${MERCES_COMMON_CRATE}/Cargo.toml missing)`);
  const manifest = readFileSync(join(oracleDir, 'Cargo.toml'), 'utf8');
  if (!manifest.includes(`path = "${ORACLE_DEPENDENCY}"`)) throw new OracleError(`${join(oracleDir, 'Cargo.toml')} no longer depends on ${ORACLE_DEPENDENCY}`);
  const pinned = resolve(oracleDir, ORACLE_DEPENDENCY);
  if (existsSync(pinned) && realpathSync(pinned) === realpathSync(theirs)) return { dir: oracleDir, targetDir: join(oracleDir, 'target'), overlay: false };
  const dir = join(scratch, 'stage1-oracle');
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const f of readdirSync(join(oracleDir, 'src'))) copyFileSync(join(oracleDir, 'src', f), join(dir, 'src', f));
  writeFileSync(join(dir, 'Cargo.toml'), manifest.replace(`path = "${ORACLE_DEPENDENCY}"`, `path = ${JSON.stringify(realpathSync(theirs))}`));
  return { dir, targetDir: join(dir, 'target'), overlay: true };
}

/** Builds the crate (offline, release) and returns the binary's path. */
export function buildOracle(cargo: string, crate: { dir: string; targetDir: string }, env: NodeJS.ProcessEnv): string {
  const r = spawnSync(cargo, ['build', '--release', '--offline', '--quiet', '--manifest-path', join(crate.dir, 'Cargo.toml')], {
    cwd: crate.dir,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600_000,
  });
  if (r.error || r.status !== 0) {
    const why = (r.stderr || r.error?.message || '').trim().split('\n').slice(-6).join(' | ');
    throw new OracleError(`cargo build of the oracle failed (${crate.dir}): ${why}`);
  }
  const bin = join(crate.targetDir, 'release', process.platform === 'win32' ? 'stage1-oracle.exe' : 'stage1-oracle');
  if (!existsSync(bin)) throw new OracleError(`cargo built no oracle binary at ${bin}`);
  return bin;
}

/** Runs the cases through the binary; one answer per case, keyed by id. */
export function runOracle(bin: string, cases: readonly OracleCase[]): Map<number, Answer> {
  const r = spawnSync(bin, [], { input: cases.map(wire).join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'], timeout: 600_000 });
  if (r.error || r.status !== 0) throw new OracleError(`the oracle exited ${r.status ?? r.error?.message}: ${(r.stderr ?? '').trim().slice(0, 400)}`);
  const out = new Map<number, Answer>();
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const { id, ...answer } = JSON.parse(line) as { id: number | null } & Answer;
    if (id === null) throw new OracleError(`the oracle could not read a case: ${(answer as { bad?: string }).bad ?? line}`);
    out.set(id, answer as Answer);
  }
  return out;
}
