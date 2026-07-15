# Report — HU [WKH-198] Fail-closed en expiry de quote — guard NaN + validación de shape de fecha

## Resumen ejecutivo

**WKH-198** cierra hallazgo A de la auditoría adversarial #2: bug de integridad money-path donde `isQuoteExpired` (remittance.ts:257-259) trata `NaN` (expiresAt malformado de un agente adversario o tampering de localStorage) como "no expirado" → el quote **nunca vence** (fail-open). En modo EIP-3009 real, el mismo dato produce `BigInt(NaN)` en wallet.ts:75/:189 → `RangeError` sin catch al firmar. **Fix quirúrgico en 3 capas**: (1) guard `Number.isNaN()` fail-closed en el dominio; (2) rechazo de shape en el borde (`isValidQuoteShape` + `isValidQuoteResult`); (3) guard defensivo fail-loud en wallet.ts. **Pipeline COMPLETO**: F0–F1–F2–F2.5–F3–AR–CR–F4 = **APROBADO PARA DONE**. Código listo para merge.

---

## Pipeline ejecutado

| Fase | Artefacto | Veredicto | Fecha |
|------|-----------|-----------|-------|
| F0 | project-context | cargado (Chaski v2, post-WKH-188) | 2026-07-14 |
| F1 | `work-item.md` (WKH-198) | HU_APPROVED (scope resuelto, no-bloqueantes) | 2026-07-14 |
| F2 | `sdd.md` | SPEC_APPROVED (arquitectura: 1 predicado puro exportado `isParseableIso` reusado en 4 sitios, CD-5 por construcción) | 2026-07-14 |
| F2.5 | `story-file.md` | contrato listo para F3 (scope IN exacto, anti-hallucination anchors, TBD resueltos) | 2026-07-14 |
| F3 | Implementación | COMPLETA: `isParseableIso` en dominio + 3 guards en borde/wallet + tests (95 líneas insertas) | 2026-07-14 |
| AR | `ar-report.md` | APROBADO (0 BLOQUEANTES, 1 MENOR: vitest alias MNR-1 fixeado en Wave 1b) | 2026-07-14 |
| CR | `cr-report.md` | APPROVED (0 BLOQUEANTES, MNR-1 documentado: import relativo no-alias) | 2026-07-14 |
| F4 | `f4-report.md` (validation) | **APROBADO PARA DONE** (tsc 0, vitest 275/275 tests, npm build OK, 5/5 ACs PASS, 10/10 CDs) | 2026-07-14 |

---

## Acceptance Criteria — resultado final (5/5 PASS)

| AC | Descripción | Status | Evidencia (archivo:línea) | Validación |
|----|---|---|---|---|
| **AC-1** | `expiresAt` no-parseable ⇒ `isQuoteExpired` devuelve `true` (fail-closed) | **PASS** | `src/domain/remittance.ts:258-259` (guard `Number.isNaN(...)`); test "malformed expiresAt" en remittance.test.ts | vitest PASS |
| **AC-2** | `expiresAt` válido + `<= nowIso` ⇒ EXPIRADO (no regresiona) | **PASS** | `src/domain/remittance.test.ts` (test existing expiry cases); vitest coverage | vitest PASS |
| **AC-3** | `expiresAt` válido + `> nowIso` ⇒ NO expirado (no regresiona) | **PASS** | `src/domain/remittance.test.ts` (test future quote); vitest coverage | vitest PASS |
| **AC-4** | Shape-validation rechaza `expiresAt` no-parseable en borde (gateway + route) | **PASS** | `src/infrastructure/a2a/gateways.ts:50-53` (&&); `app/api/a2a/quote/route.ts:20-23` (&&); tests en gateways.test.ts + route.test.ts | vitest + route.test PASS |
| **AC-5** | EIP-3009: `expiresAt` malformado ⇒ error explícito capturable (no `RangeError` opaco) | **PASS** | `src/infrastructure/wallet.ts:75,189` (guard `isParseableIso` antes de `BigInt(...)`); test en wallet.test.ts con EIP-3009 enabled | vitest PASS |

---

## Hallazgos finales

### BLOQUEANTEs
Ninguno. Pipeline limpio.

### MENORs (1, resuelto en fix-pack post-AR)

1. **MNR-1 (AR/CR)**: Import alias `@/domain/remittance` en route.ts rompe vitest.  
   - **Halgo**: Story File indicaba usar alias `@/` (resuelve bien en `tsc`/`next build`), pero vitest no tiene vite-tsconfig-paths configurado → `Error: Failed to load url @/domain/remittance` al cargar route.test.ts.
   - **Causa raíz**: Alias funciona en tsc + Next pero no en vitest. Todos los hermanos (`app/api/kyc/decision/route.ts`, etc.) usan ruta relativa `../../../../src/...`.
   - **Fix**: Usar ruta relativa `../../../../src/domain/remittance` en route.ts (matching hermanos), NO alias.  
   - **Status**: RESUELTO (route.ts modificado, vitest run 275/275 verde).  
   - **Lección**: Cualquier `import` NUEVO desde `app/api/**/route.ts` hacia `src/` con `.test.ts` colocado → usar ruta RELATIVA, no `@/`, hasta que exista vite-tsconfig-paths.

---

## Auto-Blindaje consolidado

### Patrón arquitectónico: Defensa en profundidad (2 capas + 1 defensiva)

- ✓ **Dominio (fail-closed)**: `isQuoteExpired` trata CUALQUIER `expiresAt`/`nowIso` no-parseable como EXPIRADO (último recurso, cubre incluso Remittance.rehydrate desde localStorage tampereado).
- ✓ **Borde de shape (prevención)**: `isValidQuoteShape` + `isValidQuoteResult` rechazan `expiresAt` string que no parsee ANTES de construir un Quote — evita que basura llegue al dominio.
- ✓ **Defensa en profundidad EIP-3009**: `wallet.ts` falla LOUD con error capturable (`quote_expires_at_invalid`) antes del `BigInt(NaN)` que causaría RangeError opaco.

### Lección: Predicado puro exportado del dominio

- **CD-5 resuelta por construcción**: Un único predicado `isParseableIso(value: string): boolean` exportado del dominio y reusado en 4 sitios (remittance.ts, gateways.ts, quote/route.ts, wallet.ts) hace **imposible que la lógica diverja**. No es redundancia — es idempotencia de la defensa. Patrón: cuando una validación es crítica y multi-sitio, exportar predicado puro del dominio (respeta dirección dominio→infra) y reusar explícitamente.

### Gotcha con vitest + alias

- **Alias `@/` NO resuelve en vitest sin plugins**: `@/*` en tsconfig.json funciona en tsc + Next Build, pero vitest requiere vite-tsconfig-paths o vite.config.ts con resolver. La desviación MNR-1 fue aplicada en Wave 1b tras detectar la falla. Lección: cuando la Story File sugiere alias, verificar contra `npm run test` (vitest) además de `tsc`/`next build`.

---

## Archivos modificados

### Modificados (6)

| Archivo | Wave | Cambio | LOC |
|---------|------|--------|-----|
| `src/domain/remittance.ts` | W1 | Exportar `isParseableIso` puro; guard `Number.isNaN(...)` en `isQuoteExpired:258-259` | +7 |
| `src/infrastructure/a2a/gateways.ts` | W1 | Import `isParseableIso`; agrega `&& isParseableIso(v.expiresAt)` en `isValidQuoteShape:50-53` | +2 |
| `app/api/a2a/quote/route.ts` | W1b | Import relativo `../../../../src/domain/remittance` (desvío MNR-1: NO alias `@/`); agrega `&& isParseableIso(v.expiresAt)` en `isValidQuoteResult:20-23` | +2 |
| `src/infrastructure/wallet.ts` | W1 | Extender import de `../domain/remittance`; guard fail-loud en AMBOS `authorizePrincipal` (L75, L189): test `isParseableIso` antes de `BigInt(...)` | +3 |
| `src/domain/remittance.test.ts` | W1 | NEW: test AC-1 "malformado → expirado", AC-2/AC-3 no-regresión | +41 |
| `src/infrastructure/a2a/gateways.test.ts` | W1 | NEW: test AC-4 "bad expiresAt → throw a2a_quote_bad_shape" | +5 |
| `app/api/a2a/quote/route.test.ts` | W1b | NEW: test AC-4 server "bad expiresAt + stubEnv(BASE) → 502 a2a_bad_shape" | +11 |
| `src/infrastructure/wallet.test.ts` | W1 | NEW: test AC-5 "EIP-3009 enabled + malformed expiresAt → throw quote_expires_at_invalid" (InjectedWallet + WalletConnectWallet) | +24 |

### Nuevos (0)

Ninguno. Fix es exclusivamente modificación quirúrgica de archivos existentes (guards + validadores).

---

## Decisiones diferidas a backlog

- **WKH-202**: Enforcement del submit + autoridad server-side de payout (relacionada, no en scope de WKH-198) — ya listada en backlog de auditoría adversarial #2.

---

## Lecciones para próximas HUs

1. **Defensa en profundidad > redundancia**: Cuando un bug afecta múltiples capas (dominio → borde → rama especial), implementar guards en TODAS las capas. No es redundancia — cada capa defiende un ángulo distinto (último recurso, prevención, fail-loud).

2. **Predicados puros como API de contrato**: Si una validación es crítica y multi-sitio, exportar un predicado puro del dominio (e.g., `isParseableIso`) y reusar. Esto cierra reglas como CD-5 ("la lógica no puede divergir") por construcción.

3. **Alias `@/` requiere vite.config o vite-tsconfig-paths**: El alias de TypeScript funciona en tsc + Next Build pero NO en vitest por default. Cuando Story File sugiera `@/`, verificar contra `npm run test` además de build.

4. **Foot-gun NaN en comparaciones JS**: `NaN <= x` es SIEMPRE `false`, `NaN >= x` es SIEMPRE `false`, `NaN == NaN` es SIEMPRE `false`. El único chequeo correcto es `Number.isNaN(...)`. En contextos money-path, estas comparaciones pueden anular gates críticos (ACL, timing, tolerancia) — usar DT-2 como standard.

---

## Merge & Deploy

- **Commit**: `625d411` (7 archivos, 95 líneas insertas)
- **Branch**: `fix/198-quote-expiry-fail-closed`
- **Status**: Listo para merge a `main` + deploy a staging/prod sin cambios post-CR.

