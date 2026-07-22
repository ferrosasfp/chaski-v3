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
| WKH-205 | [Deuda técnica, cero-deuda] Cierra follow-ups de WKH-202 (MNR-2/3/5/6) + residual R2 de WKH-206: oráculo KYC de `/api/payout/validate`, bug body-null, rate-limit de `/challenge` | DONE (2026-07-16) | `doc/sdd/018-wkh-205-payout-validate-oracle-hardening/report.md` |
| WKH-207 | [Deuda técnica mayor, seguimiento de WKH-168] Persistencia server-side + reconciliación de remesas huérfanas (el residual AC-9/DT-2 de WKH-168) | DONE (2026-07-16) | `doc/sdd/019-wkh-207-remittance-persistence-reconciliation/report.md` |
| WKH-209 | [Money-path, decisión founder] Mover el settlement del principal (WKH-168, EIP-3009) de Avalanche a Base — chainId, USDC address, RPC de verificación y domain EIP-712 parametrizados por red, reusando `wasiai-facilitator` (adapter Base ya existe) | DONE (2026-07-17) — 11/11 ACs, 460 tests, 0 BLQ. Fix del domain EIP-712 name-por-red (`"USDC"` Sepolia / `"USD Coin"` mainnet). Flag OFF. | `doc/sdd/020-wkh-209-settle-principal-en-base/done-report.md` |
| WKH-210 | [Money-path, seguimiento de WKH-207] Cerrar el loop async de TransFi: receptor de webhooks (`fund_settled`/`asset_deposited`/`fund_failed`) sobre el `SettlementLedger` de WKH-207 | DONE (2026-07-17) — 11/11 ACs, 501 tests, AR+CR+F4 0 BLQ. HMAC body-crudo timing-safe, idempotencia at-least-once (mutar-primero/claim-después, AR-MNR-1 fix-packeado), no-PII, flags OFF. Reorder no-custodial = WKH-211. Smoke webhook gateado al founder. | `doc/sdd/021-wkh-210-transfi-deposit-flow-webhook/done-report.md` |
| WKH-211 | [Money-path, cambio de modelo de seguridad, seguimiento de WKH-210] Value-delivery no-custodial: el USDC del sender va directo al `depositAddress` que TransFi asigna por orden (`to=depositAddress` en la firma EIP-3009), reemplazando el receiver estático de plataforma | DONE (2026-07-18) — binding=Opción B (`/api/payout/prepare` + DepositAttestation HMAC). 8/8 ACs, 553 tests, AR+CR+F4 0 BLQ. Vector de desvío de fondos cerrado (7 sub-ataques rechazan pre-broadcast); guard 8 byte-idéntico; V1-V9 intacta; flags OFF byte-idéntico. 2 MENORes fund-safe → WKH-213. | `doc/sdd/022-wkh-211-non-custodial-deposit-flow/done-report.md` |
| WKH-206 / HU-SOL-1 | [Solana LATAM Labs, fundación del port multi-VM] Generalizar la config de red (`chain.ts`) y el contrato de autorización (`ports.ts`) de EVM-only a multi-VM (discriminador `vm: 'evm' \| 'solana'`), agregando una entrada Solana configurable/resolvible SIN wallet ni firma Solana todavía | DONE (2026-07-21) — 7/7 ACs, 562 tests, AR+CR+F4 0 BLQ. Branch `feat/023-hu-sol-1-multi-vm-config` commit `1b6aa22`. | `doc/sdd/023-hu-sol-1-multi-vm-config/report.md` |
| WKH-212 / HU-SOL-4 | [Solana LATAM Labs, wallet Solana] Integración `@solana/wallet-adapter-react`: árbol de providers (ConnectionProvider+WalletProvider+WalletModalProvider) montado condicionalmente por NEXT_PUBLIC_VM, puenteado al `WalletPort` imperativo via singleton React-free. Phantom/Solflare conectables desde la UI. **Path EVM byte-idéntico (AC-3)**. Firma SPL (HU-SOL-2) y PoP (HU-SOL-8) quedan OUT. | DONE (2026-07-21) — 6/6 ACs PASS, 571 tests (562 EVM intactos + 9 nuevos Solana), AR+CR+F4 0 BLQ/0 MENOR. Seam React-free garantiza AC-3 por construcción. Peer-conflict `@solana/pay` diferido a HU-SOL-5. Branch `feat/024-hu-sol-4-wallet-adapter` commit `2dd1758`. | `doc/sdd/024-hu-sol-4-wallet-adapter/report.md` |
| WKH-207 / HU-SOL-5 | [Solana LATAM Labs, wallet firma el deposit al escrow] `authorizePrincipal` construye la ix escrow Anchor gasless (feePayer=facilitator, partial-sign SOLO wallet), retorna tx serializada + reference. Path EVM byte-idéntico. | DONE (2026-07-21) — 8/8 ACs, 594 tests (586 base + 8 Solana), AR+CR+F4 APROBADO. BLQ-MED-1 (`node:crypto` en browser) fix-packeado con `@noble/hashes`. Branch `feat/025-hu-sol-5-wallet-deposit-escrow` commit `79ff56b`. | `doc/sdd/025-hu-sol-5-wallet-deposit-escrow/report.md` |
| WKH-213 / HU-SOL-7 | [Solana LATAM Labs, GATE DE SEGURIDAD IDOR] Identidad multi-VM base58 — cierra un IDOR cross-tenant: `.toLowerCase()` corrompe base58 (case-sensitive), colisiona pubkeys distintas. Helper único `canonicalizeAddress(address, vm)` en 15 sitios/9 archivos. EVM byte-idéntico. | DONE (2026-07-21) — 9/9 ACs PASS, 586 tests, AR (ataque IDOR ejecutado, falla sin colisión) + CR + F4 0 BLQ. 1 MENOR fix-packeado (test-doubles). Branch `feat/026-hu-sol-7-identidad-base58` commit `e65bae6`. | `doc/sdd/026-hu-sol-7-identidad-base58/report.md` |
| WKH-211 / HU-SOL-8 | [Solana LATAM Labs, GATE DE SEGURIDAD] PoP + atestación ed25519 — el gate G5 (WKH-206) solo verifica ECDSA (`viem.verifyMessage`/`isAddress`), que SIEMPRE rechaza una address Solana base58. Agrega verificador ed25519 real (`nacl.sign.detached.verify` + decode base58 estricto 32 bytes), preserva `buildPopMessage` SSOT + nonce single-use, vuelve PoP OBLIGATORIO (no opt-in) en el money-path Solana (el binding Didit es débil, `authority.ts:74-87`), y ata las atestaciones a un network-id CAIP-2 (`solana:devnet`/`solana:mainnet`) en vez de `chainId:number` — anti replay cross-cluster (mismo vector "$400 por $0" ya cerrado del lado EVM). | DONE (2026-07-22) — 8/8 ACs, 621 tests, 0 BLQ/0 MENOR. Branch `feat/027-hu-sol-8-pop-ed25519` commit `eb9a406`. Verificador ed25519 + CAIP-2 + obligatoriedad + EVM byte-idéntico. | `doc/sdd/027-hu-sol-8-pop-ed25519/report.md` |
| WKH-208 / HU-SOL-9 | [Solana LATAM Labs, binding no-custodial + wire al facilitator] Ramifica la validación de address por VM (base58 cuando `vm==="solana"`) en `deposit-attestation.ts`, `settle/principal/route.ts` y `prepare/route.ts`, y hace que `facilitator-client.ts` construya un payload Solana representable hacia `/settle` del `wasiai-facilitator`. Con el escrow futuro (HU-SOL-13) el binding pasa a ser la authority del `release` (`to` atestado == `beneficiary`). Path EVM byte-idéntico. | F1 (2026-07-22) — 6 ACs EARS, 5 DT-N, 7 CD-N. **Hallazgo cross-repo BLOQUEANTE**: el schema Zod HTTP del facilitator (`wasiai-facilitator/src/core/schemas.ts::AcceptedSchema`) rechaza `asset`/`payTo` base58 en ambas ramas del union — confirmado por el propio report de HU-SOL-6, que nombra a esta HU como responsable; esta HU tiene PROHIBIDO tocar el repo del facilitator. Recomendado companion ticket separado (ver Missing Inputs). | `doc/sdd/028-hu-sol-9-binding-wire-facilitator/work-item.md` |
| WKH-216 / HU-SOL-13 | [Solana LATAM Labs, integración del escrow] Cablea el escrow Anchor (deposit real + verify vault on-chain + release autorizado + refund trustless) al money-path Solana no-custodial. 3 waves cross-repo: 13a (chaski deposit wiring + refund UI), 13b/13c (facilitator read vault + firma+broadcast release con reuso de HU-SOL-14). Path EVM byte-idéntico. Flag OFF devnet. | DONE (2026-07-22) — 7/7 ACs (AC-1,AC-6,AC-7 chaski; AC-2,AC-3,AC-4,AC-5 facilitator), 1655 tests (676+979), AR (BLQ-MED-1 flow-vm fix-pack) + CR (0 BLQ) + F4 (0 BLQ) — 2 MENOR H1/H2 documentados no-bloqueantes, git-hygiene fix-packeado 13bc. Branch `feat/029-hu-sol-13-escrow-integration` commit `e9f494a` (chaski), `feat/029bc-hu-sol-13bc-escrow-facilitator` `d0ae09d` (facilitator, HELD). | `doc/sdd/029-hu-sol-13-escrow-integration/report.md` |

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
  9/9 ACs PASS, 10/10 CDs cumplidas, pipeline QUALITY completo (F0→F1→F2→F2.5→F3→AR→CR→F4). Ver
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
  enciende sin conditions CD-3/CD-4). Ver `doc/sdd/009-wkh-186-value-delivery-scaffolding/done-report.md`.
- **WKH-187 (DONE, 2026-07-12, `010`)**: reorden money-path/UX puro — mostrar el quote lockeado apenas
  se conecta la wallet, pedir el KYC recién cuando el usuario confirma que quiere enviar. Ver
  `doc/sdd/010-wkh-187-quote-before-kyc-reorder/done-report.md`.
- **WKH-188 (DONE, 2026-07-12, `011`)**: bug reportado por el founder en móvil — al abandonar una
  sesión de Didit a mitad de camino (botón "atrás" del navegador), el usuario queda ~100s
  (40×2500ms) en el overlay "Verificando tu identidad…" sin ningún control de salida antes del
  timeout completo. Fix acotado de UX. Ver `doc/sdd/011-wkh-188-kyc-resume-escape/done-report.md`.
- **WKH-198 (F1, 2026-07-14, `012`)**: hallazgo A de la 2ª auditoría adversarial de `chaski-v2`,
  distinto al backlog 178-188 (auditoría nueva). Bug de integridad money-path confirmado en F0:
  `isQuoteExpired` sin guard de `NaN`. Ver
  `doc/sdd/012-wkh-198-quote-expiry-fail-closed/work-item.md`.
- **WKH-199 (F1, 2026-07-14, `013`, renumerado)**: hallazgo B de la misma 2ª auditoría adversarial
  (paralelo a WKH-198). Reincidencia confirmada en F0 de la MISMA clase de bug que WKH-183 cerró
  para `kyc-pending-store.ts`. Ver `doc/sdd/013-wkh-199-kyc-store-save-best-effort/work-item.md`.
- **WKH-200 (F1, 2026-07-14, `014`, renumerado DOS veces)**: hallazgo C de la misma 2ª auditoría
  adversarial. Bug de honestidad de estado + demo confirmado en F0: `TrackView` trataba
  `payout_failed`/`refunded` como "no reconocido". Ver `doc/sdd/014-wkh-200-track-honesty-payout-mock-banner/work-item.md`.
- **WKH-201 (F1, 2026-07-14, `014`)**: hallazgo D de la 2ª auditoría adversarial de `chaski-v2`,
  analyst paralelo de WKH-198/199/200. Completa el reset de WKH-184: `ForgetKyc` no purgaba el repo
  persistido (`LocalRepo`). Ver `doc/sdd/014-wkh-201-forget-disconnect-purge-persisted-pii/work-item.md`.
- **WKH-202 (F1, 2026-07-15, `015`)**: gate de la Fase A del plan de remesa real — hallazgo de la
  auditoría adversarial #2 (relacionado a WKH-198/200 pero separado). `app/api/a2a/payout/submit/route.ts`
  forwardeaba `amountUsd`/`beneficiary`/`kycVerificationId` verbatim sin NINGUNA autorización. Ver
  `doc/sdd/015-wkh-202-payout-submit-hardening/work-item.md`.
- **WKH-168 (F1, 2026-07-15, `016`)**: gate G3 de la Fase A ("el único de los 5 huecos que verifica
  que el DINERO existe") — se parte en 2 mitades, esta HU es SOLO la Mitad A (settle on-chain
  real, NO bloqueada por TransFi). `authorizePrincipal` producía una FIRMA EIP-712, nunca una
  transacción transmitida. Reusa el relayer auditado `wasiai-facilitator`. Recomendó SPLIT: la
  Mitad B (persistencia + reconciliación de huérfanos) se registra como **WKH-207** (esta HU). Ver
  `doc/sdd/016-wkh-168-principal-in-real-settlement/work-item.md`.
- **WKH-206 (F1→DONE, 2026-07-16, `017`, NNN pre-asignado sin colisión)**: G5, el ÚLTIMO de los 5
  huecos del gate de Fase A — proof-of-possession (SIWE/EIP-4361) del `address` que pide el payout.
  Ver `doc/sdd/017-wkh-206-payout-proof-of-possession/report.md`.
- **WKH-205 (F1, 2026-07-16, `018`, NNN pre-asignado sin colisión)**: deuda técnica de cierre — 4
  MENOREs de follow-up explícito de WKH-202 (MNR-2 oráculo, MNR-3 bug body-null, MNR-5 `isRecord`
  arrays, MNR-6 tipado de test) + el residual R2 de WKH-206 (rate-limit ausente en `/challenge`).
  Trabaja sobre el estado ya mergeado de WKH-178..206 (`main`), TODOS los 5 gates de Fase A (G1-G5)
  ya DONE. F0 confirmó el hallazgo central del ticket: `app/api/payout/validate/route.ts` sigue
  siendo un oráculo público de estado KYC (ecoa `reason` verbatim: `kyc_not_approved` vs
  `kyc_ownership_mismatch` vs `invalid_verification_id`) — el mismo `resolvePayoutAuthority()`
  compartido con `submit` (que SÍ colapsa su `reason` desde WKH-202/CD-12). Hallazgo NUEVO de F0
  (no anticipado por el ticket): `humanError()` (`flow-vm.ts:37-49`) YA colapsa TODOS los `reason`
  que contienen `"kyc"` al mismo mensaje de UI — el cliente legítimo (`HttpPayoutAuthorityGateway` →
  `ConfirmAndSend`) **no distingue hoy** entre los `reason` granulares, así que colapsar el `reason`
  expuesto por la ruta NO rompe ningún comportamiento observable de UI (AC-7). DT-1 decide colapsar
  en la CAPA del wrapper `validate/route.ts` (mismo patrón que el switch ya probado de
  `submit/route.ts:96-114`), sin tocar `authority.ts` (compartido, cero riesgo sobre los 7 ACs PASS
  de WKH-202). También se generaliza `src/infrastructure/rate-limit.ts` (hoy 100% KYC-specific) para
  aplicar el mismo patrón fail-closed a `/api/payout/validate` (financial-DoS vía Didit, análogo al
  hallazgo A2 de WKH-179) y a `/api/a2a/payout/challenge` (CPU-DoS vía HMAC, residual R2 WKH-206).
  9 ACs EARS. Scope OUT explícito y estricto: `submit/route.ts` (PROHIBIDO tocar su guard-order,
  CD-6, salvo la línea puntual de MNR-5), `authority.ts` (salvo justificación + doble AR, CD-3),
  ningún flag nuevo encendido, WKH-207 (persistencia/reconciliación de remesas huérfanas, fuera de
  scope). Toca `app/api/payout/validate/route.ts`(+test), `app/api/a2a/payout/challenge/route.ts`
  (+test), `src/infrastructure/rate-limit.ts`(+test), y 2 líneas puntuales de
  `app/api/a2a/payout/submit/route.ts`(+test). **Colisión con WKH-207** (`019`, corriendo en
  paralelo — ver bullet siguiente): riesgo BAJO — WKH-207 previsiblemente toca `confirm-and-send.ts`
  y el bloque de forward/reconciliación de `submit/route.ts` (`submit/route.ts:27-28` ya apunta el
  residual), mientras que WKH-205 solo toca 1 línea aislada de `submit/route.ts` (`isRecord`,
  L39-41) y NO toca `confirm-and-send.ts` en absoluto — se recomienda coordinar orden de MERGE si
  ambas tocan `submit/route.ts` en la misma ventana, pero no hay overlap de lógica. Missing Inputs:
  4 `[NEEDS CLARIFICATION]` NO bloqueantes (nombre exacto del código colapsado, extraer switch
  compartido vs duplicar, umbrales de rate-limit, extraer `isRecord()` a util compartido) —
  ninguno bloquea F2. Ver `doc/sdd/018-wkh-205-payout-validate-oracle-hardening/work-item.md` para
  el detalle completo (grounding, ACs, DT-N, CD-N, tabla de riesgo de seguridad, Missing Inputs).
- **WKH-207 (F1, 2026-07-16, `019`, NNN pre-asignado sin colisión por el orquestador)**: seguimiento
  directo de WKH-168 (DT-2 de ese work-item recomendó explícitamente esta HU, candidata L/XL). Es la
  deuda técnica MÁS GRANDE del gate de Fase A, nombrada en código (no solo en docs) por WKH-168:
  `RemittanceRepository` es client-side (`localStorage`), y una remesa cuyo principal YA entró
  on-chain (verificado, `principal_in`) puede quedar huérfana si el forward al agente de payout
  falla o si la atestación single-use se quema antes del forward — con el dinero REALMENTE adentro
  y sin persistencia/reconciliación server-side (comentarios explícitos en
  `src/application/ports.ts:115-124`, `src/application/use-cases/confirm-and-send.ts:55-65` y
  `app/api/a2a/payout/submit/route.ts:27-28`). F0 confirmó: `chaski-v2` NO tiene hoy ninguna capa de
  persistencia server-side (sin `supabase/` en el repo, sin dependencia de DB en `package.json`;
  Upstash existe pero SOLO para rate-limit y flags single-use efímeros de replay-protection —
  `attestation-store.ts`/`pop-nonce-store.ts`, explícitamente documentados como "NO
  `RemittanceState`, eso es WKH-207"). Trabaja sobre el estado ya mergeado de WKH-178..206 (`main`,
  incluyendo WKH-206 mergeado el mismo día). Sizing **XL** (QUALITY, cambio arquitectónico): 10 ACs
  EARS, 4 DT-N (incluye el hallazgo nuevo DT-3: `/api/settle/principal` hoy NO recibe
  `remittanceId` explícito — el nonce EIP-3009 es un hash one-way, así que correlacionar el
  registro server-side nuevo requiere una decisión de F2), 10 CD-N. **1 `[NEEDS CLARIFICATION]`
  BLOQUEANTE para F2** heredado literal de WKH-168/DT-2 (dónde persiste: Opción A Upstash extendido
  vs Opción C Supabase propio de `chaski-v2` — Opción B/DB de `wasiai-a2a` queda descartada salvo
  decisión humana explícita, viola el guardrail "standalone"), requiere aprobación del founder antes
  de que el Architect cierre el SDD. **Riesgo de colisión con WKH-205** (`018`, follow-ups de
  WKH-202, corriendo en paralelo): la carpeta `doc/sdd/018-wkh-205-payout-validate-oracle-hardening/`
  YA existe (F1 completo, ver bullet arriba) — Scope IN de WKH-205 confirmado acotado a
  `validate/route.ts`, `challenge/route.ts`, `rate-limit.ts` y 1 línea puntual de
  `submit/route.ts` (`isRecord`, L39-41); WKH-207 (este work-item) NO toca esos archivos salvo
  potencialmente el mismo `submit/route.ts` (bloque de forward, líneas distintas) — coordinar orden
  de merge con el Architect/orquestador antes de F3 de cualquiera de las dos HUs si ambas tocan
  `submit/route.ts` en la misma ventana (riesgo de línea, no de diseño — confirmado bajo por ambos
  work-items). Wiring de esta HU es ADITIVO (post-guards en `/api/settle/principal` y
  `/api/a2a/payout/submit`, sin tocar guard-order ni la orquestación de `confirm-and-send.ts`) —
  reduce el riesgo de colisión a nivel de líneas, no de diseño. Ver
  `doc/sdd/019-wkh-207-remittance-persistence-reconciliation/work-item.md` para el
  detalle completo (grounding, ACs, DT-N, CD-N, riesgos, Missing Inputs).
- **WKH-209 (F1, 2026-07-17, `020`, NNN pre-asignado sin colisión por el orquestador)**: decisión del
  founder — el corredor de remesa usa **Base** (TransFi, el partner de payout, no soporta USDC en
  Avalanche pero sí en Base). Esta HU mueve el settlement REAL del principal (WKH-168, EIP-3009) de
  Avalanche (Fuji 43113/mainnet 43114) a Base (Sepolia 84532/mainnet 8453), reusando
  `wasiai-facilitator` (su `BaseEip3009Adapter`/`src/chains/base.ts` YA existe y settlea Base Sepolia
  en prod — esta HU apunta Chaski a esa infra, no la construye). Es config/parametrización, NO lógica
  de dominio nueva: el guard-order y la atestación/PoP/ledger de WKH-168/202/206/207 quedan intactos
  (CD-2). **Hallazgo crítico de F0**: `src/infrastructure/wallet.ts:97,242` hardcodea el domain
  EIP-712 `name: "USD Coin", version: "2"` — correcto para el USDC de Avalanche, pero el USDC de Base
  **Sepolia** usa `eip712Name="USDC"` (NO "USD Coin", per `wasiai-facilitator/src/chains/base.ts:42-53`,
  verificado on-chain contra el contrato real). Un swap ingenuo de solo chainId+address firmaría un
  domain que no ata al `DOMAIN_SEPARATOR` real del contrato → AC-4/CD-4/DT-3 fuerzan que el
  `name`/`version` queden parametrizados por chainId (lookup público, NO env — mismo patrón que
  `wasiai-facilitator` ya usa). Toca `src/infrastructure/chain.ts:5,7-13,16-18` (chainId/viem Chain
  hardcodeados a avalanche/avalancheFuji), `src/infrastructure/wallet.ts:97,242` (domain), y
  `src/infrastructure/settlement/onchain-verifier.ts:59` (`AVALANCHE_RPC_URL` literal) + `.env.example`.
  Sizing M. Scope OUT estricto: NO toca `submit/route.ts` guard-order, NO toca `wasiai-facilitator`
  (repo externo, solo coordinación operativa de sus flags `BASE_SEPOLIA_ENABLED`/
  `BASE_SEPOLIA_RPC_URL`), NO enciende `NEXT_PUBLIC_EIP3009_ENABLED` en ningún entorno compartido, NO
  ejecuta/valida contra Base mainnet — solo Base Sepolia testnet, tokens sin valor. **1
  `[NEEDS CLARIFICATION]` BLOQUEANTE para F2** (DT-1): swap directo a Base (elimina soporte de
  Avalanche del código) vs generalizar a multi-red (Avalanche disponible pero inactivo) — recomendación
  del Analyst es swap directo, pero requiere confirmación explícita del founder por ser irreversible
  sin otra HU. Sin overlap de archivos con trabajo en curso conocido (única HU activa sobre
  `chaski-v2` en este momento). Ver
  `doc/sdd/020-wkh-209-settle-principal-en-base/work-item.md` para el detalle completo (grounding,
  ACs, DT-N, CD-N, tabla de riesgo money-path, Missing Inputs).
- **WKH-210 (F1, 2026-07-17, `021`, NNN pre-asignado sin colisión por el orquestador)**: cierra el
  loop async de TransFi — la HU original pedía DOS cosas (envío no-custodial `to=depositAddress` +
  receptor de webhooks); F0 encontró que son piezas de riesgo/blast-radius MUY distintas y
  recomendó **SPLIT**: `WKH-210` queda acotada al receptor de webhooks (`app/api/webhooks/transfi/
  route.ts`, HMAC fail-closed + idempotencia claim-once + update del `SettlementLedger` de WKH-207);
  el reorder no-custodial se recomienda como ticket nuevo separado (candidato WKH-211, a confirmar
  por el orquestador). Motivo del split: el receiver del settle HOY es un ÚNICO address ESTÁTICO de
  plataforma (env pública `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`, `chain.ts:86-90`), usado como
  invariante de seguridad fijo en CUATRO puntos (`wallet.ts:97` firma, `settle/principal/route.ts`
  S12 + V1-V9, `confirm-and-send.ts` C5) — convertirlo en un `depositAddress` dinámico por remesa
  exige una fuente de verdad server-side nueva (no solo reordenar dos llamadas) y toca
  `WalletPort.authorizePrincipal`, AMBAS wallets reales, y el guard-order S1-V9 completo de
  `settle/principal`. **F0 NO pudo verificar la premisa "WKH-208 ya existe y devuelve
  `depositAddress`"**: el código de `remit-cashout-payout` vive en el repo externo
  `wasiai-remittance-agents` (según la nota de WKH-186 arriba), que no está presente en este
  workspace; ni `PayoutRecord`/`PayoutSubmit` (`ports.ts:62-95`) ni `RawPayoutResult`
  (`gateways.ts:19-36`) tienen hoy ningún campo `depositAddress`. Trabaja sobre el estado ya
  mergeado de WKH-178..209 (`main`). Sizing **L**: 11 ACs EARS, 6 DT-N, 8 CD-N, tabla de riesgo
  money-path (HMAC falsificado / replay / PII en payload). Toca (nuevo) `app/api/webhooks/transfi/
  route.ts`, `src/infrastructure/webhooks/webhook-event-store.ts`,
  `src/infrastructure/webhooks/transfi-hmac.ts`, extiende el port `SettlementLedger`
  (`ports.ts:237-267`) con un método nuevo indexado por `payoutId` (implementado en
  `supabase-settlement-ledger.ts:73-170`), y aprovecha el barrido del comentario stale MNR-1 de
  WKH-209 (`submit/route.ts:244-248`, terminología Fuji→Base Sepolia). Scope OUT estricto: CERO
  cambios a `wallet.ts`, `confirm-and-send.ts` o el guard-order de `settle/principal`/`submit`
  (salvo el comentario puntual). **2 `[NEEDS CLARIFICATION]` BLOQUEANTES para F2**: (1) confirmar
  la existencia/contrato real de WKH-208 antes de que el Architect diseñe el ticket del reorder;
  (2) confirmar con el founder que el split (DT-1) es aceptado, o si insiste en meter el reorder
  dentro de esta misma HU pese al blast-radius documentado. Sin overlap de archivos con trabajo en
  curso conocido (única HU activa sobre `chaski-v2` en este momento). **DONE (2026-07-17)**: el
  split fue aceptado, WKH-208 se confirmó DONE entre F1 y F2 (ver `sdd.md` §1), 11/11 ACs, 501
  tests, AR+CR+F4 aprobados 0 BLQ. Ver `doc/sdd/021-wkh-210-transfi-deposit-flow-webhook/work-item.md`
  y `done-report.md` para el detalle completo (grounding, ACs, DT-N, CD-N, tabla de riesgo
  money-path, Missing Inputs).
- **WKH-211 (F1, 2026-07-17, `022`, NNN pre-asignado sin colisión por el orquestador)**: el ticket
  del reorder no-custodial que WKH-210 diferó (DT-1 de esa HU). F0 tuvo acceso, a diferencia de
  WKH-210, al repo externo `wasiai-remittance-agents` (presente en el workspace en esta sesión) y
  encontró DOS hallazgos que WKH-210 no pudo ver: (1) **WKH-208 está DONE** y su tipo interno
  `PayoutResult` (`wasiai-remittance-agents/src/providers/types.ts:112-123`) YA tiene
  `depositAddress: string | null` (WKH-208/DT-4) — PERO el output HTTP del agente
  (`CashoutPayoutOutput`, `src/agents/cashout-payout.ts:50-59,248-257`, y la route
  `src/app/api/agents/remit-cashout-payout/invoke/route.ts:21-22`) **NO lo expone**: se descarta
  silenciosamente en el mapeo de retorno. `chaski-v2` no puede consumir `depositAddress` hasta que
  ese contrato HTTP cambie en el repo externo — dependencia cross-repo BLOQUEANTE, no cosmética.
  (2) **Conflicto estructural con el gate G3 (WKH-168)**: el guard 8 de
  `app/api/a2a/payout/submit/route.ts:178-267` EXIGE la atestación de settlement (prueba de que el
  USDC YA entró) ANTES de forwardear al agente que crea la orden TransFi — pero el reorder necesita
  llamar al agente ANTES de que exista esa atestación (para conseguir el `depositAddress` antes de
  firmar). El guard 8 tiene que REDISEÑARSE (no eliminarse) para preservar la garantía G3 en el
  flujo invertido — ver DT-2 del work-item. Sizing **XL** (no L, por los dos hallazgos de arriba):
  8 ACs EARS, 5 DT-N, 7 CD-N, tabla de riesgo money-path con el vector central (desvío de fondos si
  el `depositAddress` no queda atestado/no-falsificable) y un riesgo NUEVO (órdenes TransFi
  huérfanas si `prepare` se ejecuta y el `settle` posterior falla). **2 `[NEEDS CLARIFICATION]`
  BLOQUEANTES para F2**: (1) enfoque de binding del `depositAddress` — 3 opciones planteadas (A:
  atestación HMAC server-side, patrón `attestation.ts`; B: endpoint nuevo `/api/payout/prepare` +
  atestación, combinación natural de A + el reorder real, RECOMENDADA por el Analyst; C: otra que
  el Architect evalúe) — decisión de arquitectura money-path que requiere aprobación explícita del
  founder; (2) la dependencia cross-repo de `wasiai-remittance-agents` (arriba) — el Architect debe
  decidir si esta HU espera al companion ticket del otro repo o se entrega con esa pieza stubeada.
  Scope IN toca los 4 puntos del invariante `to`/receiver que WKH-210 ya había mapeado
  (`wallet.ts:85-147,240-300`, `settle/principal/route.ts` S12/V1-V9, `confirm-and-send.ts` pasos
  3-4, `submit/route.ts` guard 8) + posible endpoint nuevo. Scope OUT estricto: nada de plata real,
  flags `NEXT_PUBLIC_EIP3009_ENABLED`/`TRANSFI_ADAPTER_READY` permanecen OFF, el webhook de WKH-210
  no se toca salvo un campo aditivo si el binding lo requiere, y PROHIBIDO debilitar/remover el
  guard 8 sin reemplazo de fuerza equivalente (CD-3). Sin overlap de archivos con trabajo en curso
  conocido (única HU activa sobre `chaski-v2` en este momento) — pero es, junto con esta HU, el
  set de archivos de MÁS alto riesgo de todo el repo (`wallet.ts`, `confirm-and-send.ts`,
  `settle/principal/route.ts`, `submit/route.ts`): ninguna otra HU debería tocarlos en la misma
  ventana sin coordinación explícita. Ver
  `doc/sdd/022-wkh-211-non-custodial-deposit-flow/work-item.md` para el detalle completo
  (grounding, ACs, DT-N, CD-N, las 3 opciones de binding, tabla de riesgo money-path, Missing
  Inputs).
- **HU-SOL-1 (F1, 2026-07-20, `023`, NNN pre-asignado sin colisión — 022 fue el último NNN usado,
  WKH-211)**: la HU #0 del programa **Solana LATAM Labs** — fundación del port de Chaski a Solana
  manteniendo el path EVM (Base, EIP-3009) 100% vivo (multi-VM, no swap). F0 confirmó que
  `src/infrastructure/chain.ts` (`NetworkConfig`, `NETWORKS`) y `src/application/ports.ts`
  (`Eip3009Authorization`, `L125-132`) son 100% EVM/viem-shaped hoy — el mint USDC de Solana es
  base58 (no `0x`), se valida con `PublicKey` de `@solana/web3.js` (no `isAddress` de viem, que
  SIEMPRE rechaza un address Solana), y Solana no tiene chainId numérico. Propone generalizar
  `Eip3009Authorization` → `VmAuthorization` (unión discriminada por `vm: 'evm' | 'solana'`, la
  variante `evm` preservando EXACTAMENTE el shape actual). **AC central**: el path EVM queda
  byte-idéntico — la suite de tests existente (`chain.test.ts`, 13 tests, y cualquier consumidor de
  `Eip3009Authorization`) pasa SIN cambios de expectativa. Scope OUT estricto y explícito: NADA de
  wallet Solana / firma SPL (**HU-SOL-2**, bloqueada por esta HU) ni binding/settle no-custodial en
  Solana (**HU-SOL-4**, bloqueada por esta HU) — esta HU es SOLO config + tipos, sin wiring que
  dispare comportamiento runtime nuevo en ningún ambiente. `@solana/web3.js` NO está instalado hoy
  (confirmado negativo en `package.json`, el único rastro en `node_modules` es transitivo de otro
  paquete) — se agrega como dependencia real. Sizing M. 7 ACs EARS, 4 DT-N, 6 CD-N. 2
  `[NEEDS CLARIFICATION]` NO bloqueantes para F2 (mecanismo exacto de selección de VM activa —
  ¿env var nueva o generalizar `NEXT_PUBLIC_CHAIN_ID`? — y cluster Solana objetivo, devnet
  recomendado). Sin overlap de archivos con trabajo en curso conocido (`chain.ts`/`ports.ts` no
  fueron tocados por WKH-210/211, las últimas HUs mergeadas), pero riesgo de colisión con
  cualquier HU EVM futura que también toque `ports.ts:125-132` — coordinar orden de merge si corre
  en paralelo. Ver `doc/sdd/023-hu-sol-1-multi-vm-config/work-item.md` para el detalle completo
  (grounding, ACs, DT-N, CD-N, Missing Inputs).
- **HU-SOL-8 / WKH-211 (F1, 2026-07-22, `027`, NNN pre-asignado sin colisión por el orquestador —
  `026` fue el último NNN usado, HU-SOL-7)**: PoP + atestación ed25519, el gate de seguridad G5
  (WKH-206) portado a Solana. F0 confirmó que `verifyPopChallenge`/`buildPopMessage`
  (`pop-challenge.ts`) y los guards P5 de `submit/route.ts`/PR6 de `prepare/route.ts` usan
  `viem.verifyMessage`/`isAddress` — SIEMPRE rechazan una address Solana base58. Esta HU agrega la
  rama ed25519 real (`nacl.sign.detached.verify` + decode base58 estricto de 32 bytes, reusando el
  `canonicalizeAddress`/`PublicKey` de HU-SOL-7), preservando `buildPopMessage` SSOT y el nonce
  single-use (`pop-nonce-store.ts`, reusado sin cambios). **Ampliación de auditoría, no solo el
  porteo mecánico**: (1) el binding Didit (`authority.ts:74-87`, `vendor_data`/`address`
  caller-controlados) es best-effort y débil, así que el PoP debe volverse OBLIGATORIO (no opt-in
  por presencia de `PAYOUT_POP_SECRET` como en EVM) en el money-path Solana; (2) las atestaciones
  deben atar un network-id CAIP-2 (`solana:devnet`/`solana:mainnet`) en vez de `chainId:number` —
  compartir el HMAC entre clusters reabriría el vector "$400 por $0" ya cerrado del lado EVM
  (A7″ de `submit/route.ts`). Sizing L (QUALITY, gate de seguridad). 8 ACs EARS, 5 DT-N, 8 CD-N.
  Depende de HU-SOL-7 (WKH-213, DONE) y HU-SOL-5 (WKH-207, DONE) — sin bloqueo. Bloquea a HU-SOL-9
  (settle Solana). 3 `[NEEDS CLARIFICATION]` NO bloqueantes para F2: (1) si el `WalletPort` Solana
  ya expone firma de mensaje arbitrario (no verificado en este F0, posible dependencia bloqueante
  si falta); (2) shape exacto de la extensión CAIP-2 de `PopChallenge`; (3) si `tweetnacl` resuelve
  transitivamente en el árbol de deps o hay que agregarla explícita. Scope IN toca
  `pop-challenge.ts`, `submit/route.ts` (P1-P6), `prepare/route.ts` (PR6), `http-pop-signer.ts` —
  los MISMOS archivos de más alto riesgo que tocó WKH-211/HU-SOL-8 mismo (ya DONE del lado EVM);
  sin overlap con otro trabajo activo (single analyst, confirmado). Ver
  `doc/sdd/027-hu-sol-8-pop-ed25519/work-item.md` para el detalle completo (grounding, ACs, DT-N,
  CD-N, Missing Inputs).
| WKH-208 / HU-SOL-9 | [Solana LATAM Labs, binding no-custodial + wire al facilitator] Ramifica la validación de address por VM (base58 cuando `vm==="solana"`) en `deposit-attestation.ts`, `settle/principal/route.ts` y `prepare/route.ts`, y agrega wire Solana hacia `/settle` del facilitator. Path EVM byte-idéntico. | DONE | feat/028-hu-sol-9-binding-wire-facilitator |

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
| WKH-205 (cierra follow-ups WKH-202 + residual R2 WKH-206: oráculo `/validate`, bug body-null, rate-limit `/challenge`) | DONE (2026-07-16) | Founder pidió cero deuda técnica tras cerrar los 5 gates de Fase A (G1-G5). 9/9 ACs, 413/413 tests, 0 BLQ. Ver `doc/sdd/018-wkh-205-payout-validate-oracle-hardening/report.md`. |

**Estado final**: La auditoría integral de Chaski v2 2026-07-10/11 + backfill técnico = **100% COMPLETADA**. Todas las HUs en estado DONE. Listo para merge a `main` y deploy a staging/prod.

## 🟢 VALUE-DELIVERY (porción técnica de WKH-168)

| HU | Status | Nota |
|----|--------|------|
| WKH-186 (scaffolding a2a mock/off + reconciliación + refund + EIP-3009-ready) | DONE (2026-07-11) | Sin movimiento de dinero real (CD-2 verificada 6 capas). Gap real cerrado (refund-on-failure). Runbook Fase A documentado. Listo para merge. Ver `doc/sdd/009-wkh-186-value-delivery-scaffolding/done-report.md`. |
| WKH-168 (Mitad A: settle on-chain real verificado, reusa `wasiai-facilitator`) | DONE (2026-07-15) | Cierra el bug de fondo (`principal_in` = firma, no dinero). Mitad B (persistencia + reconciliación) registrada como WKH-207. Ver `doc/sdd/016-wkh-168-principal-in-real-settlement/done-report.md`. |
| WKH-207 (Mitad B de WKH-168: persistencia server-side + reconciliación de remesas huérfanas) | DONE (2026-07-16) | Persistencia Postgres propio (Supabase free, decisión founder) + reconcile `manual_review` (auto-retry deferido por PII+dedupe, money-safe). Migración PENDING-DEPLOY. 10/10 ACs, 451/451 tests, AR cazó 1 BLQ money-path (createClient fuera de try/catch) → fix-packeado → re-AR APROBADO. Ver `doc/sdd/019-wkh-207-remittance-persistence-reconciliation/report.md`. |
| WKH-209 (mover el settle REAL del principal de Avalanche a Base — decisión founder, TransFi solo soporta USDC en Base) | DONE (2026-07-17) | Swap parametrizado por red (tabla NETWORKS), Avalanche eliminado. Resuelto el bug latente del domain EIP-712: Base Sepolia usa name `"USDC"`, mainnet `"USD Coin"`. DT-1 resuelto = swap directo. Default fail-safe = Base Sepolia. 11/11 ACs, 460 tests, AR+CR+F4 aprobados 0 BLQ (1 MENOR: comentario stale en submit/route.ts diferido). Flag EIP-3009 OFF, cero plata real. Ver `doc/sdd/020-wkh-209-settle-principal-en-base/done-report.md`. |
| WKH-210 (loop async TransFi — receptor de webhooks sobre el ledger de WKH-207; SPLIT del envío no-custodial) | DONE (2026-07-17) | Cierra la confirmación asíncrona (`fund_settled`/`asset_deposited`/`fund_failed`) que antes solo resolvía `reconcile-orphans` a `manual_review`. 11/11 ACs, 501 tests, AR+CR+F4 0 BLQ. El reorder no-custodial (`to=depositAddress`) es **WKH-211** (F1, ver abajo). Smoke webhook gateado al founder. Ver `doc/sdd/021-wkh-210-transfi-deposit-flow-webhook/done-report.md`. |
| WKH-211 (reorder no-custodial: `to=depositAddress` de TransFi en vez del receiver estático de plataforma — cambio de modelo de seguridad) | DONE (2026-07-18) | Cierra el value-delivery no-custodial end-to-end. F0 encontró 2 hallazgos nuevos que WKH-210 no pudo ver (sin acceso al repo del agente en ese momento): `depositAddress` existe en el tipo interno del agente (WKH-208) pero NO sale por HTTP (dependencia cross-repo bloqueante), y el guard 8/G3 de `submit/route.ts` (atestación de settlement pre-payout) es estructuralmente incompatible con el orden invertido — necesita rediseño, no remoción. Sizing XL. 8/8 ACs, 553 tests, AR+CR+F4 0 BLQ. Ver `doc/sdd/022-wkh-211-non-custodial-deposit-flow/done-report.md`. |

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
de `chaski-v2` están **100% DONE** (2026-07-14/15/16). WKH-168 (G3, Mitad A: settle real, DONE 2026-07-15) cerró el gate que verifica que el DINERO existe antes de disparar el payout (sin él, un atacante con KYC propio aprobado pasa todos los demás gates). WKH-206 (G5, proof-of-possession, DONE 2026-07-16) es el ÚLTIMO de los 5 huecos del gate de Fase A; su F0 encontró que WKH-168 ya cierra la mayor parte del gap para el camino real de dinero via EIP-712 on-chain (ver nota de WKH-206 en el reporte para el detalle honesto). Pipeline QUALITY completo para ambas HUs (F0→F1→F2→F2.5→F3→AR→CR→F4). El residual de persistencia/reconciliación (AC-9 de WKH-168) queda registrado como **WKH-207** (F1, `019`, ver sección VALUE-DELIVERY arriba); los MENOREs de follow-up explícito de WKH-202/206 (oráculo KYC, bug body-null, rate-limit ausente) quedan registrados como **WKH-205** (F1, `018`, ver sección 🟡 DEUDA TÉCNICA arriba) — son las DOS deudas técnicas que quedan documentadas y sin cerrar del gate de Fase A completo.

| HU | Status | Cierre |
|----|--------|--------|
| WKH-198 (Hallazgo A: fail-closed en expiry de quote — guard NaN + shape de fecha) | DONE | 2026-07-14 |
| WKH-199 (Hallazgo B: KYC re-brick — `KycStore.save()` best-effort + reorder) | DONE | 2026-07-14 |
| WKH-200 (Hallazgo C: estados honestos en TrackView + banner demo cubre payout-mock) | DONE | 2026-07-14 |
| WKH-201 (Hallazgo D: `forgetAndDisconnect` purga PII persistida) | DONE | 2026-07-14 |
| WKH-202 (GATE Fase A / G1+enforcement: `/api/a2a/payout/submit`) | DONE | 2026-07-15 |
| WKH-168 (GATE Fase A / G3, Mitad A: settle on-chain verificado) | DONE | 2026-07-15 |
| WKH-206 (GATE Fase A / G5, último hueco: proof-of-possession SIWE) | DONE | 2026-07-16 |
| WKH-205 (follow-ups WKH-202/206: oráculo `/validate`, bug body-null, rate-limit) | DONE | 2026-07-16 |
| WKH-207 (Mitad B de WKH-168: persistencia + reconciliación de huérfanos) | DONE | 2026-07-16 |

**Impacto**: 4 defectos de seguridad/integridad cerrados en auditoría adversarial #2 (hallazgos A-D). Money-path protegido (fail-closed en expiry quote), KYC cache resiliente (best-effort), UI honesta (payout-failed status + demo banner), reset completo (PII purged). Pipeline QUALITY completo (F0→F1→F2→F2.5→F3→AR→CR→F4) para **TODOS los gates de Fase A cerrados**. WKH-202 (DONE 2026-07-15) cerró el enforcement del endpoint de submit. WKH-168 (G3, DONE 2026-07-15) es el gate que verifica que el DINERO existe antes de disparar el payout (sin él, un atacante con KYC propio aprobado pasa todos los demás gates y pide un payout con monto arbitrario). WKH-206 (G5, DONE 2026-07-16) es el último hueco — proof-of-possession del `address`, con el hallazgo honesto de que WKH-168 ya mitiga la mayor parte del riesgo para el camino real de dinero via EIP-712 on-chain (ver report.md para el detalle completo). **Los 5 huecos del gate de Fase A (G1..G5) están cerrados a nivel código.** **WKH-207 (F1, 2026-07-16) es el residual de persistencia/reconciliación, y WKH-205 (F1, 2026-07-16) es el residual de hardening/oráculo — ambos corriendo en paralelo (`018`/`019`) para que el founder pueda declarar "cero deuda técnica" real.**

**Desvíos documentados**:
- **WKH-199 MNR-1**: `project-context.md` creado entero (188 líneas, documental de patrones Chaski v2, no en Story File pero value-added).
- **WKH-200 MNR-1**: Fake-timers test growth artifact documentado en auto-blindaje (T-AC2 poll-count intermitente, workaround en snapshot inicial).
- **WKH-201 MNR-1**: Consumidor `test-container.ts` omitido en Story File, wiring actualizado en F3 (byte-idéntico, fallo de survey).

**NNN Colisión histórica**: 4 analysts paralelos → WKH-198 tomó `012`, WKH-199 probó `012` (colisión) → `013`, WKH-200 probó `012`/`013` (colisiones) → `014`, WKH-201 probó `012`/`013` (colisiones) → `014` (comparte prefijo con WKH-200, carpetas distintas). Stubs obsoletos creados durante F1 (`012-wkh-199-*`, `012-wkh-200-*`, `012-wkh-201-*`, `013-wkh-200-*`, `013-wkh-201-*`), limpiados en esta fase final (git rm). Ver nota de coordinación debajo. **WKH-202 usó `015` sin colisión** (NNN pre-asignado por el orquestador, aplicando la lección de esta sección). **WKH-168 usó `016` sin colisión** (mismo criterio, único analyst corriendo sobre `chaski-v2` en el momento de F1). **WKH-206 usó `017` sin colisión** (mismo criterio; NNN pre-asignado explícitamente por el orquestador, ver nota de WKH-206 arriba). **WKH-205 usó `018` sin colisión** (NNN pre-asignado explícitamente por el orquestador — instrucción "usá el NNN `018` — 015=WKH-202, 016=WKH-168, 017=WKH-206 ya tomados; WKH-207 tomará `019` en paralelo, NO usar 019"). **WKH-207 usó `019` sin colisión** (NNN pre-asignado explícitamente por el orquestador — instrucción "usá el NNN `019` — 015..017 tomados; WKH-205 usa `018` en paralelo, NO usar 018"). **WKH-209 usó `020` sin colisión** (NNN pre-asignado explícitamente por el orquestador — instrucción "usá el NNN `020` — 016..019 tomados", único analyst corriendo sobre `chaski-v2` en el momento de F1).

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

**Confirmación (WKH-207, 2026-07-16)**: la misma lección se aplicó — el orquestador pre-asignó `019` a WKH-207 antes de lanzar el analyst (instrucción explícita "usá el NNN `019` — 015..017 tomados; WKH-205 usa `018` en paralelo, NO usar 018"), sin colisión de NNN. `018` quedó reservado para WKH-205 (follow-ups de WKH-202) — ambas HUs corrieron F1 en paralelo, se coordinó overlap de archivos (`submit/route.ts`, sin overlap de lógica, ver bullets de ambas arriba) entre los dos Analysts sin necesidad de re-lanzar ninguna.

**Confirmación (WKH-205, 2026-07-16)**: la misma lección se aplicó — el orquestador pre-asignó `018` a WKH-205 antes de lanzar el analyst (instrucción explícita "usá el NNN `018` — 015=WKH-202, 016=WKH-168, 017=WKH-206 ya tomados; WKH-207 tomará `019` en paralelo — NO usar `019`"), sin colisión de NNN.

**Confirmación (WKH-209, 2026-07-17)**: la misma lección se aplicó — el orquestador pre-asignó `020` a WKH-209 antes de lanzar el analyst (instrucción explícita "usá el NNN `020` — 016..019 tomados"), sin colisión de NNN. Único analyst corriendo sobre `chaski-v2` en este momento.

**Confirmación (WKH-210, 2026-07-17)**: la misma lección se aplicó — el orquestador pre-asignó `021` a WKH-210 antes de lanzar el analyst (instrucción explícita "usá el NNN `021` — 016..020 tomados"), sin colisión de NNN. Único analyst corriendo sobre `chaski-v2` en este momento.

**Confirmación (WKH-211, 2026-07-17)**: la misma lección se aplicó — el orquestador pre-asignó `022` a WKH-211 antes de lanzar el analyst (instrucción explícita "usá el NNN `022` — 016..021 tomados"), sin colisión de NNN. Único analyst corriendo sobre `chaski-v2` en este momento. A diferencia de WKH-210, este F0 tuvo acceso directo al repo `wasiai-remittance-agents` (presente en el workspace en esta sesión) y pudo verificar de primera mano el estado de WKH-208 y el gap real del output HTTP del agente — ver bullet de WKH-211 arriba para el detalle.

**Confirmación (HU-SOL-1, 2026-07-20)**: mismo criterio — `023` confirmado sin colisión vía `Glob doc/sdd/*/work-item.md` (`022` fue el último NNN usado, WKH-211). Único analyst corriendo sobre `chaski-v2` en este momento.

**Confirmación (HU-SOL-8, 2026-07-22)**: mismo criterio — `027` confirmado sin colisión vía `Glob doc/sdd/02[4-9]*` (`026` fue el último NNN usado, HU-SOL-7). Único analyst corriendo sobre `chaski-v3` en este momento.

**Confirmación (HU-SOL-9, 2026-07-22)**: mismo criterio — `028` pre-asignado explícitamente por el orquestador, sin colisión (confirmado vía `Glob doc/sdd/023*..027*`; `027` = HU-SOL-8, F1 en curso EN PARALELO sobre este mismo repo — ver bullet de HU-SOL-9 arriba y fila en la tabla Solana LATAM Labs abajo).

## ⚪ SOLANA LATAM LABS (2026-07-20, nuevo programa)

**Objetivo del programa**: portar el settlement no-custodial de Chaski a **Solana**, manteniendo el
path EVM (Base, EIP-3009, WKH-168/202/206/207/209/210/211) 100% vivo — arquitectura multi-VM, no un
reemplazo. Roadmap inicial planificado de 4 HUs, ampliado por hallazgos de F0 sucesivos; Sprint 2
ejecutó HU-SOL-1 (023, DONE 2026-07-21) + HU-SOL-4 (024, DONE 2026-07-21) + HU-SOL-5 (025, DONE
2026-07-21) + HU-SOL-7 (026, DONE 2026-07-21). Sprint 3 (Seguridad + e2e) ejecuta HU-SOL-8 (027, F1)
+ HU-SOL-9 (028, F1) en paralelo:

| HU (programa) | Jira | Título | Estado | Bloquea / Bloqueado por |
|----------------|------|--------|--------|--------------------------|
| HU-SOL-1 | WKH-206* | Config de red multi-VM (`chain.ts`) + `VmAuthorization` discriminado (`ports.ts`) — fundación, sin wallet ni firma Solana | **DONE (2026-07-21)** | Bloqueaba a HU-SOL-4 |
| HU-SOL-4 | WKH-212 | **Integración `@solana/wallet-adapter-react`**: árbol providers condicional (Phantom/Solflare), singleton bridge React-free, puenteado al `WalletPort`. Path EVM byte-idéntico (AC-3). Firma SPL (HU-SOL-2) / PoP (HU-SOL-8) / settle Solana OUT. | **DONE (2026-07-21)** | Bloquea a HU-SOL-2 (firma SPL) + HU-SOL-8 (PoP) |
| HU-SOL-5 | WKH-207* | Wallet Solana firma el `deposit` al escrow (gasless-facilitator): `authorizePrincipal` construye ix escrow Anchor, feePayer=facilitator, partial-sign SOLO wallet, retorno tx serializada + reference. Path EVM byte-idéntico. | **DONE (2026-07-21)** — 8/8 ACs, 594 tests (586 base + 8 Solana), AR+CR+F4 APROBADO. BLQ-MED-1 (CR: `node:crypto` browser) fix-packeado con `@noble/hashes`. Branch `feat/025-hu-sol-5-wallet-deposit-escrow` commit `79ff56b`. | Bloqueada por HU-SOL-4 (resuelto 2026-07-21); bloquea a HU-SOL-13 (verificación server-side) + HU-SOL-14 (broadcast gasless) |
| HU-SOL-7 | WKH-213 | Identidad Solana base58 (equivalent a EIP-4361/SIWE para Solana, Proof-of-Possession) | **DONE (2026-07-21)** — 9/9 ACs PASS, 586 tests, AR+CR+F4 0 BLQ. `canonicalizeAddress(address, vm)` cierra un IDOR cross-tenant (`.toLowerCase()` corrompe base58). Branch `feat/026-hu-sol-7-identidad-base58` commit `e65bae6`. | Bloquea a HU-SOL-8 (PoP ed25519) + HU-SOL-9 (settle Solana) |
| HU-SOL-8 | WKH-211* | **PoP + atestación ed25519 (GATE DE SEGURIDAD)**: el gate G5 (WKH-206) solo verifica ECDSA (`viem.verifyMessage`/`isAddress`), que SIEMPRE rechaza una address Solana. Agrega verificador ed25519 real (`nacl.sign.detached.verify` + decode base58 estricto), vuelve PoP OBLIGATORIO (no opt-in) en el money-path Solana (binding Didit débil, `authority.ts:74-87`), ata las atestaciones a un network-id CAIP-2 (anti replay cross-cluster). | **F1 (2026-07-22)** — 8 ACs EARS, 5 DT-N, 8 CD-N. 3 `[NEEDS CLARIFICATION]` NO bloqueantes para F2 (firma de mensaje arbitrario en `WalletPort` Solana, shape CAIP-2, resolución de `tweetnacl`). | Bloqueada por HU-SOL-7 (resuelto 2026-07-21) + HU-SOL-5 (resuelto 2026-07-21); bloquea a HU-SOL-9 (settle Solana) |
| HU-SOL-9 | WKH-208 | **Binding no-custodial + wire al facilitator**: ramifica la validación de address por VM (base58 cuando `vm==="solana"`) en `deposit-attestation.ts`, `settle/principal/route.ts` (S12/B1-B6) y `prepare/route.ts` (PR4/PR8), y hace que `facilitator-client.ts` construya un payload Solana representable hacia `/settle`. Con el escrow futuro (HU-SOL-13) el binding pasa a ser la authority del `release` (`to` atestado == `beneficiary` del escrow). | **F1 (2026-07-22)** — 6 ACs EARS, 5 DT-N, 7 CD-N. **1 `[NEEDS CLARIFICATION]` BLOQUEANTE cross-repo**: el schema Zod HTTP de `wasiai-facilitator` (`core/schemas.ts::AcceptedSchema`) rechaza `asset`/`payTo` base58 en ambas ramas del union — nombrado explícitamente por el propio report de HU-SOL-6 como responsabilidad de esta HU, pero esta HU tiene prohibido tocar ese repo (recomendado companion ticket separado). 4 `[NEEDS CLARIFICATION]` NO bloqueantes adicionales. | Depende de HU-SOL-5/HU-SOL-6/HU-SOL-7 (DONE); bloqueada por HU-SOL-8 (hallazgo de F0, activación real) + companion ticket cross-repo del facilitator (e2e-reachability); bloquea a HU-SOL-13 (release authority) |

*Nota de numeración*: el ticket Jira reusado para HU-SOL-1 es **WKH-206** (mismo número que "proof-of-possession" EVM, ya DONE 2026-07-16); **HU-SOL-5 es WKH-207** (mismo número que "Persistencia server-side + reconciliación de remesas huérfanas" del plan chaski-v2, ya DONE 2026-07-16 — reuso intencional cross-programa, mismo patrón que HU-SOL-1); **HU-SOL-8 es WKH-211** (mismo número que "Value-delivery no-custodial" de chaski-v2, ya DONE 2026-07-18 — reuso intencional cross-programa, mismo patrón); **HU-SOL-9 es WKH-208** (mismo número que "remit-cashout-payout", ya DONE — reuso intencional cross-programa, mismo patrón) — el programa Solana LATAM Labs usa su propia numeración de HU (`HU-SOL-N`) independiente del backlog Jira `WKH-NNN` de `chaski-v2`; se documenta ambos IDs en el work-item para trazabilidad. HU-SOL-4/WKH-212 es wallet-adapter-react (conexión pura, sin firma); HU-SOL-2 será firma SPL (OUT de HU-SOL-4); HU-SOL-8/WKH-211 es PoP Solana (OUT de HU-SOL-4, DEPENDE de HU-SOL-7); HU-SOL-6/WKH-205 (adaptador Solana del `wasiai-facilitator`, repo externo) está **DONE pero HELD** (branch `feat/026-wkh-205-solana-adapter` sin merge/deploy) — su propio report nombra a HU-SOL-9 como el follow-up del wire-format HTTP. Falta HU-SOL-3 en el roadmap (posiblemente reserved para escrow Solana, análogo a WKH-168/WKH-211 del lado Solana) y HU-SOL-13/HU-SOL-14 (release authority / broadcast gasless) están planificadas pero sin F1 aún. Ver `doc/sdd/023-hu-sol-1-multi-vm-config/work-item.md`, `doc/sdd/024-hu-sol-4-wallet-adapter/report.md`, `doc/sdd/025-hu-sol-5-wallet-deposit-escrow/report.md`, `doc/sdd/026-hu-sol-7-identidad-base58/report.md`, `doc/sdd/027-hu-sol-8-pop-ed25519/work-item.md` y `doc/sdd/028-hu-sol-9-binding-wire-facilitator/work-item.md`.
