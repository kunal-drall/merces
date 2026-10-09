# Merces EVM deployment

All scripts deploy the same stack through `script/lib/MercesDeploy.sol` (also used by every test fixture, so
tests and deployments exercise identical wiring), verify the wiring on chain, and record every address in
`deployments/<network>.json`.

| Script | Network | What it does |
| --- | --- | --- |
| `DeployLocal.s.sol` | anvil (any chain id) | mock USDC + mock Pyth, broadcaster = admin = allowlist manager = timelock proposer, 60 s timelock, windows enabled, two attestors and one verifier key derived from fixed strings (or `MERCES_ATTESTORS` / `MERCES_VERIFIER_KEYS`), broadcaster registered + allowlisted as issuer with 1,000,000 test USDC → `deployments/anvil.json` |
| `DeployMonadTestnet.s.sol` | Monad testnet, chain id **10143** | Pyth `0x2880aB155794e7179c9eE2e38200202908C17B43` (VERSIONS.md); stablecoin `MERCES_STABLECOIN` or a freshly deployed test USDC → `deployments/monad-testnet.json` |
| `Deploy.s.sol` | any EVM chain | everything from the environment (below) → `deployments/$MERCES_NETWORK.json` |

What gets deployed (in order): `TimelockController` (proposer = executor = `MERCES_TIMELOCK_PROPOSER`),
`FeeCollector` (owned by the timelock), the T-REX 4.1.6 implementations + `TREXImplementationAuthority`
(version 4.1.6) + shared `ClaimTopicsRegistry` / `TrustedIssuersRegistry` / `IdentityRegistryStorage` /
`IdentityRegistry` proxies, ONCHAINID `Identity` (library) + `ImplementationAuthority` + `IdFactory`, the
Poseidon(2)/(5) hashers, `Groth16Verifier`, the seven money implementations and their UUPS proxies
(owned by the timelock), `MercesTokenGovernor`, `MercesComplianceModule`, `MercesTokenFactory`, and finally
`MercesRegistry` (its address is predicted from the deployer nonce and checked). Wiring: the registry is the
identity registry's only agent and owns the `IdFactory`; the auction and window get identities; the identity
stack goes to the governor; both implementation authorities go to the timelock.

## Environment

| Variable | Default | Used by |
| --- | --- | --- |
| `MERCES_ADMIN` | broadcaster | all but local |
| `MERCES_ALLOWLIST_MANAGER` | admin | all but local |
| `MERCES_TIMELOCK_PROPOSER` | admin | all but local |
| `MERCES_TIMELOCK_DELAY` | 2 days (`Deploy`), 1 day (Monad testnet), 60 s (local) | all |
| `MERCES_STABLECOIN` | required (`Deploy`); test USDC deployed if unset (Monad testnet) | |
| `MERCES_PYTH` | required | `Deploy` |
| `MERCES_ATTESTORS`, `MERCES_VERIFIER_KEYS` | none (local: derived test keys) | comma-separated addresses |
| `MERCES_WINDOWS_ENABLED` | false (local: true) | windows ship closed (SPEC §1.6) |
| `MERCES_NETWORK` | `anvil` / `monad-testnet`; required for `Deploy` | record name |

When the admin is the broadcaster (devnet / testnet keypair, SPEC §2) the script also allows the stablecoin,
registers the attestors and verifier keys and sets the flags. With a multisig admin these are separate admin
transactions: `setStablecoin(usdc, true)`, `registerAttestor(a)`, `registerVerifierKey(k)`,
`registerIssuer(w)`, `setFlags(…)` on the registry, and `setAllowed(w, true)` from the allowlist manager.

## Commands

Build with the default (via-IR) profile — the `dev` profile is for fast tests only and its legacy-codegen
`MercesIncome` / `MercesVault` exceed EIP-170.

```bash
cd evm
forge build

# local rehearsal
anvil &
forge script script/DeployLocal.s.sol --rpc-url anvil --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil account 0

# Monad testnet
export MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz
forge script script/DeployMonadTestnet.s.sol --rpc-url monad_testnet --broadcast \
  --private-key "$DEPLOYER_KEY" --slow
```

The scripts call `vm.getCode` for the 0.8.17 T-REX / ONCHAINID / Merces-module artifacts, so they must run
from `evm/` after `forge build`. The deploy is ~45 transactions; `--slow` sends them one at a time.

Monad notes (from Monad's documentation as recalled; the site was unreachable from the build container, verify
before mainnet): Monad charges for the **gas limit** of a transaction rather than the gas used, so keep forge's
gas-estimate multiplier low (e.g. `--gas-estimate-multiplier 110`); the contract size limit is larger than
EIP-170, but every Merces contract already fits under 24,576 bytes; there is no Monad-specific code.

## Rehearsal record

`DeployLocal.s.sol` was rehearsed on anvil (chain id 31337) and `DeployMonadTestnet.s.sol` on an anvil node
started with `--chain-id 10143` whose Pyth address carried the `MockPyth` code (`anvil_setCode`), since the
Monad RPC is not reachable from the build container. Both records are in `deployments/` (`anvil.json`,
`monad-testnet-rehearsal.json`); `deployments/monad-testnet.json` is written by the real testnet run.
