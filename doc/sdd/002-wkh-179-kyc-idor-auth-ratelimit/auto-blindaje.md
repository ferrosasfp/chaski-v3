# Auto-Blindaje — WKH-179 (KYC IDOR + auth/rate-limit)

### [2026-07-10 18:50] Wave 0 — Tipo `Duration` de Upstash divergente
- **Error**: `tsc` falló con TS2345 en `rate-limit.ts` (L57/L62): mi alias local `type Duration = \`${number} ${string}\`` no era asignable al parámetro `Duration` de `Ratelimit.slidingWindow`, que es `\`${number} ${Unit}\` | \`${number}${Unit}\``.
- **Causa raíz**: inventé la firma del tipo de ventana en vez de derivarla de la librería. Aunque el valor real viene de env (string en runtime), el compilador exige el literal-type exacto de Upstash.
- **Fix**: `type Duration = Parameters<typeof Ratelimit.slidingWindow>[1]` — se deriva de la firma real; el valor de env se castea al entrar (validado en runtime).
- **Aplicar en**: cualquier helper que envuelva una lib con tipos literal-template. NO reconstruir el tipo a mano; derivarlo con `Parameters<>`/`ReturnType<>`.

### [2026-07-10 18:53] Wave 1 — `noUncheckedIndexedAccess` en mocks y split
- **Error**: `tsc` falló con TS2532/TS2493 en `session/route.test.ts` (`fetchMock.mock.calls[0][1].body`) y en `session/route.ts` (`.split(",")[0].trim()`). El `tsconfig` tiene `noUncheckedIndexedAccess`, así que todo acceso por índice es `T | undefined`.
- **Causa raíz**: asumí acceso por índice seguro (hábito de tsconfig sin la flag). Además `vi.fn(async () => ...)` infiere args `[]`, rompiendo `calls[0][1]`.
- **Fix**: (a) tipar el mock con firma explícita `vi.fn(async (_url: string, init: RequestInit) => ...)` para que `calls[0][1]` exista; (b) `calls[0]!` (non-null) para el primer elemento; (c) en prod, `.split(",")[0]?.trim()` (optional chaining).
- **Aplicar en**: TODO test/código nuevo de chaski-v2 — la flag está activa. Usar optional chaining o `!` deliberado en cada acceso por índice; tipar los `vi.fn` cuyos `.mock.calls` se inspeccionan.
