# Golden EVM — WKH-227 / HU-SOL-24

Los golden congelan la **serialización EXACTA** de 4 payloads EVM del money-path para un input FIJO
determinístico. Si un byte cambia, el test se pone **ROJO** — obligando a revisar conscientemente
cualquier cambio de serialización EVM en el diff del PR.

## Cómo se generan (NUNCA a mano — CD-4)

Los `.golden.json` / `.golden.txt` se **GENERAN del código**, jamás se editan a mano ni se ajusta el
código para matchear un valor imaginado:

```bash
UPDATE_GOLDEN=1 npm test -- contracts/golden/golden-evm.test.ts
```

Sin `UPDATE_GOLDEN`, el test **lee** el golden congelado y compara (`toEqual` / `toBe`).
Un golden que aparece modificado en el diff del PR = un cambio de serialización EVM a revisar.

## Fixture determinístico (§6.1)

Reproducible por construcción — **sin `Date.now()` ni `Math.random()`**:

| Constante | Valor |
|-----------|-------|
| `REMITTANCE_ID` | `rmt_fixed_0001` |
| `QUOTE_ID` | `q_fixed_0001` |
| `FROM` | `0xf39fd6e51aad88f6f4ce6ab8827279cffFb92266` (hardhat acct#0, viem checksumea) |
| `DEPOSIT_ADDR` | `0x1111111111111111111111111111111111111111` |
| `SEND_MINOR` | `"400000000"` (400 USDC, 6 dec — STRING, AC-5) |
| `EXPIRES_AT` | `2030-01-01T00:00:00.000Z` → `validBefore = 1893456000` |
| `CHAIN` | `84532` (Base Sepolia, default; provider mock chainIdHex `0x14a34`) |
| `nonce` | `keccak256("rmt_fixed_0001:q_fixed_0001")` = `0xdbe8185143ae74c74fd732bc99ea20992b6c4904b208b19a85afa598986aac82` (determinístico, CD-19) |
| `DEPOSIT_SECRET` | `golden-fixed-secret` |
| `EXP` | `1893456000` (epoch SEG fijo) |

## Los 4 golden

| # | Payload | Archivo |
|---|---------|---------|
| 1 | EIP-712 typed-data (`params[1]` de `eth_signTypedData_v4`; viem serializa bigint→decimal string, CD-12) | `eip712-transfer-with-authorization.golden.json` |
| 2 | `eip3009.authorization` serializada (strings canónicos) | `eip3009-authorization.golden.json` |
| 3 | Body `/settle` EIP-3009 de `broadcastSettle()` — **mismo objeto que valida el contract test #8** (`contracts/contracts.settle.test.ts`) | `settle-eip3009-body.golden.json` |
| 4 | `issueDepositAttestation()` (string `b64url.b64url`) | `deposit-attestation.golden.txt` |

## Scope OUT (DT-3)

- NO se congela el envelope Solana base58 de `verifySolanaSettlement` (T-9 es EVM-only).
- NO se congela el `signMessage` demo de `wallet.ts`.
