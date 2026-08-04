# CONTRACT-VERSIONS — WKH-227 / HU-SOL-24 (chaski-v3, CONSUMER)

Registro de los fixtures de contrato **vendoreados** (copias pinneadas del output de cada provider).
El consumer replaya estas copias contra sus propios validadores/serializadores: si un provider
driftea su shape y se re-vendorea la copia, el test del consumer se pone **ROJO** (AC-1).

## Fixtures vendoreados

| Fixture (consumer) | Repo origen | Archivo origen | Sync | Validador consumer |
|--------------------|-------------|----------------|------|--------------------|
| `vendored/corridor-fx.output.fixture.ts` | `wasiai-remittance-agents` | `src/contracts/corridor-fx.output.fixture.ts` | 2026-07-22 | `isValidQuoteResult` (handler `POST` de `app/api/a2a/quote/route.ts`) + `isValidQuoteShape` (`A2aQuoteGateway`) |
| `vendored/kyc-validator.output.fixture.ts` | `wasiai-remittance-agents` | `src/contracts/kyc-validator.output.fixture.ts` | 2026-07-22 | shape-guard **forward-looking** (test-only) |
| `vendored/solana-sponsor-limits.fixture.ts` | `wasiai-facilitator` | `src/infra/env.ts` (3 defaults) + `src/methods/solana-sponsor/cr1.ts` (fórmula del fee) | 2026-08-03 | `contracts.solana-sponsor-limits.test.ts` vs `resolveSolanaComputeUnitLimit` / `resolveSolanaComputeUnitPriceMicroLamports` (`src/infrastructure/chain.ts`) |

## Contrato retirado: `cashout-payout` (2026-07-31)

`vendored/cashout-payout.output.fixture.ts` y `contracts.payout.test.ts` se **borraron**, y hay que
decir qué se perdió con ellos en vez de dejar el archivo sin dueño.

Su validador consumer era `isValidPayoutShape`, que vivía dentro de `A2aPayoutGateway.submit`. Ese
`submit` posteaba a `/api/a2a/payout/submit`, una ruta que **WKH-320 borró** (su ausencia está
asertada en `src/composition/no-evm-surface.test.ts:124`). O sea: el contract test replayaba el
fixture del provider contra un validador que **ningún camino de producción ejecuta**. Un validador sin
consumer productivo no es un guard de contrato, es una decoración, y su verde no significaba nada.

El consumer VIVO del output de `remit-cashout-payout` hoy es server-side:
`app/api/payout/prepare/route.ts` (`isValidPayoutResult`, `:54-65`, más el chequeo aparte del
`depositAddress` en PR8). Está cubierto por `app/api/payout/prepare/route.test.ts`, pero **no** contra
el fixture vendoreado del provider, así que la detección de drift provider→consumer del payout **hoy
no existe**.

**Follow-up (necesita su propia HU)**: extraer `isValidPayoutResult` del route a un módulo importable
y apuntar ahí el contract test, re-vendoreando el fixture. No se hizo acá porque significa tocar una
route del money-path por una razón de tooling, y eso merece su propio SDD.

## Ancla de serialización del settlement

Chaski **no arma ni transmite** el body de la transacción de settlement: eso es del facilitator. Por
eso no hay fixture de consumer que comparar para ese salto. El ancla equivalente es el **pin por
hash canónico del IDL del escrow** (`contracts/idl/escrow-idl.hash.test.ts`), que corre en cada
`npm test` y fija el program id y el orden posicional de las cuentas de `deposit`, `refund` y
`register_escrow`. `wasiai-facilitator` pinnea **el mismo valor**, pero ningún test lo compara con
este: son repos separados y no hay CI cross-repo (ver la tabla de la sección `ESCROW_IDL_SHA256`).

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

## Topes del sponsor Solana — `vendored/solana-sponsor-limits.fixture.ts`

Pin de los **3 topes anti-drenaje** que el facilitator aplica a la transacción de depósito
patrocinada, más una **copia de la fórmula del fee**. A diferencia de los otros fixtures, acá no se
replaya un *shape*: se asserta que los valores que **Chaski emite** (`resolveSolanaComputeUnitLimit`
y `resolveSolanaComputeUnitPriceMicroLamports`, `src/infrastructure/chain.ts`) **caben** en los topes
pinneados, y con la política de margen del 50 %.

### Bitácora del pin

| Fecha | Valores pinneados | SDD que lo autoriza | Motivo |
|-------|-------------------|---------------------|--------|
| 2026-08-03 | `maxComputeUnits` 300000 (`env.ts:214`), `maxPriorityFeeMicroLamports` 50000 (`env.ts:215`), `maxFeeLamports` 100000 (`env.ts:218`) | **WKH-321 / SDD 038** | Primer pin de los 3 topes del sponsor Solana. Chaski pasó a declarar sus propias ix `ComputeBudget` (120 000 CU / 10 000 µL·CU⁻¹) y necesita un guard que se ponga rojo si esos valores dejan de caber. |

### Los 3 huecos que este pin NO atrapa

Están escritos completos en el encabezado del propio fixture. Resumidos:

1. **Es una copia, no una lectura.** Si el facilitator BAJA un default en `env.ts` y nadie
   re-vendorea, el CI de chaski-v3 sigue verde y el 422 vuelve en producción.
2. **Pinnea defaults del código, no configuración de despliegue.** Un override de Railway más bajo
   que el default (p. ej. `SOLANA_SPONSOR_MAX_COMPUTE_UNITS < 120000`) no lo detecta.
3. **No sigue cambios de la FÓRMULA del fee** (`cr1.ts:328-331`): si el provider la cambia, la copia
   local queda vieja y el fee derivado acá deja de ser el que el facilitator calcula.

La frescura la sostiene una persona (el AR/CR re-lee `wasiai-facilitator/src/infra/env.ts:214-218` y
compara citando `archivo:línea`), **no un assert contra el reloj**: un test que se pone rojo un día
en que nadie tocó nada entrena al equipo a ignorar el rojo.

## `ESCROW_IDL_SHA256`

```
fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071
```

Este valor **no se mantiene a mano**: `escrow-idl.hash.test.ts` lee este bloque y lo compara contra
la constante pinneada (ver "Cómo se sostiene sincronizado", abajo). Si alguien re-pinnea el código y
no toca este archivo, `npm test` se pone ROJO.

### Bitácora de re-pinneos

| Fecha | Hash | SDD que lo autoriza | Motivo |
|-------|------|---------------------|--------|
| 2026-07-22 | `aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71` | WKH-227 / HU-SOL-24 (pin inicial) | Congelar el IDL del escrow tal como estaba deployado (4 ix, `EscrowState`). |
| 2026-07-28 | `4bcc34a997396d360ab996ea5bb1015ffdd8a1d357d3f4b4cffcbfe8ea98d12b` | **HU-SOL-20 / R2b** — `solana-programs/doc/sdd/002-escrow-remittance-id-recovery/sdd.md` §4.10 (DT-9), §5 paso R2, gate G5 | R1 amplió el programa: **+2 instrucciones** (`register_escrow`, `deregister_escrow`), **+1 account type** (`EscrowIndex`) y **+1 error** (`6005 EscrowIndexFull`). |
| 2026-08-01 | `fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071` | **Ventana de custodia** — `doc/sdd/_arquitectura-desacople-verificable/plan-v2-ventana-de-custodia.md` (tren W4+W5, línea 621), commit `8c8527b` | El programa sumó la ventana de custodia: `close` agrega la cuenta `sender_ata` (barrido del vault) y entran los errores `6006 DeadlineTooSoon`, `6007 DeadlineTooFar` y `6008 ReleaseWindowClosed`. Ningún código se renumeró ni se borró; `deposit`, `refund`, `release`, `register_escrow` y `deregister_escrow` conservan discriminador, cuentas y args, y `EscrowStatus` sigue con 3 variantes. |

Cada uno de esos re-pinneos **no es drift**: cada fila cita el artefacto que lo autoriza, que es lo que
exige el párrafo de abajo. Verificado antes de re-pinnear (2026-07-28) que las **4 instrucciones
preexistentes** (`deposit`, `release`, `refund`, `close`) seguían canonicalizando **byte-idénticas**
(mismo discriminador, mismas cuentas en el mismo orden, mismos args), que el tipo `EscrowState` y su
discriminador de cuenta **no cambiaron** (8 campos, sin padding) y que el `address` sigue siendo
`DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` (upgrade in-place, CD-15). El mismo diff instrucción por
instrucción se hizo para el re-pin del 2026-08-01 y está en el encabezado de
`idl/escrow-idl.hash.test.ts:9-20`.

Los **tres** artefactos del ecosistema canonicalizan a `fb64c937…`, medido el 2026-08-04 con
`canonicalSha256` (no de memoria): la copia de chaski (`src/infrastructure/solana/escrow-idl.ts`), el
sibling que emite el compilador (`solana-programs/target/idl/escrow.json`, que es la fuente de verdad
del programa desplegado) y el pin del otro consumer
(`wasiai-facilitator/src/chains/escrow-idl.hash.test.ts:30`).

### Cómo se sostiene sincronizado (y qué queda a mano)

| Par a comparar | Qué lo chequea | Rojo automático |
|----------------|----------------|-----------------|
| IDL vendoreado de chaski ↔ constante pinneada | `idl/escrow-idl.hash.test.ts` AC-2 | **Sí**, siempre |
| IDL de `solana-programs` (fuente de verdad) ↔ constante pinneada | `idl/escrow-idl.hash.test.ts` AC-3 | Sólo si el sibling existe en el workspace (best-effort, `it.skip` limpio si no) |
| **Este documento ↔ constante pinneada** | `idl/escrow-idl.hash.test.ts` AC-DOC | **Sí**, siempre |
| Constante pinneada en chaski ↔ constante pinneada en `wasiai-facilitator` | **nadie**: repos separados, sin CI cross-repo | No — es revisión humana (misma deuda que la sección "Missing Input #1") |

El AC-DOC existe porque escribir "acordate de actualizar el doc" no funcionó: el re-pin del 2026-08-01
movió la constante en el test y dejó este archivo publicando el hash del 2026-07-28, y el drift
sobrevivió a un CR (`doc/sdd/038-wkh-321-chaski-computebudget-deposito/cr-report.md:57` llegó a citar la
línea vieja como "byte-idéntica a main", que era cierto y era justamente el problema). El test lee el
bloque de código de arriba y la última fila de la bitácora, y los compara contra la constante: **si
divergen, `npm test` falla**. Esa es la única razón por la que este número se puede creer.

⚠️ El hash **no** se calcula con `sha256sum` (hashea bytes, no JSON canónico) ni con Python
(`json.dumps` escapa los no-ASCII como `\uXXXX` y `JSON.stringify` no; el IDL tiene `docs` con
acentos ⇒ hash distinto sobre el mismo archivo). Usar `canonicalSha256` de `idl/canonical-hash.ts`.

Es el SHA-256 canónico (claves ordenadas) del IDL del escrow, address
`DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`. **Re-pinneo SOLO con artefacto explícito que lo
autorice** (una fila en la bitácora de arriba), jamás por drift silencioso: si alguien edita
`escrow-idl.ts` a mano el test se pone ROJO.
