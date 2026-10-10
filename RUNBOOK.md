# RUNBOOK.md

Operating Merces Stage 2: processes, keys, keepers, incidents. Devnet, testnet and the simulator only.

## Processes

| Process | Command | Needs |
| --- | --- | --- |
| API gateway | `pnpm dev:api` | Postgres (`DATABASE_URL`), chain modes, session secret, vault key; also indexes and cranks every simulated chain in-process |
| Indexer | `pnpm dev:indexer` | Postgres, live chains (simulated chains are skipped) |
| Keepers | `pnpm dev:keepers` | Postgres, live chains (simulated chains are skipped), keeper key (KMS), Pyth/Chainlink config; dispatches notifications |
| Report verifier | `pnpm dev:verifier` | KMS key only (no database) |
| Everything on the simulator | `pnpm dev:mock` | Postgres (`docker compose up`) |

Migrations run at process start (`migrate()`); `pnpm db:migrate` and `pnpm db:reset` exist for manual use.

**Secrets at startup.** `MERCES_SESSION_SECRET`, `MERCES_VAULT_KEY_HEX` and `MERCES_LOCAL_KEY_SEED` each need at least
32 characters once any chain is live. While every chain runs on the simulator their published development defaults are
accepted; with a live chain a missing, short or development value stops the process at boot with the variable's name.
The report verifier signs with the key the multisig registers onchain, so it refuses the development seed unless
`MERCES_VERIFIER_DEV=true` is set (docker-compose sets it for local development only).

**One owner per simulated chain.** A persisted simulator chain (`sim_state`/`sim_events` under `MERCES_SIM_KEY`,
default `sim`) is held by exactly one process through a Postgres advisory lock, and that process is the API (`dev:api`
or `dev:mock`). The API therefore indexes its simulated chains and runs their keepers in-process
(`MERCES_KEEPERS=false` turns the keepers off); `dev:indexer` and `dev:keepers` open live chains only and skip any
chain that resolves to the simulator, so the documented three-process layout works in every mode. If the lock's
connection drops, the API stops writing that chain (writes fail with "lost its single-writer lock") until restarted.

### Chain modes

`MERCES_CHAIN_SOLANA_MODE` and `MERCES_CHAIN_EVM_MODE` are `mock | live | auto` (default `auto`). `auto` goes live only
when `STAGE1_PATH` points at a valid manifest entry for that chain, its health check passes and the adapter is wired
to the generated Stage 1 clients (today neither is, so `auto` stays on the simulator with "not wired" as the reason);
the chosen mode and reason are logged at startup and shown at `GET /health`. `live` fails loudly when the adapter is
unavailable.

Mainnet is refused in every mode. Solana accepts only devnet, testnet or loopback localnet, and checks the RPC's
genesis hash against the configured cluster; EVM accepts only chain ids in the testnet allow-list
(`EVM_TESTNET_CHAIN_IDS` in `packages/chain-evm/src/config.ts`) and checks the RPC serves that id. A refused config or
RPC stops the process under `live`; under `auto` the chain falls back to the simulator and the refusal is the logged
reason. A new testnet is added to the allow-list in code, never through configuration.

### Report proofs (Stage 1 Groth16)

Reports carry Stage 1's ProofOfIncome proof (Groth16 over BN254, `stage1/circuits`). The issuer's device proves
(`@merces/poi-device`, fresh randomness); the API verifies before it builds `submitReport`, and every simulated chain
verifies again before its engine runs (`Groth16ReportVerifier` in `@merces/ports`, verdicts cached per process).
Devices fetch the circuit from `GET /prover/artifacts` and the files from `GET /prover/report.wasm` and
`GET /prover/report.zkey`, each checked against the Stage 1 build manifest's sha256. The proving key comes from Stage
1's **development** trusted setup: anyone can forge proofs with it, so never mainnet.

`MERCES_PROOF_SYSTEM` is `groth16` (default) or `mock`. `mock` also accepts mock proofs (a digest over the public
inputs, forgeable by anyone) in the simulators and the API, for fast local seeding (`dev:mock` then seeds with mock
proofs). It is honoured only when every chain resolves to the simulator, logs a warning at startup, and a process with
a live chain refuses to start with it set.

snarkjs keeps worker threads alive once it has verified or proved. The API, `dev:mock` and `dev:verifier` terminate
them on SIGINT/SIGTERM (`shutdownProofSystem()`), as do `stage1:sync` and `demo:cycle` before they exit; a new CLI that
proves or verifies must do the same, or it will not exit.

### Simulator state version 3: reset

From S2 the persisted simulator state is **version 3**: beside Stage 1's own series ledger, payout vault, tail and final
pool (version 2, S1), it carries the raise's own terms (the commit and reveal durations and the non-reveal charge) and
Stage 1's multi-step auction settlement. A persisted chain of another version is never upgraded in place:
`SimulatorChain.create` refuses it with `SimStateVersionError`, so the API and `dev:mock` stop at boot on a database
that still holds a version-1 or version-2 chain. Reset the simulated chains **before deploying the version-3 build**
(no environment holds simulator data worth keeping):

```
pnpm --filter @merces/simulator sim:reset --dry-run                      # what would go, nothing deleted
MERCES_ALLOW_SIM_RESET=1 pnpm --filter @merces/simulator sim:reset       # every simulator chain under MERCES_SIM_KEY
MERCES_ALLOW_SIM_RESET=1 pnpm --filter @merces/simulator sim:reset --chain solana --prefix sim
```

- It refuses without `MERCES_ALLOW_SIM_RESET=1` (except `--dry-run`). `DATABASE_URL` picks the database and
  `MERCES_SIM_KEY` (or `--prefix`) the key prefix, as for the API.
- Stop the API / `dev:mock` first: a chain whose single-writer lock is held is refused.
- Only chains with a persisted simulator state (`sim_state` key `<prefix>:<chain>`) are reset; a chain key without one
  (for example a live chain) is refused.
- In one transaction it deletes, for the reset chains only (row deletes, never `TRUNCATE`): `sim_state` and
  `sim_events`; the indexer projections and cursor of those chains (every chain-keyed read-model table, plus
  `attestor_proposals` and `fx_fallback_requests`); and every off-chain row keyed by a series of those chains (each
  table with a `series_id` column, such as `series_drafts`, `terms_vault`, `reports`, `tier3_cases`,
  `hardship_requests`, plus `reminders_sent`, `notifications`, `outbox` and `jobs` rows naming such a series). Series
  ids are deterministic, so a row left behind would re-attach to a new series with the same id. Projections are keyed
  by chain, not by prefix: they go whichever prefix fed them.
- It keeps people, paper and audit records not tied to a series (accounts, wallets, applications, eligibility,
  contract sessions, drafts that never created a series, `audit_log`).
- It prints the rows deleted per table. The chain's registrations lived in the simulator state and are gone: re-apply
  the allowlist (`setAllowlist`), the attestors (`registerAttestor`), the report-verifier key (`registerVerifierKey`)
  and the issuer registrations (`registerIssuer`). `dev:mock` does this itself: it registers the verifier key at boot
  and re-seeds its synthetic cohort on an empty chain.

### Checks before a deploy

The S1 gate, all from the repository root with Postgres up:

```
pnpm typecheck
DATABASE_URL=postgres://postgres@localhost:5432/merces pnpm vitest run          # unit + DB suites
MERCES_TEST_DB=1 pnpm vitest run --project canary                               # the privacy canary
CONFORMANCE_CHAIN=simulator pnpm vitest run --project conformance               # also simulator:monad
pnpm stage1:vectors --personality solana,monad                                  # 14 targets + 7 prefix gates on our simulator
pnpm stage1:vectors --backend reference                                         # all 25 on Stage 1's own simulator
pnpm stage1:vectors --backend lockstep --personality solana                     # both side by side, every step
pnpm stage1:sync --no-conformance                                               # pin, drift, math, vectors
```

`stage1:vectors` must exit 0 with `OK: 36/42 PASS, 42/42 at expected status` (the 14 targets in full and the 7 prefix
gates to their gate, on both personalities; 03 is PASS-WITH-DIVERGENCES on the five DIV-NRC-1 fields of the
non-reveal hold, and lockstep accepts 03 parting at #65 as recorded) and the reference backend with `OK: 25/25 PASS`; `stage1:sync` must report the math and vectors steps `OK` (the diff step stays
`WARN` until the adapters are wired, and conformance needs live deployments). The vector runner verifies every
embedded report proof with the ports' Groth16 verifier and never persists anything.

## Keys

- Development: `MERCES_KMS_PROVIDER=local` derives deterministic keys from `MERCES_LOCAL_KEY_SEED`. The report verifier's
  key id is `REPORT_VERIFIER_KEY_ID` (default `report-verifier-1`); its public key must be registered onchain by the
  multisig (`POST /admin/verifier-keys` builds the transaction). `dev:mock` registers it on the simulators automatically.
- Production: a cloud KMS behind `KmsPort` (Part J.2). Rotation = register the new verifier key (keep the old one active
  until in-flight reports land), switch `REPORT_VERIFIER_KEY_ID`, then deactivate the old key.
- Vault key: `MERCES_VAULT_KEY_HEX` (32 bytes). Rotation re-encrypts `terms_vault`, `applications.notes_encrypted` and
  `contract_sessions.signed_document_encrypted`; the key id is stored beside each ciphertext.
- Keeper fee payer: fund it with devnet SOL / testnet MON only; it never holds stablecoins. On Solana the settle and
  deliver jobs also pay the rent of the accounts a bidder needs (a winner's Holder PDA at `processBid`, the bidder's
  stablecoin and unit token accounts at `deliverBid` when missing; Stage 1 `raise.rs`), and the fee collector's token
  account must exist before the first `processBid` (a deployment step). Set a compute-unit limit on `processBid`: it
  can exceed Solana's 200k default (A-AUC-10; rent is not measured in the simulator).

## Keepers

All jobs are idempotent and safe to run twice or late; each run is recorded in `keeper_runs` (`GET /admin/keepers/runs`).
Chains and series are independent: one chain's outage or one series' error never stops the others. A chain refusal that
only means "nothing to do" (TooEarly, WrongStatus, Duplicate …) is ignored; any other error marks the run `ok = false`
with the chain or series and the message in `detail`, which is what to alert on. The auction jobs put a Stage 1 error
name or ChainError code in `detail` instead of the message (adapter messages can embed values; S2). Notices for chain
events (auction settled or failed, a settlement round rejected, the mint finalized, a bid delivered, status changes,
releases paused or resumed, pause ended, formal notice) are enqueued by the indexer in the transaction that projects the
finalized event, not by the keepers.

| Job | Interval | What it does | If it stops |
| --- | --- | --- | --- |
| auction.settle | 1 min | drives Stage 1's settlement of raises whose reveal phase ended: the proposal, the tally pages, finalize and a `processBid` per bid, which finalizes the mint (at most 64 steps per series per run; the next run goes on). A step someone else sent first is re-planned, not a failure. A raise with no bid waits 24 h past its reveal end so its issuer can still cancel (A-AUC-12). A series the planner will not act on fails the run as `<series>: stuck (<reason>)` and is told to the admins once per round and reason (`auction.settlement-stuck`) | settlement waits: winners' units accrue only from processing, and the money paths stay closed until the mint is final (MintNotFinalized). Anyone can send the next step: `beginSettlement`, `tallyBids`, `finalizeSettlement` and `processBid` are permissionless commands any wallet can build and sign (`POST /series/{id}/auction/build-step {signer}` builds the next one with the keepers' planner; a 409 says why there is none) |
| auction.deliver | 1 min | pushes every processed, undelivered bid with `deliverBid` (Stage 1 `deliver_bid`: the refund and the units won), reading the bids from the chain; at most 64 attempts per series per run. A refused delivery fails the run as `<series> <bidder>: <code> (attempt n)` and is retried on its own backoff (1 min, 5 min, 30 min, 2 h, 12 h, then daily; `auction_deliveries` keeps the attempts, the next attempt and the code); runs in between report `n waiting` and are not failures. A bid still failing 24 h after its raise was finalized is told once to the admins and the bidder (`bid.delivery-stuck`); a bid someone else delivered first is not a failure | refunds and units wait; a processed winner's units still accrue. Any wallet can deliver a bid (`deliverBid` is permissionless): the bidder builds its own with `POST /series/{id}/bids/build-deliver` (any account can build one for any bid, signed by one of its own wallets) |
| auction.reveal-reminders | 10 min | reminds unrevealed bidders in the last 12 h | bidders may miss reveals |
| status.crank | 1 h | `crankStatus` once the earliest unpaid period passes a status instant the chain has not recorded: InGrace after `dueAt`, Late after `graceEndsAt`, the formal notice at `formalNoticeAt` (period end + 30 / 45 / 90 days of unpaused time, Stage 1's inclusive bounds) | the stored and indexed status lags the derived one until any sync point; reads and money paths use the derived status, which is authoritative |
| pause.crank | 1 h | announces hardship pauses whose approved end passed (`PauseEnded`) | events only: a pause ends by itself at its approved end (Stage 1), so the series is no longer Paused; only the notice lags |
| burn.crank | 1 h | burns units of Retired series (Stage 1 `burn_retired`; an Extinguished series burns on claim) | holders can still claim; burn is cosmetic |
| reporting.reminders | 1 h | reminders for the earliest unpaid period only (the one Stage 1's derived status counts from; later periods wait for it): 7 days before `dueAt`, at `dueAt + 1` and at `graceEndsAt + 1`, from the chain's period read; each names what is owed (report or payment) and the series' status as the chain derives it then (A-REV-25) | issuers get no reminders |
| rate.snapshot | 30 min | one Pyth snapshot per UTC day per pair per chain, Chainlink cross-check | coverage drops → quarters flagged for attestor rates |
| fx.coverage | 6 h | flags quarters with < 80% coverage, opens attestor requests | reports for non-USD series block |
| transfer.windows | 1 h | opens/clears quarterly windows (flag `transfer_windows`) on series whose mint is final (a raise still processing its bids has none: MintNotFinalized) | no windows |
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

**Mainnet configured by mistake.** Adapters refuse it (cluster or chain-id config at construction, the RPC's genesis
hash or chain id at the first call). Under `live` the process does not start; under `auto` the chain stays on the
simulator and `GET /health` shows the refusal as the reason.

## Backups and retention

Postgres holds commitments, amounts, statuses, ciphertext and audit logs — no raw income. Retention periods are an open
question (Part J.9); until set, nothing is deleted automatically. Simulator state (`sim_*`) is development data.
