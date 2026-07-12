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
| WKH-186 | [Técnico, porción de WKH-168] Value-delivery scaffolding: adapter a2a (mock/off), reconciliación + idempotencia, refund-on-failure, EIP-3009-ready | F1 (2026-07-11) | `doc/sdd/009-wkh-186-value-delivery-scaffolding/work-item.md` |

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
- **WKH-186 (F1, 2026-07-11, `009`)**: porción TÉCNICA de WKH-168 (desembolso real), SIN depender
  del partner/sandbox TransFi — scaffolding completo de value-delivery con TODO mock/apagado por
  default (cero movimiento de dinero real). Trabaja sobre el estado ya mergeado de WKH-178..185
  (`main`); no reabre ninguno de esos gaps. 4 piezas: (1) adapter `src/infrastructure/a2a/` que
  llama directo (server-side, DT-1) a los agentes live `remit-corridor-fx`/`remit-cashout-payout`
  del repo `wasiai-remittance-agents` (verificado en disco: contrato `POST /invoke → {result}`
  estable, sin auth hoy), detrás de un flag de composición `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`
  (default `fallback`, como hoy); (2) reconciliación (deliveredPen vs expectedReceivePen, misma
  tolerancia que `assertReceiveConsistent`) + idempotencia end-to-end (el `idempotencyKey` ya
  existente viaja intacto); (3) **refund-on-failure**: cierra un gap real encontrado en F0 (NINGÚN
  use-case existente llama `Remittance.markRefunded()` — una remesa en `payout_failed` queda
  huérfana hoy, incluso en modo 100% mock) con un `RefundGateway` nuevo (`LedgerRefundGateway`,
  ledger-only, sin movimiento on-chain real — CD-8 documenta el gap de clawback real como Fase A);
  (4) EIP-3009-ready: `wallet.ts` gana un path real de `signTypedData`
  `transferWithAuthorization` detrás de `NEXT_PUBLIC_EIP3009_ENABLED` (default `false`, preserva el
  `signMessage` simbólico actual), con fail-loud en `createContainer()` si se enciende sin el
  adapter payout real (`NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a`) o sin
  `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` configurada (CD-3/CD-4). Sin HUs concurrentes en
  `chaski-v2` hoy (backlog 178-185 100% cerrado) → sin riesgo de colisión de merge. 4
  `[NEEDS CLARIFICATION]` no bloqueantes (todos resolubles por el Architect en F2 o diferidos a
  Fase A/founder, ninguno bloquea el scaffolding mock): (1) llamada directa al agente vs a través
  del gateway pagado `wasiai-a2a`; (2) dirección/contrato USDC exacto por chain para el dominio
  EIP-3009; (3) `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` no existe hoy (Fase A/partner); (4)
  `remit-cashout-payout` no expone hoy polling asíncrono separado (HU futura en ESE repo, fuera de
  `chaski-v2`). Ver `doc/sdd/009-wkh-186-value-delivery-scaffolding/work-item.md`.

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
| WKH-186 (scaffolding a2a mock/off + reconciliación + refund + EIP-3009-ready) | F1 (2026-07-11) | Sin movimiento de dinero real. Deja el terreno listo para WKH-168 real (Fase A/TransFi). Ver Notas de coordinación arriba. |
