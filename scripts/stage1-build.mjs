#!/usr/bin/env node
// Builds the Stage 1 packages this repository imports (@merces/sdk, @merces/circuits, @merces/reference) from the
// pinned `stage1` submodule. They ship TypeScript sources with `exports` pointing at `dist`, so they are compiled
// once after install. Runs as the root `postinstall`.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

if (!existsSync('stage1/packages/reference/package.json')) {
  console.error('stage1: the Stage 1 submodule is not checked out. Run `git submodule update --init` and install again.');
  process.exit(1);
}
execFileSync('pnpm', ['-r', '--filter', '@merces/reference...', 'run', 'build'], { stdio: 'inherit' });
