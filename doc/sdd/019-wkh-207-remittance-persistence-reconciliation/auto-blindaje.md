# Auto-Blindaje — WKH-207 (F3 Dev)

### [2026-07-16] Wave 0 — Extender un port fuerza a TODOS sus callers/implementers en el mismo commit
- **Error**: Agregar `remittanceId: string` (requerido) al input de `PrincipalSettlementGateway.settle`
  en `ports.ts` dejó `tsc` rojo en 3 sitios a la vez: `confirm-and-send.ts` (caller), `http-settlement-gateway.ts`
  (implementer real) y `http-settlement-gateway.test.ts` (7 call-sites vía un `input` compartido).
- **Causa raíz**: un campo REQUERIDO en el input de un método de interfaz no es aditivo para los callers —
  todos deben pasarlo. El Story separaba estos cambios entre W0 y W2.1, pero el gate de W0 (`npm run qa`)
  no pasa hasta cerrar la cascada.
- **Fix**: aplicar en W0 el 1-liner permitido por CD-5 (`remittanceId: s.id` en confirm-and-send) + el body
  aditivo del gateway + `remittanceId` en el `input` fixture del test (arregla los 7 call-sites de una).
- **Aplicar en**: cualquier HU que agregue un campo requerido a un port existente — planificar el caller-fix
  en la MISMA wave que la extensión del contrato, o el gate de esa wave nunca cierra.

### [2026-07-16] Wave 1 — Mock chainable de Supabase: builder thenable + queue por `from()`
- **Error potencial**: mockear el query-builder de supabase-js sin cubrir que la cadena
  `.from().select().in().lt().limit()` se `await`ea al final (y `.single()` en otra rama) llevaría a
  `undefined is not a function` o a resolver el resultado equivocado.
- **Fix**: builder donde cada método devuelve el mismo builder (registrando args) y el builder es
  `thenable` (`then(resolve){ resolve(result) }`); una queue de resultados indexada por cada llamada a
  `from()` cubre el caso de 2 `from()` en `markOutcome` (select attempts + update).
- **Aplicar en**: cualquier test que mockee supabase-js. No usar `mockResolvedValue` sobre el builder —
  hay que hacerlo thenable para que `await builder` funcione en todas las ramas.

### [2026-07-16] Wave 3 — Mutation self-check: fail-open de auth cae a 401, no a 200
- **Observación**: al mutar el guard de "secreto no configurado" (`if (!secret)` → `if (false)`), el request
  sin secreto cae al guard siguiente (mismatch) → 401, no 200. El test que asevera **501** exacto igual
  muere (401 !== 501). Lección: los tests de auth deben asertar el **código exacto** (501 vs 401), no solo
  "no-200" — si no, un fail-open parcial pasaría desapercibido.
- **Mutantes probados y RESTAURADOS** (todos mataron un test, `grep -rn MUTANT app/ src/` = 0 al cerrar):
  1. reconcile: `await fetch()` dentro del loop → mata "R1: 0 llamadas a fetch" (no-doble-pago).
  2. reconcile: `if (!secret)` → `if (false)` → mata "sin secreto ⇒ 501".
  3. factory: quitar el check `SETTLEMENT_LEDGER_ENABLED` → mata "flag OFF ⇒ null" (byte-idéntico).

### [2026-07-16] FIX-PACK — createClient() lanza sincrónicamente fuera del try/catch best-effort (BLQ-MED-1, AR)
- **Error**: `getSupabaseServerClient()` construía `createClient(url, key)` sin guard. `createClient`
  LANZA sincrónicamente ante una `SUPABASE_URL` malformada (ej. `abc.supabase.co` sin scheme — typo de
  deploy). Como se invoca FUERA del try/catch best-effort de las rutas (settle/submit ya broadcastearon/
  forwardearon), con el flag ON + URL mala → 500 crudo → money-path caído. Viola CD-17/AC-10 (el diseño
  promete degradar a `null`, no tumbar el endpoint).
- **Causa raíz**: se asumió que `createClient` no falla si las envs están presentes; en realidad valida la
  URL y tira `Invalid supabaseUrl` con un string sin `http(s)://`. El happy-path (URL válida) escondía el
  camino de error.
- **Fix**: envolver la construcción en try/catch DENTRO de `getSupabaseServerClient()` → `catch { return null }`
  (supabase-server.ts:24-31). Una URL malformada se comporta igual que envs ausentes (null → skip →
  byte-idéntico OFF). NO se loguea url/key (sin PII/secretos). El memo del happy-path se mantiene.
- **Aplicar en**: cualquier factory de cliente (DB/HTTP/SDK) que se invoque fuera del try/catch de la ruta.
  Si el constructor puede tirar ante config malformada, envolvelo y degradá a null — nunca dejes que un
  typo de env tumbe un endpoint que ya ejecutó el side-effect irreversible.
- **Mutante probado y RESTAURADO** (`grep -rn MUTANT app/ src/` = 0 al cerrar): `catch → throw` mata los
  3 tests BLQ-MED-1 (unit `no-throw` + settle-200 + submit-200: ambas rutas propagan `Error: MUTANT` = el
  500 crudo que el fix previene).

### [2026-07-16] FIX-PACK — markOutcome del loop del reconcile sin try/catch por-fila (MNR-2, CR)
- **Error**: `await ledger.markOutcome(...)` dentro del `for` del reconcile NO estaba en try/catch (a
  diferencia de `listStale`). Un DB-throw transitorio en la fila N abortaba el batch → 500 con trabajo parcial.
- **Fix**: try/catch por-fila (reconcile-orphans/route.ts:83-91); las filas que tiran se cuentan en `failed`
  y el endpoint responde 200 con conteo parcial `{ scanned, manualReview, failed }` (antes `{ scanned, manualReview }`).
- **Aplicar en**: cualquier loop de mutaciones best-effort — aislá cada iteración; un fallo transitorio en
  una fila no debe abortar el batch entero. Nota de contrato: el response del reconcile ahora incluye `failed`
  (aditivo, campo nuevo). [STORY-GAP menor] el SDD/Story documenta el shape sin `failed`; actualizar si se re-sincroniza.
