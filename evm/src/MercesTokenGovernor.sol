// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

/// @title MercesTokenGovernor
/// @notice Owner of every per-series T-REX `TokenProxy` / `ModularComplianceProxy` and of the shared
/// `IdentityRegistry` stack (SPEC v1.1 §4.2). It is a deliberate dead end: it exposes **no** `addAgent`,
/// `removeAgent`, `setCompliance`, `setIdentityRegistry`, `addModule`, `removeModule`, `pause`, `freeze`,
/// `forcedTransfer`, `recoveryAddress` or ownership-transfer path, so the agent set, the compliance module and
/// the identity registry of a unit token can never change after creation. Implementation upgrades of the T-REX
/// code go through the `TREXImplementationAuthority`, which is owned by the protocol `TimelockController`; the
/// governor therefore needs no forwarding function (recorded in docs/assumptions/track-c.md).
/// Non-upgradeable, no constructor arguments, no state.
contract MercesTokenGovernor {
    string public constant VERSION = "merces-token-governor-1";
}
