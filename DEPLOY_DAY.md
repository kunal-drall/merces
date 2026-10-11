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
| Keeper fee payers | fresh operator local keys, behind WalletSigner | fund with devnet SOL / testnet MON; they send permissionless commands only |
| Session secret, vault key | the API | `MERCES_SESSION_SECRET`, `MERCES_VAULT_KEY_HEX` (≥32 chars once any chain is live) |
| Conformance wallets | the operator | `CONFORMANCE_ISSUER_KEY`, `CONFORMANCE_BACKER_KEYS`, `CONFORMANCE_ATTESTOR_KEYS`, `CONFORMANCE_ADMIN_KEY`, `CONFORMANCE_VERIFIER_KEY`; use distinct fresh keys, funded/allowlisted on a dedicated deployment |

### 6.3 Bring-up, in order, and what can block each step

| # | Step | Command / config | Can be blocked by |
| --- | --- | --- | --- |
| 1 | Postgres | managed Postgres 16; `DATABASE_URL` | — |
| 2 | Migrations | run at process start, or `pnpm db:migrate` | a migration against unexpected rows (all are idempotent and ordered) |
| 3 | Pin Stage 1 at the deployed commit, run the sync | `git -C stage1 checkout <deployed>`; `pnpm install`; `pnpm stage1:sync --no-conformance` | missing manifest fields (HANDOFF §5.4); interface drift between the deployed programs and our adapters |
| 4 | Configure chains | `MERCES_CHAIN_SOLANA_MODE=live`, `SOLANA_RPC_URL`, cluster devnet; `MERCES_CHAIN_EVM_MODE=live`, `EVM_RPC_URL`, `EVM_CHAIN_KEY`, `EVM_CHAIN_ID=10143`; `STAGE1_PATH` | manifest/IDL or module-link mismatch; RPC rate limits; genesis/chain id mismatch (refused by design) |
| 5 | Start the API | `pnpm dev:api` (or the Docker image); check `GET /health` shows `live` for both chains and the reason | secrets missing or too short (the process names the variable) |
| 6 | Start the indexer | `pnpm dev:indexer` from the manifest's start slot/block | no start slot/block in the manifest |
| 7 | Start the verifier | `pnpm dev:verifier` with `MERCES_VERIFIER_CHAINS` (each chain's domain as `GET /chains` shows it), `REPORT_VERIFIER_ADDRESS`, a real seed | **the only zkTLS provider is the mock** (Part J.3 open), and startup now refuses it on live chains; a real zkTLS provider is required before live reporting |
| 8 | Register keys | verifier key and attestor keys through the admin routes and the multisig | the multisig setup; attestor identity provider (only the mock exists, Part J.1) |
| 9 | Start the keepers | `pnpm dev:keepers` with funded fee payers | unfunded fee payers; Pyth/Chainlink configuration for the FX keeper |
| 10 | Conformance | `CONFORMANCE_CHAIN=solana pnpm vitest run --project conformance`; `CONFORMANCE_CHAIN=evm:<chain>` | funded conformance wallets; any adapter gap |
| 11 | Demo cycle live | raise → treasury → reports → payouts on both networks (operator wallet transactions using the same API builders) | quarters take real time even with short auction terms; `pnpm demo:cycle` is simulator-only |
| 12 | Frontend switch | point the frontend from the `dev:mock` URL to the deployed API; `/dev/*` routes are absent outside mock mode | — |

Third-party providers still on mocks (owner decisions pending, `BUILD_PROMPT.md` Part J): identity (J.1), e-sign,
zkTLS (J.3), DEX, email. Each is a port in `packages/ports` with a mock; a real provider is an adapter plus
its facts pinned in `VERSIONS.md`.

### 6.4 Before mainnet (out of scope now; recorded)

The owner's three: a cancellable delay on extinguishment, an immediate revoke for a compromised key, an alert on every
attestor signature (HANDOFF §4.3). Stage 1's: replace the development trusted setup of the circuit with a real ceremony;
external audits. Ours: real identity, zkTLS and e-sign providers; the AWS KMS adapter for the verifier key.

### Live adapter configuration and wallet flow

- Keep keys outside git. Configure the matching public pins and secrets from `.env.example`:
  `SOLANA_KEEPER_PUBLIC_KEY` / `SOLANA_KEEPER_SEED_HEX`, `SOLANA_ALLOWLIST_PUBLIC_KEY` /
  `SOLANA_ALLOWLIST_SEED_HEX`, `EVM_KEEPER_ADDRESS` / `EVM_KEEPER_PRIVATE_KEY`,
  `EVM_ALLOWLIST_ADDRESS` / `EVM_ALLOWLIST_PRIVATE_KEY`. Seeds/keys are exactly 32 bytes in hex; EVM includes `0x`.
  These keys pay fees and send their allowed service commands only. Issuer/attestor/admin keys never enter the API.
- Set both chain modes explicitly to `live`. A missing/incomplete manifest fails startup. Use an archive RPC from
  `startSlot` / `startBlock`; EVM transactions through contract wallets need `debug_traceTransaction` call tracing.
  The indexer reconstructs canonical sequence numbers from that start, so changing it requires a fresh indexer database.
- `UnsignedTx.preparations` and `approvals` are separate wallet transactions. Sign and confirm the first required
  step, rebuild, and repeat; then sign the rebuilt main transaction. Allowances are exact, never unlimited. Solana
  payloads are base64 legacy messages with one signature; oversized bundles are refused. EVM signatures carry the
  complete serialized signed transaction. Do not edit the supplied payload after signing.
- If create returns `afterCreate`, wait for confirmed `SeriesCreated`, then call
  `POST /drafts/{draftId}/build-contract-hash` with its `seriesId`. Confirm that transaction before `openRaise`.
  Solana creates and binds in one atomic transaction.
- Set `SOLANA_FX_CURRENCIES` / `EVM_FX_CURRENCIES` as `{pairId: "EUR"}` JSON maps for non-USD pairs. On Solana,
  `SOLANA_PYTH_PRICE_ACCOUNTS` maps primary and cross-check feed ids to maintained `PriceUpdateV2` accounts.
  The operator's Pyth price pusher must keep those accounts fresh; Stage 1 verifies owner/feed/freshness onchain.
- Set `MERCES_PRICE_FEED_PROVIDER=pyth`, `PYTH_HERMES_URL=https://pyth.dourolabs.app/hermes` and `PYTH_API_KEY`.
  The key is sent in an Authorization header; provider binary updates normalize to hex before EVM submission.
  See [Pyth fetch guide](https://docs.pyth.network/price-feeds/core/fetch-price-updates) and
  [Solana push feeds](https://docs.pyth.network/price-feeds/core/push-feeds/solana).
- Curve pool creation happens on the issuer's device using `@merces/meteora`'s config generator and the pinned
  Meteora SDK `partner.createConfig` / `creator.createPool`. Keep private income input on that device. Set
  `feeClaimer` and `leftoverReceiver` to the protocol `curve_authority` PDA for the exact series, the quote mint to
  that series' stablecoin, swap base amount to offered units × 1,000,000 and migration threshold to minimum raise.
  With issuer as pool creator, creator migration fees and unlocked/vesting creator liquidity must be zero
  (`merces_protocol/src/curve.rs` activation guards); locked issuer token vesting follows Stage 1's config.
  Stage 1's generic graduation CLI uses a test Merces wallet, so its default configuration is not a protocol pool.
  Put the resulting public pool address in `SOLANA_CURVE_POOLS={"solana:<series>":"<pool>"}` before activation.
  The API validates public pool state and treasury authorities; it never runs the private-income generator.
- Curve purchases accept USDC directly. Live USDG-to-USDC requires a real DEX adapter; mock quotes are refused.
  USDG transfer hooks with amount-dependent account seeds or an extra required signer are also refused explicitly.

### Conformance and the calendar

Use a dedicated deployment with the operator's admin, fresh funded/allowlisted issuer plus five backers, two
registered attestors and a registered verifier. Wallet keys are 32-byte hex (Solana Ed25519 seed, EVM secp256k1);
attestor/verifier keys are `0x` secp256k1 hex; plural variables are JSON arrays. Set all `CONFORMANCE_*` variables in
`.env.example`, load them in the operator shell, and run the commands in step 10. `CONFORMANCE_CURVE_POOL` must be
created for the next curve test series (100 offered units, 1,000 USDC minimum). The synthetic report builder uses a
real randomized Groth16 proof and registered operator signature; it is not a production zkTLS verifier.

The full suite spans several quarters. The default `CONFORMANCE_MAX_WAIT_SECONDS=60` fails with an explicit clock
requirement rather than pretending public time can advance. For EVM, run a loopback fork preserving the allowed
**testnet** chain id and set `CONFORMANCE_EVM_TIME_TRAVEL=true` for its local `evm_setNextBlockTimestamp` / `evm_mine`.
That flag refuses any public endpoint. Solana's offline Stage 1/LiteSVM and vector gates provide accelerated lifecycle
coverage; public lifecycle observation must be scheduled across real quarters. `pnpm demo:cycle` continues to prove
the complete simulator story and prints `DEMO OK`; do not label it a live-chain demo.

### Launch prerequisites still outside this backend checkout

A deployed Stage 1 manifest and funded keys; actual identity/e-sign/provider accounts; authenticated custom YTD zkTLS
proof definitions and their verifier; browser prover packaging and persistent device-local income openings in the
frontend; live DEX routing if USDG curve purchases are required. These are functional launch dependencies, not UI
polish. The backend's live-mode checks keep mock zkTLS out. No public deployment was attempted during this change.
