# VERSIONS.md

Pinned versions and the external facts the code relies on. Every row names its source and the date checked
(2026-10-07 unless stated). Nothing here was invented; "unconfirmed" means the official page could not be reached
from the build environment and the fact must be re-verified before going live.

## Toolchain

| Package | Version | Why |
| --- | --- | --- |
| node | 22.x | runtime |
| pnpm | 10.28.0 | workspace |
| typescript | 5.9.3 | last 5.x line (7.x is the Go port; not adopted yet) |
| vitest | 4.1.11 | tests |
| tsx | 4.23.15 | run TypeScript directly |
| fastify | 5.12.5 | API gateway |
| zod | 4.6.5 | validation + JSON Schema generation (`z.toJSONSchema`) |
| pg | 8.23.1 | Postgres driver |
| pino | 10.4.0 | logging (with payload redaction) |
| openapi-typescript | 7.13.0 | typed client generation from `openapi.yaml` |
| viem | 2.57.3 | EVM adapter (`monadTestnet` chain id 10143 ships in `viem/chains`) |
| @solana/web3.js | 1.99.0 | Solana adapter skeleton (maintenance line; Anza recommends `@solana/kit` 8.x for new code — migrate when Stage 1's clients are generated with Codama) |
| @noble/hashes | 2.4.0 | sha256; scrypt and PBKDF2-HMAC-SHA256 for the attestor's keystore (`@merces/poi-device` `attestor-keys.ts`, a direct dependency since S4 WP8) |
| @noble/curves | 2.4.0 (npm, published 2026-08-27; the version Stage 1's SDK pins, `stage1/packages/sdk/package.json`) | secp256k1: Stage 1's `signDigest` and `recoverAddress` run on it; `@merces/ports` uses it only to parse a KMS's DER signature and SPKI point (`kms-secp256k1.ts`), and `stage1:sync` to emulate a KMS's DER. Traps (checked 2026-10-10 in `abstract/weierstrass.d.ts` and `.js` of the installed 2.4.0): `prehash` defaults to **true**, i.e. noble signs and recovers `sha256(input)` (`.d.ts:74, :82, :99`), so every call over a keccak digest passes `prehash: false`; `lowS` defaults to true for `sign` and `verify` (`.d.ts:84, :101`); the `'recovered'` format is **`recid ‖ r ‖ s`** (`.d.ts:68-69`; `.js:956` writes the recovery byte first), not Stage 1's `r ‖ s ‖ v`; `Signature.recoverPublicKey(hash)` takes the digest as it is while the top-level `recoverPublicKey` hashes unless `prehash: false` (`.js:922-924`, `:1144-1149`); `Signature` has no `normalizeS` (normalise with `new Signature(r, n − s)`). We never call noble's signing for Stage 1 messages ourselves: Stage 1's SDK does (`signatures.ts:43-55`), and a test pins that noble's defaults give another signature (`packages/ports/test/kms-secp256k1.test.ts`) |
| bs58 | 6.0.0 | Solana address checks |
| snarkjs | 0.7.6 | offchain Groth16 proving and verification, through Stage 1's `@merces/circuits` (`proveReport`, `verifyReport`; pinned by `stage1/circuits`) |
| Rust (rustc, cargo) | 1.97.1, Stage 1's pin (`stage1/solana/rust-toolchain.toml`, read at run time; checked 2026-10-10) | `stage1:sync`'s curve-port gate builds Stage 1's merces-common into `tools/stage1-oracle` with it (selected through rustup's `RUSTUP_TOOLCHAIN`); both CI workflows install it (`rustup toolchain install 1.97.1 --profile minimal`). Without cargo the gate, and so the sync, fails; another toolchain is reported (`warn`) |

## Stage 1 (imported, not rewritten)

| Item | Value | Why |
| --- | --- | --- |
| `stage1` submodule | `https://github.com/kunal-drall/merces` at `1bfc66b` (branch `claude/sweet-goodall-b7acm3`); tree `aa93160`, identical to `5eafd41` named in the handoff | SPEC v1.1.2, the 25 parity vectors, IDLs and ABIs |
| `@merces/reference` | 0.1.0 from the submodule (`stage1/packages/reference`) | the mechanism math, used directly by `@merces/math` and the simulator |
| `@merces/sdk` | 0.1.0 from the submodule (`stage1/packages/sdk`) | fixed point, periods, Poseidon/keccak commitments, signed messages, canonical error names |
| `@merces/circuits` | 0.1.0 from the submodule (`stage1/circuits`) | the ProofOfIncome circuit, its development verifying key and prover (development trusted setup, Stage 1 A37) |
| merces-common (Rust) | 0.1.0 from the submodule (`stage1/solana/crates/merces-common`) | the only dependency of `tools/stage1-oracle` (a path dependency; no registry crate, so it builds offline and keeps no `Cargo.lock`), which answers for `@merces/math`'s ported curve family in the curve-port gate |
| build | `scripts/stage1-build.mjs` (root `postinstall`) compiles the three with this repository's TypeScript 5.9.3 | they ship TypeScript with `exports` pointing at `dist` |

## Chain tooling (verified from official repos / npm)

| Item | Value | Source |
| --- | --- | --- |
| Anchor TS client | `@anchor-lang/core` 1.2.1 (`@coral-xyz/anchor` frozen at 0.32.1; repo moved to otter-sec/anchor) | npm, github.com/otter-sec/anchor |
| Codama | `codama` 1.11.0, `@codama/nodes-from-anchor` 1.5.6, `@codama/renderers-js` 2.5.0 | npm, github.com/codama-idl/codama |
| Solana devnet RPC | https://api.devnet.solana.com | solana.com docs (clusters) |
| Monad testnet | chain id 10143, RPC https://testnet-rpc.monad.xyz, ~400 ms blocks, finality after 2 blocks; `finalized`/`safe` tags supported | viem/chains, docs.monad.xyz (snippet) |
| Monad mainnet | chain id 143 (refused by the adapter guard) | viem/chains |
| USDC on Monad testnet | 0x534b2f3A21130d7a60830c2Df862319e593943A3 | Circle developer docs (snippet) |
| USDC Solana devnet mint | 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU | Circle developer docs (snippet) |
| USDG Solana devnet mint | 4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7 | Paxos docs (snippet) |
| ERC-3643 | `@erc3643org/erc-3643` 4.1.3 (T-REX 4.1.6 deprecated; ONCHAINID `@onchain-id/solidity` 2.2.1) | github.com/ERC-3643/ERC-3643 |
| Meteora DBC SDK | `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13; program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (mainnet and devnet); token badge needed only for Token-2022 quote mints with extensions | github.com/MeteoraAg |
| Jupiter | Swap API V2 at https://api.jup.ag/swap/v2 (`GET /order` → `POST /execute`, or `GET /quote` + `POST /swap`); `x-api-key` required (free via the Jupiter Portal) | github.com/jup-ag/space-station |
| Groth16 on Solana | Light Protocol `groth16-solana` 0.2.0 over `sol_alt_bn128_group_op` | github.com/Lightprotocol/groth16-solana |
| Groth16 on EVM | snarkjs `zkey export solidityverifier` (alt_bn128 precompiles 0x6/0x7/0x8) | github.com/iden3/snarkjs |

## Signing keys and KMS (S4)

Checked 2026-10-10 for S4 WP3 (the KMS port's `signDigest`, the DER normaliser and the provider-neutral adapter,
`packages/ports/src/kms.ts` and `kms-secp256k1.ts`). The vendors' HTML documentation (`docs.aws.amazon.com`,
`docs.cloud.google.com`, `learn.microsoft.com`) answered 403 at this environment's egress proxy, so every row below is
taken from a vendor-authored source file at a pinned release tag or commit, downloaded and read for this table, and is
**unconfirmed against the vendor's HTML documentation**: re-verify before going live. Which provider holds the
report-verifier key is an open owner question (STAGE1_INTEGRATION.md "Owner decisions and questions", S4 question 1);
until it is answered only the local signer is wired.

| Item | Fact | Source (pinned) | Status |
| --- | --- | --- | --- |
| AWS KMS key | Key spec `ECC_SECG_P256K1`, "secp256k1, commonly used for cryptocurrencies"; for it "specify `SIGN_VERIFY`" (the only usage) | botocore tag `1.43.111` (commit `0723d72cddd310b4ad7c6169d21168298b2ff3f8`, released 2026-10-09), `botocore/data/kms/2014-11-01/service-2.json:1407` (`CreateKeyRequest.KeyUsage`), `:1417` (`CreateKeyRequest.KeySpec`), `:3030-3039` (`KeySpec` enum) | unconfirmed (HTML) |
| AWS KMS `Sign` | `SigningAlgorithm=ECDSA_SHA_256` with `MessageType=DIGEST`: "When the value is `DIGEST`, KMS skips the hashing step in the signing algorithm", and "the length of the `Message` value must match the length of hashed messages for the specified signing algorithm" (32 bytes: a keccak-256 digest's length). The signature is "a DER-encoded object as defined by ANSI X9.62–2005 and RFC 3279 Section 2.2.3". Low `s` is promised nowhere in the model (no "low", "malleab" or "normaliz" anywhere), so the normaliser flips a high `s` | same file, `:3371-3377` (`MessageType` enum), `:3835` (`SignRequest.MessageType`), `:3860` (`SignResponse.Signature`), `:3877` (`ECDSA_SHA_256`) | unconfirmed (HTML) |
| AWS KMS `GetPublicKey` | "a DER-encoded X.509 public key, also known as SubjectPublicKeyInfo (SPKI), as defined in RFC 5280": for secp256k1 the 23-byte prefix `3056301006072a8648ce3d020106052b8104000a034200` then `04 ‖ X ‖ Y`, 88 bytes (the prefix also checked against Node 22's own secp256k1 SPKI export) | same file, `:2468` (`GetPublicKeyResponse.PublicKey`) | unconfirmed (HTML); prefix checked |
| GCP Cloud KMS key | `EC_SIGN_SECP256K1_SHA256`: "ECDSA on the non-NIST secp256k1 curve. This curve is only supported for HSM protection level. Other hash functions can also be used" (with a link to a page we cannot reach) | googleapis commit `525d4c82dc1dd2fa3884198a8006a7bf5b48ac9d`, `google/cloud/kms/v1/resources.proto:464-468` | unconfirmed (HTML) |
| GCP Cloud KMS `AsymmetricSign` | The digest "must be produced with the same digest algorithm as specified by the key version's algorithm"; `Digest` has `sha256`, `sha384`, `sha512` and `external_mu` fields only. A keccak-256 digest would go in `digest.sha256`: the "other hash functions can also be used" comment above is partial support for that, and it is **unverified** | same commit, `google/cloud/kms/v1/service.proto:1674-1681`, `:2497-2515` | unverified |
| GCP Cloud KMS public key and signature format | `GetPublicKey` returns PEM by default for non-PQC keys (SPKI, RFC 7468 §13: `spkiFromPem`); the `DER` option's comment names RFC 5208's PrivateKeyInfo, so it is not relied on. The signature is DER as far as the official Node sample shows: it verifies with `crypto.createVerify('sha256')` over `publicKey.pem`, and Node's ECDSA signatures are DER by default (checked with Node 22.22.0: a `createSign` signature starts `0x30`) | `resources.proto:779-802`; GoogleCloudPlatform/nodejs-docs-samples commit `bd29bbb271ad0faf9147391e958b2e573210f3c2`, `kms/verifyAsymmetricEc.js:55-71` | unconfirmed |
| Azure Key Vault | Curve `P-256K` ("The SECG SECP256K1 elliptic curve"), algorithm `ES256K` ("ECDSA using P-256K and SHA-256, as described in RFC 7518"), `CryptographyClient.sign(algorithm, digest)`. The output format (RFC 7518 JWS `r ‖ s`, 64 bytes) is unverified; the adapter takes DER only, so Azure needs a different front end | `@azure/keyvault-keys` 4.10.2 (npm, published 2026-06-09, integrity `sha512-VmUSLbXRAbSzDD8grXHGPaknYs0SKr3yuf6U+d4XMpX4XuVYskNqbTTwXce0zR1LyxfTZm9rWEBcvs3vdYwCmQ==`), `dist/esm/models/models.d.ts:160, :170, :461-462, :482`; `dist/esm/cryptographyClient.d.ts:311` | unverified |
| HashiCorp Vault transit | No secp256k1 key type: the `KeyType` list is AES-GCM, ChaCha20-Poly1305, ECDSA P-256/P-384/P-521, ED25519, RSA, HMAC, CMAC, AES-CBC, ML-DSA, SLH-DSA, HYBRID and `MANAGED_KEY`. Not usable for this key. `KeyType_MANAGED_KEY`, which delegates to an external KMS, is **unexamined** | hashicorp/vault tag `v2.1.2` (commit `76fdd6587523c4c6cb079635075e019714d23470`), `sdk/helper/keysutil/policy.go:61-81` (`MANAGED_KEY` at `:72`) | from source code, not docs |

Why ordinary wallets cannot sign Stage 1's messages (S4 D2: attestors sign with the Merces attestor tool on their own
device): Stage 1 signs the raw keccak digest of a `MERCES_*_V1` pre-image, with no EIP-191 prefix (SPEC §1.4).

| Item | Fact | Source (pinned) |
| --- | --- | --- |
| MetaMask MIP-3 | "Discontinuing the eth_sign signature method", status Accepted, created 2024-05-15: "Requests for the `eth_sign` method will return a standard "Method not found" error with code = `-32601`" | MetaMask/metamask-improvement-proposals commit `d05c7248bf914e07828fd55815d4c232d83d4d6f`, `MIPs/mip-3.md:2-9, :29` |
| ERC-191 (`personal_sign`) | `personal_sign` prepends `"\x19Ethereum Signed Message:\n" + len(message)` before hashing (version byte `0x45`) | ethereum/ERCs commit `b1f2bd8b1d31ec3bb25077f1a15295ad29e8a8fd`, `ERCS/erc-191.md:41-44, :72` |
| EIP-712 | Signs `keccak256("\x19\x01" ‖ domainSeparator ‖ hashStruct(message))`; status Final | ethereum/EIPs commit `af3a7802c8ea516f717c6013e27d0f529046f007`, `EIPS/eip-712.md:48, :133` |
| Ledger Ethereum app client | `@ledgerhq/hw-app-eth` 7.10.0 signs with secp256k1 only through `signTransaction`, `clearSignTransaction`, `signPersonalMessage` (EIP-191), `signEIP712HashedMessage` and `signEIP712Message`: no raw-hash method (`starkUnsafeSign` signs on the STARK curve) | npm, published 2026-10-02, integrity `sha512-JD0ebJw+JJxKSd2foK0hx0385BmPp8iaWDTl/qcllJry3KdAHsZSIyaYXUPMpOM5ULQWshntTDWOg/QQKUkQnA==`, `lib/Eth.d.ts:50, :67, :93, :110, :147, :272` |
| Foundry `cast wallet sign --no-hash` | "Treat the message as a raw 32-byte hash and sign it directly without hashing it again"; refused with a browser wallet. The expert fallback for attestors (blind signing: recompute the digest first). Whether its output is low `s` with `v ∈ {27, 28}`, and whether hardware signers support it, is unverified here; the API refuses anything non-canonical | foundry-rs/foundry tag `v1.8.5` (commit `51a52c59cffd940f76eddd0b4bb1791aa4b5ac7f`), `crates/cast/src/cmd/wallet/mod.rs:178-180, :549-552, :568-569` |

## Attestor device tool (S4 WP8)

Checked 2026-10-11 for the Merces attestor tool (`merces-attestor`, `@merces/poi-device` `attestor-keys.ts`,
`attestor-signer.ts`, `attestor-cli.ts`; S4 D2: attestor keys stay on the attestor's machine). Both sources were
downloaded from raw.githubusercontent.com at the pinned commit and read for this table; the tests replay every vector
named here (`packages/poi-device/test/attestor-tool.test.ts`).

| Item | Fact | Source (pinned) | Status |
| --- | --- | --- | --- |
| Web3 Secret Storage v3 (the keystore format) | Version 3; AES-128-CTR is the minimal cipher, keyed with `DK[0..15]`, parameter `iv` (128 bits); `mac` = `KECCAK(DK[16..31] ++ ciphertext)`, checked before decrypting; KDF `scrypt` (`n`, `r`, `p`, `dklen`, `salt`) or `pbkdf2` (`prf` `hmac-sha256`, `c`, `dklen` ≥ 32, `salt`); "make sure the uuid, salt and iv are actually random". The page sets no minimum `n`; both its vectors use `n`/`c` = 262144 | ethereum/ethereum-org-website commit `e5bb5d899b274b3d6dff8be52b20306fe173059e`, `public/content/developers/docs/data-structures-and-encoding/web3-secret-storage/index.md:28-73` (sha256 of the file `73884b84…e38ef`) | official definition |
| Its test vectors | The PBKDF2-SHA-256 vector (`:85-118`) reproduces in full: derived key `f06d69cd…8551`, MAC, secret `7a28b5ba…fe9d`, address `0x008aeeda4d805471df9b2a5b0f38a0c3bcba786b`. **The scrypt vector (`:120-152`) does not reproduce**: its kdfparams (`n` 262144, `r` 8, `p` 1, salt `25710c2c…1034`) give the derived key `b4130dc8…20ec` (noble and Node's native scrypt agree), not the stated `7446f59e…6c2d`; the stated derived key, MAC and ciphertext agree with each other, so a parameter on the page is wrong. A test pins both facts | same file | checked here |
| go-ethereum keystore (the reference implementation) | `StandardScryptN = 1 << 18` and `StandardScryptP = 1` ("256MB memory and taking approximately 1s CPU time"), `LightScryptN = 1 << 12`, `scryptR = 8`, `scryptDKLen = 32`; `EncryptDataV3`: a 32-byte random salt, a 16-byte random IV, AES-128-CTR under `derivedKey[:16]`, `mac = Keccak256(derivedKey[16:32], cipherText)`; the keystore JSON carries `address` (40 hex, no `0x`), `crypto`, `id` (a UUID) and `version` 3 | ethereum/go-ethereum tag `v1.17.8` (commit `a579077007b98217c3e253a66e4b452ca0c32b96`), `accounts/keystore/passphrase.go:49-70, :140-180, :184-197, :243-277` (sha256 `6b078aa8…f23a`) | from source code |
| go-ethereum's keystore test vectors | `wikipage_test_vector_scrypt` (`n` 262144, `r` 1, `p` 8, salt `ab0c7876…ba19`: the original wiki vector), `wikipage_test_vector_pbkdf2`, `31_byte_key` and `30_byte_key` (`n` 2; an old keystore's key without its leading zero bytes, which the tool left-pads): all four reproduce | same tag, `accounts/keystore/testdata/v3_test_vector.json:1-97` (sha256 `e3a43355…5d7d`) | checked here |
| The tool's keystore strength | Every keystore the tool writes (`keygen`, `import`) uses go-ethereum's standard strength: scrypt `n` = 2^18, `r` = 8, `p` = 1, dklen 32. A lower `n` is refused outside the test harness (`VITEST=true` or `NODE_ENV=test`; the CLI's `MERCES_ATTESTOR_TEST_SCRYPT_N` likewise), and the tool signs only with a keystore at that strength: a lighter one (`geth --lightkdf`, or another tool's default) is re-encrypted with `import`, which also reads PBKDF2 keystores. "Standard" is go-ethereum's name for the value; the definition page sets no minimum | go-ethereum `passphrase.go:52-58` above | our default (S4 amendment fix 4) |
| Foundry `cast wallet sign --no-hash` as a fallback | Signs a raw 32-byte hash from a local keystore (the row above, "Why ordinary wallets cannot sign"). It signs blind, so an attestor using it first rebuilds the digest from the typed fields with a tool they trust (`merces-attestor sign` shows the digest it rebuilt). Whether its output is low `s` with `v ∈ {27, 28}`, and whether `cast` reads the keystores this tool writes (go-ethereum's format), is unverified here; the API refuses any non-canonical signature (it recovers to nobody) | foundry-rs/foundry tag `v1.8.5`, as above | unverified |

## Oracles

| Item | Value | Source |
| --- | --- | --- |
| Pyth Hermes | https://hermes.pyth.network — `GET /v2/updates/price/latest?ids[]=…&encoding=base64&parsed=true`; `GET /v2/updates/price/{publish_time}`; `GET /v2/price_feeds?asset_type=fx` | github.com/pyth-network/pyth-crosschain (Hermes OpenAPI) |
| `@pythnetwork/hermes-client` | 3.1.0 — `new HermesClient(url)`, `getLatestPriceUpdates(ids, {encoding, parsed})` | npm |
| `@pythnetwork/pyth-solana-receiver` | 0.16.0; receiver program `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`, price-feed program `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT` (mainnet and devnet) | docs.pyth.network source repo |
| Pyth on Monad | IPyth at 0x2880aB155794e7179c9eE2e38200202908C17B43 on Monad testnet and mainnet; `pyth-sdk-solidity` 4.3.1; `updatePriceFeeds(bytes[])` payable, `getUpdateFee`, `getPriceNoOlderThan(id, age)` | docs.pyth.network source repo |
| Pyth FX feed ids (confirmed) | FX.EUR/USD `0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b`; FX.GBP/USD `0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1`; FX.AUD/USD `0x67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80` | docs.pyth.network data file |
| Pyth FX feed ids (unconfirmed) | USD/JPY, USD/CAD, USD/CHF, USD/SGD, USD/MXN, USD/BRL, USD/INR exist by name (EM pairs are quoted USD/XXX) — the rate keeper resolves ids at startup from `/v2/price_feeds?asset_type=fx` and fails closed when missing | — |
| FX market hours | FX feeds publish Sunday 17:00 ET to Friday 17:00 ET; EM FX from Sunday 18:00 ET; outside hours Hermes serves the last price (gate on `publish_time`) | docs.pyth.network (market hours) |
| Chainlink on Monad | Data Feeds on Monad mainnet only (crypto/exchange-rate feeds); **no FX feeds on Monad**; Data Streams verifier on testnet 0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64 | github.com/smartcontractkit/documentation |

## zkTLS and income sources

| Item | Value | Source |
| --- | --- | --- |
| Reclaim JS SDK | `@reclaimprotocol/js-sdk` 5.8.2 — `ReclaimProofRequest.init(appId, appSecret, providerId)`, `getRequestUrl()`, `getStatusUrl()`, `verifyProof(proofs)`, `transformForOnchain(proof)`; `@reclaimprotocol/zk-fetch` 1.1.0 for server-side fetches | npm, github.com/reclaimprotocol/reclaim-js-sdk |
| Reclaim proof shape | `{identifier, claimData:{provider, parameters, owner, timestampS, context, identifier, epoch}, signatures[], witnesses[{id,url}], extractedParameterValues, publicData?}`; context JSON holds `contextAddress, contextMessage, reclaimSessionId, extractedParameters, providerHash` | reclaimprotocol/docs ("Anatomy of a proof") |
| Hashing extracted values | HTTP provider `responseRedactions[].hash: 'oprf' \| 'oprf-mpc' \| 'oprf-raw'` makes the attestor sign a TOPRF hash of a named regex group instead of the value (attestor-core docs; not on the public docs site) | github.com/reclaimprotocol/attestor-core |
| Reclaim providers | A Stripe provider exists in the Reclaim devtool catalogue (id `acfdeaa9-9250-4acd-afd3-fac7ca03458b`, snippet-confirmed); no Deel or DistroKid provider found — custom HTTP providers needed | dev.reclaimprotocol.org (snippet) |
| Reclaim onchain verifiers | EVM on Ethereum, Base, Arbitrum, Optimism, Polygon and testnets; Solana program `rEcLDWaVLaymz82eGr6cutosPxE6SEzw6q4pbtLuyqf`; **Monad not listed** | github.com/reclaimprotocol/reclaim-solidity-sdk, reclaim-solana-sdk |
| TLSNotary | alpha (v0.1.0-alpha.15); `tlsn-js` deprecated/archived 2026-02; browser extension + `tlsn-wasm`; not production-ready | github.com/tlsnotary/tlsn |
| Stripe | `GET /v1/balance_transactions`, `GET /v1/payouts`, `GET /v1/balance`; test keys `sk_test_…`; Node SDK `stripe` 23.0.0 | github.com/stripe/openapi (2026-09-30) |
| Deel | https://api.letsdeel.com — `GET /rest/v2/invoices`, `GET /rest/v2/payments` (bearer/OAuth2); contractor-side earnings endpoint unconfirmed | developer.deel.com (snippet) |
| DistroKid | no public API found; income must come through a Reclaim HTTP provider over the DistroKid web app or through tier 3 | — (unconfirmed absence) |
