/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/merces_hook.json`.
 */
export type MercesHook = {
  "address": "2PuKMkGkGLCwsDMLCmm2bcbzjxtabvt9LVJni154ezRt",
  "metadata": {
    "name": "mercesHook",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Merces Token-2022 transfer hook: window-only transfers, allowlist and wallet cap for sealed-bid unit mints (SPEC §4.1)."
  },
  "instructions": [
    {
      "name": "execute",
      "docs": [
        "Called by Token-2022 on every transfer of the mint."
      ],
      "discriminator": [
        105,
        37,
        101,
        197,
        75,
        251,
        102,
        26
      ],
      "accounts": [
        {
          "name": "sourceToken"
        },
        {
          "name": "mint"
        },
        {
          "name": "destinationToken"
        },
        {
          "name": "owner"
        },
        {
          "name": "extraAccountMetaList",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
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
            ],
            "program": {
              "kind": "const",
              "value": [
                233,
                140,
                196,
                223,
                74,
                68,
                32,
                241,
                220,
                208,
                248,
                162,
                204,
                221,
                84,
                248,
                15,
                242,
                187,
                12,
                240,
                93,
                60,
                74,
                11,
                246,
                4,
                154,
                152,
                79,
                137,
                239
              ]
            }
          }
        },
        {
          "name": "series"
        },
        {
          "name": "escrowArm",
          "docs": [
            "validated (address, owner) in `read_arm`."
          ]
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializeExtraAccountMetaList",
      "docs": [
        "Creates the `ExtraAccountMetaList` for a unit mint. The mint authority (the protocol's",
        "`auction_authority` PDA) must sign, so only `merces_protocol::open_raise` can call this",
        "for a Merces mint, and the registry must already map the series to the mint."
      ],
      "discriminator": [
        43,
        34,
        13,
        49,
        167,
        88,
        235,
        235
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "extraAccountMetaList",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "mintAuthority",
          "signer": true
        },
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
            ],
            "program": {
              "kind": "const",
              "value": [
                233,
                140,
                196,
                223,
                74,
                68,
                32,
                241,
                220,
                208,
                248,
                162,
                204,
                221,
                84,
                248,
                15,
                242,
                187,
                12,
                240,
                93,
                60,
                74,
                11,
                246,
                4,
                154,
                152,
                79,
                137,
                239
              ]
            }
          }
        },
        {
          "name": "series",
          "docs": [
            "The registry series that owns `mint` (`series.unit_mint == mint`, written by `mark_raise_opened`)."
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "directTransferForbidden",
      "msg": "Direct wallet-to-wallet transfers of sealed-bid units are forbidden; use a transfer window"
    },
    {
      "code": 6001,
      "name": "programCalledOutsideOfTransfer",
      "msg": "The hook was called outside of a Token-2022 transfer"
    },
    {
      "code": 6002,
      "name": "unarmedEscrowDeposit",
      "msg": "Deposit into the window escrow is not armed for this owner and amount"
    },
    {
      "code": 6003,
      "name": "curveModeNoHook",
      "msg": "Curve-mode series units are not governed by this hook"
    },
    {
      "code": 6004,
      "name": "seriesMintMismatch",
      "msg": "Series does not belong to this mint"
    },
    {
      "code": 6005,
      "name": "escrowArmMismatch",
      "msg": "EscrowArm account is not the protocol's PDA for this mint"
    },
    {
      "code": 6006,
      "name": "mintAuthorityMismatch",
      "msg": "Mint authority must sign extra-account-metas initialisation"
    },
    {
      "code": 6007,
      "name": "invalidTokenAccount",
      "msg": "Token account could not be read"
    },
    {
      "code": 6008,
      "name": "extraAccountsMismatch",
      "msg": "Extra account list does not match the mint's ExtraAccountMetaList"
    }
  ],
  "types": [
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
    }
  ]
};
