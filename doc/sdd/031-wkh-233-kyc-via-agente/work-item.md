# Work Item — [WKH-233] Chaski v3 debe consumir el agente `remit-kyc-validator` (A2A), no Didit directo

## Resumen
Chaski v3 llama a Didit directamente en 3 sitios (`app/api/kyc/session`, `app/api/kyc/decision`,
`src/infrastructure/payout/authority.ts`) para el hard-gate de KYC/compliance, en vez de componer
un agente vía A2A como ya hace con `remit-corridor-fx` (cotiza) y `remit-cashout-payout` (payout).
El agente `remit-kyc-validator` ya existe (WKH-170, marketplace A2A) pero su contrato HTTP actual
(`POST /invoke`, síncrono, exige `legalId` en claro del caller) **no es compatible** con el flujo
hosted-redirect + document-scan/liveness que Chaski usa hoy — swapearlo literalmente sería una
regresión de seguridad y de UX (ver Missing Inputs #1, BLOQUEANTE). Objetivo final: Chaski deja de
leer `DIDIT_API_KEY`/`DIDIT_WORKFLOW_ID`/`DIDIT_BASE_URL`, y el KYC viaja 100% vía A2A al agente
(que encapsula Didit por debajo), preservando el hard-gate fail-closed y el binding sesión↔caller.

## Sizing
- SDD_MODE: full
- Estimación: L (3 call-sites a rewirear + flag nuevo + dependencia cross-repo + test coverage
  completo del path money/compliance)
- Branch sugerido: `feat/031-wkh-233-kyc-via-agente`
- Categorías de riesgo: **auth** (binding sesión↔caller, ownership WKH-53-equivalente vía
  `canonicalizeAddress`), **compliance** (hard-gate KYC/AML, `payoutAllowed`), **PII**
  (legalId/DNI, travel-rule data — CERO debe cruzar el borde HTTP en claro salvo dentro del agente),
  **money-path** (gatea `Remittance.confirm()` y `resolvePayoutAuthority`, que a su vez gatea el
  desembolso). → **QUALITY**, pipeline completo (F0→F1→F2→F2.5→F3→AR→CR→F4).

## Grounding (F0 — archivo:línea real)

### Chaski v3 hoy (llama a Didit DIRECTO en 3 sitios)
1. `chaski-v3/app/api/kyc/session/route.ts:34,63-72` — POST `${DIDIT_BASE}/v3/session/` con
   `x-api-key: DIDIT_API_KEY`, `workflow_id: DIDIT_WORKFLOW_ID`, `vendor_data` = address del sender.
   Antes del fetch: rate-limit (`:47-56`), callback server-side (`:60-61`). Emite `authToken` HMAC
   (`kyc-auth.ts:20-22`, WKH-179 B1).
2. `chaski-v3/app/api/kyc/decision/route.ts:13,30-33` — GET
   `${DIDIT_BASE}/v3/session/{id}/decision/` con `x-api-key`. Exige `x-kyc-token` válido ANTES de
   llamar a Didit (`:25-28`, WKH-179).
3. `chaski-v3/src/infrastructure/payout/authority.ts:15,58-61` — RE-verificación server-side
   independiente en tiempo de payout (`resolvePayoutAuthority`, WKH-180/202): GET
   `${DIDIT_BASE}/v3/session/{id}/decision/` con `x-api-key`, mapea `mapDiditDecision`, valida
   ownership (`vendor_data` vs `address`, `:85-87`). Guard-order completo: sin-key+prod→503
   fail-loud (`:32-35`), sin-key+no-prod→`simulated_dev` (`:37-44`), formato (`:48-50`), Didit
   (`:58-93`).
4. `chaski-v3/src/infrastructure/didit/kyc-gateway.ts` (`DiditKycGateway`) — cliente que llama a
   `/api/kyc/session`/`/api/kyc/decision` (NO Didit directo). Cableado SIN flag (hardcoded) en
   `chaski-v3/src/composition/container.ts:88`: `const kyc = new DiditKycGateway(new
   FallbackKycGateway());` — a diferencia de `quotes`/`payouts` (`:85,89`) que SÍ están gateados
   por `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` (`:71,84`).
5. Patrón A2A exemplar YA existente: `chaski-v3/src/infrastructure/a2a/gateways.ts`
   (`A2aQuoteGateway`, `A2aPayoutGateway`) → `chaski-v3/app/api/a2a/quote/route.ts` (proxy
   server-only, `REMIT_AGENTS_BASE_URL` server-only CD-9, `:28-46`) → agente vía
   `${BASE}/api/agents/remit-corridor-fx/invoke`.

### Agente `remit-kyc-validator` (repo `wasiai-remittance-agents`, WKH-170, DONE código/PENDING-DEPLOY)
- Endpoint HTTP: `src/app/api/agents/remit-kyc-validator/invoke/route.ts` — `POST /invoke`
  SÍNCRONO. Envuelve `runKycValidator` (`src/agents/kyc-validator.ts:73-96`).
- Input (`KycInputSchema`, `kyc-validator.ts:16-24`): `{senderName, senderCountry, legalId,
  amountUsd, receiverName, receiverCountry, purpose}` — **`legalId` (DNI) en claro, provisto por
  el caller**. Output (`:34-43`): `{slug, approved, riskLevel, reasons, verificationId,
  provenance, payoutAllowed}` — PII NUNCA se ecoa en el output (BLQ-MED-1, ya fixeado).
- Provider Didit del agente (`wasiai-remittance-agents/src/providers/kyc.ts:29-66`,
  `DiditKycProvider.verify`): POST `${DIDIT_BASE}/v2/session/` (**API v2**, no v3) con
  `vendor_data: legalId`, `features:["ID_VERIFICATION","LIVENESS","AML"]`, y **trata la respuesta
  como síncrona** (`data.status` ya resuelto) — marcado explícitamente `TODO(sandbox): confirmar
  el payload exacto de Didit` (`:41`, `:52`). Gateado fail-loud detrás de
  `DIDIT_ADAPTER_READY==='true'` (`:240-245`); sin evidencia de que ese flag esté confirmado/activo
  en ningún ambiente — a diferencia del flujo v3 hosted-redirect de Chaski, que SÍ está LIVE en
  producción (engram: "Chaski v2 · Didit KYC LIVE", 2026-07-XX).
- El agente **no tiene** endpoints tipo `POST /session` + `GET /decision` que espejen el flujo
  hosted-redirect real de Didit (v3, document-scan + liveness). Solo el `/invoke` síncrono.

### Hallazgo crítico de F0 (bloqueante, ver Missing Inputs #1)
Un swap literal de Chaski al contrato `/invoke` actual del agente:
1. Obligaría a Chaski a **recolectar el DNI/legalId en claro** del usuario (campo de texto) —
   reabre exactamente la superficie de PII-en-tránsito que **WKH-179** cerró en este mismo repo
   (IDOR/PII-leak de KYC).
2. **Elimina el document-scan + liveness** hospedado de Didit (la parte que hace el KYC
   SBS-compliant para Perú) a cambio de un check síncrono por número de documento.
3. Depende de la integración Didit del AGENTE, que está **sin confirmar contra sandbox** (3 TODOs
   abiertos en `kyc.ts`, `DIDIT_ADAPTER_READY` no confirmado activo) — mientras que el flujo v3 que
   Chaski ya tiene es el que está LIVE y probado.
4. El agente tampoco expone un endpoint de **re-verificación por `verificationId`** equivalente al
   que `resolvePayoutAuthority` necesita en tiempo de payout (WKH-180/202) — el `/invoke` es
   una operación única, no re-consultable.

Por esto, DT-1 (abajo) recomienda **NO** hacer el swap literal — ver Missing Inputs #1/#2
(BLOQUEANTES para F2).

## Acceptance Criteria (EARS)
- AC-1: WHEN `NEXT_PUBLIC_KYC_ADAPTER=="a2a"` AND el sender inicia KYC, the system SHALL crear la
  sesión de verificación invocando `remit-kyc-validator` a través del proxy server-only A2A (nunca
  llamando a Didit directamente desde código de `chaski-v3`).
- AC-2: WHILE `NEXT_PUBLIC_KYC_ADAPTER` está ausente o vale `"didit"` (default), the system SHALL
  preservar el flujo `DiditKycGateway` (session-redirect) byte-idéntico al actual.
- AC-3: WHEN se consulta la decisión de KYC (`ResumeKyc`/`GET /api/kyc/decision`) AND
  adapter=="a2a", the system SHALL resolver `approved`/`payoutAllowed`/`riskLevel` desde el
  endpoint de decisión del agente, nunca desde un fetch directo a `verification.didit.me` en código
  de `chaski-v3`.
- AC-4: IF el agente `remit-kyc-validator` es inalcanzable, hace timeout, o devuelve un shape
  inválido, THEN the system SHALL fallar cerrado (`payoutAllowed:false`, sin fallback silencioso a
  `approved:true`), preservando los mismos status/errores hoy vigentes
  (`502 a2a_unavailable`/`didit_decision_failed`).
- AC-5: WHEN `resolvePayoutAuthority` re-verifica la autoridad de payout AND adapter=="a2a", the
  system SHALL re-consultar la decisión de KYC vía el agente (por `verificationId`) en vez de
  llamar a Didit directamente, preservando el guard-order existente (sin-key+prod→503 fail-loud,
  sin-key+no-prod→`simulated_dev`, guard de formato, ownership `vendor_data` vs `address`).
- AC-6: WHERE adapter=="a2a", the system SHALL NOT leer `DIDIT_API_KEY`/`DIDIT_WORKFLOW_ID`/
  `DIDIT_BASE_URL` en ningún código de `chaski-v3` (verificable por grep, cero matches en el path
  a2a).
- AC-7: the system SHALL preservar sin cambios de comportamiento el binding HMAC sesión↔caller
  (`kyc-auth.ts`, WKH-179 B1) y el rate-limit (`checkKycRateLimit`) independientemente del valor
  del adapter — ambos guards viven en las rutas de Chaski, no en el backend de KYC.
- AC-8: WHEN `resolveActiveVm()==="solana"`, the system SHALL aplicar el mismo flujo KYC
  gateado-por-adapter sin divergencia de guard-order respecto al path EVM (mismo
  `canonicalizeAddress` VM-aware ya usado en `kyc-store.ts`/`authority.ts`).
- AC-9: WHILE los endpoints companion del agente (`POST /session`, `GET /decision` en
  `wasiai-remittance-agents`) no existan/estén deployados y verificados, the system SHALL mantener
  `NEXT_PUBLIC_KYC_ADAPTER` en default OFF (`"didit"`) en todo ambiente compartido — el path a2a
  queda code-complete pero no habilitado (mismo patrón PENDING-DEPLOY de WKH-167/169/170).

## Scope IN
- `chaski-v3/src/infrastructure/a2a/gateways.ts` — nuevo `A2aKycGateway` (implementa el port
  `KycGateway`, mismo patrón que `A2aQuoteGateway`/`A2aPayoutGateway`).
- `chaski-v3/app/api/kyc/session/route.ts` — rewire condicional: adapter=="a2a" → proxy al agente
  (`${REMIT_AGENTS_BASE_URL}/api/agents/remit-kyc-validator/session`); adapter default → código
  actual sin cambios.
- `chaski-v3/app/api/kyc/decision/route.ts` — mismo rewire condicional hacia
  `GET .../remit-kyc-validator/decision`.
- `chaski-v3/src/infrastructure/payout/authority.ts` (`resolvePayoutAuthority`) — rewire
  condicional del guard "Didit real" para re-consultar vía el agente cuando adapter=="a2a".
- `chaski-v3/src/composition/container.ts` — flag-gatear el wiring de `kyc` (hoy hardcodeado
  `:88`), nueva env `NEXT_PUBLIC_KYC_ADAPTER`.
- `.env.example` de `chaski-v3` — documentar el flag nuevo; anotar que `DIDIT_*` deja de ser
  requerido cuando el flag está en `"a2a"` (se mantiene como default/fallback).
- Tests: `gateways.test.ts`, `kyc/session/route.test.ts`, `kyc/decision/route.test.ts`, tests de
  `authority.ts` (si no existen, crear), `container.test.ts`.

## Scope OUT
- **`wasiai-remittance-agents`** (repo externo) — PROHIBIDO tocarlo desde esta HU (CD-3). Los 2
  endpoints companion (`POST /session`, `GET /decision`) son un **ticket cross-repo separado**
  (ver DT-4/Missing Inputs #2).
- Confirmación del sandbox Didit del agente / flip de `DIDIT_ADAPTER_READY` — deuda técnica propia
  de `wasiai-remittance-agents`, no de esta HU.
- Remover el código Didit de Chaski (`DiditKycGateway`, `kyc-gateway.ts`, `decision.ts`) — se
  conserva como default/fallback (CD-2 del container, mismo patrón que `FallbackQuoteGateway`).
- Cambios de UX/UI del flujo KYC (redirect, pantallas, copy) — la experiencia hosted-redirect se
  preserva intacta.
- `kyc-store.ts` (cache KYC-once), `kyc-pending-store.ts` (resume), y la lógica de dominio
  `Remittance.confirm()` — solo cambia el TRANSPORTE del KYC, no la máquina de estados.
- `app/api/a2a/payout/submit/route.ts` (WKH-202/206) — no se toca directamente; solo su
  dependencia `resolvePayoutAuthority` cambia de transporte por dentro.

## Decisiones técnicas (DT-N)
- DT-1: **Opción A (recomendada, requiere ratificación — Missing Inputs #1 BLOQUEANTE)**: el
  agente gana 2 endpoints nuevos que espejan 1:1 el flujo hosted-redirect real de Didit
  (`POST /session`, `GET /decision`), y Chaski se vuelve un proxy delgado (mismo patrón que
  `/api/a2a/quote`). Se **descarta** la Opción B (swap literal al `/invoke` síncrono con `legalId`)
  por las 4 razones del hallazgo crítico de F0 arriba.
- DT-2: flag **dedicado** `NEXT_PUBLIC_KYC_ADAPTER` (`"didit"` default | `"a2a"`), independiente de
  `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` (quote/payout) — el KYC es el hard-gate de compliance y
  necesita poder activarse/revertirse sin acoplar el rollout de quote/payout. A confirmar nombre
  exacto con el Architect (Missing Inputs #3).
- DT-3: el guard-order completo de `resolvePayoutAuthority` (no-key/prod fail-loud 503,
  no-key/non-prod `simulated_dev`, guard de formato, ownership check) se preserva 1:1; solo cambia
  el transporte del "Guard 2: Didit real" (Didit directo → agente).
- DT-4: el ticket companion cross-repo (`wasiai-remittance-agents`) debe ser, en la medida de lo
  posible, un **lift-and-shift** de la lógica YA PROBADA de
  `chaski-v3/app/api/kyc/session/route.ts` + `kyc/decision/route.ts` (workflow_id, vendor_data,
  callback server-side) hacia el agente — minimiza drift de comportamiento respecto de reescribir
  la integración v2 no confirmada que el agente ya tiene en `providers/kyc.ts`.
- DT-5: `KYC_SESSION_SECRET` (HMAC sesión↔caller) y el rate-limit (`checkKycRateLimit`) **quedan en
  Chaski** — son controles del lado del caller (anti-abuso/anti-IDOR de ESTE repo), el agente no
  conoce el modelo de identidad de Chaski.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO leer `DIDIT_API_KEY`/`DIDIT_WORKFLOW_ID`/`DIDIT_BASE_URL` en cualquier código
  nuevo del path `adapter==="a2a"`.
- CD-2: OBLIGATORIO fail-closed: cualquier error/timeout/shape-inválido del agente en el path KYC
  mapea a `payoutAllowed:false`/502 — NUNCA a `approved:true` por default o ausencia de dato.
- CD-3: PROHIBIDO tocar el repo `wasiai-remittance-agents` desde esta HU.
- CD-4: OBLIGATORIO `NEXT_PUBLIC_KYC_ADAPTER` default OFF (`"didit"`) en todo ambiente
  compartido/prod hasta que el companion ticket esté DONE + deployado + verificado con smoke E2E.
- CD-5: PROHIBIDO ecoar PII (legalId, documentNumber completo, travelRuleData) en logs/errores de
  cualquier punto nuevo de este wiring.
- CD-6: OBLIGATORIO preservar byte-idéntico el path EVM y el path Solana — cero divergencia de
  guard-order entre VMs (reusar `canonicalizeAddress`/`resolveActiveVm`).
- CD-7: OBLIGATORIO mantener `kyc-auth.ts` y `rate-limit.ts` sin cambios de comportamiento.
- CD-8: PROHIBIDO ampliar el scope a `Remittance.confirm()`, `kyc-store.ts`, `kyc-pending-store.ts`
  — solo cambia el transporte del KYC, no la máquina de estados de dominio.

## Missing Inputs
- [BLOQUEANTE] #1 — DT-1: ¿Opción A (session-proxy, agente gana 2 endpoints nuevos que espejan
  Didit v3 hosted-redirect) vs Opción B (swap literal al `/invoke` síncrono con `legalId`, que el
  Analyst **desaconseja firmemente** por reabrir PII-en-tránsito tipo-WKH-179 + perder
  document-scan/liveness + depender de una integración Didit no confirmada)? Requiere ratificación
  del founder antes de que el Architect cierre el SDD.
- [BLOQUEANTE] #2 — el ticket companion cross-repo en `wasiai-remittance-agents` (2 endpoints
  nuevos) **no existe hoy**. El Architect debe decidir si F2 de esta HU espera ese companion ticket
  (secuenciado) o entrega el path `a2a` code-complete-pero-permanentemente-OFF hasta que el
  companion exista (mismo patrón PENDING-DEPLOY ya usado en WKH-167/169/170/210/211).
- [NEEDS CLARIFICATION] #3 — nombre exacto del flag nuevo (`NEXT_PUBLIC_KYC_ADAPTER` propuesto por
  el Analyst) — a confirmar con el Architect, dado que el patrón existente usa un único flag
  (`NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`) para quote+payout (WKH-186/DT-4).
- [NEEDS CLARIFICATION] #4 — si el companion ticket debe descartar la integración Didit v2 no
  confirmada que el agente ya tiene en `providers/kyc.ts` a favor de un lift-and-shift del código
  v3 ya probado de Chaski (DT-4, recomendado) — decisión del Architect del repo
  `wasiai-remittance-agents`.

## Análisis de paralelismo
- Bloquea/depende de un ticket nuevo cross-repo en `wasiai-remittance-agents` (companion, sugerido
  nombre a definir por el orquestador, p.ej. WKH-234) — el flag `NEXT_PUBLIC_KYC_ADAPTER` queda
  default OFF hasta que ambas mitades estén DONE + deployadas + verificadas.
- NO bloquea ninguna otra HU activa de `chaski-v3`: el flag nuevo es aditivo y default OFF, y el
  Scope IN no colisiona con el trabajo Solana en curso (HU-SOL-*, todos en `doc/sdd/023..030`)
  salvo por `container.ts`, donde el cambio es aditivo (nuevo `if` de wiring, no toca las ramas
  Solana existentes) — riesgo de colisión de líneas BAJO, coordinar orden de merge si alguna HU
  Solana toca `container.ts` en la misma ventana.
- Puede correr en paralelo con cualquier HU que no toque `container.ts`, `app/api/kyc/*`,
  `src/infrastructure/payout/authority.ts` o `src/infrastructure/a2a/gateways.ts`.
