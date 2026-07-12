# Work Item — [WKH-187] Reordenar el flujo: mostrar el quote (valor) antes del KYC

## Resumen
Hoy Chaski pide la verificación de identidad (KYC/Didit) ANTES de mostrarle al usuario cuánto le
llega a su familia. El founder quiere invertir el orden: mostrar el quote lockeado (el valor real,
"tu familia recibe S/ X") apenas conecta la wallet, y pedir el KYC recién cuando el usuario confirma
que quiere enviar — sin debilitar en absoluto el gate de KYC antes del payout (compliance).
Beneficiario: founder/producto (reduce fricción/drop-off pre-KYC). Mecanismo: reordenar la máquina
de estados del dominio + la máquina de UI, preservando el gate duro de `confirm()` y la autoridad
server-side de WKH-180 intactos.

## Sizing
- SDD_MODE: full
- Estimación: M
- Branch sugerido: feat/187-quote-before-kyc-reorder

## F0 — Grounding (verificado post-WKH-186, líneas reales)

### Estado actual (dominio) — `src/domain/remittance.ts`
- `RemittanceStatus` (L72-83) y `TRANSITIONS` (L85-97):
  ```
  created:     ["kyc_pending"]
  kyc_pending: ["kyc_passed", "kyc_failed"]
  kyc_passed:  ["quoted"]
  kyc_failed:  []
  quoted:      ["quoted", "confirmed"]   // re-quote permitido
  confirmed:   ["principal_in", "payout_failed"]
  ...
  ```
  Orden actual: `created → kyc_pending → kyc_passed → quoted → confirmed`. El quote se ata
  DESPUÉS del KYC (`attachQuote()`, L210-216, solo alcanzable desde `kyc_passed`).
- `confirm()` (L219-226): invariante DURA — `this.state.kyc.approved && payoutAllowed` (L220-221)
  + quote presente y no vencido (L223-224). Esto lee el CAMPO `kyc` del estado (seteado por
  `applyKyc()`, L202-208), **no** la posición en la FSM. Es la pieza que NO se debe tocar.
- `attachQuote()` (L210-216): valida `quote.send.minor === sendUsd.minor` + no-vencido +
  `assertReceiveConsistent` (A5), y hace `this.to("quoted", ...)`. No depende de qué estado previo
  es válido salvo por `canTransition()`.
- `startKyc()` (L198-200): `this.to("kyc_pending", now, {ownerAddress})`. Hoy solo alcanzable desde
  `created`.

### Estado actual (UI) — `src/presentation/flow.tsx`
- `Step` (L20): `"send" | "connect" | "verify" | "review" | "track" | "done"`.
- `STEP_LABELS`/`STEP_INDEX` (L21-29): `["Enviar","Identidad","Revisar","Seguir"]`, connect/verify
  comparten índice 1 ("Identidad"), review=2, track/done=3.
- `onSend` (L151-160): crea la remesa (`createRemittance`) → step `"connect"`.
- `onConnect` (L162-181): conecta wallet; si `rememberedKyc` válido (KYC-once) → `startKyc()` (aplica
  el recordado) → `lockQuote()` → step `"review"`; si no → step `"verify"`.
- `onVerify` (L183-212): dispara `startKyc()` real (redirect Didit o simulación). Si `kind:"done"` y
  `kyc_passed` → `lockQuote()` → step `"review"`.
- Efecto de resume (L88-137, tras volver del redirect de Didit): en `kind:"passed"` hace
  `lockQuote()` de nuevo (L114) y **siempre** navega a `"review"` (L119) — el target a corregir.
- `step === "review"` (L548-596): muestra el quote lockeado + `rem.kyc.identity` (badge de
  identidad verificada, L568-580) + botón "Confirmar y enviar" (`onConfirm`, L587-589) o, si
  `error` (quote vencido, MNR-1), botón "Recotizar tasa" (`onRelock`, L582-584).

### Use-cases involucrados
- `create-remittance.ts`: crea en `"created"`, sin quote ni kyc. Sin cambios necesarios.
- `connect-wallet.ts`: conecta + devuelve `rememberedKyc`. Sin cambios de firma.
- `lock-quote.ts`: `attachQuote()`. Hoy se llama DESPUÉS del KYC (en `onConnect`/`onVerify`); con el
  reorden se llama ANTES (justo tras conectar), y potencialmente de nuevo si el quote vence durante
  el KYC (re-quote, reusa el mismo use-case).
- `start-kyc.ts`: sin cambios de firma; el `remittanceId` que recibe ya estará en `"quoted"` (no
  `"created"`) cuando se invoque.
- `resume-kyc.ts` (L23-52): lee el pendiente, aplica la decisión de Didit vía `r.applyKyc()`. El
  `snapshot` devuelto YA conserva el `quote` atado antes del redirect (el patch de `to()`,
  `remittance.ts` L195, hace shallow-merge — `quote` no se limpia al pasar por `kyc_pending`). Esto
  es CLAVE: el resume NO necesita re-cotizar si el quote sigue vigente.
- `confirm-and-send.ts` (WKH-180/182/186, L48-131): **sin cambios** — sigue llamando `r.confirm()`
  (paso 1) y la autoridad server-side `authority.authorize()` (paso 2, WKH-180) SIEMPRE, más los
  re-checks de vigencia del quote (pasos 2.5/3.5, WKH-182). Esto es independiente del orden de UI:
  confirma que el gate de compliance sigue intacto pase lo que pase en el cliente.

### El borde "quote vence durante el KYC" (foco de esta HU)
Con el reorden, la ventana entre `attachQuote()` y `confirm()` se ALARGA: hoy el quote se ata justo
antes de mostrar "review" (ventana corta = tiempo de lectura + click). Con el reorden, el quote se
ata ANTES del escaneo Didit — que puede tardar minutos (redirect real) — por lo que la ventana pasa
a cubrir TODO el KYC. La maquinaria de expiry ya existe y es reusable sin cambios de dominio:
- `isQuoteExpired()` (privado, L257-259) + `isQuoteStillValid()` (público, L253-255, WKH-182/M2).
- `confirm()` ya lanza `confirm_quote_expired` si el quote venció (L224).
- La UI YA tiene el patrón de recuperación (MNR-1, `flow.tsx` L582-584/222-228): si `onConfirm`
  falla con `quote_expired` (mapeado a copy humano en `flow-vm.ts` L23-24), se muestra "Recotizar
  tasa" (`onRelock`, que vuelve a llamar `lockQuote.execute()`) en vez de re-lanzar `onConfirm`.
  Este mismo patrón se reusa en el paso final post-KYC (ya no en el viejo "review" único, sino en el
  paso de confirmación final que sigue al KYC).

### KYC-once (WKH-181/184)
`onConnect` (L165-181) ya decide, ANTES de tocar KYC, si la wallet tiene un KYC recordado válido. En
el nuevo orden esa decisión sigue disponible en el mismo punto (tras `connectWallet.execute()`), solo
que ahora determina el SIGUIENTE paso tras el quote (saltar directo a confirmar vs. ir a verificar),
no si se cotiza o no.

## Acceptance Criteria (EARS)

- AC-1: WHEN el usuario conecta su wallet (paso `connect`), the system SHALL cotizar (`attachQuote`)
  la remesa ANTES de iniciar cualquier verificación de identidad, y SHALL mostrarle el monto que
  recibe su familia (quote lockeado, no solo el preview en vivo del paso `send`).
- AC-2: WHILE el usuario está en el paso de revisión pre-KYC (quote ya lockeado, KYC aún no
  iniciado), the system SHALL exponer una acción explícita ("continuar" / "quiero enviarlo") que
  es la que dispara el inicio del KYC — el sistema SHALL NOT iniciar el KYC automáticamente sin esa
  acción.
- AC-3: IF el KYC no ha sido aprobado (`kyc == null` o `kyc.approved/payoutAllowed` falso) para la
  remesa, THEN the system SHALL rechazar cualquier intento de `confirm()` con
  `confirm_requires_kyc_passed` — este comportamiento de `remittance.ts` (L219-222) SHALL permanecer
  byte-idéntico; el reorden de la FSM SHALL NOT debilitar, saltear ni volver opcional esta guarda.
- AC-4: WHEN el KYC-once encuentra una verificación recordada válida para la wallet conectada
  (`rememberedKyc.approved && payoutAllowed`), the system SHALL saltear el paso de escaneo (`verify`)
  y llevar al usuario directo al paso de confirmación final, preservando el quote ya lockeado en
  `connect`.
- AC-5: IF el quote asociado a la remesa vence en cualquier punto entre `attachQuote()` y
  `confirm()` (incluyendo mientras el usuario está en el escaneo Didit), THEN the system SHALL
  impedir la confirmación con ese quote vencido (`confirm_quote_expired`, `remittance.ts` L224) y
  SHALL ofrecer al usuario una vía de recuperación sin dead-end (re-cotizar) que preserva el KYC ya
  aprobado (no se le vuelve a pedir escanear el documento).
- AC-6: WHEN el usuario vuelve del redirect de Didit (resume, `flow.tsx` L88-137) con una decisión
  `passed`, the system SHALL navegar al paso de confirmación final (post-KYC) usando el `quote` que
  ya viaja en el `snapshot` retomado, SHALL NOT forzar una re-cotización incondicional si el quote
  retomado sigue vigente (`isQuoteStillValid`).
- AC-7: the system SHALL preservar, sin ningún cambio de comportamiento, la autoridad server-side de
  payout (WKH-180, `confirm-and-send.ts` L60-72: `authority.authorize()` tras `r.confirm()`, ANTES
  de autorizar el principal) — el reorden de UI/dominio es puramente de secuencia de PASOS DE
  ENTRADA (cuándo se pide cada cosa), no de las invariantes de money-path/compliance ya cerradas por
  WKH-180/182/186.
- AC-8: WHERE el usuario ya está en el paso de confirmación final (post-KYC, quote lockeado + KYC
  aprobado), the system SHALL mostrar el badge de identidad verificada (`rem.kyc.identity`) junto al
  quote, igual que hoy lo hace el paso `review` (`flow.tsx` L568-580) — no se pierde información al
  reordenar.
- AC-9: the system SHALL mantener el resto de la máquina de estados sin cambios de comportamiento
  observable post-`confirmed` (`principal_in → payout_submitted → settled/payout_failed → refunded`)
  — el scope de esta HU es exclusivamente el tramo `created → ... → confirmed`.

## Scope IN
- `src/domain/remittance.ts` — reordenar `TRANSITIONS` para que `attachQuote()` sea alcanzable desde
  `created` (primera cotización) y desde `kyc_passed` (re-cotización post-expiry sin perder el KYC),
  y `startKyc()` sea alcanzable desde `quoted` en lugar de `created`. Propuesta concreta (a validar
  en F2):
  ```
  created:     ["quoted"]
  quoted:      ["quoted", "kyc_pending"]
  kyc_pending: ["kyc_passed", "kyc_failed"]
  kyc_passed:  ["quoted", "confirmed"]
  kyc_failed:  []
  confirmed:   ["principal_in", "payout_failed"]   // sin cambios
  ...                                                // resto sin cambios
  ```
  `confirm()` y `applyKyc()` SHALL NOT cambiar su lógica interna (siguen leyendo `state.kyc`/
  `state.quote`, no la posición en la FSM).
- `src/application/use-cases/start-kyc.ts`, `resume-kyc.ts`, `lock-quote.ts`, `connect-wallet.ts` —
  ajuste de ORDEN de invocación desde `flow.tsx` (no necesariamente de firma/lógica interna de los
  use-cases, que ya son agnósticos al estado previo salvo por `canTransition`).
- `src/presentation/flow.tsx` — reordenar el `Step` type y los handlers: `lockQuote()` se invoca en
  `onConnect` (no en `onVerify`/dentro del branch de KYC-once); nuevo paso de revisión PRE-KYC con
  CTA explícita hacia `verify`; el paso de confirmación final (post-KYC) es el que hoy es `"review"`
  (con `onConfirm`/`onRelock`); el efecto de resume (L88-137) navega al paso de confirmación final
  en vez de a `"review"` a secas, sin re-lock incondicional. `STEP_LABELS`/`STEP_INDEX` actualizados
  al nuevo orden.
- Tests existentes a actualizar por el reorden: `src/domain/remittance.test.ts` (TRANSITIONS),
  `src/application/use-cases/confirm-and-send.test.ts`, `abandon-pending-kyc.test.ts`,
  `forget-kyc.test.ts`, `track-remittance.test.ts` (fixtures que construyen remesas vía la secuencia
  vieja `startKyc→applyKyc→attachQuote`), `src/presentation/flow.test.tsx` (RTL, WKH-185).

## Scope OUT
- Cualquier cambio a `confirm()` / `applyKyc()` / la autoridad server-side WKH-180 más allá de
  ajustar QUÉ estados pueden llamarlos (la LÓGICA interna de esas guardas no cambia).
- El tramo `confirmed → ... → settled/refunded` (value-delivery, WKH-186) — sin cambios.
- El copy/diseño exacto del paso de revisión pre-KYC y del stepper (`STEP_LABELS`) — se define en F2
  con Architect (ver Missing Inputs).
- Cambiar el comportamiento del preview en vivo del paso `send` (`previewQuote`, no crea remesa) —
  sigue igual, es un preview no-lockeado, distinto del quote lockeado post-connect de esta HU.
- Persistencia/schema de `RemittanceState` — sin cambios de forma (mismos campos).
- Cualquier cambio al partner/agente de KYC (Didit) o de FX/payout — fuera de scope, solo se
  reordena CUÁNDO se llaman, no CÓMO.

## Decisiones técnicas (DT-N)
- DT-1: El reorden de `TRANSITIONS` propuesto (ver Scope IN) es la opción de MÍNIMO diff que preserva
  el invariante de compliance: `confirm()` sigue leyendo el campo `kyc` del estado (no la posición
  en la FSM), por lo que reordenar CUÁNDO se llega a `kyc_passed` relativo a `quoted` no afecta la
  fuerza del gate.
- DT-2: El re-quote post-KYC (si el quote vence durante el escaneo) reusa `LockQuote`/`attachQuote()`
  sin cambios de lógica — solo se habilita la transición `kyc_passed → quoted` para que sea
  alcanzable. El KYC ya aprobado (`state.kyc`) NO se pierde al volver a `quoted` (el patch de `to()`
  es shallow-merge, `remittance.ts` L195).
- DT-3: El efecto de resume de Didit (`flow.tsx` L88-137) deja de re-cotizar incondicionalmente en
  `kind:"passed"` — usa el `quote` que ya viaja en `res.snapshot` (persistido antes del redirect) y
  solo re-cotiza si `isQuoteStillValid()` da falso. Esto cierra el borde de "doble cotización
  innecesaria" que introduciría el reorden si se copiara el código actual sin ajuste.
- DT-4: Nombre y cantidad exacta de `Step`s (¿se reusa `"review"` para ambos momentos con un flag
  interno, o se agregan pasos separados pre/post-KYC?) — decisión de implementación que el Architect
  cierra en F2 (no cambia las ACs, solo el mecanismo). Ambas opciones preservan AC-1..AC-9.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/` (repo `chaski-v2` únicamente; no
  tocar `wasiai-a2a`, `wasiai-v2`, `wasiai-remittance-agents`).
- CD-2 (COMPLIANCE, CRÍTICA): PROHIBIDO debilitar, saltear, hacer condicional-por-flag, o de
  cualquier forma reducir la fuerza del gate `confirm_requires_kyc_passed`
  (`remittance.ts` L219-222). El reorden es EXCLUSIVAMENTE de UX/secuencia de UI y de qué estados de
  la FSM son alcanzables entre sí — NO de qué invariantes se verifican. Cualquier PR que toque
  `confirm()` para debilitar esta guarda (ej. agregar un bypass, hacerla `if (kyc || flag)`) es
  BLOQUEANTE en AR.
- CD-3 (COMPLIANCE, CRÍTICA): PROHIBIDO tocar `confirm-and-send.ts` para remover, condicionar o
  debilitar el paso 2 (`authority.authorize()`, WKH-180) — la autoridad server-side sigue siendo la
  única fuente de verdad para autorizar el payout, independiente de en qué orden la UI pidió las
  cosas al usuario.
- CD-4: OBLIGATORIO que toda transición nueva agregada a `TRANSITIONS` tenga una razón de negocio
  explícita documentada en un comentario inline (mismo patrón que las transiciones existentes,
  ej. `"re-quote permitido"` en L90) — no agregar transiciones "por si acaso".
- CD-5: PROHIBIDO romper el demo existente (WKH-178/184): `isDemoMode()`, el modo fallback sin key de
  Didit, y el flujo KYC-once (WKH-181/184) SHALL seguir funcionando end-to-end tras el reorden.
- CD-6: OBLIGATORIO actualizar los tests afectados (Scope IN) en la MISMA HU — no dejar tests rojos
  ni tests que queden validando el orden viejo sin que el código lo soporte.

## Missing Inputs
- [NEEDS CLARIFICATION] Copy/diseño exacto del paso de revisión PRE-KYC: ¿se muestra el breakdown
  completo (fee, tasa, ETA) igual que el `review` actual, o una versión reducida ("tu familia recibe
  S/ X, continuá para verificar tu identidad y enviar")? No bloquea F2 (Architect puede proponer y
  el humano ajusta en gate), pero si hay una maqueta/preferencia del founder, agregarla acá.
- [NEEDS CLARIFICATION] Comportamiento exacto si el quote vence DURANTE el KYC (AC-5): ¿re-cotizar
  automáticamente al volver de Didit (silencioso, si el nuevo monto es "similar") o SIEMPRE requerir
  un tap explícito del usuario ("Recotizar tasa") antes de dejarlo confirmar? Y si el re-quote da un
  monto significativamente distinto (rate movió fuerte), ¿hace falta una re-confirmación explícita
  del nuevo monto (no solo re-mostrar la pantalla)? Bloqueante para F2 si no se resuelve — afecta el
  diseño del paso de confirmación final.
- [NEEDS CLARIFICATION] Nombres/labels exactos del `Stepper` (`STEP_LABELS`) tras el reorden — hoy
  son 4 labels para 6 steps con solape (`connect`/`verify` comparten "Identidad"). Con un paso nuevo
  de revisión pre-KYC, ¿el stepper pasa a 5 labels, o se mantiene la simplificación actual? No
  bloqueante (decisión de UI de bajo riesgo), Architect propone en F2.
- [TBD] No se pudo leer el ticket completo de Jira WKH-187 (`mcp__claude_ai_Atlassian__getJiraIssue`
  no está disponible en las tools de este agente en esta sesión) — este work-item se basó en el
  brief del orquestador (que ya contenía el detalle funcional) + grounding directo del código. Si el
  ticket de Jira tiene ACs o contexto adicional no reflejado acá (ej. métricas de drop-off que
  motivan el cambio, screenshots de diseño), agregarlos antes de HU_APPROVED.

## Análisis de paralelismo
- Esta HU trabaja sobre `main` ya consolidado post-WKH-178..186 (sin HUs en curso en paralelo sobre
  `chaski-v2` reportadas en `_INDEX.md`). No bloquea ni es bloqueada por ninguna HU abierta.
- Toca los MISMOS archivos centrales que casi todo el backlog de auditoría anterior
  (`remittance.ts`, `confirm-and-send.ts`, `flow.tsx`) — pero todas esas HUs ya están DONE y
  mergeadas, así que no hay colisión de merge esperada, solo el riesgo normal de que el reorden de
  la FSM interactúe con las invariantes que WKH-180/182/186 instalaron (mitigado explícitamente por
  AC-7/CD-3 y por reusar, sin tocar, la lógica de `confirm-and-send.ts`).
- Es una HU auto-contenida: no bloquea WKH-168 (desembolso real) ni depende de él — el value-delivery
  scaffolding de WKH-186 sigue intacto aguas abajo de `confirmed`.
