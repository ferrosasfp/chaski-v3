# SDD #198: Fail-closed en expiry de quote — guard NaN + validación de shape de fecha

> SPEC_APPROVED: no
> Fecha: 2026-07-14
> Tipo: bugfix (money-path integrity — control de FX rancio)
> SDD_MODE: bugfix
> Branch: fix/198-quote-expiry-fail-closed
> Artefactos: doc/sdd/012-wkh-198-quote-expiry-fail-closed/
> Repo: chaski-v2 (CD-7: SOLO este repo)
> Pipeline: QUALITY (AR obligatorio — case MONEY-PATH-INTEGRITY)

---

## 1. Resumen

`isQuoteExpired` (`src/domain/remittance.ts:257-259`) compara timestamps con `<=`. Si `quote.expiresAt`
no parsea a fecha (`Date.parse → NaN`), `NaN <= x` es `false` en JS → el quote **nunca vence** y el
control de FX rancio queda anulado. El mismo dato malformado, con `NEXT_PUBLIC_EIP3009_ENABLED=true`,
hace que `wallet.ts:75`/`:189` computen `BigInt(NaN)` → `RangeError` opaco sin `catch` al firmar.

El fix es **quirúrgico y en dos capas complementarias** (DT-1 del work-item):
1. **Dominio (defensa de último recurso)**: `isQuoteExpired` trata cualquier `expiresAt`/`nowIso`
   no-parseable como **EXPIRADO** (fail-closed). Cubre CUALQUIER productor presente/futuro, incluido
   `Remittance.rehydrate` desde `localStorage` tampereado.
2. **Borde de shape (prevención)**: `isValidQuoteShape` (gateways.ts) e `isValidQuoteResult`
   (quote/route.ts) rechazan un `expiresAt` string que no parsee, ANTES de que se construya un `Quote`.
3. **Defensa en profundidad EIP-3009**: `wallet.ts` falla LOUD con error nombrado
   (`quote_expires_at_invalid`) antes del `BigInt(...)`, para el caso residual que bypasea (1) y (2).

**Decisión de diseño clave de F2 (resuelve el TBD-1 del work-item):** el chequeo de parseabilidad se
implementa **una sola vez** como predicado puro exportado del dominio —
`isParseableIso(value: string): boolean` = `!Number.isNaN(new Date(value).getTime())` — y se **reusa**
en los 4 sitios (dominio, ambos validadores de shape, wallet.ts). Esto hace **imposible** que la lógica
diverja entre lugares (satisface CD-5 por construcción, no por convención) y respeta la dirección
permitida dominio→infra: infra importa un helper *explícitamente exportado* del dominio (nunca lógica
privada). `gateways.ts` y `wallet.ts` YA importan de `../../domain/remittance` / `../domain/remittance`;
`quote/route.ts` lo importa vía el alias `@/domain/remittance` (`tsconfig paths: @/* → ./src/*`).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | WKH-198 (Hallazgo A, auditoría adversarial #2) |
| **Tipo** | bugfix money-path (guard NaN de expiry) |
| **SDD_MODE** | bugfix (S) |
| **Objetivo** | Fail-closed en expiry: `expiresAt`/`nowIso` no-parseable ⇒ EXPIRADO; rechazo en el borde de shape; fail-loud en la rama EIP-3009 |
| **Scope IN** | `remittance.ts`, `remittance.test.ts`, `gateways.ts`, `gateways.test.ts`, `quote/route.ts`, `quote/route.test.ts`, `wallet.ts`, `wallet.test.ts` |
| **Scope OUT** | `fallback/gateways.ts`; payout/WKH-180 (`payout-authority-gateway.ts`, `confirm-and-send.ts`, `/api/payout/validate`); `TRANSITIONS`/`confirm()`/gates KYC; flags de payout; refund-recovery de una remesa ya `confirmed` |

### Acceptance Criteria (referencia — detalle en `work-item.md`)

- **AC-1**: `expiresAt` no-parseable ⇒ `isQuoteExpired` devuelve `true` (fail-closed), sin importar
  `nowIso`; propagado a `attachQuote` (`quote_expired`), `confirm` (`confirm_quote_expired`),
  `isQuoteStillValid` (`false`) **sin cambio de firma**.
- **AC-2**: `expiresAt` válido y `<= nowIso` (válido) ⇒ EXPIRADO (no regresiona).
- **AC-3**: `expiresAt` válido y `> nowIso` (válido) ⇒ NO expirado (no regresiona).
- **AC-4**: `expiresAt` string pero no-parseable en `isValidQuoteResult` (route) / `isValidQuoteShape`
  (gateway) ⇒ rechazo por el camino de error ya existente (`502 a2a_bad_shape` en la route;
  `throw a2a_quote_bad_shape` en el gateway).
- **AC-5**: `NEXT_PUBLIC_EIP3009_ENABLED=true` + `expiresAt` no-parseable ⇒ error explícito capturable
  (no `RangeError` opaco de `BigInt(NaN)`).

---

## 3. Context Map (Codebase Grounding — verificado post-WKH-186/187, 2026-07-14)

### Archivos leídos (con línea real)

| Archivo | Por qué | Patrón / hallazgo verificado |
|---------|---------|------------------------------|
| `src/domain/remittance.ts` | consumidor de la invariante | `Quote.expiresAt: string // ISO` L22; `attachQuote` L210-216 (`isQuoteExpired`→`quote_expired` L213); `confirm` L219-226 (`isQuoteExpired`→`confirm_quote_expired` L224); `isQuoteStillValid` L253-255 (público, reusa el privado); **`isQuoteExpired` L257-259 (ROOT CAUSE)**. Exporta hoy `toPersistedIdentity`, `canTransition` (funciones puras a nivel módulo) → patrón para exportar `isParseableIso` |
| `src/domain/remittance.test.ts` | exemplar de test dominio | fakes `quote()` L23-32 (`expiresAt: QUOTE_EXPIRES`), `ready()` L34-41; `T0`/`QUOTE_EXPIRES` de `../test-support/fakes` L11; casos expiry existentes: "attachQuote rechaza quote vencido" L76-78 (usa `expiresAt: T0`), "confirm con quote vencido" L80-84 (`now` futuro); bloque `toPersistedIdentity` L238-274 = patrón de test de función pura de módulo |
| `src/infrastructure/a2a/gateways.ts` | productor / borde shape | `import type { Quote } from "../../domain/remittance"` L8 (dominio→infra YA existe); `RawQuoteResult.expiresAt: string` L24; **`isValidQuoteShape` L42-53** (`typeof v.expiresAt === "string"` L50, GAP); `requestQuote` L94-108 (`throw a2a_quote_bad_shape` L106) |
| `src/infrastructure/a2a/gateways.test.ts` | exemplar test gateway | `validQuoteResult` L8-18; "shape inválido → throw a2a_quote_bad_shape" L62-65 (patrón `okJson`+`rejects.toThrow`); `okJson` helper L29-31 |
| `app/api/a2a/quote/route.ts` | productor / borde shape (server) | `BASE` leído DENTRO de `POST` L26 (WKH-186 auto-blindaje); **`isValidQuoteResult` L12-23** (`typeof v.expiresAt === "string"` L20, GAP); rechazo `502 a2a_bad_shape` L38-40; sin import de `src/` hoy |
| `app/api/a2a/quote/route.test.ts` | **EXISTE** (resuelve TBD-2) | `validResult` L14-22; "shape inválido → 502 a2a_bad_shape" L59-65; usa `vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE)` L52 + `vi.stubGlobal("fetch", ...)`; helper `req()` L6-12 |
| `src/infrastructure/wallet.ts` | rama EIP-3009 | `import type { Quote } from "../domain/remittance"` L5 (dominio→infra YA existe); `eip3009Enabled()` L22-24; **`InjectedWallet.authorizePrincipal` `BigInt(Math.floor(Date.parse(quote.expiresAt)/1000))` L75**; **`WalletConnectWallet.authorizePrincipal` idéntico L189**; guard existente `isAddress` L67/L182 (patrón "throw nombrado antes de firmar") |
| `src/infrastructure/wallet.test.ts` | exemplar test EIP-3009 | harness EIP-3009 YA EXISTE: `eip3009Quote` L110-119, `enableEip3009()` L121-125, `makeProvider`/`makeWcProvider`, `typedDataOf` L128-137; bloques "EIP-3009 flag … InjectedWallet" L256-284 y "… WalletConnectWallet" L286-310 (AC-10 flag ON = patrón exacto para AC-5) |
| `tsconfig.json` | alias de import | `paths: { "@/*": ["./src/*"] }` L23-26 → `quote/route.ts` puede importar `@/domain/remittance` |
| `src/domain/money.ts` (indirecto) | pureza del dominio | `remittance.ts` sólo importa `./money` (value-object puro, sin deps browser) → importar el helper en la route server-only es seguro |

### Auto-Blindaje histórico consultado (últimas 3 DONE: WKH-188/187/186)

- **WKH-186 (route env)**: leer env DENTRO del handler para que `vi.stubEnv` funcione. `route.ts` YA lo
  hace (L26). → **Constraint para el test**: el nuevo caso AC-4 en `route.test.ts` DEBE setear
  `vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE)` (si no, la route corta en 501 antes del shape-check). CD-9.
- **WKH-187 (×2) + WKH-188**: patrón recurrente (≥2 HUs) de **footguns de fecha/expiry**: los tests que
  ejercen expiry deben elegir fechas relativas al reloj correcto (dominio usa `now` inyectado; UI usa
  `new Date()` real) y **hay que correr la suite completa** tras tocar lógica compartida, no confiar en
  los anchors. → CD-10 nuevo.

---

## 4. Decisiones técnicas (DT-N)

- **DT-1 (heredada)**: fix en 2 capas complementarias (dominio fail-closed + borde de shape) —
  no redundantes: (a) defensa en profundidad, (b) prevención en el borde.
- **DT-2 (heredada, refinada)**: el chequeo es `!Number.isNaN(new Date(value).getTime())` — único
  correcto en JS/TS (nunca `=== NaN` ni `!Number.isFinite`). Se **centraliza** en un predicado puro.
- **DT-3 — mecanismo del guard en wallet.ts (resuelve TBD-1)**: **reusar** el predicado exportado del
  dominio `isParseableIso`, NO duplicar el chequeo localmente. Razón: `wallet.ts` ya importa de
  `../domain/remittance` (L5), la dirección dominio→infra es la permitida, y reusar el mismo predicado
  garantiza CD-5 por construcción. En `authorizePrincipal`, rama `eip3009Enabled()`, ANTES de
  `const validBefore = BigInt(...)`:
  ```ts
  if (!isParseableIso(quote.expiresAt)) throw new Error("quote_expires_at_invalid");
  ```
  Fail LOUD (error nombrado capturable), no fail silent (CD-8). Va en AMBOS wallets (L75 y L189).
- **DT-4 — predicado único exportado (resuelve TBD-1 y cierra CD-5)**: agregar a `remittance.ts` una
  función pura a nivel módulo (mismo patrón que `toPersistedIdentity`/`canTransition`):
  ```ts
  /** ¿`value` parsea a un instante válido? Fuente ÚNICA del chequeo de parseabilidad de fechas
   *  (WKH-198, CD-5): dominio, validadores de shape (gateways/route) y wallet.ts lo reusan. */
  export function isParseableIso(value: string): boolean {
    return !Number.isNaN(new Date(value).getTime());
  }
  ```
  `isQuoteExpired` queda:
  ```ts
  private isQuoteExpired(quote: Quote, nowIso: string): boolean {
    if (!isParseableIso(quote.expiresAt) || !isParseableIso(nowIso)) return true; // fail-closed (CD-1)
    return new Date(quote.expiresAt).getTime() <= new Date(nowIso).getTime();
  }
  ```
  Nota CD-1: se guardan AMBOS operandos (`expiresAt` **y** `nowIso`) — cualquiera NaN ⇒ EXPIRADO.
- **DT-5 — validadores de shape**: en `isValidQuoteShape` (gateways.ts) e `isValidQuoteResult`
  (route.ts), tras el chequeo `typeof v.expiresAt === "string"` existente, encadenar
  `&& isParseableIso(v.expiresAt)`. `isValidQuoteShape` sigue siendo type-guard válido
  (`v is RawQuoteResult`); `isValidQuoteResult` sigue devolviendo `boolean`. `route.ts` importa el
  predicado vía `import { isParseableIso } from "@/domain/remittance";`.
- **DT-6 — test-file de la route (resuelve TBD-2)**: `app/api/a2a/quote/route.test.ts` **YA EXISTE**
  (verificado, 74 líneas). Esta HU lo **extiende** con el caso AC-4 (no se crea un archivo nuevo).
- **DT-7 (heredada)**: NO se introduce un tipo `Quote` runtime-validado (branded / parse-don't-validate
  completo) — sería expandir scope. El fix es 1 predicado + 4 puntos de uso.
- **DT-8 — no tocar `mapResultToQuote`**: con `isValidQuoteShape` rechazando el `expiresAt` malo, el mapa
  a `Quote` (gateways.ts L70-81) sólo recibe fechas parseables; no se agrega guard ahí (evita ruido).

---

## 5. Constraint Directives (CD-N)

Heredadas del work-item (CD-1..CD-8) + nuevas de F2 (CD-9, CD-10):

- **CD-1 (MONEY-PATH, CRÍTICA)**: `isQuoteExpired` trata CUALQUIER `expiresAt`/`nowIso` no-parseable como
  EXPIRADO. PROHIBIDO que una comparación con `NaN` resulte en "vigente".
- **CD-2**: PROHIBIDO cambiar firmas públicas de `attachQuote`, `confirm`, `isQuoteStillValid`, ni
  `Quote`/`RemittanceState`. El fix es interno + un helper nuevo exportado (adición, no cambio de contrato).
- **CD-3**: PROHIBIDO tocar `TRANSITIONS`, `confirm_requires_kyc_passed`, o cualquier invariante de
  compliance/KYC.
- **CD-4**: PROHIBIDO tocar `payout-authority-gateway.ts`, `confirm-and-send.ts` (WKH-180) o cualquier
  lógica de payout — es WKH-202.
- **CD-5**: el chequeo de parseabilidad en `isValidQuoteShape`, `isValidQuoteResult`, `isQuoteExpired` y
  `wallet.ts` usa la MISMA lógica. **Cumplido por construcción**: los 4 reusan el único
  `isParseableIso` exportado del dominio (imposible que diverjan).
- **CD-6**: agregar/actualizar tests en la MISMA HU cubriendo `expiresAt` malformado (`"not-a-date"`,
  `""`) + no-regresión de quote-válido-pasado / quote-válido-futuro.
- **CD-7**: PROHIBIDO tocar archivos fuera de `chaski-v2/` (nada de `wasiai-a2a`, `wasiai-v2`,
  `wasiai-remittance-agents`, `yarvis`, `agentshop-*`).
- **CD-8**: PROHIBIDO `try/catch` silencioso en `wallet.ts` que trague el error — AC-5 exige fail LOUD
  (`throw new Error("quote_expires_at_invalid")`, capturable por `ConfirmAndSend`).
- **CD-9 (nueva, auto-blindaje WKH-186)**: el caso AC-4 en `route.test.ts` DEBE setear
  `vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE)`; si no, la route corta en 501 (env leído en runtime) y el
  test no ejercería el shape-check.
- **CD-10 (nueva, auto-blindaje WKH-187 ×2 / WKH-188)**: al tocar lógica de expiry, elegir fechas
  relativas al reloj correcto (el dominio usa `now` INYECTADO — no `new Date()`) y **correr la suite
  completa** tras la wave, no confiar sólo en los anchors de línea. Los tests EIP-3009 usan `eip3009Quote`
  con `expiresAt` fijo (string), no `new Date()`.

---

## 6. Waves de implementación

### W0 — SERIAL (contrato/fundacional)
El helper exportado es la dependencia de todo lo demás; va primero.

| Archivo | Cambio |
|---------|--------|
| `src/domain/remittance.ts` | (a) exportar `isParseableIso(value: string): boolean` (fn pura de módulo, junto a `toPersistedIdentity`/`canTransition`); (b) `isQuoteExpired` L257-259: guard fail-closed reusando `isParseableIso` para AMBOS operandos (DT-4). Sin cambios de firma pública (CD-2). |
| `src/domain/remittance.test.ts` | tests AC-1 (malformado ⇒ expirado vía `attachQuote`/`confirm`/`isQuoteStillValid`), AC-2 (válido pasado ⇒ expirado, no-regresión), AC-3 (válido futuro ⇒ no expirado, no-regresión). Opcional: test directo de `isParseableIso`. |

### W1 — PARALELIZABLE (los 3 consumidores del helper, independientes entre sí)

| Sub-wave | Archivos | Cambio |
|----------|----------|--------|
| **W1a** | `src/infrastructure/a2a/gateways.ts` + `gateways.test.ts` | `isValidQuoteShape` L50: `&& isParseableIso(v.expiresAt)`. Test: `validQuoteResult` con `expiresAt: "not-a-date"` ⇒ `requestQuote` `rejects.toThrow("a2a_quote_bad_shape")` (AC-4). |
| **W1b** | `app/api/a2a/quote/route.ts` + `route.test.ts` | `import { isParseableIso } from "@/domain/remittance"`; `isValidQuoteResult` L20: `&& isParseableIso(v.expiresAt)`. Test (extiende el archivo existente): `stubEnv(BASE)` + fetch devuelve `result` con `expiresAt` no-parseable ⇒ `502 { error: "a2a_bad_shape" }` (AC-4, CD-9). |
| **W1c** | `src/infrastructure/wallet.ts` + `wallet.test.ts` | `import { isParseableIso }` (extender el import existente de `../domain/remittance`); en AMBOS `authorizePrincipal` (L75, L189), rama `eip3009Enabled()`, antes del `BigInt(...)`: `if (!isParseableIso(quote.expiresAt)) throw new Error("quote_expires_at_invalid");` (AC-5, CD-8). Test: `enableEip3009()` + quote con `expiresAt` malformado ⇒ `rejects.toThrow("quote_expires_at_invalid")` + `eth_signTypedData_v4` NO llamado, para InjectedWallet y WalletConnectWallet. |

W1a/W1b/W1c no comparten archivos → paralelizables. Todas dependen de W0 (el `export`).

---

## 7. Exemplars verificados (paths confirmados)

| Patrón a seguir | Exemplar (path:línea real) |
|-----------------|----------------------------|
| Función pura exportada a nivel módulo en el dominio | `src/domain/remittance.ts:52-61` (`toPersistedIdentity`), `:101-103` aprox (`canTransition`) |
| Test de fn pura de dominio | `src/domain/remittance.test.ts:238-274` (bloque `toPersistedIdentity`) |
| Test de expiry existente (no-regresión AC-2/AC-3) | `remittance.test.ts:76-78` (vencido) y `:80-84` (confirm vencido) |
| Chequeo de shape + `throw a2a_quote_bad_shape` | `gateways.ts:42-53` + `:106`; test `gateways.test.ts:62-65` |
| Chequeo de shape server + `502 a2a_bad_shape` | `quote/route.ts:12-23` + `:38-40`; test `route.test.ts:59-65` |
| `throw` nombrado antes de firmar (rama EIP-3009) | `wallet.ts:67`/`:182` (`isAddress`→`invalid_address`); harness test `wallet.test.ts:256-310` |
| `stubEnv` + `stubGlobal(fetch)` en route test | `route.test.ts:52-53`, `:37-49` |
| Alias de import a dominio desde `app/` | `tsconfig.json:23-26` (`@/* → ./src/*`) |

---

## 8. Plan de tests (≥1 por AC)

| AC | Archivo de test | Caso | Aserción |
|----|-----------------|------|----------|
| **AC-1** | `remittance.test.ts` (W0) | `attachQuote({...quote(), expiresAt: "not-a-date"}, T0)` | `toThrow(/quote_expired/)` |
| **AC-1** | `remittance.test.ts` (W0) | `ready()` con quote válido, luego `confirm` con `now` malformado NO aplica; usar quote con `expiresAt` malformado y `confirm` | quote malformado ⇒ `confirm` `toThrow(/confirm_quote_expired/)`; `isQuoteStillValid` con snapshot malformado ⇒ `false` |
| **AC-1** | `remittance.test.ts` (W0) | `expiresAt: ""` (string vacío, CD-6) | tratado como expirado |
| **AC-2** | `remittance.test.ts` (W0) | `expiresAt: T0`, `now = T0` (o posterior) | expirado (no regresiona; reusa/mantiene L76-78) |
| **AC-3** | `remittance.test.ts` (W0) | `expiresAt: QUOTE_EXPIRES` futuro, `now = T0` | NO expirado (happy path L44-56 no regresiona) |
| **AC-4** | `gateways.test.ts` (W1a) | `{...validQuoteResult, expiresAt: "not-a-date"}` | `requestQuote` `rejects.toThrow("a2a_quote_bad_shape")` |
| **AC-4** | `route.test.ts` (W1b) | `stubEnv(BASE)` + fetch `result` con `expiresAt` no-parseable | `res.status === 502`, `{ error: "a2a_bad_shape" }` (CD-9) |
| **AC-5** | `wallet.test.ts` (W1c) | `enableEip3009()` + `{...eip3009Quote, expiresAt: "not-a-date"}`, InjectedWallet | `authorizePrincipal` `rejects.toThrow("quote_expires_at_invalid")`; `eth_signTypedData_v4` NO llamado |
| **AC-5** | `wallet.test.ts` (W1c) | idem, WalletConnectWallet | mismo veredicto |
| **CD-8** | `wallet.test.ts` (W1c) | (implícito en AC-5) | el error es un `Error` con message estable, NO un `RangeError` de `BigInt(NaN)` |

Notas:
- Fixtures de fecha malformada sugeridos: `"not-a-date"`, `""`. Ambos ⇒ `new Date(x).getTime()` NaN.
- `route.test.ts`: seguir el patrón `vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ result: {...} }) })))` de L60-61.
- Correr suite completa (`npm test` / `vitest run`) tras W1 (CD-10): el cambio de `isQuoteExpired` es
  compartido; verificar 0 rojos en `remittance.test.ts`, `use-cases.test.ts`, `track-remittance.test.ts`,
  `persistence.test.ts` (los que ejercen quotes) — no confiar sólo en los anchors.

---

## 9. Análisis de impacto / no-regresión

- `isQuoteExpired` añade una guarda AL INICIO; para fechas válidas el comportamiento es byte-idéntico
  (misma comparación `<=`). Los 3 consumidores (`attachQuote` L213, `confirm` L224, `isQuoteStillValid`
  L254) heredan el fix sin cambio de firma (CD-2).
- `isValidQuoteShape`/`isValidQuoteResult` sólo AGREGAN una condición de rechazo (`&& isParseableIso`);
  un `expiresAt` válido sigue pasando. `FallbackQuoteGateway` genera `expiresAt` con `toISOString()`
  (siempre válido) → sin impacto (Scope OUT, verificado work-item L118-119).
- `wallet.ts`: la guarda es un `throw` ANTES del `BigInt`, sólo en rama `eip3009Enabled()` (flag OFF por
  default, WKH-186/AC-9). Con flag OFF el path demo (`signMessage`) no toca `expiresAt` → sin impacto.
- Import nuevo en `quote/route.ts` desde `@/domain/remittance`: `remittance.ts` sólo depende de `./money`
  (puro) → seguro en un módulo server-only; no arrastra deps de browser.

---

## 10. Resolución de Missing Inputs del work-item

- **TBD-1 (mecanismo del guard en wallet.ts)** → **RESUELTO (DT-3/DT-4)**: reusar el predicado puro
  `isParseableIso` **exportado** del dominio (dirección dominio→infra, exposición explícita), no duplicar.
  Cierra CD-5 por construcción.
- **TBD-2 (test-file de la route)** → **RESUELTO (DT-6)**: `app/api/a2a/quote/route.test.ts` **YA EXISTE**;
  esta HU lo extiende con el caso AC-4. No se crea archivo nuevo.

Sin `[NEEDS CLARIFICATION]` pendientes.

---

## 11. Readiness Check

- [x] Root cause reconfirmado contra el código ACTUAL (post-WKH-186/187): `remittance.ts:257-259`,
      `wallet.ts:75/189`, `gateways.ts:42-53`, `quote/route.ts:12-23`.
- [x] Exemplars verificados con Read (paths + líneas reales, §7).
- [x] Los 2 TBD del work-item resueltos con evidencia (§10) — 0 `[NEEDS CLARIFICATION]`.
- [x] `route.test.ts` confirmado existente (no se inventa archivo).
- [x] Alias `@/* → ./src/*` verificado en `tsconfig.json` (import de la route al dominio es válido).
- [x] Dirección dominio→infra confirmada preexistente (`gateways.ts:8`, `wallet.ts:5`).
- [x] Todos los CD del work-item heredados (CD-1..CD-8) + 2 nuevos de auto-blindaje (CD-9, CD-10).
- [x] Test plan con ≥1 test por AC (§8) + no-regresión AC-2/AC-3 + verificación fail-loud CD-8.
- [x] Scope OUT respetado: payout/WKH-180, `TRANSITIONS`, compliance, `fallback/gateways.ts` intactos.
- [x] SOLO chaski-v2 (CD-7).

**Veredicto: LISTO para SPEC_APPROVED.** Fix quirúrgico (1 helper nuevo + 4 puntos de uso + tests),
bajo riesgo, sin cambios de contrato, dos TBD resueltos por evidencia del código.
