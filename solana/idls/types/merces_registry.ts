/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/merces_registry.json`.
 */
export type MercesRegistry = {
  "address": "GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi",
  "metadata": {
    "name": "mercesRegistry",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Merces charter and terms registry (D1) plus allowlist, attestor and verifier-key registries (D11). Deployed immutable."
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pendingAdmin",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "amendTerms",
      "docs": [
        "Issuer-favourable amendment (SPEC §3.2, brief C4): the issuer signs the transaction and an",
        "active attestor signs the `MERCES_AMEND_V1` message with the current nonce. The cap",
        "multiple may only decrease. Allowed only while `terminal_status == 0`."
      ],
      "discriminator": [
        17,
        7,
        252,
        2,
        182,
        121,
        215,
        182
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "issuerWallet",
          "signer": true
        },
        {
          "name": "series",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  114,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "series.seriesId",
                "account": "series"
              }
            ]
          }
        },
        {
          "name": "attestor",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "attestorAddr"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "newTermsCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "newCapMultipleWad",
          "type": "u64"
        },
        {
          "name": "attestorAddr",
          "type": {
            "array": [
              "u8",
              20
            ]
          }
        },
        {
          "name": "attestorSig",
          "type": {
            "array": [
              "u8",
              65
            ]
          }
        }
      ]
    },
    {
      "name": "createSeries",
      "discriminator": [
        181,
        9,
        52,
        120,
        197,
        221,
        42,
        142
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "issuerWallet",
          "writable": true,
          "signer": true
        },
        {
          "name": "issuer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  115,
                  115,
                  117,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "issuerWallet"
              }
            ]
          }
        },
        {
          "name": "allowlistEntry",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "issuerWallet"
              }
            ]
          }
        },
        {
          "name": "stablecoinMint",
          "docs": [
            "The settlement stablecoin (SPL Token or Token-2022); decimals and owner are read from it."
          ]
        },
        {
          "name": "fxPair",
          "docs": [
            "Required when `fx_pair_id != 0`."
          ],
          "optional": true
        },
        {
          "name": "series",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  114,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "config.seriesCount",
                "account": "protocolConfig"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createSeriesArgs"
            }
          }
        }
      ]
    },
    {
      "name": "deactivateIssuer",
      "docs": [
        "Blocks *new* series only; existing series are untouched (SPEC §3.2)."
      ],
      "discriminator": [
        52,
        10,
        163,
        187,
        247,
        22,
        150,
        37
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "issuer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  115,
                  115,
                  117,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "wallet"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "wallet",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initProtocol",
      "docs": [
        "Creates `ProtocolConfig` once (SPEC §3.2)."
      ],
      "discriminator": [
        3,
        188,
        141,
        237,
        225,
        226,
        232,
        210
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initProtocolArgs"
            }
          }
        }
      ]
    },
    {
      "name": "markCurveActivated",
      "docs": [
        "Curve-mode activation (SPEC §9, CURVE_MODE §2–§3): records the DBC config, pool, base mint",
        "and pool creator validated by `merces_protocol::activate_curve`, and fixes `P0`",
        "(`clearing_price`, per whole unit) and the design `units_sold` (base lamports) for cap",
        "accounting. Draft → Open; the protocol marks the raise Settled (and the mint final) when it",
        "observes the curve's completion."
      ],
      "discriminator": [
        199,
        227,
        142,
        117,
        166,
        213,
        143,
        77
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "protocolAuthority",
          "signer": true
        },
        {
          "name": "series",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  114,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "series.seriesId",
                "account": "series"
              }
            ]
          }
        },
        {
          "name": "issuerAllowlist",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series.issuer",
                "account": "series"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "dbcConfig",
          "type": "pubkey"
        },
        {
          "name": "dbcPool",
          "type": "pubkey"
        },
        {
          "name": "baseMint",
          "type": "pubkey"
        },
        {
          "name": "dbcCreator",
          "type": "pubkey"
        },
        {
          "name": "activatedAt",
          "type": "u64"
        },
        {
          "name": "unitsSold",
          "type": "u64"
        },
        {
          "name": "clearingPrice",
          "type": "u64"
        }
      ]
    },
    {
      "name": "markMintFinalized",
      "docs": [
        "Mint finalised: every bid of a Settled or Failed raise processed and the mint authority",
        "revoked (a failed raise finalises an empty mint, so nothing can ever be minted for it)."
      ],
      "discriminator": [
        99,
        111,
        132,
        80,
        240,
        35,
        133,
        182
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "protocolAuthority",
          "signer": true
        },
        {
          "name": "series",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  114,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "series.seriesId",
                "account": "series"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "markRaiseOpened",
      "docs": [
        "Draft → Open. Also enforces the D1 gate: contract hash set, issuer allowlisted, raises not",
        "paused. Records the unit mint and the protocol's unit escrow ATAs for the hook."
      ],
      "discriminator": [
        240,
        189,
        168,
        88,
        98,
        229,
        252,
        164
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "protocolAuthority",
          "signer": true
        },
        {
          "name": "series",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  114,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "series.seriesId",
                "account": "series"
              }
            ]
          }
        },
        {
          "name": "issuerAllowlist",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series.issuer",
                "account": "series"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "unitMint",
          "type": "pubkey"
        },
        {
          "name": "openedAt",
          "type": "u64"
        },
        {
          "name": "auctionEscrowAta",
          "type": "pubkey"
        },
        {
          "name": "windowEscrowAta",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "markRaiseResult",
      "docs": [
        "Records the raise outcome, exact and written once (SPEC §3.2)."
      ],
      "discriminator": [
        213,
        56,
        35,
        38,
        8,
        146,
        85,
        179
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "protocolAuthority",
          "signer": true
        },
        {
          "name": "series",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  114,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "series.seriesId",
                "account": "series"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "state",
          "type": "u8"
        },
        {
          "name": "settlementTs",
          "type": "u64"
        },
        {
          "name": "unitsSold",
          "type": "u64"
        },
        {
          "name": "clearingPrice",
          "type": "u64"
        }
      ]
    },
    {
      "name": "markTerminal",
      "docs": [
        "Terminal status mirror: Retired / Redeemed / Extinguished. Extinguished may follow Retired",
        "or Redeemed (SPEC §6.9: allowed in every status but Extinguished)."
      ],
      "discriminator": [
        124,
        120,
        247,
        173,
        14,
        87,
        132,
        103
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "protocolAuthority",
          "signer": true
        },
        {
          "name": "series",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  114,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "series.seriesId",
                "account": "series"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "status",
          "type": "u8"
        }
      ]
    },
    {
      "name": "registerAttestor",
      "docs": [
        "Registers (or re-activates) an attestor key."
      ],
      "discriminator": [
        68,
        201,
        86,
        244,
        51,
        113,
        15,
        94
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "attestor",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "addr"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "addr",
          "type": {
            "array": [
              "u8",
              20
            ]
          }
        }
      ]
    },
    {
      "name": "registerIssuer",
      "discriminator": [
        145,
        117,
        52,
        59,
        189,
        27,
        127,
        18
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "issuer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  115,
                  115,
                  117,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "wallet",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "registerVerifierKey",
      "discriminator": [
        128,
        252,
        149,
        28,
        64,
        87,
        132,
        178
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "verifier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  101,
                  114,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "addr"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "addr",
          "type": {
            "array": [
              "u8",
              20
            ]
          }
        }
      ]
    },
    {
      "name": "resumeIssuance",
      "discriminator": [
        225,
        10,
        210,
        222,
        48,
        32,
        11,
        146
      ],
      "accounts": [
        {
          "name": "issuerWallet",
          "signer": true
        },
        {
          "name": "issuer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  115,
                  115,
                  117,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "issuerWallet"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "revokeAttestor",
      "docs": [
        "Forward-only revocation (SPEC §1.4): records `revoked_at`; refused for the last active key."
      ],
      "discriminator": [
        185,
        12,
        191,
        140,
        144,
        112,
        102,
        154
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "attestor",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  111,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "addr"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "addr",
          "type": {
            "array": [
              "u8",
              20
            ]
          }
        }
      ]
    },
    {
      "name": "revokeVerifierKey",
      "discriminator": [
        38,
        162,
        12,
        240,
        52,
        250,
        34,
        161
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "verifier",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  101,
                  114,
                  105,
                  102,
                  105,
                  101,
                  114
                ]
              },
              {
                "kind": "arg",
                "path": "addr"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "addr",
          "type": {
            "array": [
              "u8",
              20
            ]
          }
        }
      ]
    },
    {
      "name": "setAllowed",
      "discriminator": [
        172,
        134,
        133,
        128,
        12,
        254,
        134,
        112
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "allowlistManager",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "entry",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  108,
                  108,
                  111,
                  119
                ]
              },
              {
                "kind": "arg",
                "path": "wallet"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "wallet",
          "type": "pubkey"
        },
        {
          "name": "allowed",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setAllowlistManager",
      "discriminator": [
        224,
        94,
        5,
        191,
        3,
        222,
        84,
        121
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newManager",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setContractHash",
      "docs": [
        "Draft only, non-zero (SPEC §3.2)."
      ],
      "discriminator": [
        1,
        159,
        8,
        144,
        72,
        143,
        181,
        123
      ],
      "accounts": [
        {
          "name": "issuerWallet",
          "signer": true
        },
        {
          "name": "series",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  114,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "series.seriesId",
                "account": "series"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "hash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "setDefaults",
      "docs": [
        "Edits the defaults for *future* series only (bounds-checked)."
      ],
      "discriminator": [
        58,
        181,
        153,
        49,
        140,
        16,
        205,
        251
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "defaults",
          "type": {
            "defined": {
              "name": "parametersData"
            }
          }
        }
      ]
    },
    {
      "name": "setEarlyDrawApprover",
      "docs": [
        "`Pubkey::default()` unsets the approver (early draws off)."
      ],
      "discriminator": [
        19,
        63,
        239,
        100,
        224,
        223,
        8,
        42
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "approver",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setFeeCollector",
      "discriminator": [
        143,
        46,
        10,
        113,
        121,
        157,
        245,
        166
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newCollector",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setFlags",
      "discriminator": [
        199,
        54,
        111,
        124,
        87,
        47,
        217,
        198
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newRaisesPaused",
          "type": "bool"
        },
        {
          "name": "windowsEnabled",
          "type": "bool"
        },
        {
          "name": "tier4Enabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setFxCrosscheck",
      "docs": [
        "Changes a pair's cross-check feed (SPEC §3.1). Setting it from zero applies from the current",
        "period (nothing was checked before); any later change — a new feed or removal — applies from",
        "`period_of(now) + 1`, and the feed in force for the running period is kept in",
        "`prev_crosscheck`, so a live quarter's rule never changes under an issuer."
      ],
      "discriminator": [
        160,
        149,
        202,
        41,
        2,
        37,
        220,
        207
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "fxPair",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  120
                ]
              },
              {
                "kind": "account",
                "path": "fxPair.pairId",
                "account": "fxPairConfig"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "crosscheck",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setFxPair",
      "docs": [
        "Registers an FX pair, write-once (SPEC §3.1): `pair_id = keccak256(feed_id ‖ inverted)`",
        "commits to the feed and its direction, and a pair can never be re-registered",
        "(`FxPairImmutable`). A cross-check feed given here applies from the current period; later",
        "changes go through `set_fx_crosscheck`. `enabled` only gates new series."
      ],
      "discriminator": [
        129,
        160,
        134,
        58,
        83,
        105,
        243,
        173
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "fxPair",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  120
                ]
              },
              {
                "kind": "arg",
                "path": "pairId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "pairId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "feedId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "inverted",
          "type": "bool"
        },
        {
          "name": "crosscheck",
          "type": "pubkey"
        },
        {
          "name": "enabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setFxPairEnabled",
      "docs": [
        "Enables or disables an existing pair (`enabled = false` only stops new series from",
        "referencing it; live series keep their pair, SPEC §3.1)."
      ],
      "discriminator": [
        100,
        4,
        210,
        228,
        228,
        2,
        191,
        105
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "fxPair",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  120
                ]
              },
              {
                "kind": "account",
                "path": "fxPair.pairId",
                "account": "fxPairConfig"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "enabled",
          "type": "bool"
        }
      ]
    },
    {
      "name": "stopIssuance",
      "discriminator": [
        123,
        10,
        134,
        44,
        49,
        121,
        168,
        101
      ],
      "accounts": [
        {
          "name": "issuerWallet",
          "signer": true
        },
        {
          "name": "issuer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  115,
                  115,
                  117,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "issuerWallet"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "transferAdmin",
      "discriminator": [
        42,
        242,
        66,
        106,
        228,
        10,
        111,
        156
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "allowlistEntry",
      "discriminator": [
        42,
        59,
        88,
        1,
        124,
        138,
        92,
        236
      ]
    },
    {
      "name": "attestorKey",
      "discriminator": [
        246,
        234,
        233,
        132,
        153,
        37,
        254,
        158
      ]
    },
    {
      "name": "fxPairConfig",
      "discriminator": [
        97,
        140,
        45,
        187,
        110,
        107,
        65,
        244
      ]
    },
    {
      "name": "issuer",
      "discriminator": [
        216,
        19,
        83,
        230,
        108,
        53,
        80,
        14
      ]
    },
    {
      "name": "protocolConfig",
      "discriminator": [
        207,
        91,
        250,
        28,
        152,
        179,
        215,
        209
      ]
    },
    {
      "name": "series",
      "discriminator": [
        240,
        97,
        8,
        183,
        139,
        77,
        250,
        162
      ]
    },
    {
      "name": "verifierKey",
      "discriminator": [
        27,
        40,
        233,
        33,
        249,
        246,
        9,
        239
      ]
    }
  ],
  "events": [
    {
      "name": "adminTransferStarted",
      "discriminator": [
        31,
        82,
        117,
        177,
        147,
        168,
        210,
        177
      ]
    },
    {
      "name": "adminTransferred",
      "discriminator": [
        255,
        147,
        182,
        5,
        199,
        217,
        38,
        179
      ]
    },
    {
      "name": "allowlistManagerSet",
      "discriminator": [
        168,
        4,
        114,
        48,
        8,
        117,
        206,
        225
      ]
    },
    {
      "name": "allowlistUpdated",
      "discriminator": [
        88,
        239,
        93,
        65,
        74,
        140,
        83,
        213
      ]
    },
    {
      "name": "attestorRegistered",
      "discriminator": [
        142,
        114,
        59,
        201,
        93,
        183,
        89,
        183
      ]
    },
    {
      "name": "attestorRevoked",
      "discriminator": [
        43,
        114,
        48,
        146,
        162,
        21,
        111,
        6
      ]
    },
    {
      "name": "contractHashSet",
      "discriminator": [
        27,
        118,
        95,
        170,
        193,
        92,
        210,
        97
      ]
    },
    {
      "name": "curveActivated",
      "discriminator": [
        91,
        90,
        237,
        133,
        68,
        208,
        63,
        27
      ]
    },
    {
      "name": "defaultsSet",
      "discriminator": [
        101,
        72,
        92,
        84,
        90,
        198,
        2,
        113
      ]
    },
    {
      "name": "earlyDrawApproverSet",
      "discriminator": [
        142,
        94,
        21,
        11,
        145,
        99,
        195,
        130
      ]
    },
    {
      "name": "feeCollectorSet",
      "discriminator": [
        150,
        157,
        159,
        208,
        146,
        77,
        0,
        169
      ]
    },
    {
      "name": "flagsSet",
      "discriminator": [
        18,
        239,
        239,
        47,
        29,
        66,
        236,
        126
      ]
    },
    {
      "name": "fxPairSet",
      "discriminator": [
        62,
        100,
        211,
        168,
        13,
        110,
        220,
        127
      ]
    },
    {
      "name": "issuanceResumed",
      "discriminator": [
        187,
        108,
        104,
        130,
        56,
        159,
        167,
        76
      ]
    },
    {
      "name": "issuanceStopped",
      "discriminator": [
        34,
        202,
        32,
        148,
        144,
        253,
        42,
        162
      ]
    },
    {
      "name": "issuerDeactivated",
      "discriminator": [
        99,
        85,
        66,
        97,
        134,
        180,
        9,
        194
      ]
    },
    {
      "name": "issuerRegistered",
      "discriminator": [
        98,
        108,
        156,
        224,
        9,
        0,
        195,
        21
      ]
    },
    {
      "name": "mintFinalized",
      "discriminator": [
        201,
        211,
        37,
        248,
        157,
        98,
        73,
        211
      ]
    },
    {
      "name": "protocolInitialized",
      "discriminator": [
        173,
        122,
        168,
        254,
        9,
        118,
        76,
        132
      ]
    },
    {
      "name": "raiseStateChanged",
      "discriminator": [
        187,
        26,
        189,
        153,
        199,
        75,
        20,
        155
      ]
    },
    {
      "name": "seriesCreated",
      "discriminator": [
        2,
        164,
        54,
        38,
        24,
        181,
        233,
        180
      ]
    },
    {
      "name": "terminalStatusSet",
      "discriminator": [
        200,
        8,
        227,
        71,
        10,
        217,
        192,
        214
      ]
    },
    {
      "name": "termsAmended",
      "discriminator": [
        165,
        218,
        140,
        238,
        243,
        240,
        147,
        185
      ]
    },
    {
      "name": "verifierKeyRegistered",
      "discriminator": [
        51,
        226,
        43,
        36,
        28,
        170,
        104,
        156
      ]
    },
    {
      "name": "verifierKeyRevoked",
      "discriminator": [
        227,
        104,
        7,
        71,
        203,
        98,
        107,
        98
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Caller is not authorised for this instruction"
    },
    {
      "code": 6001,
      "name": "notProtocolAuthority",
      "msg": "Caller is not the protocol authority PDA"
    },
    {
      "code": 6002,
      "name": "notPendingAdmin",
      "msg": "Caller is not the pending admin"
    },
    {
      "code": 6003,
      "name": "zeroAddress",
      "msg": "Address must not be zero"
    },
    {
      "code": 6004,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6005,
      "name": "issuerInactive",
      "msg": "Issuer is not active"
    },
    {
      "code": 6006,
      "name": "issuanceStopped",
      "msg": "Issuer has stopped new issuance"
    },
    {
      "code": 6007,
      "name": "notAllowlisted",
      "msg": "Wallet is not allowlisted"
    },
    {
      "code": 6008,
      "name": "allowlistEntryMismatch",
      "msg": "Allowlist entry does not belong to this wallet"
    },
    {
      "code": 6009,
      "name": "unitsOfferedZero",
      "msg": "units_offered must be at least 1"
    },
    {
      "code": 6010,
      "name": "reservePriceZero",
      "msg": "reserve_price must be at least 1"
    },
    {
      "code": 6011,
      "name": "minRaiseTooHigh",
      "msg": "min_raise exceeds reserve_price × units_offered"
    },
    {
      "code": 6012,
      "name": "invalidReleaseSchedule",
      "msg": "Release schedule must have 1..=24 tranches, bps summing to 10000, non-decreasing offsets"
    },
    {
      "code": 6013,
      "name": "invalidTierFlags",
      "msg": "Tier flags must be non-zero and use only bits 0..=3"
    },
    {
      "code": 6014,
      "name": "invalidMode",
      "msg": "Unknown series mode"
    },
    {
      "code": 6015,
      "name": "publicPriceNotAccepted",
      "msg": "Curve-mode series require issuer_accepts_public_price = true"
    },
    {
      "code": 6016,
      "name": "metadataUriTooLong",
      "msg": "Metadata URI exceeds 200 bytes"
    },
    {
      "code": 6017,
      "name": "fxPairMismatch",
      "msg": "FX pair account missing, disabled or does not match fx_pair_id"
    },
    {
      "code": 6018,
      "name": "transferFeeNotZero",
      "msg": "Stablecoin mint has a non-zero transfer fee"
    },
    {
      "code": 6019,
      "name": "invalidStablecoinMint",
      "msg": "Stablecoin mint could not be read"
    },
    {
      "code": 6020,
      "name": "notDraft",
      "msg": "Series is not in Draft state"
    },
    {
      "code": 6021,
      "name": "zeroContractHash",
      "msg": "Contract hash must be non-zero"
    },
    {
      "code": 6022,
      "name": "contractHashNotSet",
      "msg": "Contract hash is not set; the raise cannot open"
    },
    {
      "code": 6023,
      "name": "newRaisesPaused",
      "msg": "New raises are paused"
    },
    {
      "code": 6024,
      "name": "seriesTerminal",
      "msg": "Series is terminal"
    },
    {
      "code": 6025,
      "name": "notSealedBid",
      "msg": "Series is not a sealed-bid series"
    },
    {
      "code": 6026,
      "name": "notCurveMode",
      "msg": "Series is not a curve-mode series"
    },
    {
      "code": 6027,
      "name": "invalidRaiseTransition",
      "msg": "Invalid raise state transition"
    },
    {
      "code": 6028,
      "name": "raiseResultAlreadyWritten",
      "msg": "Raise results are written once"
    },
    {
      "code": 6029,
      "name": "mintAlreadyFinalized",
      "msg": "Mint already finalised"
    },
    {
      "code": 6030,
      "name": "invalidTerminalStatus",
      "msg": "Invalid terminal status"
    },
    {
      "code": 6031,
      "name": "invalidTerminalTransition",
      "msg": "Terminal status transition not allowed"
    },
    {
      "code": 6032,
      "name": "malformedSignature",
      "msg": "Attestor signature is malformed"
    },
    {
      "code": 6033,
      "name": "signatureRecoveryFailed",
      "msg": "Attestor signature recovery failed"
    },
    {
      "code": 6034,
      "name": "attestorMismatch",
      "msg": "Recovered signer is not the supplied attestor address"
    },
    {
      "code": 6035,
      "name": "attestorInactive",
      "msg": "Attestor key is not active"
    },
    {
      "code": 6036,
      "name": "capMultipleIncrease",
      "msg": "Cap multiple may only decrease"
    },
    {
      "code": 6037,
      "name": "zeroAttestorAddress",
      "msg": "Attestor address must be non-zero"
    },
    {
      "code": 6038,
      "name": "invalidChainId",
      "msg": "Invalid chain id"
    },
    {
      "code": 6039,
      "name": "keyAlreadyRevoked",
      "msg": "Key is already revoked"
    },
    {
      "code": 6040,
      "name": "lastKeyOfKind",
      "msg": "The last active key of a kind cannot be revoked without a replacement"
    },
    {
      "code": 6041,
      "name": "fxPairIdMismatch",
      "msg": "pair_id must equal keccak256(feed_id ‖ inverted)"
    },
    {
      "code": 6042,
      "name": "fxPairImmutable",
      "msg": "feed_id and inverted are write-once for an FX pair"
    },
    {
      "code": 6043,
      "name": "crosscheckUnchanged",
      "msg": "The cross-check feed is already the requested one"
    },
    {
      "code": 6044,
      "name": "walletCapTooSmall",
      "msg": "Wallet cap allows no bid: floor(units_offered × wallet_cap_bps / 10000) < 1"
    },
    {
      "code": 6045,
      "name": "tier1TermsRequired",
      "msg": "Tier-1 series must supply plaintext router terms"
    },
    {
      "code": 6046,
      "name": "tier1NeedsStablecoinIncome",
      "msg": "Tier-1 series must use stablecoin income (fx_pair_id = 0)"
    },
    {
      "code": 6047,
      "name": "tier1ShareTooLarge",
      "msg": "Tier-1 series require r_wad × units_offered ≤ WAD"
    },
    {
      "code": 6048,
      "name": "tier1TermsMismatch",
      "msg": "Tier-1 terms do not hash to terms_commitment"
    },
    {
      "code": 6049,
      "name": "tier1TermsUnexpected",
      "msg": "Router terms supplied for a series without tier 1"
    },
    {
      "code": 6050,
      "name": "poseidonFailed",
      "msg": "Poseidon hashing failed"
    },
    {
      "code": 6051,
      "name": "boundCapMultiple",
      "msg": "cap_multiple_wad out of bounds [2.0e18, 3.0e18]"
    },
    {
      "code": 6052,
      "name": "boundHurdleRate",
      "msg": "hurdle_rate_wad out of bounds [0, 0.25e18]"
    },
    {
      "code": 6053,
      "name": "boundPayoutMultiple",
      "msg": "payout_multiple_k out of bounds [1, 20]"
    },
    {
      "code": 6054,
      "name": "boundLockup",
      "msg": "lockup_seconds out of bounds [0, 157680000]"
    },
    {
      "code": 6055,
      "name": "boundWalletCap",
      "msg": "wallet_cap_bps out of bounds [100, 10000]"
    },
    {
      "code": 6056,
      "name": "boundAuctionFee",
      "msg": "auction_fee_bps out of bounds [0, 1000]"
    },
    {
      "code": 6057,
      "name": "boundPayoutFee",
      "msg": "payout_fee_bps out of bounds [0, 2000]"
    },
    {
      "code": 6058,
      "name": "boundWindowFee",
      "msg": "window_fee_bps out of bounds [0, 1000]"
    },
    {
      "code": 6059,
      "name": "boundNonRevealCharge",
      "msg": "non_reveal_charge_bps out of bounds [0, 1000]"
    },
    {
      "code": 6060,
      "name": "boundCommitDuration",
      "msg": "commit_duration out of bounds [1 h, 30 d]"
    },
    {
      "code": 6061,
      "name": "boundRevealDuration",
      "msg": "reveal_duration out of bounds [1 h, 7 d]"
    },
    {
      "code": 6062,
      "name": "boundWindowCommitDuration",
      "msg": "window_commit_duration out of bounds [1 h, 14 d]"
    },
    {
      "code": 6063,
      "name": "boundWindowRevealDuration",
      "msg": "window_reveal_duration out of bounds [1 h, 7 d]"
    },
    {
      "code": 6064,
      "name": "boundFxMinCoverage",
      "msg": "fx_min_coverage_bps out of bounds [5000, 10000]"
    },
    {
      "code": 6065,
      "name": "boundFxMaxStaleness",
      "msg": "fx_max_staleness_seconds out of bounds [60, 86400]"
    },
    {
      "code": 6066,
      "name": "boundFxMaxConf",
      "msg": "fx_max_conf_bps out of bounds [1, 1000]"
    },
    {
      "code": 6067,
      "name": "boundFxDeviationBand",
      "msg": "fx_deviation_band_bps out of bounds [10, 5000]"
    },
    {
      "code": 6068,
      "name": "boundMaxPause",
      "msg": "max_pause_seconds out of bounds [30 d, 730 d]"
    },
    {
      "code": 6069,
      "name": "boundMaxCumulativePause",
      "msg": "max_cumulative_pause_seconds out of bounds [max_pause_seconds, 5 y]"
    },
    {
      "code": 6070,
      "name": "curveQuoteMintMismatch",
      "msg": "Curve-mode series must use the configured curve quote mint (USDC)"
    },
    {
      "code": 6071,
      "name": "curveTermsNotZero",
      "msg": "Curve-mode series take no lockup, wallet cap or auction/window durations (all must be 0)"
    },
    {
      "code": 6072,
      "name": "curveThresholdZero",
      "msg": "Curve-mode series need a migration threshold (min_raise ≥ 1)"
    }
  ],
  "types": [
    {
      "name": "adminTransferStarted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "adminTransferred",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldAdmin",
            "type": "pubkey"
          },
          {
            "name": "newAdmin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "allowlistEntry",
      "docs": [
        "Allowlist entry (`[ALLOW, wallet]`). A missing account means \"never allowlisted\"."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "allowed",
            "type": "bool"
          },
          {
            "name": "updatedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "allowlistManagerSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "allowlistManager",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "allowlistUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "allowed",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "attestorKey",
      "docs": [
        "Attestor key (`[ATTESTOR, addr20]`). `revoked_at == 0` while active (SPEC §1.4)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "addr",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "revokedAt",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "attestorRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "addr",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          }
        ]
      }
    },
    {
      "name": "attestorRevoked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "addr",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "revokedAt",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "contractHashSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "hash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "createSeriesArgs",
      "docs": [
        "Arguments to `create_series`. Fees, FX bounds and pause bounds are copied from",
        "`ProtocolConfig.defaults`; everything here is issuer-chosen within the §1.6 bounds."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "unitsOffered",
            "type": "u64"
          },
          {
            "name": "reservePrice",
            "type": "u64"
          },
          {
            "name": "minRaise",
            "type": "u64"
          },
          {
            "name": "capMultipleWad",
            "type": "u64"
          },
          {
            "name": "hurdleRateWad",
            "type": "u64"
          },
          {
            "name": "payoutMultipleK",
            "type": "u16"
          },
          {
            "name": "lockupSeconds",
            "type": "u64"
          },
          {
            "name": "walletCapBps",
            "type": "u16"
          },
          {
            "name": "commitDuration",
            "type": "u64"
          },
          {
            "name": "revealDuration",
            "type": "u64"
          },
          {
            "name": "windowCommitDuration",
            "type": "u64"
          },
          {
            "name": "windowRevealDuration",
            "type": "u64"
          },
          {
            "name": "releaseSchedule",
            "type": {
              "vec": {
                "defined": {
                  "name": "trancheData"
                }
              }
            }
          },
          {
            "name": "termsCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tierFlags",
            "type": "u8"
          },
          {
            "name": "fxPairId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "mode",
            "type": "u8"
          },
          {
            "name": "issuerAcceptsPublicPrice",
            "type": "bool"
          },
          {
            "name": "metadataUri",
            "type": "string"
          },
          {
            "name": "tier1Terms",
            "docs": [
              "Required when bit0 (tier 1 split) is set; must hash to `terms_commitment`."
            ],
            "type": {
              "option": {
                "defined": {
                  "name": "tier1Terms"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "curveActivated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "dbcConfig",
            "type": "pubkey"
          },
          {
            "name": "dbcPool",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "dbcCreator",
            "type": "pubkey"
          },
          {
            "name": "unitsSold",
            "type": "u64"
          },
          {
            "name": "clearingPrice",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "defaultsSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "defaults",
            "type": {
              "defined": {
                "name": "parametersData"
              }
            }
          }
        ]
      }
    },
    {
      "name": "earlyDrawApproverSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "approver",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "feeCollectorSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feeCollector",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "flagsSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "newRaisesPaused",
            "type": "bool"
          },
          {
            "name": "windowsEnabled",
            "type": "bool"
          },
          {
            "name": "tier4Enabled",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "fxPairConfig",
      "docs": [
        "FX pair configuration (`[FX, pair_id]`), `pair_id = keccak256(feed_id ‖ inverted_u8)`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pairId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "feedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "inverted",
            "type": "bool"
          },
          {
            "name": "crosscheck",
            "docs": [
              "Cross-check feed: on Solana a second Pyth feed id (32 bytes stored as a `Pubkey`); zero when",
              "none is configured."
            ],
            "type": "pubkey"
          },
          {
            "name": "crosscheckEffectivePeriod",
            "docs": [
              "Period from which `crosscheck` applies (SPEC §3.1)."
            ],
            "type": "u32"
          },
          {
            "name": "prevCrosscheck",
            "docs": [
              "The cross-check in force before `crosscheck_effective_period` (a change never alters the rule",
              "of a running quarter)."
            ],
            "type": "pubkey"
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "fxPairSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pairId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "feedId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "inverted",
            "type": "bool"
          },
          {
            "name": "crosscheck",
            "type": "pubkey"
          },
          {
            "name": "crosscheckEffectivePeriod",
            "type": "u32"
          },
          {
            "name": "enabled",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "initProtocolArgs",
      "docs": [
        "Arguments to `init_protocol`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "allowlistManager",
            "type": "pubkey"
          },
          {
            "name": "feeCollector",
            "type": "pubkey"
          },
          {
            "name": "chainId",
            "docs": [
              "Cluster tag (SPEC §1.3): mainnet-beta 101, testnet 102, devnet 103, localnet 104."
            ],
            "type": "u64"
          },
          {
            "name": "defaults",
            "type": {
              "defined": {
                "name": "parametersData"
              }
            }
          },
          {
            "name": "protocolProgram",
            "docs": [
              "The `merces_protocol` program id whose `[REGISTRY_AUTHORITY]` PDA may call the write",
              "interface. Fixed for the life of the deployment (no setter)."
            ],
            "type": "pubkey"
          },
          {
            "name": "curveQuoteMint",
            "docs": [
              "The cluster's USDC mint, the only quote mint of curve-mode series (SPEC §9; zero disables",
              "curve mode). Fixed for the life of the deployment (no setter)."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "issuanceResumed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "issuanceStopped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "issuer",
      "docs": [
        "Issuer record (`[ISSUER, wallet]`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "issuanceStopped",
            "type": "bool"
          },
          {
            "name": "seriesCount",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "issuerDeactivated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "issuerRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "mintFinalized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "parametersData",
      "docs": [
        "Borsh-serialisable mirror of [`Parameters`]."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "capMultipleWad",
            "type": "u64"
          },
          {
            "name": "hurdleRateWad",
            "type": "u64"
          },
          {
            "name": "payoutMultipleK",
            "type": "u16"
          },
          {
            "name": "lockupSeconds",
            "type": "u64"
          },
          {
            "name": "walletCapBps",
            "type": "u16"
          },
          {
            "name": "auctionFeeBps",
            "type": "u16"
          },
          {
            "name": "payoutFeeBps",
            "type": "u16"
          },
          {
            "name": "windowFeeBps",
            "type": "u16"
          },
          {
            "name": "nonRevealChargeBps",
            "type": "u16"
          },
          {
            "name": "commitDuration",
            "type": "u64"
          },
          {
            "name": "revealDuration",
            "type": "u64"
          },
          {
            "name": "windowCommitDuration",
            "type": "u64"
          },
          {
            "name": "windowRevealDuration",
            "type": "u64"
          },
          {
            "name": "fxMinCoverageBps",
            "type": "u16"
          },
          {
            "name": "fxMaxStalenessSeconds",
            "type": "u64"
          },
          {
            "name": "fxMaxConfBps",
            "type": "u16"
          },
          {
            "name": "fxDeviationBandBps",
            "type": "u16"
          },
          {
            "name": "maxPauseSeconds",
            "type": "u64"
          },
          {
            "name": "maxCumulativePauseSeconds",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "protocolConfig",
      "docs": [
        "Global protocol configuration, one per deployment (`[CONFIG]`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": "pubkey"
          },
          {
            "name": "allowlistManager",
            "type": "pubkey"
          },
          {
            "name": "feeCollector",
            "type": "pubkey"
          },
          {
            "name": "domain",
            "docs": [
              "`keccak256(1u8 ‖ chain_id_be ‖ registry_program_id)` (SPEC §1.3)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "chainId",
            "type": "u64"
          },
          {
            "name": "newRaisesPaused",
            "type": "bool"
          },
          {
            "name": "windowsEnabled",
            "type": "bool"
          },
          {
            "name": "tier4Enabled",
            "type": "bool"
          },
          {
            "name": "earlyDrawApprover",
            "docs": [
              "Zero when unset (early draws off)."
            ],
            "type": "pubkey"
          },
          {
            "name": "defaults",
            "type": {
              "defined": {
                "name": "parametersData"
              }
            }
          },
          {
            "name": "protocolProgram",
            "docs": [
              "The `merces_protocol` program id, fixed at init (no setter)."
            ],
            "type": "pubkey"
          },
          {
            "name": "protocolAuthority",
            "docs": [
              "`find_program_address([REGISTRY_AUTHORITY], protocol_program)`: the only key allowed to call",
              "the write interface (SPEC §3.2 `registry_authority`)."
            ],
            "type": "pubkey"
          },
          {
            "name": "seriesCount",
            "type": "u64"
          },
          {
            "name": "attestorCount",
            "docs": [
              "Active key counts (a kind's last active key cannot be revoked, SPEC §1.4)."
            ],
            "type": "u32"
          },
          {
            "name": "verifierCount",
            "type": "u32"
          },
          {
            "name": "curveQuoteMint",
            "docs": [
              "The only quote mint curve-mode series may use (USDC of the cluster, SPEC §9), fixed at init",
              "(no setter); zero disables curve mode."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "protocolInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "allowlistManager",
            "type": "pubkey"
          },
          {
            "name": "feeCollector",
            "type": "pubkey"
          },
          {
            "name": "chainId",
            "type": "u64"
          },
          {
            "name": "domain",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "protocolProgram",
            "type": "pubkey"
          },
          {
            "name": "protocolAuthority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "raiseStateChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "state",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "series",
      "docs": [
        "One raise by one issuer (`[SERIES, series_id_le]`). The charter block is frozen once",
        "`raise_state != Draft` (SPEC §3.3)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "seriesId",
            "type": "u64"
          },
          {
            "name": "issuer",
            "type": "pubkey"
          },
          {
            "name": "mode",
            "type": "u8"
          },
          {
            "name": "stablecoin",
            "type": "pubkey"
          },
          {
            "name": "stablecoinDecimals",
            "type": "u8"
          },
          {
            "name": "stablecoinProgram",
            "docs": [
              "The stablecoin mint's owner program (SPL Token or Token-2022)."
            ],
            "type": "pubkey"
          },
          {
            "name": "unitMint",
            "docs": [
              "Set by `mark_raise_opened` (sealed bid) or `mark_curve_activated` (curve)."
            ],
            "type": "pubkey"
          },
          {
            "name": "unitsOffered",
            "type": "u64"
          },
          {
            "name": "reservePrice",
            "type": "u64"
          },
          {
            "name": "minRaise",
            "type": "u64"
          },
          {
            "name": "capMultipleWad",
            "type": "u64"
          },
          {
            "name": "hurdleRateWad",
            "type": "u64"
          },
          {
            "name": "payoutMultipleK",
            "type": "u16"
          },
          {
            "name": "lockupSeconds",
            "type": "u64"
          },
          {
            "name": "walletCapBps",
            "type": "u16"
          },
          {
            "name": "auctionFeeBps",
            "type": "u16"
          },
          {
            "name": "payoutFeeBps",
            "type": "u16"
          },
          {
            "name": "windowFeeBps",
            "type": "u16"
          },
          {
            "name": "nonRevealChargeBps",
            "type": "u16"
          },
          {
            "name": "commitDuration",
            "type": "u64"
          },
          {
            "name": "revealDuration",
            "type": "u64"
          },
          {
            "name": "windowCommitDuration",
            "type": "u64"
          },
          {
            "name": "windowRevealDuration",
            "type": "u64"
          },
          {
            "name": "fxMinCoverageBps",
            "type": "u16"
          },
          {
            "name": "maxPauseSeconds",
            "type": "u64"
          },
          {
            "name": "maxCumulativePauseSeconds",
            "type": "u64"
          },
          {
            "name": "releaseSchedule",
            "type": {
              "vec": {
                "defined": {
                  "name": "trancheData"
                }
              }
            }
          },
          {
            "name": "contractHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tierFlags",
            "type": "u8"
          },
          {
            "name": "fxPairId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "issuerAcceptsPublicPrice",
            "type": "bool"
          },
          {
            "name": "metadataUri",
            "type": "string"
          },
          {
            "name": "routerTheta",
            "docs": [
              "Tier-1 plaintext terms (zero unless bit0 of `tier_flags` is set)."
            ],
            "type": "u64"
          },
          {
            "name": "routerRWad",
            "type": "u64"
          },
          {
            "name": "termsCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amendmentNonce",
            "type": "u64"
          },
          {
            "name": "raiseState",
            "type": "u8"
          },
          {
            "name": "openedAt",
            "type": "u64"
          },
          {
            "name": "settlementTs",
            "type": "u64"
          },
          {
            "name": "unitsSold",
            "type": "u64"
          },
          {
            "name": "clearingPrice",
            "type": "u64"
          },
          {
            "name": "mintFinalized",
            "type": "bool"
          },
          {
            "name": "terminalStatus",
            "type": "u8"
          },
          {
            "name": "auctionEscrowAta",
            "type": "pubkey"
          },
          {
            "name": "windowEscrowAta",
            "type": "pubkey"
          },
          {
            "name": "dbcConfig",
            "type": "pubkey"
          },
          {
            "name": "dbcPool",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "dbcCreator",
            "docs": [
              "`pool.creator` of the DBC pool at activation: the issuer wallet or the protocol's",
              "`curve_authority` PDA (CURVE_MODE §6)."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "seriesCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "seriesId",
            "type": "u64"
          },
          {
            "name": "issuer",
            "type": "pubkey"
          },
          {
            "name": "mode",
            "type": "u8"
          },
          {
            "name": "stablecoin",
            "type": "pubkey"
          },
          {
            "name": "unitsOffered",
            "type": "u64"
          },
          {
            "name": "reservePrice",
            "type": "u64"
          },
          {
            "name": "minRaise",
            "type": "u64"
          },
          {
            "name": "capMultipleWad",
            "type": "u64"
          },
          {
            "name": "hurdleRateWad",
            "type": "u64"
          },
          {
            "name": "k",
            "type": "u16"
          },
          {
            "name": "lockupSeconds",
            "type": "u64"
          },
          {
            "name": "walletCapBps",
            "type": "u16"
          },
          {
            "name": "auctionFeeBps",
            "type": "u16"
          },
          {
            "name": "payoutFeeBps",
            "type": "u16"
          },
          {
            "name": "windowFeeBps",
            "type": "u16"
          },
          {
            "name": "nonRevealChargeBps",
            "type": "u16"
          },
          {
            "name": "termsCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tierFlags",
            "type": "u8"
          },
          {
            "name": "fxPairId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "terminalStatusSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "termsAmended",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "newTermsCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "newCapMultipleWad",
            "type": "u64"
          },
          {
            "name": "attestor",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          }
        ]
      }
    },
    {
      "name": "tier1Terms",
      "docs": [
        "Plaintext tier-1 terms (public by the issuer's choice, SPEC §6.5); checked against",
        "`terms_commitment` with Poseidon(5) at series creation."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "theta",
            "type": "u64"
          },
          {
            "name": "rWad",
            "type": "u64"
          },
          {
            "name": "currencyCode",
            "type": "u32"
          },
          {
            "name": "indexingRule",
            "type": "u32"
          },
          {
            "name": "termsSalt",
            "docs": [
              "The commitment salt as a 32-byte big-endian field element."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "trancheData",
      "docs": [
        "Borsh-serialisable mirror of [`Tranche`]."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "atOffsetSeconds",
            "type": "u64"
          },
          {
            "name": "bps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "verifierKey",
      "docs": [
        "Report-verifier key (`[VERIFIER, addr20]`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "addr",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "revokedAt",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "verifierKeyRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "addr",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          }
        ]
      }
    },
    {
      "name": "verifierKeyRevoked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "addr",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "revokedAt",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
