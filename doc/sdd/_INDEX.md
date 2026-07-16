# Chaski v2 — SDD Index

| HU | Título | Estado | Path |
|----|--------|--------|------|
| WKH-178 | [P0 demo-safe] Chaski v2: recibo real + "Modo demo" + KYC timeout/reset | DONE (2026-07-10) | `doc/sdd/001-wkh-178-demo-safe-fixes/done-report.md` |
| WKH-179 | [P0 seguridad] Chaski v2: cerrar IDOR PII + auth/rate-limit en /api/kyc/* | DONE (2026-07-10) | `doc/sdd/002-wkh-179-kyc-idor-auth-ratelimit/done-report.md` |
| WKH-180 | [P1 seguridad] Chaski v2: autoridad KYC/payout server-side (no confiar en gate client-side) | DONE (2026-07-11) | `doc/sdd/003-wkh-180-payout-authority-server-side/done-report.md` |
| WKH-181 | [P1] No persistir PII cruda + historial por-wallet + riskLevel AML | DONE (2026-07-11) | `doc/sdd/004-wkh-181-pii-persistence-history-per-wallet/done-report.md` |
| WKH-182 | [P2 money-path robustez] Validación de dominio del quote, lock optimista, chain configurable y monto lockeado al payout | DONE (2026-07-11) | `doc/sdd/005-wkh-182-money-path-robustez/done-report.md` |
| WKH-183 | [P3 higiene] pending-store huérfano, copy de errores, FX/Money, drift env | DONE (2026-07-11) | `doc/sdd/006-wkh-183-higiene-menores/done-report.md` |
| WKH-184 | [Residual AC-8 WKH-181] Reset explícito de KYC-once + señal soft de FallbackWallet (Opción D) | DONE (2026-07-11) | `doc/sdd/007-wkh-184-fallback-wallet-reset-demo-signal/done-report.md` |
| WKH-185 | [Deuda técnica] Component test harness (jsdom + RTL) + backfill de ACs de UI sin RTL (178/181/184) | DONE (2026-07-11) | `doc/sdd/008-wkh-185-component-test-harness-backfill/done-report.md` |
| WKH-186 | [Técnico, porción de WKH-168] Value-delivery scaffolding: adapter a2a (mock/off), reconciliación + idempotencia, refund-on-failure, EIP-3009-ready | DONE (2026-07-11) | `doc/sdd/009-wkh-186-value-delivery-scaffolding/done-report.md` |
| WKH-187 | [Money-path/UX] Reordenar el flujo: mostrar el quote (valor) antes del KYC | DONE (2026-07-12) | `doc/sdd/010-wkh-187-quote-before-kyc-reorder/done-report.md` |
| WKH-188 | [Bug UX, KYC resume] Escape visible + timeout más corto en el resume de KYC abandonado | DONE (2026-07-12) | `doc/sdd/011-wkh-188-kyc-resume-escape/done-report.md` |
| WKH-198 | [Hallazgo A, auditoría adversarial #2] Fail-closed en expiry de quote — guard NaN + validación de shape de fecha | DONE (2026-07-14) | `doc/sdd/012-wkh-198-quote-expiry-fail-closed/done-report.md` |
| WKH-199 | [Hallazgo B, auditoría adversarial #2] KYC re-brick — `KycStore.save()` best-effort + reorder critical-write-first | DONE (2026-07-14) | `doc/sdd/013-wkh-199-kyc-store-save-best-effort/done-report.md` |
| WKH-200 | [Hallazgo C, auditoría adversarial #2] Estados honestos en TrackView + banner demo cubre payout-mock (provenance propagada) | DONE (2026-07-14) | `doc/sdd/014-wkh-200-track-honesty-payout-mock-banner/done-report.md` |
| WKH-201 | [Hallazgo D, auditoría adversarial #2] `forgetAndDisconnect` purga PII persistida via `clearByOwner` best-effort | DONE (2026-07-14) | `doc/sdd/014-wkh-201-forget-disconnect-purge-persisted-pii/done-report.md` |
| WKH-202 | [GATE Fase A] Hardening del enforcement de `/api/a2a/payout/submit` (auth + re-validación KYC/ownership server-side) | DONE (2026-07-15) | `doc/sdd/015-wkh-202-payout-submit-hardening/done-report.md` |
| WKH-168 | [GATE Fase A / G3, Mitad A] Principal-in real: settle on-chain verificado (broadcast + receipt + monto/receiver) antes de `principal_in`, reusando `wasiai-facilitator` | DONE (2026-07-15) | `doc/sdd/016-wkh-168-principal-in-real-settlement/done-report.md` |
| WKH-206 | [GATE Fase A / G5, último hueco] Proof-of-possession (SIWE/EIP-4361) para el `address` del payout — el caller debe probar criptográficamente que controla la private key, no solo pasar el string | DONE (2026-07-16) | `doc/sdd/017-wkh-206-payout-proof-of-possession/report.md` |

## Notas de coordinación
- WKH-178 y WKH-179 corren en paralelo, ambas del mismo repo (`chaski-v2`) y de la misma auditoría
  adversarial 2026-07-10. `doc/sdd/001-wkh-179-kyc-idor-auth-ratelimit/` es un directorio obsoleto
  (colisión de NNN detectada durante F1 de WKH-179, renumerado a `002`) — no usar, solo contiene un
  stub que apunta al path correcto.
- Ambas HUs pueden tocar `chaski-v2/src/infrastructure/didit/*` y/o el flujo de KYC
  (`kyc-pending-store.ts`, `kyc-gateway.ts`) — coordinar orden de merge entre Architects/Devs antes
  de F3.
- WKH-180 es parte del mismo backlog de auditoría 2026-07-10 (hallazgo A1, seguimiento post
  WKH-178/179). Bloquea a **WKH-168** (desembolso real): el `PayoutGateway` real no debería
  mergearse sin el gate de autoridad server-side de WKH-180 ya instalado. Coordina NNN con
  WKH-181 (analyst paralelo) — WKH-180 usa `003`, WKH-181 usa `004` (confirmado, sin colisión).
- WKH-180 toca `confirm-and-send.ts`, `ports.ts`, `container.ts` y `src/infrastructure/didit/*` —
  mismo riesgo de colisión de merge que WKH-178/179; coordinar con cualquier otra HU del backlog
  180-183 que toque los mismos archivos antes de F3.
- WKH-181 corre en paralelo con WKH-180 (misma auditoría 2026-07-10, mismo repo). Ambas HUs pueden
  tocar `chaski-v2/src/infrastructure/didit/decision.ts`, `persistence.ts`, `kyc-store.ts`,
  `ports.ts` y `container.ts` — coordinar orden de merge entre Architects/Devs antes de F3. WKH-181
  trabaja sobre el estado ya mergeado de WKH-178/WKH-179 (`main`); no reabre esos gaps, agrega una
  capa nueva (reducción de PII en el límite cliente→localStorage + ownership por wallet +
  riskLevel extensible). WKH-181 tiene 2 `[NEEDS CLARIFICATION]` bloqueantes para F2 que requieren
  confirmación humana antes de que el Architect pueda cerrar el SDD: (1) si persistir nombre
  completo cuenta como "PII cruda" (AC-3/DT-1 — la lectura literal de la HU rompe el render del
  Review); (2) si el fix de `FallbackWallet` (address hardcodeada compartida por TODOS los
  usuarios sin wallet real — causa raíz más probable del bug "María Elena vieja") es AC obligatoria
  de esta HU (AC-8/DT-2) o se defiere a otra HU. Ver
  `doc/sdd/004-wkh-181-pii-persistence-history-per-wallet/work-item.md` sección Missing Inputs.
- WKH-182 (F1, 2026-07-11) es parte del mismo backlog de auditoría 2026-07-10 (hallazgos A5/A6 y
  M1-M4), trabajando sobre el estado ya mergeado de WKH-178/179/180/181 (`main`). NNN coordinado
  con WKH-183 (analyst paralelo, mismo backlog) — WKH-182 usa `005`. Toca `remittance.ts`,
  `confirm-and-send.ts`, `ports.ts`, `persistence.ts`, `wallet.ts` y
  `fallback/gateways.ts` — mismo riesgo de colisión de merge que HUs previas del backlog; coordinar
  orden de merge con WKH-183 antes de F3. Bloquea parcialmente a WKH-168 (desembolso real): el
  `PayoutGateway` real debería asumir que `PayoutSubmit` YA incluye `expectedReceivePen` (AC-6) —
  orden sugerido WKH-182 antes que WKH-168. Tiene 3 `[NEEDS CLARIFICATION]` para F2: (1) chainId
  default (43114 mainnet vs 43113 Fuji) — BLOQUEANTE, coordinar con la config de REOWN/Vercel ya
  en 43114; (2) tolerancia exacta de la validación receive/send/fee/rate; (3) forma exacta del
  contrato de CAS en `RemittanceRepository.save()`. Ver
  `doc/sdd/005-wkh-182-money-path-robustez/work-item.md` sección Missing Inputs.
- WKH-183 (F1, `006`) es la 2ª mitad del backlog de higiene P3 de la misma auditoría 2026-07-10,
  coordinada en paralelo con WKH-182 (analyst paralelo, NNN `005`) — ambas trabajan sobre el
  estado ya mergeado de WKH-178/179/180/181 (`main`). El F0 de WKH-183 descartó 2 de los 8
  hallazgos originales del ticket por estar YA resueltos como efecto colateral de WKH-178
  ("test fake miente") y WKH-181 ("schema migration / `.slice` crash en `flow.tsx`" — resuelto por
  `toPersistedIdentity`/`documentNumberLast4` + el manejo defensivo de legacy en
  `persistence.ts`/`kyc-store.ts`). De los 6 ítems vivos, el único BLOQUEANTE es un bug real
  confirmado en F0 (no solo higiene cosmética): `kyc-pending-store.ts` sin try/catch puede dejar
  una remesa persistida en `kyc_pending` sin ningún `KycPending` correlacionable si
  `localStorage.setItem` falla — la remesa queda bricked (ni retry ni resume funcionan, porque
  `kyc_pending → kyc_pending` no es una transición válida del dominio). Fix recomendado (DT-1, sin
  tocar el dominio): reordenar `pending.save()` antes de `repo.save(r)` en `start-kyc.ts`.
  **Overlap con WKH-182**: ambas HUs tocan `chaski-v2/src/infrastructure/fallback/gateways.ts`
  (WKH-183: comentario en `FallbackKycGateway` + quitar doble redondeo en
  `FallbackQuoteGateway.requestQuote`; WKH-182: hallazgos A5/A6/M1-M4 sobre el mismo archivo según
  su nota arriba) — coordinar orden de merge entre Architects/Devs antes de F3 para evitar
  conflicto. Sin overlap detectado en `wallet.ts` (WKH-183 no lo toca directamente, solo
  `flow.tsx`'s `humanError()` que consume los códigos que `wallet.ts` ya lanza hoy). Ver
  `doc/sdd/006-wkh-183-higiene-menores/work-item.md` para el detalle completo (grounding, ACs,
  DT-N, CD-N).
- **WKH-184 (DONE, 2026-07-11)**: cierra formalmente el residual AC-8 diferido de WKH-181. Opción D
  confirmada (reset manual + señal soft de `FallbackWallet`, sin pseudo-address ni hard-require).
  9/9 ACs PASS, 10/10 CDs cumplidas, pipeline QUALITY completo (F0→F1→F2→F2.5→F3→AR→CR→F4).
  Fix-pack post-CR (MNR-1 + MNR-2) aplicado y verificado. Listo para merge. Ver
  `doc/sdd/007-wkh-184-fallback-wallet-reset-demo-signal/done-report.md`.
- **WKH-185 (F1, 2026-07-11, `008`)**: deuda técnica pura, distinta al backlog de auditoría
  178-184 (no encontró bugs, agrega infraestructura de testing). Trabaja sobre el estado ya
  mergeado de WKH-178..184 (`main`). Backfillea, con evidencia RTL, exactamente los ACs marcados
  "sin RTL"/"code review (sin RTL)" en los `f4-report.md` ya escritos de WKH-178 (AC-8), WKH-181
  (AC-3/AC-13) y WKH-184 (AC-4, AC-6, fix-pack MNR-1) — lista cerrada, ver work-item DT-5. Toca
  `src/presentation/flow.tsx` con **un único cambio de código de producción**: un prop opcional
  `container?: Container` para poder inyectar fakes desde tests (default preserva el
  comportamiento actual byte-a-byte — único caller real, `app/page.tsx`, no pasa props). No crea
  `vitest.config.ts`: usa el docblock per-file `// @vitest-environment jsdom`, sin tocar el
  entorno `node` default de los 14 tests existentes. Sin bloqueantes para F2. Ver
  `doc/sdd/008-wkh-185-component-test-harness-backfill/work-item.md`.
- **WKH-186 (DONE, 2026-07-11, `009`)**: porción TÉCNICA de WKH-168 (desembolso real), SIN depender
  del partner/sandbox TransFi — scaffolding completo de value-delivery con TODO mock/apagado por
  default (cero movimiento de dinero real, verificado en 6 capas independientes CD-2). Trabaja sobre
  el estado ya mergeado de WKH-178..185 (`main`). 4 piezas
  IMPLEMENTADAS: (1) adapter `src/infrastructure/a2a/` que llama directo (server-side, DT-1) a los
  agentes live `remit-corridor-fx`/`remit-cashout-payout` del repo `wasiai-remittance-agents`,
  detrás de flag `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` (default `fallback`); (2) reconciliación
  (deliveredPen vs expectedReceivePen, misma tolerancia que `assertReceiveConsistent`) + idempotencia
  end-to-end (`idempotencyKey` intacto); (3) **gap real cerrado**: refund-on-failure (nadie llamaba
  `markRefunded()` antes, remesas quedaban huérfanas en `payout_failed`) con `LedgerRefundGateway`
  ledger-only (CD-8, gap de clawback on-chain real diferido a Fase A); (4) EIP-3009-ready:
  `wallet.ts` rama `signTypedData` `transferWithAuthorization` (default `false`, fail-loud si se
  enciende sin conditions CD-3/CD-4). Pipeline QUALITY completo: 14/14 ACs PASS, 17/17 CDs ✅,
  0 BLOQUEANTES, 4 MENORs fixeados (MNR-A receiver validation, MNR-B cache-miss status, MNR-C shape
  align, MNR-D try/catch), 223/223 tests verdes, build OK, CD-2 money-path verificada 6 capas.
  Runbook Fase A documentado en `done-report.md` §8. Ver `doc/sdd/009-wkh-186-value-delivery-scaffolding/done-report.md`.
- **WKH-187 (DONE, 2026-07-12, `010`)**: reorden money-path/UX puro — mostrar el quote lockeado apenas
  se conecta la wallet, pedir el KYC recién cuando el usuario confirma que quiere enviar. Trabaja
  sobre el estado ya mergeado de WKH-178..186 (`main`). El gate de compliance (`confirm_requires_kyc_passed`,
  `remittance.ts` L219-222) y la autoridad server-side de payout (WKH-180) quedan explícitamente
  FUERA de scope de modificación (AC-3/AC-7, CD-2/CD-3) — el reorden es solo de CUÁNDO se pide cada cosa
  en la UI y qué transiciones de la FSM son alcanzables entre sí, no de QUÉ invariantes se verifican.
  Implementación (commit `e5155e2`): único cambio de dominio es `TRANSITIONS` (L83-99 reescrito,
  3 transiciones nuevas con razones de negocio inline). `confirm()`, `applyKyc()`, `attachQuote()`
  byte-idénticos. UI: `Step` nuevo (`"confirm"` / `"review"` pre-KYC), `onConnect` (lockQuote movido),
  `onContinue` (navegación pura), resume auto-requote condicional (DT-3). Tests: 9 archivos, 235/235
  verdes, 9/9 ACs PASS, 0 BLQ/0 MENOR en AR/CR. Auto-blindaje: 3 lecciones para reordenes de FSM
  (exhaustividad de tests, precondición de estado en I/O, tiempo real en RTL). Ver
  `doc/sdd/010-wkh-187-quote-before-kyc-reorder/done-report.md`.
- **WKH-188 (DONE, 2026-07-12, `011`)**: bug reportado por el founder en móvil — al abandonar una
  sesión de Didit a mitad de camino (botón "atrás" del navegador), el usuario queda ~100s
  (40×2500ms) en el overlay "Verificando tu identidad…" sin ningún control de salida antes del
  timeout completo (`flow.tsx` L92-154/L369-378), percibido como colgado. Trabaja sobre el estado
  ya mergeado de WKH-178..187 (`main`). Fix acotado de UX del resume-loop: (1) escape visible antes
  del timeout completo, reusando `AbandonPendingKyc` ya existente (WKH-178); (2) timeout total
  acortado de ~100s a ~25-30s. El gate `confirm_requires_kyc_passed` y la autoridad server-side de
  payout (WKH-180) quedan explícitamente FUERA de scope (AC-4, CD-1/CD-3) — es un fix de timing/UI,
  no de las invariantes de negocio. Hallazgo del F0: `decision.ts` YA mapea
  `"Abandoned"/"Expired"/"Kyc Expired"` como terminal (L26) — el punto 4 del objetivo del founder
  (fail-fast si Didit expone un estado explícito de abandono) está mayormente cubierto por código
  existente; queda 1 `[NEEDS CLARIFICATION]` NO bloqueante sobre si Didit transiciona ese status de
  forma síncrona al abandono o solo tras su propio TTL — no bloquea el fix principal (escape +
  timeout corto). Toca únicamente `src/presentation/flow.tsx` (+ tests en `flow.test.tsx`, reusa el
  patrón de fake timers `T3` de WKH-178/CD-10). Sin colisión de merge esperada (última HU en tocar
  `flow.tsx` fue WKH-187, ya mergeada). Ver
  `doc/sdd/011-wkh-188-kyc-resume-escape/done-report.md`.
- **WKH-198 (F1, 2026-07-14, `012`)**: hallazgo A de la 2ª auditoría adversarial de `chaski-v2`,
  distinto al backlog 178-188 (auditoría nueva). Trabaja sobre el estado ya mergeado de
  WKH-178..188 (`main`). Bug de integridad money-path confirmado en F0: `isQuoteExpired`
  (`remittance.ts:257-259`) usa `new Date(expiresAt).getTime() <= new Date(nowIso).getTime()` sin
  guard de `NaN` — un `expiresAt` no-fecha (agente malicioso/roto, tampering de `localStorage`)
  hace que la comparación `NaN <= x` sea `false` en JS, y el quote **nunca vence** (fail-open, no
  fail-closed). En modo EIP-3009 real (flag OFF por default, WKH-186), el mismo dato malformado
  produce `BigInt(NaN)` en `wallet.ts:75`/`:189` → `RangeError` sin catch al firmar, remesa
  atascada en `confirmed` sin refund. Fix quirúrgico en 3 capas: (1) guard `Number.isNaN(...)`
  fail-closed en `isQuoteExpired` (dominio, defensa de último recurso); (2) rechazo de shape en el
  borde — `isValidQuoteShape` (`src/infrastructure/a2a/gateways.ts:42-53`) e `isValidQuoteResult`
  (`app/api/a2a/quote/route.ts:12-23`), ambos hoy solo validan `typeof expiresAt === "string"` sin
  parseabilidad; (3) guard defensivo en `wallet.ts` antes de `BigInt(Math.floor(Date.parse(...) /
  1000))`, fail LOUD (no silencioso). Scope OUT explícito: el enforcement del submit/autoridad
  server-side de payout es **WKH-202** (hallazgo relacionado, otra HU), no se toca acá; tampoco
  `FallbackQuoteGateway` (genera `expiresAt` siempre válido, no es vector). 2 `[TBD]` NO
  bloqueantes para F2 (mecanismo exacto del guard en `wallet.ts`: reusar función del dominio vs.
  duplicar chequeo local; si crear test-file dedicado para `quote/route.ts` que hoy no existe). Sin
  colisión de merge esperada — toca `remittance.ts`/`wallet.ts`/`gateways.ts`/`quote/route.ts`,
  mismos archivos que WKH-182/186/187 (todas DONE y mergeadas). Ver
  `doc/sdd/012-wkh-198-quote-expiry-fail-closed/work-item.md`.
- **WKH-199 (F1, 2026-07-14, `013`, renumerado)**: hallazgo B de la misma 2ª auditoría adversarial
  (paralelo a WKH-198). `012` fue tomado primero por WKH-198 (colisión de NNN detectada durante F1
  de WKH-199); `doc/sdd/012-wkh-199-kyc-store-save-best-effort/` quedó como stub obsoleto que
  apunta al path correcto (mismo patrón que la colisión histórica WKH-178/179). Trabaja sobre el
  estado ya mergeado de WKH-178..188 (`main`). Reincidencia confirmada en F0 de la MISMA clase de
  bug que WKH-183 cerró para `kyc-pending-store.ts` ("write no-crítico bloquea el crítico"), ahora
  en el cache de KYC-once: `KycStore.save()` (`kyc-store.ts:97-106`) NO tiene try/catch (a
  diferencia de `clear()`, `:118-122`), y se llama ANTES de `applyKyc()`+`repo.save()` tanto en
  `resume-kyc.ts:47` como en la rama `"completed"` de `start-kyc.ts:51-57` — si `setItem` lanza, un
  KYC YA APROBADO nunca se persiste y el resume-loop de `flow.tsx` (`catch { break }`, L109-113) cae
  al timeout. Fix: try/catch best-effort en `save()` (simétrico a `clear()`) + reorden del write
  no-crítico después del crítico en ambos use-cases, mismo patrón exacto que WKH-183 ya estableció
  en la rama `redirect` de `start-kyc.ts`. Sin `[NEEDS CLARIFICATION]` bloqueantes. **Sin overlap de
  archivos con WKH-198** (WKH-198 toca `remittance.ts`/`wallet.ts`/`gateways.ts`/`quote/route.ts`;
  WKH-199 toca `kyc-store.ts`/`resume-kyc.ts`/`start-kyc.ts`/`test-support/fakes.ts`) — ambas pueden
  avanzar F2/F3 sin coordinar orden de merge. Ver
  `doc/sdd/013-wkh-199-kyc-store-save-best-effort/work-item.md`.
- **WKH-200 (F1, 2026-07-14, `014`, renumerado DOS veces)**: hallazgo C de la misma 2ª auditoría
  adversarial, en paralelo con WKH-198/199/201 (mismo batch de analysts corriendo simultáneamente
  sobre `chaski-v2`). **Doble colisión de NNN**: WKH-200 probó `012` (ya tomado por WKH-198) → `013`
  (tomado casi simultáneamente por WKH-199) → se asentó en `014`. `doc/sdd/012-wkh-200-.../` y
  `doc/sdd/013-wkh-200-.../` quedaron como stubs obsoletos que apuntan acá (mismo patrón que la
  colisión histórica WKH-178/179). **Comparte prefijo `014` con WKH-201** (`014-wkh-201-...`, distinto
  nombre de carpeta) — sin colisión real de filesystem, rompe la convención de NNN único; se decide
  NO re-renumerar de nuevo (evitar una tercera cascada) y dejarlo documentado acá, mismo criterio ya
  aplicado al soft-share `013` entre WKH-199/200 antes de esta corrección. Trabaja sobre el estado ya
  mergeado de WKH-178..188 (`main`). Bug de honestidad de estado + demo confirmado en F0: `TrackView`
  (`flow.tsx:722-767`) trata `payout_failed`/`refunded` como "no reconocido" (`order.indexOf` = `-1`)
  → muestra "Tu chaski está en camino…" para siempre, sin ninguna rama de error, aunque el copy de
  reembolso ya existe (`humanError`, `flow-vm.ts:33`). `payout_failed` NO está en `TERMINAL_STATUSES`
  (`remittance.ts:99`) → el polling de `flow.tsx:325-345` (1.5s) nunca se detiene si el refund
  automático falla y la remesa queda congelada en `payout_failed`. Además `isDemoMode`
  (`flow-vm.ts:6-8`) solo mira `quote.provenance`/`kyc.provenance`, nunca la provenance del
  **payout** — `PayoutRecord` (`ports.ts:71-77`) ni siquiera tiene ese campo, aunque el shape crudo
  del agente sí lo trae (`RawPayoutResult.provenance`, `gateways.ts:34`) y se descarta en
  `mapResultToPayoutRecord` (`gateways.ts:83-91`) — con adapter `a2a` real + Didit real +
  `PAYOUT_ALLOW_MOCK`, el recibo final ("Entregado") no muestra ningún aviso de modo demo. Fix en 3
  capas: (1) branch dedicado en `TrackView` para `payout_failed`/`refunded` (AC-1); (2) parar el
  polling explícitamente en `payout_failed`, sin tocar `TERMINAL_STATUSES` del dominio (AC-2, CD-1);
  (3) propagar `provenance` del payout hasta `RemittanceState` (`payoutProvenance`, DT-1) e incluirla
  en `isDemoMode` (AC-3), + cerrar el gap del banner en `step === "verify"` (AC-4). Scope OUT
  explícito: WKH-202 (enforcement del submit), la lógica de CUÁNDO se refunda (solo la presentación
  del estado ya alcanzado), y el repo externo `wasiai-remittance-agents`. 1
  `[NEEDS CLARIFICATION]` NO bloqueante: el string exacto de `provenance` que devuelve
  `remit-cashout-payout` en modo `PAYOUT_ALLOW_MOCK` (resoluble en F2 leyendo el repo hermano).
  Riesgo de colisión de MERGE (no de NNN) con WKH-198 si ambas tocan `flow.tsx` en simultáneo —
  coordinar orden de merge entre Architects/Devs antes de F3. Sin overlap de archivos con WKH-199
  (toca `kyc-store.ts`/`resume-kyc.ts`/`start-kyc.ts`, ninguno en el Scope IN de esta HU). Overlap con
  WKH-201 no verificado (ambas trabajan sobre `chaski-v2`, pero WKH-201 toca
  `ports.ts`/`persistence.ts`/`forget-kyc.ts`/`container.ts`/`test-support/fakes.ts` — sin
  intersección directa con el Scope IN de esta HU salvo, potencialmente, `container.ts` si ambas lo
  tocan; coordinar con el Architect en F2 si aparece). Ver
  `doc/sdd/014-wkh-200-track-honesty-payout-mock-banner/work-item.md`.
- **WKH-201 (F1, 2026-07-14, `014`)**: hallazgo D de la 2ª auditoría adversarial de `chaski-v2`,
  analyst paralelo de WKH-198/199/200 (mismo backlog de auditoría, work-items escritos en
  simultáneo). **Doble colisión de NNN**: primer intento `012` (ya tomado por WKH-198), segundo
  intento `013` (tomado en simultáneo por WKH-199 y WKH-200) — renumerado finalmente a `014`. Stubs
  obsoletos en `doc/sdd/012-wkh-201-.../work-item.md` y `doc/sdd/013-wkh-201-.../work-item.md`, ambos
  apuntando al path correcto. Trabaja sobre el estado ya mergeado de WKH-178..188 (`main`). Completa
  el reset de WKH-184: `ForgetKyc` (`forget-kyc.ts:11-22`) y `forgetAndDisconnect` (`flow.tsx:300-319`)
  hoy solo limpian el KYC-once (`KycStore`) + el pending + el estado React in-memory — el repo
  persistido `chaski.remittances.v1` (`LocalRepo`, `persistence.ts`) NO se toca, y retiene
  `beneficiary.name`/`beneficiary.destination` + la identity reducida del sender de la Persona A tras
  el reset. `list()` ya filtra por `ownerAddress` (mitigante de UI, `persistence.ts:114-121`), así
  que la Persona B no lo ve en el historial, pero la PII sigue legible en `localStorage` en el mismo
  dispositivo/origen (devtools, XSS). Fix: método nuevo `clearByOwner(address)` en
  `RemittanceRepository`/`LocalRepo`, cableado como tercer argumento best-effort de `ForgetKyc`
  (DT-1/DT-2), sin tocar el filtrado owner-scoped de `list()`. Toca `ports.ts`, `persistence.ts`,
  `forget-kyc.ts`, `container.ts`, `test-support/fakes.ts` — mismos archivos tocados por
  WKH-181/182/184/186 (todas ya en `main`); sin overlap directo detectado hoy con WKH-198
  (`remittance.ts`/`wallet.ts`/`gateways.ts`/`quote/route.ts`) ni WKH-199
  (`kyc-store.ts`/`resume-kyc.ts`/`start-kyc.ts`). Overlap con WKH-200 acotado a `container.ts` (ver
  nota de WKH-200 arriba) — coordinar con el Architect si aparece en F2. Autocontenida, no
  bloquea ni es bloqueada por otra HU del backlog. Ver
  `doc/sdd/014-wkh-201-forget-disconnect-purge-persisted-pii/work-item.md`.
- **WKH-202 (F1, 2026-07-15, `015`)**: gate de la Fase A del plan de remesa real — hallazgo de la
  auditoría adversarial #2 (relacionado a WKH-198/200 pero separado, ver notas de ambas arriba).
  Trabaja sobre el estado ya mergeado de WKH-178..201 (`main`). NNN pre-asignado `015` por el
  orquestador (sin colisión — lección aplicada de la carrera de 4 analysts que generó WKH-198/199/
  200/201). F0 confirmó el hallazgo central: `app/api/a2a/payout/submit/route.ts` (L1-52) forwardea
  `amountUsd`/`beneficiary`/`kycVerificationId` verbatim sin NINGUNA autorización — inofensivo hoy
  solo porque `REMIT_AGENTS_BASE_URL` no está seteada (guard 501 fail-closed, L32). Hallazgo NUEVO no
  anticipado por el ticket original: `PayoutSubmit` (`ports.ts:63-70`) NO incluye `address`, así que
  hoy es estructuralmente imposible re-validar ownership dentro de esa ruta sin extender el
  contrato primero (DT-2). También confirmado: NO hay persistencia server-side de quotes/remesas
  (arquitectura localStorage-only) → la integridad de monto/beneficiario contra "una remesa real"
  no es 100% verificable sin agregar infraestructura nueva — `[NEEDS CLARIFICATION]` BLOQUEANTE
  (DT-3) que el Architect debe resolver con el humano antes de cerrar el SDD en F2 (alcance:
  ¿KYC+ownership alcanza, o se requiere un quote registry server-side nuevo?). Exemplars
  reusables confirmados en disco: `app/api/payout/validate/route.ts` (WKH-180, autoridad
  server-side) y `kyc-auth.ts`/`app/api/kyc/decision/route.ts` (WKH-179, patrón de token HMAC).
  `app/api/a2a/payout/submit/route.test.ts` YA EXISTE (7 tests de WKH-186, ninguno cubre auth) —
  se EXTIENDE, no se crea. Toca `route.ts`/`route.test.ts`, `ports.ts`, `gateways.ts` (a2a),
  `confirm-and-send.ts` — mismos archivos que WKH-180/182/186/187/198/200 (todas ya en `main`), sin
  overlap con ninguna HU abierta (no hay otras HUs abiertas en `chaski-v2` ahora mismo). Sizing
  QUALITY (override esperado del orquestador, ya alineado): money-path + auth. Ver
  `doc/sdd/015-wkh-202-payout-submit-hardening/work-item.md` para el detalle completo (grounding,
  ACs, DT-N, CD-N, Missing Inputs).
- **WKH-168 (F1, 2026-07-15, `016`)**: gate G3 de la Fase A ("el único de los 5 huecos que verifica
  que el DINERO existe") — se parte en 2 mitades, esta HU es SOLO la Mitad A (settle on-chain
  real, NO bloqueada por TransFi). Trabaja sobre el estado ya mergeado de WKH-178..202 (`main`).
  F0 confirmó el bug de fondo: `authorizePrincipal` (`wallet.ts:78`/`:193`) produce una FIRMA
  EIP-712, nunca una transacción transmitida — 0 ocurrencias de `waitForTransactionReceipt` en todo
  el repo — así que `confirm-and-send.ts:85-86` marca `principal_in` sobre una firma, no sobre
  dinero confirmado. **Hallazgo clave de F0**: `wasiai-facilitator` (repo hermano) YA tiene un
  adapter Avalanche real y auditado (`src/chains/avalanche.ts`, `avalancheFujiAdapter`/
  `avalancheMainnetAdapter`, "WFAC-52 delivered full real EIP-3009 settle + verify against Fuji
  RPC") que coincide EXACTO con las chains que `chaski-v2` ya soporta (43113/43114) — veredicto:
  **reusar ese `/settle` auditado, no escribir un relayer nuevo** (DT-1, CD-5). Segundo hallazgo:
  el problema de "remesa huérfana" (browser cerrado entre `principal_in` y terminal) NO se cierra
  solo moviendo `localStorage` a una DB — requiere TAMBIÉN un mecanismo de reconciliación
  server-side, porque la orquestación de `ConfirmAndSend.execute()` corre client-side hoy (DT-2) —
  se documentan 3 opciones de persistencia (Upstash ya cableado / Supabase de `wasiai-a2a` /
  Supabase propio) SIN decidir, y se **recomienda SPLIT**: esta HU queda acotada a
  settle+verificación (monto/receiver antes de `markPrincipalIn`, tamaño L), y la persistencia +
  reconciliación de huérfanos se registra como HU de seguimiento aparte (candidata L/XL, NNN
  sugerido siguiente libre, ej. WKH-207 — NO creada todavía, requiere aprobación humana del split).
  9 ACs EARS (incluye AC-6 nuevo: honestidad sobre que `LedgerRefundGateway` es ledger-only y deja
  de ser inofensivo una vez que el principal se mueve de verdad). Scope OUT explícito: Mitad B
  (TransFi), clawback real, persistencia server-side, G5/WKH-206, WKH-205, y modificar código de
  `wasiai-facilitator`/`wasiai-a2a` (se consumen solo como servicios HTTP). Toca
  `confirm-and-send.ts`, `wallet.ts`, `ports.ts`, `container.ts`, `ledger-refund-gateway.ts` — mismos
  archivos que WKH-180/186/198/202 (todas ya en `main`); sin otras HUs activas en `chaski-v2` en
  este momento. Sizing QUALITY (override del orquestador esperado y ya alineado): money-path +
  posible cambio arquitectónico. Missing Inputs: 2 `[NEEDS CLARIFICATION]` NO bloqueantes sobre el
  deploy corriente del facilitador (RPC Fuji fondeada, `FACILITATOR_API_KEY` propio o compartido) +
  1 BLOQUEANTE para la HU de seguimiento (cuál opción de persistencia, requiere decisión humana) +
  `[SIN PRODUCT CONTEXT]` (no existe `product-context.md`, contexto de negocio asumido del
  orquestador). Ver `doc/sdd/016-wkh-168-principal-in-real-settlement/work-item.md` para el detalle
  completo (grounding, ACs, DT-N, CD-N, Missing Inputs).
- **WKH-206 (F1, 2026-07-16, `017`, NNN pre-asignado sin colisión)**: G5, el ÚLTIMO de los 5 huecos
  del gate de Fase A — proof-of-possession (SIWE/EIP-4361) del `address` que pide el payout. Trabaja
  sobre el estado ya mergeado (o en curso, ver hallazgo de coordinación abajo) de WKH-178..168
  (`main`). **Hallazgo central de F0, cambia el análisis de riesgo del ticket original**: el código de
  WKH-168 (ya presente en `submit/route.ts` L113-201 y `confirm-and-send.ts` L115-189) YA cierra la
  mayor parte del gap para el ÚNICO camino que hoy mueve dinero real — cuando
  `NEXT_PUBLIC_EIP3009_ENABLED=true`, la firma EIP-712 `transferWithAuthorization`
  (`wallet.ts:79-132/213-264`) es verificada por el CONTRATO USDC mismo antes de mover fondos, y esa
  verificación on-chain se propaga hasta el guard A7 de `submit/route.ts` (L156-160,
  `att.from === address`) — un atacante NO puede lograr que `att.from` sea la address de la víctima
  sin controlar su private key. El gap SIGUE siendo real y explotable en 3 configuraciones concretas
  documentadas en el work-item: (1) `/api/payout/validate` (endpoint advisory, usa el ownership check
  de WKH-202 en solitario, sin atestación); (2) cualquier money-rail futuro (ej. TransFi/Mitad B,
  WKH-172) que no reuse la composición exacta settle→verify→attest de WKH-168; (3) local/CI donde el
  gate de atestación entero se saltea por diseño (A1). 7 ACs EARS. DT-1 (endpoint: challenge nuevo vs.
  atar a `/api/settle/principal`) queda ABIERTA como `[NEEDS CLARIFICATION]` BLOQUEANTE para F2 — este
  analyst recomienda (no vinculante) el endpoint nuevo, precisamente porque es la única opción que
  aporta algo NO cubierto ya por WKH-168. Segunda `[NEEDS CLARIFICATION]` BLOQUEANTE (de
  producto/priorización, no técnica): dado el Hallazgo Central, ¿se prioriza esta HU AHORA o se
  DIFIERE hasta un 2º money-rail real? **Hallazgo de coordinación IMPORTANTE**: `_INDEX.md` lista a
  WKH-168 como "F1 (en curso)" pero su código (atestación A1-A9) YA está presente en el working tree
  actual — antes de F3 de WKH-206, el orquestador debe confirmar el estado real de merge de WKH-168
  (riesgo de conflicto sobre `submit/route.ts`/`confirm-and-send.ts`, los mismos archivos que ambas
  HUs tocan). Ver `doc/sdd/017-wkh-206-payout-proof-of-possession/work-item.md` para el detalle
  completo (grounding, ACs, DT-N, CD-N, Missing Inputs, categorías de riesgo de seguridad).

---

## 🔴 AUDITORÍA CHASKI V2 (2026-07-10/11) — 100% CERRADA

**Estado final**: Todas las 7 HUs del backlog de seguridad/higiene en estado **DONE**.

| HU | Status | Cierre |
|----|--------|--------|
| WKH-178 (P0: demo-safe + recibo real) | DONE | 2026-07-10 |
| WKH-179 (P0: IDOR PII + auth/rate-limit) | DONE | 2026-07-10 |
| WKH-180 (P1: payout authority server-side) | DONE | 2026-07-11 |
| WKH-181 (P1: PII persistence + per-wallet + AML) | DONE | 2026-07-11 |
| WKH-182 (P2: money-path robustez) | DONE | 2026-07-11 |
| WKH-183 (P3: higiene menores) | DONE | 2026-07-11 |
| WKH-184 (Residual AC-8: reset + señal FallbackWallet) | DONE | 2026-07-11 |

**Impacto**: Chaski v2 sale del hackathon con pipeline de seguridad/QA completo, aislamiento por wallet,
PII persistida responsablemente, reset explícito para shared-device, y flujo e2e funcional. Cero hallazgos
bloqueantes abiertos. El AC-8 residual de WKH-181 (diferido a WKH-184) está formalmente cerrado.

## 🟡 DEUDA TÉCNICA POST-AUDITORÍA

| HU | Status | Nota |
|----|--------|------|
| WKH-185 (harness jsdom+RTL + backfill ACs UI sin RTL) | DONE (2026-07-11) | Cierra el gap de test automático dejado por 178/181/184 en `flow.tsx`. Test-only. Sin hallazgos (AR/CR/F4). |

**Estado final**: La auditoría integral de Chaski v2 2026-07-10/11 + backfill técnico = **100% COMPLETADA**. Todas las HUs en estado DONE. Listo para merge a `main` y deploy a staging/prod.

## 🟢 VALUE-DELIVERY (porción técnica de WKH-168)

| HU | Status | Nota |
|----|--------|------|
| WKH-186 (scaffolding a2a mock/off + reconciliación + refund + EIP-3009-ready) | DONE (2026-07-11) | Sin movimiento de dinero real (CD-2 verificada 6 capas). Gap real cerrado (refund-on-failure). Runbook Fase A documentado. Listo para merge. Ver `doc/sdd/009-wkh-186-value-delivery-scaffolding/done-report.md`. |
| WKH-168 (Mitad A: settle on-chain real verificado, reusa `wasiai-facilitator`) | F1 (2026-07-15) | Cierra el bug de fondo (`principal_in` = firma, no dinero). Recomendación de SPLIT documentada (persistencia + reconciliación → HU de seguimiento aparte). Ver `doc/sdd/016-wkh-168-principal-in-real-settlement/work-item.md`. |

## 🔵 MONEY-PATH / UX (post value-delivery scaffolding)

| HU | Status | Nota |
|----|--------|------|
| WKH-187 (reorden: quote antes del KYC) | DONE (2026-07-12) | Reorden puro de secuencia (dominio + UI); el gate de compliance `confirm_requires_kyc_passed` y la autoridad server-side WKH-180 quedan explícitamente intactos (AC-3/AC-7, CD-2/CD-3). 9/9 ACs PASS, 235/235 tests verdes, 0 BLQ/0 MENOR en AR/CR, tsc/build OK. Auto-blindaje documentado: 3 lecciones para reordenes de FSM. Ver `doc/sdd/010-wkh-187-quote-before-kyc-reorder/done-report.md`. |

## 🟣 BUGS POST-LAUNCH (reportados en producción)

| HU | Status | Nota |
|----|--------|------|
| WKH-188 (resume de KYC abandonado: escape visible + timeout corto) | DONE (2026-07-12) | Bug reportado por el founder en móvil (usuario dio "atrás" en Didit, quedó ~100s sin escape en el overlay "Verificando…"). Fix de UX/timing en `flow.tsx`, sin tocar el gate de compliance ni la autoridad server-side WKH-180 (CD-1/CD-3). Ver `doc/sdd/011-wkh-188-kyc-resume-escape/done-report.md`. |

## 🟠 AUDITORÍA ADVERSARIAL #2 (2026-07-14) — 100% CERRADA (hallazgos A-D + GATES); WKH-202 (gate Fase A, G1) DONE; WKH-168 (gate Fase A, G3) DONE; WKH-206 (gate Fase A, G5) DONE

**Estado**: Los 5 hallazgos originales A-D + WKH-202 (gate Fase A, G1) + WKH-168 (gate Fase A, G3) + WKH-206 (gate Fase A, G5) del batch de auditoría adversarial #2 
de `chaski-v2` están **100% DONE** (2026-07-14/15/16). WKH-168 (G3, Mitad A: settle real, DONE 2026-07-15) cerró el gate que verifica que el DINERO existe antes de disparar el payout (sin él, un atacante con KYC propio aprobado pasa todos los demás gates). WKH-206 (G5, proof-of-possession, DONE 2026-07-16) es el ÚLTIMO de los 5 huecos del gate de Fase A; su F0 encontró que WKH-168 ya cierra la mayor parte del gap para el camino real de dinero via EIP-712 on-chain (ver nota de WKH-206 en el reporte para el detalle honesto). Pipeline QUALITY completo para ambas HUs (F0→F1→F2→F2.5→F3→AR→CR→F4).

| HU | Status | Cierre |
|----|--------|--------|
| WKH-198 (Hallazgo A: fail-closed en expiry de quote — guard NaN + shape de fecha) | DONE | 2026-07-14 |
| WKH-199 (Hallazgo B: KYC re-brick — `KycStore.save()` best-effort + reorder) | DONE | 2026-07-14 |
| WKH-200 (Hallazgo C: estados honestos en TrackView + banner demo cubre payout-mock) | DONE | 2026-07-14 |
| WKH-201 (Hallazgo D: `forgetAndDisconnect` purga PII persistida) | DONE | 2026-07-14 |
| WKH-202 (GATE Fase A / G1+enforcement: `/api/a2a/payout/submit`) | DONE | 2026-07-15 |
| WKH-168 (GATE Fase A / G3, Mitad A: settle on-chain verificado) | DONE | 2026-07-15 |
| WKH-206 (GATE Fase A / G5, último hueco: proof-of-possession SIWE) | DONE | 2026-07-16 |

**Impacto**: 4 defectos de seguridad/integridad cerrados en auditoría adversarial #2 (hallazgos A-D). Money-path protegido (fail-closed en expiry quote), KYC cache resiliente (best-effort), UI honesta (payout-failed status + demo banner), reset completo (PII purged). Pipeline QUALITY completo (F0→F1→F2→F2.5→F3→AR→CR→F4) para **TODOS los gates de Fase A cerrados**. WKH-202 (DONE 2026-07-15) cerró el enforcement del endpoint de submit. WKH-168 (G3, DONE 2026-07-15) es el gate que verifica que el DINERO existe antes de disparar el payout (sin él, un atacante con KYC propio aprobado pasa todos los demás gates y pide un payout con monto arbitrario). WKH-206 (G5, DONE 2026-07-16) es el último hueco — proof-of-possession del `address`, con el hallazgo honesto de que WKH-168 ya mitiga la mayor parte del riesgo para el camino real de dinero via EIP-712 on-chain (ver report.md para el detalle completo). **Los 5 huecos del gate de Fase A (G1..G5) están cerrados a nivel código.**

**Desvíos documentados**:
- **WKH-199 MNR-1**: `project-context.md` creado entero (188 líneas, documental de patrones Chaski v2, no en Story File pero value-added).
- **WKH-200 MNR-1**: Fake-timers test growth artifact documentado en auto-blindaje (T-AC2 poll-count intermitente, workaround en snapshot inicial).
- **WKH-201 MNR-1**: Consumidor `test-container.ts` omitido en Story File, wiring actualizado en F3 (byte-idéntico, fallo de survey).

**NNN Colisión histórica**: 4 analysts paralelos → WKH-198 tomó `012`, WKH-199 probó `012` (colisión) → `013`, WKH-200 probó `012`/`013` (colisiones) → `014`, WKH-201 probó `012`/`013` (colisiones) → `014` (comparte prefijo con WKH-200, carpetas distintas). Stubs obsoletos creados durante F1 (`012-wkh-199-*`, `012-wkh-200-*`, `012-wkh-201-*`, `013-wkh-200-*`, `013-wkh-201-*`), limpiados en esta fase final (git rm). Ver nota de coordinación debajo. **WKH-202 usó `015` sin colisión** (NNN pre-asignado por el orquestador, aplicando la lección de esta sección). **WKH-168 usó `016` sin colisión** (mismo criterio, único analyst corriendo sobre `chaski-v2` en el momento de F1). **WKH-206 usó `017` sin colisión** (mismo criterio; NNN pre-asignado explícitamente por el orquestador, ver nota de WKH-206 arriba).

### Nota de coordinación — Limpieza de stubs de colisión NNN (auditoría adversarial #2)

Hubo una **carrera de 4 analysts en paralelo** (2026-07-14, mismo repo `chaski-v2`, el orquestador creó 4 work-items de HU de manera concurrent). La asignación de directorio SDD `NNN-titulo` quedó expuesta a colisión de filesystem:

- **WKH-198** asignado a `012-wkh-198-...` ✓ (ganador, primer analyst que escribió el path y hizo commit)
- **WKH-199** intentó `012-wkh-199-...` (colisión) → detectada en F1 → renumerado a `013-wkh-199-...` (folder real)
  - **Stub obsoleto**: `012-wkh-199-kyc-store-save-best-effort/work-item.md` (solo redirige a `013-...`)
- **WKH-200** intentó `012-wkh-200-...` (colisión con WKH-198) → `013-wkh-200-...` (colisión con WKH-199) → `014-wkh-200-...` (folder real)
  - **Stubs obsoletos**: `012-wkh-200-track-honesty-payout-mock-banner/work-item.md` y `013-wkh-200-track-honesty-payout-mock-banner/work-item.md` (redirigen a `014-...`)
- **WKH-201** intentó `012-wkh-201-...` (colisión) → `013-wkh-201-...` (colisión) → `014-wkh-201-...` (folder real, comparte prefijo `014` con WKH-200, carpetas distintas)
  - **Stubs obsoletos**: `012-wkh-201-forget-disconnect-purge-persisted-pii/work-item.md` y `013-wkh-201-forget-disconnect-purge-persisted-pii/work-item.md` (redirigen a `014-...`)

**Resolución (fase DONE, 2026-07-14)**:
- Todos los stubs fueron eliminados con `git rm doc/sdd/012-wkh-199-*`, etc.
- Las carpetas canónicas se mantienen:
  - `012-wkh-198-quote-expiry-fail-closed/`
  - `013-wkh-199-kyc-store-save-best-effort/`
  - `014-wkh-200-track-honesty-payout-mock-banner/`
  - `014-wkh-201-forget-disconnect-purge-persisted-pii/`
- Verás 4 folders con prefijo `014` = error histórico de NNN; la convención dice "prefijo único por HU" pero se toleró aquí por timing (4 HUs simultáneas). Futuras HUs respetarán NNN único (ej., WKH-202 será `015` si es la siguiente).

**Patrón idéntico al de WKH-178/179**: colisión de 2 analysts → renumeración → stubs residuales. Documentado histórico en `_INDEX.md` L21-25 de esa época. Motivo recurrente: fork-join architecture (múltiples agents lanzados simultáneamente sin coordinar NNN pre-asignado).

**Lección para futuras auditorías en paralelo**: Si se lanzan 3+ analysts al mismo tiempo sobre el mismo repo, considerar pre-asignar el rango de NNN (ej., "WKH-198 usa `012`, WKH-199 usa `013`, WKH-200 usa `014`, WKH-201 usa `015`") antes de que escriban los work-items, para evitar stubs. Alternativa: usar timestamp + analyst-id en el nombre de carpeta si los stubs se acumulan.

**Confirmación (WKH-202, 2026-07-15)**: la lección se aplicó — el orquestador pre-asignó `015` a WKH-202 antes de lanzar el analyst, sin colisión de NNN. Único analyst corriendo sobre `chaski-v2` en este momento (sin carrera paralela).

**Confirmación (WKH-168, 2026-07-15)**: la misma lección se aplicó — el orquestador pre-asignó `016` a WKH-168 antes de lanzar el analyst (instrucción explícita "usá el NNN `016` — WKH-202 tomó el `015`"), sin colisión de NNN.

**Confirmación (WKH-206, 2026-07-16)**: la misma lección se aplicó — el orquestador pre-asignó `017` a WKH-206 antes de lanzar el analyst (instrucción explícita "usá el NNN `017` — 015=WKH-202, 016=WKH-168 ya tomados"), sin colisión de NNN.
