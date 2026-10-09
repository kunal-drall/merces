#!/usr/bin/env bash
# Deploys the Merces Solana programs to a cluster, initialises the protocol and records the
# deployment in solana/deployments/<cluster>.json.
#
#   solana/scripts/deploy.sh <localnet|devnet|testnet> [options]
#
# Options:
#   --url <rpc>                         RPC endpoint (default per cluster)
#   --keypair <path>                    deployer / fee payer (default ~/.config/solana/id.json)
#   --skip-build                        use the .so files already in solana/target/deploy
#   --admin <pubkey>                    protocol admin (default: deployer)
#   --allowlist-manager <pubkey>        allowlist manager (default: deployer)
#   --fee-collector <pubkey>            fee collector (default: deployer)
#   --protocol-upgrade-authority <pk>   hand the upgrade authority of merces_protocol and merces_hook
#                                       (money code + transfer rules: SPEC §0, §2) to this key, the
#                                       multisig + timelock (default: keep the deployer)
#
# Steps: (1) build, (2) deploy merces_registry, merces_hook, merces_protocol and mock_usdg_hook with
# the program keypairs in solana/keys (fixed program ids), (3) create the mock stablecoins and call
# init_protocol (deploy-init.ts), (4) revoke merces_registry's upgrade authority (charter data has
# no upgrade path, SPEC §0/§3.3), (5) optionally transfer the merces_protocol and merces_hook upgrade
# authorities to the multisig + timelock (the EVM compliance module is upgraded by the same timelock),
# (6) verify and write the deployment record. Refuses mainnet (brief ground rules).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

CLUSTER="${1:-}"
shift || true
case "$CLUSTER" in
  localnet) URL="http://127.0.0.1:8899" ;;
  devnet) URL="https://api.devnet.solana.com" ;;
  testnet) URL="https://api.testnet.solana.com" ;;
  *) echo "usage: $0 <localnet|devnet|testnet> [options] (mainnet is refused)" >&2; exit 2 ;;
esac
KEYPAIR="${HOME}/.config/solana/id.json"
SKIP_BUILD=0
ADMIN=""
ALLOWLIST_MANAGER=""
FEE_COLLECTOR=""
PROTOCOL_UPGRADE_AUTHORITY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --keypair) KEYPAIR="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --admin) ADMIN="$2"; shift 2 ;;
    --allowlist-manager) ALLOWLIST_MANAGER="$2"; shift 2 ;;
    --fee-collector) FEE_COLLECTOR="$2"; shift 2 ;;
    --protocol-upgrade-authority) PROTOCOL_UPGRADE_AUTHORITY="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
case "$URL" in
  *mainnet*) echo "refusing to deploy to mainnet ($URL)" >&2; exit 2 ;;
esac

SOL="solana --url $URL --keypair $KEYPAIR"
DEPLOYER="$(solana-keygen pubkey "$KEYPAIR")"
echo "cluster=$CLUSTER url=$URL deployer=$DEPLOYER"

if [ "$SKIP_BUILD" -eq 0 ]; then
  bash scripts/build.sh
fi

PROGRAMS=(merces_registry merces_hook merces_protocol mock_usdg_hook)
for p in "${PROGRAMS[@]}"; do
  id="$(solana-keygen pubkey "keys/$p-keypair.json")"
  echo "deploying $p ($id)"
  $SOL program deploy "target/deploy/$p.so" --program-id "keys/$p-keypair.json" --upgrade-authority "$KEYPAIR"
done

REGISTRY_ID="$(solana-keygen pubkey keys/merces_registry-keypair.json)"
PROTOCOL_ID="$(solana-keygen pubkey keys/merces_protocol-keypair.json)"
HOOK_ID="$(solana-keygen pubkey keys/merces_hook-keypair.json)"

# mock stablecoins, protocol configuration, deployment record
node --import tsx scripts/deploy-init.ts \
  --cluster "$CLUSTER" --url "$URL" --keypair "$KEYPAIR" \
  ${ADMIN:+--admin "$ADMIN"} ${ALLOWLIST_MANAGER:+--allowlist-manager "$ALLOWLIST_MANAGER"} \
  ${FEE_COLLECTOR:+--fee-collector "$FEE_COLLECTOR"}

# the registry is immutable: no upgrade path for charter data
echo "revoking the merces_registry upgrade authority"
$SOL program set-upgrade-authority "$REGISTRY_ID" --final
if [ -n "$PROTOCOL_UPGRADE_AUTHORITY" ]; then
  for id in "$PROTOCOL_ID" "$HOOK_ID"; do
    echo "transferring the upgrade authority of $id to $PROTOCOL_UPGRADE_AUTHORITY"
    $SOL program set-upgrade-authority "$id" --new-upgrade-authority "$PROTOCOL_UPGRADE_AUTHORITY" \
      --skip-new-upgrade-authority-signer-check
  done
fi

# verification against the chain, recorded in the deployment file
node --import tsx scripts/deploy-init.ts --cluster "$CLUSTER" --url "$URL" --keypair "$KEYPAIR" --verify
echo "deployment recorded in solana/deployments/$CLUSTER.json"
