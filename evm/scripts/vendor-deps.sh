#!/usr/bin/env bash
# Copies the pinned Solidity dependencies from node_modules (installed by pnpm from package.json) into evm/lib as
# real directories. Foundry's path-context remappings need real paths, and vendoring keeps builds reproducible
# without network access. Re-run after bumping a version in package.json; commit the result.
set -euo pipefail
cd "$(dirname "$0")/.."
vendor() { # name  node_modules_path
  local name="$1" src="$2"
  local real; real="$(readlink -f "$src")"
  rm -rf "lib/$name"; mkdir -p "lib/$name"
  # copy everything except nested node_modules, tests, build artifacts and scripts
  (cd "$real" && tar --exclude=./node_modules --exclude=./test --exclude=./tests --exclude=./artifacts --exclude=./scripts --exclude=./docs --exclude=./build -cf - .) | (cd "lib/$name" && tar -xf -)
  local pkg ver; pkg="$(node -p "require('$real/package.json').name")"; ver="$(node -p "require('$real/package.json').version")"
  printf 'vendored from npm %s@%s on %s (tests, docs and build artifacts omitted)\n' "$pkg" "$ver" "$(date -u +%F)" > "lib/$name/VENDORED.txt"
  echo "lib/$name <- $pkg@$ver"
}
vendor openzeppelin-contracts node_modules/@openzeppelin/contracts
vendor openzeppelin-contracts-upgradeable node_modules/@openzeppelin/contracts-upgradeable
vendor oz4 node_modules/oz4
vendor oz4-upgradeable node_modules/oz4-upgradeable
vendor t-rex node_modules/@tokenysolutions/t-rex
vendor onchain-id node_modules/@onchain-id/solidity
# T-REX and ONCHAINID pin solc 0.8.17 and OpenZeppelin 4.x. Point their imports at the vendored OZ 4.9.6 copies
# explicitly (the only edit made to these GPL-3.0 sources; recorded in each VENDORED.txt).
for d in lib/t-rex lib/onchain-id; do
  find "$d" -name '*.sol' -print0 | xargs -0 sed -i 's#@openzeppelin/contracts-upgradeable/#@oz4-upgradeable/#g; s#@openzeppelin/contracts/#@oz4/#g'
  echo 'import paths rewritten: @openzeppelin/contracts(-upgradeable)/ -> @oz4(-upgradeable)/ (OpenZeppelin 4.9.6 vendored in lib/oz4*)' >> "$d/VENDORED.txt"
done
