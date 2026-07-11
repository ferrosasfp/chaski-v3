# Auto-Blindaje — WKH-180 (Autoridad KYC/payout server-side)

### [2026-07-11 03:23] Wave 2 — ctor de `ConfirmAndSend` rompe un test fuera de Scope IN
- **Error**: agregar el 5º arg `authority` al ctor de `ConfirmAndSend` hizo fallar `tsc`
  (TS2554) en `src/application/use-cases.test.ts:43` — un test PRE-EXISTENTE que no estaba
  en el Scope IN del Story File pero también instancia `new ConfirmAndSend(wallet, payout, repo, clock)`.
- **Causa raíz**: el Story File listó `confirm-and-send.test.ts` (net-new) como el único test
  del use-case, pero el repo ya tenía una suite integral del money-path (`use-cases.test.ts`)
  que construye el mismo use-case. Cambiar una firma de ctor ripplea a TODO call-site, no solo
  a los listados.
- **Fix**: edit mínimo — importar `FakePayoutAuthorityGateway` y pasar `new FakePayoutAuthorityGateway()`
  (default `authorized:true`, regresión-neutral) como 5º arg. Cero cambio de comportamiento del test.
- **Aplicar en**: al cambiar una firma de ctor/función pública, `grep` TODOS los call-sites
  (`grep -rn "new ConfirmAndSend"`) — no confiar en que el Scope IN los enumere. Un consumidor
  fuera de scope roto por un cambio de firma es fix obligado (mantener suite previa verde),
  no expansión de scope.

### [2026-07-11 03:22] Wave 2 — import de tipo inexistente en `fakes.ts`
- **Error**: importé `PayoutAuthority` de `../application/ports` — ese símbolo no existe; los
  tipos reales son `PayoutAuthorization` (resultado) y `PayoutAuthorityGateway` (port).
- **Causa raíz**: nombre abreviado de memoria en vez de copiar el identificador exacto del port.
- **Fix**: dejar solo `PayoutAuthorityGateway` + `PayoutAuthorization` en el import.
- **Aplicar en**: copiar los nombres de tipo EXACTOS del archivo fuente (`ports.ts`) al importar;
  no abreviar de memoria.
