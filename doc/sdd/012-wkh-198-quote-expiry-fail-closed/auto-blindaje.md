# Auto-Blindaje — WKH-198

### [2026-07-14] Wave 1b — El alias `@/domain/remittance` en route.ts rompe la suite vitest
- **Error**: seguí el Story File al pie (`import { isParseableIso } from "@/domain/remittance";`
  en `app/api/a2a/quote/route.ts`). `npm run typecheck` y `next build` pasaron, pero `vitest run`
  falló al CARGAR `app/api/a2a/quote/route.test.ts`: `Error: Failed to load url @/domain/remittance`.
- **Causa raíz**: no hay `vitest.config.*` ni `vite-tsconfig-paths` en el repo → vitest NO resuelve el
  alias `@/* → ./src/*` del tsconfig (ese path sólo lo entienden `tsc` y `next build`). El Story File
  verificó el alias en `tsconfig.json` pero NO contra el test-runner. `@/` sólo se usa hoy en
  `app/page.tsx` (sin test colocado); TODOS los `app/api/**/route.ts` con `.test.ts` colocado importan
  de `src/` por ruta RELATIVA (`../../../../src/...`).
- **Fix**: usé la ruta relativa que ya usan los hermanos con la MISMA profundidad
  (`app/api/kyc/decision/route.ts`, `app/api/payout/validate/route.ts`):
  `import { isParseableIso } from "../../../../src/domain/remittance";`. Mismo helper, misma
  semántica, sólo se tocó route.ts (Scope IN). Suite completa vuelve a verde.
- **Aplicar en**: cualquier `import` NUEVO desde `app/api/**/route.ts` hacia `src/` cuando el route
  tiene `.test.ts` colocado corrido por vitest → usar ruta RELATIVA, no `@/`, hasta que exista
  `vite-tsconfig-paths` en la config de vitest.
