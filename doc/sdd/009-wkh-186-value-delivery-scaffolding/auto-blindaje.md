# Auto-Blindaje — WKH-186 (value-delivery scaffolding)

### [2026-07-11 19:27] Wave 2 — env var leído en module-load rompe vi.stubEnv en route tests
- **Error**: las 2 API routes a2a leían `const BASE = process.env.REMIT_AGENTS_BASE_URL` en el
  top-level del módulo. En los route `.test.ts` (`vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE)`) el env
  se stubea DESPUÉS del import → `BASE` quedaba con el valor de import-time (undefined) → 8 tests
  fallaban con 501 en vez de 200/502.
- **Causa raíz**: leer env en el scope del módulo congela el valor al importar; `vi.stubEnv` sólo
  afecta lecturas en runtime.
- **Fix**: mover `const BASE = process.env.REMIT_AGENTS_BASE_URL` DENTRO de `POST()` (patrón de los
  exemplars `app/api/payout/validate/route.ts` y `app/api/kyc/session/route.ts`, que leen `apiKey`
  dentro del handler).
- **Aplicar en**: cualquier API route nueva que dependa de un env stubeable en tests → leer el env
  dentro del handler, nunca en el top-level del módulo.

### [2026-07-11 19:21] Wave 1 — fixture de fake inconsistente disparó la reconciliación nueva
- **Error**: el happy-path de `use-cases.test.ts` falló al cablear la reconciliación (AC-6):
  `FakePayoutGateway.status()` devolvía `deliveredPen: Money.of(368, "PEN")`, valor arbitrario que
  NO coincide con el `receive` del `FakeQuoteGateway` para 400 USDC (~1478.15 PEN) → la
  reconciliación (correctamente) lo marcó `payout_amount_mismatch`→`refunded` en vez de `settled`.
- **Causa raíz**: el fixture 368 predaba la reconciliación; era un "delivered" que nadie validaba
  contra el quote. Al introducir el cruce delivered↔receive lockeado, el fixture quedó fuera de
  tolerancia.
- **Fix**: alinear el default de `FakePayoutGateway.status()` a `Money.of(1478.15, "PEN")` (consistente
  con el `FakeQuoteGateway` canónico de 400 USDC) + actualizar la assertion del test. La producción es
  regresión-safe: el Fallback real devuelve `deliveredPen: null` → la guarda `rec.deliveredPen &&`
  nunca corre (CD-2/regresión byte-idéntica).
- **Aplicar en**: cualquier fake de payout con `deliveredPen` no-null DEBE ser consistente con el
  `receive` del quote fake que se use en el mismo flujo, o la reconciliación lo refundeará.
