# Story File — HU WKH-198: Fail-closed en expiry de quote (guard NaN + validación de shape de fecha)

> Contrato autocontenido para el Dev (F3). El Dev SOLO lee este archivo.
> Fuente: `sdd.md` (SPEC_APPROVED) + `work-item.md` en `doc/sdd/012-wkh-198-quote-expiry-fail-closed/`.
> Tipo: bugfix (money-path integrity — control de FX rancio) · Branch: `fix/198-quote-expiry-fail-closed`
> Repo: **chaski-v2** (`/home/ferdev/.openclaw/workspace/chaski-v2`) — CD-7: SOLO este repo.

---

## 1. Contexto compacto (qué se construye y por qué)

`isQuoteExpired` (`src/domain/remittance.ts:257-259`) compara timestamps con `<=`. Si
`quote.expiresAt` no parsea a fecha (`new Date(x).getTime() → NaN`), toda comparación con `NaN` es
`false` en JS → el quote **nunca vence** y el control de FX rancio queda anulado. El mismo dato
malformado, con `NEXT_PUBLIC_EIP3009_ENABLED=true`, hace que `wallet.ts:75`/`:189` computen
`BigInt(NaN)` → `RangeError` opaco sin `catch` al firmar (remesa atascada en `confirmed` sin refund).

El fix es **quirúrgico**: **un solo predicado puro nuevo** exportado del dominio —
`isParseableIso(value: string): boolean` = `!Number.isNaN(new Date(value).getTime())` — **reusado en
4 puntos** para que la lógica no pueda divergir (cierra CD-5 por construcción):

1. **Dominio (defensa de último recurso)**: `isQuoteExpired` trata `expiresAt` **o** `nowIso`
   no-parseable como **EXPIRADO** (fail-closed).
2. **Borde de shape (prevención)**: `isValidQuoteShape` (gateways.ts) e `isValidQuoteResult`
   (quote/route.ts) rechazan un `expiresAt` string que no parsee, ANTES de construir un `Quote`.
3. **Defensa en profundidad EIP-3009**: `wallet.ts` falla **LOUD** con error nombrado
   (`quote_expires_at_invalid`) antes del `BigInt(...)`.

La dirección de dependencias **dominio→infra ya existe** y es la permitida: `gateways.ts:8` y
`wallet.ts:5` YA importan de `../../domain/remittance` / `../domain/remittance`; `quote/route.ts`
lo importará vía el alias `@/domain/remittance` (`tsconfig paths: @/* → ./src/*`, verificado).

---

## 2. Scope IN (lista exhaustiva de archivos a tocar)

| Archivo | Acción |
|---------|--------|
| `src/domain/remittance.ts` | (a) exportar la fn pura `isParseableIso`; (b) guard fail-closed en `isQuoteExpired` (L257-259). |
| `src/domain/remittance.test.ts` | tests AC-1 (malformado ⇒ expirado) + no-regresión AC-2/AC-3 + (opcional) test directo de `isParseableIso`. |
| `src/infrastructure/a2a/gateways.ts` | `isValidQuoteShape` (L50): `&& isParseableIso(v.expiresAt)`; importar el helper. |
| `src/infrastructure/a2a/gateways.test.ts` | test AC-4: `expiresAt` no-parseable ⇒ `requestQuote` throw `a2a_quote_bad_shape`. |
| `app/api/a2a/quote/route.ts` | importar `isParseableIso` de `@/domain/remittance`; `isValidQuoteResult` (L20): `&& isParseableIso(v.expiresAt)`. |
| `app/api/a2a/quote/route.test.ts` | test AC-4 server: `stubEnv(BASE)` + fetch con `expiresAt` no-parseable ⇒ 502 `a2a_bad_shape`. |
| `src/infrastructure/wallet.ts` | extender el import de `../domain/remittance`; guard fail-loud en AMBOS `authorizePrincipal` (L75, L189) antes del `BigInt(...)`. |
| `src/infrastructure/wallet.test.ts` | tests AC-5 (InjectedWallet + WalletConnectWallet): `expiresAt` malformado ⇒ throw `quote_expires_at_invalid`, firma NO llamada. |

**PROHIBIDO tocar cualquier otro archivo.** En particular (Scope OUT, reusar sin cambios):
`src/infrastructure/fallback/gateways.ts` (genera `expiresAt` siempre válido); `TRANSITIONS`,
`confirm()` gates KYC, `confirm_requires_kyc_passed`, `assertReceiveConsistent`; `mapResultToQuote`
(gateways.ts:70-81 — no agregar guard ahí, DT-8); `src/infrastructure/payout/*`, `confirm-and-send.ts`,
`payout-authority-gateway.ts`, `/api/payout/validate` (WKH-180/202); flags de payout. **Nada fuera de
`chaski-v2/`** (CD-7).

---

## 3. Anti-Hallucination Checklist (verificá antes de codear)

- [ ] `isParseableIso` es un **helper NUEVO** exportado a nivel módulo del dominio, mismo patrón que
      `toPersistedIdentity` (`remittance.ts:52-61`) y `canTransition` (`remittance.ts:101-103`). NO
      es un método de clase.
- [ ] El chequeo correcto es **`!Number.isNaN(new Date(value).getTime())`**. PROHIBIDO `=== NaN`
      (siempre `false`) o `!Number.isFinite(...)` (DT-2).
- [ ] `isQuoteExpired` es un método `private` de la clase `Remittance` en `remittance.ts:257-259`.
      Firma actual EXACTA: `private isQuoteExpired(quote: Quote, nowIso: string): boolean`. **NO
      cambiar la firma** (CD-2).
- [ ] Sus 3 consumidores heredan el fix SIN cambios: `attachQuote` (L213 → `quote_expired`),
      `confirm` (L224 → `confirm_quote_expired`), `isQuoteStillValid` (L253-255, público → `false`).
      NO los toques.
- [ ] `isValidQuoteShape` (gateways.ts:42-53) es un type-guard `v is RawQuoteResult`; el chequeo del
      `expiresAt` existente está en **L50** (`typeof v.expiresAt === "string"`). Encadenás `&&` DENTRO
      del `return (...)`. Sigue siendo type-guard válido.
- [ ] `isValidQuoteResult` (route.ts:12-23) devuelve `boolean`; el chequeo existente está en **L20**.
      Mismo patrón: `&& isParseableIso(v.expiresAt)` dentro del `return (...)`.
- [ ] `route.ts` NO importa nada de `src/` hoy. Agregás `import { isParseableIso } from "@/domain/remittance";`.
      El alias `@/* → ./src/*` está verificado en `tsconfig.json:23-26`. `remittance.ts` sólo depende de
      `./money` (puro, sin deps browser) → seguro en un módulo server-only.
- [ ] `wallet.ts:5` YA tiene `import type { Quote } from "../domain/remittance";`. Como `isParseableIso`
      es un **valor** (función), NO un tipo, necesitás un import de valor. Dejá el `import type { Quote }`
      y agregá una línea `import { isParseableIso } from "../domain/remittance";` (o convertí a un import
      mixto correcto). No uses `import type` para el helper.
- [ ] El `BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000))` está en **L75** (`InjectedWallet`)
      y **L189** (`WalletConnectWallet`), AMBOS dentro de la rama `if (eip3009Enabled())`. El guard va
      JUSTO ANTES de esa línea, en los dos wallets.
- [ ] Fail **LOUD**: `throw new Error("quote_expires_at_invalid")`. PROHIBIDO `try/catch` que trague
      el error (CD-8).
- [ ] Fixtures de fecha malformada: `"not-a-date"` y `""` (string vacío). Ambos ⇒ `getTime()` NaN.
- [ ] El dominio usa `now` **INYECTADO** (nunca `new Date()`). En los tests de dominio, las fechas son
      strings explícitos (`T0`, `QUOTE_EXPIRES` de `../test-support/fakes`). Los tests EIP-3009 usan
      `eip3009Quote` con `expiresAt` string fijo. NO introduzcas `new Date()` real (CD-10).

---

## 4. Waves de implementación

> **W0 es SERIAL y fundacional** (todo lo demás depende del `export`). **W1a/W1b/W1c son
> paralelizables** entre sí (no comparten archivos). Todas dependen de W0.

### W0 — SERIAL · `src/domain/remittance.ts` + `remittance.test.ts`

**W0.1 — exportar el helper puro** (`remittance.ts`). Agregar una función a nivel módulo (junto a
`toPersistedIdentity` / `canTransition`, p.ej. cerca de `canTransition` en L101-103):

```ts
/** ¿`value` parsea a un instante válido? Fuente ÚNICA del chequeo de parseabilidad de fechas
 *  (WKH-198, CD-5): dominio, validadores de shape (gateways/route) y wallet.ts lo reusan. */
export function isParseableIso(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}
```

**W0.2 — guard fail-closed en `isQuoteExpired`** (`remittance.ts:257-259`). Reemplazar el cuerpo,
guardando AMBOS operandos (CD-1). SIN cambiar la firma:

```ts
private isQuoteExpired(quote: Quote, nowIso: string): boolean {
  if (!isParseableIso(quote.expiresAt) || !isParseableIso(nowIso)) return true; // fail-closed (CD-1)
  return new Date(quote.expiresAt).getTime() <= new Date(nowIso).getTime();
}
```

**W0.3 — tests de dominio** (`remittance.test.ts`). Constantes disponibles del import existente
(`../test-support/fakes`): `T0 = "2026-07-09T18:00:00.000Z"`, `QUOTE_EXPIRES = "2026-07-09T18:10:00.000Z"`
(T0 + 10 min). Fakes locales: `quote()` (L23-32, `expiresAt: QUOTE_EXPIRES`), `ready()` (L34-41,
devuelve `kyc_passed` con quote). Reusar el patrón de los tests de expiry existentes:
- `remittance.test.ts:76-78` — `attachQuote({ ...quote(), expiresAt: T0 }, T0)` ⇒ `toThrow(/quote_expired/)`.
- `remittance.test.ts:80-84` — `confirm` con `now` futuro ⇒ `toThrow(/confirm_quote_expired/)`.

Casos a agregar (bloque nuevo `describe("WKH-198 — expiry fail-closed", ...)`):

| ID | Caso | Aserción |
|----|------|----------|
| AC-1a | `ready().attachQuote({ ...quote(), expiresAt: "not-a-date" }, T0)` | `toThrow(/quote_expired/)` |
| AC-1b | `ready().attachQuote({ ...quote(), expiresAt: "" }, T0)` (string vacío, CD-6) | `toThrow(/quote_expired/)` |
| AC-1c | `r = ready(); r.attachQuote(quote(), T0); confirm` con quote malformado. Como `confirm` lee `this.state.quote`, para ejercer `confirm_quote_expired` por `expiresAt` malo, adjuntá un quote válido y probá el path directo: usá `isQuoteStillValid` sobre un estado con quote malformado. Alternativa robusta: construí una Remittance, `attachQuote` con quote válido, y verificá que un `nowIso` malformado también da EXPIRADO: `r.confirm("not-a-date")` (KYC ya pasó en `ready()`+re-attach) ⇒ `toThrow(/confirm_quote_expired/)` (guardia sobre `nowIso`, CD-1) | `toThrow(/confirm_quote_expired/)` |
| AC-1d | `isQuoteStillValid`: `ready()` (tiene quote válido), llamar `r.isQuoteStillValid("not-a-date")` (nowIso malformado ⇒ fail-closed) | `toBe(false)` |
| AC-2 | no-regresión: `attachQuote({ ...quote(), expiresAt: T0 }, T0)` (válido, `<= now`) | `toThrow(/quote_expired/)` (mantiene L76-78) |
| AC-3 | no-regresión: `ready()` happy path con `expiresAt: QUOTE_EXPIRES` (futuro), `now = T0` | NO expira (el `happy path completo` L44-56 sigue verde) |
| (opc) | test directo: `isParseableIso("2026-07-09T18:00:00.000Z") === true`; `isParseableIso("not-a-date") === false`; `isParseableIso("") === false` | — |

> Nota AC-1c: `confirm` requiere KYC pasado + quote presente. `ready()` deja `kyc_passed` con quote;
> hay que `attachQuote(quote(), T0)` para volver a `quoted` (o confirmar desde `kyc_passed`, ambos
> permitidos por `TRANSITIONS`). El vector más limpio para cubrir el guard de `nowIso` malformado es
> pasar un `now` no-parseable a `confirm`/`isQuoteStillValid` con quote válido. El vector de
> `expiresAt` malformado se cubre 100% vía `attachQuote` (AC-1a/AC-1b). No hace falta tamperear el
> estado interno.

### W1a — PARALELIZABLE · `src/infrastructure/a2a/gateways.ts` + `gateways.test.ts`

**Producción** — `isValidQuoteShape` (L42-53), agregar al import y encadenar en L50:

```ts
// import (cerca de L8, junto a `import type { Quote } ...`): NO uses `import type` para el helper.
import { isParseableIso } from "../../domain/remittance";
```
```ts
    typeof v.expiresAt === "string" &&
    isParseableIso(v.expiresAt) &&        // WKH-198 AC-4: rechaza fecha no-parseable
    typeof v.provenance === "string"
```
`mapResultToQuote` NO se toca (DT-8).

**Test** — reusar `validQuoteResult` (L8-18) y el helper `okJson` (L29-31). Patrón del test existente
de shape inválido (`gateways.test.ts:62-65`). Agregar al `describe("A2aQuoteGateway ...")`:

```ts
it("WKH-198 AC-4: expiresAt no-parseable → throw a2a_quote_bad_shape", async () => {
  vi.stubGlobal("fetch", okJson({ result: { ...validQuoteResult, expiresAt: "not-a-date" } }));
  await expect(new A2aQuoteGateway().requestQuote(quoteReq)).rejects.toThrow("a2a_quote_bad_shape");
});
```
`quoteReq` ya existe (L6). `afterEach(() => vi.restoreAllMocks())` ya está (L33).

### W1b — PARALELIZABLE · `app/api/a2a/quote/route.ts` + `route.test.ts`

**Producción** — agregar el import (arriba, junto al `import { NextResponse }` de L5) y encadenar en
`isValidQuoteResult` (L20):

```ts
import { isParseableIso } from "@/domain/remittance";
```
```ts
    typeof v.expiresAt === "string" &&
    isParseableIso(v.expiresAt) &&        // WKH-198 AC-4: rechaza fecha no-parseable
    typeof v.provenance === "string"
```

**Test** — el archivo `route.test.ts` **YA EXISTE** (75 líneas), se **extiende** (no se crea). Reusar
`validResult` (L14-22), `req()` (L6-12), `BASE` (L4). **CD-9 crítico**: la route lee
`process.env.REMIT_AGENTS_BASE_URL` DENTRO del handler (L26) → SIN `stubEnv` la route corta en 501
antes del shape-check. Seguí el patrón del test "shape inválido" (L59-65). Agregar:

```ts
it("WKH-198 AC-4: expiresAt no-parseable del agente → 502 a2a_bad_shape (CD-9)", async () => {
  vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => ({ result: { ...validResult, expiresAt: "not-a-date" } }),
  })));
  const res = await POST(req({ amountUsd: 400, destCountry: "PE", payoutMethod: "yape" }));
  expect(res.status).toBe(502);
  expect(await res.json()).toEqual({ error: "a2a_bad_shape" });
});
```
`afterEach(() => vi.restoreAllMocks())` ya está (L24) y limpia `stubEnv`.

### W1c — PARALELIZABLE · `src/infrastructure/wallet.ts` + `wallet.test.ts`

**Producción** — `wallet.ts:5` tiene `import type { Quote } from "../domain/remittance";`. Agregar un
import de VALOR para el helper (NO `import type`):

```ts
import { isParseableIso } from "../domain/remittance";
```

En AMBOS `authorizePrincipal`, rama `if (eip3009Enabled())`, JUSTO ANTES del `const validBefore = BigInt(...)`
(L75 en `InjectedWallet`, L189 en `WalletConnectWallet`):

```ts
      if (!isParseableIso(quote.expiresAt)) throw new Error("quote_expires_at_invalid"); // WKH-198 AC-5 (CD-8: fail LOUD)
      const validBefore = BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000));
```
Fail LOUD, sin `try/catch` (CD-8). Va en LOS DOS wallets.

**Test** — el harness EIP-3009 YA EXISTE: `eip3009Quote` (L110-119, `expiresAt` string fijo),
`enableEip3009()` (L121-125), `makeProvider`/`makeWcProvider`, y el `wc` hoisted. El `afterEach`
(L98-105) borra los env `NEXT_PUBLIC_EIP3009_ENABLED`/receiver/usdc y `window`/`wc.provider`. Reusar
el patrón de los bloques `describe("EIP-3009 flag ... InjectedWallet")` (L256-284) y `... WalletConnectWallet`
(L286-310). Agregar dos casos (uno por wallet):

```ts
describe("WKH-198 AC-5 — expiresAt malformado en firma EIP-3009 real", () => {
  it("InjectedWallet: flag ON + expiresAt no-parseable → throw quote_expires_at_invalid, firma NO llamada", async () => {
    enableEip3009();
    const p = makeProvider();
    stubWindow(p);
    const w = new InjectedWallet();
    await w.connect();
    await expect(w.authorizePrincipal({ ...eip3009Quote, expiresAt: "not-a-date" }))
      .rejects.toThrow("quote_expires_at_invalid");
    expect(p.calls.some((c) => c.method === "eth_signTypedData_v4")).toBe(false);
  });

  it("WalletConnectWallet: flag ON + expiresAt no-parseable → throw quote_expires_at_invalid, firma NO llamada", async () => {
    enableEip3009();
    wc.provider = makeWcProvider();
    const w = new WalletConnectWallet("proj-id");
    await w.connect();
    await expect(w.authorizePrincipal({ ...eip3009Quote, expiresAt: "not-a-date" }))
      .rejects.toThrow("quote_expires_at_invalid");
    const p = wc.provider as ReturnType<typeof makeWcProvider>;
    expect(p.calls.some((c) => c.method === "eth_signTypedData_v4")).toBe(false);
  });
});
```

> `stubWindow` y `makeWcProvider` ya se usan en los bloques existentes; confirmá el nombre exacto del
> helper de window en tu archivo (los tests EIP-3009 InjectedWallet usan `stubWindow(p)`; los WC usan
> `wc.provider = makeWcProvider()`). CD-8 verificado: el error es un `Error` con message estable
> `quote_expires_at_invalid`, NO un `RangeError` opaco de `BigInt(NaN)`.

---

## 5. Constraint Directives a respetar (heredadas del work-item + F2)

- **CD-1 (MONEY-PATH, CRÍTICA)**: `isQuoteExpired` trata CUALQUIER `expiresAt` **o** `nowIso`
  no-parseable como EXPIRADO. PROHIBIDO que una comparación con `NaN` resulte en "vigente".
- **CD-2**: PROHIBIDO cambiar firmas públicas de `attachQuote`, `confirm`, `isQuoteStillValid`, ni
  `Quote`/`RemittanceState`. El helper nuevo es una ADICIÓN exportada, no un cambio de contrato.
- **CD-3**: PROHIBIDO tocar `TRANSITIONS`, `confirm_requires_kyc_passed`, invariantes de compliance/KYC.
- **CD-4**: PROHIBIDO tocar payout (`payout-authority-gateway.ts`, `confirm-and-send.ts`, flags) — WKH-202.
- **CD-5**: los 4 sitios usan la MISMA lógica. **Cumplido por construcción**: todos reusan el único
  `isParseableIso` exportado. NO dupliques el chequeo `Number.isNaN(...)` en ningún sitio.
- **CD-6**: tests en la MISMA HU con `expiresAt` malformado (`"not-a-date"`, `""`) + no-regresión
  válido-pasado / válido-futuro.
- **CD-7**: PROHIBIDO tocar archivos fuera de `chaski-v2/`.
- **CD-8**: PROHIBIDO `try/catch` silencioso en `wallet.ts` — fail LOUD con `throw new Error("quote_expires_at_invalid")`.
- **CD-9 (auto-blindaje WKH-186)**: el caso AC-4 en `route.test.ts` DEBE setear
  `vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE)` (si no, la route corta en 501 y no ejercería el shape-check).
- **CD-10 (auto-blindaje WKH-187 ×2 / WKH-188)**: al tocar expiry, usar fechas relativas al reloj
  correcto (dominio = `now` INYECTADO, nunca `new Date()`; EIP-3009 = `eip3009Quote.expiresAt` string
  fijo) y **correr la suite COMPLETA** tras la wave — no confiar sólo en los anchors de línea.

---

## 6. Exemplars verificados (paths + líneas reales)

| Patrón | Exemplar |
|--------|----------|
| Fn pura exportada a nivel módulo del dominio | `src/domain/remittance.ts:52-61` (`toPersistedIdentity`), `:101-103` (`canTransition`) |
| Test de expiry (no-regresión AC-2/AC-3) | `remittance.test.ts:76-78` (vencido), `:80-84` (confirm vencido), `:44-56` (happy path) |
| Shape-guard + `throw a2a_quote_bad_shape` | `gateways.ts:42-53` + `:106`; test `gateways.test.ts:62-65` (usa `okJson` L29-31) |
| Shape-guard server + `502 a2a_bad_shape` | `quote/route.ts:12-23` + `:38-40`; test `route.test.ts:59-65` (`stubEnv` L52 + `stubGlobal(fetch)`) |
| `throw` nombrado antes de firmar (rama EIP-3009) | `wallet.ts:67`/`:182` (`isAddress`→`invalid_address`) |
| Harness EIP-3009 flag ON | `wallet.test.ts:110-125` (`eip3009Quote`, `enableEip3009`), bloques `:256-284`/`:286-310` |
| Alias import a dominio desde `app/` | `tsconfig.json:23-26` (`@/* → ./src/*`) |
| Fakes de fecha | `src/test-support/fakes.ts:34-35` (`T0`, `QUOTE_EXPIRES`) |

---

## 7. Tests requeridos (≥1 por AC)

| AC | Archivo | Caso | Aserción |
|----|---------|------|----------|
| AC-1 | `remittance.test.ts` | `attachQuote` con `expiresAt: "not-a-date"` y `""` | `toThrow(/quote_expired/)` |
| AC-1 | `remittance.test.ts` | `confirm`/`isQuoteStillValid` con `nowIso` malformado (quote válido) | `toThrow(/confirm_quote_expired/)` / `toBe(false)` |
| AC-2 | `remittance.test.ts` | `expiresAt: T0`, `now = T0` (válido, `<=`) | expirado (no regresiona) |
| AC-3 | `remittance.test.ts` | `expiresAt: QUOTE_EXPIRES` futuro, `now = T0` | NO expira (no regresiona) |
| AC-4 | `gateways.test.ts` | `{ ...validQuoteResult, expiresAt: "not-a-date" }` | `requestQuote` rejects `a2a_quote_bad_shape` |
| AC-4 | `route.test.ts` | `stubEnv(BASE)` + fetch `result` con `expiresAt` no-parseable | `status === 502`, `{ error: "a2a_bad_shape" }` |
| AC-5 | `wallet.test.ts` | `enableEip3009()` + `expiresAt: "not-a-date"`, InjectedWallet | rejects `quote_expires_at_invalid`; `eth_signTypedData_v4` NO llamado |
| AC-5 | `wallet.test.ts` | idem, WalletConnectWallet | mismo veredicto |

---

## 8. Done Definition

- [ ] Los 8 archivos del Scope IN modificados; ningún otro archivo tocado; nada fuera de `chaski-v2/`.
- [ ] `isParseableIso` exportado UNA sola vez del dominio y reusado en los 4 sitios (CD-5). Sin
      duplicación de `Number.isNaN(new Date(...))` en gateways/route/wallet.
- [ ] `isQuoteExpired` guarda AMBOS operandos (fail-closed CD-1); firmas públicas intactas (CD-2).
- [ ] `wallet.ts` falla LOUD (`throw new Error("quote_expires_at_invalid")`) en los DOS wallets, sin
      `try/catch` silencioso (CD-8); guard ANTES del `BigInt(...)`.
- [ ] `route.test.ts` AC-4 setea `vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE)` (CD-9).
- [ ] ≥1 test por AC (§7), incluyendo no-regresión AC-2/AC-3 y verificación fail-loud CD-8.
- [ ] **`npm run build` + `npm run typecheck` limpios** (TypeScript strict, sin `any` explícito).
- [ ] **`npm test` (suite COMPLETA, `vitest run`) verde** — CD-10: verificar 0 rojos en
      `remittance.test.ts`, `gateways.test.ts`, `route.test.ts`, `wallet.test.ts` y los que ejercen
      quotes (`use-cases.test.ts`, `track-remittance.test.ts`, `persistence.test.ts`). No confiar sólo
      en los anchors.

---

## 9. Comandos

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v2
npm run typecheck  # tsc --noEmit — TS strict limpio
npm run build      # next build --webpack
npm test           # vitest run — SUITE COMPLETA (CD-10)
# atajo: npm run qa  == typecheck + test
```
