# Tokeny T-REX (ERC-3643 reference implementation) — research memo

Target: a Solidity engineer deploying T-REX with Foundry on an EVM chain (Monad) and writing custom compliance modules.

**Sources examined (read-only):**

- `/home/user/tokenysolutions/t-rex` — git `f1390127d4270e7f31764c068caf0a1526b852d4` ("🗑️ Deprecate repo (#254)", 2025-10-28). All `file:line` citations below are relative to this directory unless stated otherwise. `node_modules/` is **not** present in the clone.
- `@onchain-id/solidity@2.2.1` — fetched with `npm pack` into the scratchpad and extracted (`.../scratchpad/oid/extract/package/`). Citations are written as `oid:contracts/<path>:<line>`.
- `@openzeppelin/contracts@4.9.3` and `@openzeppelin/contracts-upgradeable@4.9.3` — fetched with `npm pack` (the versions resolved by the repo's `package-lock.json`).
- `/home/user/openzeppelin/openzeppelin-contracts` — this checkout is **OZ v5.7.0**, not the version T-REX depends on (see §2.4).
- Two real Foundry builds were run (forge 1.7.1) to verify compilation claims (§2.5).

> **Repo status:** the README opens with "⚠️ This repository is DEPRECATED and no longer maintained ⚠️ Please see https://github.com/ERC-3643/ERC-3643" (`README.md:1-2`). 4.1.6 is the last npm release of `@tokenysolutions/t-rex`; the maintained successor lives under the ERC-3643 GitHub org (not examined here).

---

## 0. Headline findings

1. **Licence is GPL-3.0 with a dual-licensing notice** ("proprietary license or the GPL v.3") on every file, and the **11 concrete compliance modules additionally carry a CC-BY-NC-4.0 "non-commercial" rider** (§1). The core (Token, registries, ModularCompliance, proxies, factory, `IModule`, `AbstractModule*`) is plain GPL-3.0.
2. **Everything is pinned to `pragma solidity 0.8.17;`** (83 of 85 files; the other two use `^0.8.17`), and so is all of `@onchain-id/solidity@2.2.1`. Unmodified sources **do not compile under solc 0.8.2x**; they compile cleanly with solc 0.8.17, and they compile under 0.8.30 once the pins are relaxed to `^0.8.17` (verified, §2.5).
3. **Requires OpenZeppelin 4.x (resolved 4.9.3). Not OZ 5.** The code uses the no-argument `Ownable()` constructor and `__Ownable_init()` (§2.4).
4. **`IdentityRegistry.isVerified` returns `true` for any registered identity when the ClaimTopicsRegistry is empty**, and `registerIdentity` only checks "non-zero and not already registered" — a dummy contract or even an EOA can be registered as the "identity" (§5).
5. **Token starts paused** (`Token.init` sets `_tokenPaused = true`, `contracts/token/Token.sol:128`); an agent must `unpause()`.
6. **Zero-amount transfers/mints/burns revert** because `ModularCompliance.transferred/created/destroyed` require `_value > 0` (`contracts/compliance/modular/ModularCompliance.sol:155,167,179`).
7. `mint` **does** reach modules with `_from == address(0)` via `canTransfer(address(0), _to, _amount)` (`Token.sol:456`), so every custom `moduleCheck` must handle the zero sender (§7.5).
8. **Upgrades** are governed by the owner of the `TREXImplementationAuthority` (`useTREXVersion`); proxies look up the implementation on every call (beacon-like, custom slot, not ERC-1967). Set the IA owner to a timelock with OZ `transferOwnership` (§9).
9. Nothing chain-specific was found (§10).

---

## 1. Licence

### 1.1 Repository licence

- `LICENSE.md` is the verbatim GNU GPL v3 text: `LICENSE.md:1-2` "GNU GENERAL PUBLIC LICENSE / Version 3, 29 June 2007".
- `README.md:68`: "This project is licensed under the GNU General Public License v3.0".
- `package.json:38`: `"license": "SEE LICENSE IN LICENSE.md"` (not an SPDX expression).

### 1.2 SPDX identifiers in `contracts/`

| SPDX | Count | Files |
|---|---|---|
| `GPL-3.0` | 83 | all production contracts |
| `UNLICENSED` | 1 | `contracts/_testContracts/OIDImports.sol:1` (test-only) |
| none | 2 | `contracts/_testContracts/MockContract.sol`, `contracts/_testContracts/ClaimIssuerTrick.sol` (test-only) |

### 1.3 Dual-licensing language (every production file)

Every production contract has the same header notice (e.g. `contracts/token/Token.sol:40-62`):

> "The T-REX software is licensed under a proprietary license or the GPL v.3. If you choose to receive it under the GPL v.3 license, the following applies: … Copyright (C) 2023, Tokeny sàrl. This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version."

So the repo is **GPL-3.0-or-later with an optional commercial/proprietary licence from Tokeny**.

### 1.4 Additional CC-BY-NC-4.0 restriction on the concrete compliance modules

`CHANGELOG.md:14` (4.1.6): "Added commercial licensing to all modules of compliance as they are part of Tokeny's IP."

All **11 concrete modules** carry, at line 2 and lines 63-66, e.g. `contracts/compliance/modular/modules/MaxBalanceModule.sol:2` and `:63-66`:

> "This contract is also licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC-BY-NC-4.0), which prohibits commercial use. For commercial inquiries, please contact Tokeny sàrl for licensing options."

Files with the rider: `ConditionalTransferModule.sol`, `CountryAllowModule.sol`, `CountryRestrictModule.sol`, `ExchangeMonthlyLimitsModule.sol`, `MaxBalanceModule.sol`, `SupplyLimitModule.sol`, `TimeExchangeLimitsModule.sol`, `TimeTransfersLimitsModule.sol`, `TokenListingRestrictionsModule.sol`, `TransferFeesModule.sol`, `TransferRestrictModule.sol` (all under `contracts/compliance/modular/modules/`).

Files **without** the rider (plain GPL-3.0 + proprietary alternative): `IModule.sol`, `AbstractModule.sol`, `AbstractModuleUpgradeable.sol`, `ModuleProxy.sol` (verified: header lines 1-3 and 40-52 contain only the standard notice), and all of Token / registries / ModularCompliance / proxies / factory / roles / DVA / DVD.

The SPDX line on the modules is still `GPL-3.0` (the CC rider is only in comments), so SPDX-based scanners will under-report. The legal effect of "GPL-3.0 *and also* CC-BY-NC-4.0" on the same file is ambiguous (GPL §7 forbids adding further restrictions to GPL-licensed code; a court could read it either as GPL-only or as "licensee's choice"). **Treat the 11 modules as non-commercial-only unless you obtain Tokeny's commercial licence; do not import them into a commercial product. Write your own modules against `IModule`/`AbstractModuleUpgradeable`, which are GPL-only.**

### 1.5 Is it GPL-3.0, and what does that imply?

**Yes: GPL-3.0-or-later** (strong copyleft), with a commercial alternative available from Tokeny.

Implications for a repository that imports these contracts:

- Solidity `import` + compile produces a combined work that embeds T-REX bytecode/source into your artefacts. Under the GPL this is a derivative/combined work; **if you distribute the resulting source or bytecode (publishing a repo, verifying on an explorer, shipping to clients), the whole must be offered under GPL-3.0-compatible terms**, including your own contract sources that are compiled together with T-REX. GPL is not LGPL (`LICENSE.md` tail: "The GNU General Public License does not permit incorporating your program into proprietary programs. … use the GNU Lesser General Public License instead").
- Deploying bytecode on a public chain is arguably "conveying" (the bytecode is public); verified source on an explorer certainly is. Plan for GPL-3.0 on everything compiled with T-REX, or buy the commercial licence.
- Interacting with already-deployed T-REX contracts from a *separate* contract via interfaces (e.g. only `IModule.sol`, `IToken.sol`) is the lowest-coupling option, but note that the interface files themselves are GPL-3.0 too, so copying them into your repo still brings GPL text in. Re-declaring minimal interfaces yourself is the only clean-room path.
- A custom module inherits from `AbstractModuleUpgradeable` (GPL) → your module source is GPL-covered if distributed.
- `@onchain-id/solidity@2.2.1`: all 18 contracts are `SPDX-License-Identifier: GPL-3.0` (`oid:contracts/Identity.sol:1`), `LICENSE.md` is GPL-3.0, **but `package.json` says `"license": "ISC"`** (`oid:package.json:32`) — an internal inconsistency; assume GPL-3.0 (the source headers and LICENSE file govern).
- OpenZeppelin 4.9.3 is MIT — no issue.

---

## 2. Versions and compilation

### 2.1 Package

- `package.json:2-3`: `"name": "@tokenysolutions/t-rex"`, `"version": "4.1.6"`.
- Published files (`package.json:10-19`): `artifacts/`, `contracts/`, `index.js`, `index.d.ts`, excluding `_testContracts`. `index.js` exports Hardhat artifacts (ABI + bytecode) for every contract (`index.js:1-75`), e.g. `require('@tokenysolutions/t-rex').contracts.Token`.
- In-contract version string: `TokenStorage.sol:79` `_TOKEN_VERSION = "4.1.3"` (returned by `Token.version()`, `Token.sol:404-406`) — not bumped to 4.1.6.
- `CHANGELOG.md:4-19` (4.1.6): `TimeTransfersLimitsModule.removeTimeTransferLimit/batchSet/batchRemove`, new `TokenListingRestrictionsModule`, CC-BY-NC rider on modules, `TransferRestrictModule.moduleCheck` now allows `_from`/`_to == address(0)`.

### 2.2 Solidity pragmas

- 83 files: `pragma solidity 0.8.17;` (exact pin).
- 2 files: `pragma solidity ^0.8.17;` — `contracts/compliance/modular/modules/TransferRestrictModule.sol:69`, `contracts/compliance/modular/modules/SupplyLimitModule.sol:69`.
- `hardhat.config.ts:11,13-15`: compiler `0.8.17`, optimizer enabled, `runs: 200`.
- `.solhint.json:4`: `"compiler-version": ["error", "^0.8.17"]`.
- `@onchain-id/solidity@2.2.1`: all 18 files `pragma solidity 0.8.17;` (exact pin).
- OpenZeppelin 4.9.3: `^0.8.0`–`^0.8.2` style pragmas (compatible with any 0.8.x).

### 2.3 Dependencies (`package.json` — note they are *devDependencies*; the npm package declares **no runtime dependencies**, so consumers must install OZ and ONCHAINID themselves)

| Dep | Range (`package.json`) | Resolved (`package-lock.json`) |
|---|---|---|
| `@onchain-id/solidity` | `^2.0.0` (`:47`) | `2.1.0` (`package-lock.json:2488-2489`) |
| `@openzeppelin/contracts` | `^4.8.3` (`:48`) | `4.9.3` (`:2494-2495`) |
| `@openzeppelin/contracts-upgradeable` | `^4.8.3` (`:49`) | `4.9.3` (`:2500-2501`) |

The user's stated target `@onchain-id/solidity 2.2.1` is within `^2.0.0`; its ABI surface used by T-REX (`IIdentity`, `IClaimIssuer`, `IIdFactory`) is unchanged between 2.1.0 and 2.2.1 as far as the T-REX call sites go (`getClaim`, `keyHasPurpose`, `isClaimValid`, `createTokenIdentity`).

### 2.4 OpenZeppelin major version: must be 4.x

T-REX uses the OZ-4 API everywhere:

- No-arg `Ownable()` constructor (OZ-4): `contracts/roles/AgentRole.sol:70` (`contract AgentRole is Ownable`), `contracts/proxy/authority/TREXImplementationAuthority.sol:72`, `contracts/factory/TREXFactory.sol:82`, `contracts/factory/TREXGateway.sol:106` (via `AgentRole`), `contracts/DVD/DVDTransferManager.sol:69`, `AgentRoles.sol:70`, `OwnerRoles.sol:70`. OZ-5's `Ownable` constructor requires `address initialOwner` (`/home/user/openzeppelin/openzeppelin-contracts/contracts/access/Ownable.sol:38`) → compile error.
- No-arg `__Ownable_init()`: `Token.sol:123`, `IdentityRegistry.sol:103`, `IdentityRegistryStorage.sol:74`, `ClaimTopicsRegistry.sol:72`, `TrustedIssuersRegistry.sol:75`, `ModularCompliance.sol:85`, `AbstractModuleUpgradeable.sol:131`. OZ-5 takes `initialOwner`.
- `ModuleProxy` wraps OZ `ERC1967Proxy(implementation, _data)` (`ModuleProxy.sol:65-70`) — this signature is the same in OZ-4 and OZ-5, but the other usages break.

**Do not point Foundry remappings at `/home/user/openzeppelin/openzeppelin-contracts` (v5.7.0). Install `@openzeppelin/contracts@4.9.x` and `@openzeppelin/contracts-upgradeable@4.9.x` (4.9.6 is the latest 4.x).**

### 2.5 Do the contracts compile with solc 0.8.2x? (verified by building)

Set-up used (scratchpad, not committed): `src/` = copy of `contracts/` minus `_testContracts/`; remappings `@openzeppelin/contracts/=<oz-4.9.3>/`, `@openzeppelin/contracts-upgradeable/=<ozu-4.9.3>/`, `@onchain-id/solidity/=<oid-2.2.1 package root>/`; optimizer on, 200 runs.

| Build | Result |
|---|---|
| Unmodified sources, `solc_version = "0.8.17"` | **Compiler run successful.** 108 artefact directories. |
| Unmodified sources, `solc_version = "0.8.30"` | **Fails before compiling**: `Error: Encountered invalid solc version in src/DVA/DVATransferManager.sol: No solc version installed that matches the version requirement: =0.8.17`. (With a pinned compiler you get `ParserError: Source file requires different compiler version`.) |
| Sources with `sed 's/^pragma solidity 0\.8\.17;/pragma solidity ^0.8.17;/'` applied to **both** T-REX and `@onchain-id/solidity`, `solc_version = "0.8.30"`, `evm_version = "paris"` | **Compiler run successful with warnings** — only `Warning (3628)` "payable fallback function, but no receive" on the 6 `*Proxy.sol` contracts and `Warning (5667)` unused parameters in `TransferFeesModule.moduleCheck` (`TransferFeesModule.sol:172`). No errors, no breaking semantic changes detected by the compiler. |

Contract sizes (`forge build --sizes`, runtime bytes): `Token` 14,245 (0.8.17) / 14,162 (0.8.30); `IdentityRegistry` 6,910; `ModularCompliance` 5,619; `TREXImplementationAuthority` 8,995; **`TREXFactory` 23,495 at 0.8.17 (only 1,081 bytes under the 24,576 EIP-170 limit) and 22,967 at 0.8.30** — keep `optimizer_runs` low (200) for the factory or it may exceed the size limit; `TokenProxy` 1,604; `MaxBalanceModule` 8,510.

**Practical consequence for Foundry:** Foundry resolves one solc version per import graph. Any of your files that `import` a T-REX file (e.g. a custom module importing `AbstractModuleUpgradeable.sol`) must have a pragma satisfiable together with `0.8.17` — i.e. write your own files with `pragma solidity ^0.8.17;` (or `>=0.8.17`) and let the unit compile with 0.8.17; **or** vendor T-REX + ONCHAINID into your repo and patch the pins to `^0.8.17` (as tested above) to compile everything with 0.8.2x. Also note solc ≥0.8.20 defaults to `evm_version = shanghai` (emits `PUSH0`); set `evm_version` explicitly to what the target chain supports.

`forge lint` (runs with `forge build` on forge 1.7.x) reports `erc20-unchecked-transfer` on `DVDTransferManager.sol:327-338`, `ApproveTransfer.sol:127`, `TREXGateway.sol:351` and `block-timestamp` in the time-limit modules — lint findings only, not compile errors; `--deny warnings` will fail the lint stage.

---

## 3. Architecture — contract inventory (`contracts/`)

### 3.1 Token

| File | Role |
|---|---|
| `token/IToken.sol` | `interface IToken is IERC20` — ERC-3643 token interface, events (`:84-149`) and functions (`:159-459`). |
| `token/Token.sol` | `contract Token is IToken, AgentRoleUpgradeable, TokenStorage` (`:71`). ERC-20 with identity + compliance gating, pause, address freeze, partial freeze, forced transfer, mint/burn, recovery, batch ops. Initialised through `init(...)` (`:100-132`). |
| `token/TokenStorage.sol` | Storage layout for Token (`:68-98`): balances, allowances, totalSupply, name/symbol/decimals/onchainID, `_TOKEN_VERSION`, `_frozen`, `_frozenTokens`, `_tokenPaused`, `_tokenIdentityRegistry`, `_tokenCompliance`, `uint256[49] __gap`. |

### 3.2 Registries

| File | Role |
|---|---|
| `registry/implementation/IdentityRegistry.sol` | `IdentityRegistry is IIdentityRegistry, AgentRoleUpgradeable, IRStorage` (`:76`). Maps wallet → ONCHAINID (through IRS), performs `isVerified` claim checks against CTR + TIR. Agents register/update/delete identities; owner swaps linked registries. |
| `registry/implementation/IdentityRegistryStorage.sol` | `IdentityRegistryStorage is IIdentityRegistryStorage, AgentRoleUpgradeable, IRSStorage` (`:71`). Shared wallet→(identity, country) storage, can be bound to up to 300 IRs (`:135`); each bound IR becomes an agent of the IRS (`:136`). |
| `registry/implementation/ClaimTopicsRegistry.sol` | `ClaimTopicsRegistry is IClaimTopicsRegistry, OwnableUpgradeable, CTRStorage` (`:69`). Owner-managed list of required claim topics, max 15 (`:80`). |
| `registry/implementation/TrustedIssuersRegistry.sol` | `TrustedIssuersRegistry is ITrustedIssuersRegistry, OwnableUpgradeable, TIRStorage` (`:72`). Owner-managed list of `IClaimIssuer` → allowed topics; max 50 issuers (`:86`), 1–15 topics per issuer (`:84-85`); reverse index topic → issuers (`TIRStorage.sol:76`). |
| `registry/interface/I*.sol` | Interfaces with events. |
| `registry/storage/IRStorage.sol`, `IRSStorage.sol`, `CTRStorage.sol`, `TIRStorage.sol` | Storage-layout contracts, each with `uint256[49] __gap`. |

### 3.3 Compliance

| File | Role |
|---|---|
| `compliance/modular/IModularCompliance.sol` | Interface: `bindToken/unbindToken/addModule/removeModule/callModuleFunction/transferred/created/destroyed/canTransfer/getModules/getTokenBound/isModuleBound` + events. |
| `compliance/modular/ModularCompliance.sol` | `ModularCompliance is IModularCompliance, OwnableUpgradeable, MCStorage` (`:72`). One token bound per compliance; up to 25 modules (`:116`); fan-out of hooks and checks to modules. |
| `compliance/modular/MCStorage.sol` | `_tokenBound`, `_modules[]`, `_moduleBound` mapping, `__gap` (`:66-81`). |
| `compliance/modular/modules/IModule.sol` | Module interface (§7.1). |
| `compliance/modular/modules/AbstractModule.sol` | Non-upgradeable base: binding bookkeeping + modifiers (§7.2). |
| `compliance/modular/modules/AbstractModuleUpgradeable.sol` | UUPS/Ownable/Initializable base with namespaced storage (§7.2). |
| `compliance/modular/modules/ModuleProxy.sol` | `ModuleProxy is ERC1967Proxy` (`:67-70`) — thin OZ ERC-1967 proxy for upgradeable modules. |
| `compliance/legacy/*` | v3-era non-modular compliance: `ICompliance.sol`, `BasicCompliance.sol` (abstract, `AgentRole`-based), `DefaultCompliance.sol` (`canTransfer` always `true`, `DefaultCompliance.sol:92-94`), feature mixins (`features/*.sol`) and their test harnesses (`test/*Test.sol`). Excluded from coverage (`.solcover.js:2-3`). The test fixture still uses `DefaultCompliance` as the token's initial compliance (`test/fixtures/deploy-full-suite.fixture.ts:79`). It implements `bindToken/unbindToken/transferred/created/destroyed/canTransfer`, so the Token can point at it, but it is not `IModularCompliance` (no modules). |

#### 3.3.1 Modules (`contracts/compliance/modular/modules/`) — one line each (all `AbstractModuleUpgradeable`, all CC-BY-NC-tagged)

| Module | `isPlugAndPlay` | What it does |
|---|---|---|
| `CountryAllowModule.sol` | true (`:213-215`) | Allow-list of ISO-3166 numeric country codes per compliance; `moduleCheck` passes iff receiver's `investorCountry` is allowed (`:193-201`). |
| `CountryRestrictModule.sol` | true (`:214-216`) | Deny-list of countries per compliance; `moduleCheck` fails if receiver's country is restricted (`:191-202`). |
| `MaxBalanceModule.sol` | **false** (`:280-282`) | Cap on tokens held **per ONCHAINID** (not per wallet) per compliance; tracks `_IDBalance[compliance][identity]` in transfer/mint/burn actions (`:202-227`); `moduleCheck` rejects if `_value > max` or `idBalance(to)+_value > max` (`:235-249`). Needs pre-set of balances if bound to a token with supply (`canComplianceBind` `:263-275`). |
| `SupplyLimitModule.sol` | true (`:161-163`) | Max total supply per compliance; only acts on mints (`_from == address(0)`), rejects if `totalSupply + _value > limit` (`:130-141`). |
| `TimeTransfersLimitsModule.sol` | true (`:224-226`) | Up to 4 rolling-window limits (`limitTime`, `limitValue`) per compliance (`:233-247`); counters per sender **identity** per window (`:100`); agents and mints bypass (`:181-187`). |
| `TimeExchangeLimitsModule.sol` | true (`:295-297`) | Same windows but only for transfers **to** ONCHAINIDs tagged as exchanges (`_exchangeIDs`, module-owner managed `:175-197`); counters per (compliance, exchangeID, investorID, window). |
| `ExchangeMonthlyLimitsModule.sol` | true (`:242-244`) | Fixed 30-day limit per (compliance, exchangeID) for investor→exchange transfers (`:196-230`, `:319`). |
| `TransferRestrictModule.sol` | true (`:212-214`) | Per-compliance allow-list of wallets; transfer passes if `_from` **or** `_to` is allowed; mint/burn (`address(0)`) always pass (`:175-190`). |
| `ConditionalTransferModule.sol` | true (`:203-205`) | Pre-approval of exact transfers `(from,to,amount,token)` hashed (`:271-279`); approvals are consumed on transfer (`:153-163`); `moduleCheck` passes only if approved (`:183-191`). **No special case for `_from == address(0)` → mints need an approval for `(address(0), to, amount)`.** |
| `TransferFeesModule.sol` | **false** (`:196-198`) | Takes a bps fee on transfers by calling `token.forcedTransfer(_to, collector, fee)` from `moduleTransferAction` (`:133-154`) — therefore the module contract must be a **token agent** (`canComplianceBind` `:188-191`); `moduleCheck` always true (`:172-174`). |
| `TokenListingRestrictionsModule.sol` | true (`:295-297`) | Investor-side opt-in/opt-out: token configured as WHITELISTING or BLACKLISTING (`:160-172`); investors call `listToken/unlistToken` for their wallet or ONCHAINID (`:309-338`); `moduleCheck` consults receiver's listing (`:230-254`). State keyed by **token address**, not compliance. |

### 3.4 Proxies and implementation authority

| File | Role |
|---|---|
| `proxy/interface/IProxy.sol` | `setImplementationAuthority(address)`, `getImplementationAuthority()`, event `ImplementationAuthoritySet` (`:65-76`). |
| `proxy/AbstractProxy.sol` | Stores the IA address in slot `0x821f3e4d…aafc` = `keccak256("ERC-3643.proxy.beacon")` (`:102-109`); `setImplementationAuthority` callable only by the **current IA** and validates the new IA has all 6 implementations (`:74-87`). |
| `proxy/TokenProxy.sol` | Constructor validates args, stores IA, fetches `getTokenImplementation()` and `delegatecall`s `init(address,address,string,string,uint8,address)` (`:69-107`); fallback delegates to whatever the IA currently returns (`:110-127`). |
| `proxy/IdentityRegistryProxy.sol` | Same pattern; `delegatecall init(address,address,address)` (`:69-94`). |
| `proxy/IdentityRegistryStorageProxy.sol`, `ClaimTopicsRegistryProxy.sol`, `TrustedIssuersRegistryProxy.sol`, `ModularComplianceProxy.sol` | Same pattern; `delegatecall init()` (each `:69-79`). |
| `proxy/authority/ITREXImplementationAuthority.sol` | `struct TREXContracts {token,ctr,ir,irs,tir,mc}` (`:69-82`), `struct Version {uint8 major,minor,patch}` (`:84-91`), events (`:96-114`), functions. |
| `proxy/authority/TREXImplementationAuthority.sol` | `Ownable`; registry of versions → implementation sets; `useTREXVersion` flips all proxies; reference/auxiliary semantics; `changeImplementationAuthority` migrates a token's proxies to another IA (§9). |
| `proxy/authority/IIAFactory.sol`, `IAFactory.sol` | Factory that deploys *auxiliary* IAs for a token (`deployIA`, `IAFactory.sol:86-97`), callable only by the reference IA; new IA fetches the current version from the reference and ownership goes to the token owner (`:93`). |

### 3.5 Factory and gateway

| File | Role |
|---|---|
| `factory/ITREXFactory.sol` | `struct TokenDetails` (`:68-93`), `struct ClaimDetails` (`:95-102`), events (`:107-117`), `deployTREXSuite`, `recoverContractOwnership`, getters/setters. |
| `factory/TREXFactory.sol` | `TREXFactory is ITREXFactory, Ownable` (`:82`). CREATE2-deploys the 6 proxies with a string salt and wires them in one tx (`:103-177`). Constructor needs IA + ONCHAINID `IdFactory` (`:94-97`). |
| `factory/ITREXGateway.sol`, `factory/TREXGateway.sol` | `TREXGateway is ITREXGateway, AgentRole` (`:106`). Public/whitelisted front-end to the factory with optional ERC-20 deployment fee and discounts; computes salt = `hex(owner) ‖ name` (`:358`); must be made owner of the factory (`transferFactoryOwnership`, `:163-165`). |

### 3.6 Roles

| File | Role |
|---|---|
| `roles/Roles.sol` | Library `Roles.Role {mapping bearer}` with `add/remove/has`; `has` reverts on zero address (`:95-98`). |
| `roles/AgentRole.sol` | `AgentRole is Ownable` (non-upgradeable); `addAgent/removeAgent` `onlyOwner`, `isAgent`, `onlyAgent` modifier, events `AgentAdded/AgentRemoved` (`:70-98`). Used by `TREXGateway` and as the casting type for `isAgent` lookups in modules/DVD/DVA. |
| `roles/AgentRoleUpgradeable.sol` | Same with `OwnableUpgradeable` (`:70-98`). Inherited by `Token`, `IdentityRegistry`, `IdentityRegistryStorage`. |
| `roles/permissioning/agent/AgentRoles.sol` | Sub-roles for agents (SupplyModifier, Freezer, TransferManager, RecoveryAgent, ComplianceAgent, WhiteListManager, AgentAdmin) managed by `onlyAdmin` (`:99-209`). |
| `roles/permissioning/agent/AgentManager.sol` | `AgentManager is AgentRoles` bound to one token (`:72-78`). Each `call*` function requires the caller's ONCHAINID to hold the sub-role **and** `msg.sender` to be an ACTION key (purpose 2) on that ONCHAINID (e.g. `:94-99`), then forwards to the Token / IR. The AgentManager contract itself must be an agent on Token and IR. |
| `roles/permissioning/agent/AgentRolesUpgradeable.sol` | Upgradeable variant; **not used by any contract in `contracts/`**. |
| `roles/permissioning/owner/OwnerRoles.sol`, `OwnerManager.sol`, `OwnerRolesUpgradeable.sol` | Same pattern for owner-level actions (set registries/compliance, manage TIR/CTR, transfer ownership, add agents) — `OwnerManager` must be the *owner* of the target contracts (`OwnerManager.sol:104-427`). `OwnerRolesUpgradeable` unused. |

### 3.7 DVA / DVD transfer managers (present)

| File | Role |
|---|---|
| `DVA/IDVATransferManager.sol`, `DVA/DVATransferManager.sol` | **Delivery-vs-Approval** escrow. A token agent sets approval criteria (`setApprovalCriteria`, `:87-126`); the DVA contract itself must be `isVerified` on the token's IR (`:98-100`), i.e. you must register the DVA address as an identity holder. `initiateTransfer` pulls tokens with `transferFrom` into the DVA (`:142`); approvers approve on-chain or via `ecrecover` signatures (`delegateApproveTransfer`, `:184-205`); completion/cancel/reject moves tokens with `token.transfer` (`:415-416`). |
| `DVD/DVDTransferManager.sol` | **Delivery-vs-Delivery** atomic swap of two ERC-20/T-REX tokens with per-parity fees; `Ownable`; detects T-REX tokens by `try identityRegistry()` (`:381-391`); T-REX agents can take/cancel (`:316-317`, `:364-365`). |

### 3.8 Test-only (`contracts/_testContracts/`)

`OIDImports.sol` (pulls `ClaimIssuer`, `Identity`, `ImplementationAuthority` from ONCHAINID into the Hardhat build), `MockContract.sol`, `ClaimIssuerTrick.sol` (an `isClaimValid` that reverts), `TestERC20.sol`, `TestUpgradedCountryAllowModule.sol` (UUPS upgrade test), `v_3_5_2/*` (legacy proxy/IA/token for migration tests).

---

## 4. Deployment sequences

### 4.1 Init / constructor signatures (exact)

```solidity
// implementations (all `external initializer`)
Token.init(address _identityRegistry, address _compliance, string _name, string _symbol, uint8 _decimals, address _onchainID)   // Token.sol:100-108
IdentityRegistry.init(address _trustedIssuersRegistry, address _claimTopicsRegistry, address _identityStorage)                 // IdentityRegistry.sol:87-91
IdentityRegistryStorage.init()   // IdentityRegistryStorage.sol:73-75
ClaimTopicsRegistry.init()       // ClaimTopicsRegistry.sol:71-73
TrustedIssuersRegistry.init()    // TrustedIssuersRegistry.sol:74-76
ModularCompliance.init()         // ModularCompliance.sol:84-86

// proxies (constructor delegatecalls the matching init)
new TokenProxy(address implementationAuthority, address _identityRegistry, address _compliance, string _name, string _symbol, uint8 _decimals, address _onchainID) // TokenProxy.sol:69-78
new IdentityRegistryProxy(address implementationAuthority, address _trustedIssuersRegistry, address _claimTopicsRegistry, address _identityStorage)                // IdentityRegistryProxy.sol:69-74
new IdentityRegistryStorageProxy(address implementationAuthority)   // :69
new ClaimTopicsRegistryProxy(address implementationAuthority)       // :69
new TrustedIssuersRegistryProxy(address implementationAuthority)    // :70
new ModularComplianceProxy(address implementationAuthority)         // :69

// authority / factory
new TREXImplementationAuthority(bool referenceStatus, address trexFactory, address iaFactory)   // TREXImplementationAuthority.sol:104
addAndUseTREXVersion(Version{major,minor,patch}, TREXContracts{tokenImplementation, ctrImplementation, irImplementation, irsImplementation, tirImplementation, mcImplementation}) // :139-142
new TREXFactory(address implementationAuthority_, address idFactory_)   // TREXFactory.sol:94
new IAFactory(address trexFactory)                                      // IAFactory.sol:79
new TREXGateway(address factory, bool publicDeploymentStatus)           // TREXGateway.sol:128

// wiring
IdentityRegistryStorage.bindIdentityRegistry(address _identityRegistry)  // IdentityRegistryStorage.sol:133 (owner-only via internal addAgent)
ModularCompliance.bindToken(address _token)                             // ModularCompliance.sol:91 (owner, or the token itself if nothing bound yet)
AgentRoleUpgradeable.addAgent(address)                                  // AgentRoleUpgradeable.sol:83 (onlyOwner)
```

Init-time validations worth knowing: `Token.init` requires `owner()==0` (legacy-proxy guard, `Token.sol:113`), non-zero IR and compliance (`:114-117`), non-empty name/symbol (`:118-121`), `decimals <= 18` (`:122`), **sets `_tokenPaused = true`** (`:128`), and calls `setCompliance` which calls `compliance.bindToken(address(this))` (`:130`, `:515-522`). `IdentityRegistry.init` requires all three addresses non-zero (`:92-96`). `TokenProxy` repeats the arg checks in its constructor (`TokenProxy.sol:79-88`).

`ModularCompliance.bindToken` (`:91-97`) accepts the call either from the compliance **owner** or from the **token itself when `_tokenBound == address(0)`**. So a fresh compliance can be bound simply by passing it to `Token.init`; a compliance already bound to another token makes `Token.init` revert with "only owner or token can call". `unbindToken` (`:102-108`) is symmetric.

### 4.2 Manual deployment WITHOUT `TREXFactory` (mirrors `test/fixtures/deploy-full-suite.fixture.ts:15-237`)

Actor: `deployer` (becomes owner of everything; `__Ownable_init` sets `msg.sender`, which under a proxy constructor's `delegatecall` is the account deploying the proxy).

1. **Deploy the six T-REX implementations** (plain `new`, no constructor args): `ClaimTopicsRegistry`, `TrustedIssuersRegistry`, `IdentityRegistryStorage`, `IdentityRegistry`, `ModularCompliance`, `Token` (fixture `:22-27`). They are never initialised and never used directly (optional hardening: call `init()`/`init(...)` on each bare implementation so nobody else can; there is no `_disableInitializers()` in constructors).
2. **(ONCHAINID) Deploy identity infra** (fixture `:28-42`), using `@onchain-id/solidity` artefacts: `Identity(deployer, true)` (library mode, `oid:contracts/Identity.sol:49-57`) → `ImplementationAuthority(identityImpl)` (`oid:contracts/proxy/ImplementationAuthority.sol`) → `IdFactory(identityIA)` (`oid:contracts/factory/IdFactory.sol:34`). Only needed if you want token/investor ONCHAINIDs created by the factory pattern; see §5.5.
3. **Deploy `TREXImplementationAuthority(true, address(0), address(0))`** (reference IA, no factory yet; fixture `:44-48`) and register the version: `addAndUseTREXVersion({4,0,0}, {token, ctr, ir, irs, tir, mc})` (fixture `:49-62`; `TREXImplementationAuthority.sol:139-142`, `:282-311`). All six addresses must be non-zero (`:287-294`).
4. **Deploy the registry proxies**: `new ClaimTopicsRegistryProxy(ia)`, `new TrustedIssuersRegistryProxy(ia)`, `new IdentityRegistryStorageProxy(ia)` (fixture `:67-77`). Each constructor `delegatecall`s `init()` so the deployer is the owner.
5. **Deploy compliance**: `new ModularComplianceProxy(ia)` (fixture `deploySuiteWithModularCompliancesFixture` `:242-243`). (The fixture's base suite uses the legacy `DefaultCompliance` instead, `:79`.) A `ModularCompliance` can also be deployed **without** a proxy — `new ModularCompliance(); mc.init();` (fixture `:245-246`) — but then it is not upgradeable through the IA.
6. **Deploy `IdentityRegistryProxy(ia, tir, ctr, irs)`** (fixture `:81-88`).
7. **Deploy `TokenProxy(ia, ir, mc, name, symbol, decimals, tokenOnchainID_or_0)`** (fixture `:93-107`). `_onchainID` may be `address(0)` and set later with `setOnchainID` (`Token.sol:106`, `:180-183`). The token is now **paused**.
8. **Wire IRS ↔ IR**: `irs.bindIdentityRegistry(ir)` as IRS owner (fixture `:111`; `IdentityRegistryStorage.sol:133-139` — makes the IR an agent of the IRS so `registerIdentity` can write through). Test confirms non-owner reverts (`test/registries/identity-registry-storage.test.ts:243-245`).
9. **Agents**: `token.addAgent(tokenAgent)` (fixture `:113`); `ir.addAgent(tokenAgent)` and **`ir.addAgent(address(token))`** (fixture `:132-133`) — the latter is required for `Token.recoveryAddress`, which calls `registerIdentity`/`deleteIdentity` on the IR (`Token.sol:308-317`).
10. **Claim topics & trusted issuers** (optional): `ctr.addClaimTopic(topic)` (fixture `:116`); deploy a `ClaimIssuer(managementKey)` and add a CLAIM key (purpose 3) for the signing key (fixture `:118-121`); `tir.addTrustedIssuer(claimIssuer, [topics])` (fixture `:123`). Skip both to run with **no claim requirements** (see §5.2).
11. **Modules**: `mc.addModule(module)` (owner), then configure through `mc.callModuleFunction(abi.encodeWithSelector(...), module)` (§7.4).
12. **Register investors**: `ir.registerIdentity(wallet, IIdentity(identity), country)` by an IR agent (fixture `:135-137`), add claims to their identities if topics are required (fixture `:139-177`).
13. **Mint and unpause**: `token.mint(wallet, amount)` by a token agent (works while paused — `mint` has no `whenNotPaused`, `Token.sol:454`), then `token.unpause()` by an agent (fixture `:179-180`, `:186`).
14. **Ownership hand-off** (not in fixture): `transferOwnership(...)` on Token, IR, IRS, CTR, TIR, MC, and the IA (§9.4).

### 4.3 Deployment WITH `TREXFactory`

Pre-requisites (fixture `:44-65`):

1. Implementations + reference IA + `addAndUseTREXVersion` as in 4.2 steps 1–3. `TREXFactory`'s constructor calls `setImplementationAuthority`, which requires all six getters non-zero (`TREXFactory.sol:210-223`), so the IA must already have a version in use.
2. ONCHAINID `IdFactory` must exist (constructor requires non-zero `idFactory_`, `:228-232`).
3. `new TREXFactory(ia, idFactory)` (`:94-97`), then **`idFactory.addTokenFactory(trexFactory)`** (fixture `:65`; `oid:contracts/factory/IdFactory.sol:42-50`) so the factory may call `createTokenIdentity` (`:128` requires token-factory or owner).
4. Optionally `ia.setTREXFactory(trexFactory)` (`TREXImplementationAuthority.sol:115-122`; requires the factory's IA to be this IA) and `new IAFactory(trexFactory)` + `ia.setIAFactory(iaFactory)` (`:127-134`) if you want `changeImplementationAuthority` to be able to spin off per-token IAs.

Signature (`TREXFactory.sol:103-105`, interface `ITREXFactory.sol:164-167`), **`onlyOwner`**:

```solidity
function deployTREXSuite(string memory _salt, TokenDetails calldata _tokenDetails, ClaimDetails calldata _claimDetails) external onlyOwner;

struct TokenDetails {            // ITREXFactory.sol:68-93
    address owner;               // becomes owner of token, IR, TIR, CTR, MC
    string name;
    string symbol;
    uint8 decimals;              // 0..18
    address irs;                 // address(0) => deploy a new IRS; else reuse (factory must OWN it to bind)
    address ONCHAINID;           // address(0) => IdFactory.createTokenIdentity(token, owner, salt)
    address[] irAgents;          // <=5, added as IR agents
    address[] tokenAgents;       // <=5, added as Token agents
    address[] complianceModules; // <=30, bound in order
    bytes[] complianceSettings;  // callModuleFunction(settings[i], modules[i]) for i < settings.length
}
struct ClaimDetails {            // ITREXFactory.sol:95-102
    uint256[] claimTopics;       // <=5 required topics
    address[] issuers;           // <=5 trusted issuers (IClaimIssuer)
    uint256[][] issuerClaims;    // topics allowed per issuer (same index as issuers)
}
```

What `deployTREXSuite` does, in order (`TREXFactory.sol:106-176`): validates limits (`:106-119`); CREATE2-deploys TIR, CTR, MC (`:121-123`), IRS if `irs == 0` (`:124-130`), IR (`:131-132`), Token (`:133-143`) — all with `salt = keccak256(abi.encodePacked(_salt))` (`:237`) and the respective proxy creation code; if `ONCHAINID == 0` creates a token identity via the IdFactory and `setOnchainID` (`:144-147`); adds claim topics (`:148-150`) and trusted issuers (`:151-153`); `irs.bindIdentityRegistry(ir)` (`:154`); `ir.addAgent(token)` (`:155`), IR agents (`:156-158`), token agents (`:159-161`); for each module `addModule` if not bound, then `callModuleFunction(settings[i])` if `i < settings.length` (`:162-169`); records `tokenDeployed[_salt]` (`:170`); transfers ownership of **token, IR, TIR, CTR, MC** to `_tokenDetails.owner` (`:171-175`) — **the newly deployed IRS stays owned by the factory**; use `recoverContractOwnership(irs, newOwner)` (`:182-184`, documented at `ITREXFactory.sol:169-176`). Emits `TREXSuiteDeployed(token, ir, irs, tir, ctr, mc, salt)` (`:176`). The token is left **paused**; a token agent must `unpause()`.

Example call (from `test/factory.test.ts:299-322`): modules deployed beforehand (here a bare `CountryAllowModule` without proxy), `complianceSettings[0] = abi.encodeWithSignature("batchAllowCountries(uint16[])", [42,66])`.

Addresses are deterministic per (factory address, salt) — "The address can be the same on all EVM blockchains as long as the factory address is the same" (`ITREXFactory.sol:153-154`). `TREXGateway.deployTREXSuite(TokenDetails, ClaimDetails)` (`TREXGateway.sol:339-361`) derives the salt itself (`Strings.toHexString(owner) ‖ name`, `:358`) and enforces deployer whitelist / fees; it must be the factory's owner.

---

## 5. Identity verification

### 5.1 `IdentityRegistry.isVerified(address)` — code walk (`IdentityRegistry.sol:173-223`)

```
173 function isVerified(address _userAddress) external view returns (bool) {
174   if (address(identity(_userAddress)) == address(0)) return false;     // not registered → false
175   uint256[] memory requiredClaimTopics = _tokenTopicsRegistry.getClaimTopics();
176   if (requiredClaimTopics.length == 0) return true;                     // NO TOPICS → TRUE for any registered identity
186   for each required topic:
187-188   trustedIssuers = _tokenIssuersRegistry.getTrustedIssuersForClaimTopic(topic);
190     if (trustedIssuers.length == 0) return false;                       // topic required but nobody trusted → false
192-195   claimIds[i] = keccak256(abi.encode(trustedIssuers[i], topic));    // ERC-735 claimId convention
197     for each claimId j:
198       (foundClaimTopic, scheme, issuer, sig, data, ) = identity(_userAddress).getClaim(claimIds[j]);   // NO try/catch
200       if (foundClaimTopic == topic) {
201-202     try IClaimIssuer(issuer).isClaimValid(identity, topic, sig, data) returns (bool v) {
204-208       if (v) j = claimIds.length;                                    // valid → stop scanning this topic
209-211       if (!v && j == last) return false;                             // last candidate invalid → false
212-216     } catch { if (j == last) return false; }                        // issuer reverted on last candidate → false
217-219   } else if (j == last) return false;                                // no claim stored for last candidate → false
222   return true;                                                           // every topic satisfied
```

Semantics: **for every required topic, at least one trusted issuer for that topic must have a valid claim on the identity.** The `issuer` passed to `isClaimValid` is the one **stored in the identity's claim** (line 198), not the registry entry; a real ONCHAINID stores the claim under `keccak256(abi.encode(_issuer, _topic))` (`oid:contracts/Identity.sol:360`), so they coincide — but a malicious/custom identity contract can return any `issuer`, i.e. the registry trusts the identity contract. Line 198 has no `try/catch`: an identity whose `getClaim` reverts (or an EOA) makes `isVerified` **revert** instead of returning false — but only when topics are required.

Tests confirming: no topics ⇒ true (`test/registries/identity-registry.test.ts:185-201`); topics but no trusted issuer ⇒ false (`:204-218`); revoked claim ⇒ false (`:221-238`); issuer revert on last candidate ⇒ false (`:263-277`).

### 5.2 With NO required claim topics

Yes — `isVerified` returns `true` for **any address with a non-zero entry in the IRS** (`:174-177`). Combined with §5.3 this means "registered in the IR" is the only gate. This is the simplest permissioning model: run an empty `ClaimTopicsRegistry` and have an IR agent whitelist wallets with `registerIdentity`.

### 5.3 What `registerIdentity` requires (`IdentityRegistry.sol:266-273` → `IdentityRegistryStorage.sol:80-93`)

- Caller must be an **agent of the IdentityRegistry** (`onlyAgent`, `:270`).
- The IR must itself be an agent of the IRS (achieved by `bindIdentityRegistry`, `IdentityRegistryStorage.sol:136`).
- `_userAddress != 0 && address(_identity) != 0` (`IdentityRegistryStorage.sol:85-88`).
- Wallet not already stored (`:89`, "address stored already").
- **No other checks**: no `extcodesize`, no ERC-165/`IIdentity` probe, no proof that the wallet is a key on the identity, no country validation (`uint16`, any value). `updateIdentity`/`updateCountry`/`deleteIdentity` are likewise `onlyAgent` with only non-zero/stored checks (`IdentityRegistry.sol:122-143`, `IdentityRegistryStorage.sol:98-128`).

### 5.4 Minimal/dummy identity vs real ONCHAINID

| Scenario | Works? |
|---|---|
| Register wallet with **any non-zero address** (even an EOA or the wallet itself) as identity, **no claim topics** | Yes: `isVerified` is true; `transfer/mint` work. Modules that key state by identity (MaxBalance, TimeTransfersLimits, Exchange*, TokenListing by OID) just use the address as a key. |
| Same, **with claim topics** | No: `getClaim` is called on the identity (`:198`) — an EOA/contract without `getClaim(bytes32)` reverts and `isVerified` reverts. A dummy that implements `getClaim` returning the right topic and an `issuer` whose `isClaimValid` returns true would pass — the IR trusts the identity contract (see 5.1). |
| `Token.recoveryAddress` | Requires `IIdentity(_investorOnchainID).keyHasPurpose(keccak256(abi.encode(_newWallet)), 1)` (`Token.sol:303-305`) — needs a real ERC-734 key holder. |
| `AgentManager`/`OwnerManager` | Require `keyHasPurpose(..., 2)` on the caller's ONCHAINID — real ERC-734 needed. |
| `MaxBalanceModule._getIdentity` | `require(identity != 0, "identity not found")` (`:313`) — any address works as long as the wallet is registered. |

Conclusion: a wallet **can** be registered with a minimal/dummy identity (or no contract at all) and will be "verified" as long as the CTR is empty. A real ONCHAINID `Identity` is required for claim-based verification, recovery, and the role-manager contracts. The IR agent is the trust anchor.

### 5.5 Deploying an ONCHAINID Identity (`@onchain-id/solidity@2.2.1`)

- `Identity(address initialManagementKey, bool _isLibrary)` (`oid:contracts/Identity.sol:49-57`): `_isLibrary = false` → a standalone, fully initialised identity with `initialManagementKey` as MANAGEMENT key (purpose 1); `_isLibrary = true` → implementation for proxies (`_canInteract` false, every `delegatedOnly` function reverts on the implementation itself, `:20-23`). `initialize(address initialManagementKey)` (`:64-67`) is the proxy initializer (guarded by `_initialized`, `:575`).
- `ImplementationAuthority(address implementation)` (`oid:contracts/proxy/ImplementationAuthority.sol`), `Ownable`, `updateImplementation` `onlyOwner`, `getImplementation()`.
- `IdentityProxy(address _implementationAuthority, address initialManagementKey)` (`oid:contracts/proxy/IdentityProxy.sol`): stores the IA in the same `0x821f3e4d…aafc` slot and `delegatecall`s `initialize(address)`; fallback looks up the implementation per call (beacon-like, same pattern as T-REX).
- `IdFactory(address implementationAuthority)` (`oid:contracts/factory/IdFactory.sol:34`), `Ownable`:
  - `createIdentity(address _wallet, string _salt)` **`onlyOwner`** (`:62-77`): CREATE2 `IdentityProxy` with salt `"OID"+_salt`, wallet as management key, records wallet→identity.
  - `createIdentityWithManagementKeys(address _wallet, string _salt, bytes32[] _managementKeys)` `onlyOwner` (`:82-118`): identity whose management keys are the given key hashes (wallet itself must not be listed).
  - `createTokenIdentity(address _token, address _tokenOwner, string _salt)` (`:123-141`): callable by registered token factories or owner; salt `"Token"+_salt`; used by `TREXFactory` (`TREXFactory.sol:145`).
  - `linkWallet/unlinkWallet` (`:146-180`, called by the wallet), `getIdentity(wallet)`, `getWallets(identity)`, `getToken(identity)`, `isSaltTaken`, `addTokenFactory/removeTokenFactory` `onlyOwner` (`:42-57`).
- `ClaimIssuer(address initialManagementKey)` is an `Identity` (`oid:contracts/ClaimIssuer.sol`). `isClaimValid(identity, topic, sig, data)` recovers the signer of `toEthSignedMessageHash(keccak256(abi.encode(identity, topic, data)))` and requires that key to have purpose 3 (CLAIM) on the issuer and not be revoked (`revokeClaimBySignature`, `revokeClaim`). The fixture signs claims exactly this way (`test/fixtures/deploy-full-suite.fixture.ts:139-153`).
- Adding a claim: `Identity.addClaim(topic, scheme, issuer, signature, data, uri)` (`oid:contracts/Identity.sol:342-377`), `onlyClaimKey` (purpose 3 — but `keyHasPurpose` returns true for MANAGEMENT keys for any purpose, `:477-493`), verifies `IClaimIssuer(issuer).isClaimValid(...)` unless self-issued (`:356-358`), stores under `claimId = keccak256(abi.encode(_issuer, _topic))` (`:360`) — one claim per (issuer, topic).
- The Hardhat fixture shows the whole flow in JS: `deployIdentityProxy(identityIA, managementKey, signer)` (`test/fixtures/deploy-full-suite.fixture.ts:6-13`) and the `Identity(deployer, true)` / `ImplementationAuthority` / `Factory` deployments (`:28-42`).
- `node_modules/@onchain-id` does **not** exist in the clone (checked). The package ships `contracts/`, `artifacts/`, `typechain-types/`, `index.js` (`oid:package.json:5-11`), so for Foundry you can remap `@onchain-id/solidity/=node_modules/@onchain-id/solidity/` and import `contracts/Identity.sol`, `contracts/proxy/IdentityProxy.sol`, `contracts/proxy/ImplementationAuthority.sol`, `contracts/factory/IdFactory.sol`, `contracts/ClaimIssuer.sol` (all pinned `0.8.17`).

---

## 6. Token behaviour (`contracts/token/Token.sol`)

### 6.1 `transfer` (`:417-426`) — order of checks

1. `whenNotPaused` modifier (`:76-79`, `:417`) — "Pausable: paused".
2. `require(!_frozen[_to] && !_frozen[msg.sender], "wallet is frozen")` (`:418`).
3. `require(_amount <= balanceOf(msg.sender) - _frozenTokens[msg.sender], "Insufficient Balance")` (`:419`) — spendable = balance − partially frozen.
4. `if (_tokenIdentityRegistry.isVerified(_to) && _tokenCompliance.canTransfer(msg.sender, _to, _amount))` (`:420`) — short-circuit, so `canTransfer` is **not** called for unverified recipients. Note: **sender is not checked for verification**, only the recipient.
5. `_transfer(msg.sender, _to, _amount)` (`:421`) → `_beforeTokenTransfer` hook (empty virtual, `:594`), balance update, `Transfer` event (`:534-547`).
6. `_tokenCompliance.transferred(msg.sender, _to, _amount)` (`:422`) → `moduleTransferAction` on every module, **after** balances changed. Reverts in a module action revert the whole transfer.
7. Otherwise `revert("Transfer not possible")` (`:425`) — the same reason for "recipient unverified" and "compliance refused"; indexers/UX cannot distinguish them.

### 6.2 `transferFrom` (`:220-234`)

Same checks 1–4 with `_from` as sender (`:224-227`), then **allowance is decremented only after the checks pass**: `_approve(_from, msg.sender, _allowances[_from][msg.sender] - _amount)` (`:228`) — insufficient allowance surfaces as an arithmetic underflow panic (0x11), not a string; there is no "infinite allowance" shortcut. Then `_transfer` and `transferred` (`:229-230`). `approve/increaseAllowance/decreaseAllowance` are plain (`:137-156`).

### 6.3 `mint` (`:454-459`) — `onlyAgent`, **not** gated by pause

```
455 require(_tokenIdentityRegistry.isVerified(_to), "Identity is not verified.");
456 require(_tokenCompliance.canTransfer(address(0), _to, _amount), "Compliance not followed");
457 _mint(_to, _amount);                     // Transfer(0, to, amount)
458 _tokenCompliance.created(_to, _amount);  // moduleMintAction on every module (requires amount > 0)
```

So yes: mint calls `canTransfer(address(0), _to, _amount)` **before** supply changes, and `created` after. Test: `test/token/token-transfer.test.ts:389-402`.

### 6.4 `burn` (`:464-474`) — `onlyAgent`

No `isVerified`, no `canTransfer`. Requires `balance >= amount` (`:465`); if the amount exceeds the free balance it **unfreezes the difference** and emits `TokensUnfrozen` (`:466-471`); `_burn` (`:472`); `compliance.destroyed(_userAddress, _amount)` → `moduleBurnAction` (`:473`).

### 6.5 `forcedTransfer` (`:431-449`) — `onlyAgent`, not gated by pause or frozen flags

Requires `balance >= amount` (`:436`); unfreezes partially frozen tokens if needed (`:437-442`); requires **`isVerified(_to)`** (`:443`) but **does NOT call `canTransfer`** (test "when the transfer breaks compliance rules → should still transfer tokens", `test/token/token-transfer.test.ts:332-333`); then `_transfer` and `compliance.transferred(...)` (`:444-445`). Hence module *actions* still run — e.g. `MaxBalanceModule.moduleTransferAction` reverts if the cap is exceeded (`MaxBalanceModule.sol:207`), so a module can still block a forced transfer through its action hook.

### 6.6 Freezing

- `setAddressFrozen(address, bool)` `onlyAgent` (`:479-483`), emits `AddressFrozen(user, frozen, msg.sender)`. Frozen wallets cannot send or receive via `transfer/transferFrom` (`:418`, `:225`) but **can** be minted to, burned from, or forced-transferred.
- `freezePartialTokens(address, uint256)` `onlyAgent` (`:488-493`): requires `balance >= frozen + amount`; `unfreezePartialTokens` (`:498-502`). Frozen tokens reduce the spendable balance (`:419`, `:226`).
- `pause()/unpause()` `onlyAgent` (`:188-199`); only `transfer/transferFrom` are gated.

### 6.7 `recoveryAddress(lostWallet, newWallet, investorOnchainID)` (`:297-322`) — `onlyAgent`

Requires `balanceOf(lostWallet) != 0` (`:302`); requires `newWallet` to be a **MANAGEMENT key (purpose 1)** on `investorOnchainID` (`:303-305`); then `IR.registerIdentity(newWallet, onchainID, investorCountry(lostWallet))` (`:308-309`, needs the **Token to be an IR agent**, and `newWallet` must not already be registered), `forcedTransfer(lost → new, full balance)` (`:310`), re-applies partial freeze and address freeze (`:311-316`), `IR.deleteIdentity(lostWallet)` (`:317`), emits `RecoverySuccess` (`:318`); else reverts "Recovery not possible" (`:321`). The `RecoveryFails` event mentioned in `IToken.sol:294` **does not exist** (doc artefact).

### 6.8 Agent-only vs owner-only

- `onlyAgent`: `pause`, `unpause`, `forcedTransfer`, `batchForcedTransfer`, `mint`, `batchMint`, `burn`, `batchBurn`, `setAddressFrozen`, `batchSetAddressFrozen`, `freezePartialTokens`, `unfreezePartialTokens` (+batch), `recoveryAddress`.
- `onlyOwner`: `setName` (`:161`), `setSymbol` (`:170`), `setOnchainID` (`:180`), `setIdentityRegistry` (`:507`), `setCompliance` (`:515-522`, unbinds old compliance then binds new), `addAgent/removeAgent` (`AgentRoleUpgradeable.sol:83-93`), `transferOwnership` (OZ).
- Anyone: `transfer`, `transferFrom`, `approve`, `increase/decreaseAllowance`, `batchTransfer`, views.

### 6.9 Decimals

`uint8`, validated `0 <= _decimals && _decimals <= 18` in `Token.init` (`:122`) and `TokenProxy` (`:88`). **`decimals = 0` is allowed** and is in fact what the test fixture uses (`tokenDecimals = BigNumber.from('0')`, fixture `:92`). `decimals` is immutable after init (no setter; `UpdatedTokenInformation` re-emits the stored value).

### 6.10 Batch functions (`:204-292`)

`batchTransfer(to[], amounts[])` (anyone, loops `transfer`), `batchForcedTransfer`, `batchMint`, `batchBurn`, `batchSetAddressFrozen`, `batchFreezePartialTokens`, `batchUnfreezePartialTokens` (all loop the single-item public function, so the `onlyAgent` check runs per item; no length-equality checks — mismatched arrays revert with an index panic). Gas-limit warning in NatSpec (`IToken.sol:307-308`).

### 6.11 Other nuances

- Zero-amount `transfer`, `mint`, `burn` **revert** inside the compliance (`ModularCompliance.sol:155,167,179`: "invalid argument - no value transfer/mint/burn"); with the legacy `DefaultCompliance` they succeed.
- `_beforeTokenTransfer(from, to, amount)` is an empty `internal virtual` hook (`:594`) — the only extension point if you fork `Token`.
- `setCompliance` calls `unbindToken` on the old compliance (`:516-518`), which requires `msg.sender == token` or owner — fine since the token calls it.

---

## 7. Modular compliance and custom modules

### 7.1 `IModule` (`contracts/compliance/modular/modules/IModule.sol:65-173`)

```solidity
event ComplianceBound(address indexed _compliance);           // :73
event ComplianceUnbound(address indexed _compliance);         // :80
function bindCompliance(address _compliance) external;        // :93   only callable by _compliance itself
function unbindCompliance(address _compliance) external;      // :103
function moduleTransferAction(address _from, address _to, uint256 _value) external;   // :115  state update on transfer
function moduleMintAction(address _to, uint256 _value) external;                       // :126
function moduleBurnAction(address _from, uint256 _value) external;                     // :137
function moduleCheck(address _from, address _to, uint256 _value, address _compliance) external view returns (bool); // :149
function isComplianceBound(address _compliance) external view returns (bool);          // :155
function canComplianceBind(address _compliance) external view returns (bool);          // :161
function isPlugAndPlay() external pure returns (bool);                                 // :166
function name() external pure returns (string memory _name);                           // :172
```

### 7.2 Base contracts

**`AbstractModule`** (`AbstractModule.sol:67-116`, non-upgradeable): `mapping(address => bool) private _complianceBound` (`:70`); modifiers `onlyBoundCompliance(address _compliance)` (`:75-78`, checks the *parameter*) and `onlyComplianceCall()` (`:83-86`, checks `msg.sender` is a bound compliance); `bindCompliance` requires non-zero, not already bound, **`msg.sender == _compliance`** (`:91-97`); `unbindCompliance` is `onlyComplianceCall` + `msg.sender == _compliance` (`:102-107`); `isComplianceBound` (`:112-114`).

**`AbstractModuleUpgradeable`** (`AbstractModuleUpgradeable.sol:70-147`): `is IModule, Initializable, OwnableUpgradeable, UUPSUpgradeable`; the binding map lives in an ERC-7201-style namespaced struct at slot `0xf6cc97de1266c180cd39f3b311632644143ce7873d2927755382ad4b39e8ae00` = `keccak256(abi.encode(uint256(keccak256("ERC3643.storage.AbstractModule")) - 1)) & ~0xff` (`:71-78`, `:141-146`); same two modifiers (`:83-96`); same bind/unbind rules (`:101-119`); `__AbstractModule_init()` `onlyInitializing` calls `__Ownable_init()` (`:130-133`); `_authorizeUpgrade` is `onlyOwner` (`:139`). The **module owner** (set by `initialize`) controls UUPS upgrades and any `onlyOwner` module-global settings (e.g. `addExchangeID`); the **compliance owner** controls per-compliance settings via `callModuleFunction`. `onlyBoundCompliance` is defined but **not used** by any shipped module (removed from views in 4.0.1, `CHANGELOG.md:116`).

### 7.3 Writing a custom module (recipe)

```solidity
// SPDX-License-Identifier: GPL-3.0   (you inherit GPL code; see §1.5)
pragma solidity ^0.8.17;              // must intersect T-REX's 0.8.17 pin unless you vendor+patch

import "@tokenysolutions/t-rex/contracts/compliance/modular/modules/AbstractModuleUpgradeable.sol";
import "@tokenysolutions/t-rex/contracts/compliance/modular/IModularCompliance.sol";
import "@tokenysolutions/t-rex/contracts/token/IToken.sol";

contract WalletCapModule is AbstractModuleUpgradeable {
    mapping(address compliance => uint256) private _cap;           // state keyed by compliance address
    event CapSet(address indexed compliance, uint256 cap);

    function initialize() external initializer { __AbstractModule_init(); }   // call via ModuleProxy ctor data

    // per-compliance setter: compliance owner calls compliance.callModuleFunction(abi.encodeCall(this.setCap,(x)), module)
    function setCap(uint256 cap) external onlyComplianceCall { _cap[msg.sender] = cap; emit CapSet(msg.sender, cap); }

    function moduleTransferAction(address, address, uint256) external override onlyComplianceCall {}
    function moduleMintAction(address, uint256) external override onlyComplianceCall {}
    function moduleBurnAction(address, uint256) external override onlyComplianceCall {}

    // view only; called from ModularCompliance.canTransfer with _from == address(0) on mint
    function moduleCheck(address /*_from*/, address _to, uint256 _value, address _compliance) external view override returns (bool) {
        uint256 cap = _cap[_compliance];
        if (cap == 0) return true;
        IToken token = IToken(IModularCompliance(_compliance).getTokenBound());   // compliance -> token
        return token.balanceOf(_to) + _value <= cap;       // balances are pre-transfer at check time
    }
    function canComplianceBind(address) external pure override returns (bool) { return true; }
    function isPlugAndPlay() external pure override returns (bool) { return true; }
    function name() external pure override returns (string memory) { return "WalletCapModule"; }
}
```

Deploy: `impl = new WalletCapModule(); proxy = new ModuleProxy(address(impl), abi.encodeCall(WalletCapModule.initialize, ()));` (pattern in `test/compliances/module-max-balance.test.ts:10-12`). Modules can also be deployed bare without a proxy (`test/factory.test.ts:297`, fixture `:261-269`) — then `owner()` is zero and `onlyOwner`/upgrade functions are unusable, but compliance-gated functions work. **Deploy via proxy and initialise in the constructor data** to avoid someone else calling `initialize` on the bare implementation (no `_disableInitializers()` anywhere).

### 7.4 How modules are added and configured

- `ModularCompliance.addModule(address)` `onlyOwner` (`ModularCompliance.sol:113-126`): non-zero, not already bound, `_modules.length <= 24` (max 25), `if (!module.isPlugAndPlay()) require(module.canComplianceBind(address(this)))`, then `module.bindCompliance(address(this))` (so `msg.sender == compliance` in the module), push, emit `ModuleAdded`.
- `removeModule(address)` `onlyOwner` (`:131-145`): calls `module.unbindCompliance(address(this))`, swap-and-pop, emit `ModuleRemoved`.
- `callModuleFunction(bytes callData, address _module)` `onlyOwner` (`:189-219`): requires module bound; raw `call` with the calldata (assembly, bubbles reverts, discards return data); emits `ModuleInteraction(module, selector)`. The module sees `msg.sender == compliance`, which is what `onlyComplianceCall` setters key on. Example encoding: `abi.encodeWithSignature("setMaxBalance(uint256)", 100)` (test `module-max-balance.test.ts:98-101`). `TREXFactory` uses the same mechanism for `complianceSettings` (`TREXFactory.sol:167`).
- Pre-binding presets (modules with `isPlugAndPlay() == false`): `MaxBalanceModule.preSetModuleState/batchPreSetModuleState/presetCompleted` are callable by the **compliance owner** directly on the module *before* binding (`MaxBalanceModule.sol:141-196`); `TransferFeesModule` needs the module to be a token agent (`:188-191`).

### 7.5 How `moduleCheck` is invoked (`ModularCompliance.canTransfer`, `:245-253`)

```
245 function canTransfer(address _from, address _to, uint256 _value) external view returns (bool) {
247   for (i < _modules.length)
248     if (!IModule(_modules[i]).moduleCheck(_from, _to, _value, address(this))) return false;
252   return true;
```

- Iterates **all bound modules in insertion order, short-circuiting on the first `false`**; a module's `moduleCheck` that reverts makes `canTransfer` revert (and thus the token call).
- `view`: modules cannot write state or emit events in `moduleCheck` (`IModularCompliance.sol:198-199`).
- **Mint reaches modules** with `_from == address(0)` (`Token.sol:456`). **Burn never calls `canTransfer`** (`Token.sol:464-474`) — modules only see burns via `moduleBurnAction` (`destroyed`, `:177-184`). `forcedTransfer` never calls `canTransfer` (§6.5).
- Hooks: `transferred(from,to,value)` / `created(to,value)` / `destroyed(from,value)` are `onlyToken` (`msg.sender == _tokenBound`, `:79-82`), require non-zero addresses and `_value > 0` (`:150-184`), and loop `moduleTransferAction/moduleMintAction/moduleBurnAction` on **all** modules (no short-circuit; a revert aborts the token call).
- Modules that special-case the zero sender: `TimeTransfersLimitsModule.sol:181-183`, `TransferRestrictModule.sol:181-183` (also `_to==0`), `ExchangeMonthlyLimitsModule.sol:202`, `TimeExchangeLimitsModule.sol:232`, `SupplyLimitModule.sol:136` (uses it to detect mint), `TokenListingRestrictionsModule.sol:236` (`_to==0`). `MaxBalanceModule`, `CountryAllowModule`, `CountryRestrictModule` ignore `_from`. `ConditionalTransferModule` does **not** special-case it (mints need approvals).

### 7.6 Can modules read the compliance → token binding?

Yes. `IModularCompliance.getTokenBound()` (`ModularCompliance.sol:238-240`) is public. In `moduleCheck` use the `_compliance` parameter; in `onlyComplianceCall` functions use `msg.sender`. Every shipped module does `IToken(IModularCompliance(c).getTokenBound())` and then `.identityRegistry().identity(addr)` / `.investorCountry(addr)` (e.g. `MaxBalanceModule.sol:310-315`, `CountryAllowModule.sol:239-241`), `.totalSupply()` (`SupplyLimitModule.sol:137`), or `AgentRole(token).isAgent(addr)` (`TimeTransfersLimitsModule.sol:342-344`). A single module instance therefore serves any number of compliances/tokens.

### 7.7 Per-token state keyed by compliance address — how the shipped modules do it

| Module | State layout |
|---|---|
| `MaxBalanceModule` | `_maxBalance[compliance]`, `_IDBalance[compliance][onchainID]`, `_compliancePresetStatus[compliance]` (`:81-88`). Tracks balances **per identity** (sum over the identity's wallets); maintains its own ledger in the action hooks (`:202-227`) rather than reading `balanceOf`, hence the preset requirement. |
| `TimeTransfersLimitsModule` | `transferLimits[compliance] : Limit[] (≤4)`, `limitValues[compliance][limitTime]`, `usersCounters[compliance][identity][limitTime]` (`:94-100`); counters are per **sender identity**, reset when `timer <= block.timestamp` (`:307-313`). |
| `TransferRestrictModule` | `_allowedUserAddresses[compliance][wallet]` (`:75`) — per **wallet**. |
| `ConditionalTransferModule` | `_transfersApproved[compliance][keccak256(abi.encode(from,to,amount,token))] : uint` (`:81`, `:271-279`). |
| `ExchangeMonthlyLimitsModule` | `_exchangeMonthlyLimit[compliance][exchangeID]`, `_exchangeCounters[compliance][exchangeID][investorID]` (`:84-87`); **`_exchangeIDs[onchainID]` is global to the module and owner-managed** (`:90`, `:145-167`). |
| `TimeExchangeLimitsModule` | `_exchangeLimits[compliance][exchangeID] : Limit[] (≤4)`, `_limitValues[...]`, `_exchangeCounters[compliance][exchangeID][investorID][limitTime]` (`:94-104`); global `_exchangeIDs`. |
| `SupplyLimitModule` | `_supplyLimits[compliance]` (`:77`); reads `token.totalSupply()` live. |
| `CountryAllowModule` / `CountryRestrictModule` | `_allowedCountries[compliance][uint16]` / `_restrictedCountries[compliance][uint16]` (`:77`). |
| `TransferFeesModule` | `_fees[compliance] : Fee{rate bps, collector}` (`:78-84`). |
| `TokenListingRestrictionsModule` | keyed by **token**: `_tokenListingType[token]`, `_tokenInvestorListingStatus[token][walletOrOID]` (`:119-123`); investor functions are permissionless (`:309-338`). |

**Closest to a per-wallet cap:** none ships one — `MaxBalanceModule` is per-ONCHAINID and keeps its own ledger. A per-wallet cap is simplest as a new module reading `token.balanceOf(_to) + _value` in `moduleCheck` (pre-transfer balances), as in §7.3, with no action-hook ledger needed.

---

## 8. Events an indexer needs

### Token (`contracts/token/IToken.sol`, plus inherited)

| Event | Signature | Emitted by |
|---|---|---|
| `Transfer` | `(address indexed from, address indexed to, uint256 value)` (OZ `IERC20`) | `_transfer/_mint/_burn` (`Token.sol:546,559,572`); mint has `from = 0`, burn `to = 0`. |
| `Approval` | `(address indexed owner, address indexed spender, uint256 value)` | `_approve` (`:587`), also on every `transferFrom`. |
| `UpdatedTokenInformation` | `(string indexed _newName, string indexed _newSymbol, uint8 _newDecimals, string _newVersion, address indexed _newOnchainID)` (`IToken.sol:84-85`) — indexed strings are stored as keccak hashes | `init`, `setName`, `setSymbol`, `setOnchainID` (`:131,164,173,182`). |
| `IdentityRegistryAdded` | `(address indexed _identityRegistry)` (`:92`) | `init`/`setIdentityRegistry` (`:509`). |
| `ComplianceAdded` | `(address indexed _compliance)` (`:99`) | `init`/`setCompliance` (`:521`). |
| `RecoverySuccess` | `(address indexed _lostWallet, address indexed _newWallet, address indexed _investorOnchainID)` (`:108`) | `recoveryAddress` (`:318`). |
| `AddressFrozen` | `(address indexed _userAddress, bool indexed _isFrozen, address indexed _owner)` (`:119`) | `setAddressFrozen` (`:482`). |
| `TokensFrozen` / `TokensUnfrozen` | `(address indexed _userAddress, uint256 _amount)` (`:127,135`) | `freezePartialTokens` (`:492`), `unfreezePartialTokens` (`:501`), and implicit unfreezes in `forcedTransfer`/`burn` (`:441,470`). |
| `Paused` / `Unpaused` | `(address _userAddress)` (`:142,149`) — **not indexed** | `pause/unpause` (`:190,198`). |
| `AgentAdded` / `AgentRemoved` | `(address indexed _agent)` (`AgentRoleUpgradeable.sol:75-76`) | `addAgent/removeAgent`. |
| `OwnershipTransferred` | OZ `(address indexed previousOwner, address indexed newOwner)` | `__Ownable_init`, `transferOwnership`. |
| `Initialized(uint8)` | OZ `Initializable` | `init`. |
| `ImplementationAuthoritySet` | `(address indexed _implementationAuthority)` (`IProxy.sol:69`) | proxy constructor / `setImplementationAuthority` — emitted **from the proxy address**. |

### IdentityRegistry (`contracts/registry/interface/IIdentityRegistry.sol`)

| Event | Signature | Emitted by |
|---|---|---|
| `IdentityRegistered` | `(address indexed investorAddress, IIdentity indexed identity)` (`:100`) | `registerIdentity` (`IdentityRegistry.sol:272`), incl. during recovery. |
| `IdentityRemoved` | `(address indexed investorAddress, IIdentity indexed identity)` (`:108`) | `deleteIdentity` (`:142`). |
| `IdentityUpdated` | `(IIdentity indexed oldIdentity, IIdentity indexed newIdentity)` (`:116`) — **wallet not included** | `updateIdentity` (`:125`). |
| `CountryUpdated` | `(address indexed investorAddress, uint16 indexed country)` (`:124`) | `updateCountry` (`:133`). Note: the country given at `registerIdentity` is **not** emitted by the IR (only in the IRS event? no — `IdentityStored` has no country either); an indexer must read `investorCountry()` or decode calldata. |
| `ClaimTopicsRegistrySet` / `TrustedIssuersRegistrySet` / `IdentityStorageSet` | `(address indexed …)` (`:78,85,92`) | `init` and setters (`:100-102`, `:150,158,166`). |
| `AgentAdded/AgentRemoved`, `OwnershipTransferred`, `Initialized`, `ImplementationAuthoritySet` | as above | |

### Related (useful for a complete index)

- **IdentityRegistryStorage** (`IIdentityRegistryStorage.sol:77-115`): `IdentityStored(address indexed investorAddress, IIdentity indexed identity)`, `IdentityUnstored(...)`, `IdentityModified(IIdentity indexed old, IIdentity indexed new)`, `CountryModified(address indexed investorAddress, uint16 indexed country)`, `IdentityRegistryBound/Unbound(address indexed identityRegistry)`. Since an IRS may be shared by many IRs/tokens, index the IR events per token and the IRS events for the shared view.
- **ClaimTopicsRegistry** (`IClaimTopicsRegistry.sol:71,78`): `ClaimTopicAdded(uint256 indexed claimTopic)`, `ClaimTopicRemoved(uint256 indexed claimTopic)`.
- **TrustedIssuersRegistry** (`ITrustedIssuersRegistry.sol:75-90`): `TrustedIssuerAdded(IClaimIssuer indexed trustedIssuer, uint256[] claimTopics)`, `TrustedIssuerRemoved(IClaimIssuer indexed)`, `ClaimTopicsUpdated(IClaimIssuer indexed, uint256[] claimTopics)`.
- **ModularCompliance** (`IModularCompliance.sol:75-103`): `ModuleInteraction(address indexed target, bytes4 selector)`, `TokenBound(address _token)`, `TokenUnbound(address _token)` (not indexed), `ModuleAdded(address indexed _module)`, `ModuleRemoved(address indexed _module)`.
- **Modules** (`IModule.sol:73,80`): `ComplianceBound/ComplianceUnbound(address indexed _compliance)` + per-module config events (e.g. `MaxBalanceSet(address indexed _compliance, uint256 indexed _maxBalance)`, `MaxBalanceModule.sol:97`).
- **TREXFactory** (`ITREXFactory.sol:107-117`): `Deployed(address indexed _addr)` per proxy, `TREXSuiteDeployed(address indexed _token, address _ir, address _irs, address _tir, address _ctr, address _mc, string indexed _salt)` — the canonical "new token" signal; `ImplementationAuthoritySet`, `IdFactorySet`.
- **TREXImplementationAuthority** (`ITREXImplementationAuthority.sol:96-114`): `TREXVersionAdded(Version indexed, TREXContracts indexed)`, `TREXVersionFetched`, `VersionUpdated(Version indexed)` — the upgrade signal, `ImplementationAuthoritySet(bool, address)`, `TREXFactorySet`, `IAFactorySet`, `ImplementationAuthorityChanged(address indexed _token, address indexed _newIA)`.
- **ONCHAINID Identity** (`oid:contracts/interface/IERC735.sol:14-42`, `IERC734.sol:14-49`): `ClaimAdded/ClaimRemoved/ClaimChanged(bytes32 indexed claimId, uint256 indexed topic, uint256 scheme, address indexed issuer, bytes signature, bytes data, string uri)`, `KeyAdded/KeyRemoved`, `Executed/ExecutionRequested/Approved`; **ClaimIssuer** `ClaimRevoked(bytes indexed signature)` — needed to track verification status changes, which produce **no event on the IR**.

---

## 9. Upgradeability

### 9.1 Mechanism

- Each T-REX proxy stores only the IA address (slot `keccak256("ERC-3643.proxy.beacon")`, `AbstractProxy.sol:102-109`; changed in 4.1.3 from the ERC-1822 slot to avoid explorer confusion, `CHANGELOG.md:36-44`). On **every call** the fallback asks the IA for the current implementation (`TokenProxy.sol:111`, etc.) and `delegatecall`s with `sub(gas(), 10000)` (`:116`). This is a beacon pattern with one beacon for six contract kinds — **not ERC-1967/1822**; explorers' "read as proxy" will not auto-detect it.
- The IA keeps `mapping(bytes32 versionHash => TREXContracts)` and `_currentVersion` (`TREXImplementationAuthority.sol:77-80`). Switching `_currentVersion` upgrades **all** proxies that point at this IA atomically.
- Storage compatibility is the deployer's responsibility: implementations keep `uint256[49] __gap`s (`TokenStorage.sol:97`, `IRStorage.sol:84`, etc.).
- Modules (`AbstractModuleUpgradeable`) use standard OZ UUPS (`upgradeTo/upgradeToAndCall`, `_authorizeUpgrade` `onlyOwner`, `:139`) behind `ModuleProxy` (ERC-1967). Upgrade test: `TestUpgradedCountryAllowModule` (`contracts/_testContracts/TestUpgradedCountryAllowModule.sol`).

### 9.2 Who can upgrade

| Action | Who | Where |
|---|---|---|
| `addTREXVersion(version, contracts)` | **IA owner**, and only on a *reference* IA; version must not exist; all six non-zero | `TREXImplementationAuthority.sol:282-297` |
| `useTREXVersion(version)` | **IA owner**; version must exist and differ from current | `:302-311` |
| `addAndUseTREXVersion` | external wrapper calling both (owner check inside) | `:139-142` |
| `fetchVersion(version)` | anyone, only on an *auxiliary* IA; copies from the reference IA | `:147-155` |
| `setTREXFactory` / `setIAFactory` | IA owner, reference only; factory must reference this IA | `:115-134` |
| `changeImplementationAuthority(token, newIA)` | **the single address that owns all six contracts of the token's suite** (`:173-181`); `newIA == 0` → reference IA deploys a fresh auxiliary IA through `IAFactory` owned by the token owner (`:183-185`, `IAFactory.sol:86-97`); otherwise `newIA` must be on the same version and be either the reference IA or `IAFactory`-deployed (`:186-202`); then every proxy's `setImplementationAuthority` is called (`:204-212`; the shared IRS only if it still points at this IA) | `:161-214` |
| `AbstractProxy.setImplementationAuthority` | only the **current IA** of that proxy (`AbstractProxy.sol:75`) | |
| Module `upgradeTo` | module **owner** (`AbstractModuleUpgradeable.sol:139`) | |

Reference vs auxiliary (`:83`, `:316-325`): Tokeny's model is one *reference* IA that publishes versions and auxiliary IAs that can only *fetch* those versions ("it is not possible to come with your own implementation of the TREXImplementationAuthority contract and use it for contracts already deployed by the TREX factory", `CHANGELOG.md:154-163`). In an independent deployment **you deploy the reference IA**, so you publish versions yourself. `getReferenceContract()` calls `ITREXFactory(_trexFactory).getImplementationAuthority()` (`:323-325`) and will revert if `_trexFactory` is unset; this only matters for `fetchVersion` and the `newIA != 0` branch of `changeImplementationAuthority`.

### 9.3 Upgrade procedure (owner of the reference IA)

1. Deploy new implementation(s); reuse unchanged addresses for the others.
2. `ia.addTREXVersion({4,1,x}, {token, ctr, ir, irs, tir, mc})`.
3. `ia.useTREXVersion({4,1,x})` → all proxies now delegate to the new code. Emits `VersionUpdated`.
4. No per-proxy re-initialisation happens; if a new implementation needs a migration, add an explicit `reinitializer` function and call it per proxy.

### 9.4 Setting the owner to a timelock

`TREXImplementationAuthority is Ownable` (OZ 4.9, `:72`); owner = deployer (`Ownable()` constructor sets `msg.sender`). To put upgrades behind a timelock: deploy an OZ `TimelockController` (proposers = your multisig, executors = multisig or `address(0)` for open execution), then `ia.transferOwnership(timelock)`. OZ-4 `Ownable` is **single-step** (`Ownable2Step` is not used), so double-check the address; after transfer, `addTREXVersion/useTREXVersion/setTREXFactory/setIAFactory` must be scheduled through the timelock. `IAFactory.deployIA` transfers each new auxiliary IA to `Ownable(_token).owner()` (`IAFactory.sol:93`) — so if the token owner is the timelock, spun-off IAs are timelocked too. The same `transferOwnership` applies to Token/IR/IRS/CTR/TIR/MC (their `onlyOwner` configuration surfaces) and to `TREXFactory` (`deployTREXSuite` is `onlyOwner`; or make the `TREXGateway` the factory owner). `changeImplementationAuthority` requires **one** address to own all six suite contracts, so keep ownership uniform if you want that path available.

---

## 10. Monad / chain-specific code

None found.

- `grep -rn "chainid|CHAIN_ID|chainId|monad"` over `contracts/`, `test/`, `scripts/`, `hardhat.config.ts` → only `_onchainId` parameter names in `TREXFactory.sol:331,342`.
- No hard-coded addresses, no precompile use, no EIP-712 domain separators (DVA signatures are raw `ecrecover` over `keccak256(transferID)` with no chain id or contract address, `DVATransferManager.sol:194-198`, `:437` — theoretically replayable across chains/deployments if the same `transferID` recurs; `transferID` = hash of nonce, sender, recipient, amount, `:318`).
- Time logic uses `block.timestamp` with second-granularity windows (`TimeTransfersLimitsModule.sol:310,323`, `ExchangeMonthlyLimitsModule.sol:319` = `30 days`) — fine on any chain regardless of block time.
- `CREATE2` in `TREXFactory._deploy` (`:236-250`) and `IdFactory._deploy` — standard opcode.
- Gas: proxy fallback forwards `gas() - 10000` (`TokenProxy.sol:116`); `isVerified` is O(topics × issuers) external calls; `batch*` functions are unbounded loops.
- EVM version: T-REX was built with solc 0.8.17 (pre-`PUSH0`). If you recompile with ≥0.8.20, pin `evm_version` to one the target chain supports (my 0.8.30 test build used `paris`).

---

## 11. Not found / unverified

- **Monad-specific behaviour** (opcode support such as `PUSH0`/`MCOPY`/transient storage, gas schedule, contract-size limit, precompiles): not verifiable from this repo; nothing in the code depends on it, but confirm the chain's EVM version before choosing `evm_version`.
- **Maintained successor** (`github.com/ERC-3643/ERC-3643`, referenced at `README.md:2`): not examined. Its licence, pragma policy and API may differ from 4.1.6.
- **`@onchain-id/solidity` 2.1.0 vs 2.2.1 diff**: only 2.2.1 was inspected (the lockfile resolves 2.1.0). The T-REX call surface (`IIdentity.getClaim/keyHasPurpose`, `IClaimIssuer.isClaimValid`, `IIdFactory.createTokenIdentity`) is present in 2.2.1; whether anything else changed between the two was not checked.
- **ONCHAINID `package.json` says `"license": "ISC"` while its `LICENSE.md` and all SPDX headers say GPL-3.0** — contradiction not resolvable from the sources; treat as GPL-3.0.
- **Legal reading of "GPL-3.0 + CC-BY-NC-4.0" on the 11 modules** and of whether on-chain deployment constitutes GPL "conveying": not legal advice; obtain counsel or Tokeny's commercial licence if commercial use is intended.
- **Hardhat test suite was not executed** (no `node_modules`); behavioural claims are from reading the Solidity and the test sources, plus the two Foundry *compile* runs. No Foundry tests were written.
- **Audit**: `README.md:73-74` links a Hacken audit for v4.0.0 (`CHANGELOG.md:124`); later modules (4.1.x, incl. `TokenListingRestrictionsModule`, `AbstractModuleUpgradeable`) are not covered by that audit as far as the repo states.
- **`RecoveryFails` event** is documented in `IToken.sol:294` but does not exist in the interface or implementation.
- **`_TOKEN_VERSION = "4.1.3"`** (`TokenStorage.sol:79`) vs package 4.1.6 — not bumped; harmless.
- **Gas numbers / deployment cost on the target chain**: not measured.
- **`docs/TREX-WhitePaper.pdf`**: not read (binary); `docs.tokeny.com` not consulted.
- **IRS `bindIdentityRegistry` access control**: the function has no modifier (`IdentityRegistryStorage.sol:133`) and relies on the internal `addAgent` being `onlyOwner` (`AgentRoleUpgradeable.sol:83`); the test at `test/registries/identity-registry-storage.test.ts:243-245` confirms non-owners revert, but the revert reason will be OZ's "Ownable: caller is not the owner".
