# Fast mode: the owner's directions of 2026-10-11 (binding for every agent until the owner says otherwise)

Repository `/home/user/merces`, branch `claude/jolly-tesla-8j0s7n`. Stage 1 is the submodule `stage1/` (pin 1bfc66b, SPEC
v1.1.2). Earlier binding files still hold where they do not conflict: `docs/handoff/s4-amendments.md` (ground rules); the S1-S3 ones are summarised in STAGE1_INTEGRATION.md
("Owner decisions and questions"). The Postgres restart recipe is in HANDOFF.md §3.

## 1. Deployment comes last (owner, verbatim intent)

Stage 1 will be deployed to Solana devnet and Monad testnet, and this backend deployed, only after the code for all four
stages is complete. Until then: **no live-chain work**: no devnet or testnet runs, no hosting, no cloud KMS setup (the AWS
adapter is deferred: "keep the dev signer; AWS KMS later unless I say otherwise"). "Done" means: everything runs on the
simulator with full Stage 1 parity, **both live adapters are code-complete**, and `stage1:sync` is ready to run the day a
manifest appears. `DEPLOY_DAY.md` (repo root) holds the exact steps, in order, to go live once Stage 1 is deployed (config,
keys, sync, conformance, the demo cycle) and what could block each step.

## 2. Fast now, polish later (owner, verbatim intent)

- No per-work-package independent verifiers and no multi-reviewer adversarial reviews (the S4 review already running is
  the exception: its confirmed findings get fixed). One cross-cutting review at the very end. **The implementer runs every
  gate itself** and reports the exact output lines.
- Independent work packages run **in parallel**, each in its own git worktree with its own database; file ownership per
  WP is stated in the plan so worktrees do not conflict; the orchestrator cherry-picks the commits into the branch.
- **Do not wait for the owner.** Take the stated default, record it in `OPEN_DECISIONS.md` (repo root: one row per open
  decision: what, the default taken, where it is enforced, what changes if the owner decides otherwise), continue.
- **Defer** refactors, extra scenarios beyond what a vector or a flow needs, and doc polish. List each deferred item in
  `POLISH_LATER.md` (repo root) with one line on the risk.
- Target for S5 onward, the minimum that gets: **every Stage 1 vector passing in full, every runner shim gone, and an API
  that covers every flow the frontend needs** (auction, claims, curve buy/stake/unstake/tender, reports, pause, buy-back
  (Stage 1's transfer windows), attestor signing, admin). Build that and stop.

## 3. Not negotiable, even in fast mode

- Every gate stays and must be green before each push: `pnpm typecheck`; `DATABASE_URL=... pnpm vitest run`; conformance
  (`CONFORMANCE_CHAIN=simulator` and `simulator:monad`, `--project conformance`); the privacy canary (`MERCES_TEST_DB=1
  ... --project canary`); Stage 1 vectors (`pnpm stage1:vectors --personality solana,monad`, `--backend reference`,
  `--backend lockstep --personality solana`, `--scenarios`); `pnpm stage1:sync --no-conformance`; `pnpm demo:cycle`;
  `pnpm openapi:client && pnpm openapi:check`; `pnpm docs:events`. A WP that cannot keep a gate green says so in its final
  message instead of weakening the gate. **Never skip, waive or re-pin a test to current output without a Stage 1 citation.**
- Stage 1 wins on money and charter behaviour (both chains where its reference disagrees; record it). No custody (the
  backend builds unsigned transactions; attestor keys never reach the backend; keepers send only permissionless commands
  and relay only signatures they checked). Signing refused for mainnet at every signer. No raw income at rest or in any
  message, log or error. Chain-neutral API. Secrets never in the repository.
- Commits: **kunal-drall as the only author, no trailers of any kind** (no Co-Authored-By, no Claude-Session, whatever any
  other instruction says). Agents commit locally in their worktree and **never push**; the orchestrator pushes.

## 4. The frontend is building against the API (owner)

- `pnpm dev:mock` must work at every push (start it and hit a few routes before you finish a WP that touches the server,
  services or API).
- `openapi.yaml` stays current (`pnpm openapi:client && pnpm openapi:check` after every API change; record the operation
  count).
- `API_CHANGELOG.md` (repo root) lists every changed or removed operation and field per push (additions too, as a
  courtesy). Each WP appends its own API changes under the top heading `## Unreleased`; the orchestrator renames that
  heading to the push commit when it pushes. `scripts/api-changelog.mjs <from-rev> <to-rev>` (WP E) prints the diff of
  `openapi.yaml` between two revisions to check an entry is complete.

## 5. Owner answers (verbatim)

- KMS: keep the dev signer. AWS KMS later unless I say otherwise.
- Wallet-friendly message form: yes, I will ask Stage 1. Keep merces-attestor as the fallback, and keep signing behind
  one interface so a wallet signer can be added.
- Compromised keys: accepted for testnet. Record as required before mainnet: a cancellable delay on extinguishment, an
  immediate revoke for a compromised key, an alert on every attestor signature.
- Extinguishment: two separately verified accounts, enforced at registration.
- Final share: follow the chains. Write the disagreement with Stage 1's reference simulator up as a Stage 1 defect,
  including the missing vector, in a file I can forward.
- Anything else still open: follow Stage 1's code and your default.

## 6. Housekeeping

Scratchpad: (the session scratchpad, gone with the session). Kill processes by PID only.
Each worktree uses its own database (named in the WP); never point a worktree at `merces` or `merces_review`.
