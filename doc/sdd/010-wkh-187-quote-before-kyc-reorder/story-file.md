# Story File — WKH-187: Mostrar el quote (valor) antes del KYC (reorden money-path)

> Contrato autosuficiente para el Dev (F3). Fuente: `sdd.md` (SPEC_APPROVED) + grounding directo.
> Repo: **`chaski-v2`** (CD-1: NO tocar ningún archivo fuera de este repo).
> Branch: `feat/187-quote-before-kyc-reorder`.
> El Dev SOLO lee este archivo. Si algo no está acá, no se hace.

---

## 0. Contexto (qué se construye y por qué)

Hoy Chaski pide el **KYC (Didit) ANTES** de mostrar cuánto recibe la familia. Esta HU **invierte el
orden**: el quote se **lockea apenas conecta la wallet** (`onConnect` → `lockQuote`), el usuario ve el
valor real ("tu familia recibe S/ X") en un **paso de revisión pre-KYC**, y el KYC se dispara recién
cuando el usuario tapea "Continuar".

**LO QUE NO CAMBIA (compliance, INVIOLABLE):**
- El gate `confirm()` (`remittance.ts` L219-226) que exige `state.kyc.approved && payoutAllowed` queda
  **byte-idéntico**. Lee el **campo `kyc`**, no la posición en la FSM. **CD-2/CD-13: NO-TOCAR.**
- La autoridad server-side WKH-180 (`confirm-and-send.ts`, `authority.authorize()`) queda **byte-idéntica**.
  **CD-3: NO-TOCAR `confirm-and-send.ts`.**
- El único cambio de **dominio** es el objeto `TRANSITIONS` (`remittance.ts` L85-97). Nada más de
  `remittance.ts` cambia de lógica (**CD-13**).

Reordenamos QUÉ estados de la FSM son alcanzables entre sí y CUÁNDO la UI pide cada cosa — **nunca**
QUÉ invariantes se verifican.

---

## 1. Scope IN (lista exhaustiva de archivos a tocar)

| Archivo | Qué se toca | Wave |
|---------|-------------|------|
| `src/domain/remittance.ts` | SOLO el objeto `TRANSITIONS` (L85-97) | W0 |
| `src/domain/remittance.test.ts` | `ready()` (L34-39), `canTransition` (L88-92), happy path (L42-54) + nuevos tests | W0 |
| `src/application/use-cases/start-kyc.ts` | SOLO el comentario L59-61 ("created"→"quoted") | W1 |
| `src/application/use-cases/confirm-and-send.test.ts` | `seedQuoted` (L38-45): reordenar seeding | W1 |
| `src/application/use-cases/track-remittance.test.ts` | setup (L39-41): reordenar seeding | W1 |
| `src/application/use-cases.test.ts` | V1 orphan (L187-219): assert `status=="quoted"` + seeding startKyc | W1 |
| `src/infrastructure/persistence.test.ts` | L46: `startKyc` desde `created` → seed quote primero | W1 |
| `src/presentation/flow.tsx` | `Step`, `STEP_LABELS`/`STEP_INDEX`, `onConnect`, `onContinue` (nuevo), `onVerify`, resume effect, banner demo, paso `review` (nuevo pre-KYC) + paso `confirm` (review renombrado) | W2 |
| `src/presentation/flow.test.tsx` | `goToReview()` (L39-44) → renombrar/ajustar + nuevos tests RTL | W3 |

**NO-TOCAR (CD-3/CD-13, BLOQUEANTE en AR si el diff los modifica en lógica):**
- `src/application/use-cases/confirm-and-send.ts` (completo)
- `remittance.ts` cuerpo de `confirm()` (L219-226), `applyKyc()` (L202-208), `attachQuote()` (L210-216),
  `startKyc()` (L198-200), `to()` (L191-196), todos los `mark*`, `isQuoteStillValid`/`isQuoteExpired`.
- `src/application/use-cases/lock-quote.ts`, `resume-kyc.ts`, `connect-wallet.ts` (sin cambios de firma/lógica)
- Schema `RemittanceState` (L132-149) — sin cambios de forma.
- Tramo `confirmed → … → settled/refunded` (WKH-186).

---

## 2. Anti-Hallucination Anchors (archivo:línea EXACTO — verificado en F2.5)

### `src/domain/remittance.ts`
- `TRANSITIONS` **L85-97** — objeto a reescribir (§3.1). Orden actual: `created→kyc_pending→kyc_passed→quoted→confirmed`.
- `canTransition()` **L101-103** — no se toca (lee `TRANSITIONS`).
- `to()` **L191-196** — **shallow-merge** (`{ ...this.state, ...patch, ... }` L195): el `quote` y el
  `kyc` **sobreviven** transiciones sin patch. Base de DT-1b/DT-2. **NO-TOCAR.**
- `startKyc()` **L198-200** — `to("kyc_pending", ...)`. **NO-TOCAR.**
- `applyKyc()` **L202-208** — deriva `kyc_passed`/`kyc_failed` de `approved && payoutAllowed`. **NO-TOCAR.**
- `attachQuote()` **L210-216** — `to("quoted", ...)` hardcodeado (L215) + valida monto/expiry/A5. **NO-TOCAR.**
- `confirm()` **L219-226** — **GATE DURO** L220-221 (`if (!this.state.kyc || !(...approved && payoutAllowed)) throw confirm_requires_kyc_passed`); L223 `confirm_requires_quote`; L224 `confirm_quote_expired`; L225 `to("confirmed")`. **NO-TOCAR (CD-2).**
- `isQuoteStillValid()` **L253-255** (público) — reusar en el resume (CD-11). `isQuoteExpired()` **L257-259** (privado).

### `src/presentation/flow.tsx`
- `Step` type **L20** — hoy `"send"|"connect"|"verify"|"review"|"track"|"done"`.
- `STEP_LABELS` **L21** = `["Enviar","Identidad","Revisar","Seguir"]`; `STEP_INDEX` **L22-29**.
- `onSend` **L151-160** — sin cambios (`create` → `setStep("connect")`).
- `onConnect` **L162-181** — KYC-once branch L167-177 (`startKyc` L169, `lockQuote` L172, `setStep("review")` L174); else `setStep("verify")` L179. **A reordenar (§3.2).**
- `onVerify` **L183-212** — redirect L194-199; simulación `done` L200-211 (`lockQuote` L209, `setStep("review")` L211). **Quitar lockQuote, destino `confirm` (§3.2).**
- `onConfirm` **L214-220** — sin cambios.
- `onRelock` **L222-228** (MNR-1, comentario L222) — sin cambios de firma.
- Resume effect **L88-137** — rama `passed` L111-119: L114 `lockQuote` incondicional (**quitar**), L119 `setStep("review")` (**→ `confirm` + auto-requote condicional, §3.2**). Rama fail L120-124.
- Banner demo **L341** — `step === "review" || step === "track"` → ampliar (§3.2).
- Paso `review` **L548-596** — breakdown quote L550-567, badge identidad L568-580, botones L581-594. **Este bloque se RENOMBRA a `confirm` + se crea uno nuevo `review` pre-KYC (§3.3).**

### Use-cases
- `start-kyc.ts` **L59-61** — comentario "la remesa sigue persistida en 'created'" → actualizar a "quoted".
- `lock-quote.ts` / `resume-kyc.ts` / `connect-wallet.ts` — **sin cambios** (agnósticos al estado previo salvo `canTransition`).
- `confirm-and-send.ts` — **NO-TOCAR (CD-3).**

### Tests (fixtures que asumen el orden viejo `startKyc→applyKyc→attachQuote`)
- `remittance.test.ts` `ready()` **L34-39** (`create→startKyc→applyKyc`); happy **L42-54**; `canTransition` **L88-92** (assert `created→kyc_pending`).
- `confirm-and-send.test.ts` `seedQuoted()` **L38-45** (`create→startKyc→applyKyc→attachQuote`).
- `track-remittance.test.ts` setup **L39-41**.
- `use-cases.test.ts` V1 orphan **L187-219** (assert `status=="created"` L198/L213 → `"quoted"`).
- `persistence.test.ts` **L46** (`startKyc` desde `created`).
- `flow.test.tsx` `goToReview()` **L39-44** (send→connect→verify→review).

---

## 3. Diseño paso a paso con snippets objetivo

### 3.1 Dominio — `TRANSITIONS` nuevo (Wave 0, `remittance.ts` L85-97)

Reemplazar el objeto completo. **Cada transición nueva con razón inline (CD-4):**

```ts
const TRANSITIONS: Record<RemittanceStatus, readonly RemittanceStatus[]> = {
  created: ["quoted"],                             // WKH-187: cotiza PRIMERO (quote antes del KYC)
  quoted: ["quoted", "kyc_pending", "confirmed"],  // re-quote | iniciar KYC | confirmar (gate por state.kyc, DT-1b)
  kyc_pending: ["kyc_passed", "kyc_failed"],       // (sin cambios)
  kyc_passed: ["quoted", "confirmed"],             // WKH-187: re-quote post-KYC (conserva kyc) | confirmar
  kyc_failed: [],                                  // (sin cambios)
  confirmed: ["principal_in", "payout_failed"],    // (sin cambios)
  principal_in: ["payout_submitted", "payout_failed"], // (sin cambios)
  payout_submitted: ["settled", "payout_failed"],  // (sin cambios)
  settled: [],                                     // (sin cambios)
  payout_failed: ["refunded"],                     // (sin cambios)
  refunded: [],                                    // (sin cambios)
};
```

**Cambios vs. hoy:**
- `created`: `["kyc_pending"]` → `["quoted"]` (elimina `created→kyc_pending`; el KYC ya no arranca sin cotizar).
- `quoted`: `["quoted","confirmed"]` → `["quoted","kyc_pending","confirmed"]` (agrega `quoted→kyc_pending`).
- `kyc_passed`: `["quoted"]` → `["quoted","confirmed"]` (agrega `kyc_passed→confirmed`).

**DT-1b (`quoted→confirmed`, corrige el work-item):** necesario para el path re-cotizar→confirmar
(tras `onRelock`, `attachQuote` deja la remesa en `quoted`; sin esto `confirm()` lanzaría
`invalid_transition:quoted->confirmed` y AC-5 no se cumple). **Es seguro:** un `confirm()` desde el
`quoted` pre-KYC (kyc=null) lanza `confirm_requires_kyc_passed` (L220-221) ANTES de `to("confirmed")`
(L225). El gate real es el campo `kyc`, no la FSM.

**Trayectorias válidas resultantes:**
- Happy: `created →(attachQuote)→ quoted →(startKyc)→ kyc_pending →(applyKyc)→ kyc_passed →(confirm)→ confirmed`
- Re-quote pre-confirm: `kyc_passed →(attachQuote)→ quoted →(confirm)→ confirmed`
- KYC-once: `created →(attachQuote)→ quoted →(startKyc remembered)→ kyc_pending →(applyKyc)→ kyc_passed →(confirm)→ confirmed`

### 3.2 UI — `flow.tsx` handlers/stepper/resume (Wave 2)

**`Step` type (L20) nuevo — orden `send→connect→review→verify→confirm→track→done`:**
```ts
type Step = "send" | "connect" | "review" | "verify" | "confirm" | "track" | "done";
```

**`STEP_LABELS`/`STEP_INDEX` (L21-29) — 4 labels, "Revisar" antes de "Identidad" (decisión #3):**
```ts
const STEP_LABELS = ["Enviar", "Revisar", "Identidad", "Seguir"];
const STEP_INDEX: Record<Step, number> = {
  send: 0,
  connect: 0,
  review: 1,
  verify: 2,
  confirm: 2,   // comparte "Identidad" con verify (solape análogo al connect/verify de hoy)
  track: 3,
  done: 3,
};
```

**`onConnect` (L162-181) — `lockQuote` ANTES del KYC (CD-12):**
- `connectWallet.execute()` → `setAddress(addr)`.
- **SIEMPRE** `lockQuote.execute({ remittanceId: rem.id })` (`created→quoted`, quote visible AC-1) → `setRem(locked.snapshot)`.
- Luego: si `rememberedKyc.approved && payoutAllowed` (KYC-once) → `startKyc.execute(...)` (`quoted→kyc_pending→kyc_passed` vía `kind:"done"`) → `setRem(res.snapshot)` → **`setStep("confirm")`** (salta `review`+`verify`, AC-4).
- Si no hay remembered → **`setStep("review")`**.
- **CD-12 crítico:** `lockQuote` va antes de `startKyc`; invertirlo = `invalid_transition:created->kyc_pending` (ya no existe).

**`onContinue` (NUEVO handler) — navegación pura (AC-2):**
```ts
const onContinue = () => setStep("verify"); // sin llamada de dominio: la CTA lleva al KYC, NO lo auto-inicia
```

**`onVerify` (L183-212) — quitar `lockQuote`, destino `confirm`:**
- El quote ya está lockeado desde `onConnect`. **Eliminar** `lockQuote` (L209) y el `sleep`/`setScanStage(4)` asociado se conservan.
- `startKyc.execute(...)` (`quoted→kyc_pending`) → redirect Didit (sin cambios L194-199), o simulación `done`/`kyc_passed` → `setRem(res.snapshot)` → **`setStep("confirm")`** (antes `"review"` L211).
- Branch de error de KYC (L202-205) sin cambios.

**Resume effect (L88-137) rama `passed` (L111-119) — DT-3 + CD-11 (auto-requote condicional):**
```ts
if (res.kind === "passed") {
  setRem(res.snapshot); // el snapshot ya trae el quote lockeado pre-redirect
  // CD-11: re-check de expiry con la lógica del dominio (single-source-of-truth), NO recalcular en la UI
  const valid = Remittance.rehydrate(res.snapshot).isQuoteStillValid(new Date().toISOString());
  if (valid) {
    if (alive) setStep("confirm");            // AC-6: NO re-cotiza
  } else {
    try {
      const prev = res.snapshot.quote?.receive; // lo que vio pre-KYC
      const locked = await c.lockQuote.execute({ remittanceId: res.snapshot.id }); // AUTO re-quote (kyc_passed→quoted)
      if (alive) {
        setRem(locked.snapshot);
        // AC-5: indicador solo si el monto cambió; NUNCA re-pide escanear DNI (state.kyc intacto)
        if (prev && locked.snapshot.quote && prev.minor !== locked.snapshot.quote.receive.minor) {
          setRateUpdated(true);
        }
        setStep("confirm");
      }
    } catch {
      if (alive) setStep("confirm"); // el paso confirm ofrece Recotizar (onRelock) si falta quote/expiró
    }
  }
  return;
}
```
- **Quitar** el `lockQuote` incondicional actual (L113-118).
- Nuevo estado UI: `const [rateUpdated, setRateUpdated] = useState(false);` (junto a los otros `useState`).
- `Remittance` ya se importa? Verificar el import de `../domain/remittance`; hoy sólo se importan tipos (`Quote, RemittanceState, PayoutMethod`, L15). **Agregar `Remittance`** al import para `rehydrate`/`isQuoteStillValid` (es la clase, no un tipo). Esto NO viola CD-13 (no cambia su lógica, solo la usa).

**Banner demo (L341):** ampliar a incluir el nuevo paso (recomendado `"review" || "confirm" || "track"`):
```ts
{rem && isDemoMode(rem) && (step === "review" || step === "confirm" || step === "track") ? (
```

### 3.3 UI — bloques de paso (Wave 2, `flow.tsx`)

**Paso `confirm` (post-KYC) = el `review` actual RENOMBRADO (L548-596):**
- Cambiar el guard `step === "review"` → `step === "confirm"`.
- Contenido idéntico: breakdown (L550-567) + badge identidad (L568-580, AC-8) + botón "Confirmar y enviar"/`onConfirm` o "Recotizar tasa"/`onRelock` si `error` (MNR-1).
- **Añadir** el indicador de tasa actualizada cuando `rateUpdated`, encima del breakdown:
```tsx
{rateUpdated ? (
  <Pill tone="active">La tasa se actualizó · tu familia recibe {rem.quote.receive.format()} ahora</Pill>
) : null}
```

**Paso `review` (pre-KYC) = bloque NUEVO (patrón: el review actual recortado, SIN badge, SIN onConfirm):**
```tsx
{step === "review" && rem?.quote && (
  <div className="space-y-4">
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold">Revisá el envío</p>
        <Pill tone="active">tasa fijada</Pill>
      </div>
      <div className="mb-3 rounded-xl bg-sand px-4 py-3 text-center">
        <p className="text-xs text-stone">{rem.beneficiary.name} recibe</p>
        <p className="tabular text-3xl font-extrabold text-verde">{rem.quote.receive.format()}</p>
      </div>
      <Row label="Enviás" value={rem.sendUsd.format()} />
      <Row label="Comisión" value={rem.quote.feeUsd.format()} />
      <Row label="Tipo de cambio" value={`S/ ${rem.quote.rate.toFixed(3)}`} />
      <Row label="Llega en" value={`~${rem.quote.etaMinutes} min`} />
      <div className="my-2 h-px bg-line" />
      <Row label="Recibe en" value={`${methodLabel(rem.beneficiary.method)} · ${rem.beneficiary.destination}`} />
    </Card>
    <Button disabled={busy} onClick={onContinue}>Continuar</Button>
    <p className="text-center text-xs text-stone">
      Para enviar, verificás tu identidad una sola vez (por ley).
    </p>
  </div>
)}
```
- **NO** muestra `rem.kyc?.identity` (el KYC aún no ocurrió).
- CTA "Continuar" → `onContinue` → paso `verify` (AC-2).

### 3.4 Use-cases (Wave 1) — solo comentario

`start-kyc.ts` L59-61: el comentario dice "la remesa sigue persistida en 'created'". Con el reorden, el
último estado guardado antes de un pending-fail es `"quoted"`. Actualizar el texto del comentario
(CD-6). **La lógica NO cambia** (el `repo.save(r)` condicionado a `pending.save` OK es correcto).

---

## 4. COMPLIANCE (para el Dev y el AR) — el gate KYC→payout es byte-idéntico

El reorden **NO toca** ninguna de estas piezas. Verificación rápida del Adversary:

1. **`confirm()` (`remittance.ts` L219-226) sin cambios.** El guard L220-221 lee el **campo `kyc`**, no la
   FSM. Reordenar cuándo se llega a `kyc_passed` relativo a `quoted` NO afecta el check. **CD-2/CD-13.**
2. **`quoted→confirmed` (DT-1b) no debilita nada.** Es la única transición realmente nueva. `confirm()`
   desde `quoted` con kyc=null lanza `confirm_requires_kyc_passed` ANTES de la transición. Verificado
   por T-COMPLIANCE.
3. **`confirm-and-send.ts` (WKH-180/182/186) NO se toca (CD-3).** La autoridad server-side, los re-checks
   de expiry y la reconciliación corren igual, en el mismo orden.
4. **`applyKyc()` (L202-208) sin cambios.**

**Único cambio de dominio permitido:** el objeto `TRANSITIONS` (L85-97). Cualquier diff que modifique
la lógica de `confirm()`, `applyKyc()`, `attachQuote()`, `startKyc()`, `to()` o `confirm-and-send.ts` =
**BLOQUEANTE en AR.**

---

## 5. Waves de implementación

### Wave 0 (Serial Gate — dominio) — `remittance.ts` + `remittance.test.ts`
- **W0.1** — reescribir `TRANSITIONS` (§3.1) con comentarios CD-4.
- **W0.2** — `remittance.test.ts`:
  - `ready()` (L34-39): nuevo orden `create → attachQuote → startKyc → applyKyc` (queda `kyc_passed` **con quote**). Ojo: el helper debe cotizar primero.
  - happy path (L42-54): la remesa ya llega con quote a `kyc_passed`; el `r.attachQuote()` L45 puede quedar como re-quote (`kyc_passed→quoted`) o ajustarse; el assert `status==="kyc_passed"` L44 seguirá válido tras `ready()`. Confirmá que la trayectoria completa a `settled` (L46-53) sigue verde.
  - `canTransition` (L88-92): `created→kyc_pending` ahora es **false**; usar `created→quoted` true, `created→settled` false. Mantener `payout_failed→refunded` true.
  - **Nuevos tests de dominio:** T-COMPLIANCE, T-AC5a, T-AC9, T-REORDER, T-REQUOTE (§7).
- **Verificación:** `npx tsc --noEmit` + `npx vitest run src/domain/remittance.test.ts` verde.

### Wave 1 (use-cases — comentario + fixtures)
- **W1.1** — `start-kyc.ts` L59-61: comentario "created"→"quoted".
- **W1.2** — reordenar seeding al nuevo orden (`create → attachQuote → startKyc → applyKyc`):
  - `confirm-and-send.test.ts` `seedQuoted` (L38-45).
  - `track-remittance.test.ts` (L39-41).
  - `use-cases.test.ts` V1 orphan (L187-219): tras pending-fail el estado persistido es **`"quoted"`** (asserts L198/L213 `status=="created"` → `"quoted"`); antes de `startKyc.execute` la remesa debe estar cotizada (seed quote / attachQuote). El retry (L215-218) ahora avanza `quoted→kyc_pending`.
  - `persistence.test.ts` (L46): seed quote antes del `startKyc`.
  - **CD-9 (auto-blindaje WKH-186):** cualquier fake de payout con `deliveredPen` no-null debe ser consistente con el `receive` del quote del mismo flujo, o la reconciliación lo refundea.
- **Verificación:** `npx tsc --noEmit` + suites application/infrastructure verdes.

### Wave 2 (UI — reorden `flow.tsx`)
- **W2.1** — `Step` type + `STEP_LABELS`/`STEP_INDEX` (§3.2) + `useState rateUpdated` + import `Remittance`.
- **W2.2** — handlers: `onConnect` (lockQuote antes del KYC, destino confirm/review), `onContinue` (nuevo), `onVerify` (quitar lockQuote, destino confirm), resume (§3.2 DT-3/CD-11), banner demo.
- **W2.3** — bloques UI: paso `confirm` (review renombrado + `rateUpdated`), paso `review` nuevo (pre-KYC, §3.3).
- **Verificación:** `npx tsc --noEmit` + `npx next build`.

### Wave 3 (tests RTL + regresión)
- **W3.1** — `flow.test.tsx`: ajustar `goToReview()` (L39-44) al nuevo orden. Ojo: en el nuevo orden hay
  DOS botones "Continuar" a distinto tiempo (el del paso `send` y el del paso `review`). Renombrar a
  `goToConfirm()` la ruta completa hasta el paso `confirm`; secuencia: fill send → "Continuar" (send) →
  "Conectar wallet" → "Continuar" (review, dispara verify) → "Escanear DNI + selfie" → llega a `confirm`.
  Ajustar T1/T2 (leen el paso final, ahora `confirm`).
- **W3.2** — nuevos tests RTL: T-AC1, T-AC2, T-AC4, T-AC5b, T-AC6, T-AC8 (§7).
- **Verificación:** `npx vitest run` (los ~223 tests verdes).

---

## 6. Mapeo de ACs (9)

| AC | Cómo se satisface | Test |
|----|-------------------|------|
| AC-1 | `lockQuote` en `onConnect` antes de cualquier KYC; quote visible en `review` | T-AC1 |
| AC-2 | Paso `review` con CTA "Continuar" (`onContinue`, navegación pura); KYC no auto-inicia | T-AC2 |
| AC-3 | `confirm()` L219-222 byte-idéntico; rechaza sin KYC en el nuevo orden | T-COMPLIANCE |
| AC-4 | KYC-once en `onConnect` → `setStep("confirm")` directo (salta review+verify), quote preservado | T-AC4 |
| AC-5 | `quoted→confirmed` (DT-1b) + auto-requote `kyc_passed→quoted` sin re-escanear DNI | T-AC5a, T-AC5b, T-REQUOTE |
| AC-6 | Resume `passed` con quote vigente (`isQuoteStillValid`) → `confirm` sin re-cotizar | T-AC6 |
| AC-7 | `confirm-and-send.ts` intacto (CD-3); autoridad WKH-180 sin cambios | T-AC7 |
| AC-8 | Paso `confirm` muestra `rem.kyc.identity` (L568-580) junto al quote | T-AC8 |
| AC-9 | `TRANSITIONS` post-`confirmed` sin cambios; happy path a `settled` intacto | T-AC9 |

---

## 7. Test Plan (12 tests, ≥1 por AC)

| Test | AC | Archivo | Wave | Qué prueba |
|------|-----|---------|------|-----------|
| T-AC1 (RTL) | AC-1 | `flow.test.tsx` | W3 | tras conectar wallet, el paso `review` muestra el quote lockeado (S/ concreto) ANTES de UI de KYC |
| T-AC2 (RTL) | AC-2 | `flow.test.tsx` | W3 | `review` tiene "Continuar"; el escaneo NO aparece hasta el tap (no auto-inicia KYC) |
| **T-COMPLIANCE** (dominio) | AC-3 | `remittance.test.ts` | W0 | `confirm()` desde `quoted` sin KYC (`created→quoted`, kyc=null) lanza `confirm_requires_kyc_passed`; idem desde `kyc_pending` — el gate no se debilitó |
| T-AC4 (RTL) | AC-4 | `flow.test.tsx` | W3 | KYC-once → tras connect va directo a `confirm` (sin `review` ni escaneo), con quote lockeado |
| T-AC5a (dominio) | AC-5 | `remittance.test.ts` | W0 | re-quote `kyc_passed→quoted` conserva `state.kyc`; luego `confirm()` `quoted→confirmed` OK |
| T-AC5b (RTL) | AC-5 | `flow.test.tsx` | W3 | en `confirm` con quote vencido, `onRelock` re-cotiza y NO vuelve al escaneo de DNI |
| T-AC6 (RTL) | AC-6 | `flow.test.tsx` | W3 | resume `passed` con quote vigente → navega a `confirm` SIN re-cotizar |
| T-AC7 (use-case) | AC-7 | `confirm-and-send.test.ts` | W1 | tests de autoridad WKH-180 (authority false→payout_failed) verdes con el seeding nuevo |
| T-AC8 (RTL) | AC-8 | `flow.test.tsx` | W3 | el paso `confirm` muestra el badge de identidad (`rem.kyc.identity`) junto al quote |
| T-AC9 (dominio) | AC-9 | `remittance.test.ts` | W0 | happy path `…→confirmed→principal_in→payout_submitted→settled` intacto |
| **T-REORDER** (dominio) | AC-1/DT-1b | `remittance.test.ts` | W0 | trayectoria `created→quoted→kyc_pending→kyc_passed→confirmed` válida; `created→kyc_pending` ahora inválida (quote visible antes del KYC) |
| **T-REQUOTE** (dominio) | AC-5/DT-1b | `remittance.test.ts` | W0 | expiry-durante-KYC: `quoted→confirmed` alcanzable tras re-quote → auto re-cotiza + monto nuevo, sin dead-end |

> Los tests existentes actualizados por el reorden también cuentan como cobertura de regresión (CD-6).

**CD-10 (auto-blindaje WKH-185):** si algún test RTL espía `window.location.reload/href`, reemplazar el
objeto `location` completo y restaurarlo en `finally` (no `defineProperty` sobre la property).

---

## 8. Constraint Directives (checklist para el Dev)

### OBLIGATORIO
- [ ] **CD-4:** cada transición nueva en `TRANSITIONS` con razón de negocio inline (§3.1).
- [ ] **CD-6:** actualizar TODOS los tests afectados en esta HU; cero rojos, cero validando el orden viejo.
- [ ] **CD-11:** el re-check de expiry en el resume reusa `Remittance.rehydrate(snapshot).isQuoteStillValid(now)`, NO recalcula `new Date(...) <= now` en la UI.
- [ ] **CD-12:** en `onConnect`, `lockQuote` va SIEMPRE antes de `startKyc` (KYC-once incluido).
- [ ] Seguir el patrón del `review` actual (L548-596) para ambos pasos nuevos.

### PROHIBIDO
- [ ] **CD-1:** tocar cualquier archivo fuera de `chaski-v2/`.
- [ ] **CD-2 (COMPLIANCE):** debilitar/saltear/condicionar-por-flag `confirm_requires_kyc_passed` (L219-222). Cualquier `if (kyc || flag)` = BLOQUEANTE.
- [ ] **CD-3 (COMPLIANCE):** tocar `confirm-and-send.ts` para remover/condicionar `authority.authorize()` (WKH-180).
- [ ] **CD-5:** romper el demo (`isDemoMode`, fallback sin key Didit) o el KYC-once (WKH-181/184).
- [ ] **CD-13:** modificar la lógica interna de `confirm()`/`applyKyc()`/`attachQuote()`/`startKyc()`/`to()`/`mark*` — el único cambio de dominio es `TRANSITIONS`.
- [ ] **CD-14:** re-cotizar en un punto que fuerce re-escanear el DNI o pierda `state.kyc` (el re-quote es `kyc_passed→quoted`, conserva `kyc` por shallow-merge).
- [ ] NO nuevas dependencias. NO cambiar schema `RemittanceState`. NO tocar tramo `confirmed→…→settled` (WKH-186).

---

## 9. Regresión

- **Demo (WKH-178/184):** `isDemoMode()` + banner "Modo demo" siguen; ampliar la condición de step (§3.2) para no perder la señal en `confirm`. T1 (RTL) lo cubre.
- **KYC-once (WKH-181/184):** branch `rememberedKyc` en `onConnect` preservado; solo cambia el destino (`confirm` directo). T-AC4. El reset "¿No sos vos?" (`forgetAndDisconnect`) no se toca (T4/T5 verdes).
- **WKH-180/182/186 aguas abajo:** `confirm-and-send.ts` intacto (CD-3); autoridad server-side, re-checks de expiry y reconciliación corren igual. Suites verdes tras actualizar solo el seeding (W1).
- **Los ~223 tests** de la suite quedan verdes (W3.2).

---

## 10. Anti-Hallucination Checklist (completar antes de cerrar F3)

- [x] Todos los paths y líneas de §2 verificados con Read en F2.5 (coinciden con el código real).
- [x] `TRANSITIONS` (L85-97), `confirm()` (L219-226), `attachQuote()` (L210-216), `to()` shallow-merge (L191-196) confirmados.
- [x] `flow.tsx` `Step` L20, `STEP_LABELS` L21, resume L88-137 (L114 lockQuote, L119 setStep), review L548-596 confirmados.
- [x] Fixtures de test (ready L34, seedQuoted L38, V1 orphan L187-219, goToReview L39) confirmados.
- [x] Sin `[NEEDS CLARIFICATION]` pendientes (los 4 resueltos en el SDD §10).
- [ ] (Dev) Ningún archivo NO-TOCAR modificado en su lógica.
- [ ] (Dev) `Remittance` importado en `flow.tsx` para `rehydrate`/`isQuoteStillValid`.

---

## 11. Done Definition

- [ ] `TRANSITIONS` reescrito (§3.1); ningún otro cambio de lógica en `remittance.ts`.
- [ ] `flow.tsx` reordenado (§3.2/§3.3): quote visible antes del KYC; paso `review` pre-KYC + `confirm` post-KYC; resume con auto-requote condicional.
- [ ] `confirm-and-send.ts` sin tocar (CD-3); gate `confirm()` byte-idéntico (CD-2).
- [ ] Los 12 tests del plan implementados y verdes.
- [ ] Todos los CD del §8 respetados.
- [ ] `npx tsc --noEmit` — sin errores.
- [ ] `npx vitest run` — los ~223 tests verdes.
- [ ] `npx next build` — build OK.
- [ ] Demo + KYC-once funcionando (CD-5).

---

*Story File generado por NexusAgil — WKH-187 — listo para F3.*
