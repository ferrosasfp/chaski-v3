# Story File W2 — WKH-227 / HU-SOL-24 · repo `wasiai-facilitator` (PROVIDER)

> Contrato autocontenido para el Dev. Deriva de `chaski-v3/doc/sdd/032-wkh-227-contratos-idl-golden/sdd.md` (SPEC_APPROVED). El Dev SOLO lee este archivo.
>
> **Repo de trabajo:** `/home/ferdev/.openclaw/workspace/wasiai-facilitator`
> **Wave:** W2 (paralelizable con W1 y W3)
> **Naturaleza:** 100% ADITIVO. Fixture + tests + helper de hash. CERO edición de código de producción (schemas, IDL, adapters, routes NO se tocan).

---

## 1. Contexto mínimo

`wasiai-facilitator` recibe el body `/settle` (y `/verify`) validado por `VerifyRequestSchema`/`SettleRequestSchema` (`src/core/schemas.ts`, todos `.strict()`). Esta HU congela:
1. Un **fixture del body `/settle` EIP-3009** válido + un contract test que prueba que `VerifyRequestSchema` lo **acepta**, y que un body con campo extra/renombrado lo **rechaza** (`.strict()` caza el drift) → AC-1.
2. El **hash SHA-256 canónico del IDL vendoreado** (`src/chains/escrow-idl.ts`) contra una constante pinneada (AC-2) + comparación best-effort contra `solana-programs/target/idl/escrow.json` por path sibling (AC-3).

Este fixture `/settle` es el MISMO objeto que el consumer (chaski, W3) captura de `broadcastSettle()` y compara — es el punto de encuentro del contrato cross-repo.

---

## 2. Scope IN — archivos EXACTOS a crear

> ⚠️ **DESVIACIÓN JUSTIFICADA DE LOS PATHS DEL SDD §4.1** — el SDD lista `contracts/` en la raíz del repo. **Grounding F2.5 verificado:** en `wasiai-facilitator`, `vitest.config.ts` fija `include: ['src/**/*.test.ts']` → un test en `contracts/` en la raíz **NUNCA se ejecutaría** (`npm test` lo ignora → falso verde, AC-1 no probado). Además `tsconfig.json` tiene `rootDir: "./src"` → un archivo fuera de `src/` importado por un test de `src/` rompe `tsc`. **Por eso W2 vive bajo `src/`.** Contenido e intención idénticos al SDD; solo cambia la ubicación por restricción de tooling verificada.

| # | Archivo (path absoluto) | Acción |
|---|-------------------------|--------|
| 1 | `/home/ferdev/.openclaw/workspace/wasiai-facilitator/src/contracts/settle-eip3009.body.fixture.ts` | Crear |
| 2 | `/home/ferdev/.openclaw/workspace/wasiai-facilitator/src/contracts/contracts.provider.test.ts` | Crear |
| 3 | `/home/ferdev/.openclaw/workspace/wasiai-facilitator/src/chains/canonical-hash.ts` | Crear (helper test-scope, junto al hash test) |
| 4 | `/home/ferdev/.openclaw/workspace/wasiai-facilitator/src/chains/escrow-idl.hash.test.ts` | Crear |

**Grounding verificado (por qué `src/` funciona):**
- vitest `include: ['src/**/*.test.ts']` → los 2 `*.test.ts` bajo `src/` **SÍ corren**. ✓
- tsconfig `include: ['src/**/*']`, `exclude: ['**/*.test.ts']`, `rootDir: ./src` → el `*.fixture.ts` (#1) y `canonical-hash.ts` (#3), al NO ser `*.test.ts`, **SÍ los type-checkea** `tsc --noEmit` (CD-9). Los `*.test.ts` quedan excluidos de tsc (igual que TODOS los tests del repo hoy) pero vitest los transpila y corre.
- `lint`/`format:check` corren sobre `src/**` → los 4 archivos serán lint/prettier-checkeados. El `qa` script (`typecheck && lint && format:check && test`) debe quedar verde. **Escribí lint-clean** (`--max-warnings 0`).

---

## 3. Anti-Hallucination Checklist

- [ ] Los schemas se importan de `../core/schemas.js` (Node16 → **extensión `.js` OBLIGATORIA** en imports, patrón `core.schemas.solana.test.ts:20`). Exports reales: `VerifyRequestSchema`, `SettleRequestSchema` (schemas.ts:203-219; `SettleRequestSchema = VerifyRequestSchema`).
- [ ] El IDL se importa de `./escrow-idl.js` → `export const escrowIdl` (escrow-idl.ts). Es un objeto con `address: 'DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x'` y `metadata`/`instructions`/... Se LEE, jamás se edita (CD-2).
- [ ] Antes de escribir el body fixture, LEER `src/methods/eip3009/schemas.ts` → `Eip3009AuthorizationSchema` para los validadores exactos de `authorization` (from/to = AddressHex, value/validAfter/validBefore = Uint256String decimal, nonce = Bytes32Hex `0x`+64). NO inventar los formatos.
- [ ] El body válido matchea la **rama 1** del union (`Eip3009RequestSchema`, schemas.ts:101-110): `extra.assetTransferMethod === 'eip3009'`. Ver §4.
- [ ] `.strict()` está en TODOS los objetos → un campo extra hace fallar `.safeParse`. Es lo que prueba el drift.
- [ ] `node:crypto` (`createHash`) y `node:fs`/`node:path` ya disponibles. NO agregar deps.
- [ ] Base58: N/A (EVM-only, CD-10 no aplica). El body usa `0x`-hex + decimal strings.
- [ ] NO `any`. Strict-typed.

---

## 4. `src/contracts/settle-eip3009.body.fixture.ts` (fixture del body `/settle`)

Body EIP-3009 completo y VÁLIDO que matchea `Eip3009RequestSchema`. **Debe ser byte-idéntico al objeto que arma `broadcastSettle` en chaski** (chaski `facilitator-client.ts:88-104`), para que el contract test de W3 (`toEqual`) cierre. Estructura exacta:

```ts
// FIXTURE DE CONTRATO — ORIGEN (provider /settle). WKH-227 / HU-SOL-24, sync: 2026-07-22.
// Body EIP-3009 canónico que VerifyRequestSchema/SettleRequestSchema aceptan. Es el punto de
// encuentro cross-repo: chaski-v3 (consumer) vendorea una COPIA y la compara byte-a-byte contra
// el body que arma broadcastSettle(). NO editar a mano. Amounts = decimal STRING (AC-5).
export const settleEip3009Body = {
  x402Version: 2,                    // z.literal(2) — el NÚMERO, no "2"
  resource: { url: "https://chaski.example/api/settle" },
  accepted: {
    scheme: "exact",
    network: "eip155:84532",         // eip155:<chainId>
    amount: "400000000",             // uint256 decimal STRING (AC-5) — 400 USDC (6 dec)
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",   // USDC Base Sepolia (0x-hex, AddressHex)
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 60,
    extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
  },
  payload: {
    signature: "0x" + "ab".repeat(65),   // 65-byte 0x-hex (pasa el regex de PayloadSchema)
    authorization: {
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",   // AddressHex (checksum)
      to: "0x1111111111111111111111111111111111111111",
      value: "400000000",             // == accepted.amount (decimal string)
      validAfter: "0",
      validBefore: "1893456000",      // decimal string
      nonce: "0x" + "cd".repeat(32),  // Bytes32Hex (0x + 64 hex)
    },
  },
} as const;
```

> **IMPORTANTE — sincronía con W3:** los valores `asset`/`payTo`/`amount`/`from`/`to`/`nonce`/`validBefore`/`signature` de este fixture deben coincidir con el golden #3 que W3 genera de `broadcastSettle(fixedInput)`. Los valores canónicos están fijados en el SDD §4.4 y en el Story File W3. Si W3 genera algo distinto, gana el output REAL de `broadcastSettle` (CD-4) y se re-pinnea ESTE fixture. Verificá que `asset`/`from` sean el checksum EXACTO que emite chaski (viem checksumea). El Dev de W2 puede tomar el `asset` real de `resolveUsdcAddress()` para 84532 si difiere del literal de arriba — el contract test de W3 es el árbitro.

---

## 5. `src/contracts/contracts.provider.test.ts` (AC-1)

Exemplar: `src/__tests__/unit/core.schemas.solana.test.ts` (`VerifyRequestSchema.parse`/`safeParse`, fixtures literales, imports `.js`). Estructura:

**Bloque A — accept:**
```ts
expect(() => VerifyRequestSchema.parse(settleEip3009Body)).not.toThrow();
expect(VerifyRequestSchema.safeParse(settleEip3009Body).success).toBe(true);
```

**Bloque B — reject (drift):**
- Campo EXTRA en un objeto `.strict()`:
  ```ts
  const withExtra = { ...settleEip3009Body, accepted: { ...settleEip3009Body.accepted, foo: "bar" } };
  expect(VerifyRequestSchema.safeParse(withExtra).success).toBe(false);
  ```
- Campo RENOMBRADO (falta el requerido, sobra el nuevo):
  ```ts
  const { amount, ...restAccepted } = settleEip3009Body.accepted;
  const renamed = { ...settleEip3009Body, accepted: { ...restAccepted, amount2: amount } };
  expect(VerifyRequestSchema.safeParse(renamed).success).toBe(false);
  ```
- (Opcional recomendado) `x402Version: 3` → `success:false` (z.literal(2) — CD-8 del facilitator).

> Estos asserts prueban que si el schema del provider gana un campo requerido nuevo o renombra uno, el body que el consumer sigue mandando deja de validar → el drift se detecta.

---

## 6. `src/chains/canonical-hash.ts` (helper test-scope, AC-2)

Algoritmo canónico EXACTO (§4.3 del SDD — idéntico byte-a-byte al de W3). Sort recursivo de keys → JSON string canónico → SHA-256 hex:

```ts
import { createHash } from "node:crypto";

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v !== null && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export function canonicalSha256(obj: unknown): string {
  return createHash("sha256").update(canonicalJson(obj), "utf8").digest("hex");
}
```

---

## 7. `src/chains/escrow-idl.hash.test.ts` (AC-2 + AC-3)

```ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { escrowIdl } from "./escrow-idl.js";
import { canonicalSha256 } from "./canonical-hash.js";

// Pinneada y verificada en F2 sobre los 3 IDL reales (todos canonicalizan igual, address DR5G).
const ESCROW_IDL_SHA256 = "aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71";
```

**AC-2 (Nivel 1, SIEMPRE corre):**
```ts
it("AC-2: el IDL vendoreado canonicaliza al hash pinneado", () => {
  expect(canonicalSha256(escrowIdl)).toBe(ESCROW_IDL_SHA256);
});
```
> Si alguien edita `escrow-idl.ts` a mano sin re-pinnear la constante → ROJO.

**AC-3 (Nivel 2, best-effort — skip limpio si no está el sibling):**
```ts
const SIBLING = path.resolve(process.cwd(), "../solana-programs/target/idl/escrow.json");
(existsSync(SIBLING) ? it : it.skip)("AC-3: coincide con solana-programs (fuente de verdad)", () => {
  const idl = JSON.parse(readFileSync(SIBLING, "utf8"));
  expect(canonicalSha256(idl)).toBe(ESCROW_IDL_SHA256);
});
```
> `../solana-programs/target/idl/escrow.json` EXISTE hoy en el workspace (verificado F2.5). En CI del repo desplegado por separado NO estará → `it.skip` limpio, sin fallar. `solana-programs` se LEE, jamás se escribe (CD-2).

---

## 8. Constraint Directives que aplican a W2

- **CD-1**: CERO cambio runtime. No tocar `src/core/schemas.ts`, `src/chains/escrow-idl.ts`, adapters, routes.
- **CD-2**: `solana-programs/target/idl/escrow.json` se LEE, jamás se escribe. `src/chains/escrow-idl.ts` NO se edita.
- **CD-9 (WKH-196)**: gate = `npm run typecheck` (`tsc --noEmit` COMPLETO) + `npm test`. Además `npm run lint` (`--max-warnings 0`) y `format:check` deben quedar verdes (`qa` los corre). Strict-typed, sin `any`.
- **AC-5**: `amount`/`value` on-chain = decimal STRING. FIAT no aplica acá.
- **Imports con extensión `.js`** (Node16 moduleResolution) — obligatorio, si no `tsc` rompe.

---

## 9. Tests requeridos

| Test | AC | Verifica |
|------|----|----------|
| `contracts.provider.test.ts` bloque A | AC-1 | `VerifyRequestSchema` acepta el body EIP-3009 canónico |
| `contracts.provider.test.ts` bloque B | AC-1 | campo extra/renombrado → `.strict()` rechaza (drift rojo) |
| `escrow-idl.hash.test.ts` AC-2 | AC-2 | hash local del IDL vendoreado == pinneado |
| `escrow-idl.hash.test.ts` AC-3 | AC-3 | best-effort vs sibling `solana-programs` (skip si falta) |
| Suite existente | AC-6 | 100% verde |

---

## 10. Done Definition (W2)

- [ ] Los 4 archivos creados bajo `src/` (fixture + provider test + canonical-hash + hash test).
- [ ] `cd /home/ferdev/.openclaw/workspace/wasiai-facilitator && npx tsc --noEmit` → 0 errores.
- [ ] `npm test` → suite previa 100% verde + los 2 tests nuevos verdes (AC-3 corre porque el sibling existe).
- [ ] `npm run lint` y `npm run format:check` verdes (o `npm run qa` completo verde).
- [ ] `ESCROW_IDL_SHA256 = aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71` pinneada tal cual.
- [ ] Fixture `/settle` con header AC-7 y amounts como decimal string (AC-5).
- [ ] Ningún archivo de producción (`core/schemas.ts`, `escrow-idl.ts`, adapters, routes) modificado.

---

## 11. Comando de verificación

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-facilitator
npx tsc --noEmit            # CD-9: gate estático COMPLETO
npm test                   # AC-6 + los 2 tests nuevos
npm run qa                 # (recomendado) typecheck + lint + format:check + test
```
