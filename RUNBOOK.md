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
`MERCES_VERIFIER_DEV=true` is set (docker-compose sets it for local development only), and `MERCES_VERIFIER_DEV=true`
itself is refused at boot when its chain table `MERCES_VERIFIER_CHAINS` names any chain but a local id (Solana localnet
104, EVM 31337): pointing the verifier at a testnet means a secret seed and `REPORT_VERIFIER_ADDRESS`.

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
(`EVM_TESTNET_CHAIN_IDS` in `packages/domain/src/signing.ts` since S4, beside its mainnet tripwire; every signer reads the
same list) and checks the RPC serves that id. A refused config or
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

### The non-reveal charge (the owner's setting)

`MERCES_NON_REVEAL_CHARGE_BPS` is the non-reveal charge every new series built through the terms service records, in
whole basis points within Stage 1's bounds (0 to 1000). When a series' sealed raise settles, a bid committed and never
revealed pays `floor(deposit × rate / 10000)` to the protocol fee collector at `processBid` and gets the rest back at
delivery (Stage 1's code); a failed raise charges nothing. The rate is the owner's decision: there is no default.

- **Unset (absent or blank):** the API starts, but `POST /drafts/{id}/build-create-series` answers 409 for a sealed raise
  (the message names `MERCES_NON_REVEAL_CHARGE_BPS`; `detail.setting` too), so no sealed series goes live without the
  owner's decision. A curve raise, which has no bids to charge, is built and records 0. Drafts can still be validated.
- **Malformed or out of bounds** (not a whole number, above 1000): the API, `dev:mock` and the keepers refuse to start,
  naming the setting and the bounds (never the value given).
- **Changing it** affects series created afterwards only: each series keeps the rate it recorded (Stage 1's charters are
  frozen; series created under the S2 hold recorded 0). Issuers cannot choose it. On a live chain (S5) Stage 1's
  registry copies the admin's protocol default (`set_defaults`) into each series whatever the transaction says, so keep
  the setting equal to the chain's default; the adapter then reads each series' recorded rate back.

### Simulator state version 5: reset

From S4 WP5 the persisted simulator state is **version 5**: Stage 1's key registry, each attestor key with its
revocation time (`{active, revokedAt}`; version 4 held a boolean), so a revoked key keeps Stage 1's 45-day grace on
report and FX signatures. Migration 023 adds the registry times to the read model's `attestors` table
(`registered_at`, `revoked_at`, `updated_seq`; rows indexed before it keep their state, with no times, and the next
event about the key overwrites them) and re-expresses the admin requests stored before S4 (`registerAttestor{active:
false}` becomes the `revokeAttestor` it now is). Reset the simulated chains **after deploying the WP5 build** with
the commands below; S4 WP6 and WP7 reset them again.

S4 WP6 completes version 5 (no new number: nothing was deployed in between): the report verifier's keys are Stage 1's
key records by 20-byte address too (they were ed25519 keys by key id), and a tier-2 report carries the verifier key's
Stage 1 REPORT signature. A version-5 chain saved before WP6 still holds the old verifier keys, so **reset the simulated
chains after deploying the WP6 build**. Migration 024 adds the read model's `verifier_keys` table (projected from
`VerifierKeyRegistered` / `VerifierKeyRevoked`, as `attestors`), removes the stored multisig requests for an ed25519
verifier key (no chain can carry them; the audit log keeps their proposal) and supersedes the reports assembled with the
retired ed25519 attestation that were never submitted (assemble them again; one built from such a row answers 409
`attestation-superseded`).

S4 WP7 keeps version 5, but attestors become 20-byte keys on both personalities (A-M5-2 revised): a simulator chain saved
before WP7 holds attestors registered under Solana wallet addresses, which no command or event can name any more, so
**reset the simulated chains after deploying the WP7 build** (then re-register the attestor keys; dev:mock registers and
links its dev attestor keys itself). Migration 025:
- adds `account_signer_keys` (an attestor key linked to an account by its own EIP-191 proof; kept by a reset: it names no
  chain), gives `auth_nonces` a `purpose` (`sign-in`, `link-signer-key`; existing rows are sign-in nonces) and an
  `account_id`, and makes its `chain` nullable (a link challenge is chain-neutral);
- keeps keys only: rows of `attestors` and `attestor_proposals` (its `wallet` column is renamed `address`) whose attestor
  is not a 20-byte key are removed, as are the multisig requests naming one (the audit log keeps their proposals);
- closes once, with `decision_code = 'superseded-s4'` and a state each table's check allows, the open work addressed to
  an attestor that is not a key: a pending hardship request → `rejected`; an open tier-3 case, or a signed one whose
  quarter no report has reached the chain with → `withdrawn`; an open annual attestation → `withdrawn` (a new state; a
  withdrawn one no longer holds its year); a built extinguishment request naming one → `withdrawn` (a new state); an
  attested amendment, or a built one that has not landed → `rejected`; an FX fallback request signed by one whose rate no
  report has reached the chain with is opened again (`decision_code` superseded-s4 until a key signs it), since closing
  it would hold its pair and period for good; reports assembled with such a co-signer and not submitted → `superseded`.
  The issuer opens each again, addressed to a registered key; items already on a chain keep their records.

Before version 5:

From S3 the persisted simulator state is **version 4**: beside Stage 1's own series ledger, payout vault, tail and final
pool (version 2, S1), the raise's own terms and Stage 1's multi-step auction settlement (version 3, S2), it carries each
series' unit scale (Stage 1's `unit_scale`: 1 for a sealed-bid series, 10^6 base lamports per whole unit for a curve
series), curve staking (the stake and tender totals, the census time, each holder's stake) and the curve record (S3
WP8: the DBC stand-in pool, its base-mint accounts, P0 and what was collected), completed under the same version before
anything was deployed. Migration 020 reshapes the read model's `curves` table (the old rows are dropped with it; a reset
re-indexes them). A persisted chain of another version is never
upgraded in place: `SimulatorChain.create` refuses it with `SimStateVersionError`, so the API and `dev:mock` stop at
boot on a database that still holds a version-1, -2, -3 or (since S4 WP5) -4 chain. Reset the simulated chains
**before deploying the version-4 build**, and again after S3 WP8 (no environment holds simulator data worth keeping):

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
  the allowlist (`setAllowlist`), the attestors (`registerAttestor`), the report-verifier key (`registerVerifierKey` of
  its 20-byte address) and the issuer registrations (`registerIssuer`). `dev:mock` does this itself: it registers the
  verifier key at boot and re-seeds its synthetic cohort on an empty chain.

### S4 resets: bid and order commitments (WP2)

S4 WP2 switched bid and order commitments to Stage 1's keccak over the price, quantity, salt and wallet (A-SIG-8). The
state version is unchanged (still 4), but a bid or window order committed before the switch carries our old SHA-256
commitment and can never be revealed (CommitmentMismatch, InvalidCommitment). Reset the simulated chains with the
commands above after deploying the WP2 build (no environment holds simulator data worth keeping); S4 WP5 (state
version 5, above), WP6 and WP7 reset them again. Clients compute the new commitment themselves (or through `POST /series/{id}/bids/commitment`) with a
fresh 32-byte salt per bid: the commitment no longer binds the series.

### Checks before a deploy

The gate (S1, kept through S2 and S3), all from the repository root with Postgres up:

```
pnpm typecheck
DATABASE_URL=postgres://postgres@localhost:5432/merces pnpm vitest run          # unit + DB suites
MERCES_TEST_DB=1 pnpm vitest run --project canary                               # the privacy canary
CONFORMANCE_CHAIN=simulator pnpm vitest run --project conformance               # also simulator:monad
pnpm stage1:vectors --personality solana,monad                                  # 14 targets + 7 prefix gates on our simulator
pnpm stage1:vectors --backend reference                                         # all 25 on Stage 1's own simulator
pnpm stage1:vectors --backend lockstep --personality solana                     # both side by side, every step
pnpm stage1:vectors --scenarios                                                 # our S3 claim scenarios, in lockstep
pnpm stage1:sync --no-conformance                                               # pin, drift, math, curve port, vectors
pnpm openapi:check                                                              # routes, openapi.yaml, access tiers
pnpm demo:cycle                                                                 # raise to payout on both personalities
```

`stage1:vectors` must exit 0 with `OK: 38/42 PASS, 42/42 at expected status (14 prefix runs)` (the 14 targets in full
and the 7 prefix gates to their gate, on both personalities; 01 and 05 PASS-WITH-WAIVERS; 03 PASS in full since the
non-reveal charge is modelled, with no accepted divergence, in lockstep too) and the reference backend with
`OK: 25/25 PASS`;
`stage1:vectors --scenarios` (the paths of the claim family no vector takes, built on Stage 1 vector prefixes) with
`OK: 22/24 PASS, 24/24 at expected status (2 runs with accepted divergences)` (twelve scenarios, (a)–(l), on both personalities; (l) is PASS-WITH-DIVERGENCES on DIV-S1I-1, a Stage 1-internal difference resolved toward both chains); `stage1:sync` must report the math, curve-port and vectors steps `OK` (the diff step stays
`WARN` until the adapters are wired, and conformance needs live deployments). The curve-port step needs cargo with Stage 1's
toolchain (`rustup toolchain install 1.97.1 --profile minimal`, the channel of `stage1/solana/rust-toolchain.toml`):
without it the step, and the sync, fails; it must print `55/55 figures, 5,883/5,883 oracle cases` at @1bfc66b. `openapi:check` prints `openapi.yaml matches 170 operations` (after S3) and `demo:cycle` ends with `DEMO OK`. The vector runner verifies every
embedded report proof with the ports' Groth16 verifier and never persists anything.

## Keys

- Development: `MERCES_KMS_PROVIDER=local` derives deterministic keys from `MERCES_LOCAL_KEY_SEED`. Each key id is
  configured with its algorithm (since S4 WP3 nothing is inferred from the id, and an unconfigured id is an error);
  a secp256k1 key is Stage 1's test-key derivation of `merces-local-kms:<seed>:<keyId>` and signs a digest as Stage 1
  does (`signDigest`: `r ‖ s ‖ v`, low s, `v ∈ {27, 28}`, checked against the key's address before it is returned).
  The report verifier's key id is `REPORT_VERIFIER_KEY_ID` (default `report-verifier-1`), a secp256k1 key since S4 WP6;
  its 20-byte address must be registered onchain by the multisig (`POST /admin/verifier-keys` `{chain, address}` builds
  the transaction). `dev:mock` registers it on the simulators automatically. The standalone verifier
  (`pnpm dev:verifier`) signs only for the chains of its own table `MERCES_VERIFIER_CHAINS` (`.env.example` and
  `docker-compose.yml` carry the dev simulators' domains; a test keeps them current) and, in development
  (`MERCES_VERIFIER_DEV=true`), accepts the local ids and nothing else (any other chain in the table stops it at boot);
  the API's in-process verifier in mock mode derives its table from each simulator's `ChainInfo.signing`.
- Production: a cloud KMS behind `KmsPort`. S4 ships the provider-neutral adapter (`RemoteSecp256k1Kms` in
  `@merces/ports`: the KMS's DER signature becomes Stage 1's 65 bytes, low s, the recovery id found against the key's
  address, fail closed; the DER SPKI public key gives the address) but no provider: which one holds the report-verifier
  key is an open owner question (STAGE1_INTEGRATION.md "Owner decisions and questions", S4 question 1), and the
  verifier refuses any `MERCES_KMS_PROVIDER` but `local` until it is answered. Setup facts, each pinned to its source:
  VERSIONS.md "Signing keys and KMS" (AWS: key spec `ECC_SECG_P256K1`, usage `SIGN_VERIFY`, `Sign` with
  `ECDSA_SHA_256` and `MessageType=DIGEST`; GCP: `EC_SIGN_SECP256K1_SHA256` at HSM protection level, the digest in
  `digest.sha256` unverified; HashiCorp Vault transit has no secp256k1 key).
- Report verifier key (S4 WP6, D10, amendment D10). The verifier starts only when its KMS key's address equals
  `REPORT_VERIFIER_ADDRESS` (required outside development) and every domain of `MERCES_VERIFIER_CHAINS` is on the
  signing allow-list (never mainnet). Each chain's registry holds it as a verifier key (`GET /admin/verifier-keys`
  shows the chain's records and the verifier's own address side by side). Rotation, on every chain:
  1. create the new key in the KMS and register its address (`POST /admin/verifier-keys`, or `POST
     /admin/verifier-keys/rotate` `{from, to}`, which registers the new key and revokes the old one in one transaction:
     the EVM's own `rotateVerifierKey`, two instructions of one transaction on Solana);
  2. switch `REPORT_VERIFIER_KEY_ID` and `REPORT_VERIFIER_ADDRESS` to the new key, and add the old address with its
     retirement time to `REPORT_VERIFIER_PREVIOUS_ADDRESSES` (`[{"address": "0x…", "retiredAt": <unix seconds>}]`), so a
     device's prior-quarter attestation by the old key stays acceptable, only for quarters that ended at or before
     `retiredAt`;
  3. revoke the old key (`POST /admin/verifier-keys/revoke`; refused for the chain's last active verifier key: 409
     `last-active-key`, rotate instead). Its tier-2 attestations of periods that ended by the revocation stay valid
     onchain until `revokedAt` + 45 days (Stage 1's grace), so reports already attested can still be submitted.
  A **compromised** verifier key is revoked at once and never listed in `REPORT_VERIFIER_PREVIOUS_ADDRESSES` (remove
  it if it is there): the verifier then refuses its priors (`prior-unattested`), so an issuer affected has the previous
  quarter attested again by the new key (from a fresh zkTLS proof of that quarter), or, where the chain accepts any
  prior (a series' first report outside Q1, A25), reports from the ZERO prior (the least favourable to it); and check
  the reports the chain accepted under the revoked key in its grace window, as for attestor keys.
- Attestor keys (S4 WP5, A-SIG-4; by key since S4 WP7): an attestor is a secp256k1 key held on the attestor's own
  device (never by the backend; the Merces attestor tool since S4 WP8, "Attestor key setup" below), its 20-byte address the attestor on every chain that registers it. Onboarding: the
  attestor links the key to their account (`POST /me/signer-keys/challenge`, sign the text with the key, `POST
  /me/signer-keys`), then an admin proposes it per chain (`POST /admin/attestors {chain, attestor, accountId?}`: 422
  `key-not-linked` until the account has linked it) and the multisig signs `registerAttestor`; access starts once it is
  indexed. Revocation: `POST /admin/attestors/revoke {chain, attestor}` builds the forward-only `revokeAttestor` (no link
  needed). The admin service reads the chain's registry first and refuses with 409 (nothing built) a key that is already
  active (`key-already-active`), a revoke of a key that is not active (`key-not-active`) and a revoke of the chain's last
  active attestor key (`last-active-key`: both chains refuse it). Rotation (a new device, a suspected key): the attestor
  makes a new key on the device and links it to the same account; `POST /admin/attestors/rotate {chain, from, to}` builds
  `rotateAttestor` (register `to`, revoke `from`, one transaction), for each chain the old key is registered on; PAUSE,
  AMEND, EXTINGUISH and TRUEUP signatures the old key made are dead once it lands and are signed again with the new key.
  An attestor unlinks a key with `DELETE /me/signer-keys/{address}` (409 `open-work` while work addressed to it is open). Attestor access ends as soon as the revocation is indexed; report (tier 3) and
  FX signatures the old key made for periods that ended by its revocation stay valid onchain until `revokedAt` + 45
  days (`GET /admin/attestors` shows `revokedAt` and `graceUntil`), so a compromised key's in-flight signatures stay
  usable for that long: check the reports accepted under a revoked key in that window. Pause approvals, amendments and
  extinguishments need an active key.
- Vault key: `MERCES_VAULT_KEY_HEX` (32 bytes). Rotation re-encrypts `terms_vault`, `applications.notes_encrypted` and
  `contract_sessions.signed_document_encrypted`; the key id is stored beside each ciphertext.
- Keeper fee payer: fund it with devnet SOL / testnet MON only; it never holds stablecoins. On Solana the settle and
  deliver jobs also pay the rent of the accounts a bidder needs (a winner's Holder PDA at `processBid`, the bidder's
  stablecoin and unit token accounts at `deliverBid` when missing; Stage 1 `raise.rs`), and the fee collector's token
  account must exist before the first `processBid` (a deployment step). Set a compute-unit limit on `processBid`: it
  can exceed Solana's 200k default (A-AUC-10; rent is not measured in the simulator).

### Attestor key setup

An attestor signs Stage 1's messages with a dedicated secp256k1 key that never leaves their own machine (S4 D2,
A-SIG-2). The Merces attestor tool keeps it: `merces-attestor`, the `bin` of `@merces/poi-device`; from a checkout of
this repository it runs as `pnpm -s attestor <command>` (`-s` keeps pnpm's banner off the JSON it prints). It belongs on
the attestor's machine, never on a server.

1. **Make the key.** `pnpm -s attestor keygen` asks for a password twice on the terminal (no echo; at least 8
   characters) and writes `~/.merces/attestor/keystore.json` (`--keystore <path>` for another file; mode 0600 in a
   0700 directory; it never overwrites a file): a Web3 Secret Storage v3 keystore at go-ethereum's standard strength
   (scrypt n = 2^18, r = 8, p = 1; AES-128-CTR; VERSIONS.md "Attestor device tool"). It prints the key's address,
   never the key, and no command of the tool prints a key. To bring an existing key, `pnpm -s attestor import <file>`
   (a v3 keystore of any strength, scrypt or PBKDF2, or a file holding a `0x`-hex key, which you then delete) writes a
   new keystore at full strength. The tool signs only with a keystore at that strength: import a lighter one first
   (another tool's default, `geth --lightkdf`). Back up the keystore file and its password, separately: nobody can
   recover the key without both. The key attests and does nothing else: never fund it and never import it into a
   wallet (it signs raw digests, and a raw-digest signer signs any 32 bytes, a transaction hash included).
2. **Pin the networks.** Write `~/.merces/attestor/networks.json` (`--networks <path>` for another file): for each chain
   key you attest on, `{"<chain>": {"family": "evm" | "solana", "chainId": …, "registry": "<the Merces registry's
   address>"}}` (the tool computes the signing domain with Stage 1's `computeDomain`; a full `{chainKind, chainId,
   registry, domain}` is accepted too and must hash to itself). Take the values from the deployment manifest Merces
   publishes, never from the API the requests come from: the table is what stops a compromised API from pointing the
   key at another deployment. The live deployments and their manifest come with S5. The tool refuses the whole table
   when any entry is a mainnet (Solana cluster tag 101, an EVM mainnet such as Monad's 143), a network off the signing
   allow-list or a domain that is not the hash of its own fields. Development against the simulator: copy each chain's
   `signing` from `GET /chains` and pass `--allow-local` to `sign` (the local ids 104 and 31337, nothing else).
3. **Link the key to your account.** `POST /me/signer-keys/challenge {"address": "0x…"}`; save the response's
   `message` exactly (`jq -r .message > challenge.txt`); `pnpm -s attestor link challenge.txt` shows the host, the
   account, the key and the nonce, asks, signs the challenge with EIP-191 (it signs no text but a key-link challenge
   built for this key) and prints `{address, nonce, signature}`, the body of `POST /me/signer-keys`. An admin then
   proposes the key per chain and the multisig registers it ("Attestor keys" above).
4. **Sign a work item.** Save the item's signing request (one, or a list such as an FX rate's per-series requests;
   the S4 WP9-WP13 routes return them) as `request.json` and run `pnpm -s attestor sign request.json`. The tool checks
   the request against the pinned table (the chain, its domain, the series key), rebuilds Stage 1's pre-image and digest
   from the typed fields and refuses any difference, then shows what you authorise, built from those fields alone (a
   request carries no text of the server's; one that does is refused). Before a PAUSE or an EXTINGUISH it says that the
   signature cannot be recalled: anyone holding it can submit it until it is used or the key is revoked. Once you
   confirm and give the password it signs the digest it rebuilt and prints `{kind, chain, seriesId, signer,
   signature, digest}` (`--out <file>` writes it 0600); post the signature to the item's route. Limits in S4: the nonce
   of a PAUSE, AMEND, EXTINGUISH or TRUEUP request comes from the server and the tool cannot check it against the chain
   yet (S5 reads it from a public RPC), so sign only a request you expect; an unrelayed PAUSE or EXTINGUISH signature
   that leaks is withdrawn only by rotating the key.
5. **Passwords.** The terminal is the default. `--password-env NAME` (and `--source-password-env NAME` for `import`)
   read a password from an environment variable, for scripted tests: a password there is readable through
   `/proc/<pid>/environ` by the same user and by root, and lands in shell history when it is set on the command line.
   Do not use it for a real key. `MERCES_ATTESTOR_TEST_SCRYPT_N` (a weak keystore, for tests) is refused outside the
   test harness (`VITEST=true` or `NODE_ENV=test`).
6. **Expert fallback.** Foundry's `cast wallet sign --no-hash <digest>` signs a raw digest from a local keystore. It
   signs blind: rebuild and check the digest first (`sign` prints the one it rebuilt). Its output format is unverified
   (VERSIONS.md); the API refuses a non-canonical signature.

## Keepers

All jobs are idempotent and safe to run twice or late; each run is recorded in `keeper_runs` (`GET /admin/keepers/runs`).
Chains and series are independent: one chain's outage or one series' error never stops the others. A chain refusal that
only means "nothing to do" (TooEarly, WrongStatus, Duplicate …) is ignored; any other error marks the run `ok = false`
with the chain or series and the message in `detail`, which is what to alert on. The auction jobs put a Stage 1 error
name or ChainError code in `detail` instead of the message (adapter messages can embed values; S2), and so do the curve
jobs (S3). Notices for chain events (auction settled or failed, a settlement round rejected, the mint finalized, a bid
delivered, status changes, releases paused or resumed, pause ended, formal notice; a curve's completion,
`curve.completed`, and its redemption, `curve.tender-open`) are enqueued by the indexer in the transaction that projects
the finalized event, not by the keepers. The curve jobs run on Solana-family chains only (curve mode is Solana only).

| Job | Interval | What it does | If it stops |
| --- | --- | --- | --- |
| auction.settle | 1 min | drives Stage 1's settlement of raises whose reveal phase ended: the proposal, the tally pages, finalize and a `processBid` per bid, which finalizes the mint (at most 64 steps per series per run; the next run goes on). A step someone else sent first is re-planned, not a failure; any other refusal fails the run as `<series>: <Stage 1 name or code>`, and the steps that series' pass landed before it still count as the run's actions (the next run goes on from there). A raise with no bid waits 24 h past its reveal end so its issuer can still cancel (A-AUC-12). A series the planner will not act on fails the run as `<series>: stuck (<reason>)` and is told to the admins once per round and reason (`auction.settlement-stuck`) | settlement waits: winners' units accrue only from processing, and the money paths stay closed until the mint is final (MintNotFinalized). Anyone can send the next step: `beginSettlement`, `tallyBids`, `finalizeSettlement` and `processBid` are permissionless commands any wallet can build and sign (`POST /series/{id}/auction/build-step {signer}` builds the next one with the keepers' planner; a 409 says why there is none) |
| auction.deliver | 1 min | pushes every processed, undelivered bid with `deliverBid` (Stage 1 `deliver_bid`: the refund and the units won), reading the bids from the chain; at most 64 attempts per series per run. A refused delivery fails the run as `<series> <bidder>: <code> (attempt n)` and is retried on its own backoff (1 min, 5 min, 30 min, 2 h, 12 h, then daily; `auction_deliveries` keeps the attempts, the next attempt and the code); runs in between report `n waiting` and are not failures. A bid still failing 24 h after its raise was finalized is told once to the admins and the bidder (`bid.delivery-stuck`); a bid someone else delivered first is not a failure | refunds and units wait; a processed winner's units still accrue. Any wallet can deliver a bid (`deliverBid` is permissionless): the bidder builds its own with `POST /series/{id}/bids/build-deliver` (any account can build one for any bid, signed by one of its own wallets) |
| auction.reveal-reminders | 10 min | reminds unrevealed bidders in the last 12 h | bidders may miss reveals |
| status.crank | 1 h | `crankStatus` once the earliest unpaid period passes a status instant the chain has not recorded: InGrace after `dueAt`, Late after `graceEndsAt`, the formal notice at `formalNoticeAt` (period end + 30 / 45 / 90 days of unpaused time, Stage 1's inclusive bounds) | the stored and indexed status lags the derived one until any sync point; reads and money paths use the derived status, which is authoritative |
| pause.crank | 1 h | announces hardship pauses whose approved end passed (`PauseEnded`) | events only: a pause ends by itself at its approved end (Stage 1), so the series is no longer Paused; only the notice lags |
| curve.lifecycle | 1 min | for every curve series: `completeCurve` once the pool filled while the raise is Open (it settles at the pool's finish time), and in the same pass `collectCurveProceeds` once (the partner migration fee and surplus into the treasury, which starts the release tranches); after that `collectCurveProceeds` at most once a week on the chain's clock while the partner's trading fees wait in the pool (also on a curve that never fills). A step another sender took first (RaiseNotOpen, CurveNotComplete) is skipped; any other refusal fails the run as `<series>: <code>`. Each check that sent a step or read a change is kept in `curve_monitor` with the chain's time (`GET /series/{id}/curve` `graduationMonitor`); `POST /admin/curves/monitor` runs the same pass by hand | the raise stays Open after the pool filled (no reports, no stakes; the treasury stays empty) until anyone sends `completeCurve` and `collectCurveProceeds` (both permissionless); trading fees wait in the pool, never lost |
| curve.sync | 10 min | the census (`syncCurveUnits`, permissionless) of each settled, non-terminal curve: once after completion (no census since its settlement time), so holders can stake, then once per period end an hour after it unless a census already postdates the end, so the issuer can report (Stage 1's report gate, CurveUnitsNotSynced). **Never while the issuer has assembled the report for the series' next expected period and not submitted it**: the proof binds the census and a new one would invalidate it (InvalidProof; amendment H1); the run says `n held for an assembled report` and syncs once the report is submitted. A TerminalStatus or RaiseNotOpen refusal (a stale read) is routine; anything else fails the run as `<series>: <code>`. Anyone else may still sync at any time (the census race is reported to Stage 1, A-CURVE-5) | stakes beyond the last census fail (StakeExceedsOutstanding) and the issuer's report assembly answers 409 CurveUnitsNotSynced with the sync step: the issuer or any holder can build it (`POST /series/{id}/curve/build-sync`) |
| burn.crank | 1 h | one `burnRetired` (Stage 1 `burn_retired`) per holder of a Retired series that still holds units in its own balance (its units less undelivered auction units and units held for a window ask; an Extinguished holder's units burn at `claimFinal`); never on a curve series, whose units never burn (CurveModeNoBurn); a holder the chain refuses (not registered) is skipped | holders can still claim; burn is cosmetic |
| reporting.reminders | 1 h | reminders for the earliest unpaid period only (the one Stage 1's derived status counts from; later periods wait for it): 7 days before `dueAt`, at `dueAt + 1` and at `graceEndsAt + 1`, from the chain's period read; each names what is owed (report or payment) and the series' status as the chain derives it then (A-REV-25) | issuers get no reminders |
| curve.stake-reminders | 1 day | on each settled, non-terminal curve with a census, every linked wallet (account_wallets on that chain) holding units in its wallet, read from the chain per wallet, is reminded that unstaked units earn nothing (`curve.stake-reminder`, to that wallet's account only), with its next step: `approve-wallet` (not allowlisted: it cannot stake), `register-and-stake` or `stake`; once per payment round (the last paid period) and step, recorded in `reminders_sent` with the notice | holders who never staked are not reminded; nothing is lost (a later stake earns from then on) |
| curve.tender-reminders | 1 h | once a curve redeemed (status Redeemed) and while its tender quota lasts (units at redemption less tendered and staked units), every linked wallet holding units in its wallet is reminded to tender (`curve.tender-reminder`, to that wallet's account only): `tender`, `register-and-tender`, or `approve-wallet` (not registered and not allowlisted: it cannot tender); once per step. Stakers hear of the redemption from the chain notice (`curve.tender-open`): their stake is reserved | wallet holders may miss the quota; stakers' tenders are unaffected |
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
