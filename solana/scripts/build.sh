#!/usr/bin/env bash
# Builds every Merces program with Anchor. Platform-tools v1.52 is what the pinned Agave 3.1.10 release ships with;
# the SBPF v0 architecture is used so the binaries deploy on every cluster without feature-gate dependence.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
TOOLS_VERSION="${MERCES_PLATFORM_TOOLS:-v1.52}"
anchor build --tools-version "$TOOLS_VERSION" --arch v0 "$@"
