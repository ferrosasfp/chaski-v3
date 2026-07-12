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
  el estado ya mergeado de WKH-178..185 (`main`); no reabre ninguno de esos gaps. 4 piezas
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

## 🔵 MONEY-PATH / UX (post value-delivery scaffolding)

| HU | Status | Nota |
|----|--------|------|
| WKH-187 (reorden: quote antes del KYC) | DONE (2026-07-12) | Reorden puro de secuencia (dominio + UI); el gate de compliance `confirm_requires_kyc_passed` y la autoridad server-side WKH-180 quedan explícitamente intactos (AC-3/AC-7, CD-2/CD-3). 9/9 ACs PASS, 235/235 tests verdes, 0 BLQ/0 MENOR en AR/CR, tsc/build OK. Auto-blindaje documentado: 3 lecciones para reordenes de FSM. Ver `doc/sdd/010-wkh-187-quote-before-kyc-reorder/done-report.md`.
