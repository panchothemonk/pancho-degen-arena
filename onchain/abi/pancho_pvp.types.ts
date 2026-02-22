/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/pancho_pvp.json`.
 */
export type PanchoPvp = {
  "address": "52nguesHaBuF4psFr2uybVnW4angLW2ZtsBRSRmdF8k3",
  "metadata": {
    "name": "panchoPvp",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Pancho PvP on-chain escrow and settlement"
  },
  "instructions": [
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
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "upVault",
          "writable": true
        },
        {
          "name": "downVault",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "createRound",
      "discriminator": [
        229,
        218,
        236,
        169,
        231,
        80,
        134,
        112
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
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
            ]
          }
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "upVault",
          "writable": true
        },
        {
          "name": "downVault",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "market",
          "type": "u8"
        },
        {
          "name": "roundId",
          "type": "i64"
        },
        {
          "name": "lockTs",
          "type": "i64"
        },
        {
          "name": "endTs",
          "type": "i64"
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
          "name": "oraclePriceAccount",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initializeConfig",
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "address": "Dkm5UeGTaeXDkauBMtNwbHGw7q2aXbrqb9HBQVN5GFx8"
        },
        {
          "name": "treasury"
        },
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
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "feeBps",
          "type": "u16"
        },
        {
          "name": "oracleMaxAgeSec",
          "type": "u32"
        },
        {
          "name": "oracleProgram",
          "type": "pubkey"
        },
        {
          "name": "oracleAccountSol",
          "type": "pubkey"
        },
        {
          "name": "oracleAccountBtc",
          "type": "pubkey"
        },
        {
          "name": "oracleAccountEth",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "joinRound",
      "discriminator": [
        191,
        222,
        86,
        25,
        234,
        174,
        157,
        249
      ],
      "accounts": [
        {
          "name": "user",
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
            ]
          }
        },
        {
          "name": "round",
          "writable": true
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "sideVault",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "side",
          "type": "u8"
        },
        {
          "name": "lamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "lockRound",
      "discriminator": [
        68,
        124,
        43,
        230,
        30,
        44,
        248,
        227
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
          "name": "round",
          "writable": true
        },
        {
          "name": "oraclePrice"
        }
      ],
      "args": []
    },
    {
      "name": "setConfig",
      "discriminator": [
        108,
        158,
        154,
        175,
        212,
        98,
        52,
        66
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
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
        }
      ],
      "args": [
        {
          "name": "feeBps",
          "type": "u16"
        },
        {
          "name": "oracleMaxAgeSec",
          "type": "u32"
        },
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setOracleAccounts",
      "discriminator": [
        174,
        106,
        146,
        87,
        199,
        228,
        200,
        208
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
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
        }
      ],
      "args": [
        {
          "name": "oracleAccountSol",
          "type": "pubkey"
        },
        {
          "name": "oracleAccountBtc",
          "type": "pubkey"
        },
        {
          "name": "oracleAccountEth",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setTreasury",
      "discriminator": [
        57,
        97,
        196,
        95,
        195,
        206,
        106,
        136
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
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
          "name": "newTreasury"
        }
      ],
      "args": []
    },
    {
      "name": "settleRound",
      "discriminator": [
        40,
        101,
        18,
        1,
        31,
        129,
        52,
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
          "name": "round",
          "writable": true
        },
        {
          "name": "upVault",
          "writable": true
        },
        {
          "name": "downVault",
          "writable": true
        },
        {
          "name": "oraclePrice"
        },
        {
          "name": "treasury",
          "writable": true
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "globalConfig",
      "discriminator": [
        149,
        8,
        156,
        202,
        160,
        252,
        176,
        217
      ]
    },
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    },
    {
      "name": "round",
      "discriminator": [
        87,
        127,
        165,
        51,
        73,
        78,
        116,
        174
      ]
    },
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    }
  ],
  "events": [
    {
      "name": "claimed",
      "discriminator": [
        217,
        192,
        123,
        72,
        108,
        150,
        248,
        33
      ]
    },
    {
      "name": "roundCreated",
      "discriminator": [
        16,
        19,
        68,
        117,
        87,
        198,
        7,
        124
      ]
    },
    {
      "name": "roundJoined",
      "discriminator": [
        106,
        227,
        27,
        229,
        123,
        51,
        104,
        141
      ]
    },
    {
      "name": "roundLocked",
      "discriminator": [
        19,
        58,
        91,
        157,
        24,
        76,
        207,
        7
      ]
    },
    {
      "name": "roundSettled",
      "discriminator": [
        249,
        225,
        66,
        54,
        157,
        200,
        234,
        222
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidFeeBps",
      "msg": "Invalid fee bps"
    },
    {
      "code": 6001,
      "name": "protocolPaused",
      "msg": "Protocol is paused"
    },
    {
      "code": 6002,
      "name": "invalidSchedule",
      "msg": "Invalid schedule"
    },
    {
      "code": 6003,
      "name": "invalidSide",
      "msg": "Invalid side"
    },
    {
      "code": 6004,
      "name": "invalidMarket",
      "msg": "Invalid market"
    },
    {
      "code": 6005,
      "name": "invalidFeedId",
      "msg": "Invalid feed id for market"
    },
    {
      "code": 6006,
      "name": "invalidStake",
      "msg": "Invalid stake"
    },
    {
      "code": 6007,
      "name": "roundNotOpen",
      "msg": "Round is not open"
    },
    {
      "code": 6008,
      "name": "roundLocked",
      "msg": "Round is locked"
    },
    {
      "code": 6009,
      "name": "positionSideMismatch",
      "msg": "Position side mismatch"
    },
    {
      "code": 6010,
      "name": "alreadyClaimed",
      "msg": "Already claimed"
    },
    {
      "code": 6011,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6012,
      "name": "roundAlreadyLocked",
      "msg": "Round already locked"
    },
    {
      "code": 6013,
      "name": "tooEarlyToLock",
      "msg": "Too early to lock"
    },
    {
      "code": 6014,
      "name": "lockWindowExpired",
      "msg": "Lock window expired"
    },
    {
      "code": 6015,
      "name": "tooEarlyToSettle",
      "msg": "Too early to settle"
    },
    {
      "code": 6016,
      "name": "roundAlreadySettled",
      "msg": "Round already settled"
    },
    {
      "code": 6017,
      "name": "insufficientVaultLiquidity",
      "msg": "Insufficient vault liquidity"
    },
    {
      "code": 6018,
      "name": "roundNotSettled",
      "msg": "Round not settled"
    },
    {
      "code": 6019,
      "name": "nothingToClaim",
      "msg": "Nothing to claim"
    },
    {
      "code": 6020,
      "name": "vaultRoundMismatch",
      "msg": "Vault round mismatch"
    },
    {
      "code": 6021,
      "name": "positionRoundMismatch",
      "msg": "Position round mismatch"
    },
    {
      "code": 6022,
      "name": "positionUserMismatch",
      "msg": "Position user mismatch"
    },
    {
      "code": 6023,
      "name": "invalidOraclePrice",
      "msg": "Invalid oracle price update"
    },
    {
      "code": 6024,
      "name": "unexpectedOracleAccount",
      "msg": "Unexpected oracle account"
    },
    {
      "code": 6025,
      "name": "invalidOracleOwner",
      "msg": "Invalid oracle owner"
    },
    {
      "code": 6026,
      "name": "staleOraclePrice",
      "msg": "Stale oracle price"
    }
  ],
  "types": [
    {
      "name": "claimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "stake",
            "type": "u64"
          },
          {
            "name": "payout",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "globalConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "oracleProgram",
            "type": "pubkey"
          },
          {
            "name": "oracleAccountSol",
            "type": "pubkey"
          },
          {
            "name": "oracleAccountBtc",
            "type": "pubkey"
          },
          {
            "name": "oracleAccountEth",
            "type": "pubkey"
          },
          {
            "name": "feeBps",
            "type": "u16"
          },
          {
            "name": "oracleMaxAgeSec",
            "type": "u32"
          },
          {
            "name": "paused",
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
      "name": "position",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "claimed",
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
      "name": "round",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roundId",
            "type": "i64"
          },
          {
            "name": "market",
            "type": "u8"
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
            "name": "oraclePriceAccount",
            "type": "pubkey"
          },
          {
            "name": "lockTs",
            "type": "i64"
          },
          {
            "name": "endTs",
            "type": "i64"
          },
          {
            "name": "startPrice",
            "type": "i64"
          },
          {
            "name": "endPrice",
            "type": "i64"
          },
          {
            "name": "expo",
            "type": "i32"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "winnerSide",
            "type": "u8"
          },
          {
            "name": "upTotal",
            "type": "u64"
          },
          {
            "name": "downTotal",
            "type": "u64"
          },
          {
            "name": "feeLamports",
            "type": "u64"
          },
          {
            "name": "distributableLamports",
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
      "name": "roundCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "i64"
          },
          {
            "name": "market",
            "type": "u8"
          },
          {
            "name": "lockTs",
            "type": "i64"
          },
          {
            "name": "endTs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "roundJoined",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "lamports",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "roundLocked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "startPrice",
            "type": "i64"
          },
          {
            "name": "expo",
            "type": "i32"
          },
          {
            "name": "lockedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "roundSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "winnerSide",
            "type": "u8"
          },
          {
            "name": "startPrice",
            "type": "i64"
          },
          {
            "name": "endPrice",
            "type": "i64"
          },
          {
            "name": "feeLamports",
            "type": "u64"
          },
          {
            "name": "distributableLamports",
            "type": "u64"
          },
          {
            "name": "settledAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "vault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
