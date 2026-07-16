# Work Item — [WKH-205] Cerrar deuda técnica de follow-ups de WKH-202 (+ residuales WKH-206): oráculo KYC de `/api/payout/validate`, bug body-null, rate-limit de `/challenge`

## Resumen

`doc/sdd/015-wkh-202-payout-submit-hardening/done-report.md` dejó 4 MENOREs documentados como
follow-up explícito hacia esta HU (MNR-2, MNR-3, MNR-5, MNR-6), y `doc/sdd/017-wkh-206-.../` dejó un
residual R2 (rate-limit ausente en `/api/a2a/payout/challenge`). El founder pidió cero deuda técnica:
esta HU cierra los 4+1 ítems, con foco en el más serio — `app/api/payout/validate/route.ts` es hoy un
**oráculo público sin auth de estado KYC** (ecoa `reason` verbatim: `kyc_not_approved` vs
`kyc_ownership_mismatch` vs `invalid_verification_id`), exactamente lo que CD-12 (no-oracle) de
`/api/a2a/payout/submit` se esforzó en negar del lado de al lado.

## Sizing

- **SDD_MODE: full** (QUALITY) — money-path adyacente (mismo módulo `resolvePayoutAuthority` que
  alimenta `submit`, gate G1 de Fase A) + superficie de seguridad (oráculo IDOR-like, financial-DoS
  vía Didit sin rate-limit).
- **Estimación: M** — 2 endpoints tocados + 1 módulo de rate-limit generalizado + tests extendidos;
  cero cambios de dominio, cero cambios en `submit/route.ts` (su guard-order queda intacto).
- **Branch sugerido**: `feat/018-wkh-205-payout-validate-oracle-hardening`

### Waves sugeridas (para F2/F2.5)
- **W0** — generalizar `src/infrastructure/rate-limit.ts` (hoy 100% KYC-specific: `checkKycRateLimit`,
  prefix `kyc:rl:*`) a un helper reusable por-ruta (nuevo prefix/buckets configurables), sin tocar la
  firma ni el comportamiento de `checkKycRateLimit` (CD, ver abajo).
- **W1** — `app/api/payout/validate/route.ts`: (a) fix body-null (mismo patrón `isRecord` de
  `submit`/`challenge`), (b) colapsar `reason` en la rama `authorized:false` reusando el criterio
  no-oracle de CD-12, (c) aplicar rate-limit (IP + address, mismo patrón `checkKycRateLimit`).
- **W2** — `app/api/a2a/payout/challenge/route.ts`: aplicar el mismo rate-limit generalizado de W0
  (residual R2 WKH-206).
- **W3** — higiene MNR-5 (`isRecord` no excluye arrays) + MNR-6 (tipado `it.each` en
  `submit/route.test.ts:176-180`) — fixes de una línea, sin riesgo money-path.

## Acceptance Criteria (EARS)

- **AC-1**: WHEN un caller no autenticado hace POST a `/api/payout/validate` con `verificationId`+
  `address` de un tercero y la re-consulta contra Didit resuelve `authorized:false` (por CUALQUIER
  motivo — status no-Approved, ownership mismatch, o `verificationId` malformado), the system SHALL
  responder con un **único código de `reason` no-revelador**, indistinguible entre esas causas (mismo
  criterio no-oracle que `app/api/a2a/payout/submit/route.ts:101-105` aplica hoy vía CD-12).
- **AC-2**: WHILE la autoridad server-side (`resolvePayoutAuthority`) devuelve un fallo TÉCNICO
  (`kyc_authority_unavailable` / `kyc_reauth_failed`, HTTP 502/503), the system SHALL preservar esos
  códigos SIN colapsar (son estados operativos, no oráculo de KYC de un tercero — el caller legítimo
  los necesita para reintentar/mostrar "no disponible" vs "rechazado").
- **AC-3**: WHEN el body de un POST a `/api/payout/validate` es el literal JSON `null` (o cualquier
  no-record: array, string, número), the system SHALL responder 4xx (nunca 500 crudo) — mismo patrón
  `isRecord()` que `app/api/a2a/payout/submit/route.ts:39-41,72-73` y
  `app/api/a2a/payout/challenge/route.ts:18-20,31-32` ya aplican.
- **AC-4**: WHEN el volumen de POSTs a `/api/payout/validate` (por IP y, si presente, por `address`)
  excede el umbral configurado, the system SHALL rechazar con 429 antes de re-consultar a Didit (cierra
  el vector financial-DoS análogo a WKH-179/hallazgo A2 — cada llamada re-consulta Didit, que Chaski
  paga).
- **AC-5**: WHEN el volumen de POSTs a `/api/a2a/payout/challenge` (por IP) excede el umbral
  configurado, the system SHALL rechazar con 429 antes de emitir/firmar el challenge HMAC (cierra el
  residual R2 de WKH-206 — flood quema CPU HMAC).
- **AC-6**: IF el store de rate-limit (Upstash) no está configurado Y el resto de los guards de la ruta
  indican un entorno "vivo" (mismo criterio que `checkKycRateLimit` hoy: Didit configurado ⇒
  fail-closed), THEN the system SHALL fail-closed (503), nunca fail-open silencioso.
- **AC-7**: WHEN el caller LEGÍTIMO (el propio flujo `ConfirmAndSend` vía `HttpPayoutAuthorityGateway`,
  que hoy consume `{authorized, reason}` de `/api/payout/validate` y lo persiste como
  `failureReason`/lo traduce con `humanError()` en `src/presentation/flow-vm.ts:37-49`) recibe la
  respuesta colapsada, the system SHALL preservar exactamente el mismo comportamiento observable de UI
  — `humanError()` YA colapsa TODOS los `reason` que contienen `"kyc"` al mismo mensaje
  (`flow-vm.ts:47`, verificado en F0), así que ningún cliente real distingue hoy `kyc_not_approved` de
  `kyc_ownership_mismatch`; el `authorized: boolean` y el shape `{authorized, reason?}` (con `reason`
  AUSENTE en `authorized:true`) se preservan byte-idénticos.
- **AC-8**: the system SHALL excluir arrays de la validación `isRecord()` de
  `app/api/a2a/payout/submit/route.ts:39-41` (MNR-5: `isRecord([])` hoy es `true`; aunque no explotable,
  hoy el comentario dice "record-like" siendo impreciso) — mismo criterio aplicado a los `isRecord()` de
  `validate`/`challenge` si esta HU los introduce/toca.
- **AC-9**: the system SHALL tipar explícitamente el parámetro `isValidRecord: boolean` en el
  `it.each` de `app/api/a2a/payout/submit/route.test.ts:176-180` (MNR-6).

## Scope IN

- `app/api/payout/validate/route.ts` (líneas 1-24 completas: bug null L12-16, rest-spread/reason L19-23)
- `app/api/payout/validate/route.test.ts` (3 tests que hoy assertean `reason` específico —
  `kyc_not_approved` L83, `kyc_ownership_mismatch` L108 — SE REESCRIBEN a propósito, el contrato SÍ
  cambia; ver CD-1 abajo, distinto del CD-10 de WKH-202 que prohibía tocar esta ruta)
- `app/api/a2a/payout/challenge/route.ts` (rate-limit nuevo, sin tocar la lógica HMAC existente)
- `app/api/a2a/payout/challenge/route.test.ts` (tests nuevos de rate-limit)
- `src/infrastructure/rate-limit.ts` (generalizar sin romper `checkKycRateLimit` — CD abajo)
- `src/infrastructure/rate-limit.test.ts` (tests del helper generalizado)
- `app/api/a2a/payout/submit/route.ts:39-41` (SOLO el fix de un línea de MNR-5: excluir arrays de
  `isRecord`; PROHIBIDO tocar cualquier otra línea de esta ruta — ver Scope OUT)
- `app/api/a2a/payout/submit/route.test.ts:176-180` (SOLO el tipado de MNR-6)
- `.env.example` (documentar nuevas env vars de rate-limit si W0 introduce nombres nuevos)

## Scope OUT

- `app/api/a2a/payout/submit/route.ts` — **PROHIBIDO** tocar el guard-order (CD-11 de WKH-202,
  aprobado, 287/287 tests verdes) salvo la línea puntual de MNR-5 arriba. NO reordenar, NO cambiar
  ningún `if`/`switch` existente.
- `src/infrastructure/payout/authority.ts` (`resolvePayoutAuthority`) — módulo compartido con
  `submit`; el colapso de `reason` de AC-1 se resuelve en la CAPA del wrapper (`validate/route.ts`,
  mismo patrón que `submit/route.ts:96-114` YA hace HOY con su propio switch), NO adentro del módulo
  compartido. Si el Architect en F2 concluye que hace falta tocarlo, requiere justificación explícita
  y doble revisión (AR) por el radio de impacto sobre `submit` (7 ACs PASS de WKH-202 dependen de él).
- Encender ningún flag (`NEXT_PUBLIC_*`, `PAYOUT_POP_SECRET`, `SETTLE_ATTESTATION_SECRET`,
  `NEXT_PUBLIC_EIP3009_ENABLED`) — todos quedan en su estado actual.
- Persistencia server-side / reconciliación de remesas huérfanas — eso es WKH-207 (ver Análisis de
  paralelismo).
- `wasiai-a2a`, `wasiai-v2`, `wasiai-facilitator`, Didit — ningún repo externo.
- SIWE / binding real de `address` a una firma en `/api/payout/validate` — deferred (residual R1 de
  WKH-202 §8, distinto del oráculo de reason que SÍ cierra esta HU).

## Decisiones técnicas (DT-N)

- **DT-1 — Cómo cerrar el oráculo sin romper al cliente legítimo.** F0 confirmó que
  `HttpPayoutAuthorityGateway.authorize()` (`src/infrastructure/payout/payout-authority-gateway.ts:9-25`)
  propaga `{authorized, reason}` tal cual al use-case `ConfirmAndSend` (`confirm-and-send.ts:100-106`),
  que lo usa SOLO para (a) la decisión booleana `authorized` y (b) como `reason` de
  `failAndRefund()` (persistido en `Remittance.markPayoutFailed`). El único punto de la UI que traduce
  ese `reason` a texto es `humanError()` (`flow-vm.ts:37-49`), que hoy colapsa TODO string que
  `.includes("kyc")` al mismo mensaje ("No pudimos verificar tu identidad.") — es decir, el cliente
  real **ya no distingue** `kyc_not_approved` de `kyc_ownership_mismatch` ni de `kyc_reauth_failed`.
  **Decisión**: colapsar en `validate/route.ts` los 3 `reason` de "no autorizado por motivo del sujeto"
  (`kyc_not_approved`, `kyc_ownership_mismatch`, `invalid_verification_id`) a UN único código nuevo
  (nombre exacto a definir en F2, ej. `kyc_not_authorized`), preservando intactos los 2 `reason`
  "técnicos" (`kyc_authority_unavailable` 503, `kyc_reauth_failed` 502) porque esos SÍ importan para
  operar (reintentar vs no). Exactamente el mismo criterio que `submit/route.ts:96-114` ya implementa
  hoy con su propio switch (CD-12) — este DT extiende ese patrón probado a la ruta hermana, sin tocar
  `authority.ts` (DT compartido, cero riesgo sobre los 7 ACs de WKH-202 ya PASS).
  **[TBD F2]**: si el Architect decide extraer el switch de colapso a una función compartida
  (`mapAuthorityReasonToPublicCode()`, reusada por `submit` Y `validate` para evitar divergencia futura
  — lección explícita de WKH-202 "CD-1 anti-pattern: reutilización estricta") o si cada ruta mantiene
  su propio switch inline (menor riesgo sobre el código ya aprobado de `submit`). Este analyst
  recomienda NO tocar el switch de `submit` (menor blast radius) y solo AÑADIR el switch nuevo en
  `validate`, aceptando la duplicación como deuda documentada explícita (trade-off: menos riesgo AR,
  más deuda — founder puede preferir lo inverso).
- **DT-2 — Generalizar `rate-limit.ts`.** El helper existente (`checkKycRateLimit`) es 100%
  específico a KYC (prefix `kyc:rl:*`, env vars `KYC_RL_*`). Se generaliza a una función
  parametrizada por `bucketPrefix` + límites configurables, SIN romper la firma pública actual de
  `checkKycRateLimit` (los callers existentes — `app/api/kyc/session/route.ts` u otra ruta que lo use
  hoy — quedan intactos; se agrega una nueva función o un wrapper, decisión de implementación en F2).
- **DT-3 — Rate-limit fail-mode de `/validate` y `/challenge`.** Mismo criterio que `checkKycRateLimit`
  (SDD §4.4 de WKH-179): Upstash no configurado + el resto de la ruta "en vivo" (Didit key presente
  para `/validate`; `PAYOUT_POP_SECRET` presente para `/challenge`) ⇒ fail-closed 503/429. Si el
  mecanismo subyacente ya está apagado por su propio flag (`/challenge` sin `PAYOUT_POP_SECRET` → 501
  ANTES de llegar al rate-limit), el rate-limit ni se evalúa (mismo orden de guards que ya existe: flag
  primero, todo lo demás después).
- **DT-4 — MNR-5/MNR-6 se cierran en esta HU** (no se difieren de nuevo): son fixes de una línea sin
  riesgo money-path, consistentes con el mandato de cero deuda técnica del founder.

## Constraint Directives (CD-N)

- **CD-1**: El contrato observable de `/api/payout/validate` **SÍ CAMBIA** en esta HU (a diferencia del
  CD-10 de WKH-202, que lo declaraba inmutable). Los 2 tests que hoy assertean `reason` granular
  (`route.test.ts:83,108`) DEBEN reescribirse deliberadamente para el nuevo código colapsado — un CR
  que encuentre esos tests sin tocar debe marcarlo BLOQUEANTE (test verde mintiendo sobre el contrato
  viejo).
- **CD-2**: OBLIGATORIO preservar el shape `{authorized: boolean, reason?: string}` y el hecho de que
  `reason` está AUSENTE cuando `authorized:true` (el rest-spread de `validate/route.ts:22` ya lo
  garantiza — PROHIBIDO reemplazarlo por un objeto literal, mismo comentario que ya existe en
  L19-21).
- **CD-3**: PROHIBIDO tocar `src/infrastructure/payout/authority.ts` salvo justificación explícita y
  doble revisión AR (ver Scope OUT). Si se toca, TODOS los tests de `submit/route.test.ts` (287 hoy)
  deben re-correr verdes sin modificar sus asserts.
- **CD-4**: OBLIGATORIO fail-closed en cualquier rama nueva de rate-limit (nunca autorizar/emitir por
  default ante error de Upstash en un entorno "vivo" — mismo criterio que CD-4 de WKH-180/202).
- **CD-5**: PROHIBIDO introducir un `isRecord()` nuevo por archivo sin la exclusión de arrays (MNR-5) —
  todo `isRecord()` nuevo o tocado en esta HU debe excluir `Array.isArray`.
- **CD-6**: PROHIBIDO cambiar el guard-order de `submit/route.ts` (guards 1-8, líneas 62-264) —
  cualquier diff fuera de la línea puntual de MNR-5 (L39-41) en ese archivo es AUTOMÁTICAMENTE
  BLOQUEANTE en AR.

## Tabla de riesgo de seguridad

| # | Vector | Estado ANTES de WKH-205 | Estado DESPUÉS (objetivo) | AC |
|---|--------|--------------------------|----------------------------|----|
| 1 | Oráculo KYC vía `/api/payout/validate` (reason verbatim revela `not_approved` vs `ownership_mismatch` vs `invalid_verification_id` a un caller no autenticado que sondea `verificationId`+`address` ajenos) | **ALTO** — CD-12 "no-oracle" es decorativo a nivel repo (MNR-2 WKH-202, R1 WKH-206) | **BAJO** — colapsado a 1 código no-revelador, mismo criterio que `submit` | AC-1, AC-7 |
| 2 | Financial-DoS vía `/api/payout/validate` (cada POST re-consulta Didit; Chaski paga por verificación, sin límite) | **MEDIO** — sin rate-limit, análogo al hallazgo A2 de WKH-179 que SÍ se cerró en `/api/kyc/session` | **BAJO** — mismo patrón `checkKycRateLimit` aplicado acá | AC-4, AC-6 |
| 3 | CPU-DoS vía `/api/a2a/payout/challenge` (flood de HMAC sign, gratis para el atacante, costoso en CPU serverless) | **MEDIO** — sin rate-limit (residual R2 WKH-206) | **BAJO** | AC-5, AC-6 |
| 4 | 500 crudo con body `null` en `/api/payout/validate` (info-leak de stack trace / DoS de logs ruidosos) | **BAJO** — no explotable para robar datos, pero viola el contrato "nunca 500 crudo" (MNR-3 WKH-202) | **Cerrado** | AC-3 |
| 5 | `isRecord([])` acepta arrays como record-like (MNR-5) | **BAJO/no-explotable** hoy (cae en el guard de formato de todas formas) | Cerrado, comentario preciso | AC-8 |
| 6 | Ownership best-effort sin SIWE (residual R1 WKH-202/206) | Sin cambios — **fuera de scope**, deferred | Sin cambios (documentado, no regresión) | — |

## Missing Inputs

- **[NEEDS CLARIFICATION, NO bloqueante]** Nombre exacto del código colapsado de AC-1 (ej.
  `kyc_not_authorized` vs reusar `payout_not_authorized` del propio `submit` por consistencia
  cross-endpoint) — resoluble en F2, no bloquea el sizing ni el scope.
- **[NEEDS CLARIFICATION, NO bloqueante]** DT-1 [TBD F2]: extraer switch compartido vs duplicar
  (trade-off riesgo/deuda) — el Architect decide con el humano si hace falta.
- **[NEEDS CLARIFICATION, NO bloqueante]** Umbrales exactos de rate-limit para `/validate` (¿mismos
  defaults que KYC: 5/10min IP, 3/10min address?) y `/challenge` (¿solo IP, ya que `challenge` no
  requiere `verificationId`?) — el Architect propone defaults conservadores en F2, ajustables por env.
- **[NEEDS CLARIFICATION, NO bloqueante]** Si vale la pena, en la misma HU, extraer el `isRecord()`
  duplicado (hoy vive suelto en `submit/route.ts`, `challenge/route.ts`, y se agregaría en
  `validate/route.ts`) a un util compartido — trivial pero toca 3 archivos ya aprobados; el Architect
  decide el trade-off en F2.

## Análisis de paralelismo

- **¿Bloquea otras HUs?** No. Los 5 gates de Fase A (G1-G5: WKH-202/168/203/206) ya están DONE; esta HU
  es puramente deuda técnica/hardening post-gate, no bloquea ningún camino de dinero nuevo.
- **¿Colisiona con WKH-207?** WKH-207 (candidata, aún NO creada como work-item formal — mencionada en
  `_INDEX.md` como "reconciliación de remesas huérfanas / persistencia server-side", tomará NNN `019`)
  previsiblemente toca `confirm-and-send.ts`, `app/api/a2a/payout/submit/route.ts` (comentario
  `submit/route.ts:27-28` ya apunta "Residual WKH-207: una atestación quemada + un forward fallido deja
  la remesa varada") y probablemente infraestructura de persistencia nueva (DB/Upstash extendido).
  **Esta HU (WKH-205) NO toca `confirm-and-send.ts` ni el cuerpo de `submit/route.ts`** (solo la línea
  puntual de MNR-5, CD-6) — el archivo compartido de mayor riesgo es `submit/route.ts`, pero el diff de
  WKH-205 ahí es de 1 línea aislada (`isRecord` L39-41), lejos de cualquier lógica de reconciliación
  que WKH-207 tocaría (esperada en el bloque de forward L265-284 o en nueva infraestructura). **Riesgo
  de colisión de MERGE: BAJO** — recomendado coordinar el ORDEN de merge si ambas tocan
  `submit/route.ts` en la misma ventana (evitar conflicto de línea, no de lógica). Sin colisión de NNN
  (WKH-205=`018`, WKH-207=`019`, coordinado por el orquestador).
- Puede correr en paralelo (F2 en simultáneo) con cualquier otra HU que NO toque
  `app/api/payout/validate/*`, `app/api/a2a/payout/challenge/*`, `src/infrastructure/rate-limit.ts`, o
  `app/api/a2a/payout/submit/route.ts:39-41`.
