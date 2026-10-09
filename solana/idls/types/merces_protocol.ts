/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/merces_protocol.json`.
 */
export type MercesProtocol = {
  "address": "EuaPg2nTXsf3CmmeJMfdiQb4C2hU7AfLfFyDLpD69six",
  "metadata": {
    "name": "mercesProtocol",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Merces protocol: sealed-bid auction, treasury, ProofOfIncome verifier, split router, rate accumulator, payout vault, redemption/tail/pause/extinguishment and transfer window (SPEC §5–§7)."
  },
  "instructions": [
    {
      "name": "approvePause",
      "discriminator": [
        149,
        48,
        3,
        81,
        156,
        74,
        195,
        172
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
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "attestorKey"
        }
      ],
      "args": [
        {
          "name": "pauseEnd",
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
      "name": "beginSettlement",
      "discriminator": [
        124,
        223,
        80,
        249,
        19,
        59,
        26,
        92
      ],
      "accounts": [
        {
          "name": "series"
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "clearingPrice",
          "type": "u64"
        },
        {
          "name": "qAboveClaim",
          "type": "u64"
        },
        {
          "name": "qAtClaim",
          "type": "u64"
        }
      ]
    },
    {
      "name": "beginTakeback",
      "discriminator": [
        216,
        255,
        139,
        188,
        116,
        16,
        91,
        86
      ],
      "accounts": [
        {
          "name": "series"
        },
        {
          "name": "window",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "revealIndex",
          "type": "u32"
        }
      ]
    },
    {
      "name": "beginWindowSettlement",
      "discriminator": [
        243,
        202,
        174,
        1,
        214,
        69,
        188,
        176
      ],
      "accounts": [
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "window",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "clearingPrice",
          "type": "u64"
        },
        {
          "name": "noMatch",
          "type": "bool"
        }
      ]
    },
    {
      "name": "burnRetired",
      "discriminator": [
        228,
        173,
        81,
        177,
        162,
        172,
        101,
        104
      ],
      "accounts": [
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "holder",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "holderWallet"
              }
            ]
          }
        },
        {
          "name": "holderWallet"
        },
        {
          "name": "holderUnitAta",
          "writable": true
        },
        {
          "name": "vaultAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "unitMint",
          "writable": true
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": []
    },
    {
      "name": "cancelRaise",
      "discriminator": [
        93,
        123,
        204,
        79,
        107,
        196,
        120,
        217
      ],
      "accounts": [
        {
          "name": "issuer",
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
          "writable": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "unitMint",
          "docs": [
            "minted for a cancelled raise)."
          ],
          "writable": true
        },
        {
          "name": "auctionAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "registryAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "registryProgram",
          "address": "GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi"
        }
      ],
      "args": []
    },
    {
      "name": "claim",
      "discriminator": [
        62,
        198,
        214,
        193,
        213,
        159,
        108,
        210
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "holder",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "holderWallet"
              }
            ]
          }
        },
        {
          "name": "holderWallet"
        },
        {
          "name": "holderUnitAta",
          "writable": true
        },
        {
          "name": "holderStableAta",
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "unitMint",
          "writable": true
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "claimFinal",
      "discriminator": [
        168,
        108,
        208,
        13,
        198,
        126,
        106,
        235
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "holder",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "holderWallet"
              }
            ]
          }
        },
        {
          "name": "holderWallet"
        },
        {
          "name": "holderUnitAta",
          "writable": true
        },
        {
          "name": "holderStableAta",
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "unitMint",
          "writable": true
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "claimRedemption",
      "discriminator": [
        109,
        110,
        9,
        188,
        195,
        217,
        112,
        83
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "holder",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "holderWallet"
              }
            ]
          }
        },
        {
          "name": "holderWallet"
        },
        {
          "name": "holderUnitAta",
          "writable": true
        },
        {
          "name": "holderStableAta",
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "unitMint",
          "writable": true
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "claimRelease",
      "discriminator": [
        32,
        49,
        104,
        71,
        174,
        25,
        58,
        118
      ],
      "accounts": [
        {
          "name": "issuer",
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasuryToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasuryAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "issuerStable",
          "writable": true
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        }
      ],
      "args": []
    },
    {
      "name": "claimTail",
      "discriminator": [
        229,
        158,
        116,
        28,
        94,
        146,
        231,
        110
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "holder",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "holderWallet"
              }
            ]
          }
        },
        {
          "name": "holderWallet"
        },
        {
          "name": "holderUnitAta",
          "writable": true
        },
        {
          "name": "holderStableAta",
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "unitMint",
          "writable": true
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closeRouterPeriod",
      "discriminator": [
        69,
        252,
        72,
        12,
        128,
        169,
        239,
        181
      ],
      "accounts": [
        {
          "name": "series"
        },
        {
          "name": "router",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "period",
          "type": "u32"
        }
      ]
    },
    {
      "name": "commitAsk",
      "discriminator": [
        30,
        63,
        84,
        0,
        233,
        247,
        91,
        51
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "window",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "holder",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "escrowArm",
          "docs": [
            "Armed by this instruction right before the transfer and cleared after it (SPEC §4.1)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  114,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "unitMint"
              }
            ]
          }
        },
        {
          "name": "ownerUnitAta",
          "writable": true
        },
        {
          "name": "windowEscrowAta",
          "writable": true
        },
        {
          "name": "unitMint"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "commitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "units",
          "type": "u64"
        }
      ]
    },
    {
      "name": "commitBid",
      "discriminator": [
        149,
        237,
        198,
        113,
        53,
        66,
        70,
        76
      ],
      "accounts": [
        {
          "name": "bidder",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "bidderAllowlist",
          "docs": [
            "owner, `allowed`) right after the raise-state check."
          ]
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "bid",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  105,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "bidder"
              }
            ]
          }
        },
        {
          "name": "bidderStable",
          "writable": true
        },
        {
          "name": "escrowToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "commitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "escrow",
          "type": "u64"
        }
      ]
    },
    {
      "name": "crankStatus",
      "discriminator": [
        69,
        67,
        28,
        149,
        44,
        85,
        125,
        85
      ],
      "accounts": [
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "deliverBid",
      "discriminator": [
        112,
        17,
        157,
        232,
        139,
        0,
        81,
        61
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "bid",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  105,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "bidder"
              }
            ]
          }
        },
        {
          "name": "bidder"
        },
        {
          "name": "holder",
          "docs": [
            "Required when units are pending (every winner has one from `process_bid`)."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "bidder"
              }
            ]
          }
        },
        {
          "name": "bidderStableAta",
          "writable": true
        },
        {
          "name": "bidderUnitAta",
          "writable": true
        },
        {
          "name": "escrowAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "escrowToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "auctionEscrowAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "auctionEscrowAta",
          "writable": true
        },
        {
          "name": "unitMint"
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "deliverOrder",
      "discriminator": [
        196,
        161,
        127,
        199,
        67,
        133,
        163,
        104
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "window",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner"
        },
        {
          "name": "holder",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "ownerUnitAta",
          "writable": true
        },
        {
          "name": "ownerStableAta",
          "writable": true
        },
        {
          "name": "windowEscrowAta",
          "writable": true
        },
        {
          "name": "windowStable",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119,
                  95,
                  115,
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "windowEscrowAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "unitMint"
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "endPause",
      "discriminator": [
        168,
        253,
        217,
        210,
        39,
        68,
        102,
        122
      ],
      "accounts": [
        {
          "name": "issuer",
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "extinguish",
      "discriminator": [
        67,
        56,
        159,
        245,
        251,
        97,
        178,
        201
      ],
      "accounts": [
        {
          "name": "payer",
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
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasuryToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasuryAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "attestorKeyA"
        },
        {
          "name": "attestorKeyB"
        },
        {
          "name": "registryAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "registryProgram",
          "address": "GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi"
        }
      ],
      "args": [
        {
          "name": "attestorA",
          "type": {
            "array": [
              "u8",
              20
            ]
          }
        },
        {
          "name": "sigA",
          "type": {
            "array": [
              "u8",
              65
            ]
          }
        },
        {
          "name": "attestorB",
          "type": {
            "array": [
              "u8",
              20
            ]
          }
        },
        {
          "name": "sigB",
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
      "name": "finalizeSettlement",
      "discriminator": [
        220,
        72,
        152,
        119,
        178,
        196,
        25,
        170
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
          "writable": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "unitMint",
          "docs": [
            "any bid fails here)."
          ],
          "writable": true
        },
        {
          "name": "auctionAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "registryAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "registryProgram",
          "address": "GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi"
        }
      ],
      "args": []
    },
    {
      "name": "finalizeTakeback",
      "discriminator": [
        24,
        86,
        246,
        125,
        207,
        88,
        233,
        87
      ],
      "accounts": [
        {
          "name": "series"
        },
        {
          "name": "window",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "finalizeWindow",
      "discriminator": [
        183,
        76,
        248,
        161,
        196,
        14,
        74,
        46
      ],
      "accounts": [
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "window",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "initFxPair",
      "discriminator": [
        254,
        9,
        109,
        243,
        168,
        168,
        119,
        241
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "pairConfig",
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
          "name": "pair",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  120,
                  112,
                  97,
                  105,
                  114
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
        }
      ]
    },
    {
      "name": "initRouter",
      "discriminator": [
        234,
        132,
        181,
        34,
        176,
        101,
        142,
        94
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "router",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "routerAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101,
                  114,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "routerToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101,
                  114,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "openRaise",
      "discriminator": [
        131,
        238,
        79,
        115,
        242,
        135,
        142,
        242
      ],
      "accounts": [
        {
          "name": "issuer",
          "writable": true,
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
          "writable": true
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
                "path": "issuer"
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
          "name": "unitMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  110,
                  105,
                  116,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "auctionAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "auctionEscrowAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "auctionEscrowAta",
          "writable": true
        },
        {
          "name": "windowEscrowAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "windowEscrowAta",
          "writable": true
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
                "path": "unitMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                20,
                185,
                158,
                131,
                137,
                165,
                81,
                158,
                30,
                216,
                124,
                16,
                183,
                70,
                79,
                255,
                98,
                165,
                132,
                92,
                217,
                45,
                170,
                189,
                13,
                184,
                165,
                199,
                152,
                190,
                53,
                159
              ]
            }
          }
        },
        {
          "name": "registryAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "hookProgram",
          "address": "2PuKMkGkGLCwsDMLCmm2bcbzjxtabvt9LVJni154ezRt"
        },
        {
          "name": "registryProgram",
          "address": "GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "openWindow",
      "discriminator": [
        51,
        40,
        53,
        181,
        170,
        43,
        128,
        168
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
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
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "window",
          "docs": [
            "`init_if_needed` so a second `open_window` for the same period reverts `WindowAlreadyOpen`",
            "instead of failing account creation; the handler refuses any already-used window account."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "arg",
                "path": "period"
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
          "name": "period",
          "type": "u32"
        }
      ]
    },
    {
      "name": "pay",
      "discriminator": [
        119,
        18,
        216,
        65,
        192,
        117,
        122,
        220
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
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
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "report",
          "docs": [
            "The report of the open due period (`pay`); unused by `pay_trueup`."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  112,
                  111,
                  114,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "report.period",
                "account": "report"
              }
            ]
          }
        },
        {
          "name": "payerStable",
          "docs": [
            "The payer's stablecoin account; `dup` because the issuer usually pays from the same account",
            "that receives truncation refunds (`issuer_stable_ata`)."
          ],
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "issuer"
        },
        {
          "name": "issuerStableAta",
          "writable": true
        },
        {
          "name": "feeCollectorAta",
          "writable": true
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "registryAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "registryProgram",
          "address": "GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "payTrueup",
      "discriminator": [
        223,
        249,
        33,
        64,
        76,
        143,
        123,
        155
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
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
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "report",
          "docs": [
            "The report of the open due period (`pay`); unused by `pay_trueup`."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  112,
                  111,
                  114,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "report.period",
                "account": "report"
              }
            ]
          }
        },
        {
          "name": "payerStable",
          "docs": [
            "The payer's stablecoin account; `dup` because the issuer usually pays from the same account",
            "that receives truncation refunds (`issuer_stable_ata`)."
          ],
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "issuer"
        },
        {
          "name": "issuerStableAta",
          "writable": true
        },
        {
          "name": "feeCollectorAta",
          "writable": true
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "registryAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "registryProgram",
          "address": "GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "prepareRaise",
      "discriminator": [
        244,
        88,
        176,
        16,
        31,
        248,
        5,
        216
      ],
      "accounts": [
        {
          "name": "issuer",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "unitMint",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  110,
                  105,
                  116,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "escrowAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasuryAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "windowEscrowAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "escrowArm",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  114,
                  109
                ]
              },
              {
                "kind": "account",
                "path": "unitMint"
              }
            ]
          }
        },
        {
          "name": "escrowToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasuryToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "windowStable",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119,
                  95,
                  115,
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "processBid",
      "discriminator": [
        218,
        244,
        13,
        56,
        52,
        34,
        110,
        206
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
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
          "writable": true
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "bid",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  105,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "bidder"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "holder",
          "docs": [
            "allocated."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "bidder"
              }
            ]
          }
        },
        {
          "name": "bidder"
        },
        {
          "name": "escrowAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "auctionAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "escrowToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasuryToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "feeCollectorAta",
          "writable": true
        },
        {
          "name": "auctionEscrowAta",
          "writable": true
        },
        {
          "name": "unitMint",
          "writable": true
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "registryAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "registryProgram",
          "address": "GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "processOrder",
      "discriminator": [
        126,
        54,
        252,
        181,
        254,
        163,
        107,
        165
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
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
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "window",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "owner"
        },
        {
          "name": "holder",
          "docs": [
            "fill, required (registered) for a seller."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "ownerAllowlist",
          "docs": [
            "missing entry reads as not allowed) so the buyer re-check at fill cannot be bypassed or",
            "forced by omission. Ignored for asks."
          ],
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
                "path": "owner"
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
          "name": "ownerUnitAta"
        },
        {
          "name": "windowStable",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119,
                  95,
                  115,
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "windowEscrowAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "feeCollectorAta",
          "writable": true
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "redeem",
      "discriminator": [
        184,
        12,
        86,
        149,
        70,
        196,
        97,
        225
      ],
      "accounts": [
        {
          "name": "issuer",
          "writable": true,
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
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "issuerStable",
          "writable": true
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "registryAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "registryProgram",
          "address": "GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi"
        }
      ],
      "args": []
    },
    {
      "name": "registerHolder",
      "discriminator": [
        113,
        111,
        117,
        246,
        175,
        59,
        98,
        161
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
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
                "kind": "arg",
                "path": "wallet"
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
          "name": "holder",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
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
      "name": "requestEarlyDraw",
      "discriminator": [
        63,
        30,
        179,
        170,
        248,
        153,
        55,
        45
      ],
      "accounts": [
        {
          "name": "issuer",
          "signer": true
        },
        {
          "name": "approver",
          "docs": [
            "The configured early-draw approver must co-sign (SPEC §5.3). Unset by default."
          ],
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
          "name": "series"
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "ledger",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasuryToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "treasuryAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "issuerStable",
          "writable": true
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
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
      "name": "requestPause",
      "discriminator": [
        4,
        147,
        210,
        86,
        91,
        63,
        156,
        78
      ],
      "accounts": [
        {
          "name": "issuer",
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "retireIfCapped",
      "discriminator": [
        8,
        7,
        41,
        74,
        211,
        35,
        249,
        48
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
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "registryAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "registryProgram",
          "address": "GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi"
        }
      ],
      "args": []
    },
    {
      "name": "revealBid",
      "discriminator": [
        48,
        73,
        28,
        255,
        202,
        126,
        236,
        196
      ],
      "accounts": [
        {
          "name": "bidder",
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "bid",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  105,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "bidder"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "salt",
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
      "name": "revealOrder",
      "discriminator": [
        25,
        244,
        42,
        219,
        17,
        156,
        211,
        74
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "window",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "ownerUnitAta"
        },
        {
          "name": "holder",
          "docs": [
            "undelivered auction and window units count toward the wallet cap."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  104,
                  111,
                  108,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "token2022Program",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "salt",
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
      "name": "route",
      "discriminator": [
        229,
        23,
        203,
        151,
        122,
        227,
        173,
        42
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
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
          "writable": true
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "router",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "routerAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101,
                  114,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "routerToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101,
                  114,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultToken",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  116,
                  111,
                  107,
                  101,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "vaultAuth",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "issuer"
        },
        {
          "name": "issuerStableAta",
          "writable": true
        },
        {
          "name": "feeCollectorAta",
          "writable": true
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "registryAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  121,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "registryProgram",
          "address": "GigVSncHHvrt8kZVHcdZWULqUE52aAZn7GzGaBNVznSi"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "setReleasePause",
      "discriminator": [
        215,
        180,
        122,
        38,
        245,
        241,
        156,
        195
      ],
      "accounts": [
        {
          "name": "issuer",
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "treasury",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "snapshotFx",
      "discriminator": [
        153,
        93,
        61,
        208,
        198,
        250,
        10,
        77
      ],
      "accounts": [
        {
          "name": "keeper",
          "writable": true,
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
          "name": "pairConfig",
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
                "path": "pair.pairId",
                "account": "fxPair"
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
          "name": "pair",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  120,
                  112,
                  97,
                  105,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pair.pairId",
                "account": "fxPair"
              }
            ]
          }
        },
        {
          "name": "checkpoint",
          "docs": [
            "Checkpoint for the current period, created on the first snapshot of the period."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  120,
                  99,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "pair.pairId",
                "account": "fxPair"
              },
              {
                "kind": "arg",
                "path": "period"
              }
            ]
          }
        },
        {
          "name": "priceUpdate",
          "docs": [
            "Owner (Pyth receiver program) and discriminator checked by Anchor."
          ]
        },
        {
          "name": "crosscheckUpdate",
          "docs": [
            "The cross-check feed's update (the pair's `crosscheck`, read as a Pyth feed id); required",
            "once a cross-check is configured and effective for the period."
          ],
          "optional": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "period",
          "type": "u32"
        }
      ]
    },
    {
      "name": "submitReport",
      "discriminator": [
        27,
        178,
        64,
        9,
        20,
        46,
        250,
        14
      ],
      "accounts": [
        {
          "name": "issuer",
          "writable": true,
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
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "report",
          "docs": [
            "`init_if_needed` so a repeated period reverts `WrongPeriod` (the sequential-period rule",
            "guarantees the account of the next expected period is fresh)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  112,
                  111,
                  114,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "arg",
                "path": "args.period"
              }
            ]
          }
        },
        {
          "name": "attestationKey",
          "docs": [
            "validated in the handler. Any account for tiers 1 and 4."
          ]
        },
        {
          "name": "fxAttestorKey"
        },
        {
          "name": "fxPair",
          "docs": [
            "when it exists — a pair never snapshotted reads as `NeedsFallback`). Ignored for stablecoin",
            "income."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  120,
                  112,
                  97,
                  105,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series.fxPairId",
                "account": "series"
              }
            ]
          }
        },
        {
          "name": "fxStart",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  120,
                  99,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "series.fxPairId",
                "account": "series"
              },
              {
                "kind": "arg",
                "path": "args.period"
              }
            ]
          }
        },
        {
          "name": "fxEnd",
          "docs": [
            "stand in only when no snapshot of `period + 1` exists (SPEC §6.6)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  120,
                  99,
                  112
                ]
              },
              {
                "kind": "account",
                "path": "series.fxPairId",
                "account": "series"
              },
              {
                "kind": "arg",
                "path": "args.period.saturatingAdd1"
              }
            ]
          }
        },
        {
          "name": "router",
          "docs": [
            "Tier 1 router (required for tier 1 reports)."
          ],
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
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
              "name": "submitReportArgs"
            }
          }
        }
      ]
    },
    {
      "name": "submitTrueup",
      "discriminator": [
        156,
        160,
        53,
        114,
        184,
        206,
        150,
        251
      ],
      "accounts": [
        {
          "name": "issuer",
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
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "attestorKey"
        }
      ],
      "args": [
        {
          "name": "year",
          "type": "u16"
        },
        {
          "name": "adjustment",
          "type": "i64"
        },
        {
          "name": "attestationTs",
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
      "name": "tallyBids",
      "discriminator": [
        122,
        122,
        63,
        132,
        54,
        0,
        209,
        103
      ],
      "accounts": [
        {
          "name": "series"
        },
        {
          "name": "auction",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  99,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "tallyOrders",
      "discriminator": [
        61,
        95,
        87,
        41,
        53,
        242,
        50,
        199
      ],
      "accounts": [
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "window",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "tallyTakeback",
      "discriminator": [
        20,
        30,
        236,
        82,
        174,
        38,
        9,
        204
      ],
      "accounts": [
        {
          "name": "series"
        },
        {
          "name": "window",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "windowCommitBid",
      "discriminator": [
        215,
        151,
        197,
        55,
        237,
        207,
        13,
        140
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "ownerAllowlist",
          "docs": [
            "`allowed`)."
          ]
        },
        {
          "name": "window",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              },
              {
                "kind": "account",
                "path": "window.period",
                "account": "window"
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "ownerStable",
          "writable": true
        },
        {
          "name": "windowStable",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  105,
                  110,
                  100,
                  111,
                  119,
                  95,
                  115,
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        },
        {
          "name": "stablecoinMint"
        },
        {
          "name": "stablecoinProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "commitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "escrow",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawPauseRequest",
      "discriminator": [
        197,
        231,
        114,
        71,
        130,
        40,
        133,
        119
      ],
      "accounts": [
        {
          "name": "issuer",
          "signer": true
        },
        {
          "name": "series"
        },
        {
          "name": "ledger",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  101,
                  100,
                  103,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "series"
              }
            ]
          }
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "auction",
      "discriminator": [
        218,
        94,
        247,
        242,
        126,
        233,
        131,
        81
      ]
    },
    {
      "name": "bid",
      "discriminator": [
        143,
        246,
        48,
        245,
        42,
        145,
        180,
        88
      ]
    },
    {
      "name": "escrowArm",
      "discriminator": [
        162,
        165,
        18,
        121,
        181,
        42,
        223,
        65
      ]
    },
    {
      "name": "fxCheckpoint",
      "discriminator": [
        11,
        152,
        148,
        148,
        80,
        19,
        149,
        86
      ]
    },
    {
      "name": "fxPair",
      "discriminator": [
        235,
        138,
        221,
        112,
        21,
        75,
        185,
        165
      ]
    },
    {
      "name": "holder",
      "discriminator": [
        37,
        121,
        1,
        40,
        55,
        46,
        199,
        157
      ]
    },
    {
      "name": "ledger",
      "discriminator": [
        43,
        41,
        21,
        213,
        180,
        176,
        95,
        32
      ]
    },
    {
      "name": "order",
      "discriminator": [
        134,
        173,
        223,
        185,
        77,
        86,
        28,
        51
      ]
    },
    {
      "name": "report",
      "discriminator": [
        232,
        246,
        229,
        227,
        242,
        105,
        190,
        2
      ]
    },
    {
      "name": "router",
      "discriminator": [
        94,
        226,
        217,
        169,
        186,
        4,
        198,
        7
      ]
    },
    {
      "name": "treasury",
      "discriminator": [
        238,
        239,
        123,
        238,
        89,
        1,
        168,
        253
      ]
    },
    {
      "name": "window",
      "discriminator": [
        66,
        77,
        66,
        242,
        153,
        13,
        1,
        69
      ]
    }
  ],
  "events": [
    {
      "name": "bidCommitted",
      "discriminator": [
        81,
        13,
        193,
        139,
        0,
        168,
        82,
        55
      ]
    },
    {
      "name": "bidDelivered",
      "discriminator": [
        7,
        57,
        55,
        228,
        231,
        134,
        21,
        65
      ]
    },
    {
      "name": "bidRevealed",
      "discriminator": [
        227,
        144,
        125,
        229,
        28,
        109,
        18,
        209
      ]
    },
    {
      "name": "earlyDrawExecuted",
      "discriminator": [
        209,
        16,
        155,
        22,
        147,
        209,
        185,
        52
      ]
    },
    {
      "name": "finalClaimed",
      "discriminator": [
        186,
        25,
        206,
        197,
        232,
        173,
        198,
        52
      ]
    },
    {
      "name": "formalNoticeDue",
      "discriminator": [
        95,
        174,
        56,
        171,
        60,
        68,
        148,
        0
      ]
    },
    {
      "name": "fxDeviationFlagged",
      "discriminator": [
        106,
        13,
        215,
        88,
        203,
        84,
        151,
        1
      ]
    },
    {
      "name": "fxSnapshot",
      "discriminator": [
        220,
        160,
        9,
        175,
        94,
        68,
        100,
        10
      ]
    },
    {
      "name": "holderRegistered",
      "discriminator": [
        201,
        78,
        223,
        133,
        103,
        164,
        173,
        136
      ]
    },
    {
      "name": "incomeRouted",
      "discriminator": [
        74,
        170,
        11,
        181,
        163,
        82,
        157,
        140
      ]
    },
    {
      "name": "mintAuthorityRevoked",
      "discriminator": [
        2,
        222,
        125,
        58,
        108,
        126,
        254,
        121
      ]
    },
    {
      "name": "nonRevealCharged",
      "discriminator": [
        60,
        146,
        175,
        103,
        182,
        164,
        178,
        169
      ]
    },
    {
      "name": "orderCommitted",
      "discriminator": [
        120,
        115,
        67,
        82,
        131,
        215,
        13,
        83
      ]
    },
    {
      "name": "orderDelivered",
      "discriminator": [
        235,
        100,
        90,
        112,
        48,
        114,
        170,
        75
      ]
    },
    {
      "name": "orderFilled",
      "discriminator": [
        120,
        124,
        109,
        66,
        249,
        116,
        174,
        30
      ]
    },
    {
      "name": "orderRevealed",
      "discriminator": [
        241,
        84,
        202,
        173,
        0,
        48,
        108,
        91
      ]
    },
    {
      "name": "pauseApproved",
      "discriminator": [
        40,
        77,
        179,
        159,
        179,
        219,
        156,
        244
      ]
    },
    {
      "name": "pauseEnded",
      "discriminator": [
        72,
        74,
        19,
        105,
        123,
        35,
        163,
        227
      ]
    },
    {
      "name": "pauseRequestWithdrawn",
      "discriminator": [
        1,
        189,
        151,
        61,
        180,
        5,
        118,
        0
      ]
    },
    {
      "name": "pauseRequested",
      "discriminator": [
        125,
        37,
        174,
        211,
        183,
        55,
        129,
        7
      ]
    },
    {
      "name": "paymentSettled",
      "discriminator": [
        158,
        182,
        152,
        76,
        105,
        23,
        232,
        135
      ]
    },
    {
      "name": "payoutClaimed",
      "discriminator": [
        200,
        39,
        105,
        112,
        116,
        63,
        58,
        149
      ]
    },
    {
      "name": "payoutDistributed",
      "discriminator": [
        115,
        245,
        51,
        199,
        174,
        132,
        93,
        90
      ]
    },
    {
      "name": "raiseCancelled",
      "discriminator": [
        97,
        36,
        168,
        231,
        73,
        9,
        183,
        237
      ]
    },
    {
      "name": "raiseFailed",
      "discriminator": [
        173,
        114,
        142,
        65,
        206,
        43,
        66,
        170
      ]
    },
    {
      "name": "raiseMintFinalized",
      "discriminator": [
        54,
        240,
        19,
        166,
        250,
        47,
        100,
        50
      ]
    },
    {
      "name": "raiseOpened",
      "discriminator": [
        101,
        185,
        168,
        82,
        48,
        206,
        42,
        238
      ]
    },
    {
      "name": "raiseSettled",
      "discriminator": [
        232,
        65,
        241,
        63,
        139,
        70,
        15,
        90
      ]
    },
    {
      "name": "redemptionClaimed",
      "discriminator": [
        107,
        251,
        199,
        213,
        59,
        173,
        53,
        189
      ]
    },
    {
      "name": "releaseClaimed",
      "discriminator": [
        133,
        40,
        237,
        156,
        239,
        255,
        142,
        242
      ]
    },
    {
      "name": "releasePauseSet",
      "discriminator": [
        61,
        166,
        133,
        207,
        49,
        255,
        17,
        2
      ]
    },
    {
      "name": "reportAccepted",
      "discriminator": [
        145,
        20,
        109,
        239,
        250,
        220,
        112,
        36
      ]
    },
    {
      "name": "routerPeriodClosed",
      "discriminator": [
        226,
        132,
        11,
        0,
        100,
        89,
        64,
        83
      ]
    },
    {
      "name": "seriesExtinguished",
      "discriminator": [
        182,
        252,
        152,
        228,
        102,
        90,
        167,
        150
      ]
    },
    {
      "name": "seriesRedeemed",
      "discriminator": [
        189,
        33,
        198,
        46,
        242,
        217,
        224,
        62
      ]
    },
    {
      "name": "seriesRetired",
      "discriminator": [
        159,
        224,
        233,
        125,
        150,
        67,
        182,
        158
      ]
    },
    {
      "name": "settlementProposed",
      "discriminator": [
        139,
        32,
        64,
        205,
        27,
        154,
        100,
        147
      ]
    },
    {
      "name": "settlementRejected",
      "discriminator": [
        150,
        187,
        194,
        237,
        234,
        74,
        188,
        41
      ]
    },
    {
      "name": "statusChanged",
      "discriminator": [
        146,
        235,
        222,
        125,
        145,
        246,
        34,
        240
      ]
    },
    {
      "name": "tailClaimed",
      "discriminator": [
        234,
        226,
        68,
        141,
        117,
        84,
        109,
        65
      ]
    },
    {
      "name": "tailDistributed",
      "discriminator": [
        183,
        217,
        130,
        211,
        149,
        54,
        107,
        192
      ]
    },
    {
      "name": "trueUpPaid",
      "discriminator": [
        250,
        5,
        48,
        117,
        139,
        227,
        221,
        84
      ]
    },
    {
      "name": "trueUpRecorded",
      "discriminator": [
        136,
        108,
        181,
        204,
        83,
        211,
        84,
        110
      ]
    },
    {
      "name": "unitsAllocated",
      "discriminator": [
        35,
        220,
        182,
        208,
        114,
        123,
        48,
        16
      ]
    },
    {
      "name": "unitsBurned",
      "discriminator": [
        42,
        95,
        38,
        222,
        211,
        129,
        9,
        122
      ]
    },
    {
      "name": "windowCleared",
      "discriminator": [
        198,
        19,
        200,
        5,
        204,
        56,
        177,
        210
      ]
    },
    {
      "name": "windowNoMatch",
      "discriminator": [
        49,
        227,
        216,
        91,
        203,
        74,
        110,
        30
      ]
    },
    {
      "name": "windowOpened",
      "discriminator": [
        159,
        141,
        177,
        171,
        68,
        255,
        97,
        133
      ]
    },
    {
      "name": "windowSettlementProposed",
      "discriminator": [
        92,
        218,
        72,
        249,
        44,
        84,
        239,
        104
      ]
    },
    {
      "name": "windowSettlementRejected",
      "discriminator": [
        155,
        179,
        67,
        242,
        208,
        249,
        237,
        174
      ]
    },
    {
      "name": "windowTakebackProposed",
      "discriminator": [
        175,
        181,
        87,
        233,
        19,
        25,
        185,
        15
      ]
    },
    {
      "name": "windowTakebackRejected",
      "discriminator": [
        74,
        219,
        136,
        150,
        247,
        227,
        202,
        98
      ]
    },
    {
      "name": "windowTakebackSettled",
      "discriminator": [
        22,
        141,
        9,
        4,
        150,
        133,
        92,
        157
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6001,
      "name": "divisionByZero",
      "msg": "Division by zero"
    },
    {
      "code": 6002,
      "name": "invalidInput",
      "msg": "Invalid input"
    },
    {
      "code": 6003,
      "name": "negativeTimestamp",
      "msg": "Clock returned a negative timestamp"
    },
    {
      "code": 6004,
      "name": "notIssuer",
      "msg": "Caller is not the series issuer"
    },
    {
      "code": 6005,
      "name": "notSealedBid",
      "msg": "Series is not a sealed-bid series"
    },
    {
      "code": 6006,
      "name": "notDraft",
      "msg": "Series is not in Draft state"
    },
    {
      "code": 6007,
      "name": "contractHashNotSet",
      "msg": "Contract hash is not set"
    },
    {
      "code": 6008,
      "name": "newRaisesPaused",
      "msg": "New raises are paused"
    },
    {
      "code": 6009,
      "name": "notAllowlisted",
      "msg": "Wallet is not allowlisted"
    },
    {
      "code": 6010,
      "name": "raiseNotOpen",
      "msg": "Raise is not open"
    },
    {
      "code": 6011,
      "name": "raiseHasBids",
      "msg": "Raise already has bids"
    },
    {
      "code": 6012,
      "name": "commitPhaseOver",
      "msg": "Commit phase has ended"
    },
    {
      "code": 6013,
      "name": "notRevealPhase",
      "msg": "Not in the reveal phase"
    },
    {
      "code": 6014,
      "name": "revealPhaseNotOver",
      "msg": "Reveal phase has not ended"
    },
    {
      "code": 6015,
      "name": "zeroEscrow",
      "msg": "Escrow must be positive"
    },
    {
      "code": 6016,
      "name": "alreadyRevealed",
      "msg": "Bid already revealed"
    },
    {
      "code": 6017,
      "name": "commitmentMismatch",
      "msg": "Commitment does not match the revealed values"
    },
    {
      "code": 6018,
      "name": "tallyInProgress",
      "msg": "A settlement tally is in progress; it cannot be reset"
    },
    {
      "code": 6019,
      "name": "notSettling",
      "msg": "Auction is not settling"
    },
    {
      "code": 6020,
      "name": "bidSeriesMismatch",
      "msg": "Bid account is not a bid of this series"
    },
    {
      "code": 6021,
      "name": "bidPdaMismatch",
      "msg": "Bid account is not the expected PDA"
    },
    {
      "code": 6022,
      "name": "tallyPageTooLarge",
      "msg": "Too many accounts in one tally page"
    },
    {
      "code": 6023,
      "name": "tallyIncomplete",
      "msg": "Not every revealed bid has been tallied in this round"
    },
    {
      "code": 6024,
      "name": "notSettledOrFailed",
      "msg": "Auction has not settled or failed"
    },
    {
      "code": 6025,
      "name": "raiseNotSettled",
      "msg": "The raise is not Settled"
    },
    {
      "code": 6026,
      "name": "bidAlreadyProcessed",
      "msg": "Bid already processed"
    },
    {
      "code": 6027,
      "name": "bidNotProcessed",
      "msg": "Bid has not been processed yet"
    },
    {
      "code": 6028,
      "name": "bidAlreadyDelivered",
      "msg": "Bid already delivered"
    },
    {
      "code": 6029,
      "name": "mintedUnitsMismatch",
      "msg": "Minted units do not equal units sold"
    },
    {
      "code": 6030,
      "name": "proceedsMismatch",
      "msg": "Treasury deposits do not sum to the proceeds"
    },
    {
      "code": 6031,
      "name": "escrowAccountMismatch",
      "msg": "Escrow token account is not the recorded protocol escrow"
    },
    {
      "code": 6032,
      "name": "stablecoinMismatch",
      "msg": "Stablecoin account mint mismatch"
    },
    {
      "code": 6033,
      "name": "tokenProgramMismatch",
      "msg": "Token program is not the mint's owner"
    },
    {
      "code": 6034,
      "name": "transferFeeNotZero",
      "msg": "Stablecoin transfer fee is not zero"
    },
    {
      "code": 6035,
      "name": "invalidMint",
      "msg": "Mint account could not be read"
    },
    {
      "code": 6036,
      "name": "ataMismatch",
      "msg": "Token account is not the expected associated token account"
    },
    {
      "code": 6037,
      "name": "unitMintMismatch",
      "msg": "Unit mint does not match the series"
    },
    {
      "code": 6038,
      "name": "mintNotFinalized",
      "msg": "Mint is not finalised"
    },
    {
      "code": 6039,
      "name": "releasesPausedByIssuer",
      "msg": "Issuer has paused releases"
    },
    {
      "code": 6040,
      "name": "seriesLate",
      "msg": "Series is Late; releases are blocked"
    },
    {
      "code": 6041,
      "name": "seriesExtinguished",
      "msg": "Series is extinguished"
    },
    {
      "code": 6042,
      "name": "nothingVested",
      "msg": "Nothing vested to release"
    },
    {
      "code": 6043,
      "name": "earlyDrawApproverUnset",
      "msg": "Early-draw approver is not configured"
    },
    {
      "code": 6044,
      "name": "earlyDrawApproverMismatch",
      "msg": "Early-draw approver must co-sign"
    },
    {
      "code": 6045,
      "name": "earlyDrawExceedsProceeds",
      "msg": "Early draw exceeds the remaining proceeds"
    },
    {
      "code": 6046,
      "name": "terminalStatus",
      "msg": "Series is in a terminal status"
    },
    {
      "code": 6047,
      "name": "wrongPeriod",
      "msg": "Report period is not the next expected period"
    },
    {
      "code": 6048,
      "name": "periodNotEnded",
      "msg": "The period has not ended yet"
    },
    {
      "code": 6049,
      "name": "dueOutstanding",
      "msg": "A previous due amount is still open"
    },
    {
      "code": 6050,
      "name": "tailEnded",
      "msg": "Tail reporting window has ended"
    },
    {
      "code": 6051,
      "name": "noTailDue",
      "msg": "No tail is due for this series"
    },
    {
      "code": 6052,
      "name": "tierNotEnabled",
      "msg": "Tier is not enabled for this series"
    },
    {
      "code": 6053,
      "name": "tier1NotExclusive",
      "msg": "Tier 1 reports are only valid for pure on-chain-income series"
    },
    {
      "code": 6054,
      "name": "tier4Disabled",
      "msg": "Tier 4 self-attestation is disabled"
    },
    {
      "code": 6055,
      "name": "fxMustBeOne",
      "msg": "fx_avg_wad must equal WAD for stablecoin income"
    },
    {
      "code": 6056,
      "name": "fxAverageMismatch",
      "msg": "fx_avg_wad does not match the quarter average"
    },
    {
      "code": 6057,
      "name": "fxNeedsFallback",
      "msg": "FX pair needs a fallback rate; an attestor signature is required"
    },
    {
      "code": 6058,
      "name": "fxFallbackNotNeeded",
      "msg": "FX fallback signature supplied but the pair did not need a fallback"
    },
    {
      "code": 6059,
      "name": "fxCheckpointMismatch",
      "msg": "FX accumulator or checkpoint account mismatch"
    },
    {
      "code": 6060,
      "name": "priorCommitmentMismatch",
      "msg": "Prior income commitment does not match the chain"
    },
    {
      "code": 6061,
      "name": "invalidProof",
      "msg": "Groth16 proof is invalid"
    },
    {
      "code": 6062,
      "name": "malformedProof",
      "msg": "Proof bytes are malformed"
    },
    {
      "code": 6063,
      "name": "publicInputNotCanonical",
      "msg": "Public input is not a canonical field element"
    },
    {
      "code": 6064,
      "name": "malformedSignature",
      "msg": "Attestation signature is malformed"
    },
    {
      "code": 6065,
      "name": "signatureRecoveryFailed",
      "msg": "Attestation signature recovery failed"
    },
    {
      "code": 6066,
      "name": "signerMismatch",
      "msg": "Recovered signer is not the supplied key"
    },
    {
      "code": 6067,
      "name": "verifierKeyInactive",
      "msg": "Verifier key is not active (or outside its revocation grace)"
    },
    {
      "code": 6068,
      "name": "attestorInactive",
      "msg": "Attestor key is not active (or outside its revocation grace)"
    },
    {
      "code": 6069,
      "name": "keyAccountMismatch",
      "msg": "Attestation key account is not the expected registry PDA"
    },
    {
      "code": 6070,
      "name": "attestationRequired",
      "msg": "Attestation required for this tier"
    },
    {
      "code": 6071,
      "name": "routerPeriodNotClosed",
      "msg": "Router checkpoint for the period is missing"
    },
    {
      "code": 6072,
      "name": "routerRequired",
      "msg": "Router account required for a tier 1 report"
    },
    {
      "code": 6073,
      "name": "routerCommitmentMismatch",
      "msg": "Income commitment does not match the router checkpoint"
    },
    {
      "code": 6074,
      "name": "nothingDue",
      "msg": "No due amount to pay"
    },
    {
      "code": 6075,
      "name": "noUnitsOutstanding",
      "msg": "Units outstanding is zero"
    },
    {
      "code": 6076,
      "name": "trueUpYearUsed",
      "msg": "A true-up was already recorded for this year"
    },
    {
      "code": 6077,
      "name": "trueUpYearNotEnded",
      "msg": "True-up year has not ended"
    },
    {
      "code": 6078,
      "name": "trueUpYearIncomplete",
      "msg": "Not every period of the true-up year has an accepted report"
    },
    {
      "code": 6079,
      "name": "trueUpOutstanding",
      "msg": "The previous true-up is still unpaid"
    },
    {
      "code": 6080,
      "name": "trueUpExceedsYear",
      "msg": "Negative true-up exceeds the year's accepted payments"
    },
    {
      "code": 6081,
      "name": "trueUpTimestampInFuture",
      "msg": "True-up attestation timestamp is in the future"
    },
    {
      "code": 6082,
      "name": "noTrueUpDue",
      "msg": "No true-up is due"
    },
    {
      "code": 6083,
      "name": "holderNotRegistered",
      "msg": "Holder is not registered for this series"
    },
    {
      "code": 6084,
      "name": "notRetired",
      "msg": "Series is not retired"
    },
    {
      "code": 6085,
      "name": "notRedeemed",
      "msg": "Series is not redeemed"
    },
    {
      "code": 6086,
      "name": "notExtinguished",
      "msg": "Series is not extinguished"
    },
    {
      "code": 6087,
      "name": "lockupActive",
      "msg": "Lockup has not ended"
    },
    {
      "code": 6088,
      "name": "noRedeemedUnits",
      "msg": "Holder has no redeemed units"
    },
    {
      "code": 6089,
      "name": "deliverFirst",
      "msg": "Pending auction or window units must be delivered first (deliver_bid / deliver_order)"
    },
    {
      "code": 6090,
      "name": "askEscrowOutstanding",
      "msg": "Units escrowed in a window must be processed before redemption"
    },
    {
      "code": 6091,
      "name": "zeroUnits",
      "msg": "Units must be positive"
    },
    {
      "code": 6092,
      "name": "pauseNotRequested",
      "msg": "Pause not requested by the issuer"
    },
    {
      "code": 6093,
      "name": "alreadyPaused",
      "msg": "Series is already paused"
    },
    {
      "code": 6094,
      "name": "notPaused",
      "msg": "Series is not paused"
    },
    {
      "code": 6095,
      "name": "pauseEndInPast",
      "msg": "Pause end must be in the future"
    },
    {
      "code": 6096,
      "name": "pauseTooLong",
      "msg": "Pause exceeds max_pause_seconds"
    },
    {
      "code": 6097,
      "name": "pauseCumulativeExceeded",
      "msg": "Cumulative pause exceeds max_cumulative_pause_seconds"
    },
    {
      "code": 6098,
      "name": "tooManyPauses",
      "msg": "Pause history is full"
    },
    {
      "code": 6099,
      "name": "unreportedPeriods",
      "msg": "Ended periods are unreported"
    },
    {
      "code": 6100,
      "name": "attestorsNotDistinct",
      "msg": "The two extinguishment attestors must be distinct"
    },
    {
      "code": 6101,
      "name": "notCapped",
      "msg": "Cap is not yet met"
    },
    {
      "code": 6102,
      "name": "notTierOne",
      "msg": "Series is not a tier 1 (split) series"
    },
    {
      "code": 6103,
      "name": "nothingToRoute",
      "msg": "Nothing to route"
    },
    {
      "code": 6104,
      "name": "routerPeriodNotEnded",
      "msg": "Router period has not ended"
    },
    {
      "code": 6105,
      "name": "routerPeriodAlreadyClosed",
      "msg": "Router period already closed"
    },
    {
      "code": 6106,
      "name": "snapshotAlreadyTaken",
      "msg": "A snapshot was already taken today"
    },
    {
      "code": 6107,
      "name": "feedIdMismatch",
      "msg": "Pyth price feed id mismatch"
    },
    {
      "code": 6108,
      "name": "priceStale",
      "msg": "Pyth price is stale"
    },
    {
      "code": 6109,
      "name": "priceNotPositive",
      "msg": "Pyth price is not positive"
    },
    {
      "code": 6110,
      "name": "confidenceTooWide",
      "msg": "Pyth confidence interval too wide"
    },
    {
      "code": 6111,
      "name": "insufficientVerification",
      "msg": "Pyth price update is not fully verified"
    },
    {
      "code": 6112,
      "name": "crosscheckRequired",
      "msg": "The pair's cross-check price update is required for this period"
    },
    {
      "code": 6113,
      "name": "windowsDisabled",
      "msg": "Transfer windows are disabled"
    },
    {
      "code": 6114,
      "name": "windowStatusNotAllowed",
      "msg": "Series status does not allow a window"
    },
    {
      "code": 6115,
      "name": "reportNotPaid",
      "msg": "The report for this period is not paid"
    },
    {
      "code": 6116,
      "name": "windowWrongPeriod",
      "msg": "Window period must be the quarter before the current one"
    },
    {
      "code": 6117,
      "name": "windowAlreadyOpen",
      "msg": "Window already open for this series"
    },
    {
      "code": 6118,
      "name": "windowNotCommit",
      "msg": "Window is not in the commit phase"
    },
    {
      "code": 6119,
      "name": "windowNotReveal",
      "msg": "Window is not in the reveal phase"
    },
    {
      "code": 6120,
      "name": "windowRevealNotOver",
      "msg": "Window reveal phase has not ended"
    },
    {
      "code": 6121,
      "name": "windowNotSettling",
      "msg": "Window is not settling"
    },
    {
      "code": 6122,
      "name": "windowNotSettled",
      "msg": "Window is not settled"
    },
    {
      "code": 6123,
      "name": "orderMismatch",
      "msg": "Order account mismatch"
    },
    {
      "code": 6124,
      "name": "orderAlreadyProcessed",
      "msg": "Order already processed"
    },
    {
      "code": 6125,
      "name": "outOfOrder",
      "msg": "Orders must be processed in reveal order: bids first, then asks"
    },
    {
      "code": 6126,
      "name": "askExceedsBalance",
      "msg": "Ask quantity exceeds the holder's unit balance"
    },
    {
      "code": 6127,
      "name": "wrongSide",
      "msg": "Wrong side for this instruction"
    },
    {
      "code": 6128,
      "name": "escrowArmBusy",
      "msg": "Escrow arm is busy"
    },
    {
      "code": 6129,
      "name": "orderNotProcessed",
      "msg": "Order has not been processed yet"
    },
    {
      "code": 6130,
      "name": "orderAlreadyDelivered",
      "msg": "Order already delivered"
    },
    {
      "code": 6131,
      "name": "takebackRequired",
      "msg": "Cancelled buyer units exceed the at-price asks: a take-back threshold must be settled first"
    },
    {
      "code": 6132,
      "name": "takebackNotRequired",
      "msg": "No take-back threshold is needed for this window"
    },
    {
      "code": 6133,
      "name": "takebackInProgress",
      "msg": "A take-back round is in progress; it cannot be reset"
    },
    {
      "code": 6134,
      "name": "takebackNotTallying",
      "msg": "No take-back round is being tallied"
    },
    {
      "code": 6135,
      "name": "takebackAlreadySettled",
      "msg": "The take-back threshold is already settled"
    },
    {
      "code": 6136,
      "name": "bidsNotProcessed",
      "msg": "Every revealed bid must be processed before asks and take-back rounds"
    }
  ],
  "types": [
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
      "name": "auction",
      "docs": [
        "Sealed-bid auction state (`[AUCTION, series]`)."
      ],
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
          },
          {
            "name": "openedAt",
            "type": "u64"
          },
          {
            "name": "commitEnd",
            "type": "u64"
          },
          {
            "name": "revealEnd",
            "type": "u64"
          },
          {
            "name": "escrowTotal",
            "type": "u64"
          },
          {
            "name": "bidCount",
            "type": "u32"
          },
          {
            "name": "revealedCount",
            "type": "u32"
          },
          {
            "name": "validCount",
            "type": "u32"
          },
          {
            "name": "tallyRound",
            "type": "u32"
          },
          {
            "name": "roundRejected",
            "type": "bool"
          },
          {
            "name": "rejectionReason",
            "docs": [
              "0 = none, 1 = ClaimMismatch, 2 = InvalidClearingPrice (last rejected round)."
            ],
            "type": "u8"
          },
          {
            "name": "clearingPrice",
            "type": "u64"
          },
          {
            "name": "qAboveClaim",
            "type": "u64"
          },
          {
            "name": "qAtClaim",
            "type": "u64"
          },
          {
            "name": "rClaim",
            "type": "u64"
          },
          {
            "name": "qAbove",
            "type": "u64"
          },
          {
            "name": "qAt",
            "type": "u64"
          },
          {
            "name": "allocSum",
            "type": "u64"
          },
          {
            "name": "minValidPrice",
            "type": "u64"
          },
          {
            "name": "talliedCount",
            "type": "u32"
          },
          {
            "name": "unitsSold",
            "type": "u64"
          },
          {
            "name": "proceeds",
            "type": "u64"
          },
          {
            "name": "settlementTs",
            "type": "u64"
          },
          {
            "name": "bidsProcessed",
            "type": "u32"
          },
          {
            "name": "unitsMinted",
            "type": "u64"
          },
          {
            "name": "mintFinalized",
            "type": "bool"
          },
          {
            "name": "mintAuthorityRevoked",
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
      "name": "bid",
      "docs": [
        "One bid per wallet per series (`[BID, series, bidder]`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "commitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "escrow",
            "type": "u64"
          },
          {
            "name": "revealIndex",
            "type": "u32"
          },
          {
            "name": "revealed",
            "type": "bool"
          },
          {
            "name": "valid",
            "type": "bool"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "talliedRound",
            "type": "u32"
          },
          {
            "name": "processed",
            "type": "bool"
          },
          {
            "name": "allocation",
            "type": "u64"
          },
          {
            "name": "pendingUnits",
            "type": "u64"
          },
          {
            "name": "pendingRefund",
            "type": "u64"
          },
          {
            "name": "delivered",
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
      "name": "bidCommitted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "escrow",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bidDelivered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "units",
            "type": "u64"
          },
          {
            "name": "refund",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bidRevealed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "valid",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "earlyDrawExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "approver",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "escrowArm",
      "docs": [
        "Armed `commit_ask` deposit for the unit mint (`[ESCROW_ARM, unit_mint]`, SPEC §4.1). Read by",
        "the hook at bytes 8..40 (owner) and 40..48 (units)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "armedOwner",
            "type": "pubkey"
          },
          {
            "name": "armedUnits",
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
      "name": "finalClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "units",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "formalNoticeDue",
      "docs": [
        "`trueup == false`: the report countdown of `period` reached the formal-notice threshold.",
        "`trueup == true`: the true-up of calendar year `period` did (SPEC §6.4, `FormalNoticeDue(series, trueup)`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "trueup",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "fxCheckpoint",
      "docs": [
        "Accumulator checkpoint at the first snapshot of a period (`[FX_CHECKPOINT, pair_id, period]`)."
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
            "name": "period",
            "type": "u32"
          },
          {
            "name": "sumWad",
            "type": "u128"
          },
          {
            "name": "count",
            "type": "u32"
          },
          {
            "name": "flagged",
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
      "name": "fxDeviationFlagged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pair",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "rateWad",
            "type": "u64"
          },
          {
            "name": "crosscheckWad",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "fxPair",
      "docs": [
        "Rate accumulator (`[FX_PAIR, pair_id]`)."
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
            "name": "sumWad",
            "type": "u128"
          },
          {
            "name": "count",
            "type": "u32"
          },
          {
            "name": "lastDay",
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
      "name": "fxSnapshot",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "pair",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "day",
            "type": "u32"
          },
          {
            "name": "rateWad",
            "type": "u64"
          },
          {
            "name": "sumWad",
            "type": "u128"
          },
          {
            "name": "count",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "holder",
      "docs": [
        "Holder record (`[HOLDER, series, wallet]`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "registered",
            "type": "bool"
          },
          {
            "name": "lastNetAccWad",
            "type": "u128"
          },
          {
            "name": "pending",
            "type": "u64"
          },
          {
            "name": "redeemedUnits",
            "type": "u64"
          },
          {
            "name": "lastTailAccWad",
            "type": "u128"
          },
          {
            "name": "lastFinalAccWad",
            "type": "u128"
          },
          {
            "name": "undeliveredUnits",
            "docs": [
              "Units minted to the auction escrow for this wallet and not yet delivered (accrual weight)."
            ],
            "type": "u64"
          },
          {
            "name": "askEscrowUnits",
            "docs": [
              "Units escrowed in an open or unprocessed window ask (accrual weight)."
            ],
            "type": "u64"
          },
          {
            "name": "windowPendingUnits",
            "docs": [
              "Units owed to the holder by processed window orders (fills bought, ask units returned) and",
              "still in the window escrow until `deliver_order` (accrual weight)."
            ],
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
      "name": "holderRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "incomeRouted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "passThrough",
            "type": "u64"
          },
          {
            "name": "routed",
            "type": "u64"
          },
          {
            "name": "ytdReceived",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "ledger",
      "docs": [
        "Per-series repayment ledger (`[LEDGER, series]`). Zero-copy so account validation never puts it",
        "on the stack. Optional values are `(value, has_*)` pairs; booleans are `u8`; field order avoids",
        "padding (bytemuck `Pod`)."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "paidPerUnitWad",
            "type": "u128"
          },
          {
            "name": "netAccWad",
            "type": "u128"
          },
          {
            "name": "tailAccWad",
            "type": "u128"
          },
          {
            "name": "tailPaidPerUnitWad",
            "type": "u128"
          },
          {
            "name": "finalAccWad",
            "type": "u128"
          },
          {
            "name": "yearGrossWad",
            "type": {
              "array": [
                "u128",
                4
              ]
            }
          },
          {
            "name": "settlementTs",
            "type": "u64"
          },
          {
            "name": "openDueAmount",
            "type": "u64"
          },
          {
            "name": "routerCredit",
            "type": "u64"
          },
          {
            "name": "trueupNonce",
            "type": "u64"
          },
          {
            "name": "trueupDue",
            "type": "u64"
          },
          {
            "name": "trueupAttestedAt",
            "type": "u64"
          },
          {
            "name": "pauseNonce",
            "type": "u64"
          },
          {
            "name": "pauseRequestedAt",
            "type": "u64"
          },
          {
            "name": "pausedTotal",
            "type": "u64"
          },
          {
            "name": "carryWad",
            "docs": [
              "Exact WAD-scaled distribution remainder (`< units_outstanding`)."
            ],
            "type": "u64"
          },
          {
            "name": "feeCollected",
            "type": "u64"
          },
          {
            "name": "grossReceived",
            "type": "u64"
          },
          {
            "name": "refundedToIssuer",
            "type": "u64"
          },
          {
            "name": "unitsOutstanding",
            "docs": [
              "`units_sold` at mint finalisation, reduced only by burns."
            ],
            "type": "u64"
          },
          {
            "name": "redemptionTs",
            "type": "u64"
          },
          {
            "name": "redemptionPrice",
            "type": "u64"
          },
          {
            "name": "unitsAtRedemption",
            "type": "u64"
          },
          {
            "name": "tailCapPerUnit",
            "type": "u64"
          },
          {
            "name": "tailCarryWad",
            "type": "u64"
          },
          {
            "name": "extinguishedAt",
            "type": "u64"
          },
          {
            "name": "finalCarryWad",
            "type": "u64"
          },
          {
            "name": "finalUnits",
            "type": "u64"
          },
          {
            "name": "extinguishNonce",
            "type": "u64"
          },
          {
            "name": "yearPaySum",
            "docs": [
              "Σ `payment_usd` accepted per calendar year (tagged ring; bounds negative true-ups)."
            ],
            "type": {
              "array": [
                "u64",
                4
              ]
            }
          },
          {
            "name": "pauseStart",
            "type": {
              "array": [
                "u64",
                16
              ]
            }
          },
          {
            "name": "pauseEnd",
            "type": {
              "array": [
                "u64",
                16
              ]
            }
          },
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "lastIncomeCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "firstPeriod",
            "type": "u32"
          },
          {
            "name": "lastAcceptedPeriodV",
            "type": "u32"
          },
          {
            "name": "lastPaidPeriodV",
            "type": "u32"
          },
          {
            "name": "openDuePeriodV",
            "type": "u32"
          },
          {
            "name": "formalNoticeEmittedForV",
            "type": "u32"
          },
          {
            "name": "lastIncomePeriodV",
            "type": "u32"
          },
          {
            "name": "activeWindowV",
            "type": "u32"
          },
          {
            "name": "yearGrossTag",
            "type": {
              "array": [
                "u32",
                4
              ]
            }
          },
          {
            "name": "yearPayTag",
            "type": {
              "array": [
                "u32",
                4
              ]
            }
          },
          {
            "name": "trueupYearV",
            "type": "u32"
          },
          {
            "name": "lastTrueupYearV",
            "type": "u32"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "hasLastAcceptedPeriod",
            "type": "u8"
          },
          {
            "name": "hasLastPaidPeriod",
            "type": "u8"
          },
          {
            "name": "hasOpenDuePeriod",
            "type": "u8"
          },
          {
            "name": "hasFormalNotice",
            "type": "u8"
          },
          {
            "name": "hasLastIncomePeriod",
            "type": "u8"
          },
          {
            "name": "hasActiveWindow",
            "type": "u8"
          },
          {
            "name": "openDueTier",
            "type": "u8"
          },
          {
            "name": "pauseRequested",
            "type": "u8"
          },
          {
            "name": "pauseCount",
            "type": "u8"
          },
          {
            "name": "trueupNoticeEmitted",
            "type": "u8"
          },
          {
            "name": "hasTrueupYear",
            "type": "u8"
          },
          {
            "name": "hasLastTrueupYear",
            "type": "u8"
          },
          {
            "name": "tailExhausted",
            "type": "u8"
          },
          {
            "name": "mintFinalized",
            "type": "u8"
          },
          {
            "name": "yearGrossSet",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "yearPaySet",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "padding",
            "type": {
              "array": [
                "u8",
                12
              ]
            }
          }
        ]
      }
    },
    {
      "name": "mintAuthorityRevoked",
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
      "name": "nonRevealCharged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "charge",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "order",
      "docs": [
        "Window order, ONE per wallet per window (`[ORDER, series, period, owner]`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "commitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "escrow",
            "docs": [
              "Stablecoin for bids, units for asks."
            ],
            "type": "u64"
          },
          {
            "name": "revealIndex",
            "docs": [
              "Per-side reveal index."
            ],
            "type": "u32"
          },
          {
            "name": "revealed",
            "type": "bool"
          },
          {
            "name": "valid",
            "type": "bool"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "talliedRound",
            "type": "u32"
          },
          {
            "name": "processed",
            "type": "bool"
          },
          {
            "name": "fill",
            "type": "u64"
          },
          {
            "name": "takebackRound",
            "docs": [
              "Take-back tally round in which this order was counted."
            ],
            "type": "u32"
          },
          {
            "name": "pendingUnits",
            "docs": [
              "Owed to the owner after processing and paid by `deliver_order`: units (bid fill or ask",
              "return) and stablecoin (bid refund or ask proceeds)."
            ],
            "type": "u64"
          },
          {
            "name": "pendingStable",
            "type": "u64"
          },
          {
            "name": "delivered",
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
      "name": "orderCommitted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "escrow",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "orderDelivered",
      "docs": [
        "`deliver_order` paid what a processed window order owes its owner (Solana addition mirroring",
        "`BidDelivered`): `units` (bid fill or ask return) and `amount` of stablecoin (bid refund or ask",
        "proceeds)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "units",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "orderFilled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "fill",
            "type": "u64"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "refund",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "orderRevealed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "valid",
            "type": "bool"
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
      "name": "pauseApproved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "start",
            "type": "u64"
          },
          {
            "name": "end",
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
      "name": "pauseEnded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "pausedTotal",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "pauseRequestWithdrawn",
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
          }
        ]
      }
    },
    {
      "name": "pauseRequested",
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
          }
        ]
      }
    },
    {
      "name": "paymentSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "gross",
            "type": "u64"
          },
          {
            "name": "accrual",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "accepted",
            "type": "u64"
          },
          {
            "name": "refunded",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "payoutClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "burnedUnits",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "payoutDistributed",
      "docs": [
        "`source`: 0 = Payment, 1 = Router, 2 = Tail, 3 = Final."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "source",
            "type": "u8"
          },
          {
            "name": "gross",
            "type": "u64"
          },
          {
            "name": "accepted",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "netAdded",
            "type": "u64"
          },
          {
            "name": "deltaAccWad",
            "type": "u128"
          },
          {
            "name": "paidPerUnitWad",
            "type": "u128"
          },
          {
            "name": "retired",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "priceFeedMessage",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feedId",
            "docs": [
              "`FeedId` but avoid the type alias because of compatibility issues with Anchor's `idl-build` feature."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": "i64"
          },
          {
            "name": "conf",
            "type": "u64"
          },
          {
            "name": "exponent",
            "type": "i32"
          },
          {
            "name": "publishTime",
            "docs": [
              "The timestamp of this price update in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "prevPublishTime",
            "docs": [
              "The timestamp of the previous price update. This field is intended to allow users to",
              "identify the single unique price update for any moment in time:",
              "for any time t, the unique update is the one such that prev_publish_time < t <= publish_time.",
              "",
              "Note that there may not be such an update while we are migrating to the new message-sending logic,",
              "as some price updates on pythnet may not be sent to other chains (because the message-sending",
              "logic may not have triggered). We can solve this problem by making the message-sending mandatory",
              "(which we can do once publishers have migrated over).",
              "",
              "Additionally, this field may be equal to publish_time if the message is sent on a slot where",
              "where the aggregation was unsuccesful. This problem will go away once all publishers have",
              "migrated over to a recent version of pyth-agent."
            ],
            "type": "i64"
          },
          {
            "name": "emaPrice",
            "type": "i64"
          },
          {
            "name": "emaConf",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceUpdateV2",
      "docs": [
        "A price update account. This account is used by the Pyth Receiver program to store a verified price update from a Pyth price feed.",
        "It contains:",
        "- `write_authority`: The write authority for this account. This authority can close this account to reclaim rent or update the account to contain a different price update.",
        "- `verification_level`: The [`VerificationLevel`] of this price update. This represents how many Wormhole guardian signatures have been verified for this price update.",
        "- `price_message`: The actual price update.",
        "- `posted_slot`: The slot at which this price update was posted."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writeAuthority",
            "type": "pubkey"
          },
          {
            "name": "verificationLevel",
            "type": {
              "defined": {
                "name": "verificationLevel"
              }
            }
          },
          {
            "name": "priceMessage",
            "type": {
              "defined": {
                "name": "priceFeedMessage"
              }
            }
          },
          {
            "name": "postedSlot",
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
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "raiseCancelled",
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
      "name": "raiseFailed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "clearingPrice",
            "type": "u64"
          },
          {
            "name": "proceeds",
            "type": "u64"
          },
          {
            "name": "minRaise",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "raiseMintFinalized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "unitsSold",
            "type": "u64"
          },
          {
            "name": "proceeds",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "raiseOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "unitMint",
            "type": "pubkey"
          },
          {
            "name": "openedAt",
            "type": "u64"
          },
          {
            "name": "commitEnd",
            "type": "u64"
          },
          {
            "name": "revealEnd",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "raiseSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "clearingPrice",
            "type": "u64"
          },
          {
            "name": "unitsSold",
            "type": "u64"
          },
          {
            "name": "proceeds",
            "type": "u64"
          },
          {
            "name": "settlementTs",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "redemptionClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "units",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "releaseClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "releasedTotal",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "releasePauseSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "report",
      "docs": [
        "Accepted report (`[REPORT, series, period]`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "acceptedAt",
            "type": "u64"
          },
          {
            "name": "paymentUsd",
            "type": "u64"
          },
          {
            "name": "fxAvgWad",
            "type": "u64"
          },
          {
            "name": "fxFallback",
            "type": "bool"
          },
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "liquidityEvent",
            "type": "bool"
          },
          {
            "name": "incomeCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "priorIncomeCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "due",
            "type": "u64"
          },
          {
            "name": "accrualPaid",
            "type": "u64"
          },
          {
            "name": "paidAt",
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
      "name": "reportAccepted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "paymentUsd",
            "type": "u64"
          },
          {
            "name": "fxAvgWad",
            "type": "u64"
          },
          {
            "name": "fxFallback",
            "type": "bool"
          },
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "liquidityEvent",
            "type": "bool"
          },
          {
            "name": "incomeCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "due",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "router",
      "docs": [
        "Tier 1 split router (`[ROUTER, series]`); income lands in the `router_token` PDA."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "theta",
            "type": "u64"
          },
          {
            "name": "rWad",
            "type": "u64"
          },
          {
            "name": "ytdYear",
            "type": "u32"
          },
          {
            "name": "ytdReceived",
            "type": "u64"
          },
          {
            "name": "lastReceiptPeriod",
            "docs": [
              "Period of the latest receipt (0 = none yet)."
            ],
            "type": "u32"
          },
          {
            "name": "lastCheckpointPeriod",
            "docs": [
              "Latest period with a recorded checkpoint (0 = none yet)."
            ],
            "type": "u32"
          },
          {
            "name": "initPeriod",
            "docs": [
              "Period in which the router (and its receiving account) was created. No income can have",
              "been received before it, so every earlier period's `ytd_at_end` is exactly 0."
            ],
            "type": "u32"
          },
          {
            "name": "cpPeriod",
            "docs": [
              "Ring of `ROUTER_RING` period checkpoints `{period, ytd_at_end}` (slot = period % ring)."
            ],
            "type": {
              "array": [
                "u32",
                8
              ]
            }
          },
          {
            "name": "cpYtdAtEnd",
            "type": {
              "array": [
                "u64",
                8
              ]
            }
          },
          {
            "name": "cpSet",
            "type": {
              "array": [
                "bool",
                8
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "routerPeriodClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "ytdAtEnd",
            "type": "u64"
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
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "seriesExtinguished",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "unreleased",
            "type": "u64"
          },
          {
            "name": "attestorA",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "attestorB",
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
      "name": "seriesRedeemed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "hurdle",
            "type": "u64"
          },
          {
            "name": "dAvg",
            "type": "u64"
          },
          {
            "name": "capRemaining",
            "type": "u64"
          },
          {
            "name": "units",
            "type": "u64"
          },
          {
            "name": "deposit",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "seriesRetired",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "paidPerUnitWad",
            "type": "u128"
          },
          {
            "name": "refund",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "settlementProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "clearingPrice",
            "type": "u64"
          },
          {
            "name": "round",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "settlementRejected",
      "docs": [
        "`reason`: 1 = ClaimMismatch, 2 = InvalidClearingPrice."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "round",
            "type": "u32"
          },
          {
            "name": "clearingPrice",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "statusChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "old",
            "type": "u8"
          },
          {
            "name": "new",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "submitReportArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "paymentUsd",
            "type": "u64"
          },
          {
            "name": "fxAvgWad",
            "type": "u64"
          },
          {
            "name": "fxFallbackSig",
            "docs": [
              "Attestor signature over `MERCES_FX_V1` when the pair needs a fallback rate."
            ],
            "type": {
              "option": {
                "array": [
                  "u8",
                  65
                ]
              }
            }
          },
          {
            "name": "fxAttestorAddr",
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          },
          {
            "name": "priorIncomeCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "incomeCommitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tier",
            "type": "u8"
          },
          {
            "name": "liquidityEvent",
            "type": "bool"
          },
          {
            "name": "proof",
            "docs": [
              "256 bytes: A (64) ‖ B (128) ‖ C (64), see `zk`."
            ],
            "type": "bytes"
          },
          {
            "name": "attestationSig",
            "docs": [
              "Tier 2: report-verifier key; tier 3: attestor. None for tiers 1 and 4."
            ],
            "type": {
              "option": {
                "array": [
                  "u8",
                  65
                ]
              }
            }
          },
          {
            "name": "attestationAddr",
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
      "name": "tailClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tailDistributed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "gross",
            "type": "u64"
          },
          {
            "name": "accepted",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "refunded",
            "type": "u64"
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
      "name": "treasury",
      "docs": [
        "Treasury bookkeeping (`[TREASURY, series]`); the stablecoin sits in the `treasury_token` PDA."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "proceeds",
            "docs": [
              "Exact proceeds (`p* × units_sold`), written at finalize."
            ],
            "type": "u64"
          },
          {
            "name": "proceedsReceived",
            "type": "u64"
          },
          {
            "name": "releasedTotal",
            "type": "u64"
          },
          {
            "name": "issuerPausedReleases",
            "type": "bool"
          },
          {
            "name": "earlyDrawTotal",
            "type": "u64"
          },
          {
            "name": "extinguishedAt",
            "docs": [
              "`now` of the extinguishment (0 while not extinguished); caps vesting for the estate."
            ],
            "type": "u64"
          },
          {
            "name": "mintFinalized",
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
      "name": "trueUpPaid",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "accrual",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "trueUpRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "year",
            "type": "u16"
          },
          {
            "name": "adjustment",
            "type": "i64"
          },
          {
            "name": "deadline",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "unitsAllocated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "bidder",
            "type": "pubkey"
          },
          {
            "name": "units",
            "type": "u64"
          },
          {
            "name": "cost",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "refund",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "unitsBurned",
      "docs": [
        "`reason`: 0 = Retired, 1 = Redeemed, 2 = Extinguished."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "units",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "verificationLevel",
      "docs": [
        "Pyth price updates are bridged to all blockchains via Wormhole.",
        "Using the price updates on another chain requires verifying the signatures of the Wormhole guardians.",
        "The usual process is to check the signatures for two thirds of the total number of guardians, but this can be cumbersome on Solana because of the transaction size limits,",
        "so we also allow for partial verification.",
        "",
        "This enum represents how much a price update has been verified:",
        "- If `Full`, we have verified the signatures for two thirds of the current guardians.",
        "- If `Partial`, only `num_signatures` guardian signatures have been checked.",
        "",
        "# Warning",
        "Using partially verified price updates is dangerous, as it lowers the threshold of guardians that need to collude to produce a malicious price update."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "partial",
            "fields": [
              {
                "name": "numSignatures",
                "type": "u8"
              }
            ]
          },
          {
            "name": "full"
          }
        ]
      }
    },
    {
      "name": "window",
      "docs": [
        "Transfer window (`[WINDOW, series, period]`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "state",
            "type": "u8"
          },
          {
            "name": "opensAt",
            "type": "u64"
          },
          {
            "name": "commitEnd",
            "type": "u64"
          },
          {
            "name": "revealEnd",
            "type": "u64"
          },
          {
            "name": "orderCount",
            "type": "u32"
          },
          {
            "name": "bidCount",
            "type": "u32"
          },
          {
            "name": "askCount",
            "type": "u32"
          },
          {
            "name": "revealedCount",
            "type": "u32"
          },
          {
            "name": "revealedBids",
            "type": "u32"
          },
          {
            "name": "revealedAsks",
            "type": "u32"
          },
          {
            "name": "validCount",
            "type": "u32"
          },
          {
            "name": "escrowUnits",
            "type": "u64"
          },
          {
            "name": "escrowStable",
            "type": "u64"
          },
          {
            "name": "tallyRound",
            "type": "u32"
          },
          {
            "name": "roundRejected",
            "type": "bool"
          },
          {
            "name": "rejectionReason",
            "docs": [
              "0 = none, 1 = NoMatchInvalid, 2 = PriceNotRevealed, 3 = NoCrossing (last rejected round)."
            ],
            "type": "u8"
          },
          {
            "name": "clearingPrice",
            "type": "u64"
          },
          {
            "name": "noMatchProposed",
            "type": "bool"
          },
          {
            "name": "dAbove",
            "type": "u64"
          },
          {
            "name": "dAt",
            "type": "u64"
          },
          {
            "name": "sBelow",
            "type": "u64"
          },
          {
            "name": "sAt",
            "type": "u64"
          },
          {
            "name": "maxBid",
            "type": "u64"
          },
          {
            "name": "minAsk",
            "type": "u64"
          },
          {
            "name": "validBids",
            "type": "u32"
          },
          {
            "name": "validAsks",
            "type": "u32"
          },
          {
            "name": "talliedCount",
            "type": "u32"
          },
          {
            "name": "branch",
            "type": "u8"
          },
          {
            "name": "matchedUnits",
            "type": "u64"
          },
          {
            "name": "marginalRemaining",
            "docs": [
              "Units left for the marginal bids at `p*` (branch A; first-come in reveal order)."
            ],
            "type": "u64"
          },
          {
            "name": "askAtTotal",
            "docs": [
              "Class fill of the at-`p*` ask group before cancellations (A: `s_at`, B: `D − s_below`)."
            ],
            "type": "u64"
          },
          {
            "name": "askAtFilled",
            "docs": [
              "Units already given to at-`p*` asks (first-come against `ask_at_total − cancelled_units`)."
            ],
            "type": "u64"
          },
          {
            "name": "cancelledUnits",
            "docs": [
              "Fills of buyers cancelled at fill time (allowlist removed), taken back from the asks."
            ],
            "type": "u64"
          },
          {
            "name": "nextBidIndex",
            "docs": [
              "Bids are processed in ascending per-side reveal index, then asks."
            ],
            "type": "u32"
          },
          {
            "name": "nextAskIndex",
            "type": "u32"
          },
          {
            "name": "bidsProcessed",
            "type": "u32"
          },
          {
            "name": "asksProcessed",
            "type": "u32"
          },
          {
            "name": "processedCount",
            "type": "u32"
          },
          {
            "name": "deliveredCount",
            "type": "u32"
          },
          {
            "name": "tbRound",
            "type": "u32"
          },
          {
            "name": "tbRejected",
            "type": "bool"
          },
          {
            "name": "tbSettled",
            "type": "bool"
          },
          {
            "name": "tbPrice",
            "type": "u64"
          },
          {
            "name": "tbIndex",
            "type": "u32"
          },
          {
            "name": "tbAboveSum",
            "type": "u64"
          },
          {
            "name": "tbFound",
            "type": "bool"
          },
          {
            "name": "tbKQuantity",
            "type": "u64"
          },
          {
            "name": "tbTallied",
            "type": "u32"
          },
          {
            "name": "tbPartial",
            "docs": [
              "Units cut from the threshold order itself (`R − Σ_{key > k} q`)."
            ],
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
      "name": "windowCleared",
      "docs": [
        "`branch`: 0 = SupplyLimited, 1 = DemandLimited."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "clearingPrice",
            "type": "u64"
          },
          {
            "name": "matchedUnits",
            "type": "u64"
          },
          {
            "name": "branch",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "windowNoMatch",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "windowOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "commitEnd",
            "type": "u64"
          },
          {
            "name": "revealEnd",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "windowSettlementProposed",
      "docs": [
        "Window settlement proposal (Solana addition mirroring the auction's `SettlementProposed`;",
        "SPEC §12: every state transition emits an event). `no_match = true` proposes `NO_MATCH`",
        "(`clearing_price` is then `u64::MAX`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "clearingPrice",
            "type": "u64"
          },
          {
            "name": "noMatch",
            "type": "bool"
          },
          {
            "name": "round",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "windowSettlementRejected",
      "docs": [
        "`reason`: 1 = NoMatchInvalid, 2 = PriceNotRevealed, 3 = NoCrossing. `clearing_price` is",
        "`u64::MAX` for a rejected `NO_MATCH` proposal."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "clearingPrice",
            "type": "u64"
          },
          {
            "name": "reason",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "windowTakebackProposed",
      "docs": [
        "Take-back threshold proposal (Solana addition, SPEC §7 cancelled-buyer take-back from the asks",
        "below `p*`): the order with key `(price, reveal_index)` is proposed as the last one cut."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "revealIndex",
            "type": "u32"
          },
          {
            "name": "round",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "windowTakebackRejected",
      "docs": [
        "A take-back proposal that failed the tally check (never a revert)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "round",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "windowTakebackSettled",
      "docs": [
        "The take-back threshold is settled: `below_units` units come off the asks below `p*`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "series",
            "type": "pubkey"
          },
          {
            "name": "period",
            "type": "u32"
          },
          {
            "name": "cancelledUnits",
            "type": "u64"
          },
          {
            "name": "belowUnits",
            "type": "u64"
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "revealIndex",
            "type": "u32"
          },
          {
            "name": "partial",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
