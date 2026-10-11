# Open decisions
| Decision | Default taken | Where | If the owner decides otherwise |
| --- | --- | --- | --- |
| Verifier key custody | local dev signer until staging; AWS KMS later | `packages/ports/src/kms*.ts`, `report-verifier/src/main.ts` | add the AWS adapter over `RemoteSecp256k1Kms` (facts pinned in `VERSIONS.md` "Signing keys and KMS") |
| Wallet-friendly messages | owner asks Stage 1 for EIP-712/EIP-191 forms; `merces-attestor` is the path | `poi-device`, `DigestSigner` | add a wallet signer behind `DigestSigner`; the API's signature check takes the new digest form |
| Compromised-key risk | accepted for testnet | `SECURITY.md` (HANDOFF §4.3) | mainnet requirements (HANDOFF §6.4) |
| Extinguishment accounts | two separately verified accounts, enforced at registration (commit `5029b6f`) | `admin/service.ts` `requireVerifiedAttestorAccount` | — (decided) |
| Final-share weight | follow both chains; the reference fix and missing-vector regression are implemented in stage1/ | `simulator/src/engine/terminal.ts`; `docs/stage1/defects/` | verify the fix against both chains and the regression vector |
| Non-reveal charge rate | per series; the rate is the owner's deployment setting `MERCES_NON_REVEAL_CHARGE_BPS`, no built-in default (the terms service refuses sealed series while unset) | `services/src/terms`, `.env.example` | set the value |
| Window fee | a series parameter; value = Stage 1's default until the owner decides | S5 #2 | set the value |
| Tier-1 public terms | accepted, with an explicit issuer consent step | S5 #8 | — |
| Formal notice | mirrors Stage 1 (period end + 90 days); owner asked Stage 1 to move it to 90 days after the deadline | `domain` status rules | follow Stage 1's change |
| Tier-2 liquidity flag | the verifier signs the device-declared flag | `report-verifier` | an attested source |
| Lost device openings | deterministic salts from the device secret | `poi-device` | — |
| Pushed claims / keeper sweeps | not built | — | a `claimFor` path |
| `issuer_accepts_public_price` | implicit on choosing a curve (consent field recorded as a question) | curve configure | an explicit field |
| Census binding at period end | ours: 409s around the issuer's report (A-CURVE-5); asked of Stage 1 | `poi/service.ts`, keepers | follow Stage 1 |
| Unstake pays | the code wins (unstake credits pending; our builder bundles a claim) | `meteora/staking.ts` | follow Stage 1 if its SPEC wins |
| Mock zkTLS on testnet | refuse on live chains (S4 review finding 10) | `report-verifier` | an explicit override for testnet |
| Anything else open | follow Stage 1's code and the default in `ASSUMPTIONS.md` | — | — |
