# Work Item — [WKH-207] Persistencia server-side + reconciliación de remesas huérfanas

## Resumen

Cierra el residual explícitamente documentado por WKH-168 (comentario `ports.ts:115-124`,
`confirm-and-send.ts:55-65`, `submit/route.ts:27-28`): el estado de la remesa vive SOLO en
`localStorage` (cliente) y `ConfirmAndSend.execute()` corre client-side — si el browser se cierra
entre `principal_in` (dinero YA verificado on-chain adentro) y un estado terminal, la remesa queda
**huérfana, con el dinero REALMENTE adentro y sin forma de reconciliar**. Es la deuda técnica más
grande del gate de Fase A, nombrada sin eufemismo por el founder ("cero deuda técnica"). Esta HU
construye (1) persistencia server-side del estado crítico de la remesa y (2) un mecanismo de
reconciliación que detecta y resuelve remesas varadas SIN depender de que el mismo browser vuelva a
abrir la pestaña — con idempotencia estricta para nunca pagar dos veces.

## Sizing

- SDD_MODE: full (QUALITY, money-path + cambio arquitectónico)
- Estimación: **XL** (cambio arquitectónico nuevo: persistencia + reconciliación + ownership/RLS +
  auth de endpoint protegido; ver "Veredicto sobre el tamaño" abajo)
- Branch sugerido: `feat/207-remittance-persistence-reconciliation`

### Veredicto sobre el tamaño

Esta HU es la "Mitad B" que WKH-168 recomendó explícitamente separar (su propio work-item, DT-2:
"candidata L/XL, sugerido WKH-207"). No se recomienda partirla de nuevo en HUs separadas — el
founder ya la pidió como una sola unidad de "cero deuda técnica" — pero el Architect debería
organizar F3 en **2 waves dentro de la misma HU**:
- **Wave 1**: schema + migración (sin aplicar) + repository server-side + wiring aditivo en
  `/api/settle/principal` y `/api/a2a/payout/submit` (escribir/actualizar el registro, sin tocar
  guard-order).
- **Wave 2**: mecanismo de reconciliación (endpoint/job protegido) + idempotencia del retry +
  resolución manual con evidencia.

## Acceptance Criteria (EARS)

- **AC-1**: WHEN el settle del principal se verifica on-chain exitosamente
  (`verifySettlementOnChain` → `ok:true`) en `/api/settle/principal` Y el flag de persistencia
  server-side está ON, the system SHALL escribir un registro server-side persistente (txHash,
  monto verificado, receiver, address del sender, quoteId, timestamp) **antes** de responder la
  atestación al cliente.
- **AC-2**: WHILE el flag de persistencia server-side está OFF (default), the system SHALL
  preservar el comportamiento byte-idéntico a pre-HU: ningún registro server-side se escribe,
  `/api/settle/principal` y `/api/a2a/payout/submit` responden exactamente igual que hoy.
- **AC-3**: WHEN `/api/a2a/payout/submit` recibe un forward exitoso o fallido (4xx/5xx/timeout) del
  agente de payout, y el flag está ON, the system SHALL actualizar el registro server-side
  correlacionado con el resultado (`submitted` / `settled` / `failed` / `forward_error`).
- **AC-4**: WHEN el mecanismo de reconciliación se ejecuta, the system SHALL identificar remesas
  "varadas" — definidas como: registro con settle verificado (principal REALMENTE adentro) Y sin
  resolución terminal (sin forward exitoso confirmado, o atestación quemada sin forward posterior
  registrado) transcurrido un umbral de tiempo configurable.
- **AC-5**: WHEN la reconciliación reintenta el forward de una remesa varada, the system SHALL
  reusar el MISMO `idempotencyKey` (derivado del registro persistido, mismo patrón
  `${remittanceId}:${quoteId}` de WKH-186/WKH-168) usado en el intento original — PROHIBIDO generar
  uno nuevo.
- **AC-6**: IF el reintento de reconciliación falla de nuevo, O el mecanismo no puede determinar con
  certeza si el payout ya se pagó, THEN the system SHALL marcar la remesa para **resolución
  MANUAL** con toda la evidencia disponible (txHash, monto, receiver, address, quoteId, historial de
  intentos) — PROHIBIDO reintentar indefinidamente sin backoff/límite, PROHIBIDO asumir éxito
  silencioso.
- **AC-7**: the system SHALL exponer el mecanismo de reconciliación protegido por autenticación
  server-side (secreto compartido o equivalente) — NUNCA público/sin auth, dado que opera sobre el
  money-path.
- **AC-8**: the system SHALL entregar la migración de la(s) tabla(s) nueva(s) como archivo
  **PENDING-DEPLOY** (no aplicado a ninguna base de datos dev/staging/prod) — la aplicación es una
  acción gated que ejecuta el founder fuera de esta HU.
- **AC-9**: IF la tabla nueva persiste datos de remesa asociados a un usuario (ownerAddress/
  beneficiary), THEN the system SHALL aplicar el patrón de ownership del ecosistema — filtro
  app-layer por owner/dirección equivalente en cada query/mutación desde `src/`/`app/api/`, y (si el
  motor lo soporta) RLS como defensa en profundidad.
- **AC-10**: WHILE la migración no está aplicada Y/O el flag de persistencia está OFF, the system
  SHALL degradar con gracia (feature-detect/catch) sin romper ningún flujo existente — ninguna ruta
  que hoy funciona debe empezar a fallar por la sola presencia de código nuevo apagado.

## Scope IN

- Migración nueva (SQL, ubicación depende de DT-1 — `supabase/migrations/` si se adopta Opción C, o
  N/A si se adopta Opción A/Upstash) — **archivo únicamente, NO se aplica**.
- `src/application/ports.ts` — extender `RemittanceRepository` (o agregar un port nuevo, p.ej.
  `ReconciliationStore`/`SettlementLedger`) con la capacidad de consulta que la reconciliación
  necesita (ej. listar registros no-terminales más viejos que un umbral).
- Infra nueva (`src/infrastructure/persistence/...` o similar, nombre exacto a definir en F2) —
  implementación server-side del port nuevo, flag-gated, con ownership/RLS (AC-9).
- `app/api/settle/principal/route.ts` — wiring ADITIVO: escribir el registro server-side tras V9
  (verificación on-chain exitosa), sin tocar el guard-order S1-V9 existente (AC-1/CD-3).
- `app/api/a2a/payout/submit/route.ts` — wiring ADITIVO: actualizar el registro tras el forward,
  sin tocar el guard-order 1-8 existente (AC-3/CD-3).
- Endpoint/mecanismo nuevo de reconciliación (ej. `app/api/admin/reconcile-orphans/route.ts` o
  equivalente — nombre a definir en F2), protegido por auth server-side (AC-7).
- `.env.example` — documentar las env vars nuevas (persistencia + secreto de reconciliación),
  SIEMPRE server-only salvo que el Architect justifique lo contrario.
- `src/test-support/fakes.ts` / `test-container.ts` — fake del port nuevo.
- Tests correspondientes (≥1 por AC).

## Scope OUT

- **Aplicar la migración** a cualquier base de datos (dev/staging/prod) — acción gated del founder.
- **Encender el flag de persistencia server-side por default** en cualquier entorno.
- El **guard-order** de `/api/a2a/payout/submit` (guards 1-8, WKH-202/168/206) y la lógica de
  atestación/PoP ya aprobada — solo wiring aditivo POST-guards.
- La **orquestación/secuencia** de `confirm-and-send.ts` — sigue corriendo client-side sin cambios
  de guard-order; la persistencia server-side es un side-effect ADICIONAL en las rutas API, NO un
  reemplazo del flujo client-side (ver DT-2 heredado de WKH-168: mover solo el storage no alcanza,
  pero tampoco se reescribe la orquestación en esta HU — el punto de escritura server-side es
  `/api/settle/principal`/`/api/a2a/payout/submit`, que YA son server-side hoy).
- **Clawback on-chain real** de un principal ya settleado — sigue siendo Scope OUT heredado de
  WKH-168/DT-8 (requiere autorización del receiver, imposible con el patrón `RefundGateway` actual).
- **Automatizar el disparo** de la reconciliación (cron/scheduler de infraestructura) — se entrega
  el mecanismo invocable; la programación (Vercel Cron, GitHub Actions, manual) es TBD (ver Missing
  Inputs).
- **UI/UX de usuario final** para mostrar el estado de reconciliación — es una operación
  admin/server-side, no user-facing, en esta HU.
- Habilitar el payout real o Mitad B/TransFi (sigue bloqueado por partner/sandbox).
- El demo del jurado (`chaski-ai.vercel.app`, `yarvis`, `agentshop-*`).
- Modificar código de `wasiai-facilitator`, `wasiai-a2a` o `wasiai-v2` — guardrail "standalone" del
  `project-context.md` (ver DT-1).
- G5/WKH-206 (ya DONE) y WKH-205 (backlog separado — ver Análisis de paralelismo).

## Decisiones técnicas (DT-N)

### DT-1 — Dónde persiste (NO decidido en F1, ver Missing Inputs BLOQUEANTE)

Heredado literal de `doc/sdd/016-wkh-168-principal-in-real-settlement/work-item.md` (DT-2), que ya
evaluó 3 opciones sin decidir:

| Opción | Resumen | Estado |
|--------|---------|--------|
| **A. Upstash Redis** (ya cableado, hoy solo rate-limit + single-use flags) | Cero infra nueva; el shape de `RemittanceState`+CAS de `LocalRepo` es casi copiable 1:1. Sin queries relacionales robustas — la reconciliación tendría que mantener sus propios índices manuales (ej. un set ordenado por timestamp). | Viable como MVP de menor fricción |
| **B. Supabase de `wasiai-a2a`** | Postgres real, patrón `owner_ref`+RLS ya probado ahí | **DESCARTADA** — viola literalmente el guardrail `project-context.md`: "NUNCA tocar wasiai-a2a... Chaski v2 es standalone" |
| **C. Supabase/Postgres propio de `chaski-v2`** | Respeta 100% el guardrail; Postgres real con queries/reconciliación nativas | Mayor lift (proyecto Supabase nuevo, credenciales, migraciones) |

**Recomendación no-vinculante (heredada)**: Opción C para el alcance completo (persistencia +
reconciliación con queries robustas); Opción A como paso intermedio si se prioriza velocidad. Esta
decisión requiere **aprobación humana explícita del founder** antes de que el Architect cierre el
SDD en F2 — no es una llamada del Analyst ni del Architect en solitario.

### DT-2 — El punto de escritura server-side NO es el client-side repo

Insight heredado de WKH-168/DT-2: mover solo el storage (`localStorage` → DB) no cierra el gap,
porque `ConfirmAndSend.execute()` sigue corriendo en el browser — cerrar la pestaña a mitad de un
`await` aborta la ejecución sin importar dónde se lee/escribe el estado. El punto de escritura
server-side de esta HU es **`/api/settle/principal`** (ya server-side, ya verifica on-chain) y
**`/api/a2a/payout/submit`** (ya server-side, ya reenvía al agente) — se les agrega un side-effect
de persistencia AL FINAL de su lógica existente (post-guards), sin mover ni reordenar la
orquestación de `confirm-and-send.ts`.

### DT-3 — Hallazgo: `/api/settle/principal` hoy NO recibe `remittanceId`

Verificado en disco (`app/api/settle/principal/route.ts`, `src/infrastructure/wallet.ts:37-39`): el
nonce EIP-3009 es `keccak256(remittanceId:quoteId)` — **determinístico pero one-way** (no se puede
recuperar `remittanceId` desde el nonce). El body que llega a `/api/settle/principal` solo trae
`authorization` (incluye el nonce hasheado), `signature`, `address`, `quoteId`,
`expectedValueMinor` — ningún campo `remittanceId` explícito. Para correlacionar el registro
server-side nuevo con el agregado `Remittance` del cliente hay 2 caminos (Architect decide en F2,
NO bloqueante para F1):
1. Agregar `remittanceId` como campo explícito nuevo del body de `/api/settle/principal` (cambio
   menor y aditivo al shape existente).
2. Correlacionar SIN `remittanceId`, usando `(address, quoteId, txHash)` como clave compuesta —
   evita tocar el contrato del endpoint, pero es una clave menos directa para la reconciliación.

### DT-4 — Idempotencia del retry: reusar, NUNCA regenerar

El `idempotencyKey` que hoy usa `ConfirmAndSend` es `${remittanceId}:${quoteId}`
(`confirm-and-send.ts:216`). El retry de reconciliación DEBE reusar ese MISMO valor derivado del
registro persistido — regenerar uno nuevo reabriría exactamente el vector de doble-pago que
`deterministicNonce` (WKH-168/CD-19) cerró para la firma EIP-3009. El Architect debe verificar en
F2 que el agente `remit-cashout-payout` (repo `wasiai-remittance-agents`) deduplica de verdad por
`idempotencyKey` del lado del partner — si no lo garantiza, el criterio de AC-6 (preferir "varado"
antes que doble-pago) manda: NO reintentar automáticamente, marcar para resolución manual.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO aplicar la migración a cualquier base de datos (dev/staging/prod) como parte
  de esta HU — solo se entrega el archivo, PENDING-DEPLOY.
- **CD-2**: PROHIBIDO encender el flag de persistencia server-side por default en cualquier entorno
  — off por default al terminar F3, comportamiento byte-idéntico (AC-2).
- **CD-3**: PROHIBIDO tocar el guard-order de `/api/a2a/payout/submit` (guards 1-8) ni la lógica de
  atestación/PoP ya aprobada (WKH-168/WKH-202/WKH-206) — solo wiring aditivo POST-guards.
- **CD-4**: PROHIBIDO tocar el guard-order S1-V9 de `/api/settle/principal`, ni la secuencia
  broadcast→verify→attest — solo wiring aditivo tras V9.
- **CD-5**: PROHIBIDO tocar la orquestación/secuencia de `confirm-and-send.ts` — el use-case sigue
  corriendo client-side sin cambios de guard-order (CAS → autoridad → expiry → firma → expiry →
  submit se mantiene intacto).
- **CD-6**: PROHIBIDO que el reintento de reconciliación pueda producir doble-pago — preferir
  "varado, resolución manual" antes que arriesgar un segundo desembolso (mismo criterio de WKH-168).
- **CD-7**: PROHIBIDO persistir PII cruda en la tabla/registro nuevo — reusar el reductor existente
  (`toPersistedIdentity`) si aplica, y guardar solo lo mínimo necesario para reconciliar (txHash,
  montos, address, quoteId, status, timestamps) — NUNCA documento de identidad, fecha de
  nacimiento, nacionalidad.
- **CD-8**: PROHIBIDO exponer el endpoint/mecanismo de reconciliación sin autenticación — debe
  rechazar (401/403) cualquier request sin la credencial server-side configurada.
- **CD-9**: OBLIGATORIO — cualquier query/mutación sobre la tabla/registro nuevo desde `src/`/
  `app/api/` DEBE filtrar por el owner/dirección del caller cuando aplique (mismo patrón
  `owner_ref` documentado en `CLAUDE.md` del ecosistema WasiAI/`wasiai-a2a`).
- **CD-10**: PROHIBIDO usar la base de datos de `wasiai-a2a` (Opción B de DT-1) sin decisión humana
  explícita — viola el guardrail "standalone" de `project-context.md` tal como está escrito hoy.

## Categorías de riesgo de seguridad (money-path)

| Riesgo | Descripción | Mitigación en esta HU |
|--------|-------------|------------------------|
| **R1 — Doble-pago en el retry** | Reintentar el forward con un `idempotencyKey` nuevo, o sin garantía de dedupe del agente, paga dos veces el mismo principal | AC-5/DT-4/CD-6: reusar el MISMO idempotencyKey; si no hay garantía de dedupe, preferir "varado" (AC-6) |
| **R2 — Reconciliación pública/sin auth** | Cualquiera dispara reintentos de payout sobre remesas ajenas, o lee evidencia (montos/address/txHash) de terceros | AC-7/CD-8: auth server-side obligatoria |
| **R3 — Data leak / IDOR en la tabla nueva** | Query sin filtro por owner permite leer/mutar remesas de otro usuario (mismo patrón `a2a_agent_keys` IDOR documentado en `wasiai-a2a`) | AC-9/CD-9: ownership app-layer + RLS defensa en profundidad |
| **R4 — Migración aplicada por error** | Un `db push`/`migrate` accidental en CI/CD toca prod antes de la revisión del founder | AC-8/CD-1: archivo PENDING-DEPLOY, NUNCA ejecutado por esta HU |
| **R5 — Flag ON en un scope de Vercel por error** | Persistencia server-side empieza a escribir en un entorno no revisado (preview/staging) | CD-2: off por default; AC-2 preserva byte-identidad |
| **R6 — Reconciliación "resuelve" con datos no verificados** | Retry usa un monto/receiver del CLIENTE en vez del verificado on-chain persistido en AC-1 | AC-1: el registro server-side se escribe con los valores YA verificados on-chain (V6/V8 de WKH-168), nunca un eco del cliente |
| **R7 — PII en la tabla de reconciliación** | La tabla nueva termina guardando identidad cruda del beneficiario/sender para "contexto" | CD-7: solo evidencia mínima money-path, nunca identidad |

## Missing Inputs

- **[NEEDS CLARIFICATION — BLOQUEANTE para F2]** DT-1: ¿Opción A (Upstash) o Opción C (Supabase
  propio de `chaski-v2`)? Requiere decisión humana del founder (Opción B queda descartada salvo
  decisión explícita, CD-10). El Architect NO puede cerrar el SDD sin esto — determina el shape
  entero del repository/migración.
- **[NEEDS CLARIFICATION — NO bloqueante]** DT-3: ¿se agrega `remittanceId` explícito al body de
  `/api/settle/principal`, o se correlaciona por `(address, quoteId, txHash)`? Resoluble en F2.
- **[TBD]** Mecanismo de disparo de la reconciliación: cron externo (Vercel Cron/GitHub Actions),
  invocación manual documentada en runbook, o ambas — no decidido en F1.
- **[TBD]** Umbral de tiempo exacto para considerar una remesa "varada" (ej. 5/10/30 min desde
  `principal_in` sin avanzar) — a definir en F2 con el founder/Architect.
- **[TBD]** Si el agente `remit-cashout-payout` (repo `wasiai-remittance-agents`) garantiza dedupe
  real por `idempotencyKey` del lado del partner — impacta si el retry automático de AC-5 es seguro
  o si CD-6/AC-6 fuerza resolución manual SIEMPRE (más conservador). Verificar en F2 leyendo ese
  repo.
- **[SIN PRODUCT CONTEXT]** (heredado de WKH-168): no existe `product-context.md`. Contexto de
  negocio asumido: remesas USDC→PEN→Yape; sender cripto-nativo; los legs regulados los ejecutan
  partners licenciados; WasiAI es la capa de orquestación, no el money transmitter.

## Análisis de paralelismo

- **WKH-205** (follow-ups de WKH-202, `018` pre-asignado por el orquestador) está declarada como
  corriendo en paralelo, pero al momento de este F0 su carpeta `doc/sdd/018-...` **no existe aún en
  disco** (no se pudo verificar su Scope IN exacto). Riesgo de colisión ALTO por patrón histórico:
  prácticamente todas las HUs de este backlog (WKH-180/182/186/198/200/202/168/206) tocan
  `ports.ts`/`confirm-and-send.ts`/`container.ts` — mismo patrón de colisión de merge que motivó las
  notas de coordinación de WKH-198..201. **Recomendación**: coordinar con el orquestador/Architect
  el orden de merge ANTES de F3 de cualquiera de las dos HUs; si WKH-207 se mantiene aditiva (solo
  extiende `ports.ts` con un port/método nuevo, sin tocar la firma de `ConfirmAndSend`) el riesgo se
  reduce a conflicto de líneas, no de diseño.
- Esta HU **no bloquea** a otras HUs activas conocidas — es el cierre de un residual ya documentado,
  no una dependencia de nadie más.
- Esta HU está **bloqueada conceptualmente** por la decisión humana de DT-1 (dónde persiste) antes
  de que el Architect pueda cerrar F2 — ver Missing Inputs.
- Trabaja sobre el estado ya mergeado de WKH-178..206 (`main`), incluyendo WKH-206 (DONE
  2026-07-16, mismo día).
- Toca los mismos archivos "de siempre" del backlog (`ports.ts`, `container.ts`,
  `app/api/settle/principal/route.ts`, `app/api/a2a/payout/submit/route.ts`) — todos ya en `main`,
  sin overlap de HUs activas verificado salvo el riesgo WKH-205 arriba documentado.
- Cierra el ÚLTIMO residual explícitamente nombrado del gate de Fase A (G3/WKH-168, AC-9): tras esta
  HU, el founder puede declarar honestamente "cero deuda técnica" documentada en código para el
  money-path de settle del principal.
