# Deferred work
The S4 recovery/security findings are implemented in the current integration work; verification is recorded in HANDOFF.md. The remaining delivery work (S5 and live adapters) is not deferred polish.

| Item | Risk if left |
| --- | --- |
| AWS KMS adapter | staging cannot use a managed key until built (owner: later) |
| EVM adapter builds one command per transaction | the curve unstake bundle is Solana only (curve mode is Solana only, so no impact now) |
| Our scenarios beyond what a vector needs | fewer regression nets for paths no vector takes |
| Live nonce read in `merces-attestor` from a public RPC | a compromised API could collect a PAUSE over a future nonce (residual risk in SECURITY.md) |
| Real identity (J.1), zkTLS (J.3), e-sign, email, price feeds, DEX providers | live tier-2 reports are blocked until a real zkTLS provider is selected and implemented; the development trusted setup must be replaced before mainnet |
| Doc polish of `STAGE1_INTEGRATION.md` (long) | slower onboarding |
| `TODO`/`S5` markers in source (`grep -rn "S5" packages/*/src`) | each is an item of HANDOFF §4.4 or HANDOFF §5 |


- Match the Solana simulator personality's terminal pause cleanup to Solana (the attestor service and indexer now block/close terminal hardship work; EVM/reference differ, S4 finding 8).
