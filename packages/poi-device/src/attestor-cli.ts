#!/usr/bin/env tsx
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { isPublishedTestKey, SigningError } from '@merces/domain';
import { AttestorKey, KeystoreError, createKeystore, decryptKeystore, isTestHarness, keystoreKdf } from './attestor-keys.ts';
import { AttestorToolError, checkLinkChallenge, checkRequest, describeLinkChallenge, describeSigningRequest, linkProof, pinNetworks, signChecked, type CheckedSigningRequest } from './attestor-signer.ts';

/**
 * `merces-attestor`: the Merces attestor tool (S4 D2, WP8), a command-line signer that runs on the attestor's own
 * machine. The backend never sees the key: the tool keeps it in a Web3 Secret Storage v3 keystore, checks every
 * signing request against its own pinned network table, shows what the request authorises from the typed fields, signs
 * the digest it rebuilt, and prints only the signature. It never prints the private key, and it has no command that
 * would.
 *
 * Passwords are read from the terminal with echo off by default. `--password-env NAME` reads one from an environment
 * variable instead, for scripted use; such a password is exposed through `/proc/<pid>/environ` to the same user and
 * root, and through shell history when it is set on the command line (RUNBOOK "Attestor key setup").
 *
 * `MERCES_ATTESTOR_TEST_SCRYPT_N` lowers the keystore's scrypt n for the test harness only (`VITEST=true` or
 * `NODE_ENV=test`); anywhere else the tool refuses to start a command with it set.
 */

export const TEST_SCRYPT_N_ENV = 'MERCES_ATTESTOR_TEST_SCRYPT_N';
const KEYSTORE_ENV = 'MERCES_ATTESTOR_KEYSTORE';
const NETWORKS_ENV = 'MERCES_ATTESTOR_NETWORKS';
const MAX_REQUESTS = 64;

const USAGE = `merces-attestor: the Merces attestor tool (your attestor key never leaves this machine)

Usage: merces-attestor <command> [options]

Commands:
  keygen                make a new attestor key in a new keystore
  import <file>         put an existing key in a new keystore: <file> is a Web3 Secret Storage v3
                        keystore (geth, cast, ...) or holds a 0x-hex private key; re-encrypted at full strength
  address               print the keystore's key address
  link <challenge.txt>  sign a key-link challenge (the "message" of POST /me/signer-keys/challenge);
                        prints the body of POST /me/signer-keys
  sign <request.json>   check a signing request (or a list) against the pinned network table, show it,
                        and sign the digest rebuilt on this machine; prints {signer, signature, digest}

Options:
  --keystore <path>             the keystore (default $${KEYSTORE_ENV} or ~/.merces/attestor/keystore.json)
  --networks <path>             the pinned network table for sign (default $${NETWORKS_ENV} or ~/.merces/attestor/networks.json)
  --allow-local                 accept the simulator's local chain ids (development only)
  --out <path>                  write the JSON result to <path> (mode 0600) instead of stdout
  --yes                         sign without asking (the display and warnings are still printed)
  --password-env <NAME>         read the keystore password from environment variable NAME instead of the terminal
                                (exposed through /proc/<pid>/environ and shell history; avoid it)
  --source-password-env <NAME>  import: the password of the keystore being imported, from NAME
  --help                        this text
`;

export type CliErrorCode = 'usage' | 'no-tty' | 'aborted' | 'exists' | 'io' | 'unrecognised' | 'declined';
export class CliError extends Error {
  constructor(
    public readonly code: CliErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const NO_TTY =
  'no terminal to read the password from: run the tool in a terminal, or pass --password-env NAME (a password in an environment variable is exposed through /proc/<pid>/environ and shell history)';

/** Where the tool talks: stdout carries JSON results only; stderr carries the display, guidance, prompts and errors. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  /** reads a password from the terminal with echo off; rejects with `CliError('no-tty')` when there is no terminal */
  readPassword(prompt: string): Promise<string>;
  /** asks yes or no on the terminal; false when there is no terminal */
  confirm(prompt: string): Promise<boolean>;
}

// ---------------------------------------------------------------- the terminal

/** What `readHiddenLine` needs of a terminal input (a `tty.ReadStream`). */
export interface TtyInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Reads one line from a terminal in raw mode, echoing nothing (the password is never written to `output`): Enter ends
 * it, Backspace deletes, Ctrl-C (or Ctrl-D on an empty line) aborts. The terminal's mode is restored on every path.
 * Rejects with `CliError('no-tty')` when `input` is not a terminal.
 */
export function readHiddenLine(input: TtyInput, output: { write(s: string): unknown }, prompt: string): Promise<string> {
  if (input.isTTY !== true || typeof input.setRawMode !== 'function') return Promise.reject(new CliError('no-tty', NO_TTY));
  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  return new Promise((resolvePromise, reject) => {
    const decoder = new StringDecoder('utf8');
    let value = '';
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      input.removeListener('data', onData);
      input.setRawMode!(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolvePromise(value);
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new CliError('aborted', 'aborted'));
        if (ch === '\u0004') {
          if (value === '') return finish(new CliError('aborted', 'aborted'));
          continue;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
      }
    };
    input.on('data', onData);
  });
}

/** The process's own terminal: stdin for input, stderr for prompts (stdout stays clean JSON). */
export function nodeIo(): CliIo {
  return {
    out: (t) => void process.stdout.write(t.endsWith('\n') ? t : `${t}\n`),
    err: (t) => void process.stderr.write(t.endsWith('\n') ? t : `${t}\n`),
    env: process.env,
    readPassword: (prompt) => readHiddenLine(process.stdin, process.stderr, prompt),
    confirm: async (prompt) => {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
      try {
        return /^y(es)?$/i.test((await rl.question(prompt)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

// ---------------------------------------------------------------- arguments

interface Options {
  keystore?: string;
  networks?: string;
  out?: string;
  passwordEnv?: string;
  sourcePasswordEnv?: string;
  allowLocal: boolean;
  yes: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): { command: string | undefined; positional: string[]; opts: Options } {
  const opts: Options = { allowLocal: false, yes: false, help: false };
  const positional: string[] = [];
  const valued: Record<string, keyof Options> = { '--keystore': 'keystore', '--networks': 'networks', '--out': 'out', '--password-env': 'passwordEnv', '--source-password-env': 'sourcePasswordEnv' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--allow-local') opts.allowLocal = true;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a in valued) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new CliError('usage', `${a} needs a value`);
      (opts as unknown as Record<string, string>)[valued[a]!] = v;
    } else if (a.startsWith('-')) throw new CliError('usage', `unknown option ${a}`);
    else positional.push(a);
  }
  return { command: positional.shift(), positional, opts };
}

function home(env: CliIo['env']): string {
  return env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
}
function keystorePath(opts: Options, env: CliIo['env']): string {
  return resolve(opts.keystore ?? env[KEYSTORE_ENV] ?? join(home(env), '.merces', 'attestor', 'keystore.json'));
}
function networksPath(opts: Options, env: CliIo['env']): string {
  return resolve(opts.networks ?? env[NETWORKS_ENV] ?? join(home(env), '.merces', 'attestor', 'networks.json'));
}

/** The scrypt n for a new keystore: the standard one, or the test override under the test harness only. */
export function scryptNFor(env: CliIo['env']): number | undefined {
  const v = env[TEST_SCRYPT_N_ENV];
  if (v === undefined || v === '') return undefined;
  if (!isTestHarness(env)) {
    throw new CliError('usage', `${TEST_SCRYPT_N_ENV} works only under the test harness (VITEST=true or NODE_ENV=test): a keystore this tool writes always has scrypt n of at least 2^18`);
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new CliError('usage', `${TEST_SCRYPT_N_ENV} is not an integer`);
  return n;
}

// ---------------------------------------------------------------- files

function readSmall(path: string, maxBytes: number, what: string): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    throw new CliError('io', `cannot read the ${what} (${path})`);
  }
  if (size > maxBytes) throw new CliError('io', `the ${what} is larger than ${maxBytes} bytes (${path})`);
  return readFileSync(path, 'utf8');
}
function readJson(path: string, maxBytes: number, what: string): unknown {
  const text = readSmall(path, maxBytes, what);
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('io', `the ${what} is not JSON (${path})`);
  }
}
/** Writes a file readable by its owner only (0600) in a directory only its owner can enter (0700 when created). */
function writePrivate(path: string, content: string, opts: { overwrite: boolean }): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, content, { mode: 0o600, flag: opts.overwrite ? 'w' : 'wx' });
    chmodSync(path, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('exists', `${path} already exists; this tool never overwrites a keystore`);
    throw new CliError('io', `cannot write ${path}`);
  }
}
function emit(io: CliIo, opts: Options, result: unknown): void {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (opts.out) {
    writePrivate(resolve(opts.out), text, { overwrite: true });
    io.err(`Written to ${resolve(opts.out)}`);
  } else io.out(text);
}

// ---------------------------------------------------------------- passwords and keys

function envPassword(io: CliIo, name: string): string {
  const v = io.env[name];
  if (v === undefined || v === '') throw new CliError('usage', `the environment variable ${name} is not set`);
  io.err(`Note: reading a password from $${name}; a password in the environment is exposed through /proc/<pid>/environ and shell history.`);
  return v;
}
async function newPassword(io: CliIo, opts: Options): Promise<string> {
  if (opts.passwordEnv) return envPassword(io, opts.passwordEnv);
  const a = await io.readPassword('New keystore password (at least 8 characters): ');
  const b = await io.readPassword('Repeat the password: ');
  if (a !== b) throw new CliError('usage', 'the two passwords differ');
  return a;
}
async function existingPassword(io: CliIo, prompt: string, envName: string | undefined): Promise<string> {
  return envName ? envPassword(io, envName) : io.readPassword(prompt);
}

async function loadKey(io: CliIo, opts: Options): Promise<AttestorKey> {
  const path = keystorePath(opts, io.env);
  if (!existsSync(path)) throw new CliError('io', `no keystore at ${path} (run \`merces-attestor keygen\`, or pass --keystore)`);
  try {
    if ((statSync(path).mode & 0o077) !== 0) io.err(`Warning: ${path} is readable by other users; chmod 600 it.`);
  } catch {
    // reading the mode is advisory only
  }
  const json = readJson(path, 64 * 1024, 'keystore');
  const kdf = keystoreKdf(json);
  if (kdf === null) throw new CliError('unrecognised', `${path} is not a Web3 Secret Storage v3 keystore`);
  const password = await existingPassword(io, 'Keystore password: ', opts.passwordEnv);
  return decryptKeystore(json, password, { env: io.env });
}

async function writeNewKeystore(io: CliIo, opts: Options, key: AttestorKey): Promise<{ address: string; checksumAddress: string; keystore: string }> {
  const path = keystorePath(opts, io.env);
  refuseExisting(io, opts);
  const scryptN = scryptNFor(io.env);
  const password = await newPassword(io, opts);
  io.err('Encrypting the key (scrypt; this takes a moment)...');
  const ks = await createKeystore(key, password, { ...(scryptN === undefined ? {} : { scryptN }), env: io.env });
  writePrivate(path, `${JSON.stringify(ks, null, 2)}\n`, { overwrite: false });
  io.err(
    [
      `Keystore written to ${path} (mode 0600).`,
      'Back up the keystore file and its password: the key cannot be recovered without both, and Merces cannot recover it.',
      'This key is dedicated to attesting: never fund it and never import it into a wallet. It signs raw Stage 1 digests,',
      'and a raw-digest signer would sign any 32 bytes, a transaction hash included.',
      'Next: link it to your account (POST /me/signer-keys/challenge, then `merces-attestor link challenge.txt`).',
    ].join('\n'),
  );
  return { address: key.address, checksumAddress: key.checksumAddress, keystore: path };
}

// ---------------------------------------------------------------- commands

function refuseExisting(io: CliIo, opts: Options): void {
  const path = keystorePath(opts, io.env);
  if (existsSync(path)) throw new CliError('exists', `${path} already exists; this tool never overwrites a keystore (pass --keystore for another file)`);
}

async function keygen(io: CliIo, opts: Options): Promise<number> {
  refuseExisting(io, opts);
  const key = AttestorKey.generate();
  try {
    emit(io, opts, await writeNewKeystore(io, opts, key));
  } finally {
    key.wipe();
  }
  return 0;
}

async function importKey(io: CliIo, opts: Options, file: string | undefined): Promise<number> {
  if (!file) throw new CliError('usage', 'import needs a file: a v3 keystore or a file holding a 0x-hex private key');
  refuseExisting(io, opts);
  const path = resolve(file);
  const text = readSmall(path, 64 * 1024, 'file to import');
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  let key: AttestorKey;
  if (keystoreKdf(parsed) !== null) {
    const password = await existingPassword(io, 'Password of the keystore being imported: ', opts.sourcePasswordEnv);
    key = await decryptKeystore(parsed, password, { allowWeakKdf: true, env: io.env });
  } else if (/^(0x)?[0-9a-fA-F]{64}$/.test(text.trim())) {
    const bytes = Uint8Array.from(Buffer.from(text.trim().replace(/^0x/, ''), 'hex'));
    try {
      key = AttestorKey.fromPrivateKey(bytes);
    } finally {
      bytes.fill(0);
    }
  } else {
    throw new CliError('unrecognised', `${path} is neither a Web3 Secret Storage v3 keystore nor a 0x-hex private key`);
  }
  try {
    if (!opts.allowLocal && isPublishedTestKey(key.address)) throw new CliError('declined', 'published test keys can be imported only for the simulator (--allow-local)');
    emit(io, opts, await writeNewKeystore(io, opts, key));
  } finally {
    key.wipe();
  }
  if (parsed === null) io.err(`The private key is still in plain text in ${path}: delete that file securely now.`);
  return 0;
}

async function address(io: CliIo, opts: Options): Promise<number> {
  const key = await loadKey(io, opts);
  try {
    emit(io, opts, { address: key.address, checksumAddress: key.checksumAddress });
  } finally {
    key.wipe();
  }
  return 0;
}

async function link(io: CliIo, opts: Options, file: string | undefined): Promise<number> {
  if (!file) throw new CliError('usage', 'link needs the challenge text file (the "message" of POST /me/signer-keys/challenge)');
  const text = readSmall(resolve(file), 4096, 'challenge');
  const key = await loadKey(io, opts);
  try {
    io.err(describeLinkChallenge(checkLinkChallenge(text, key.address)).join('\n'));
    if (!opts.yes && !(await io.confirm('Sign this key-link proof? [y/N] '))) throw new CliError('declined', 'nothing signed (confirm on a terminal, or pass --yes)');
    emit(io, opts, linkProof(text, key));
  } finally {
    key.wipe();
  }
  return 0;
}

async function sign(io: CliIo, opts: Options, file: string | undefined): Promise<number> {
  if (!file) throw new CliError('usage', 'sign needs the signing request file (one request, or a list of them)');
  const parsed = readJson(resolve(file), 1024 * 1024, 'signing request');
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0 || list.length > MAX_REQUESTS) throw new CliError('usage', `a request file holds 1 to ${MAX_REQUESTS} requests`);
  const npath = networksPath(opts, io.env);
  if (!existsSync(npath)) throw new CliError('io', `no pinned network table at ${npath} (RUNBOOK "Attestor key setup"; or pass --networks)`);
  if (opts.allowLocal) io.err('Local chain ids accepted (--allow-local): development against the simulator only.');
  const networks = pinNetworks(readJson(npath, 64 * 1024, 'pinned network table'), { allowLocal: opts.allowLocal });
  const checkedList: CheckedSigningRequest[] = list.map((r) => checkRequest(r, networks, { allowLocal: opts.allowLocal }));
  checkedList.forEach((c, i) => io.err([`--- ${i + 1} of ${checkedList.length}`, ...describeSigningRequest(c)].join('\n')));
  if (!opts.yes && !(await io.confirm(`Sign ${checkedList.length === 1 ? 'this message' : `these ${checkedList.length} messages`}? [y/N] `))) throw new CliError('declined', 'nothing signed (confirm on a terminal, or pass --yes)');
  const key = await loadKey(io, opts);
  let results;
  try {
    if (!opts.allowLocal && isPublishedTestKey(key.address)) throw new CliError('declined', 'published test keys are refused for live chains');
    results = checkedList.map((c) => ({ kind: c.kind, chain: c.chain, seriesId: c.seriesId, ...signChecked(c, key) }));
  } finally {
    key.wipe();
  }
  emit(io, opts, Array.isArray(parsed) ? results : results[0]);
  return 0;
}

/**
 * Runs one command and returns the exit code: 0 done, 1 refused or failed, 2 a usage error. Errors are printed as
 * `merces-attestor: <code>: <message>`; an unexpected error prints its name only, never its message (which could quote
 * an input).
 */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { command, positional, opts } = parseArgs(argv);
    if (opts.help || command === 'help') {
      io.out(USAGE);
      return 0;
    }
    if (command === undefined) {
      io.err(USAGE);
      return 2;
    }
    scryptNFor(io.env);
    switch (command) {
      case 'keygen': return await keygen(io, opts);
      case 'import': return await importKey(io, opts, positional[0]);
      case 'address': return await address(io, opts);
      case 'link': return await link(io, opts, positional[0]);
      case 'sign': return await sign(io, opts, positional[0]);
      default: throw new CliError('usage', `unknown command ${command} (merces-attestor --help)`);
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`merces-attestor: ${e.code}: ${e.message}`);
      return e.code === 'usage' ? 2 : 1;
    }
    if (e instanceof KeystoreError || e instanceof SigningError || e instanceof AttestorToolError) {
      io.err(`merces-attestor: ${e.code}: ${e.message}`);
      return 1;
    }
    io.err(`merces-attestor: unexpected error (${e instanceof Error ? e.name : typeof e})`);
    return 1;
  }
}

function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  main(process.argv.slice(2), nodeIo()).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
