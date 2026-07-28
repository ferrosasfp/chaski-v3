# CONTRACT-VERSIONS — WKH-227 / HU-SOL-24 (chaski-v3, CONSUMER)

Registro de los fixtures de contrato **vendoreados** (copias pinneadas del output de cada provider).
El consumer replaya estas copias contra sus propios validadores/serializadores: si un provider
driftea su shape y se re-vendorea la copia, el test del consumer se pone **ROJO** (AC-1).

## Fixtures vendoreados

| Fixture (consumer) | Repo origen | Archivo origen | Sync | Validador consumer |
|--------------------|-------------|----------------|------|--------------------|
| `vendored/corridor-fx.output.fixture.ts` | `wasiai-remittance-agents` | `src/contracts/corridor-fx.output.fixture.ts` | 2026-07-22 | `isValidQuoteResult` (handler `POST` de `app/api/a2a/quote/route.ts`) + `isValidQuoteShape` (`A2aQuoteGateway`) |
| `vendored/kyc-validator.output.fixture.ts` | `wasiai-remittance-agents` | `src/contracts/kyc-validator.output.fixture.ts` | 2026-07-22 | shape-guard **forward-looking** (test-only) |
| `vendored/cashout-payout.output.fixture.ts` | `wasiai-remittance-agents` | `src/contracts/cashout-payout.output.fixture.ts` | 2026-07-22 | `isValidPayoutShape` (`A2aPayoutGateway.submit`) |
| `vendored/settle-eip3009.body.fixture.ts` | `wasiai-facilitator` | `src/contracts/settle-eip3009.body.fixture.ts` | 2026-07-22 | body de `broadcastSettle()` (`toEqual`) — **== golden #3** |

## CD-4 — árbitro consumer (settle body)

El fixture `/settle` del origen W2 usó valores **placeholder** para los campos runtime-variables de
`payload`. Al capturar el body REAL que arma `broadcastSettle()` de chaski con el fixture determinístico
(`remittanceId="rmt_fixed_0001"`, `quoteId="q_fixed_0001"`), el único campo que difirió fue:

| Campo | W2 (placeholder) | chaski REAL (determinístico) |
|-------|------------------|------------------------------|
| `payload.authorization.nonce` | `0x` + `cd`×32 | `keccak256("rmt_fixed_0001:q_fixed_0001")` = `0xdbe8185143ae74c74fd732bc99ea20992b6c4904b208b19a85afa598986aac82` |

Por **CD-4 gana la salida REAL del consumer**: la copia vendoreada (`settle-eip3009.body.fixture.ts`)
se re-pinneó con el nonce determinístico real. El resto del body (x402Version, resource.url, accepted.*,
extra.name="USD Coin", from/to/value/validAfter/validBefore, signature de shape) es idéntico a W2.
Follow-up sugerido: re-sincronizar el fixture ORIGEN en `wasiai-facilitator` con el mismo nonce
determinístico (fuera de scope de esta wave — no se toca otro repo).

## Deuda técnica — sincronización cross-repo (Missing Input #1)

**NO hay CI cross-repo real.** La sincronización provider→consumer es **MANUAL** dentro del mismo PR:
cuando un provider cambia su contrato, hay que re-vendorear la copia acá en el mismo PR. Sin eso, el
drift pasa silencioso hasta que alguien re-vendorea.

- Ticket follow-up sugerido: **`WKH-TBD: CI cross-repo drift trigger`** — GitHub Action
  `repository_dispatch` provider→consumers que dispare el replay de contratos en cada cambio de fixture
  del provider. **NO se implementa acá** (CD-3: sin dep cross-repo, sin CI nuevo en esta HU).

## Contrato KYC — forward-looking

`remit-kyc-validator` **NO tiene consumer productivo en chaski**: el KYC real va por Didit
(`/api/kyc/*`), no por el agente A2A. El contract test (`contracts.kyc.test.ts`) usa un shape-guard
**test-only** que espeja `KycAgentOutput` (keys + typeof) — existe sólo para mantener la simetría con
los otros 2 contratos y cerrar el loop de drift, sin inventar un consumer productivo. CD-7: el fixture
NO lleva PII (`travelRuleData` / `legalId` / `documentNumber`).

## `ESCROW_IDL_SHA256`

```
4bcc34a997396d360ab996ea5bb1015ffdd8a1d357d3f4b4cffcbfe8ea98d12b
```

### Bitácora de re-pinneos

| Fecha | Hash | SDD que lo autoriza | Motivo |
|-------|------|---------------------|--------|
| 2026-07-22 | `aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71` | WKH-227 / HU-SOL-24 (pin inicial) | Congelar el IDL del escrow tal como estaba deployado (4 ix, `EscrowState`). |
| 2026-07-28 | `4bcc34a997396d360ab996ea5bb1015ffdd8a1d357d3f4b4cffcbfe8ea98d12b` | **HU-SOL-20 / R2b** — `solana-programs/doc/sdd/002-escrow-remittance-id-recovery/sdd.md` §4.10 (DT-9), §5 paso R2, gate G5 | R1 amplió el programa: **+2 instrucciones** (`register_escrow`, `deregister_escrow`), **+1 account type** (`EscrowIndex`) y **+1 error** (`6005 EscrowIndexFull`). |

Este re-pinneo **no es drift**: es el SDD explícito que exige el párrafo de abajo. Verificado antes de
re-pinnear que las **4 instrucciones preexistentes** (`deposit`, `release`, `refund`, `close`) siguen
canonicalizando **byte-idénticas** (mismo discriminador, mismas cuentas en el mismo orden, mismos args),
que el tipo `EscrowState` y su discriminador de cuenta **no cambiaron** (8 campos, sin padding) y que el
`address` sigue siendo `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` (upgrade in-place, CD-15). El
valor es **idéntico** al pineado por R2a en `wasiai-facilitator` (`src/chains/escrow-idl.hash.test.ts`).

⚠️ El hash **no** se calcula con `sha256sum` (hashea bytes, no JSON canónico) ni con Python
(`json.dumps` escapa los no-ASCII como `\uXXXX` y `JSON.stringify` no; el IDL tiene `docs` con
acentos ⇒ hash distinto sobre el mismo archivo). Usar `canonicalSha256` de `idl/canonical-hash.ts`.

SHA-256 canónico (claves ordenadas) del IDL del escrow. Verificado en F2 sobre los 3 IDL reales del
ecosistema (chaski `src/infrastructure/solana/escrow-idl.ts`, el sibling `solana-programs/target/idl/escrow.json`
y el del facilitator) — **los 3 canonicalizan igual**, address `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`.
El test `idl/escrow-idl.hash.test.ts` compara el IDL pinneado en chaski contra esta constante (AC-2,
siempre) y, best-effort, contra el sibling (AC-3, skip limpio si no existe). **Re-pinneo SOLO con SDD
explícito**, jamás por drift silencioso: si alguien edita `escrow-idl.ts` a mano el test se pone ROJO.
