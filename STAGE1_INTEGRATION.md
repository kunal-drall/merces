# STAGE1_INTEGRATION.md

How Stage 2 works without Stage 1 today, how it catches Stage 1 the moment it appears, and what happens then.
This file is updated at each catch-up with what matched, what changed and what is still open.

## Status (2026-10-08)

**Stage 1 is not present.** `pnpm stage1:sync` reports "Stage 1 not present" and every chain runs on the simulator
(`auto` mode falls back when no manifest entry passes a health check). Everything below the "After Stage 1 lands"
line is what will happen, not what has happened.

| Item | State |
| --- | --- |
| Canonical model v0 | `DOMAIN_EVENTS.md`, `packages/domain/schema/domain-v0.schema.json` |
| Simulator | both personalities pass the H2 conformance suite (16 tests) and the H1 scenarios |
| Live adapters | `SolanaChain` and `EvmChain` skeletons: health checks, mainnet guards, event mappers; reads/writes wait for generated clients |
| Math | `@merces/math` interim; `selectMath()` swaps in Stage 1's library after vector parity |
| Drift report | none yet (`INTERFACE_DRIFT.md` is written by `stage1:sync`) |

## What we expect from Stage 1

A handoff manifest at `$STAGE1_PATH/handoff/manifest.json` (or `manifest.json` at the root). Every field is optional;
unknown fields are kept:

```json
{
  "version": "…", "commit": "…",
  "math":    { "package": "<path or npm name exporting a MercesMath-shaped object (see packages/math/src/index.ts)>" },
  "vectors": "<path to parity vectors (format below)>",
  "events":  { "doc": "EVENTS.md", "schema": "<JSON schema: {events: {Name: {properties}}, commands: {Name: {properties}}}>" },
  "solana":  { "cluster": "devnet", "rpcUrl": "…", "programs": { "<module>": "<program id>" }, "idlDir": "<dir of Anchor IDL json>", "startSlot": 0 },
  "evm":     [ { "chain": "monad-testnet", "chainId": 10143, "rpcUrl": "…", "startBlock": 0, "contracts": { "<module>": "<address>" }, "abiDir": "<dir of ABI json>" } ],
  "stablecoins": { "solana": { "USDC": "<mint>", "USDG": "<mint>" }, "monad-testnet": { "USDC": "<address>" } }
}
```

If Stage 1 arrives without a manifest, write `stage1.map.json` (same shape) by hand at the Stage 1 root or at this
repository's root; the pipeline accepts either.

### Parity vector format

```json
{
  "math": [ { "fn": "owedYtd", "args": ["100000000000000", "500", "75000000000", "60000000000"], "expect": "750000000" } ],
  "scenarios": [ {
    "name": "happy-path", "genesis": 1767225600, "personalities": ["solana", "monad"],
    "steps": [
      { "at": 0,  "actor": "issuer",   "command": { "kind": "registerIssuer" } },
      { "at": 10, "actor": "keeper",   "command": { "kind": "settleAuction", "seriesId": "$series0" } },
      { "at": 20, "actor": "backer-1", "command": { "kind": "revealBid", "...": "..." }, "expectError": "WrongPhase" }
    ],
    "expect": { "balances": { "backer-1": { "USDC": "…" } }, "series": { "$series0": { "status": "OnTime", "unitsOutstanding": "500" } } }
  } ]
}
```

Actors: `issuer`, `backer-N`, `attestor-N`, `admin`, `keeper`, `allowlistManager`, `router`. `$seriesN` is the N-th
series created in the scenario. Bigint arguments are decimal strings. Every expected balance must match the simulator
to the base unit; a mismatch means the simulator is wrong and is fixed.

## `pnpm stage1:sync`

1. **detect** — manifest or map through `STAGE1_PATH`; "Stage 1 not present" otherwise.
2. **generate** — EVM ABIs → `packages/stage1-sync/generated/evm/*.ts` (`as const` for viem); Anchor IDLs →
   `generated/solana/*.ts` (built-in renderer; Codama can replace it once Stage 1 pins an IDL spec version).
3. **diff** — `INTERFACE_DRIFT.md`: every canonical event and command, its Stage 1 counterpart, field-by-field mapping,
   and anything missing, extra or differently shaped.
4. **math** — Stage 1's library vs ours on every math vector (`MATH_PARITY.md` under `packages/stage1-sync/out`);
   `selectMath()` switches only when every vector agrees.
5. **vectors** — scenario replay through the simulator (`VECTOR_PARITY.md`).
6. **conformance** — the H2 suite against each live chain (`CONFORMANCE_CHAIN=solana|evm:<chain>`).
7. **verdict** — per chain: ready for `live`, or the blockers.

It runs in CI on a six-hour schedule and whenever `stage1/**`, `stage1.map.json` or `.gitmodules` change
(`.github/workflows/stage1-sync.yml`; set the `STAGE1_REPO` repository variable).

## After Stage 1 lands (D6 checklist)

1. Run `pnpm stage1:sync`; read `INTERFACE_DRIFT.md` first.
2. Resolve drift in the adapters' mappers (`packages/chain-solana/src/mapping.ts`, `packages/chain-evm/src/mapping.ts`).
   Change the canonical model only for a real gap, and record why here.
3. Where Stage 1 contradicts an assumption, Stage 1 wins for onchain behaviour: update the simulator and
   `ASSUMPTIONS.md`. Candidates already flagged: A-AUC-1 (tie-breaking), A-C8-1/2 (accrual), A-RED-1/2 (redemption
   precondition, tail fee), A-REP-2 (public input layout), A-FX-1/2 (weekends, Chainlink), A-C11-6 (extinguishment).
4. Wire the adapters' reads, event decoding and transaction builders to the generated clients; the conformance env
   for live chains needs funded devnet/testnet wallets (`CONFORMANCE_ISSUER_KEY`, `CONFORMANCE_BACKER_KEYS`,
   `CONFORMANCE_ATTESTOR_KEYS`, `CONFORMANCE_ADMIN_KEY`) and short durations in Stage 1's test deployment.
5. Get the conformance suite green on Solana devnet and Monad testnet.
6. Run the full raise-to-payout cycle on both live chains (`pnpm demo:cycle` against `MERCES_CHAIN_*_MODE=live`).
7. Flip both chains to `live` in the staging configuration; keep `mock` for local development and Stage 3.
8. Update this file: what matched, what changed, what is still open.

## Known gaps that only Stage 1 can close

- Groth16 circuit, verifying key and prover artifacts (the mock proof system is used end to end until then).
- The exact event and instruction names, account layouts and error codes (the adapters' mappers start empty).
- Pyth receiver accounts / `updatePriceFeeds` call shapes inside Stage 1's rate accumulator; FX weekend policy.
- Reclaim's onchain verifier on Monad is not listed by Reclaim; the report verifier's offchain attestation is the
  path Stage 1 verifies onchain (registered ed25519 key).
