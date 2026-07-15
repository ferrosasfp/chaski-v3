# Work Item — [WKH-202] [GATE Fase A] Hardening del enforcement de `/api/a2a/payout/submit`

## Resumen
`app/api/a2a/payout/submit/route.ts` es hoy un proxy POST público sin ninguna autorización que
forwardea `amountUsd`/`beneficiary`/`kycVerificationId` verbatim al agente real
`remit-cashout-payout`. Es inofensivo SOLO porque `REMIT_AGENTS_BASE_URL` no está seteada en
Vercel (guard fail-closed 501 vigente). El día que la Fase A setee esa env var, el endpoint queda
abierto a que cualquiera dispare un desembolso real con monto/beneficiario arbitrario. Esta HU es
el **gate obligatorio** antes de habilitar esa env var: construye el enforcement server-side
(auth + re-validación de KYC/ownership) que hoy no existe.

## Sizing
- SDD_MODE: full
- Estimación: M (toca contrato de puertos + 2 rutas + 1 use-case + tests; sin UI)
- Branch sugerido: `feat/015-wkh-202-payout-submit-hardening`

**Clasificación: QUALITY.** Justificación: (1) toca directamente el money-path real (el endpoint
que dispara desembolsos) y la superficie de auth del repo; (2) el propio `project-context.md`
exige NexusAgil QUALITY siempre en `chaski-v2`; (3) el hallazgo es equivalente en severidad a un
IDOR/broken-auth (cualquiera en internet puede invocar un desembolso arbitrario) — la misma clase
de bug que motivó WKH-146/161 (cobraya) y WKH-179/180 (chaski-v2), ambas QUALITY. FAST/LAUNCH
quedan descartados: no es un fix cosmético ni de UI, es el gate de compliance de un pago real.

## Skills Router
No se encontró `.agent/skills/` ni un skills-router en `chaski-v2` (repo standalone, distinto de
`wasiai-a2a`). Declarando 2 etiquetas de dominio manualmente en su lugar:
- **api-auth-hardening** (server-side authorization guards, fail-closed by default)
- **money-path-integrity** (invariantes de negocio que protegen movimiento de valor real)

## Grounding (F0) — verificado en disco, con correcciones al input del orquestador

- `app/api/a2a/payout/submit/route.ts` (52 líneas) — confirmado: NO hay ninguna autorización.
  Guard fail-closed único: `if (!BASE) return 501` (L32). El body se forwardea tal cual en L38
  (`body: JSON.stringify(body)`), sin tocar `amountUsd`/`beneficiary`/`kycVerificationId`/
  `kycPayoutAllowed`. La única validación es de **shape de la respuesta** (`isValidPayoutResult`,
  L14-28) — confirma la premisa de la HU. Corrección menor: el comentario CD-10 vive en el
  bloque de cabecera L1-6 (no en L28 como cita el input).
- **`app/api/a2a/payout/submit/route.test.ts` YA EXISTE** (7 tests, de WKH-186) — el input del
  orquestador lo trataba como archivo a crear; en realidad hay que **extenderlo preservando los 7
  tests actuales** (guard BASE-unset, forwarding ok, upstream 502, bad-shape 502, 2 casos MNR-C
  payoutId-null, fetch-throw 502). Ninguno cubre auth/validación de request — confirma el gap.
- `src/infrastructure/payout/payout-authority-gateway.ts` (`HttpPayoutAuthorityGateway`) — EXISTE
  tal como lo cita el input: adapter cliente que llama `/api/payout/validate`, fail-closed en
  cualquier error de red/parse (CD-A4).
- `app/api/payout/validate/route.ts` — EXISTE tal como lo cita el input: autoridad server-side
  (WKH-180) que re-consulta Didit real, con guard-order documentado (sin key+prod → 503 fail-loud;
  sin key+no-prod → simulación; con key → formato → Didit → mapeo → ownership por
  `vendor_data`/`address`). **Exemplar principal para el fix de esta HU.**
- `app/api/kyc/decision/route.ts` + `src/infrastructure/kyc-auth.ts` — EXISTEN tal como los cita
  el input: patrón de auth por token HMAC (`x-kyc-token`, `issueSessionToken`/
  `verifySessionToken`, timing-safe). Limitación documentada explícitamente en el propio archivo
  (`kyc-auth.ts:7`): NO prueba posesión de wallet, es replayable si se filtra, SIWE queda
  deferred — dato relevante para no sobre-prometer en el diseño de F2.
- `src/application/use-cases/confirm-and-send.ts` — EXISTE tal como lo cita el input. Confirmado
  el hallazgo clave: el paso 2 (L60-72) llama `authority.authorize({verificationId, address})`
  ANTES de `payouts.submit()` (paso 4, L100-110), pero **toda la orquestación es client-side**. Si
  un atacante se salta este use-case y llama `POST /api/a2a/payout/submit` directo, nada de este
  chequeo corre — no hay ningún vínculo server-side entre "se re-validó la autoridad" y "se
  ejecutó el submit". Esto es la causa raíz exacta del hallazgo.
- `src/domain/remittance.ts` — el gate `confirm_requires_kyc_passed` vive en `confirm()`,
  **L227-234** (el input citaba L219-222, de una nota histórica de WKH-187 ya desactualizada por
  cambios posteriores de línea — sin impacto de fondo, mismo gate).
- `src/application/ports.ts` — hallazgo NUEVO no anticipado por el input: **`PayoutSubmit`
  (L63-70) NO incluye `address`**. `PayoutAuthorityGateway.authorize()` (L97-104) exige
  `{verificationId, address}`, pero ese `address` nunca llega al `PayoutGateway.submit()` —
  confirma que hoy es estructuralmente imposible re-validar ownership dentro de la ruta
  `/api/a2a/payout/submit`, aunque quisiéramos, sin antes extender el contrato.
- `src/infrastructure/a2a/gateways.ts` — `A2aPayoutGateway.submit()` (L119-138) postea
  `{quoteId, amountUsd, kycVerificationId, kycPayoutAllowed: true (HARDCODEADO, "DT-5:
  sintetizado", L127), beneficiary, idempotencyKey}` — nunca `address`. El campo
  `kycPayoutAllowed: true` está sintetizado por el CLIENTE, no verificado server-side en el submit.
- `project-context.md:33-35` — confirmado: **NO hay persistencia server-side de quotes/remesas**
  (`src/infrastructure/persistence.ts` es `localStorage`-based, solo client-side). Esto es una
  limitación arquitectónica real: el enforcement de esta HU puede re-validar KYC/ownership contra
  Didit, pero NO puede (sin agregar infraestructura server-side nueva) verificar que
  `amountUsd`/`beneficiary` del submit coincidan con una remesa cotizada real. Ver Missing Inputs.
- `.env.example` — confirmado: `REMIT_AGENTS_BASE_URL` (server-only, sin `NEXT_PUBLIC_`) y
  `KYC_SESSION_SECRET` (HMAC de `kyc-auth.ts`) ya documentados; ninguna env var de "payout auth"
  existe todavía.
- `app/api/a2a/quote/route.ts` — confirmado Scope OUT: mismo patrón de proxy que `payout/submit`
  pero cotizar no mueve dinero; el guard 501 (CD-9) se mantiene sin cambios, fuera de esta HU.
- **`product-context.md` NO existe** en `chaski-v2` (solo `project-context.md`, 188 líneas,
  bootstrapeado en WKH-188). Marcado `[SIN PRODUCT CONTEXT]` — se sigue con el contexto de negocio
  provisto en el prompt del orquestador (remesas USDC→PEN→Yape, KYC Didit, payout TransFi vía
  agentes A2A, WasiAI como capa de orquestación).

## Acceptance Criteria (EARS)

- **AC-1**: IF `POST /api/a2a/payout/submit` recibe un request sin evidencia server-side
  verificable de autorización de payout (re-validación de que el `kycVerificationId` está
  `Approved` y pertenece al caller), THEN the system SHALL responder con un código de error (4xx)
  y SHALL NOT invocar `fetch` hacia `REMIT_AGENTS_BASE_URL`.
- **AC-2**: WHEN el enforcement re-valida la autorización y el resultado es `authorized:false`
  (cualquier `reason` del vocabulario ya establecido en `PayoutAuthorization`,
  `src/application/ports.ts:97-100` — `kyc_not_approved`/`kyc_reauth_failed`/
  `kyc_ownership_mismatch`/etc.), the system SHALL responder sin forwardear el submit al agente.
- **AC-3**: WHILE `REMIT_AGENTS_BASE_URL` no está seteada, the system SHALL seguir respondiendo
  501 `a2a_not_configured` (comportamiento actual de `route.ts:32` intacto, sin regresión,
  independiente del resultado del guard de autorización nuevo).
- **AC-4**: WHEN el request está autorizado (KYC `Approved` + ownership verificado) Y
  `REMIT_AGENTS_BASE_URL` está configurada, the system SHALL forwardear el request al agente
  `remit-cashout-payout` preservando el comportamiento ya existente (nunca loguea `beneficiary`
  ni PII, nunca ecoa `BASE` en la respuesta, `idempotencyKey` forwardeado intacto — CD-5/CD-9/CD-10
  preexistentes).
- **AC-5**: IF la re-validación server-side de autoridad falla por causa técnica (timeout/DNS/
  parse del fetch a Didit, o falta una env var requerida por el guard nuevo), THEN the system SHALL
  fail-closed (rechazar el submit; NUNCA autorizar por default) — mismo principio que
  `payout-authority-gateway.ts` (CD-A4) y `payout/validate/route.ts` (CD-4).
- **AC-6**: the system SHALL preservar en verde los 7 tests existentes de
  `app/api/a2a/payout/submit/route.test.ts` (guard BASE-unset, forwarding ok con 200, upstream
  502, bad-shape 502, los 2 casos MNR-C de `payoutId:null`, fetch-throw 502) sin modificar su
  comportamiento esperado.
- **AC-7**: IF el request pasa la autorización pero el shape de la respuesta del agente es
  inválido (comportamiento YA existente, `isValidPayoutResult`), THEN the system SHALL seguir
  respondiendo 502 `a2a_bad_shape` exactamente como hoy — sin cambios de este comportamiento
  (evita regresión de WKH-186/MNR-C).

## Scope IN
- `app/api/a2a/payout/submit/route.ts` — agregar el guard de autorización server-side.
- `app/api/a2a/payout/submit/route.test.ts` — extender con tests nuevos de auth/validación,
  preservando los 7 tests existentes.
- Módulo de re-validación reusado/extraído de `app/api/payout/validate/route.ts` (evitar 2
  implementaciones divergentes del mismo guard-order Didit — exacto refactor es de F2).
- `src/application/ports.ts` — extender `PayoutSubmit` con `address` (necesario para que el
  enforcement pueda verificar ownership; ver DT-2).
- `src/infrastructure/a2a/gateways.ts` — `A2aPayoutGateway.submit()`: forwardear `address` en el
  body.
- `src/application/use-cases/confirm-and-send.ts` — pasar `address` (ya disponible vía
  `this.wallet.getAddress()`, L64) al `payouts.submit()`.
- Tests de use-case/gateway/fakes que el cambio de contrato de `PayoutSubmit` obligue a tocar
  (`confirm-and-send.test.ts`, `src/test-support/fakes.ts` / `test-container.ts`).
- `.env.example` — si F2 decide una env var nueva (ej. secreto de un token de payout, DT-4 opción b).

## Scope OUT
- Repo `wasiai-remittance-agents` y su flag `PAYOUT_ALLOW_MOCK` (fuera de este repo).
- Lógica interna del agente real `remit-cashout-payout`.
- `app/api/a2a/quote/route.ts` — el guard 501 de CD-9 se mantiene sin cambios.
- Los MENORes pendientes de la auditoría adversarial #2 de `chaski-v2`: PII over-transmission en
  `src/infrastructure/didit/decision.ts:73-83`, TTL AML client-only, over-refund en entrega
  parcial, CAS cross-tab TOCTOU — son backlog aparte, NO se arrastran a esta HU.
- Persistencia server-side nueva de quotes/remesas (tipo Upstash-backed quote registry) — a menos
  que F2/el humano confirme que es BLOQUEANTE para cerrar el objetivo de la HU (ver Missing Inputs
  #1, DT-3).
- SIWE / prueba criptográfica de posesión de wallet — límite conocido y explícitamente deferred en
  `kyc-auth.ts:7`, no se resuelve en esta HU.
- Cualquier cambio a `chaski-ai.vercel.app`, `wasiai-agentshop`, el gateway a2a, o código de
  `yarvis`/`agentshop-*` (demo del jurado del grant Team1).

## Decisiones técnicas (DT-N)
- **DT-1**: El enforcement server-side DEBE reusar la lógica de re-validación de autoridad ya
  construida en `app/api/payout/validate/route.ts` (WKH-180) — extraerla a un módulo compartido
  invocable desde ambas rutas, en vez de reimplementar el guard-order Didit (formato → fetch →
  mapeo → ownership) por segunda vez. El refactor exacto (función pura exportada vs. llamada
  interna al propio endpoint) es decisión de F2/Architect.
- **DT-2**: El contrato `PayoutSubmit`/`A2aPayoutGateway.submit()` no incluye `address` hoy — es un
  campo NUEVO necesario para que el enforcement pueda re-validar ownership server-side dentro de
  `/api/a2a/payout/submit`. Agregarlo es Scope IN de esta HU; `ConfirmAndSend` ya tiene el `address`
  disponible (`this.wallet.getAddress()`, `confirm-and-send.ts:64`), solo falta propagarlo.
- **DT-3**: NO existe persistencia server-side de quotes/remesas (arquitectura localStorage-only,
  `project-context.md:33-35`). El enforcement de esta HU puede verificar que el `kycVerificationId`
  presentado está `Approved` y pertenece al `address` del caller, pero NO puede (sin agregar
  infraestructura server-side nueva) verificar que `amountUsd`/`beneficiary` coincidan
  EXACTAMENTE con una remesa cotizada real. Es una limitación heredada, no un bug de esta HU —
  documentada como `[NEEDS CLARIFICATION]` BLOQUEANTE (Missing Inputs #1).
- **DT-4**: El mecanismo exacto de la "credencial de autorización server-side" (AC-1) tiene 2
  caminos válidos siguiendo precedentes del repo: (a) re-consultar Didit inline dentro del propio
  `/api/a2a/payout/submit`, mismo patrón que `/api/payout/validate`, sin token nuevo; o (b) exigir
  un token HMAC nuevo (ej. `x-payout-token`), mismo patrón que `x-kyc-token`/`kyc-auth.ts`, emitido
  tras un `/api/payout/validate` exitoso. Trade-off: (a) es más simple, sin nueva superficie de
  auth, pero re-valida contra Didit en CADA submit (latencia); (b) evita el 2º roundtrip pero
  agrega máquina de tokens nueva. Decisión final es del Architect en F2 — ambas opciones cierran
  AC-1/AC-2/AC-5.

## Constraint Directives (CD-N)
- **CD-1**: PROHIBIDO tocar `chaski-ai.vercel.app`, `wasiai-agentshop`, el gateway a2a, o
  cualquier código de `yarvis`/`agentshop-*` — el demo del jurado del grant Team1 corre en
  paralelo y NO se toca desde esta HU.
- **CD-2**: PROHIBIDO arrastrar a esta HU los MENORes pendientes de la auditoría adversarial #2
  (PII over-transmission en `didit/decision.ts:73-83`, TTL AML client-only, over-refund en
  entrega parcial, CAS cross-tab TOCTOU) — son backlog aparte, quedan Scope OUT explícito.
- **CD-3**: PROHIBIDO debilitar, saltear o volver condicional-por-flag el gate
  `confirm_requires_kyc_passed` (`remittance.ts:227-234`) ni remover/condicionar
  `authority.authorize()` de `confirm-and-send.ts` — invariantes de compliance ya vigentes,
  INTOCABLES.
- **CD-4**: OBLIGATORIO fail-closed en TODOS los guards nuevos de esta HU: ante cualquier duda,
  error o timeout de la re-validación, rechazar el submit, NUNCA autorizar por default — mismo
  principio ya establecido en `payout/validate/route.ts` y `payout-authority-gateway.ts`.
- **CD-5**: PROHIBIDO loguear o ecoar `beneficiary`/PII en cualquier código nuevo de error de esta
  HU — mismo guardrail CD-5 ya vigente en `route.ts`/`gateways.ts`.
- **CD-6**: OBLIGATORIO preservar los 7 tests existentes de `route.test.ts` en verde sin modificar
  su comportamiento esperado; los tests nuevos se AGREGAN, no reemplazan los existentes.

## Categorías de riesgo de seguridad (money-path + auth)
- **Broken authorization / IDOR-equivalente**: endpoint público sin ninguna verificación de
  identidad/autorización que, una vez `REMIT_AGENTS_BASE_URL` esté seteada, dispara un desembolso
  real contra `remit-cashout-payout` para cualquier caller de internet.
- **Tampering de request**: `amountUsd`/`beneficiary`/`kycVerificationId`/`kycPayoutAllowed` son
  100% caller-controlados y hoy se forwardean verbatim sin validar contra ningún estado
  server-side (`kycPayoutAllowed: true` incluso viaja HARDCODEADO desde el cliente).
  Nota: `kycPayoutAllowed` no se usa por el server hoy (se descarta en el forward), pero su sola
  presencia en el body es una señal de diseño confuso a limpiar en F2.
- **Replay**: `idempotencyKey` se forwardea intacto (CD-10) pero no hay verificación server-side de
  unicidad-por-caller — un atacante podría reusar o predecir keys.
- **Fail-open risk en el guard nuevo**: cualquier guard mal diseñado (try/catch demasiado amplio,
  default `authorized: true`) podría fail-open — misma clase de bug que causó WKH-198 (`NaN`
  fail-open en expiry de quote). El diseño de F2 debe ser explícitamente fail-closed en cada rama.
- **Missing server-side state (residual documentado)**: sin persistencia de quotes/remesas, la
  integridad de monto/beneficiario contra "una remesa real" no es 100% verificable con el
  enforcement de esta HU (DT-3) — riesgo residual, no bloqueante para cerrar el enforcement de
  auth/KYC/ownership, pero debe quedar explícito en el done-report.

## Missing Inputs
1. **[NEEDS CLARIFICATION] BLOQUEANTE (DT-3)**: ¿el objetivo "respaldado por una remesa legítima
   que cruzó el gate de compliance" exige verificar `amountUsd`/`beneficiary` contra un quote
   persistido server-side (requiere infraestructura nueva, ej. Upstash-backed quote registry con
   TTL, ya usado para rate-limit), o alcanza con re-validar KYC `Approved` + ownership del
   `address` (sin verificar monto/beneficiario contra nada)? Sin esta definición el Architect no
   puede fijar el alcance exacto del SDD en F2. Recomendación del analyst (no vinculante): cerrar
   esta HU con KYC+ownership (alcance ya sustancial, cierra el vector de "cualquiera dispara
   cualquier payout") y abrir un follow-up explícito para la integridad de monto/beneficiario si
   el humano lo prioriza — evita expandir esta HU a una feature de persistencia server-side nueva.
2. **[NEEDS CLARIFICATION] NO bloqueante (DT-4)**: mecanismo exacto del guard de autorización
   (re-fetch inline a Didit vs. token HMAC nuevo `x-payout-token`) — el Architect decide en F2 con
   ambas opciones ya documentadas en DT-4.
3. **[NEEDS CLARIFICATION] NO bloqueante**: código HTTP exacto para "no autorizado". El repo no es
   100% consistente hoy: `/api/kyc/decision` usa 401 (falta de token); `/api/payout/validate` usa
   200 con `{authorized:false}` para "no aprobado" (nunca 403). El Architect decide en F2 si
   `/api/a2a/payout/submit` sigue el patrón 401 (falta de credencial) + 200/`authorized:false`
   equivalente (KYC no aprobado), o usa 401/403 explícitos.
4. **[SIN PRODUCT CONTEXT]**: no existe `product-context.md` en `chaski-v2` — se usó el contexto
   de negocio provisto en el prompt del orquestador (ver Grounding).

## Análisis de paralelismo
No hay otras HUs abiertas en `chaski-v2` en este momento — todas las HUs previas (178-201) están
`DONE` según `doc/sdd/_INDEX.md`. Esta HU es standalone y es el **gate bloqueante** para habilitar
`REMIT_AGENTS_BASE_URL` en Vercel (Fase A del plan de remesa real) — hasta que WKH-202 esté DONE y
mergeada, esa env var NO debe setearse en producción. Riesgo de colisión de merge: bajo — los
archivos tocados (`route.ts`, `gateways.ts`, `ports.ts`, `confirm-and-send.ts`) fueron modificados
por última vez en WKH-186/187/200, todas ya mergeadas a `main`. Sin HUs paralelas conocidas que
toquen los mismos archivos hoy.

## Plan de tests (≥1 por AC)
- **AC-1**: test nuevo — `POST` sin credencial de autorización → 4xx, `fetch` hacia
  `REMIT_AGENTS_BASE_URL` NUNCA invocado (mock de fetch con `expect(...).not.toHaveBeenCalled()`,
  mismo patrón que el test existente de `BASE` unset).
- **AC-2**: test nuevo — mock de la re-validación devolviendo `authorized:false` con cada `reason`
  relevante (`kyc_not_approved`, `kyc_ownership_mismatch`) → respuesta de error, sin forward al
  agente.
- **AC-3**: test existente YA cubre esto (`"sin REMIT_AGENTS_BASE_URL → 501 a2a_not_configured,
  fetch NOT called"`) — verificar que sigue pasando con el guard nuevo agregado (orden de guards
  no debe romperlo).
- **AC-4**: test existente YA cubre el happy path (`"con base + agente ok → 200 { result }"`) —
  extenderlo para que el mock de autorización esté en estado `authorized:true` antes de llegar al
  forward; verificar que preserva PII-free (no contiene `999888777`) e idempotencyKey intacto.
- **AC-5**: test nuevo — mock de la re-validación lanzando (timeout/DNS) → respuesta de error,
  fetch a `REMIT_AGENTS_BASE_URL` NUNCA invocado.
- **AC-6**: correr `npm run test` sobre `app/api/a2a/payout/submit/route.test.ts` — los 7 tests
  existentes deben seguir en verde sin modificar sus asserts.
- **AC-7**: test existente YA cubre esto (`"shape inválido del agente → 502 a2a_bad_shape"` + los
  2 casos MNR-C) — verificar que sigue pasando sin cambios tras agregar el guard de autorización
  ANTES del forward.
- Adicional (cierre de DT-2/contrato): test nuevo en `confirm-and-send.test.ts` — verificar que
  `payouts.submit()` recibe `address` en el request cuando `ConfirmAndSend.execute()` corre.
