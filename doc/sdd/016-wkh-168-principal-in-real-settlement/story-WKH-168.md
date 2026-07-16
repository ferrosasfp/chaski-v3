# Story File — #016: [WKH-168] GATE Fase A / G3 — Principal-in real

> SDD: `doc/sdd/016-wkh-168-principal-in-real-settlement/sdd.md` (**SPEC_APPROVED 2026-07-15**, clinical review AUTO)
> Fecha: 2026-07-15
> Branch: `feat/016-wkh-168-principal-in-real-settlement`
> SDD_MODE: full · **money-path real** (se mueve el PRINCIPAL, no fees) · Tamaño: **XL**
> Baseline verificado **ejecutando** el 2026-07-15: `npx vitest run` → **PASS (287) FAIL (0)**

---

## Goal

Hoy `principal_in` significa **"el usuario firmó"**, no "el USDC llegó". `confirm-and-send.ts:85-86` hace:

```ts
const { tx } = await this.wallet.authorizePrincipal(quote);   // ← una FIRMA (signTypedData)
r.markPrincipalIn(tx, this.clock.nowIso());                   // ← se marca como si hubiera plata
```

Nadie transmite esa autorización. Nadie espera un receipt. `waitForTransactionReceipt` tiene **0 ocurrencias**
en el repo. El payout se dispara sobre dinero que **puede no existir**.

Esta HU hace que `principal_in` signifique: **"hay un receipt on-chain que NOSOTROS verificamos leyendo el log
`Transfer` del contrato USDC, con el `from`, el `to` y el `value` correctos"** — y ata el payout a ese USDC
realmente recibido, con una atestación server-side que el atacante no puede forjar.

**Todo detrás de flags que siguen OFF por default. Esta HU construye, no enciende.**

> **Lo que esta HU NO cierra** (va al done-report, no lo intentes acá): **G5/WKH-206** (posesión criptográfica
> de la wallet), la **mitad B** del payout (USDC→PEN→Yape, bloqueada por el sandbox de TransFi),
> **partners/legal** (founder), **remesas huérfanas / persistencia** (**WKH-207**), y el **clawback real**
> (imposible: revertir un `transferWithAuthorization` exige la clave del *receiver*). **Cerrar G3 NO habilita
> la Fase A.**

---

## ⚠️ LEER ANTES DE TODO — las 3 ideas que hacen que esta HU exista

Si no entendés estas tres, vas a escribir código que parece correcto y no verifica nada.

### 1. La respuesta del facilitador es un ECO de nuestro propio input. No es una verificación.

`wasiai-facilitator/src/chains/base-adapter.ts:811` lo dice **literalmente en un comentario**:

```ts
// 7. Success (AC-7, AC-9). Fields from input params, NOT re-read from chain.
return {
  ok: true, settled: true,
  transactionHash: hash,
  blockNumber: Number(receipt.blockNumber),
  amount: params.accepted.amount,   // :817  ← LO QUE NOSOTROS MANDAMOS
  from: authorization.from,          // :818  ← LO QUE NOSOTROS MANDAMOS
  to: authorization.to,              // :819  ← LO QUE NOSOTROS MANDAMOS
  asset: token.address,              // :820
};
```

Entonces:

```ts
// ❌ ESTO NO VERIFICA NADA. Es una TAUTOLOGÍA.
if (res.to !== resolveReceiverAddress()) fail();
// res.to === authorization.to === el `to` que nosotros pusimos en el request.
// Comparás tu input contra tu input. SIEMPRE pasa. Da falsa sensación de seguridad.
```

**El AC-2 del work-item está mal formulado por esto** y su plan de tests describe un caso imposible
(*"fake gateway devuelve `{ok:true, to:"0xOTRO"}`"* — el facilitador real **nunca** puede devolver eso).
Ver "Corrección al SDD/work-item" abajo.

**Lo que SÍ prueba el 200 del facilitador**: que él hizo `simulateContract` → `writeContract` (`:764`) →
`waitForTransactionReceipt` (`:779`) → `receipt.status !== 'reverted'` (`:800`). Es evidencia **atestiguada
por un tercero**, no verificada por nosotros.

**Por eso existe el verificador on-chain (W3)**: leemos el receipt **nosotros**, con **nuestro** RPC, y
buscamos el log `Transfer` **emitido por el contrato USDC**. Ese log lo emite el token, no nosotros. Ahí sí
`to`, `from` y `value` son hechos de la cadena.

> **Al dev**: si en algún momento te tienta "simplificar" el verificador a `if (res.to === receiver)` porque
> "hace lo mismo con menos código" → **PARÁ**. No hace lo mismo. No hace nada. Es el bug que esta HU vino a
> matar. **CD-10.**

### 2. El facilitador acepta SOBRE-pago y sub-reporta el monto real.

`base-adapter.ts:609`:

```ts
if (BigInt(authorization.value) < acceptedAmount) { /* INVALID_AMOUNT */ }
```

Es un **`>=`**, no una igualdad. Si `authorization.value > accepted.amount`, **se settlea igual**. Y lo que se
mueve on-chain es `authorization.value` (`:471-472`), mientras la respuesta reporta `accepted.amount` (`:817`).
⇒ **Un settle honesto puede mover MÁS de lo que reporta.**

Por eso **nosotros exigimos igualdad exacta** (`value === expectedValueMinor`, rama **S11**) **antes** de
forwardear, y verificamos el `value` **del log on-chain** (rama **V8**) después. Somos **más estrictos que el
facilitador**, a propósito. No lo relajes a `>=` "para ser consistentes con el facilitador".

### 3. `ConfirmAndSend` corre en el CLIENTE. Todo chequeo que viva ahí es OPCIONAL para el atacante.

`ConfirmAndSend.execute()` se invoca desde `src/presentation/flow.tsx` — JS del browser. El atacante
simplemente **no lo ejecuta**: hace `POST /api/a2a/payout/submit` con `curl`. El propio código lo dejó escrito
en `app/api/a2a/payout/submit/route.ts:16-17`:

> *"Residual (NO lo cierra esta HU): kycPayoutAllowed sigue siendo un booleano del caller (WKH-203) y **nadie
> verifica que el sender pagó el principal en USDC (WKH-168)**."*

Por eso **W6 (la atestación server-side) es la wave que cierra G3**. Sin W6 esta HU hace honesto el camino
honesto y **no detiene al atacante**. Las waves W0-W5 son la plomería; **W6 es el gate**.

---

## Resoluciones vinculantes del gate SPEC_APPROVED (no re-litigar)

1. **W6 (AC-10/AC-11) ENTRA.** Decisión del humano (Fernando). La HU es **XL** y está asumido. Fundamento:
   *media medida no sirve — el AR va a probar el bypass ejecutando (como hizo en WKH-202)*. **W6 es primera
   clase, no un apéndice. No la descopes, no la dejes para el final "si da el tiempo".**
2. **DT-1 (reusar `wasiai-facilitator`) RATIFICADO.** La mecánica vive en `base-adapter.ts:750-822`;
   `avalanche.ts` es un *thin wrapper* (43113/43114). **CD-18: `chaski-v2` NO hace ni un `writeContract`.**
3. **DT-5 (verificación on-chain read-only INDEPENDIENTE) RATIFICADO.** Es el corazón de la HU.
4. **Nonce determinístico `keccak256(remittanceId:quoteId)`.** Hoy el nonce es random y **se descarta**
   (`wallet.ts:75` y `:190`) → un timeout + reintento = **el usuario paga dos veces**. Es un bug real y vivo.
5. **Refund real NO entra** (DT-8). Solo la marca `principal_settled_refund_manual` (AC-6).
6. **Estado server-side: Opción (A) Upstash, mínimo.** `SET NX` single-use por atestación. **NO** persistencia
   de remesa (eso es WKH-207 → **CD-8 intacto**). **Fail-closed: Upstash caído ⇒ 503, nunca forwardea.**

---

## 🏛️ DIRECTIVA DE ARQUITECTURA (vinculante) — broadcast y verificación son SEPARABLES

> Esto viene de una resolución del gate con fundamento **regulatorio**, no estético. Leelo entero.

La norma PSAV peruana (Res. SBS 02648-2024) define PSAV por la **actividad** — *"transferencia de activos
virtuales para o en nombre de otra persona"* — **no por la autodenominación**. El análisis legal dice, textual:
*"si el orquestador toca el USDC o dispara la transferencia en nombre del sender, la autodenominación 'capa
tech' no protege"*. Nuestro facilitator broadcasteando el `transferWithAuthorization` del usuario **es
exactamente el caso ambiguo**. La pregunta está con el abogado. **No bloquea esta HU** (todo se construye tras
flags, nada se enciende).

**Consecuencia de diseño, obligatoria:**

| Pieza | Rol | Riesgo legal | Destino si el veredicto es adverso |
|---|---|---|---|
| `onchain-verifier.ts` (W3) | **Leer** el receipt + el log `Transfer` | **Ninguno.** Leer una cadena no es transferir. | **Sobrevive intacto.** |
| `attestation.ts` + `attestation-store.ts` (W0/W6) | Firmar/verificar el hecho verificado | Ninguno | **Sobrevive intacto.** |
| `facilitator-client.ts` (W2) | **Transmitir** (rol de relayer) | **Es el único expuesto** | **Se reemplaza quién transmite.** |

**Reglas que hacen esto real (CD-20, CD-21):**

- `onchain-verifier.ts` **NO importa** `facilitator-client.ts`, **no lee ninguna env `FACILITATOR_*`**, y **no
  sabe quién broadcasteó**. Su input es un **`txHash` de cualquier origen**. Si mañana el usuario se
  auto-broadcastea y nos postea el hash, el verificador funciona **sin cambiar una línea**.
- `facilitator-client.ts` **NO importa** `onchain-verifier.ts` y **no verifica nada**. Devuelve un `txHash` o
  un error. Es el **único** archivo del repo que conoce `FACILITATOR_BASE_URL` / `FACILITATOR_API_KEY`.
- **El único lugar que los compone** es `app/api/settle/principal/route.ts` (broadcast → verify → attest).

> **Si acoplás los dos, un veredicto legal adverso mata la HU entera.** Separados, solo se reemplaza el
> transmisor. **Es la diferencia entre tirar 3 waves y tirar 1 archivo.**

---

## Acceptance Criteria (EARS)

> AC-1…AC-9 heredados del work-item (con 2 correcciones de grounding). AC-10/AC-11 aprobados en el gate.

1. **AC-1**: WHEN `NEXT_PUBLIC_EIP3009_ENABLED=true` y el usuario autoriza el principal, the system SHALL
   **transmitir** la autorización `transferWithAuthorization` firmada — no solo retener la firma — mediante un
   gateway de settlement dedicado.
2. **AC-2** *(reinterpretado — ver "Corrección")*: WHEN el settlement produce un receipt minado, the system
   SHALL verificar **leyendo la cadena por su cuenta** (receipt + log `Transfer` emitido por
   `resolveUsdcAddress()`) que el `to` coincide con `resolveReceiverAddress()` y que el `value` coincide con
   `quote.send.minor`, **antes** de transicionar a `principal_in`. **NO** se cumple chequeando la respuesta del
   facilitador (es un eco — `base-adapter.ts:811`).
3. **AC-3**: IF el receipt revirtió, O el monto/receiver no coincide, O el gateway devuelve error (incl.
   `CHAIN_UNAVAILABLE`, cap diario, `OPERATOR_FUNDING_LOW`, timeout), THEN the system SHALL **NO** transicionar
   a `principal_in` y SHALL transicionar `confirmed → payout_failed` (vía `failAndRefund`), dejando
   `principalTx` en `null`.
4. **AC-4**: WHEN se alcanza `principal_in` en modo real, the system SHALL persistir el **hash verificado
   on-chain** como `principalTx` — **nunca la firma cruda**.
5. **AC-5**: WHILE `NEXT_PUBLIC_EIP3009_ENABLED` está unset/`false` (default), the system SHALL preservar el
   comportamiento **byte-idéntico** a pre-HU.
6. **AC-6**: IF una remesa alcanza `principal_in` en modo real y luego transiciona a `payout_failed`, THEN the
   system SHALL registrar `failureReason = "principal_settled_refund_manual"` — marca estable que dice que el
   refund automático es **ledger-only y NO revierte** el principal ya settleado.
7. **AC-7**: WHEN se transmite el settlement, the system SHALL hacerlo desde una **ruta server-side** (nunca
   exponer credenciales del facilitador al cliente) que delega en el `/settle` auditado de
   `wasiai-facilitator`.
8. **AC-8**: the system SHALL NO debilitar el guard fail-loud de `container.ts:59-67`.
9. **AC-9**: the system SHALL documentar (comentario inline en el port/gateway nuevo) que la **remesa
   huérfana** NO se cierra en esta HU → **WKH-207**.
10. **AC-10**: WHEN `SETTLE_ATTESTATION_SECRET` está configurado, `POST /api/a2a/payout/submit` SHALL rechazar
    (**403**) toda request sin atestación de settlement válida (HMAC vigente, `valueMinor` == `amountUsd` del
    body, `from` ≡ `address` del body), **ANTES** de forwardear al agente.
11. **AC-11**: WHEN una atestación válida ya fue consumida, SHALL rechazarla (**409**) sin forwardear; IF
    Upstash no está disponible/configurado, THEN SHALL responder **503** (fail-closed), **NUNCA** forwardear.

---

## 📏 REGLA DE CONTEO — la autoridad es el RUNNER, nunca `grep`

> Esto causó **5 errores de conteo** en esta sesión (5→7 tests, 4→5 niveles, 7→8, 4→5, 6→8 en
> `container.test.ts`) y el work-item dice "los 6 tests de `container.test.ts`" cuando **son 8**.

El `grep -c "^\s*it("` que prescribía el auto-blindaje de WKH-202 **es ambiguo**: cuenta un `it.each` de 4
casos como **1**. Verificado ejecutando, en este repo, hoy:

| Archivo | `grep -cE '^\s*it(\.each)?\('` | `npx vitest run <archivo>` | ¿Coinciden? |
|---|---|---|---|
| `src/composition/container.test.ts` | 8 | **8** | sí |
| `src/application/use-cases/confirm-and-send.test.ts` | 14 | **14** | sí |
| `src/infrastructure/wallet.test.ts` | — | **16** | — |
| `src/infrastructure/a2a/gateways.test.ts` | — | **11** | — |
| **`app/api/a2a/payout/submit/route.test.ts`** | **16** | **19** | **NO** ⚠️ |

**CD-13**: la **única** autoridad de cualquier conteo de tests es el output del runner
(`npx vitest run <archivo>` → `PASS (N)`). **PROHIBIDO usar `grep -c` como autoridad.** Todo número de este
Story File viene del runner, ejecutado hoy.

---

## Baselines verificados **ejecutando** (2026-07-15, `main`)

| Comando | Resultado |
|---|---|
| `npx vitest run` | **PASS (287) FAIL (0)** ← baseline de la HU |
| `npx vitest run src/composition/container.test.ts` | **PASS (8)** ← el work-item decía 6 |
| `npx vitest run src/application/use-cases/confirm-and-send.test.ts` | **PASS (14)** |
| `npx vitest run src/infrastructure/wallet.test.ts` | **PASS (16)** |
| `npx vitest run src/infrastructure/a2a/gateways.test.ts` | **PASS (11)** |
| `npx vitest run app/api/a2a/payout/submit/route.test.ts` | **PASS (19)** ⚠️ (grep diría 16) |

---

## Files to Modify/Create

> **24 archivos: 11 nuevos + 13 modificaciones** (verificado contando las filas de esta tabla, no a ojo —
> CD-13). Cualquier archivo fuera de esta tabla → **PARAR y escalar** (CD-22).

| # | Archivo | Acción | Qué hacer | Wave |
|---|---------|--------|-----------|------|
| 1 | `src/application/ports.ts` | Modificar | `Eip3009Authorization`, `PrincipalSettlementGateway`, `SettlementFailureReason`; `WalletPort.authorizePrincipal(quote, remittanceId)`; `PayoutSubmit.settlementAttestation?` | W0.1 |
| 2 | `src/infrastructure/settlement/attestation.ts` | **CREAR** | `issueSettlementAttestation` / `verifySettlementAttestation` (HMAC, patrón `kyc-auth.ts`) | W0.2 |
| 3 | `src/infrastructure/settlement/attestation.test.ts` | **CREAR** | 5 tests | W0.2 |
| 4 | `src/test-support/fakes.ts` | Modificar | `FakeSettlementGateway`; `FakeWallet` gana `eip3009` opcional | W0.3 |
| 5 | `src/test-support/test-container.ts` | Modificar | `settlement?: PrincipalSettlementGateway` en overrides + 7º arg de `ConfirmAndSend` | W0.4 |
| 6 | `src/infrastructure/wallet.ts` | Modificar | Payload EIP-3009 completo + **nonce determinístico** | W1.1 |
| 7 | `src/infrastructure/wallet.test.ts` | Modificar | **BREAKER de tsc** (8 call sites) + 3 tests | W1.2 |
| 8 | `src/infrastructure/settlement/facilitator-client.ts` | **CREAR** | **Broadcast** — el ÚNICO que conoce `FACILITATOR_*` (CD-20) | W2.1 |
| 9 | `app/api/settle/principal/route.ts` | **CREAR** | Ramas **S1-S21** + composición broadcast→verify→attest | W2.2 |
| 10 | `app/api/settle/principal/route.test.ts` | **CREAR** | 20 tests | W2.3 |
| 11 | `src/infrastructure/settlement/onchain-verifier.ts` | **CREAR** | Ramas **V1-V9** — **read-only**, cero `writeContract` (CD-18/CD-21) | W3.1 |
| 12 | `src/infrastructure/settlement/onchain-verifier.test.ts` | **CREAR** | 9 tests | W3.2 |
| 13 | `src/infrastructure/settlement/http-settlement-gateway.ts` | **CREAR** | Cliente → `/api/settle/principal` | W4.1 |
| 14 | `src/infrastructure/settlement/http-settlement-gateway.test.ts` | **CREAR** | 5 tests | W4.2 |
| 15 | `src/composition/container.ts` | Modificar | Instanciar **solo** si el flag está on. **Guard `:59-67` INTACTO** | W4.3 |
| 16 | `src/composition/container.test.ts` | Modificar | +2 tests. **Los 8 existentes: asserts intactos** | W4.4 |
| 17 | `src/application/use-cases/confirm-and-send.ts` | Modificar | Ramas **C1-C8** + marca AC-6 | W5.1 |
| 18 | `src/application/use-cases/confirm-and-send.test.ts` | Modificar | +10 tests. **Los 14 existentes: asserts intactos** | W5.2 |
| 19 | `src/infrastructure/settlement/attestation-store.ts` | **CREAR** | Upstash `SET NX` single-use — **fail-CLOSED** | W6.1 |
| 20 | `src/infrastructure/settlement/attestation-store.test.ts` | **CREAR** | 4 tests | W6.2 |
| 21 | `app/api/a2a/payout/submit/route.ts` | Modificar | Ramas **A1-A10**. **Guards 1-6 byte-idénticos** (CD-11) | W6.3 |
| 22 | `app/api/a2a/payout/submit/route.test.ts` | Modificar | +9 tests. **Los 19 existentes: asserts intactos** | W6.4 |
| 23 | `src/infrastructure/a2a/gateways.ts` | Modificar | `settlementAttestation` en el body | W6.5 |
| 24 | `.env.example` | Modificar | 4 env vars **server-only** + nota de flags OFF | W7.1 |

**NO se tocan** (verificado por grep exhaustivo):
`src/domain/**` (`remittance.ts`, `money.ts` — la FSM ya soporta todo), `src/presentation/**`,
`src/infrastructure/fallback/gateways.ts`, `src/infrastructure/refund/ledger-refund-gateway.ts`
(la marca AC-6 vive en `confirm-and-send.ts`, **no** en el gateway),
`src/infrastructure/chain.ts`, `src/infrastructure/kyc-auth.ts`, `src/infrastructure/rate-limit.ts`,
`src/infrastructure/a2a/gateways.test.ts`, `app/api/payout/validate/**`, `src/infrastructure/payout/authority.ts`.

---

## 🔴 Blast radius — los DOS breakers de tsc (survey ya hecho, no lo repitas)

### Breaker 1: `WalletPort.authorizePrincipal(quote, remittanceId)` — **`wallet.test.ts` rompe en 8 lugares**

`remittanceId` es **REQUERIDO** (no opcional). Un `remittanceId?: string` permitiría caer en silencio al nonce
random → **fail-open sobre CD-19** (la garantía anti-doble-pago). **Prohibido.**

| Consumidor | ¿Rompe tsc? | Por qué |
|---|---|---|
| **`src/infrastructure/wallet.test.ts`** líneas **198, 250, 262, 274, 291, 302, 319, 329** | **SÍ — 8 call sites** | Llaman `w.authorizePrincipal(quote)` con **1 arg** → `Expected 2 arguments, but got 1`. **Éste es el `gateways.test.ts` de esta HU: el breaker real.** En Scope IN (W1.2). Agregar el 2º arg es **SETUP (args de llamada), no un assert** — precedente WKH-202. |
| `src/application/use-cases/confirm-and-send.ts:85` | **SÍ** — call site | En Scope IN (W5.1) |
| `src/infrastructure/wallet.ts:65,114,181` | Implementaciones | Se modifican (W1.1). `FallbackWallet:114` puede **ignorar** el 2º arg (`_remittanceId`) — TS admite implementar con menos/ignorar params |
| `src/test-support/fakes.ts:250` | **No** | `FakeWallet.authorizePrincipal(_quote)` — implementar con menos params es válido en TS. Se extiende igual (W0.3) para poder devolver `eip3009` |
| `src/application/use-cases/confirm-and-send.test.ts:52,95,147,168` | **No** | Son `vi.spyOn(wallet, "authorizePrincipal")` — la aridad no rompe el spy |
| `src/presentation/**` | **No** | 0 ocurrencias (grep verificado) |

### Breaker 2: `PayoutSubmit.settlementAttestation?: string` — **OPCIONAL, no rompe nada**

| Consumidor | ¿Rompe tsc? | Por qué |
|---|---|---|
| `src/infrastructure/a2a/gateways.test.ts:20` (`const payoutReq: PayoutSubmit = {…}` literal tipado) | **No** | El campo es **opcional** → el literal sigue válido. (Contraste con WKH-202, donde `address` era requerido y **sí** rompía). **NO lo toques.** |
| `src/application/use-cases/confirm-and-send.ts:103` | No (pero se agrega) | W5.1 |
| `gateways.ts:119`, `fallback/gateways.ts:98`, `fakes.ts:216` | No | Consumidores, ignoran el arg |

> **¿Por qué opcional NO es fail-open acá** (a diferencia de `address` en WKH-202)? Porque **el enforcement
> vive en el SERVIDOR** (rama **A3**: atestación ausente ⇒ 403), no en el tipo. El campo es opcional porque en
> **modo demo no existe atestación** y el demo debe seguir andando byte-idéntico (AC-5). El atacante omitirlo
> no lo ayuda: el server la exige igual. **Decilo así si el AR pregunta.**

> **Al dev**: **tsc rojo en un archivo NO listado arriba → desviación reportable.** No lo arregles en
> silencio: significa que este survey falló. **PARAR y escalar** (CD-22).

---

## Contrato EXACTO del facilitador (verificado campo a campo contra el Zod real — NO inventar)

Fuente: `wasiai-facilitator/src/core/schemas.ts:60-98` + `:112` (`SettleRequestSchema = VerifyRequestSchema`)
y `src/methods/eip3009/schemas.ts:17-58`. **Todos los objetos son `.strict()` ⇒ un campo extra = 400.**

```jsonc
POST {FACILITATOR_BASE_URL}/settle
Authorization: Bearer {FACILITATOR_API_KEY}        // middleware/auth.ts:102-106
content-type: application/json

{
  "x402Version": 2,                                // z.literal(2)  ← el número 2, NO "2"
  "resource": { "url": "https://…" },              // z.string().url()  ← .strict(): solo url|description|mimeType
  "accepted": {                                    // .strict()
    "scheme": "exact",                             // z.literal('exact')
    "network": "eip155:43113",                     // z.string().min(1); core/settle.ts:33 → /^eip155:([1-9]\d*)$/
    "amount":  "400000000",                        // Uint256StringSchema  ← STRING decimal canónico
    "asset":   "0x5425890298aed601595a70AB815c96711a31Bc65",  // AddressHexSchema /^0x[0-9a-fA-F]{40}$/
    "payTo":   "0x…",                              // AddressHexSchema
    "maxTimeoutSeconds": 60,                       // z.number().int().positive()
    "extra": {                                     // .strict()
      "assetTransferMethod": "eip3009",            // z.enum(['eip3009','permit2','erc7710'])
      "name": "USD Coin",                          // opcional
      "version": "2"                               // opcional
    }
  },
  "payload": {                                     // .strict()
    "signature": "0x…",                            // /^0x[0-9a-fA-F]+$/
    "authorization": {                             // Eip3009AuthorizationSchema (schemas.ts:49-56)
      "from":        "0x…",                        // AddressHexSchema
      "to":          "0x…",                        // AddressHexSchema
      "value":       "400000000",                  // Uint256StringSchema
      "validAfter":  "0",                          // Uint256StringSchema
      "validBefore": "1783036800",                 // Uint256StringSchema
      "nonce":       "0x<64 hex>"                  // Bytes32HexSchema /^0x[0-9a-fA-F]{64}$/
    }
  }
}
```

**`Uint256StringSchema` = `/^(0|[1-9]\d*)$/`** (`eip3009/schemas.ts:36-38`) ⇒ **rechaza** ceros a la izquierda
(`"01"`), negativos, notación científica (`"1e2"`), vacío y espacios.

**Respuesta 200** (`routes/settle.ts:385-392`): `{ settled, transactionHash, blockNumber, amount, from, to, asset }`.

**Mapa de errores del facilitador → nuestro status** (ramas S14-S20):

| Facilitador | Códigos | Nuestro status | Nuestro `error` |
|---|---|---|---|
| 401 / 403 | `UNAUTHORIZED`, `FORBIDDEN` (payTo allowlist, `settle.ts:131`) | **502** | `settle_rejected` |
| 400 | `INVALID_PAYLOAD`, `INVALID_AMOUNT`, `INVALID_RECEIVER`, `NETWORK_MISMATCH`, `EXPIRED_AUTHORIZATION` | **502** | `settle_rejected` |
| 409 | `CONFLICT` (in-flight, `settle.ts:177`) | **409** | `settle_in_flight` |
| 429 / 503 | `RATE_LIMITED`, `CHAIN_UNAVAILABLE`, `OPERATOR_FUNDING_LOW`, `SERVICE_UNAVAILABLE` | **503** | `settle_unavailable` |
| 500 | `TRANSACTION_FAILED` (incluye revert on-chain, `base-adapter.ts:800`) | **502** | `settle_reverted` |
| throw / timeout | — | **504** | `settle_unavailable` |
| 200 con shape malo | — | **502** | `settle_unverified` |

**CD-12 (no-oracle)**: **NUNCA** ecoamos el `code`/`message` del facilitador al cliente. Solo nuestros enums.

**Conversión de tipos (CD-16)**: `wallet.ts` firma con `BigInt`/`0x…`; el schema exige **strings decimales
canónicos**. La serialización `bigint → string` se hace **en `wallet.ts`** (donde se firma).
**PROHIBIDO `JSON.stringify` sobre un `bigint`** → tira `TypeError`.

---

## Ramas — TODAS fail-closed, enumeradas una por una

> Precedentes que justifican esta paranoia: **WKH-198** shipeó un fail-open por `NaN`; el SDD de **WKH-204**
> casi shipea otro con `String()`; **`z.string().min(1)` NO trimea**. **CD-12: ante error, timeout,
> ambigüedad, `reason` desconocido o dependencia caída → BLOQUEAR.** Sin `default:` permisivo.

### S — `POST /api/settle/principal` (ruta NUEVA, server-only) — orden OBLIGATORIO

Espeja el guard-order de `submit/route.ts:46-96`.

| # | Condición | Resultado | Nota |
|---|---|---|---|
| **S1** | `process.env.NEXT_PUBLIC_EIP3009_ENABLED !== "true"` | **501** `settle_not_enabled` | **PRIMER guard.** CD-1: la HU construye, no enciende. Ningún fetch. |
| **S2** | `!FACILITATOR_BASE_URL` **o** `!FACILITATOR_API_KEY` | **501** `settle_not_configured` | Sin backend no hay nada que settlear. Ningún fetch. |
| **S3** | `resolveReceiverAddress()` / `resolveUsdcAddress()` throw | **500** `settle_misconfigured` (**capturado**, nunca crudo) | Defensivo: la ruta es un proceso server distinto del container |
| **S4** | body no-record (`null`, `[]`, `123`, `"s"`) | **400** `settle_invalid_request` | **CD-15**: `await req.json().catch(() => null)` + `isRecord`. `req.json()` **resuelve** con `null` ante el body `null` → el `.catch` NO dispara (WKH-202/BLQ-BAJO-1) |
| **S5** | `authorization` ausente/no-record, o falta alguno de los 6 campos, o alguno no es `string` | **400** `settle_invalid_request` | `typeof x === "string"`. **PROHIBIDO `String(x)`** (`String(123)==="123"` — WKH-204) |
| **S6** | `signature` no matchea `/^0x[0-9a-fA-F]+$/` | **400** `settle_invalid_request` | |
| **S7** | `nonce` no matchea `/^0x[0-9a-fA-F]{64}$/` | **400** `settle_invalid_request` | bytes32 exacto |
| **S8** | `value` / `validAfter` / `validBefore` no matchean `/^(0\|[1-9]\d*)$/` | **400** `settle_invalid_request` | Rechaza `"01"`, `"-1"`, `"1e2"`, `""`, `" 1 "`. **SIN trim** (`z.string().min(1)` no trimea — WKH-204) |
| **S9** | `address` vacío / no-string / `!isAddress(address)` | **400** `settle_invalid_request` | |
| **S10** | `expectedValueMinor` no es entero ≥ 1 | **400** `settle_invalid_request` | `typeof === "number" && Number.isInteger(x) && x >= 1`. **PROHIBIDO `Number(x)`** (`Number("")===0` — WKH-198) |
| **S11** | `authorization.value !== String(expectedValueMinor)` | **400** `settle_amount_mismatch` | **Igualdad EXACTA** — stricter que el `>=` del facilitador (`base-adapter.ts:609`). Ningún fetch |
| **S12** | `!isAddressEqual(authorization.to, resolveReceiverAddress())` | **400** `settle_receiver_mismatch` | **CD-9**: el `payTo` sale de **env**, jamás del body. Ningún fetch |
| **S13** | `!isAddressEqual(authorization.from, address)` | **400** `settle_sender_mismatch` | Ata la firma al caller declarado. Ningún fetch |
| **S14** | Facilitador → 401 / 403 | **502** `settle_rejected` | Config del operador. **Nunca** ecoa el motivo (CD-12) |
| **S15** | Facilitador → 400 (`INVALID_*` / `NETWORK_MISMATCH` / `EXPIRED_AUTHORIZATION`) | **502** `settle_rejected` | |
| **S16** | Facilitador → 409 `CONFLICT` | **409** `settle_in_flight` | El cliente **NO** debe re-firmar (DT-6) |
| **S17** | Facilitador → 429 / 503 | **503** `settle_unavailable` | **AC-3** |
| **S18** | Facilitador → 500 `TRANSACTION_FAILED` | **502** `settle_reverted` | **AC-3** |
| **S19** | Timeout / DNS / `fetch` throw | **504** `settle_unavailable` | `AbortSignal.timeout(45_000)`. **Ambiguo**: la tx pudo minarse. Fail-closed → `payout_failed`; el reintento con el MISMO nonce (DT-6) es seguro |
| **S20** | 200 pero JSON no parsea, **o** `settled !== true`, **o** `transactionHash` no matchea `/^0x[0-9a-fA-F]{64}$/` | **502** `settle_unverified` | **NUNCA asumir éxito por HTTP 200** |
| **S21** | 200 + shape OK | → **rama V** | **El 200 NO es suficiente** (idea #1) |

**CD-9 — construcción de `accepted` (NUNCA del body):**

| Campo | Fuente **obligatoria** | Prohibido |
|---|---|---|
| `payTo` | `resolveReceiverAddress()` | ~~body~~ |
| `asset` | `resolveUsdcAddress()` | ~~body~~ |
| `network` | `` `eip155:${resolveChainId()}` `` | ~~body~~ |
| `amount` | `String(expectedValueMinor)` (ya pinneado igual a `authorization.value` en S11) | ~~body~~ |

### V — Verificación on-chain INDEPENDIENTE (`onchain-verifier.ts`) — read-only

**Input**: `{ txHash, expectedFrom, expectedTo, expectedValueMinor }`. **No sabe quién broadcasteó** (CD-21).

| # | Condición | Resultado |
|---|---|---|
| **V1** | `!AVALANCHE_RPC_URL` | **503** `settle_unverified` — **fail-closed**: sin poder verificar, NO se atestigua |
| **V2** | `getTransactionReceipt` throw / timeout | **503** `settle_unverified` |
| **V3** | `receipt.status !== "success"` | **502** `settle_reverted` |
| **V4** | **0** logs `Transfer` emitidos por `resolveUsdcAddress()` en el receipt | **502** `settle_unverified` |
| **V5** | **≥2** logs `Transfer` emitidos por `resolveUsdcAddress()` | **502** `settle_unverified` — ambigüedad ⇒ bloquear (no elegir "el primero") |
| **V6** | (exactamente 1 log) `!isAddressEqual(log.args.to, resolveReceiverAddress())` | **502** `settle_receiver_mismatch` — **AC-2** |
| **V7** | (exactamente 1 log) `!isAddressEqual(log.args.from, expectedFrom)` | **502** `settle_sender_mismatch` |
| **V8** | (exactamente 1 log) `log.args.value !== BigInt(expectedValueMinor)` | **502** `settle_amount_mismatch` — **AC-2**, cierra el sobre-pago (idea #2) |
| **V9** | Todo OK | **200** → recién acá se **emite la atestación** (DT-7) |

> ⚠️ **V5 filtra por EMISOR (el contrato USDC), NUNCA por `to`.** Ver "Corrección al SDD" #1: si filtrás por
> `to === receiver`, V6 se vuelve **inalcanzable** y el chequeo del receiver vuelve a ser una tautología — el
> bug exacto que la HU vino a matar.

**Algoritmo obligatorio:**

```ts
// Read-only. Cero wallet, cero clave privada, cero writeContract (CD-18).
const transfers = parseEventLogs({ abi: USDC_TRANSFER_ABI, eventName: "Transfer", logs: receipt.logs })
  .filter((l) => isAddressEqual(l.address, usdc));   // ← filtro por EMISOR, y SOLO por emisor
if (transfers.length === 0) return { ok: false, reason: "settlement_unverified" };  // V4
if (transfers.length > 1)  return { ok: false, reason: "settlement_unverified" };  // V5 (ambigüedad)
const t = transfers[0];
// V6/V7/V8 sobre el ÚNICO log → cada uno con su reason distinguible
```

Un `transferWithAuthorization` de USDC (FiatTokenV2) emite **exactamente 1** `Transfer`. `>1` = algo que no
entendemos ⇒ **bloquear**.

ABI (única fuente, sin hardcodear el contrato — sale de `resolveUsdcAddress()`):

```ts
const USDC_TRANSFER_ABI = [{
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from",  type: "address", indexed: true },
    { name: "to",    type: "address", indexed: true },
    { name: "value", type: "uint256", indexed: false },
  ],
}] as const;
```

### A — Atestación en `POST /api/a2a/payout/submit` (**la wave que cierra G3**)

Se inserta **DESPUÉS** del guard de autoridad WKH-202 (`route.ts:78-96`) y **ANTES** del forward (`:98`).
**Los guards 1-6 existentes quedan byte-idénticos** (CD-11).

| # | Condición | Resultado |
|---|---|---|
| **A1** | `!SETTLE_ATTESTATION_SECRET` **y** `(process.env.VERCEL_ENV ?? "") === ""` | **skip** → forward. Pre-HU byte-idéntico (AC-5/CD-1; demo local intacto). **Los 19 tests existentes caen acá.** |
| **A2** | `!SETTLE_ATTESTATION_SECRET` **y** `VERCEL_ENV !== ""` | **503** `payout_settlement_unavailable` — nunca fail-open en un deploy (patrón `simulated_dev`, `route.ts:74-76`) |
| **A3** | `settlementAttestation` ausente / no-string / vacío | **403** `payout_principal_unverified` |
| **A4** | Formato inválido (no `<b64>.<b64>`) **o** HMAC no matchea (timing-safe, **longitud primero** — `kyc-auth.ts:31`) | **403** `payout_principal_unverified` |
| **A5** | `exp` ausente / no-number / vencido | **403** `payout_principal_unverified` |
| **A6** | `att.valueMinor !== Money.of(body.amountUsd,"USDC").minor` | **403** `payout_principal_unverified` — **mata "monto arbitrario"** |
| **A6′** | `body.amountUsd` no es `number` finito `> 0`, **o** `Money.of` throw | **403** `payout_principal_unverified` — **ver el defecto abajo. NUNCA 500.** |
| **A7** | `att.from.toLowerCase() !== body.address.toLowerCase()` | **403** `payout_principal_unverified` — ata el pagador on-chain al address ya KYC-validado (WKH-202) |
| **A8** | `SET NX settle:att:<txHash>` → **ya existía** | **409** `payout_already_settled` (anti-replay) |
| **A9** | Upstash no configurado / throw | **503** `payout_settlement_unavailable` — **fail-CLOSED, NUNCA forwardea** |
| **A10** | Todo OK | → forward (bloque `:98-114` **intacto**) |

**CD-12 (no-oracle)**: A3-A7 devuelven **el mismo** `error`. El endpoint **no** es un oráculo de *por qué* falló.

#### 🐛 A6′ — el defecto que el Story File corrige (leer sí o sí)

`body.amountUsd` viene del **caller hostil**. `Money.of()` (`money.ts:17-25`) **TIRA** con `NaN`, negativo, o
`minor > MAX_SAFE_INTEGER`. Y este bloque corre **FUERA** del `try/catch` de la route (que abre recién en el
forward, `:98`) ⇒ **un throw acá = 500 crudo**. Es **exactamente** el bug WKH-202/BLQ-BAJO-1 repitiéndose, y
viola el contrato de la cabecera del archivo (*"TODO en try/catch: nunca 500 crudo"*).

```ts
// A6′ — guard de tipo ANTES de Money.of (CD-16), + try/catch por el cap de MAX_SAFE_INTEGER.
if (typeof body.amountUsd !== "number" || !Number.isFinite(body.amountUsd) || body.amountUsd <= 0) {
  return NextResponse.json({ error: "payout_principal_unverified" }, { status: 403 });
}
let expectedMinor: number;
try {
  expectedMinor = Money.of(body.amountUsd, "USDC").minor;
} catch {
  return NextResponse.json({ error: "payout_principal_unverified" }, { status: 403 });
}
if (expectedMinor !== att.valueMinor) {
  return NextResponse.json({ error: "payout_principal_unverified" }, { status: 403 });
}
```

- **PROHIBIDO `Money.of(Number(body.amountUsd), "USDC")`**: `Number("abc")` = `NaN` → `Money.of` throw → 500.
- **A6′ vive DENTRO del bloque de atestación** (después de A1/A2). Así el camino A1-skip queda
  **byte-idéntico** y los **19** tests existentes no se enteran. **No lo subas al guard de formato del paso 3**
  (rompería CD-11).
- Import de `Money`: `"../../../../../src/domain/money"` (**5 niveles** — ver abajo).

### C — `ConfirmAndSend` (rama real). Con el flag OFF **ninguna** corre (AC-5).

Se inserta entre `:85` (firma) y `:86` (`markPrincipalIn`).

**¿Cómo sabe `ConfirmAndSend` que está en "modo real"?** → **`this.settlement !== undefined`.**
El gateway es un **7º parámetro OPCIONAL del constructor** y el container **solo lo instancia si el flag está
on** (W4.3) ⇒ **AC-5 se preserva por construcción**, sin que el use-case lea ni una env var (CD-14).
Los 14 tests existentes construyen con 6 args → **no rompen** (contraste con WKH-201, que sí era un cambio de
constructor rompedor).

| # | Condición | Resultado |
|---|---|---|
| **C1** | `this.settlement` definido y `res.eip3009 === undefined` | `failAndRefund("settlement_unverified")`, **NO** `markPrincipalIn` — invariante rota, fail-loud |
| **C2** | `settle()` → `{ok:false, reason}` (cualquiera) | `failAndRefund(reason)`, `principalTx` sigue **`null`** (**AC-3**) |
| **C3** | `settle()` **throw** (red/bug) | `failAndRefund("settlement_unavailable")` — **CD-12**: try/catch, ninguna excepción escapa |
| **C4** | `{ok:true}` pero `valueMinor !== quote.send.minor` | `failAndRefund("settlement_amount_mismatch")`, **NO** `markPrincipalIn` (**AC-2**, camino honesto) |
| **C5** | `{ok:true}` pero `!isAddressEqual(to, resolveReceiverAddress())` | `failAndRefund("settlement_receiver_mismatch")`, **NO** `markPrincipalIn` (**AC-2**) |
| **C6** | `{ok:true}` + monto + receiver OK | `markPrincipalIn(txHash)` — **AC-4**: el **hash verificado**, NUNCA la firma. La atestación se guarda en memoria para el submit |
| **C7** | Tras `principal_in`, quote vencido (`:95`) | `failAndRefund("quote_expired_before_submit")` **+ marca AC-6** (el principal está **realmente adentro**) |
| **C8** | Tras `principal_in`, el payout falla | `failAndRefund(reason)` **+ marca AC-6** |

**El re-check de expiry 3.5 (`:94-98`) queda DESPUÉS del settle.** Si el quote venció durante el settle, el
principal **ya está adentro** → `principal_in → payout_failed` es transición válida (`remittance.ts:92`) →
refund con la marca AC-6. **No muevas el orden de guards** (CAS → autoridad → expiry → firma → **settle** →
EXPIRY → submit).

#### La marca AC-6 — contrato exacto

```ts
// failAndRefund gana un 3er parámetro. `principalReallyIn` = el principal se movió DE VERDAD on-chain.
private async failAndRefund(r: Remittance, reason: string, principalReallyIn = false): Promise<void> {
  // AC-6/DT-8 (WKH-168): con el principal REALMENTE adentro, LedgerRefundGateway NO revierte nada
  // (ledger-refund-gateway.ts:9 devuelve un refundTx SINTÉTICO). Reusar el reason normal sería una
  // mentira nueva y peligrosa (R5). Marca estable, sin PII (CD-17). El clawback real es IMPOSIBLE con
  // el patrón RefundGateway: revertir un transferWithAuthorization exige la clave del RECEIVER → Scope
  // OUT (DT-8). Resolución MANUAL. Reconciliación → WKH-207.
  const effective = principalReallyIn ? "principal_settled_refund_manual" : reason;
  r.markPayoutFailed(effective, this.clock.nowIso());
  // … resto INTACTO; creditBack recibe `effective`
}
```

- `principalReallyIn = true` **SOLO** en **C7** y **C8** (post-`markPrincipalIn`) **y** con `this.settlement`
  definido (modo real). En **modo demo el default `false` mantiene todo byte-idéntico** → el test existente que
  assertea `quote_expired_before_submit` en el re-check 3.5 **sigue verde sin tocarlo** (AC-5).
- **C1-C5 pasan `false`**: ahí el principal **NO** entró.

---

## Imports — profundidad exacta (verificada con `os.path.relpath`, NO la adivines)

**PROHIBIDO `@/`** (lección WKH-198): **no existe `vitest.config.*`** en este repo (verificado: `ls` vacío) ni
`vite-tsconfig-paths` → el alias pasa `typecheck` + `next build` pero **revienta vitest**. Ruta relativa,
siempre.

| Desde | Hacia `src/**` | Niveles |
|---|---|---|
| `app/api/settle/principal/route.ts` | `"../../../../src/infrastructure/settlement/onchain-verifier"` | **4** |
| `app/api/a2a/payout/submit/route.ts` | `"../../../../../src/domain/money"` | **5** |
| `src/infrastructure/settlement/*.ts` → `src/**` | `"../chain"`, `"../../domain/money"`, `"../../application/ports"` | — |

> `app/api/a2a/payout/submit/` está **un nivel más profundo** que `app/api/settle/principal/`. Ya existe en
> vivo: `submit/route.ts:19` usa **5** (`"../../../../../src/infrastructure/payout/authority"`). Copiá esa.

---

## Exemplars verificados (paths y líneas confirmados con Read)

### Exemplar 1 — Ruta API server-only fail-closed
**`app/api/a2a/payout/submit/route.ts:42-115`** · para **#9** (`settle/principal/route.ts`)
Guard-order, `const parsed: unknown = await req.json().catch(() => null)` + `isRecord` (`:54-55`), errores
opacos, `AbortSignal.timeout` (`:103`), env leída **dentro** del handler (`:43`, CD-14), `VERCEL_ENV` (`:74`).

### Exemplar 2 — HMAC stateless
**`src/infrastructure/kyc-auth.ts:10-33`** · para **#2** (`attestation.ts`)
```ts
import { createHmac, timingSafeEqual } from "node:crypto";
function secret(): string {                      // ← el secreto se lee DENTRO (CD-14: vi.stubEnv)
  const s = process.env.KYC_SESSION_SECRET;
  if (!s) throw new Error("KYC_SESSION_SECRET missing");
  return s;
}
// verify: longitud PRIMERO (timingSafeEqual TIRA con buffers de distinta longitud), sin throw
if (a.length !== b.length) return false;         // :31
return timingSafeEqual(a, b);
```
`createHmac("sha256", secret()).update(x).digest("base64url")`. **NO `jsonwebtoken`/`jose`.**

### Exemplar 3 — Upstash lazy + reset para tests
**`src/infrastructure/rate-limit.ts:54-79` + `:109-111`** · para **#19** (`attestation-store.ts`)
Copiá: `new Redis({ url, token })`, el cliente memoizado (`let cached`), el `getLimiters()` que devuelve `null`
si falta env, y **exportá un `__resetAttestationStore()`** (gemelo de `__resetKycRateLimitClient`, `:109-111`)
— **sin él, `vi.stubEnv("UPSTASH_…")` no toma efecto tras la primera llamada → tests flaky**.

> 🔴 **NO copies el `catch` de `rate-limit.ts:101-105`.** Ese hace **fail-OPEN**
> (`console.warn(...); return { ok: true }`). Es correcto **ahí** (un blip de Redis no debe bloquear tráfico
> KYC legítimo) y **catastrófico acá**: un atacante que tira Upstash **replaya la atestación N veces** → N
> payouts sobre un solo principal. **En el money-path, Upstash caído ⇒ 503 (A9). CD-12.**

### Exemplar 4 — Gateway cliente → ruta propia
**`src/infrastructure/a2a/gateways.ts:96-142`** · para **#13** (`http-settlement-gateway.ts`)
`fetch("/api/…")` (nunca la URL del facilitador), type-guards explícitos (`isValidPayoutShape`, `:57-70`),
errores estables PII-free. **Sin `any`** (CD-15 de WKH-186).

### Exemplar 5 — Fakes + inyección en tests
**`src/test-support/fakes.ts:301-325`** (`FakePayoutAuthorityGateway`, `FakeRefundGateway`) + **`test-container.ts:44-55`**
Molde exacto para `FakeSettlementGateway`: `public calls: […] = []`, resultado inyectado por constructor,
`mode: "resolve" | "reject"` para ejercitar el throw (C3).

### Exemplar 6 — `vi.mock` de un módulo propio en un test de route
**`app/api/kyc/session/route.test.ts:1-7`** · para **#10** y **#22**
```ts
const { rlMock } = vi.hoisted(() => ({ rlMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/rate-limit", () => ({ checkKycRateLimit: rlMock }));
import { POST } from "./route";     // ← el import va DESPUÉS del vi.mock (que igual se hoistea)
```
**Es el patrón para mockear `onchain-verifier` (en `settle/principal/route.test.ts`) y `attestation-store` (en
`submit/route.test.ts`)** sin tocar Upstash ni un RPC real.

### Exemplar 7 — `vi.mock` de una lib externa preservando lo real
**`src/infrastructure/rate-limit.test.ts:1-27`** · para **#12** (`onchain-verifier.test.ts`)
`vi.hoisted` + `vi.mock("@upstash/redis", …)` + `__resetKycRateLimitClient()` en `beforeEach`.
Para viem, **preservá lo real** (así testeás el decoding de verdad):
```ts
const { getReceiptMock } = vi.hoisted(() => ({ getReceiptMock: vi.fn() }));
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();   // ← tipado, cero `any`
  return { ...actual, createPublicClient: vi.fn(() => ({ getTransactionReceipt: getReceiptMock })) };
});
```
`parseEventLogs` / `isAddressEqual` / `keccak256` quedan **reales** → V4-V8 se prueban de verdad.

### Exemplar 8 — Test de route con env + fetch stub
**`app/api/a2a/payout/submit/route.test.ts:1-60`** · para **#10**, **#22**
`function req(payload: unknown): Request` (`:6-12`), `beforeEach`/`afterEach` con `vi.stubEnv` +
`vi.unstubAllEnvs()` (`:38-45` — **`restoreAllMocks` NO deshace `stubEnv`**), y el helper `fetchRouter`
(`:49-60`) que **separa las llamadas por URL** para poder assertar `expect(agentCalls).toHaveLength(0)`.
> Tipá los params del mock (`url: string`, `_init?: RequestInit`) — **tsc strict, cero `any`** (WKH-196).

### Exemplar 9 — Seed de remesa para el use-case
**`src/application/use-cases/confirm-and-send.test.ts:26-45`** · para **#18**
`seedQuoted(repo)` (`:38-45`) + el `quote` canónico (`:26-34`: `Money.of(400,"USDC")` → **`send.minor = 400_000_000`**).
`FakeWallet.getAddress()` → `"0xSender"` (`fakes.ts:247-249`).

---

## Contratos exactos (NO inventar)

### `src/application/ports.ts` (#1)

```ts
// ── Settlement del principal (WKH-168) ───────────────────────────────────────
// AC-9 (residual NO cerrado por esta HU): si el browser se cierra entre el settle on-chain y el
// estado terminal, la remesa queda HUÉRFANA con el principal REALMENTE adentro. Esta HU EMPEORA la
// consecuencia (antes no había plata; ahora sí) sin cerrar el gap: no hay persistencia server-side
// ni reconciliación. → WKH-207. El single-use pre-forward de la atestación agrega un 2º caso de
// varado (atestación quemada + forward fallido) → misma HU.
export interface Eip3009Authorization {
  from: string;        // 0x + 40 hex
  to: string;          // 0x + 40 hex
  value: string;       // uint256 decimal CANÓNICO (/^(0|[1-9]\d*)$/) — NUNCA bigint (CD-16)
  validAfter: string;  // idem
  validBefore: string; // idem
  nonce: string;       // 0x + 64 hex (bytes32)
}

export type SettlementFailureReason =
  | "settlement_unavailable"
  | "settlement_rejected"
  | "settlement_amount_mismatch"
  | "settlement_receiver_mismatch"
  | "settlement_reverted"
  | "settlement_unverified";

export interface PrincipalSettlementGateway {
  settle(input: {
    authorization: Eip3009Authorization;
    signature: string;
    address: string;
    quoteId: string;
    expectedValueMinor: number;   // quote.send.minor
  }): Promise<
    | { ok: true; txHash: string; valueMinor: number; to: string; from: string; attestation: string }
    | { ok: false; reason: SettlementFailureReason }
  >;
}

// WalletPort — remittanceId es REQUERIDO (CD-19: el nonce determinístico es la garantía
// anti-doble-pago a nivel CONTRATO; un remittanceId opcional permitiría caer al nonce random).
export interface WalletPort {
  connect(): Promise<string>;
  getAddress(): Promise<string | null>;
  authorizePrincipal(quote: Quote, remittanceId: string): Promise<{
    tx: string;                                                            // demo: firma simbólica (AC-5)
    eip3009?: { authorization: Eip3009Authorization; signature: string };  // SOLO en modo real
  }>;
}

// PayoutSubmit — OPCIONAL a propósito: en modo demo no existe atestación (AC-5). NO es fail-open:
// el enforcement vive en el SERVER (/api/a2a/payout/submit, rama A3 → 403), no en el tipo.
export interface PayoutSubmit {
  // … campos existentes intactos …
  settlementAttestation?: string;
}
```

### `src/infrastructure/settlement/attestation.ts` (#2)

```ts
export interface SettlementAttestation {
  txHash: string; chainId: number; valueMinor: number;
  from: string; to: string; quoteId: string; exp: number;  // exp: epoch SEGUNDOS
}
export function issueSettlementAttestation(p: SettlementAttestation): string;
/** null ante CUALQUIER problema (formato, HMAC, exp, tipos). Nunca throw por token inválido. */
export function verifySettlementAttestation(token: string, nowMs: number): SettlementAttestation | null;
```

**Formato**: `` `${b64(JSON.stringify(payload))}.${b64(hmac(b64payload))}` `` — el HMAC se calcula **sobre el
string base64url del payload**, no sobre el JSON crudo. Así `verify` re-HMACea **el string recibido tal cual**
y no depende de que `JSON.stringify` re-serialice idéntico. **Es la parte que se rompe si improvisás.**

**Orden obligatorio de `verify`** (fail-closed en cada paso, todos → `null`):
1. `typeof token === "string"` y `token.split(".").length === 2`, ambas partes no vacías.
2. **HMAC primero** (longitud primero + `timingSafeEqual`) — antes de parsear nada.
3. `JSON.parse(Buffer.from(p,"base64url").toString("utf8"))` **dentro de try/catch**.
4. `isRecord` + **validar tipo de CADA campo**: `txHash` `/^0x[0-9a-fA-F]{64}$/`; `chainId`
   `Number.isInteger`; `valueMinor` `Number.isInteger && > 0`; `from`/`to` `isAddress`; `quoteId` string
   no-vacío; `exp` `Number.isFinite`.
5. `exp * 1000 > nowMs` (**A5** colapsa acá: A4 y A5 devuelven ambos `null` → **el mismo 403 opaco**, CD-12).
6. `!process.env.SETTLE_ATTESTATION_SECRET` → `return null` (defensa; la route ya cortó en A1/A2).

**TTL sugerido al emitir**: `exp = now + 15 min` (la ventana settle→submit es de segundos; 15 min da margen
sin volver el token un pase eterno).

### `src/infrastructure/settlement/attestation-store.ts` (#19)

```ts
export type AttestationClaim = { ok: true } | { ok: false; alreadyUsed: true } | { ok: false; unavailable: true };
/** Single-use por txHash. SET NX + TTL. FAIL-CLOSED: sin env o ante CUALQUIER throw → unavailable. */
export async function claimAttestationOnce(txHash: string): Promise<AttestationClaim>;
export function __resetAttestationStore(): void;   // solo tests (gemelo de __resetKycRateLimitClient)
```

```ts
// Upstash: SET key value NX EX ttl → "OK" si lo creó, null si YA existía.
const created = await redis.set(`settle:att:${txHash}`, "1", { nx: true, ex: 86_400 });
if (created !== "OK") return { ok: false, alreadyUsed: true };   // A8 → 409
return { ok: true };
```
- **`catch` → `{ ok:false, unavailable:true }`** (A9 → 503). **NO** `{ok:true}`. **No es `rate-limit.ts`.**
- Sin `UPSTASH_REDIS_REST_URL`/`TOKEN` → `unavailable`.
- **CD-8**: acá **NO** se guarda `RemittanceState`, ni beneficiario, ni monto. **Solo un flag `"1"` por
  txHash.** Es replay-protection efímera, **no** persistencia de remesa (eso es WKH-207). Si te encontrás
  guardando cualquier otra cosa → **PARAR**, violaste CD-8.

### `wallet.ts` — nonce determinístico (#6)

```ts
import { keccak256, toBytes } from "viem";
// CD-19 (WKH-168/DT-6): el nonce ERA random (wallet.ts:75, :190) y se DESCARTABA. Con random, un
// settle con respuesta ambigua (timeout) + reintento = una autorización NUEVA = el usuario PAGA DOS
// VECES. Determinístico por (remittanceId, quoteId): el contrato USDC marca authorizationState[from]
// [nonce] → el 2º settle de la MISMA autorización REVIERTE ⇒ doble-pago IMPOSIBLE a nivel CONTRATO,
// no a nivel convención. El nonce NO es secreto (EIP-3009 solo exige unicidad por (from, nonce)) y
// sin la firma es inútil para un tercero. remittanceId es único (CryptoIds).
const nonce = keccak256(toBytes(`${remittanceId}:${quote.quoteId}`));
```

Y el retorno de la rama real (**CD-16**: la conversión `bigint → string` se hace **acá**, donde se firma):

```ts
return {
  tx: sig,
  eip3009: {
    signature: sig,
    authorization: {
      from: this.address,
      to: receiver,
      value: String(quote.send.minor),       // number entero → decimal canónico. OK: Money.minor es entero
      validAfter: "0",
      validBefore: validBefore.toString(),   // bigint → string. JAMÁS JSON.stringify(bigint) → TypeError
      nonce,
    },
  },
};
```

- **La rama demo (`wallet.ts:94-99`, `:209-214`) y `FallbackWallet` (`:114-116`) quedan INTACTAS** → siguen
  devolviendo `{ tx }` **sin** `eip3009` (AC-5).
- **`toHex(crypto.getRandomValues(...))` se borra** de `:75` y `:190`. Si `toHex` queda sin uso en el archivo,
  sacalo del import o lint/tsc se queja.

---

## Constraint Directives — 23 (8 heredados: CD-1…CD-8 · 15 nuevos: CD-9…CD-23)

> Checkealos **uno por uno** en W7. El AR los va a auditar **ejecutando**.

### Heredados del work-item

- [ ] **CD-1**: PROHIBIDO habilitar el payout real por default, o setear `NEXT_PUBLIC_EIP3009_ENABLED=true` /
      `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a` **en cualquier entorno** como parte de esta HU. Al terminar F3
      los flags siguen **off**. **Esta HU construye, no enciende.**
- [ ] **CD-2**: PROHIBIDO debilitar, remover o volver condicional el guard fail-loud de `container.ts:59-67`.
      Invariante money-path **sagrada**.
- [ ] **CD-3**: PROHIBIDO tocar el demo del jurado (`chaski-ai.vercel.app`, `wasiai-agentshop`, `yarvis`,
      `agentshop-*`, grant Team1).
- [ ] **CD-4**: PROHIBIDO exponer `FACILITATOR_API_KEY` (o cualquier credencial) al cliente. **SIEMPRE**
      server-side, **NUNCA** con prefijo `NEXT_PUBLIC_`.
- [ ] **CD-5**: PROHIBIDO implementar un relayer/broadcast on-chain propio en `chaski-v2`. (El verificador
      read-only **NO** viola esto: no hay wallet, ni clave, ni `writeContract`.)
- [ ] **CD-6**: PROHIBIDO modificar código de `wasiai-facilitator` o `wasiai-a2a`. Se consumen **únicamente**
      como servicios HTTP externos. **PROHIBIDO importar su código.**
- [ ] **CD-7**: OBLIGATORIO — toda transición a `principal_in` en modo real DEBE estar precedida por
      verificación de **monto Y receiver** contra el receipt on-chain. Un receipt sin verificar **NUNCA** basta.
- [ ] **CD-8**: PROHIBIDO decidir o implementar persistencia del estado de la remesa (localStorage → server) o
      reconciliación de huérfanos → **WKH-207**. El `SET NX` de la atestación **NO** es persistencia de remesa:
      es un flag `"1"` por txHash. Si guardás algo más → **PARAR**.

### Nuevos de este SDD

- [ ] **CD-9**: PROHIBIDO tomar `payTo`, `asset` o `network` del **body**. **Siempre** de env server-side
      (`resolveReceiverAddress()` / `resolveUsdcAddress()` / `resolveChainId()`).
- [ ] **CD-10**: PROHIBIDO tratar la respuesta del facilitador como verificación on-chain. Es un **eco** de
      nuestro input (`base-adapter.ts:811,817-819`). `{settled:true}` + HTTP 200 **nunca** bastan para
      `markPrincipalIn`.
- [ ] **CD-11**: PROHIBIDO alterar los guards 1-6 de `app/api/a2a/payout/submit/route.ts:46-96` ni los asserts
      de sus **19** tests (runner). La atestación se **AGREGA** después de la autoridad y antes del forward.
- [ ] **CD-12**: OBLIGATORIO fail-closed en **toda** rama nueva. Ante error, timeout, ambigüedad, `reason`
      desconocido o dependencia caída → **bloquear**. Sin `default:` permisivo (WKH-198). **PROHIBIDO
      `authorized`/`ok`/`verified = true` como valor inicial o por default.**
- [ ] **CD-13**: PROHIBIDO escribir números de artefactos sin el comando que los verifica, y **PROHIBIDO usar
      `grep -c` como autoridad de conteo** (cuenta un `it.each` de 4 casos como 1). La **única** autoridad es
      `npx vitest run <archivo>` → `PASS (N)`.
- [ ] **CD-14**: OBLIGATORIO leer env **DENTRO** del handler/función, nunca en el top-level del módulo (rompe
      `vi.stubEnv`). *(WKH-186; exemplars: `submit/route.ts:43`, `kyc-auth.ts:12-17`)*
- [ ] **CD-15**: OBLIGATORIO `const parsed: unknown = await req.json().catch(() => null)` + `isRecord()` antes
      de leer campos. PROHIBIDO `as {…}` sobre `req.json()` y `.catch(() => ({}))`. *(WKH-202/BLQ-BAJO-1)*
- [ ] **CD-16**: PROHIBIDO `JSON.stringify` sobre `bigint` (`TypeError`). La conversión a uint256 decimal
      canónico se hace en `wallet.ts`. PROHIBIDO `String(x)`/`Number(x)` sobre input hostil sin
      `typeof`/`Number.isInteger`/`Number.isFinite`. *(WKH-204: `String(123)==="123"`; WKH-198: `Number("")===0`)*
- [ ] **CD-17**: PROHIBIDO loguear o ecoar `signature`, `FACILITATOR_API_KEY`, `FACILITATOR_BASE_URL`,
      `AVALANCHE_RPC_URL`, `SETTLE_ATTESTATION_SECRET`, `UPSTASH_*` o PII del beneficiario. `txHash` y
      `blockNumber` **sí** son públicos.
- [ ] **CD-18**: OBLIGATORIO — `chaski-v2` **jamás** ejecuta `writeContract` / `sendTransaction` /
      `sendRawTransaction` / `prepareTransactionRequest`. El único cliente viem nuevo es un `publicClient`
      **read-only**. **Verificable**:
      `grep -rn "writeContract\|sendTransaction\|sendRawTransaction\|prepareTransactionRequest" src app` → **0**.
- [ ] **CD-19**: PROHIBIDO el nonce aleatorio. El nonce EIP-3009 es **determinístico** por
      `keccak256(toBytes(\`${remittanceId}:${quoteId}\`))`. **Verificable**:
      `grep -rn "getRandomValues" src/infrastructure/wallet.ts` → **0**.
- [ ] **CD-20** *(directiva del gate — legal/PSAV)*: `facilitator-client.ts` es el **ÚNICO** archivo que puede
      leer `FACILITATOR_BASE_URL`/`FACILITATOR_API_KEY` y el único que hace el POST a `/settle`. **Verificable**:
      `grep -rln "FACILITATOR_" src app` → **exactamente 1 archivo**.
- [ ] **CD-21** *(directiva del gate — legal/PSAV)*: `onchain-verifier.ts` es **read-only y agnóstico del
      broadcaster**: **PROHIBIDO** que importe `facilitator-client.ts`, que lea una env `FACILITATOR_*`, o que
      su firma mencione al facilitador. Su input es un **`txHash` de cualquier origen**. **Verificable**:
      `grep -n "facilitator\|FACILITATOR" src/infrastructure/settlement/onchain-verifier.ts` → **0**.
- [ ] **CD-22** *(auto-blindaje WKH-201)*: PROHIBIDO cerrar una wave con **tsc rojo en un archivo no listado**
      en "Files to Modify/Create" / "Blast radius". Si aparece → **reportar como desviación**, no arreglarlo en
      silencio.
- [ ] **CD-23** *(MEMORY WKH-196)*: el gate es **`npm run qa`** (`tsc --noEmit` **+** `vitest run`).
      **PROHIBIDO validar solo con `npm run build`**: este repo **NO** tiene `tsconfig.build.json` — el
      `tsconfig.json` incluye `src/**/*.ts` **y** `app/**/*.ts` (verificado, `:34-42`), así que
      `tsc --noEmit` **sí** cubre los `*.test.ts`.

---

## Waves

> W0 es **serial y bloquea todo**. W2 ‖ W3 (independientes). **W6 NO es opcional** (resolución del gate).

### Wave -1 — Environment Gate (ANTES de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v2
npm install 2>/dev/null || echo "revisar package.json"
ls src/application/ports.ts src/application/use-cases/confirm-and-send.ts \
   src/application/use-cases/confirm-and-send.test.ts src/infrastructure/wallet.ts \
   src/infrastructure/wallet.test.ts src/infrastructure/chain.ts src/infrastructure/kyc-auth.ts \
   src/infrastructure/rate-limit.ts src/composition/container.ts src/composition/container.test.ts \
   src/test-support/fakes.ts src/test-support/test-container.ts src/domain/money.ts \
   src/infrastructure/a2a/gateways.ts app/api/a2a/payout/submit/route.ts \
   app/api/a2a/payout/submit/route.test.ts app/api/kyc/session/route.test.ts .env.example \
   2>/dev/null || echo "FALTA archivo base — PARAR"
npm run qa 2>&1 | tail -8    # baseline esperado: tsc limpio + PASS (287) FAIL (0)
```
**Si algo falla en W-1: PARAR y reportar.** No implementes sobre un entorno roto.

### Wave 0 — Contratos y tipos (SERIAL, bloquea todo)

- [ ] **W0.1** `src/application/ports.ts` — `Eip3009Authorization`, `SettlementFailureReason`,
      `PrincipalSettlementGateway`, `WalletPort.authorizePrincipal(quote, remittanceId)`,
      `PayoutSubmit.settlementAttestation?`. **Comentario AC-9 inline** (contrato arriba). → #1
- [ ] **W0.2** `src/infrastructure/settlement/attestation.ts` + `.test.ts` — HMAC. → #2/#3 · Exemplar 2
- [ ] **W0.3** `src/test-support/fakes.ts` — `FakeSettlementGateway` (molde: `FakeRefundGateway`, `:313-325`);
      `FakeWallet.authorizePrincipal(_quote, _remittanceId?)` con `eip3009` opcional inyectable. → #4 · Exemplar 5
- [ ] **W0.4** `src/test-support/test-container.ts` — `settlement?: PrincipalSettlementGateway` en
      `TestContainerOverrides` (`:44-55`) + pasarlo como **7º arg** a `ConfirmAndSend` (`:77`). → #5

**Gate W0:**
```bash
npm run qa
```
- ✅ tsc **rojo esperado y aceptable SOLO** en: `wallet.test.ts` (8 call sites) y `confirm-and-send.ts:85`
  — se arreglan en W1/W5. **Si querés W0 en verde**, hacé W0 + W1.1 + W1.2 + W5.1 juntos.
- ✅ **287 + 5** (los de `attestation.test.ts`) = **292** una vez que tsc compile.
- 🔴 tsc rojo en **cualquier otro** archivo → **PARAR y escalar** (CD-22): el survey del Blast radius falló.

### Wave 1 — Wallet: payload EIP-3009 completo + nonce determinístico (dep: W0)

- [ ] **W1.1** `src/infrastructure/wallet.ts` — `InjectedWallet` (`:65-100`) y `WalletConnectWallet`
      (`:181-215`): nonce determinístico + retorno `{tx, eip3009}` en la rama real. **Ramas demo (`:94-99`,
      `:209-214`) y `FallbackWallet` (`:114-116`) INTACTAS** (AC-5). Borrar `getRandomValues` (CD-19). → #6
- [ ] **W1.2** `src/infrastructure/wallet.test.ts` — **agregar el 2º arg en los 8 call sites**
      (líneas **198, 250, 262, 274, 291, 302, 319, 329**) — **SETUP, los asserts NO se tocan** — **+3 tests**. → #7

**Gate W1:**
```bash
npx vitest run src/infrastructure/wallet.test.ts   # 19 (16 + 3)
```
- ✅ Los **16** originales verdes **con asserts byte-idénticos** (`git diff`: solo los args de llamada + los 3
  `it()` nuevos).
- ✅ `grep -rn "getRandomValues" src/infrastructure/wallet.ts` → **0** (CD-19).

### Wave 2 — Broadcast + ruta de settle (dep: W0) — **‖ con W3**

- [ ] **W2.1** `src/infrastructure/settlement/facilitator-client.ts` **(nuevo)** — el POST a `/settle` con el
      contrato exacto de arriba + el mapa de errores S14-S20. **Único lector de `FACILITATOR_*`** (CD-20).
      `AbortSignal.timeout(45_000)`. **No importa el verificador** (CD-21). → #8
- [ ] **W2.2** `app/api/settle/principal/route.ts` **(nuevo)** — ramas **S1-S21** + composición
      broadcast → verify → attest. Imports **relativos de 4 niveles**. Env **dentro** del handler (CD-14). → #9
- [ ] **W2.3** `app/api/settle/principal/route.test.ts` **(nuevo)** — **20 tests**. `vi.mock` del
      `onchain-verifier` (Exemplar 6) + `vi.stubGlobal("fetch")` para las ramas del facilitador. → #10

**Gate W2:**
```bash
npx vitest run app/api/settle/principal/route.test.ts   # 20
```
- ✅ En S1/S2/S4-S13: `expect(fetchMock).not.toHaveBeenCalled()` — **ningún fetch al facilitador**.
- ✅ AC-7: el fetch recibió `Authorization: Bearer <key>` **y** el JSON de la respuesta al cliente **no**
  contiene `FACILITATOR_API_KEY` / `FACILITATOR_BASE_URL` / `AVALANCHE_RPC_URL`.
- ✅ `grep -rln "FACILITATOR_" src app` → **exactamente `facilitator-client.ts`** (CD-20).

### Wave 3 — Verificador on-chain read-only (dep: W0) — **‖ con W2**

- [ ] **W3.1** `src/infrastructure/settlement/onchain-verifier.ts` **(nuevo)** — ramas **V1-V9**.
      `createPublicClient({ chain: resolveChain(), transport: http(AVALANCHE_RPC_URL) })` +
      `getTransactionReceipt` + `parseEventLogs` + filtro **por emisor** + `isAddressEqual`.
      **Cero `writeContract`/`sendTransaction`** (CD-18). **Cero mención al facilitador** (CD-21). → #11
- [ ] **W3.2** `src/infrastructure/settlement/onchain-verifier.test.ts` **(nuevo)** — **9 tests**
      (`vi.mock("viem", importOriginal)` — Exemplar 7). → #12

**Gate W3:**
```bash
npx vitest run src/infrastructure/settlement/onchain-verifier.test.ts   # 9
grep -n "facilitator\|FACILITATOR" src/infrastructure/settlement/onchain-verifier.ts   # → 0 (CD-21)
grep -rn "writeContract\|sendTransaction\|sendRawTransaction\|prepareTransactionRequest" src app  # → 0 (CD-18)
```
- ✅ **V6 es alcanzable** (si tu filtro incluye `to === receiver`, V6 nunca dispara → **volviste a la
  tautología**: rehacelo).

### Wave 4 — Gateway cliente + cableado (dep: W1, W2, W3)

- [ ] **W4.1** `src/infrastructure/settlement/http-settlement-gateway.ts` **(nuevo)** — implementa
      `PrincipalSettlementGateway` llamando a **`/api/settle/principal`** (jamás al facilitador). Type-guards
      explícitos, **sin `any`**. Mapea status → `SettlementFailureReason`. → #13 · Exemplar 4
- [ ] **W4.2** `…/http-settlement-gateway.test.ts` **(nuevo)** — **5 tests**. → #14
- [ ] **W4.3** `src/composition/container.ts` — instanciar **solo** si
      `process.env.NEXT_PUBLIC_EIP3009_ENABLED === "true"`; pasarlo como **7º arg** a `ConfirmAndSend`
      (`:85`). **El guard `:59-67` NO SE TOCA** (AC-8/CD-2). → #15
- [ ] **W4.4** `src/composition/container.test.ts` — **+2 tests**. **Los 8 existentes: asserts intactos**. → #16

**Gate W4:**
```bash
npx vitest run src/composition/container.test.ts   # 10 (8 + 2)
```
- ✅ Los **8** originales verdes **sin modificar aserciones** (**AC-8**; el work-item decía 6 — CD-13).
- ✅ `git diff src/composition/container.ts` **no toca** las líneas 59-67.

### Wave 5 — `ConfirmAndSend` (dep: W4)

- [ ] **W5.1** `src/application/use-cases/confirm-and-send.ts` — 7º param opcional
      `settlement?: PrincipalSettlementGateway`; ramas **C1-C8** entre `:85` y `:86`; 3er param de
      `failAndRefund` + marca AC-6; `settlementAttestation` en el `payouts.submit()` (`:103-111`).
      **NO tocar el orden de guards** (CD-2 de WKH-202). → #17
- [ ] **W5.2** `src/application/use-cases/confirm-and-send.test.ts` — **+10 tests**. **Los 14 existentes:
      asserts intactos**. → #18

**Gate W5:**
```bash
npx vitest run src/application/use-cases/confirm-and-send.test.ts   # 24 (14 + 10)
```
- ✅ Los **14** originales verdes **con asserts byte-idénticos** (AC-5).
- ✅ En C1-C5: `markPrincipalIn` **NUNCA** invocado y `snapshot.principalTx === null` (AC-3).

### Wave 6 — **El enforcement del gate (AC-10/AC-11)** (dep: W0, W5) — **NO es opcional**

- [ ] **W6.1** `src/infrastructure/settlement/attestation-store.ts` **(nuevo)** — Upstash `SET NX`,
      **fail-CLOSED** + `__resetAttestationStore()`. → #19 · Exemplar 3 (**sin copiar su `catch` fail-open**)
- [ ] **W6.2** `…/attestation-store.test.ts` **(nuevo)** — **4 tests**. → #20
- [ ] **W6.3** `app/api/a2a/payout/submit/route.ts` — ramas **A1-A10** (+ **A6′**) entre `:96` y `:98`.
      **Guards 1-6 (`:46-96`) byte-idénticos** (CD-11). **El bloque de forward (`:98-114`) NO se toca.**
      Actualizar el comentario de cabecera `:16-17` (el residual de WKH-168 **ya no está abierto**). → #21
- [ ] **W6.4** `app/api/a2a/payout/submit/route.test.ts` — `vi.mock` del `attestation-store`,
      `vi.stubEnv("SETTLE_ATTESTATION_SECRET", "")` en el `beforeEach` (**SETUP**, ver abajo) + **9 tests**.
      **Los 19 existentes: asserts intactos**. → #22
- [ ] **W6.5** `src/infrastructure/a2a/gateways.ts` — `settlementAttestation: req.settlementAttestation` en el
      body (`:123-134`). **NO remover `kycPayoutAllowed`** (contrato cross-repo, WKH-203). → #23

**Gate W6:**
```bash
npx vitest run app/api/a2a/payout/submit/route.test.ts   # 28 (19 + 9)
```
- ✅ Los **19** originales verdes **con asserts byte-idénticos** (`git diff` del test: solo el `beforeEach`, el
  `vi.mock` y los 9 `it()` nuevos).
- ✅ En A2-A9: `agentCalls` **= 0** — el agente **NUNCA** fue invocado (**AC-10/AC-11**).

#### El `beforeEach` de W6.4 (habilitador de los 19 — es SETUP, no asserts)

Los 19 tests existentes **no** stubean `SETTLE_ATTESTATION_SECRET`. Con el guard nuevo, su resultado pasaría a
depender del **shell ambiente** (vitest no carga `.env.local`, pero un `SETTLE_ATTESTATION_SECRET` exportado en
la shell/CI los mandaría a A3 → **403 → rojo intermitente**). Mismo precedente que WKH-202 §4.7:

```ts
beforeEach(() => {
  vi.stubEnv("DIDIT_API_KEY", "");                 // ← ya existe (:39)
  vi.stubEnv("VERCEL_ENV", "");                    // ← ya existe (:40)
  vi.stubEnv("SETTLE_ATTESTATION_SECRET", "");     // ← WKH-168: rama A1 (skip) → los 19 intactos
});
// afterEach (:42-45) queda como está: restoreAllMocks() + unstubAllEnvs()
```
Los tests que quieren el secreto lo re-stubean adentro (gana el stub más reciente).

### Wave 7 — Env, docs, regresión y cierre (dep: todas)

- [ ] **W7.1** `.env.example` — junto al bloque de value-delivery (`:50-81`). **Las 4 nuevas son
      server-only, NINGUNA con `NEXT_PUBLIC_`** (CD-4):
      - `FACILITATOR_BASE_URL=` — base del `wasiai-facilitator`. Sin ella → `/api/settle/principal` = **501**.
      - `FACILITATOR_API_KEY=` — Bearer. ⚠️ documentar: `FACILITATOR_PAYTO_ALLOWLIST` **del facilitador** debe
        incluir nuestro `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` o **todo settle da 403**.
      - `AVALANCHE_RPC_URL=` — RPC **read-only** para la verificación on-chain (DT-5). Sin ella → **503**
        fail-closed: **sin poder verificar, NO se atestigua**.
      - `SETTLE_ATTESTATION_SECRET=` — HMAC de la atestación. **Sin ella en un deploy de Vercel el submit
        responde 503** (A2, nunca fail-open). Fuera de Vercel (local/CI) la exigencia no aplica (A1).
      - ⚠️ Nota: el gate **exige `UPSTASH_REDIS_REST_URL`/`TOKEN`** (ya existen, `:31-32`) — sin ellas el
        submit responde **503** (A9, fail-closed).
      - ⚠️ Nota: `NEXT_PUBLIC_EIP3009_ENABLED` y `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` **siguen OFF** (CD-1).
      - ⚠️ Nota: `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS` **debe** ser el USDC canónico de la chain o **todo settle
        da 400** (el facilitador lo hardcodea, ver Riesgos). → #24
- [ ] **W7.2** `npm run qa` completo → **tsc limpio + PASS (354) FAIL (0)** (ver Test Expectations).
- [ ] **W7.3** Checklist de los **23 CDs**, uno por uno. Corré los 4 greps verificables (CD-18/19/20/21).
- [ ] **W7.4** `git diff --stat` toca **exactamente los 24 archivos** de la tabla — ni uno más (CD-22).
- [ ] **W7.5** Confirmar para el done-report: **G3 cerrado** (con los flags off); **NO** habilita la Fase A
      (faltan **G5/WKH-206**, mitad B/TransFi, partners/legal); residuales: **WKH-207** (huérfanas +
      atestación quemada), **clawback imposible** (DT-8), **WKH-203** (`kycPayoutAllowed`).

### Verificación Incremental

| Wave | Comando | Criterio de cierre |
|------|---------|--------------------|
| W-1 | `npm run qa` | Baseline **287/287** + tsc limpio |
| W0 | `npm run qa` | tsc rojo **solo** en `wallet.test.ts` + `confirm-and-send.ts:85`; **292** al compilar |
| W1 | `npx vitest run src/infrastructure/wallet.test.ts` | **19** + los 16 con asserts intactos + `getRandomValues` = 0 |
| W2 | `npx vitest run app/api/settle/principal/route.test.ts` | **20** + `FACILITATOR_` en **1** solo archivo |
| W3 | `npx vitest run src/infrastructure/settlement/onchain-verifier.test.ts` | **9** + V6 alcanzable + CD-18/CD-21 en 0 |
| W4 | `npx vitest run src/composition/container.test.ts` | **10** + los 8 con asserts intactos + `:59-67` sin diff |
| W5 | `npx vitest run src/application/use-cases/confirm-and-send.test.ts` | **24** + los 14 con asserts intactos |
| W6 | `npx vitest run app/api/a2a/payout/submit/route.test.ts` | **28** + los 19 con asserts intactos + `agentCalls`=0 |
| W7 | `npm run qa` | **354/354** + tsc limpio + 23 CDs + 24 archivos exactos |

> **PROHIBIDO cerrar una wave validando solo con `npm run build`** (CD-23, lección WKH-196: un CR aprobó con
> tsc roto en tests porque el build los excluía). En **este** repo **no existe `tsconfig.build.json`** →
> `npm run typecheck` **sí** cubre los `*.test.ts`. El gate es **`npm run qa`**.

---

## Test Expectations

**Baseline: 287/287 (verificado ejecutando 2026-07-15). Objetivo: 354/354** = 287 + **67 nuevos**.

> ⚠️ **CD-13**: 354 es el **objetivo planificado**. La **autoridad es el runner**. Si tu conteo real difiere
> (por ejemplo porque usaste `it.each` — que el runner cuenta por caso y `grep` cuenta como 1), **reportá el
> número real del runner**; **NO** ajustes tests para "llegar al número", y **NO** anotes el número de `grep`.
> **Preferí `it()` explícito por rama** — hace el conteo trivial y el AR feliz.

| Wave | Archivo | Antes (runner) | Nuevos | Después |
|---|---|---|---|---|
| W0.2 | `src/infrastructure/settlement/attestation.test.ts` | 0 (nuevo) | **5** | 5 |
| W1.2 | `src/infrastructure/wallet.test.ts` | **16** | **3** | 19 |
| W2.3 | `app/api/settle/principal/route.test.ts` | 0 (nuevo) | **20** | 20 |
| W3.2 | `src/infrastructure/settlement/onchain-verifier.test.ts` | 0 (nuevo) | **9** | 9 |
| W4.2 | `src/infrastructure/settlement/http-settlement-gateway.test.ts` | 0 (nuevo) | **5** | 5 |
| W4.4 | `src/composition/container.test.ts` | **8** | **2** | 10 |
| W5.2 | `src/application/use-cases/confirm-and-send.test.ts` | **14** | **10** | 24 |
| W6.2 | `src/infrastructure/settlement/attestation-store.test.ts` | 0 (nuevo) | **4** | 4 |
| W6.4 | `app/api/a2a/payout/submit/route.test.ts` | **19** | **9** | 28 |
| | **Suite** | **287** | **67** | **354** |

### Cómo se testea un settle on-chain **sin cadena real** — 3 niveles, **sin anvil**

Ningún test de este repo levanta una cadena, y **CD-6 prohíbe tocar `wasiai-facilitator`** (donde WFAC-52 ya
validó Fuji real). Los 3 niveles:

1. **Use-case** (`confirm-and-send.test.ts`): `FakeSettlementGateway` inyectado por `test-container` /
   constructor. **Cero HTTP, cero cadena.** Controla `{ok:true/false}` y los valores.
2. **Rutas `app/api/**`**: `vi.stubGlobal("fetch", vi.fn())` + `vi.stubEnv` + `vi.mock` de los módulos propios
   (`onchain-verifier`, `attestation-store` — Exemplar 6). **Imports relativos** (`@/` no resuelve en vitest).
3. **Verificador** (`onchain-verifier.test.ts`): `vi.mock("viem", importOriginal)` stubeando **solo**
   `createPublicClient` → `getTransactionReceipt` devuelve **receipts sintéticos** (status + logs fabricados).
   `parseEventLogs`/`isAddressEqual` quedan **reales** ⇒ V3-V8 se prueban de verdad, determinístico y rápido.

**Fixture de receipt sintético** (molde para W3.2):

```ts
const USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => `0x000000000000000000000000${a.slice(2).toLowerCase()}` as const;

function receipt(opts: { status?: "success" | "reverted"; logs?: unknown[] }) {
  return { status: opts.status ?? "success", blockNumber: 1n, logs: opts.logs ?? [] };
}
function transferLog(from: string, to: string, valueMinor: bigint, emitter = USDC) {
  return {
    address: emitter,
    topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: `0x${valueMinor.toString(16).padStart(64, "0")}`,
  };
}
// V5: dos logs de USDC → ambigüedad → settle_unverified (NO elegir "el primero")
// V4: transferLog(..., emitter: "0xOtroToken") → 0 logs de USDC → settle_unverified
```

### Tests por AC

| AC | Test | Archivo |
|---|---|---|
| **AC-1** | Modo real + fake ⇒ `settle()` invocado **con la `authorization` completa** (no solo la firma) — spy sobre el arg | `confirm-and-send.test.ts` |
| **AC-2** | (a) receipt con `Transfer.to = 0xOTRO` ⇒ `settlement_receiver_mismatch` (**V6**); `value` distinto ⇒ `settlement_amount_mismatch` (**V8**); sin log USDC ⇒ `settlement_unverified` (**V4**); 2 logs USDC ⇒ `settlement_unverified` (**V5**) · (b) C4/C5 ⇒ `markPrincipalIn` **nunca** llamado · (c) positivo ⇒ `markPrincipalIn(txHash)` | `onchain-verifier.test.ts`, `confirm-and-send.test.ts` |
| **AC-3** | `{ok:false}` por cada `SettlementFailureReason` + throw (C2/C3) ⇒ `payout_failed`, `principalTx === null`, `creditBack` invocado · S14-S20 ⇒ status esperado, **nunca 200** | `confirm-and-send.test.ts`, `settle/principal/route.test.ts` |
| **AC-4** | `snapshot.principalTx === "0x<64hex>"` (el hash del fake) **y `!== signature`** del input | `confirm-and-send.test.ts` |
| **AC-5** | Los **16** de `wallet.test.ts`, los **14** de `confirm-and-send.test.ts`, los **8** de `container.test.ts` y los **19** de `submit/route.test.ts` verdes **sin tocar asserts** · flag off ⇒ el gateway **nunca se instancia** (spy en la factory) · `FallbackWallet.authorizePrincipal` sigue devolviendo `{tx}` **sin** `eip3009` | los 4 archivos |
| **AC-6** | Seed `principal_in` en **modo real** → forzar `payout_failed` ⇒ `failureReason === "principal_settled_refund_manual"` · **Contraste**: modo demo ⇒ el `reason` de hoy **intacto** | `confirm-and-send.test.ts` |
| **AC-7** | El `fetch` mockeado recibió `Authorization: Bearer <key>` **y** el JSON de la respuesta al cliente **no** contiene `FACILITATOR_API_KEY`/`FACILITATOR_BASE_URL`/`AVALANCHE_RPC_URL` (assert sobre el string serializado) · el gateway llama a `/api/settle/principal`, **nunca** a la URL del facilitador | `settle/principal/route.test.ts`, `http-settlement-gateway.test.ts` |
| **AC-8** | Los **8** de `container.test.ts` verdes **sin modificar aserciones** (el work-item decía 6 — CD-13) | `container.test.ts` |
| **AC-9** | **Documental (CR)**: comentario inline en `ports.ts` citando la orfandad + **WKH-207**. Sin test automatizado | `ports.ts` |
| **AC-10** | A3-A7 + **A6′** (sin atestación / HMAC forjado / vencida / `valueMinor` ≠ `amountUsd` / `amountUsd` hostil / `from` ≠ `address`) ⇒ **403** y **`agentCalls` = 0** · A2 (sin secreto + `VERCEL_ENV="production"`) ⇒ **503**, `agentCalls` = 0 · A1 ⇒ los **19** existentes verdes | `submit/route.test.ts` |
| **AC-11** | 2ª presentación de la misma atestación ⇒ **409**, `agentCalls` = 0 · Upstash unavailable/throw ⇒ **503**, `agentCalls` = 0 | `submit/route.test.ts`, `attestation-store.test.ts` |

### Criterio Test-First

**Money-path real.** **Sí, test-first** en **W2, W3, W5 y W6** — o, como mínimo, código + tests verdes al
cerrar cada wave. **W6 no se cierra sin sus 9 tests**: es el gate.

---

## ⚠️ Riesgos operativos — leelos ANTES de intentar un e2e en testnet

> **Ninguno bloquea los tests con fakes/mocks.** **Todos bloquean el e2e en Fuji real.** Que no te coman una
> hora de debugging.

1. **El relayer de Fuji puede estar SIN GAS.** Precedente de memoria (Kite/Base): *"las baterías largas drenan
   el gas del relayer"*. Síntoma: el facilitador responde **503 `OPERATOR_FUNDING_LOW`** → **S17** → 503 →
   `payout_failed`. **Es fail-closed (no se pierde plata), pero parece un bug tuyo y no lo es.**
   `[NEEDS CLARIFICATION — operador]`: ¿el deploy del facilitador tiene `AVALANCHE_FUJI_RPC_URL` seteada y el
   relayer fondeado en AVAX Fuji?
2. **`FACILITATOR_PAYTO_ALLOWLIST` debe incluir nuestro receiver.** Si no, `settle.ts:131` responde **403
   `FORBIDDEN` (`payTo not permitted`)** → **S14** → **502 para TODO settle**. `[NEEDS CLARIFICATION —
   operador]`: ¿key propia para chaski-v2 o compartida? (impacta cap diario y rate-limit por key).
3. **El facilitador HARDCODEA el USDC canónico por cadena** (`avalanche.ts`: Fuji
   `0x5425890298aed601595a70AB815c96711a31Bc65`, mainnet `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`) y
   rechaza si `accepted.asset` no coincide (`base-adapter.ts:586` → **400**). Si
   `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS` difiere ⇒ **todo settle falla 400**. Fail-closed (no pierde plata) pero
   es config-drift silencioso — precedente **WKH-162**.
4. **`auth.ts:100`: `if (configured.length === 0) return;`** — un facilitador **sin**
   `FACILITATOR_API_KEY`/`FACILITATOR_API_KEYS` **no autentica**. No es nuestro código (CD-6), pero nuestra
   seguridad depende de esa config. **Verificar antes de encender.**
5. **`AVALANCHE_RPC_URL` público** → rate-limit/latencia pueden dar **V2** ⇒ 503 ⇒ `payout_failed` con el
   principal **realmente adentro** (varado). Mitigación mínima: RPC dedicado. La reconciliación real es
   **WKH-207**.
6. **`AbortSignal.timeout(45_000)` vs el límite de la función en Vercel.** El facilitador espera el receipt
   (`RECEIPT_TIMEOUT_MS`), por eso 45s (la ruta existente usa 10s, que no alcanza). Si el plan de Vercel corta
   antes, la función muere y el cliente ve un error → **igual fail-closed** (`payout_failed`), pero el
   diagnóstico cambia. **No lo bajes a 10s "por consistencia"**: un settle real tarda más.

---

## Corrección al SDD/work-item detectada en F2.5 — **aplicar la del Story File**

> Los 3 primeros son **defectos reales** (habrían cerrado waves en rojo o shipeado un bug); los 2 últimos son
> precisiones que el SDD dejó abiertas. **Reportados al orquestador.** Precedente: en WKH-202 este paso cazó 2
> defectos; en WKH-203, 3.

1. 🔴 **DEFECTO — V5/V6 del SDD son mutuamente inalcanzables ⇒ el chequeo del receiver vuelve a ser una
   tautología.** El SDD §5 escribe V5 como *"≥2 logs `Transfer` de USDC **hacia `resolveReceiverAddress()`**"*.
   Si el filtro incluye `to === receiver`, entonces el log que sobrevive tiene `to === receiver` **por
   construcción** ⇒ **V6 (`log.args.to !== receiver → receiver_mismatch`) es inalcanzable** ⇒ **AC-2 no
   verifica el receiver** — el bug exacto que la HU vino a matar (idea #1), reintroducido en la propia
   solución. **Corrección aplicada**: **V5 filtra por EMISOR (contrato USDC + topic `Transfer`) y SOLO por
   emisor**; se exige **exactamente 1** log; V6/V7/V8 se assertean sobre ese log único, cada uno con su
   `reason` distinguible. Es además **más estricto** que el SDD (bloquea cualquier receipt con >1 `Transfer` de
   USDC, no solo los que van a nuestro receiver). **Prevalece el Story File.**

2. 🔴 **DEFECTO — A6 del SDD produce un 500 crudo con input hostil (WKH-202/BLQ-BAJO-1 repetido).** El SDD §5
   escribe A6 como `att.valueMinor !== Money.of(body.amountUsd,"USDC").minor`. `body.amountUsd` es
   **atacante-controlado** y `Money.of` (`money.ts:17-25`) **TIRA** con `NaN`/negativo/`> MAX_SAFE_INTEGER`.
   Ese bloque corre **fuera** del `try/catch` de la route (que abre en `:98`) ⇒ `curl -d '{"amountUsd":"x",…}'`
   ⇒ **500 crudo**, violando el contrato de la cabecera (*"nunca 500 crudo"*). **Corrección aplicada**: rama
   **A6′** — guard `typeof/Number.isFinite/> 0` **antes** de `Money.of`, + `try/catch` por el cap de
   `MAX_SAFE_INTEGER`, todo → **403 opaco**, **dentro** del bloque de atestación (para no romper CD-11).

3. 🟠 **DEFECTO (de proceso) — el SDD no advierte el breaker de tsc de `wallet.test.ts`.** El SDD §6/W1 cambia
   `authorizePrincipal(quote, remittanceId)` sin señalar que **`wallet.test.ts` llama al método con 1 arg en 8
   líneas** (198, 250, 262, 274, 291, 302, 319, 329) ⇒ **8 errores de tsc**. Es el equivalente exacto del
   `gateways.test.ts:20` de WKH-202 (que el SDD de aquella HU **sí** documentó). Sin este aviso, W0/W1 cierran
   en rojo y el dev cree que rompió algo. **Corrección aplicada**: sección "Blast radius", Breaker 1, con las
   8 líneas exactas.

4. 🟡 **PRECISIÓN — el SDD no dice cómo `ConfirmAndSend` sabe que está en "modo real"** (lo necesitan C1 y la
   marca AC-6). Leer una env en el use-case violaría CD-14 y la arquitectura (los use-cases no leen env).
   **Resuelto**: **modo real ⇔ `this.settlement !== undefined`**, vía un **7º parámetro OPCIONAL** del
   constructor que el container solo inyecta con el flag on ⇒ **AC-5 por construcción** y **los 14 tests
   existentes no rompen** (contraste con WKH-201, que sí era un cambio rompedor de constructor).

5. 🟡 **PRECISIÓN — separación broadcast/verificación elevada a estructura de archivos.** El SDD (W2) deja el
   POST al facilitador **dentro** de `route.ts`. La **directiva #2 del gate** (legal/PSAV) exige que broadcast
   y verificación sean **estrictamente separables**. **Aplicado**: el broadcast se extrae a
   `facilitator-client.ts` (**único** lector de `FACILITATOR_*`, **CD-20**) y el verificador queda **agnóstico
   del broadcaster** (**CD-21**, input = `txHash` de cualquier origen). Un veredicto legal adverso ⇒ se
   reemplaza **1 archivo**, no la HU. Sin costo en tests (el fetch sigue stubeado desde la route).

6. ℹ️ **Ya corregido por el SDD, se propaga**: el work-item dice *"los **6** tests de `container.test.ts`"* —
   **son 8** (runner). Y el work-item (`:121-123`) dice que el path live es `avalanche.ts`; la **mecánica**
   vive en `base-adapter.ts` (`avalanche.ts` es un *thin wrapper*).

---

## Out of Scope — no lo intentes acá

- **Persistencia server-side del estado de la remesa + reconciliación de huérfanas** → **WKH-207**. **CD-8.**
  El `SET NX` de la atestación **no** es esto (es un flag `"1"` por txHash).
- **G5 / SIWE / posesión criptográfica de la wallet** → **WKH-206**. Hoy nada prueba que el caller controla la
  wallet (`kyc-auth.ts:7` ya lo declara deferred).
- **Mitad B del payout** (USDC→PEN→Yape, TransFi) → bloqueada por el sandbox del partner.
- **Clawback / refund on-chain real** → **imposible** con el patrón `RefundGateway` (DT-8): revertir un
  `transferWithAuthorization` es una transferencia **inversa** que exige la clave del **receiver**. Solo la
  marca de AC-6.
- **`kycPayoutAllowed` server-side en el agente** → **WKH-203**, repo `wasiai-remittance-agents`. **NO lo
  remuevas de `gateways.ts:131`**: es contrato cross-repo.
- **Modificar `wasiai-facilitator` o `wasiai-a2a`** → **CD-6**. Solo HTTP.
- **Encender los flags** → **CD-1**. En ningún entorno, ni "para probar", ni en `.env.example`.
- **Un relayer/broadcast propio** → **CD-5/CD-18**.
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar, no asumir.

Situaciones de escalation:
- **tsc rojo en un archivo fuera de "Files to Modify/Create" / "Blast radius"** (CD-22) — el survey falló.
- Un assert de los **16** (`wallet.test.ts`) / **14** (`confirm-and-send.test.ts`) / **8**
  (`container.test.ts`) / **19** (`submit/route.test.ts`) se rompe. **PROHIBIDO ajustar el test para que
  pase**: arreglá el código.
- Un exemplar (path/línea) ya no coincide con lo descrito.
- El cierre de una wave exige tocar un archivo fuera de la tabla, o tocar `container.ts:59-67`.
- El conteo del runner difiere del objetivo de la wave → **reportá el número del runner** (CD-13), no lo
  "arregles".
- **Cualquier situación donde la única salida aparente sea debilitar un guard, autorizar/verificar por default,
  o confiar en la respuesta del facilitador como si fuera on-chain** (CD-10/CD-12) → **PARAR SIEMPRE**.
  Es el money-path, y acá el dinero es **real**.

---

*Story File generado por NexusAgil — F2.5 (FULL, money-path real, XL). Baseline verificado **ejecutando**:
`npx vitest run` → **PASS (287) FAIL (0)**, 2026-07-15. Objetivo: **354/354**. Broadcast y verificación quedan
**separables por construcción** (CD-20/CD-21) — directiva del gate.*
