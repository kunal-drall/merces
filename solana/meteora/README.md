# @merces/meteora

Merces curve-mode raise style on Solana (brief D10): the oracle-driven Meteora DBC config generator, the
devnet graduation script and the pool state reader. Everything is verifiable offline; see
`docs/meteora/` for the proceeds memo, the curve-mode design note and the devnet runbook, and
`docs/assumptions/track-d.md` for every default.

```
src/constants.ts   program constants and enums (checked against SDK 1.5.13 / cp-amm-sdk 1.5.1)
src/math.ts        exact bigint port of the program's curve, migration, fee and vesting arithmetic
src/validate.ts    off-chain mirror of `create_config` validation (program error codes)
src/proceeds.ts    where the quote goes: migration fee, surplus, trading fees, DAMM v2 pool depth
src/config.ts      buildMercesCurveConfig(): attested income + series terms -> DBC ConfigParameters + JSON
src/graduation.ts  idempotent, resumable graduation flow (library)
src/graduate.ts    CLI for the flow            src/state.ts  pool progress reader (library + CLI)
src/cli-config.ts  CLI for the generator       src/cli.ts    arg parsing, RPC presets, polling confirmation
```

## Commands

```bash
pnpm --filter @merces/meteora test                  # unit tests (+ the local-validator E2E when solana-test-validator and the fixtures are present)
pnpm --filter @merces/meteora lint                  # tsc --noEmit
pnpm --filter @merces/meteora config -- --input examples/issuer.example.json --out series-config.json
pnpm --filter @merces/meteora graduate -- --cluster devnet --payer payer.json --issuer issuer.json --config series-config.json --create-quote-mint
pnpm --filter @merces/meteora state -- --cluster devnet --pool <pubkey>
pnpm --filter @merces/meteora test:local-validator  # end-to-end rehearsal with the real program binaries
```

The graduation state file holds the secret keys of the test wallets it creates (devnet only). Keep it out of git.

## Library use

```ts
import { buildMercesCurveConfig, mercesCurveConfigToJson } from "@merces/meteora";
const cfg = buildMercesCurveConfig({
  trailingAnnualIncome: 40_000_000_000n, // USDC base units
  targetRaise: 100_000_000_000n,
  unitsOnCurve: 10_000n,
  quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
});
cfg.configParameters;      // program ConfigParameters (bigint); toSdkConfigParameters() for the SDK
cfg.proceeds;              // who receives what, pool depth, price impact
mercesCurveConfigToJson(cfg); // deterministic JSON with configHash
```
