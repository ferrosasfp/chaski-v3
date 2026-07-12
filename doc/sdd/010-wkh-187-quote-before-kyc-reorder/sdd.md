# SDD #187: Reordenar el flujo — mostrar el quote (valor) antes del KYC

> SPEC_APPROVED: no
> Fecha: 2026-07-12
> Tipo: improvement (money-path / UX, secuencia de entrada)
> SDD_MODE: full
> Branch: feat/187-quote-before-kyc-reorder
> Artefactos: doc/sdd/010-wkh-187-quote-before-kyc-reorder/
> Repo: chaski-v2 (CD-1: SOLO este repo)

---

## 1. Resumen

Hoy Chaski pide el KYC (Didit) ANTES de mostrar cuánto recibe la familia. Esta HU invierte el orden:
el quote se **lockea apenas conecta la wallet** (`onConnect`), el usuario ve el valor real ("tu
familia recibe S/ X") en un paso de **revisión pre-KYC**, y el KYC se dispara recién cuando el usuario
decide continuar. El gate de compliance (`confirm()` exige `state.kyc` aprobado + la autoridad
server-side WKH-180) queda **byte-idéntico**: reordenamos QUÉ estados de la FSM son alcanzables entre
sí y CUÁNDO la UI pide cada cosa, nunca QUÉ invariantes se verifican.

**Hallazgo crítico de F2 (corrige el work-item):** el `TRANSITIONS` propuesto en el work-item
(`quoted: ["quoted","kyc_pending"]`, `kyc_passed: ["quoted","confirmed"]`) crea un **dead-end** para
el path de re-cotización que AC-5 exige "sin dead-end": tras un re-quote post-KYC la remesa cae en
`quoted`, desde donde `confirmed` es inalcanzable → `confirm()` lanzaría `invalid_transition:quoted->
confirmed`. El diseño correcto agrega `confirmed` como destino alcanzable desde `quoted` (ver §4.1,
DT-1b). Es seguro: `confirm()` sigue gateado por `state.kyc`, no por la posición FSM.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | WKH-187 |
| **Tipo** | improvement (secuencia UI + FSM) |
| **SDD_MODE** | full |
| **Objetivo** | Mostrar el quote lockeado antes del KYC, sin debilitar el gate KYC→payout |
| **Reglas de negocio** | `confirm()` (compliance) byte-idéntico; autoridad WKH-180 intacta; demo/KYC-once funcionando |
| **Scope IN** | `remittance.ts` (TRANSITIONS), `flow.tsx` (Step/handlers/stepper/resume), tests afectados. Use-cases: sin cambios de firma/lógica, solo orden de invocación desde `flow.tsx` |
| **Scope OUT** | `confirm()`/`applyKyc()` lógica interna; `confirm-and-send.ts`; tramo `confirmed→…→settled`; partner Didit/FX; schema `RemittanceState`; preview en vivo del paso `send` |
| **Missing Inputs** | Los 3 `[NEEDS CLARIFICATION]` del work-item se resuelven acá (decisiones del orquestador, §10) |

### Acceptance Criteria (referencia — el detalle está en `work-item.md`)

- **AC-1**: `onConnect` cotiza (`attachQuote`) ANTES de cualquier KYC y muestra el quote lockeado.
- **AC-2**: el paso de revisión pre-KYC expone una acción explícita que dispara el KYC; NO auto-inicia.
- **AC-3**: `confirm()` rechaza sin KYC (`confirm_requires_kyc_passed`) — byte-idéntico (L219-222).
- **AC-4**: KYC-once salta el escaneo → directo a confirmación final, preservando el quote lockeado.
- **AC-5**: quote vencido entre `attachQuote()` y `confirm()` → sin dead-end, re-cotiza sin re-escanear DNI.
- **AC-6**: resume de Didit `passed` → navega a confirmación final usando el quote del snapshot; re-cotiza solo si venció.
- **AC-7**: autoridad server-side WKH-180 sin cambios de comportamiento.
- **AC-8**: el paso de confirmación final muestra el badge de identidad verificada junto al quote.
- **AC-9**: la máquina post-`confirmed` sin cambios observables.

---

## 3. Context Map (Codebase Grounding — verificado post-WKH-186)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo (con línea real) |
|---------|---------|-----------------------------------|
| `src/domain/remittance.ts` | FSM + invariantes | `TRANSITIONS` L85-97 (orden actual `created→kyc_pending→kyc_passed→quoted→confirmed`); `canTransition` L101-103; `to()` **shallow-merge** L191-196 (el `quote` sobrevive el paso por `kyc_pending`); `startKyc` L198-200; `applyKyc` L202-208; `attachQuote` L210-216 (`to("quoted")` hardcodeado + valida monto/expiry/A5); `confirm()` L219-226 (**GATE DURO** L220-221, lee `state.kyc` no la FSM); `isQuoteStillValid` L253-255; `isQuoteExpired` L257-259 |
| `src/presentation/flow.tsx` | máquina de UI | `Step` L20; `STEP_LABELS`/`STEP_INDEX` L21-29; efecto resume L88-137 (L114 re-lock incondicional, L119 `setStep("review")` — a corregir); `onSend` L151-160; `onConnect` L162-181 (KYC-once L167-177, `lockQuote` L172); `onVerify` L183-212 (`lockQuote` L209); `onConfirm` L214-220; `onRelock` L223-228 (MNR-1); paso `review` L548-596 (quote breakdown L550-567, badge identidad L568-580, botones L581-594) |
| `src/application/use-cases/lock-quote.ts` | re-usa `attachQuote` | L12-24: `get→requestQuote→attachQuote→save`. Agnóstico al estado previo salvo `canTransition`. Sin cambios de firma |
| `src/application/use-cases/start-kyc.ts` | inicia KYC | L33 `r.startKyc()` sobre lo que reciba; KYC-once L36-41; redirect L59-69 (persiste pending, comentario L61 dice "created" — a actualizar a "quoted") |
| `src/application/use-cases/resume-kyc.ts` | retoma Didit | L33 corta si no está en `kyc_pending`; L48-51 `applyKyc→save→clear`. Snapshot conserva `quote`. Sin cambios |
| `src/application/use-cases/connect-wallet.ts` | login + KYC-once | L14-18: `connect→store.get`. Sin cambios |
| `src/application/use-cases/confirm-and-send.ts` | money-path | **NO-TOCAR (CD-3)**: `r.confirm()` L53 (paso 1), `authority.authorize()` L65-72 (paso 2, WKH-180), re-checks expiry L78/95, reconciliación L116. Independiente del orden de UI |
| `src/presentation/flow-vm.ts` | helpers UI puros | `isDemoMode` L6-8; `humanError` L22-35 (mapea `quote_expired`→copy L23-24); NO tiene helper de expiry-now (candidato a agregar, DT-3) |
| `src/domain/remittance.test.ts` | tests FSM | helper `ready()` L34-39 (`create→startKyc→applyKyc`, rompe con el reorden); `canTransition` L88-92 (assert `created→kyc_pending` rompe); happy path L42-54; A5 L107-145 |
| `src/application/use-cases/confirm-and-send.test.ts` | tests money-path | `seedQuoted()` L38-45 (`create→startKyc→applyKyc→attachQuote`, rompe) |
| `src/application/use-cases/track-remittance.test.ts` | tests tracking | setup L39-41 (`startKyc→applyKyc→attachQuote`, rompe) |
| `src/application/use-cases.test.ts` | tests use-cases | V1 orphan L187-219 (asserts `status=="created"` tras pending-fail, rompe → pasa a `"quoted"`); AC-6 L226-234; KYC-once L165-174; redirect+resume L176-185 |
| `src/infrastructure/persistence.test.ts` | tests CAS | L46 `r.startKyc(NOW, owner)` desde `created` (rompe); L132 usa `rehydrate` (order-independent, OK) |
| `src/presentation/flow.test.tsx` | RTL harness (WKH-185) | `goToReview()` L39-44 (send→connect→verify→review, cambia); framer-motion mock L14-25; T1/T2 leen el paso `review` (ahora `confirm`) |
| `doc/sdd/009…/auto-blindaje.md`, `008…/auto-blindaje.md` | blindaje histórico | Ver §7 CD-9/CD-10 (fixtures de fake consistentes con el quote; `window.location.reload` no redefinible en jsdom) |

### Exemplars verificados (Glob/Read confirmados)

| Para modificar | Seguir patrón de | Razón |
|----------------|------------------|-------|
| Nuevo paso `review` (pre-KYC) | paso `review` actual `flow.tsx` L548-596 | mismo breakdown de quote; sin badge KYC, sin `onConfirm` |
| Paso `confirm` (post-KYC) | paso `review` actual `flow.tsx` L548-596 | ES el review actual (badge + `onConfirm`/`onRelock`) renombrado |
| `onContinue` (nuevo handler) | `onSend` L151-160 / navegación pura | solo `setStep`, sin llamada de dominio (AC-2) |
| Re-check de expiry en resume | `isQuoteStillValid` domain L253-255 vía `Remittance.rehydrate` | single-source-of-truth de expiry (DT-3) |
| TRANSITIONS nuevo | comentarios inline existentes L90 (`// re-quote permitido`) | CD-4: razón de negocio por transición |

### Estado de BD / persistencia
Sin cambios de schema. `RemittanceState` (L132-149) mantiene forma. La persistencia es el
`RemittanceRepository` existente; los saves ocurren dentro de los use-cases actuales.

---

## 4. Diseño Técnico

### 4.1 Dominio — `src/domain/remittance.ts` (Wave 0)

**Único cambio de dominio: el objeto `TRANSITIONS` (L85-97).** `confirm()`, `applyKyc()`,
`attachQuote()`, `startKyc()`, `to()` y todos los `mark*` **NO cambian de lógica**.

Nuevo `TRANSITIONS` (cada transición con razón inline — CD-4):

```
created:     ["quoted"]                              // cotiza PRIMERO (quote antes de KYC, WKH-187)
quoted:      ["quoted", "kyc_pending", "confirmed"]  // re-quote | iniciar KYC | confirmar*
kyc_pending: ["kyc_passed", "kyc_failed"]            // (sin cambios)
kyc_passed:  ["quoted", "confirmed"]                 // re-quote post-KYC (conserva KYC) | confirmar
kyc_failed:  []                                      // (sin cambios)
confirmed:   ["principal_in", "payout_failed"]       // (sin cambios)
principal_in:     ["payout_submitted", "payout_failed"]  // (sin cambios)
payout_submitted: ["settled", "payout_failed"]           // (sin cambios)
settled:          []                                     // (sin cambios)
payout_failed:    ["refunded"]                           // (sin cambios)
refunded:         []                                     // (sin cambios)
```

`* quoted → confirmed` (**DT-1b, corrige el work-item**): necesario para el path re-cotizar→confirmar.
Tras un re-quote (`onRelock`), `attachQuote()` hace `to("quoted")` (L215, hardcodeado); si `confirmed`
no fuera alcanzable desde `quoted`, `confirm()` lanzaría `invalid_transition:quoted->confirmed` y AC-5
("sin dead-end") no se cumpliría. **Es seguro (COMPLIANCE, §5):** llegar a `quoted` con `state.kyc ==
null` (path pre-KYC `created→quoted`) y llamar `confirm()` lanza `confirm_requires_kyc_passed`
(L220-221) ANTES de intentar la transición — el gate real es el campo `kyc`, no la FSM (DT-1).

**Transiciones eliminadas vs. hoy:**
- `created → kyc_pending` (ya no): el KYC nunca arranca desde `created` en el nuevo orden; se fuerza
  a nivel FSM que **no se puede iniciar KYC sin haber cotizado** (propiedad deseable).
- `kyc_passed → quoted` **se conserva** (re-quote post-KYC sin perder el KYC).

**Trayectorias válidas resultantes:**
- Happy: `created →(attachQuote)→ quoted →(startKyc)→ kyc_pending →(applyKyc)→ kyc_passed →(confirm)→ confirmed`
- Re-quote pre-confirm: `kyc_passed →(attachQuote/onRelock)→ quoted →(confirm)→ confirmed`
- KYC-once: `created →(attachQuote)→ quoted →(startKyc remembered)→ kyc_pending →(applyKyc)→ kyc_passed →(confirm)→ confirmed`

### 4.2 UI — `src/presentation/flow.tsx` (Wave 2)

**`Step` type (L20) nuevo:**
```
"send" | "connect" | "review" | "verify" | "confirm" | "track" | "done"
```
`review` = pre-KYC (nuevo contenido); `confirm` = post-KYC (el actual `review` renombrado).

**`STEP_LABELS`/`STEP_INDEX` (L21-29)** — decisión #3 (§10): 4 labels, "Revisar" antes de "Identidad":
```
STEP_LABELS = ["Enviar", "Revisar", "Identidad", "Seguir"]
send:0 · connect:0 · review:1 · verify:2 · confirm:2 · track:3 · done:3
```
`confirm` comparte índice 2 ("Identidad") con `verify` — igual que hoy `connect`/`verify` comparten
índice (solape ya existente, riesgo bajo). Alternativa (5 labels con "Confirmar" propio) documentada
en §10 como no-bloqueante.

**Handlers:**

| Handler | Cambio | Detalle |
|---------|--------|---------|
| `onSend` L151-160 | sin cambios | `create` → `setStep("connect")` |
| `onConnect` L162-181 | **lockQuote movido acá** | `connectWallet` → `lockQuote` (`created→quoted`, quote visible AC-1). Luego: si `rememberedKyc` válido → `startKyc(remembered)` (`quoted→kyc_pending→kyc_passed`) → `setStep("confirm")` (KYC-once salta review+verify, AC-4); si no → `setStep("review")` |
| `onContinue` **(nuevo)** | navegación pura | `setStep("verify")`. Sin llamada de dominio (AC-2: la CTA lleva al KYC, no lo auto-inicia) |
| `onVerify` L183-212 | **quitar `lockQuote`** | quote ya lockeado en `onConnect`. `startKyc` (`quoted→kyc_pending`) → redirect Didit, o simulación `done`/`kyc_passed` → `setStep("confirm")`. El branch de error de KYC no cambia |
| `onConfirm` L214-220 | sin cambios | `confirmAndSend` → `track`/`done` |
| `onRelock` L223-228 | sin cambios de firma | re-quote desde `confirm`. Ahora parte de `kyc_passed→quoted` (o `quoted→quoted`); tras re-lock, `confirm()` usa `quoted→confirmed` (DT-1b) |

**Orden crítico en `onConnect`:** `lockQuote` (attachQuote, `created→quoted`) DEBE ir ANTES de
`startKyc` (que ahora exige `quoted→kyc_pending`). Invertirlo = `invalid_transition:created->kyc_pending`.

**Efecto de resume (L88-137)** — DT-3, decisión #1 (§10):
- Rama `passed` (L111-119): **navega a `"confirm"`** (no `"review"`).
- **No re-lockea incondicionalmente** (quitar el `lockQuote` incondicional de L114). En su lugar:
  1. `setRem(res.snapshot)` (el snapshot ya trae el `quote` lockeado pre-redirect).
  2. Chequear vigencia: `Remittance.rehydrate(res.snapshot).isQuoteStillValid(new Date().toISOString())`.
  3. Si **válido** → `setStep("confirm")` con el quote existente (AC-6: no re-cotiza).
  4. Si **vencido** → `lockQuote.execute()` (AUTO re-quote, sin tap manual), comparar
     `res.snapshot.quote.receive` (lo que vio pre-KYC) vs. el nuevo `locked.snapshot.quote.receive`;
     si difieren, setear un flag de UI (`rateUpdated`) → `setStep("confirm")` (AC-5: sin dead-end,
     NUNCA re-pide escanear el DNI porque el `state.kyc` está intacto).

**Paso `review` (pre-KYC) — nuevo bloque UI** (patrón: `review` actual L548-596, recortado):
- Muestra el **breakdown COMPLETO del quote lockeado** (decisión #2, §10): "S/ X que recibe la
  familia", "Enviás", "Comisión", "Tipo de cambio", "Llega en", método/destino — igual que el review
  actual L555-566.
- **NO** muestra el badge de identidad (KYC aún no hecho).
- CTA explícita **"Continuar"** (`onContinue`) — dispara el paso `verify`. Microcopy en §4.6.
- Guard `step === "review" && rem?.quote` (el quote está garantizado tras `onConnect`).

**Paso `confirm` (post-KYC) — el `review` actual renombrado** (L548-596 → guard `step === "confirm"`):
- Idéntico contenido: breakdown + badge de identidad (L568-580, AC-8) + botón "Confirmar y enviar"
  (`onConfirm`) o "Recotizar tasa" (`onRelock`) si hay `error` (MNR-1, preserva KYC).
- **Añadir** el indicador "la tasa se actualizó, tu familia recibe S/ X ahora" cuando `rateUpdated`
  (viene del auto-requote del resume). Microcopy en §4.6.

**Banners condicionados por step (L341-345):** el banner "Modo demo" hoy se muestra en
`step === "review" || "track"`. Debe pasar a `step === "confirm" || "track"` (el review pre-KYC es
demo también, pero el banner canónico vive en la confirmación/tracking; el Dev puede incluir `review`
si se decide mostrarlo antes — **no** cambia ninguna AC; recomendado: `"review" || "confirm" || "track"`
para no perder la señal demo en el nuevo paso). Ver §4.6.

### 4.3 Use-cases (Wave 1) — solo orden de invocación

Ningún use-case cambia de firma ni de lógica. El único ajuste de contenido es de **comentario**:
`start-kyc.ts` L61 dice "la remesa sigue persistida en 'created'"; con el reorden el último estado
guardado antes de un pending-fail es `"quoted"`. Actualizar el comentario (CD-6, no-bloqueante para
compilar pero exigido por higiene). La lógica (`repo.save` condicionado a `pending.save` OK) es
correcta tal cual.

### 4.4 Flujo principal (Happy Path, nuevo orden)

1. `send`: usuario ingresa monto/beneficiario → `createRemittance` (`created`) → `connect`.
2. `connect`: conecta wallet → `lockQuote` (`created→quoted`, quote lockeado) → `review`.
3. `review`: ve el valor completo ("tu familia recibe S/ X") → tap **"Continuar"** → `verify`.
4. `verify`: tap "Escanear DNI + selfie" → `startKyc` (`quoted→kyc_pending`) → redirect Didit.
5. (vuelta) resume `passed` → `applyKyc` (`kyc_pending→kyc_passed`, quote intacto) → `confirm`.
6. `confirm`: ve quote + badge de identidad → tap **"Confirmar y enviar"** → `confirmAndSend`
   (`confirm()`: `kyc_passed→confirmed`; autoridad WKH-180) → `track`/`done`.

**KYC-once (AC-4):** paso 3-5 se colapsan: `connect` → `lockQuote` → `startKyc(remembered)` →
`kyc_passed` → `confirm` directo (sin `review` ni `verify`).

### 4.5 Flujo de error

- **Quote vencido durante el KYC (AC-5):** al volver de Didit (`passed`) con quote vencido → auto
  re-quote (`kyc_passed→quoted`) → `confirm` con indicador "tasa actualizada". Nunca re-escanea DNI.
- **Quote vence en el paso `confirm` (post-render):** `onConfirm` → `confirmAndSend` lanza
  `confirm_quote_expired` → `guard` setea `error` → se muestra "Recotizar tasa" (`onRelock`, MNR-1) →
  re-quote (`quoted→confirmed` disponible tras re-lock, DT-1b) → confirmar.
- **KYC no pasa (`failed`):** resume/onVerify → `setStep("verify")` + error (sin cambios vs. hoy).
- **Timeout del resume-loop:** card `timedOut` + "Reintentar" (sin cambios, WKH-178).
- **`confirm()` sin KYC (AC-3):** si por bug la UI llegara a confirmar sin KYC (ej. desde el `quoted`
  pre-KYC), `confirm()` lanza `confirm_requires_kyc_passed` — gate byte-idéntico.

### 4.6 Microcopy (nuevo/afectado)

| Elemento | Texto | Contexto |
|----------|-------|----------|
| Título paso `review` | "Revisá el envío" | header del breakdown pre-KYC |
| CTA paso `review` | "Continuar" | botón principal → dispara `verify` (AC-2). El Dev puede usar "Quiero enviarlo"; preferido "Continuar" por consistencia con el paso `send` |
| Subcopy paso `review` | "Para enviar, verificás tu identidad una sola vez (por ley)." | explica por qué sigue el KYC |
| Indicador tasa actualizada | "La tasa se actualizó · tu familia recibe {receive} ahora" | paso `confirm`, cuando `rateUpdated` (auto-requote) |
| Banner demo | (sin cambio de texto) | ampliar condición a incluir `confirm` (y opcional `review`) |

El paso `confirm` conserva el copy actual del `review` ("Revisá antes de enviar", "Confirmar y enviar
{monto}", "Al confirmar, autorizás el envío de {monto} desde tu wallet").

---

## 5. COMPLIANCE — cómo el gate KYC→payout queda byte-idéntico (para el AR)

Enumeración para verificación rápida del Adversary. **El reorden NO toca ninguna de estas piezas:**

1. **`confirm()` (`remittance.ts` L219-226) sin cambios.** El guard L220-221
   `if (!this.state.kyc || !(kyc.approved && kyc.payoutAllowed)) throw confirm_requires_kyc_passed`
   lee el **campo `kyc` del estado**, no la posición en la FSM. Reordenar cuándo se llega a
   `kyc_passed` relativo a `quoted` NO afecta este check. **NO-TOCAR (CD-2).**
2. **`quoted → confirmed` (DT-1b) no debilita nada.** Es la única transición realmente nueva. Un
   `confirm()` desde el `quoted` pre-KYC (kyc=null) lanza `confirm_requires_kyc_passed` ANTES de
   `to("confirmed")` (el throw está en L220-221, la transición en L225). La FSM permisiva + el gate de
   campo = misma fuerza que hoy. Verificable con el test de compliance (§8, T-COMPLIANCE).
3. **`confirm-and-send.ts` (WKH-180/182/186) NO se toca (CD-3).** `r.confirm()` (paso 1, L53) +
   `authority.authorize()` (paso 2, L65-72, autoridad server-side ANTES de mover el principal) + los
   re-checks de expiry (L78/95) + la reconciliación (L116) corren SIEMPRE, en el mismo orden,
   independientemente de en qué secuencia la UI pidió las cosas. **NO-TOCAR.**
4. **`applyKyc()` (L202-208) sin cambios.** Sigue derivando `kyc_passed`/`kyc_failed` de
   `approved && payoutAllowed`.

**Archivos NO-TOCAR (marcar BLOQUEANTE en AR si el diff los modifica en su lógica):**
`src/application/use-cases/confirm-and-send.ts`, y las líneas L219-226 (cuerpo de `confirm()`) y
L202-208 (cuerpo de `applyKyc()`) de `src/domain/remittance.ts`. En `remittance.ts` el ÚNICO cambio
permitido es el objeto `TRANSITIONS` (L85-97).

---

## 6. Constraint Directives

### OBLIGATORIO seguir
- **CD-4 (heredada):** cada transición nueva en `TRANSITIONS` con razón de negocio inline (patrón L90).
- **CD-6 (heredada):** actualizar TODOS los tests afectados en la MISMA HU; cero tests rojos, cero
  tests validando el orden viejo.
- **CD-11 (nueva):** el re-check de expiry en el resume DEBE reusar la lógica del dominio
  (`Remittance.rehydrate(snapshot).isQuoteStillValid(now)`), NO duplicar el cálculo `new
  Date(expiresAt) <= now` en la UI (single-source-of-truth; evita drift de la regla de expiry).
- **CD-12 (nueva):** en `onConnect`, `lockQuote` (attachQuote) va SIEMPRE antes de `startKyc`
  (KYC-once incluido); invertirlo rompe la FSM (`created→kyc_pending` ya no existe).
- Seguir el patrón del paso `review` actual para AMBOS pasos nuevos (`review` pre-KYC, `confirm`).

### PROHIBIDO
- **CD-1 (heredada):** tocar cualquier archivo fuera de `chaski-v2/`.
- **CD-2 (heredada, COMPLIANCE CRÍTICA):** debilitar/saltear/condicionar-por-flag el gate
  `confirm_requires_kyc_passed` (`remittance.ts` L219-222). Cualquier `if (kyc || flag)` o bypass =
  **BLOQUEANTE en AR**.
- **CD-3 (heredada, COMPLIANCE CRÍTICA):** tocar `confirm-and-send.ts` para remover/condicionar/
  debilitar el paso 2 (`authority.authorize()`, WKH-180).
- **CD-5 (heredada):** romper el demo (`isDemoMode`, fallback sin key Didit) o el KYC-once (WKH-181/184).
- **CD-13 (nueva):** modificar la lógica interna de `confirm()`, `applyKyc()`, `attachQuote()`,
  `startKyc()`, `to()` o cualquier `mark*` de `remittance.ts` — el único cambio de dominio es
  `TRANSITIONS`.
- **CD-14 (nueva):** re-cotizar automáticamente en un punto que fuerce re-escanear el DNI o que pierda
  el `state.kyc` aprobado (el re-quote es `kyc_passed→quoted`, conserva `kyc` por shallow-merge).
- NO agregar dependencias nuevas. NO cambiar el schema de `RemittanceState`. NO tocar el tramo
  `confirmed→…→settled` (WKH-186).

---

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Dead-end re-quote (el TRANSITIONS del work-item) | A | A (AC-5) | DT-1b: `quoted→confirmed`; test T-REQUOTE (§8) |
| Debilitar el gate KYC sin querer al reordenar | M | Crítico | §5 COMPLIANCE + CD-2/CD-13 + T-COMPLIANCE + AR |
| Invertir `lockQuote`/`startKyc` en `onConnect` → invalid_transition | M | A | CD-12 + test de dominio de trayectoria |
| Doble cotización innecesaria en resume | M | M (UX/costo) | DT-3: re-quote solo si `isQuoteStillValid` falso |
| Fixtures de test que construyen por el orden viejo quedan rojos | A | M | CD-6 + §8 enumera cada uno; patrón de seeding nuevo |
| Fake de payout inconsistente con el quote dispara la reconciliación (WKH-186) | B | M | CD-9 (auto-blindaje 186): `deliveredPen` del fake consistente con `receive` |
| Espiar `window.location` en RTL bajo jsdom | B | B | CD-10 (auto-blindaje 185): reemplazar el objeto `location` entero |

### Auto-Blindaje heredado (últimas HUs DONE)
- **CD-9 (de WKH-186):** cualquier fake de payout con `deliveredPen` no-null debe ser consistente con
  el `receive` del quote fake del mismo flujo, o la reconciliación lo refundea. Aplica a los fixtures
  que se toquen en `confirm-and-send.test.ts` / `use-cases.test.ts`.
- **CD-10 (de WKH-185):** para espiar `window.location.reload/href` en tests de componente jsdom,
  reemplazar el objeto `location` completo y restaurarlo en `finally` (no `defineProperty` sobre la
  property). Relevante si se agrega un test RTL que ejerza el redirect de Didit.

---

## 8. Waves + Test Plan (≥1 test por AC)

### Wave 0 (Serial Gate — dominio)
- **W0.1** — `remittance.ts`: nuevo `TRANSITIONS` (§4.1) con comentarios CD-4.
- **W0.2** — `remittance.test.ts`: actualizar `ready()` (L34-39) al nuevo orden
  (`create→attachQuote→startKyc→applyKyc` = `kyc_passed` con quote); actualizar `canTransition`
  (L88-92); happy path (L42-54). **Nuevos tests de dominio** (ver tabla).
- Verificación: `typecheck` + `remittance.test.ts` verde.

### Wave 1 (use-cases — orden + fixtures)
- **W1.1** — `start-kyc.ts`: actualizar comentario L61 ("created"→"quoted") (CD-6).
- **W1.2** — Fixtures de test al nuevo orden (seeding `create→attachQuote→startKyc→applyKyc`):
  `confirm-and-send.test.ts` (`seedQuoted` L38-45), `track-remittance.test.ts` (L39-41),
  `use-cases.test.ts` (V1 orphan L187-219: assert `status=="quoted"`; los tests de startKyc siembran
  quote primero), `persistence.test.ts` (L46).
- Verificación: `typecheck` + suites de application/infrastructure verdes.

### Wave 2 (UI — reorden `flow.tsx`)
- **W2.1** — `Step` type + `STEP_LABELS`/`STEP_INDEX` (§4.2).
- **W2.2** — handlers: `onConnect` (lockQuote antes de KYC + destino confirm/review), `onContinue`
  (nuevo), `onVerify` (quitar lockQuote, destino confirm), resume (§4.2 DT-3), banner demo.
- **W2.3** — bloques UI: paso `review` (nuevo, pre-KYC) + paso `confirm` (review renombrado + badge +
  indicador `rateUpdated`).
- Verificación: `typecheck` + `next build` (webpack).

### Wave 3 (tests de componente RTL + regresión)
- **W3.1** — `flow.test.tsx`: actualizar `goToReview()` (L39-44) al nuevo orden y renombrar a
  `goToConfirm()`; ajustar T1/T2 (leen el paso final `confirm`). **Nuevos tests RTL** (tabla).
- **W3.2** — correr la suite completa (los ~223 tests) verde.

### Test Plan (mapeo AC → test)

| Test | AC | Archivo | Wave | Qué prueba |
|------|-----|---------|------|-----------|
| T-AC1 (RTL) | AC-1 | `flow.test.tsx` | W3 | tras conectar wallet, el paso muestra el quote lockeado (S/ concreto, no preview) ANTES de cualquier UI de KYC |
| T-AC2 (RTL) | AC-2 | `flow.test.tsx` | W3 | el paso `review` tiene "Continuar"; el KYC/escaneo NO aparece hasta el tap (no auto-inicia) |
| **T-COMPLIANCE** (dominio) | AC-3 | `remittance.test.ts` | W0 | `confirm()` desde `quoted` sin KYC (`created→quoted`, kyc=null) lanza `confirm_requires_kyc_passed`; y desde `kyc_pending` idem — el gate no se debilitó con el reorden |
| T-AC4 (RTL) | AC-4 | `flow.test.tsx` | W3 | KYC-once (store con kyc recordado) → tras connect va directo a `confirm` (sin `review` ni escaneo), con quote lockeado |
| T-AC5a (dominio) | AC-5 | `remittance.test.ts` | W0 | re-quote `kyc_passed→quoted` conserva `state.kyc`; luego `confirm()` `quoted→confirmed` OK (sin dead-end) |
| T-AC5b (RTL) | AC-5 | `flow.test.tsx` | W3 | en `confirm` con quote vencido, `onRelock` re-cotiza y NO vuelve al escaneo de DNI |
| T-AC6 (RTL) | AC-6 | `flow.test.tsx` | W3 | resume `passed` con quote vigente → navega a `confirm` SIN re-cotizar (lockQuote no se llama de más) |
| T-AC7 (use-case) | AC-7 | `confirm-and-send.test.ts` | W1 | los tests de autoridad WKH-180 (authority false→payout_failed) siguen verdes con el seeding nuevo |
| T-AC8 (RTL) | AC-8 | `flow.test.tsx` | W3 | el paso `confirm` muestra el badge de identidad (`rem.kyc.identity`) junto al quote |
| T-AC9 (dominio) | AC-9 | `remittance.test.ts` | W0 | happy path completo `…→confirmed→principal_in→payout_submitted→settled` intacto; `canTransition` post-confirmed sin cambios |
| **T-REORDER** (dominio) | AC-1/DT-1b | `remittance.test.ts` | W0 | trayectoria nueva `created→quoted→kyc_pending→kyc_passed→confirmed` válida; `created→kyc_pending` ahora inválida |
| T-REQUOTE (dominio) | AC-5/DT-1b | `remittance.test.ts` | W0 | `quoted→confirmed` alcanzable (evita el dead-end del work-item) |

> Los tests existentes actualizados por el reorden (no nuevos) también cuentan como cobertura de
> regresión de CD-6.

---

## 9. Regresión

- **Demo (WKH-178/184):** `isDemoMode()` y el banner "Modo demo" siguen; ajustar la condición de step
  (§4.2) para no perder la señal en el nuevo paso `confirm`. T1 (RTL) lo cubre.
- **KYC-once (WKH-181/184):** el branch de `rememberedKyc` en `onConnect` se preserva; solo cambia el
  destino (confirm directo). T-AC4 lo cubre. El reset "¿No sos vos?" (`forgetAndDisconnect`) no se
  toca (T4/T5 RTL siguen verdes).
- **WKH-180/182/186 aguas abajo:** `confirm-and-send.ts` intacto (CD-3); la autoridad server-side, los
  re-checks de expiry y la reconciliación corren igual. Suites de `confirm-and-send.test.ts` /
  `track-remittance.test.ts` verdes tras actualizar solo el seeding (Wave 1).
- **Los ~223 tests** de la suite quedan verdes (W3.2).

---

## 10. Uncertainty Markers (resueltos por el orquestador)

| Marker | Resolución | Bloqueante? |
|--------|-----------|-------------|
| Copy pre-KYC (NC#1) | **Decisión #2:** el paso `review` muestra el breakdown COMPLETO (tasa, enviás, comisión, **monto que recibe la familia**, ETA) + CTA "Continuar". Microcopy §4.6 | No (resuelto) |
| Expiry durante KYC (NC#2) | **Decisión #1:** AUTO re-cotizar al volver del KYC si venció (sin tap manual); el paso `confirm` siempre muestra el monto vigente; indicador "la tasa se actualizó" si cambió; NUNCA re-pide escanear DNI. §4.2/§4.5 | No (resuelto) |
| Stepper labels (NC#3) | **Decisión #3:** 4 labels `["Enviar","Revisar","Identidad","Seguir"]` (§4.2). Alternativa 5-label ("Confirmar" propio) = mejora UI opcional, no-bloqueante | No (resuelto) |
| Reusar `review` con flag vs. pasos separados (DT-4) | **Decisión #4:** **pasos separados** `review` (pre-KYC) + `confirm` (post-KYC) — el harness RTL los distingue sin ambigüedad (por CTA "Continuar" vs "Confirmar y enviar"). §4.2 | No (resuelto) |

Sin `[NEEDS CLARIFICATION]` pendientes.

---

## 11. Readiness Check

```
[x] Cada AC (1-9) tiene ≥1 test asociado (tabla §8) y archivo(s) en §4
[x] Cada archivo a tocar tiene exemplar verificado con Read (§3, líneas reales)
[x] No hay [NEEDS CLARIFICATION] pendientes (§10, los 4 resueltos por el orquestador)
[x] Constraint Directives con >3 PROHIBIDO (CD-1/2/3/5/13/14) + OBLIGATORIO (CD-4/6/11/12)
[x] Context Map con >2 archivos leídos (13 archivos, §3)
[x] Scope IN/OUT explícitos (§2)
[x] Persistencia/BD: sin cambios de schema (verificado, §3)
[x] Happy Path completo (§4.4) + Flujo de error (§4.5)
[x] COMPLIANCE explícito para el AR (§5) + archivos NO-TOCAR marcados
[x] Hallazgo crítico (dead-end del TRANSITIONS del work-item) documentado y corregido (DT-1b)
```

READY FOR SPEC_APPROVED.

---

*SDD generado por NexusAgil — FULL — WKH-187*
