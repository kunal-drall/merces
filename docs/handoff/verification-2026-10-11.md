# Integration verification — 2026-10-11

Backend: S4 recovery, S5 items 1–12, registry completion and both live adapters. Stage 1: reference final-share fix
`bafe1fb76094afa423211320356b8db868c2b340`. The 25 official vectors and chain programs are unchanged.

All commands below exited 0. Tests used an isolated PostgreSQL 16 database; no public-chain transactions ran.

| Check | Recorded result |
| --- | --- |
| `pnpm typecheck` | passed, including a repeat after client/IDL generation |
| Full suite with `MERCES_TEST_DB=1` | `Test Files 101 passed (101)`; `Tests 939 passed (939)` |
| `CONFORMANCE_CHAIN=simulator` | `Tests 20 passed (20)` |
| `CONFORMANCE_CHAIN=simulator:monad` | `Tests 11 passed (11)` |
| Privacy canary | `Tests 3 passed (3)` |
| Stage 1 vectors, solana + monad | `OK: 50/50 PASS, 50/50 at expected status` |
| Stage 1 reference vectors | `OK: 25/25 PASS, 25/25 at expected status` |
| Full lockstep, solana + monad | `OK: 50/50 PASS, 50/50 at expected status` |
| Scenario CLI, lockstep | `OK: 32/32 PASS, 32/32 at expected status` (explicitly names the reference-inapplicable scenario) |
| Sync scenario matrix | `82/82 run(s) PASS` across applicable backends |
| New final-share vector, both lockstep personalities | `PASS 88/88` each; `OK: 2/2 PASS, 2/2 at expected status` |
| Stage 1's new final-share unit regression | `Tests 1 passed (1)` |
| `stage1:sync --no-conformance` | math/signatures/vectors OK; curve figures 55/55, Rust oracle 5,883/5,883; generation 4 IDLs and 28 ABIs |
| `pnpm demo:cycle` | `DEMO OK` on both personalities, real Groth16 proofs |
| `pnpm openapi:client && pnpm openapi:check` | `openapi.yaml matches 213 operations` |
| `pnpm docs:events` | event documentation and schema regenerated |
| `pnpm keys:check` | `published keys: 133 addresses` |
| `pnpm dev:mock` | started on an isolated empty database; `/health`, `/chains`, `/series`, `/issuers` each HTTP 200; process stopped afterward |
| Clean install with generated clients absent | `pnpm install --offline --frozen-lockfile` passed; postinstall regenerated 4 IDLs and 28 ABIs; typecheck and every pre-push command rerun successfully |
| `git diff --check` | passed |

`stage1:sync` still reports the raw canonical/chain interface differences as WARN: 28 items without a direct
counterpart, 476 field mismatches, 5 unverified name matches and 92 additional Stage 1 items. It compares raw ABI/IDL
shapes, not the adapters' enrichment logic; the generated `INTERFACE_DRIFT.md` is retained for review. Its deployment
verdict is **NOT ready**, also because live conformance was explicitly skipped. This was not weakened or presented as
public-chain verification. Simulator conformance ran separately as recorded above.

The final integration review corrected consecutive event numbering for the indexer, Solana combined claim accounting,
tail-report unit census, Hermes base64-to-hex conversion, complete EVM module health, and redaction of transport errors.
ABI/IDL and Meteora fixtures run offline; actual RPC, signing-provider, fee and deployment behavior remains to be
rehearsed on deployment day. `DEPLOY_DAY.md` names the manifest, funded keys, real provider and frontend prover prerequisites.

Implementation merge: `4625660bad2c28c9d88020def0f04a59f62f21e9`; adapter implementation `7fccb08`, clean-install
bootstrap `711c576`. Both source histories are ancestors of the integration, with the exact Stage 1 code retained as
its submodule. New author/committer fields and empty trailer blocks were checked before publication. Subsequent
publication-status edits touch only `HANDOFF.md`, `API_CHANGELOG.md` and this report; no tests read these files.
