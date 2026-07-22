// src/infrastructure/solana/escrow-idl.ts
// COPIA PINNEADA del IDL del programa escrow Anchor (HU-SOL-12, artefacto INMUTABLE del repo externo
// /home/ferdev/.openclaw/workspace/solana-programs/target/idl/escrow.json). Se COPIA, NO se edita
// (CD-5). No puede importarse por path relativo desde src/ (el IDL vive fuera de chaski-v3, AH-10).
// El `address` (BBQ9…79WA) es la ÚNICA fuente del program id (CD-SDD-4). El adapter lo castea a
// anchor.Idl en runtime (lazy). Verificado contra AH-11: ix `deposit` discriminator
// [242,35,198,137,82,225,242,182]; args remittance_id[u8;16]/beneficiary/authority/amount(u64)/deadline(i64).
export const escrowIdl = {
  address: "BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA",
  metadata: {
    name: "escrow",
    version: "0.1.0",
    spec: "0.1.0",
    description: "Created with Anchor",
  },
  instructions: [
    {
      name: "close",
      docs: [
        "`constraint status != Deposited` (AC-8) va en el Context. Aquí solo cerramos el vault.",
      ],
      discriminator: [98, 165, 201, 177, 108, 65, 206, 96],
      accounts: [
        {
          name: "sender",
          writable: true,
          signer: true,
          relations: ["escrow_state"],
        },
        {
          name: "mint",
          relations: ["escrow_state"],
        },
        {
          name: "escrow_state",
          writable: true,
          pda: {
            seeds: [
              { kind: "const", value: [101, 115, 99, 114, 111, 119] },
              { kind: "account", path: "sender" },
              { kind: "arg", path: "remittance_id" },
            ],
          },
        },
        {
          name: "vault",
          writable: true,
          pda: {
            seeds: [
              { kind: "account", path: "escrow_state" },
              {
                kind: "const",
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: "account", path: "mint" },
            ],
            program: {
              kind: "const",
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: "token_program",
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        },
      ],
      args: [
        {
          name: "remittance_id",
          type: { array: ["u8", 16] },
        },
      ],
    },
    {
      name: "deposit",
      discriminator: [242, 35, 198, 137, 82, 225, 242, 182],
      accounts: [
        {
          name: "sender",
          writable: true,
          signer: true,
        },
        {
          name: "mint",
        },
        {
          name: "escrow_state",
          writable: true,
          pda: {
            seeds: [
              { kind: "const", value: [101, 115, 99, 114, 111, 119] },
              { kind: "account", path: "sender" },
              { kind: "arg", path: "remittance_id" },
            ],
          },
        },
        {
          name: "vault",
          writable: true,
          pda: {
            seeds: [
              { kind: "account", path: "escrow_state" },
              {
                kind: "const",
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: "account", path: "mint" },
            ],
            program: {
              kind: "const",
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: "sender_ata",
          writable: true,
        },
        {
          name: "token_program",
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        },
        {
          name: "associated_token_program",
          address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        },
        {
          name: "system_program",
          address: "11111111111111111111111111111111",
        },
      ],
      args: [
        {
          name: "remittance_id",
          type: { array: ["u8", 16] },
        },
        {
          name: "beneficiary",
          type: "pubkey",
        },
        {
          name: "authority",
          type: "pubkey",
        },
        {
          name: "amount",
          type: "u64",
        },
        {
          name: "deadline",
          type: "i64",
        },
      ],
    },
    {
      name: "refund",
      discriminator: [2, 96, 183, 251, 63, 208, 46, 46],
      accounts: [
        {
          name: "sender",
          writable: true,
          signer: true,
          relations: ["escrow_state"],
        },
        {
          name: "mint",
          relations: ["escrow_state"],
        },
        {
          name: "escrow_state",
          writable: true,
          pda: {
            seeds: [
              { kind: "const", value: [101, 115, 99, 114, 111, 119] },
              { kind: "account", path: "sender" },
              { kind: "arg", path: "remittance_id" },
            ],
          },
        },
        {
          name: "vault",
          writable: true,
          pda: {
            seeds: [
              { kind: "account", path: "escrow_state" },
              {
                kind: "const",
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: "account", path: "mint" },
            ],
            program: {
              kind: "const",
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: "sender_ata",
          writable: true,
          pda: {
            seeds: [
              { kind: "account", path: "sender" },
              {
                kind: "const",
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: "account", path: "mint" },
            ],
            program: {
              kind: "const",
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: "token_program",
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        },
        {
          name: "associated_token_program",
          address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        },
      ],
      args: [
        {
          name: "remittance_id",
          type: { array: ["u8", 16] },
        },
      ],
    },
    {
      name: "release",
      docs: [
        "Autorización (AC-6) y destino fijo (AC-1) son DECLARATIVOS vía `has_one` en el Context,",
        "no `require!` imperativos. `has_one = authority` -> ConstraintHasOne (2001) si firma otro.",
      ],
      discriminator: [253, 249, 15, 206, 28, 127, 193, 241],
      accounts: [
        {
          name: "authority",
          signer: true,
          relations: ["escrow_state"],
        },
        {
          name: "sender",
          relations: ["escrow_state"],
        },
        {
          name: "beneficiary",
          docs: ["validado por has_one = beneficiary; owner de la ATA destino (CR-4)"],
          relations: ["escrow_state"],
        },
        {
          name: "mint",
          relations: ["escrow_state"],
        },
        {
          name: "escrow_state",
          writable: true,
          pda: {
            seeds: [
              { kind: "const", value: [101, 115, 99, 114, 111, 119] },
              { kind: "account", path: "sender" },
              { kind: "arg", path: "remittance_id" },
            ],
          },
        },
        {
          name: "vault",
          writable: true,
          pda: {
            seeds: [
              { kind: "account", path: "escrow_state" },
              {
                kind: "const",
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: "account", path: "mint" },
            ],
            program: {
              kind: "const",
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: "beneficiary_ata",
          writable: true,
          pda: {
            seeds: [
              { kind: "account", path: "beneficiary" },
              {
                kind: "const",
                value: [
                  6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28,
                  180, 133, 237, 95, 91, 55, 145, 58, 140, 245, 133, 126, 255, 0, 169,
                ],
              },
              { kind: "account", path: "mint" },
            ],
            program: {
              kind: "const",
              value: [
                140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19,
                153, 218, 255, 16, 132, 4, 142, 123, 216, 219, 233, 248, 89,
              ],
            },
          },
        },
        {
          name: "token_program",
          address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        },
        {
          name: "associated_token_program",
          address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        },
      ],
      args: [
        {
          name: "remittance_id",
          type: { array: ["u8", 16] },
        },
      ],
    },
  ],
  accounts: [
    {
      name: "EscrowState",
      discriminator: [19, 90, 148, 111, 55, 130, 229, 108],
    },
  ],
  errors: [
    { code: 6000, name: "ZeroAmount", msg: "Deposit amount must be greater than zero" },
    { code: 6001, name: "InvalidDeadline", msg: "Deadline must be in the future" },
    { code: 6002, name: "EscrowNotDeposited", msg: "Escrow is not in the Deposited state" },
    { code: 6003, name: "DeadlineNotReached", msg: "Deadline has not been reached yet" },
    { code: 6004, name: "EscrowNotTerminal", msg: "Escrow must be in a terminal state to close" },
  ],
  types: [
    {
      name: "EscrowState",
      type: {
        kind: "struct",
        fields: [
          { name: "sender", type: "pubkey" },
          { name: "beneficiary", type: "pubkey" },
          { name: "authority", type: "pubkey" },
          { name: "mint", type: "pubkey" },
          { name: "amount", type: "u64" },
          { name: "deadline", type: "i64" },
          { name: "status", type: { defined: { name: "EscrowStatus" } } },
          { name: "bump", type: "u8" },
        ],
      },
    },
    {
      name: "EscrowStatus",
      type: {
        kind: "enum",
        variants: [{ name: "Deposited" }, { name: "Released" }, { name: "Refunded" }],
      },
    },
  ],
} as const;
