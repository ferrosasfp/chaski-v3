# Auto-Blindaje — WKH-205 (F3)

### [2026-07-16 13:00] W1 — rate-limit fail-closed rompe los tests de autoridad preservados
- **Error potencial (evitado)**: al insertar `checkRouteRateLimit` en `validate/route.ts` bajo `if (DIDIT_API_KEY)`, los ~10 tests de autoridad preservados setean `DIDIT_API_KEY="test-key"` pero NO fijan Upstash env → `getLimiters` devuelve `null` → `unavailable:true` → la ruta corta con 503 ANTES de llegar a la autoridad → todos esos tests (Approved/Declined/ownership/PII/502/timeout) fallarían.
- **Causa raíz**: el rate-limit es fail-CLOSED por diseño (CD-4); un test que ejercita la autoridad sin querer ejercitar el rate-limit lo dispara igual porque solo depende de `DIDIT_API_KEY`.
- **Fix**: mockear `checkRouteRateLimit` a `{ ok:true }` por default en el test (vía `vi.mock` + `importOriginal` rest-spread, conservando `clientIp`/`PAYOUT_VALIDATE_RL` reales), y overridearlo solo en AC-4 (`!ok`→429) y AC-6 (`unavailable`→503). El SDD lo autoriza explícitamente ("mockeá checkRouteRateLimit o el @upstash/*").
- **Aplicar en**: `challenge/route.test.ts` (mismo patrón: los tests setean `PAYOUT_POP_SECRET` sin Upstash → mismo mock por default aplicado en W2).

### [2026-07-16 13:45] Mutation self-check — mutante dangling por muerte de sesión
- **Error**: la sesión murió por límite EN MEDIO del mutante 2 (rate-limit fail-closed), dejando `if (rl.unavailable) { /* MUTANT: fail-open, no return */ }` sin restaurar en `validate/route.ts:41` (código de producción con un bug de fail-open live).
- **Causa raíz**: el mutation self-check muta código real; si la sesión se corta entre "mutar" y "restaurar", el mutante queda persistido en disco.
- **Fix**: al reanudar, restaurar el `return 503` fail-closed exacto del contrato SDD §4.1 (ANTES de `if (!rl.ok)`, porque `unavailable` también trae `ok:false`); `grep -rn MUTANT app/ src/` = 0; `npm run qa` verde.
- **Aplicar en**: cualquier mutation-testing manual — hacer los mutantes de a UNO, con backup en scratchpad (se hizo: `validate-route.bak`), y verificar `grep MUTANT` = 0 antes de cerrar la wave. Nunca dejar mutantes vivos entre pasos.
