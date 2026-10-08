# RUNBOOK.md

Operating Merces Stage 2: processes, keys, keepers, incidents. Devnet, testnet and the simulator only.

## Processes

| Process | Command | Needs |
| --- | --- | --- |
| API gateway | `pnpm dev:api` | Postgres (`DATABASE_URL`), chain modes, session secret, vault key |
| Indexer | `pnpm dev:indexer` | Postgres, chains |
| Keepers | `pnpm dev:keepers` | Postgres, chains, keeper key (KMS), Pyth/Chainlink config |
| Report verifier | `pnpm dev:verifier` | KMS key only (no database) |
| Everything on the simulator | `pnpm dev:mock` | Postgres (`docker compose up`) |

Migrations run at process start (`migrate()`); `pnpm db:migrate` and `pnpm db:reset` exist for manual use.

### Chain modes

`MERCES_CHAIN_SOLANA_MODE` and `MERCES_CHAIN_EVM_MODE` are `mock | live | auto` (default `auto`). `auto` goes live only
when `STAGE1_PATH` points at a valid manifest entry for that chain and its health check passes; the chosen mode and
reason are logged at startup and shown at `GET /health`. `live` fails loudly when the adapter is unavailable.

## Keys

- Development: `MERCES_KMS_PROVIDER=local` derives deterministic keys from `MERCES_LOCAL_KEY_SEED`. The report verifier's
  key id is `REPORT_VERIFIER_KEY_ID` (default `report-verifier-1`); its public key must be registered onchain by the
  multisig (`POST /admin/verifier-keys` builds the transaction). `dev:mock` registers it on the simulators automatically.
- Production: a cloud KMS behind `KmsPort` (Part J.2). Rotation = register the new verifier key (keep the old one active
  until in-flight reports land), switch `REPORT_VERIFIER_KEY_ID`, then deactivate the old key.
- Vault key: `MERCES_VAULT_KEY_HEX` (32 bytes). Rotation re-encrypts `terms_vault`, `applications.notes_encrypted` and
  `contract_sessions.signed_document_encrypted`; the key id is stored beside each ciphertext.
- Keeper fee payer: fund it with devnet SOL / testnet MON only; it never holds stablecoins.

## Keepers

All jobs are idempotent and safe to run twice or late; each run is recorded in `keeper_runs` (`GET /admin/keepers/runs`).

| Job | Interval | What it does | If it stops |
| --- | --- | --- | --- |
| auction.settle | 1 min | settles raises whose reveal phase ended | settlement delays; anyone can call `settleAuction` |
| auction.reveal-reminders | 10 min | reminds unrevealed bidders in the last 12 h | bidders may miss reveals |
| status.crank | 1 h | InGrace/Late transitions, FormalNoticeDue | statuses lag; the chain's view is authoritative |
| pause.crank | 1 h | ends approved pauses | paused series stay paused until run |
| burn.crank | 1 h | burns units of Retired/Extinguished series | holders can still claim; burn is cosmetic |
| reporting.reminders | 1 h | due-soon / due / grace-end reminders | issuers get no reminders |
| rate.snapshot | 30 min | one Pyth snapshot per UTC day per pair per chain, Chainlink cross-check | coverage drops → quarters flagged for attestor rates |
| fx.coverage | 6 h | flags quarters with < 80% coverage, opens attestor requests | reports for non-USD series block |
| transfer.windows | 1 h | opens/clears quarterly windows (flag `transfer_windows`) | no windows |
| outbox.dispatch | 15 s | delivers notifications | inbox/email lag |

Run a job once by hand: `tsx -e "…"` is not needed — in mock mode `dev:mock` runs the scheduler in-process; set
`MERCES_KEEPERS=false` to disable it.

## Incidents

**Indexer behind or stuck.** `GET /health` shows the cursor and last seq per chain. The indexer resumes from
`indexer_cursors`; a gap in `seq` stops the batch and logs a warning until the port serves the missing events. To
rebuild the read model: `pnpm db:reset` then restart (the simulator's state is separate, in `sim_state`/`sim_events`).

**Rate snapshots missing.** `rate_pairs.last_error` names the cause (`no Pyth feed … failing closed`, `stale price`
outside FX market hours, `deviation N bps`). Resolve the feed id or wait for market open; a quarter below 80% coverage is
flagged and an attestor signs a rate (`/attestor/fx-requests`).

**Verifier down.** Devices cannot obtain attestations; tier-2 reports pause but nothing is penalised until deadlines,
and deadlines are published. Restart the verifier; its key is deterministic (dev) or in the KMS (prod).

**A series is Late because of our outage.** Lateness is the chain's rule, not ours; the issuer's remedy is a hardship
pause approved by an attestor (C8.5). Do not ask for an admin override: none exists by design.

**Suspected income leak.** Run `pnpm test:canary`. Check `audit_log` for `contract.read` and `terms_access_log` for
disclosure reads. The logger redacts income-bearing keys; a leak would have to bypass the logger.

**Mainnet configured by mistake.** Adapters refuse mainnet at construction; the process does not start.

## Backups and retention

Postgres holds commitments, amounts, statuses, ciphertext and audit logs — no raw income. Retention periods are an open
question (Part J.9); until set, nothing is deleted automatically. Simulator state (`sim_*`) is development data.
