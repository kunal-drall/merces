# Deployment day
Do this only when HANDOFF §4 and HANDOFF §5 are done (owner's order). Mainnet is out of scope and refused in code.

### 6.1 Deploy Stage 1 (from a machine with network access)

- **Solana devnet:** `stage1/solana/scripts/deploy.sh devnet` (builds with the pinned toolchain, deploys the three
  programs, makes the registry immutable) then `node --import tsx stage1/solana/scripts/deploy-init.ts --cluster devnet
  --url <rpc> --keypair <path>` (initialises the protocol with domain chain id 103, mock stablecoins as needed); smoke
  test `stage1/solana/scripts/smoke.ts`.
- **Monad testnet (chain 10143):** `cd stage1/evm && forge build` (default via-IR profile) then the
  `DeployMonadTestnet.s.sol` script per `stage1/evm/script/README.md` (environment: `MERCES_ADMIN`,
  `MERCES_ALLOWLIST_MANAGER`, `MERCES_TIMELOCK_PROPOSER`, `MERCES_STABLECOIN` or a fresh test USDC, `MERCES_ATTESTORS`,
  `MERCES_VERIFIER_KEYS`, `MERCES_WINDOWS_ENABLED=false`); addresses land in `stage1/evm/deployments/monad-testnet.json`.
- Run Stage 1's parity vectors against both deployments and fill the devnet/testnet columns of `stage1/PARITY_REPORT.md`.
- Produce `handoff/manifest.json` in Stage 1 (program ids, contract addresses, RPC URLs, stablecoins, start slot/block)
  in the shape `packages/chains/src/manifest.ts` parses; commit it in Stage 1; bump our submodule to that commit.

### 6.2 Keys

| Key | Holder | Notes |
| --- | --- | --- |
| Admin / multisig | the operator (Squads on Solana, the timelock proposer on the EVM) | signs admin transactions the API builds (`/admin/*` returns `tx-requests`; `POST /admin/tx-requests/{id}/sent` records them) |
| Report verifier key | the verifier service, behind the KMS port | owner: **keep the local dev signer until staging; AWS KMS later unless the owner says otherwise**. With a live chain the local signer needs a real ≥32-char `MERCES_LOCAL_KEY_SEED` (the published dev seed is refused) and `REPORT_VERIFIER_ADDRESS` pinned; register the address onchain as a verifier key (`POST /admin/verifier-keys` → multisig) |
| Attestor keys | each attestor, in `merces-attestor` on their own machine | link with `POST /me/signer-keys/challenge` + `merces-attestor link`; pass the attestor identity check (`POST /me/attestor/identity-check`); admin proposes (`POST /admin/attestors`) → multisig registers; two distinct verified accounts needed for extinguishment |
| Keeper fee payers | the keepers, behind the KMS port | fund with devnet SOL / testnet MON; they send permissionless commands only |
| Session secret, vault key | the API | `MERCES_SESSION_SECRET`, `MERCES_VAULT_KEY_HEX` (≥32 chars once any chain is live) |
| Conformance wallets | the operator | `CONFORMANCE_ISSUER_KEY`, `CONFORMANCE_BACKER_KEYS`, `CONFORMANCE_ATTESTOR_KEYS`, `CONFORMANCE_ADMIN_KEY`, funded on both networks |

### 6.3 Bring-up, in order, and what can block each step

| # | Step | Command / config | Can be blocked by |
| --- | --- | --- | --- |
| 1 | Postgres | managed Postgres 16; `DATABASE_URL` | — |
| 2 | Migrations | run at process start, or `pnpm db:migrate` | a migration against unexpected rows (all are idempotent and ordered) |
| 3 | Pin Stage 1 at the deployed commit, run the sync | `git -C stage1 checkout <deployed>`; `pnpm install`; `pnpm stage1:sync` | missing manifest fields (HANDOFF §5.4); interface drift between the deployed programs and our adapters |
| 4 | Configure chains | `MERCES_CHAIN_SOLANA_MODE=live`, `SOLANA_RPC_URL`, cluster devnet; `MERCES_CHAIN_EVM_MODE=live`, `EVM_RPC_URL`, `EVM_CHAIN_KEY`, `EVM_CHAIN_ID=10143`; `STAGE1_PATH` | adapters not wired (HANDOFF §5); RPC rate limits; genesis/chain id mismatch (refused by design) |
| 5 | Start the API | `pnpm dev:api` (or the Docker image); check `GET /health` shows `live` for both chains and the reason | secrets missing or too short (the process names the variable) |
| 6 | Start the indexer | `pnpm dev:indexer` from the manifest's start slot/block | no start slot/block in the manifest |
| 7 | Start the verifier | `pnpm dev:verifier` with `MERCES_VERIFIER_CHAINS` (each chain's domain as `GET /chains` shows it), `REPORT_VERIFIER_ADDRESS`, a real seed | **the only zkTLS provider is the mock** (Part J.3 open), and startup now refuses it on live chains; a real zkTLS provider is required before live reporting |
| 8 | Register keys | verifier key and attestor keys through the admin routes and the multisig | the multisig setup; attestor identity provider (only the mock exists, Part J.1) |
| 9 | Start the keepers | `pnpm dev:keepers` with funded fee payers | unfunded fee payers; Pyth/Chainlink configuration for the FX keeper |
| 10 | Conformance | `CONFORMANCE_CHAIN=solana pnpm vitest run --project conformance`; `CONFORMANCE_CHAIN=evm:<chain>` | funded conformance wallets; any adapter gap |
| 11 | Demo cycle live | raise → treasury → reports → payouts on both networks (`packages/scenarios/src/demo-cycle.ts` against live chains) | quarters take real time: use short test terms; a real prover for reports |
| 12 | Frontend switch | point the frontend from the `dev:mock` URL to the deployed API; `/dev/*` routes are absent outside mock mode | — |

Third-party providers still on mocks (owner decisions pending, `BUILD_PROMPT.md` Part J): identity (J.1), e-sign,
zkTLS (J.3), price feeds, DEX, email. Each is a port in `packages/ports` with a mock; a real provider is an adapter plus
its facts pinned in `VERSIONS.md`.

### 6.4 Before mainnet (out of scope now; recorded)

The owner's three: a cancellable delay on extinguishment, an immediate revoke for a compromised key, an alert on every
attestor signature (HANDOFF §4.3). Stage 1's: replace the development trusted setup of the circuit with a real ceremony;
external audits. Ours: real identity, zkTLS and e-sign providers; the AWS KMS adapter for the verifier key.
