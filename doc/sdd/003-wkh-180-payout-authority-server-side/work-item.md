# Work Item — [WKH-180] Autoridad KYC/payout server-side (no confiar en gate client-side)

## Resumen
Chaski v2 desembolsa (hoy en modo MOCK) confiando en un `KycVerification` que vive 100% en
localStorage del navegador. Cualquiera puede editar devtools/localStorage y "aprobar" su propio
KYC sin pasar por Didit, o reusar un `verificationId` ajeno. Esta HU mueve la autoridad de
"¿este KYC está aprobado y autoriza el payout?" al servidor: antes de desembolsar, el server
re-valida el `verificationId` contra Didit (o falla-loud si no puede), y el cliente deja de ser
la fuente de verdad.

## Sizing
- SDD_MODE: full
- Estimación: M
- Branch sugerido: fix/180-payout-authority-server-side

## F0 — Grounding (líneas verificadas)

Arquitectura confirmada: **toda la app corre client-side**. `getContainer()`
(`src/composition/container.ts:69-72`) es un singleton del browser; `LocalRepo`
(`src/infrastructure/persistence.ts:25-64`) y `LocalKycStore`
(`src/infrastructure/kyc-store.ts:16-43`) persisten en `localStorage` (`chaski.remittances.v1`,
`chaski.kyc.v1`). El dominio (`src/domain/remittance.ts`) es puro y sus invariantes son
correctas — el problema es que corren sobre **estado atacante-controlable**, no que falten
invariantes.

Puntos de bypass confirmados:

1. **`start-kyc.ts:36-41`** (KYC-once): `this.kycStore.get(input.address)` lee `chaski.kyc.v1`
   directo del browser. Si `remembered.approved && remembered.payoutAllowed` → `r.applyKyc(...)`
   se aplica **sin tocar Didit en absoluto**. Un atacante puede sembrar una entrada falsa en
   localStorage y saltarse el KYC entero en la siguiente remesa.
2. **`remittance.ts:161-168`** (`Remittance.confirm()`): exige `state.kyc.approved &&
   state.kyc.payoutAllowed` — invariante correcta, pero `state` es la snapshot que vive en
   `LocalRepo` (localStorage), editable con una línea de devtools.
3. **`confirm-and-send.ts:42-48`**: `payouts.submit({ ..., kycVerificationId: kyc.verificationId
   })` — el `verificationId` viaja tal cual del estado del cliente al `PayoutGateway.submit()`
   sin que nada lo re-verifique contra la fuente real (Didit).
4. **`resume-kyc.ts:46-49`**: aplica `v` (la decisión) igual que `start-kyc` — mismo patrón,
   mismo problema de fondo (la aplicación del resultado es correcta; lo que falta es un segundo
   chequeo server-side justo antes de mover valor).

Lo que SÍ es servidor-autoritativo hoy (WKH-179, ya en prod): `app/api/kyc/session/route.ts` y
`app/api/kyc/decision/route.ts` — `DIDIT_API_KEY` vive solo en el server, guard-order
`501 → 500 → rate-limit/auth → Didit`, token HMAC (`x-kyc-token`) evita el IDOR de PII, y
`maskDecision()` enmascara el documento. **Estas rutas ya hablan con Didit de verdad** — el gap
no es "no hay integración server-side con Didit", es que **nadie vuelve a llamarlas antes de
pagar**. `mapDiditDecision` (`src/infrastructure/didit/decision.ts:29-54`) usa
`verificationId = raw.session_id` (el session id de Didit) — es el identificador correcto para
re-consultar `/v3/session/{id}/decision/` en el momento del payout.

`ConfirmAndSend` (`confirm-and-send.ts:14-61`) usa `FallbackPayoutGateway`
(`src/infrastructure/fallback/gateways.ts:92-113`) — **MOCK, no desembolsa nada real** (confirmado
por comentario `// MOCK — no desembolsa`). El desembolso real es WKH-168 (aún no implementado).
Esto significa que el gate server-side de esta HU se puede instalar AHORA, sobre el mock, sin
esperar a WKH-168: el punto de enforcement (justo antes de `payouts.submit()`) es el mismo
independientemente de si el gateway de abajo es mock o real.

### Decisión de arquitectura — dónde vive la re-validación

**Opción (a) — nueva ruta server-side en chaski-v2** (`app/api/payout/validate` o similar):
re-consulta `GET /v3/session/{verificationId}/decision/` a Didit con `DIDIT_API_KEY` (mismo
patrón que `app/api/kyc/decision/route.ts`), confirma `status === "Approved"`, y el use-case
`ConfirmAndSend` llama a esta ruta ANTES de `payouts.submit()`.

- (+) Reusa 100% el patrón ya auditado y en prod de WKH-179 (guard-order, fail-closed,
  `DIDIT_API_KEY` server-only).
- (+) Cero dependencia nueva de red/infra — mismo repo, mismo deploy (Vercel), sin costos de
  protocolo A2A adicionales.
- (+) Consistente con CD-1 (esta HU no toca nada fuera de chaski-v2).
- (–) Duplica lógica de "consultar Didit" en dos rutas (`/kyc/decision` y `/payout/validate`) —
  mitigable extrayendo el fetch+mapeo a un helper compartido (`decision.ts` ya es puro/testeable).
- (–) No resuelve "ownership" (¿el `verificationId` pertenece al `address` que está confirmando
  la remesa?) salvo que Didit devuelva `vendor_data` en la respuesta de decision — **hoy
  `mapDiditDecision` no extrae `vendor_data`** (`decision.ts:16-20` `DiditRaw` no lo tipa). Esto
  es un gap real que el Architect debe resolver en F2 (extender el mapeo + comparar contra
  `input.address` del caller).

**Opción (b) — delegar en los agentes A2A `remit-kyc-validator` / `remit-cashout-payout`** (ya
live en el marketplace, WKH-170/WKH-172): chaski-v2 llamaría a esos agentes como autoridad de
KYC/payout en vez de re-consultar Didit directo.

- (+) Reusa agentes ya construidos, auditados y facturables del ecosistema WasiAI.
- (–) Agrega una dependencia cross-repo/cross-servicio (Railway) al money-path crítico de
  chaski-v2 — más latencia, más superficie de fallo, más piezas que pueden estar caídas el día
  del demo.
- (–) Esos agentes cobran vía protocolo A2A (x402/agent-key) — introduce facturación real en un
  flujo que hoy es gratis para el usuario de Chaski, y requiere wiring de pago (agent key,
  fondeo) que no existe en chaski-v2.
- (–) remit-cashout-payout está en ETAPA MOCK igual que `FallbackPayoutGateway` — no aporta
  desembolso real hoy, solo movería el mock de un repo a otro.
- (–) Viola el espíritu de CD-1 (scope = solo chaski-v2): agregaría cambios de contrato/llamada
  en un servicio que NO es chaski-v2.

**Recomendación del Analyst: Opción (a).** Es la que cierra el hallazgo A1 con menor superficie
nueva, reusa el patrón ya probado en prod (WKH-179), no introduce dependencias cross-repo ni
facturación, y es coherente con CD-1. Opción (b) queda anotada para una HU futura si algún día
se decide que chaski-v2 debe consumir el ecosistema A2A como autoridad KYC compartida entre
múltiples clientes (hoy Chaski es el único consumidor, así que esa indirección no aporta valor).

`[NEEDS CLARIFICATION]` — la decisión final (a) vs (b) y el diseño exacto de "ownership" del
verificationId quedan para el Architect en F2; el orquestador puede resolver (a) como default en
modo AUTO dado el análisis anterior, sin bloquear el pipeline.

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `ConfirmAndSend` va a invocar `payouts.submit()`, the system SHALL primero
  re-validar el `kycVerificationId` de la remesa contra una fuente server-side independiente del
  estado del cliente (no leer `approved`/`payoutAllowed` desde el `KycVerification` que llegó del
  browser).
- **AC-2**: IF la re-validación server-side responde que el `verificationId` NO está en estado
  `Approved` (o la consulta falla/timeout), THEN the system SHALL bloquear el payout (no llamar a
  `payouts.submit()`) y marcar la remesa como fallida con una razón explícita (ej.
  `kyc_reauth_failed`).
- **AC-3**: WHERE el server no tiene `DIDIT_API_KEY` configurada (modo simulación) AND el entorno
  es producción, the system SHALL fallar-loud (bloquear el payout, NO autorizar por default) en
  vez de aceptar silenciosamente la simulación como autoridad.
- **AC-4**: WHERE el server no tiene `DIDIT_API_KEY` configurada AND el entorno NO es producción
  (dev/local/demo), the system SHALL permitir el camino simulado (preserva DX de desarrollo, sin
  romper el flujo demo existente).
- **AC-5**: IF el `kycVerificationId` recibido está vacío, malformado, o ausente, THEN the system
  SHALL rechazar el intento de payout SIN llamar a Didit (guard-order: validar formato antes de
  gastar la consulta externa).
- **AC-6**: WHILE el estado de KYC guardado en `localStorage` del cliente esté manipulado (ej.
  `approved: true` forjado sin haber pasado por Didit), the system SHALL igual bloquear el payout
  si la re-validación server-side no confirma `Approved` — es decir, el gate NO debe depender
  exclusivamente de la invariante de dominio `Remittance.confirm()` que corre sobre estado
  client-side.
- **AC-7**: the system SHALL ejecutar la re-validación server-side (llamada a Didit, uso de
  `DIDIT_API_KEY`) exclusivamente en runtime de servidor (ruta API de Next.js) — el API key NUNCA
  se expone al browser, mismo patrón que `app/api/kyc/{session,decision}/route.ts` (WKH-179).

## Scope IN
- `src/application/use-cases/confirm-and-send.ts` — invocar la re-validación server-side ANTES
  de `payouts.submit()`; bloquear/marcar `payout_failed` si no autoriza.
- `src/application/ports.ts` — nuevo port (ej. `PayoutAuthorityGateway` o extensión de
  `PayoutGateway`) que expone `authorize(verificationId, ...): Promise<{ authorized: boolean;
  reason?: string }>`.
- Nueva ruta server-side (ej. `app/api/payout/validate/route.ts`) — re-consulta Didit por
  `verificationId`, guard-order `501/fail-loud-prod → formato → Didit → resultado`, siguiendo el
  patrón de `app/api/kyc/decision/route.ts`.
- Nuevo adapter cliente (ej. `src/infrastructure/payout/payout-authority-gateway.ts`) que llama a
  la ruta anterior desde el use-case.
- `src/composition/container.ts` — wiring del nuevo port/adapter.
- Posible extensión de `src/infrastructure/didit/decision.ts` (`DiditRaw`/`mapDiditDecision`) si
  el Architect decide resolver "ownership" comparando `vendor_data` — a confirmar en F2.
- Tests: ruta nueva (`route.test.ts`), use-case (`confirm-and-send.test.ts` — no existe hoy, es
  cobertura net-new), y del helper de mapeo si se extiende.
- `.env.example` — documentar cualquier env var nueva (ej. detección de entorno prod si no se
  reusa `VERCEL_ENV`/`NODE_ENV` ya disponible).

## Scope OUT
- Desembolso real (WKH-168) — el `PayoutGateway` sigue siendo `FallbackPayoutGateway` (MOCK). Esta
  HU instala el gate de autoridad; no mueve plata real.
- Cualquier cambio a `wasiai-a2a`, `remit-kyc-validator`, `remit-cashout-payout`, o cualquier otro
  repo/servicio fuera de `chaski-v2` (Opción b descartada, ver Decisión de arquitectura).
- Cambios a rate-limit/auth de `/api/kyc/session` y `/api/kyc/decision` (ya cerrados en WKH-179).
- Persistencia server-side de remesas/historial (`LocalRepo` sigue en localStorage) — fuera de
  scope; esta HU NO mueve el money-path a un backend con DB.
- Cambios de UI/UX más allá de mostrar el estado de fallo cuando el gate bloquea el payout (texto
  exacto/diseño visual queda a criterio del Architect en F2, sin expandir scope).
- El demo live actual (agentshop, cobraya, Chaski v1 pre-rebrand) — CD-1 explícito abajo.

## Decisiones técnicas (DT-N)
- DT-1: la re-validación se hace consultando Didit directamente (mismo integration point que
  `/api/kyc/decision`), NO se construye una tabla/DB server-side de verificaciones — Didit sigue
  siendo la única fuente de verdad externa, evita drift entre "lo que dice nuestra DB" y "lo que
  dice Didit".
- DT-2: el punto de enforcement es el use-case `ConfirmAndSend`, no el dominio `Remittance`
  — el dominio queda puro (sin I/O); la llamada de red vive en la capa de aplicación/infra, según
  Clean Architecture ya establecida en el repo.
- DT-3: fail-loud en prod cuando falta `DIDIT_API_KEY` es una regla NUEVA respecto al patrón
  existente (`/api/kyc/*` hoy caen a simulación con 501 sin distinguir entorno) — esta HU
  introduce el primer chequeo de entorno prod-vs-no-prod explícito del repo; el Architect debe
  decidir la fuente de verdad del "estamos en prod" (`VERCEL_ENV === "production"` es la señal
  más confiable en Vercel, análogo al patrón de IP-trust ya usado en WKH-179 `session/route.ts`).

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/` — ni el demo live
  (agentshop/cobraya/Chaski v1), ni `wasiai-a2a`, ni ningún agente `remit-*`. Esta HU es
  exclusivamente `chaski-v2/`.
- CD-2: PROHIBIDO tratar cualquier campo `approved`/`payoutAllowed`/`kycVerificationId` que llegue
  del cliente (browser) como autoridad final — todo valor booleano de autorización de payout debe
  originarse en la respuesta de la re-validación server-side de ESTA HU, no en el `KycVerification`
  cacheado.
- CD-3: OBLIGATORIO seguir el guard-order ya establecido en WKH-179 para la nueva ruta
  (`501/misconfig → validación de formato → llamada a Didit → resultado`) — no llamar a Didit
  antes de los guards previos.
- CD-4: PROHIBIDO que el 501 (simulación) autorice payouts en producción de forma silenciosa —
  debe ser un fallo explícito y visible (AC-3), no un default permisivo.
- CD-5: OBLIGATORIO que el `DIDIT_API_KEY` y cualquier llamada de red a Didit para esta
  re-validación corran exclusivamente en runtime server (ruta API), nunca en código que se bundlee
  al cliente.

## Missing Inputs
- `[NEEDS CLARIFICATION]` — diseño exacto de "ownership" (¿el `verificationId` re-validado
  pertenece al `address`/wallet que está confirmando la remesa?): depende de si Didit expone
  `vendor_data` en la respuesta de `/decision/` — a confirmar contra el sandbox real en F2/F3
  (mismo caveat ya documentado en `decision.ts:26-28` para el split paterno/materno).
- `[NEEDS CLARIFICATION]` — fuente de verdad de "estamos en producción" (`VERCEL_ENV` vs
  `NODE_ENV` vs env var custom) — el Architect la fija en F2; no bloqueante para F1.
- `[resuelto en F1]` — Opción (a) vs (b) de arquitectura: recomendada (a), ver sección de
  Decisión de arquitectura arriba. El Architect puede confirmar o revertir en F2 con
  justificación si aparece nueva información.

## Análisis de paralelismo
- Bloquea: **WKH-168** (desembolso real) — WKH-168 no debería mergear un `PayoutGateway` real que
  desembolse dinero sin que el gate de autoridad de esta HU ya esté en su lugar; orden de merge
  sugerido: WKH-180 antes que WKH-168.
- Coordina con: **WKH-181/182/183** (backlog de la misma auditoría 2026-07-10, en NNN paralelos
  bajo `chaski-v2/doc/sdd/`) — mismo repo, mismo `git log` reciente (WKH-178/179 ya mergeados).
  Si WKH-181 toca `confirm-and-send.ts` o `ports.ts`, coordinar orden de merge entre Architects
  antes de F3 (mismo patrón de coordinación documentado en WKH-179 done-report).
- No bloquea: WKH-178/179 (ya DONE, mergeados, live).
- Puede correr en paralelo con cualquier HU que NO toque `confirm-and-send.ts`, `ports.ts`,
  `container.ts`, o `src/infrastructure/didit/*`.
