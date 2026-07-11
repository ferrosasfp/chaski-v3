# Story File — [WKH-178] Chaski v2: recibo real (no S/0.00) + banner "Modo demo" + KYC timeout/reset

> **Contrato autosuficiente para el Dev (F3).** Todo lo que necesitás está acá. No hace falta re-leer el
> codebase entero: los anchors (firmas, líneas, patrones) ya están verificados y citados con `archivo:línea`.
> Igual DEBÉS abrir cada archivo del Scope IN antes de editarlo (Anti-Hallucination §3).
> Fuente: `doc/sdd/001-wkh-178-demo-safe-fixes/sdd.md` (SPEC_APPROVED).

---

## 1. Contexto mínimo (qué / por qué / dónde)

**Repo**: `chaski-v2/` (Next 16, Clean Architecture: `domain` → `application` → `infrastructure` / `presentation`, wiring en `composition`). **NO** `wasiai-a2a`.

**Qué se arregla** (3 defectos demo-safe detectados en la auditoría adversarial 2026-07-10):
- **B2 (AC-1/2/3)** — El recibo de éxito muestra **"recibió S/0.00"**. Causa: `TrackRemittance` coalesce `rec.deliveredPen ?? Money.zero("PEN")` → fabrica un cero. Fix: propagar `null` y que la UI decida el fallback (`quote.receive`, o `"—"`).
- **B3 (AC-4/5/6)** — El flujo simulado (payout mock, identidad "María Elena" hardcodeada, `signMessage`) se presenta **sin ningún indicador de que es una demo**. Fix: banner "Modo demo — sin dinero real" derivado de `provenance === "local-fallback"`.
- **A4 (AC-7/8/9)** — Un KYC abandonado deja al usuario bloqueado ~100s y **el bloqueo se repite en cada reload** porque el pending nunca se limpia. Fix: en el timeout, limpiar el pending + mostrar botón "Reintentar" que resetea el flujo sin refrescar.

**Restricción rectora — CD-1 (demo-live)**: PROHIBIDO tocar el demo live (`yarvis` + `agentshop-*`, otros repos). **TODO** el trabajo vive dentro de `chaski-v2/`. Ver el checklist completo de CDs en §6 — son inviolables.

**Naturaleza del cambio**: 100% presentación + un ajuste puntual de use-case + **una** ampliación de firma de dominio (DT-5). Sin nuevos ports/adapters, sin cambios de arquitectura.

---

## 2. Scope IN (lista exhaustiva — NO agregar archivos)

| # | Archivo | Wave | Tipo | Qué |
|---|---|---|---|---|
| 1 | `src/domain/remittance.ts` | W0 | MOD | Ampliar firma `markSettled` a `deliveredPen: Money \| null` (DT-5/CD-5) |
| 2 | `src/application/use-cases/abandon-pending-kyc.ts` | W0 | **NEW** | Use-case `AbandonPendingKyc` (DT-3) |
| 3 | `src/composition/container.ts` | W0 | MOD | Exponer `abandonPendingKyc` en `Container` + wiring |
| 4 | `src/presentation/flow-vm.ts` | W0 | **NEW** | Módulo puro: `isDemoMode`, `deliveredDisplay` |
| 5 | `src/presentation/ui.tsx` | W0 | MOD | Tono `warn` en `Pill` |
| 6 | `src/application/use-cases/track-remittance.ts` | W1 | MOD | Quitar coalesce `?? Money.zero` (AC-1) |
| 7 | `src/application/use-cases/confirm-and-send.ts` | W1 | MOD | Idem, demo-inerte (DT-4) |
| 8 | `src/presentation/flow.tsx` | W1/W2/W3 | MOD | Receipt fallback (AC-2/3), banner (AC-4/5), KYC timeout/reset (AC-7/8/9) |
| 9 | `src/application/use-cases.test.ts` | tests | MOD | Alinear el fake mentiroso + assert monto real (AC-1, AC-7) |
| 10 | `src/presentation/flow-vm.test.ts` | tests | **NEW** | Tests de `isDemoMode`/`deliveredDisplay` (AC-2..6) |
| 11 | `src/application/use-cases/abandon-pending-kyc.test.ts` | tests | **NEW (opcional)** | Test de `AbandonPendingKyc` (AC-7) |

**PROHIBIDO** tocar cualquier otro archivo. En particular (Scope OUT): `src/app/api/**`, `src/infrastructure/didit/kyc-gateway.ts`, `src/infrastructure/fallback/gateways.ts`, `src/infrastructure/wallet.ts`.

---

## 3. Anti-Hallucination anchors (firmas/contratos EXACTOS — verificalos vos mismo antes de editar)

> Cada anchor fue leído con `Read`. Abrí el archivo y confirmá la línea antes de tocar nada.

### A. `markSettled` — firma de dominio a ampliar (DT-5)
`src/domain/remittance.ts:176-178` (ACTUAL):
```ts
markSettled(payoutTx: string, deliveredPen: Money, now: string): void {
  this.to("settled", now, { payoutTx, deliveredPen });
}
```
- El único cambio permitido es el **tipo del 2º parámetro** → `Money | null`. El **cuerpo no cambia** (`this.to(...)` ya acepta `Partial<RemittanceState>` y `RemittanceState.deliveredPen` ya es `Money | null`, ver `remittance.ts:90`).
- Backward-compatible: todos los callers hoy pasan un `Money` real (`remittance.test.ts:42,76`), no rompen.
- **CD-5**: es el ÚNICO cambio de dominio permitido. PROHIBIDO tocar `TRANSITIONS` / invariantes. En particular PROHIBIDO agregar self-transition `kyc_pending→kyc_pending` (ver `TRANSITIONS`, `remittance.ts:59-71`).

### B. `Container` interface + patrón de wiring (DT-3)
`src/composition/container.ts:26-36` — interfaz `Container`: los **9 miembros son use-cases** (`previewQuote`, `createRemittance`, `connectWallet`, `startKyc`, `resumeKyc`, `lockQuote`, `confirmAndSend`, `trackRemittance`, `listHistory`). Se agrega un **10º use-case**: `abandonPendingKyc: AbandonPendingKyc`.
`src/composition/container.ts:38-62` — `createContainer()`: `const kycPending = new LocalKycPendingStore();` (l.43) YA existe. Patrón de wiring (l.51-61): `nombre: new UseCase(dep)`. Reusar la instancia `kycPending` existente — NO crear otra.
- **CD-6**: la presentación NO importa ni instancia `LocalKycPendingStore`/`KycPendingStore`. El clear pasa SIEMPRE por `c.abandonPendingKyc.execute()`.
- Nota: `flow.tsx:46` usa `const c = useMemo(() => createContainer(), [])` → agregar el miembro al `Container` lo hace disponible como `c.abandonPendingKyc`.

### C. `KycPendingStore.clear()` (contrato de infra)
`src/application/ports.ts:53-57`:
```ts
export interface KycPendingStore {
  save(p: KycPending): Promise<void>;
  get(): Promise<KycPending | null>;
  clear(): Promise<void>;
}
```
Impl: `src/infrastructure/kyc-pending-store.ts:21-23` (`clear()` → `localStorage.removeItem(KEY)`). El use-case `AbandonPendingKyc` solo llama `await this.pending.clear()`.

### D. `Pill` — firma y tokens (AC-4/5, W0-5)
`src/presentation/ui.tsx:95-118` (ACTUAL):
```ts
const PILL: Record<string, string> = {
  neutral: "bg-sand text-stone",
  active: "bg-cochineal/10 text-cochineal-ink",
  ok: "bg-verde-bg text-verde",
  bad: "bg-cochineal/10 text-cochineal-ink",
};
export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "active" | "ok" | "bad";
  children: ReactNode;
}) { ... }
```
- Agregar `warn` al record `PILL` **y** a la union `tone`. Tokens existentes (NO inventar clases): sugerido `warn: "bg-sand text-ink"` o `"bg-cochineal/10 text-cochineal-ink"`. **NO** reusar `bg-verde-bg`/`ok` (verde = éxito real, confunde). Paleta disponible: `sand`, `stone`, `verde`/`verde-bg`, `cochineal`/`cochineal-ink`, `ink`, `line`. No hay ámbar en la paleta.
- Exemplars de reuso de `Pill`: `flow.tsx:468` (`<Pill tone="active">…`), `flow.tsx:592` (`<Pill tone="ok">Entregado</Pill>`).

### E. `RemittanceState` — campos que consume el flow-vm
`src/domain/remittance.ts:79-94`. Campos relevantes:
- `deliveredPen: Money | null` (l.90) — ya nullable.
- `quote: Quote | null` (l.84); `Quote.provenance: string` (l.23); `Quote.receive: Money` (l.18).
- `kyc: KycVerification | null` (l.85); `KycVerification.provenance: string` (l.42).
- `status: RemittanceStatus` (l.81).
El gateway ya devuelve nullable: `PayoutRecord.deliveredPen: Money | null` (`ports.ts:70`). El fallback demo devuelve `deliveredPen:null` (harness intencional, NO tocar — CD-4).

### F. `resetTo(...)` — reset de flujo (AC-9)
`src/presentation/flow.tsx:612-620`:
```ts
function resetTo(
  setStep: (s: Step) => void,
  setRem: (r: RemittanceState | null) => void,
  setPreview: (q: Quote | null) => void,
): void {
  setRem(null);
  setPreview(null);
  setStep("send");
}
```
Ya se usa en el Recibo: `flow.tsx:515` (`onNew={() => resetTo(setStep, setRem, setPreview)}`). Reusar tal cual en `onRetryKyc` — NO crear otro reset.

### G. State/refs del componente `RemittanceFlow` (para W2/W3)
`src/presentation/flow.tsx:45-84`. Ya existen: `step/setStep` (l.47), `error/setError` (l.49), `preview/setPreview` (l.59), `rem/setRem` (l.60), `resuming/setResuming` (l.62), `resumedRef` (l.84, `useRef(false)`). El Stepper fijo está en l.268-270. Se AGREGA un solo estado nuevo: `const [timedOut, setTimedOut] = useState(false)`.

---

## 4. Waves paso a paso

> Todas las waves comparten `flow.tsx` (secciones distintas) ⇒ **seriales en un único Dev run**: W0 → W1 → W2 → W3. `remittance.ts`/`track-remittance.ts`/`confirm-and-send.ts`/`abandon-pending-kyc.ts`/`container.ts`/`ui.tsx`/`flow-vm.ts` no colisionan entre sí.

### W0 — Contratos / scaffolding (serial, PRIMERO)

**W0-1 · `src/domain/remittance.ts`** — cambiar SOLO el tipo del parámetro:
```ts
// antes:
markSettled(payoutTx: string, deliveredPen: Money, now: string): void {
// después:
markSettled(payoutTx: string, deliveredPen: Money | null, now: string): void {
```
Cuerpo intacto. → habilita AC-1. (DT-5/CD-5)

**W0-2 · `src/application/use-cases/abandon-pending-kyc.ts`** (NEW) — molde: `list-history.ts` (constructor 1 dep + `execute()` delega). Objetivo:
```ts
import type { KycPendingStore } from "../ports";

/** Abandona un KYC en curso (limpia el pending) — usado cuando el resume-loop agota el timeout,
 *  para que el próximo reload no repita el bloqueo. */
export class AbandonPendingKyc {
  constructor(private readonly pending: KycPendingStore) {}

  async execute(): Promise<void> {
    await this.pending.clear();
  }
}
```
(DT-3). Import type-only del port (`ports.ts:53`).

**W0-3 · `src/composition/container.ts`** — 3 ediciones:
1. import: `import { AbandonPendingKyc } from "../application/use-cases/abandon-pending-kyc";`
2. interfaz `Container` (tras `listHistory: ListHistory;`, l.35): agregar `abandonPendingKyc: AbandonPendingKyc;`
3. return de `createContainer` (tras `listHistory: new ListHistory(repo),`, l.60): agregar `abandonPendingKyc: new AbandonPendingKyc(kycPending),` (reusa la `kycPending` de l.43). (CD-6)

**W0-4 · `src/presentation/flow-vm.ts`** (NEW) — módulo puro, sin React, imports type-only:
```ts
import type { Money } from "../domain/money";
import type { RemittanceState } from "../domain/remittance";

/** "Modo demo" ⇔ algún dato del flujo vino del fallback local (no Didit / no partner real). */
export function isDemoMode(rem: RemittanceState): boolean {
  return rem.quote?.provenance === "local-fallback" || rem.kyc?.provenance === "local-fallback";
}

/** Monto a MOSTRAR como entregado: el real; si no llegó, el cotizado; si tampoco, null → UI muestra "—". */
export function deliveredDisplay(rem: RemittanceState): Money | null {
  return rem.deliveredPen ?? rem.quote?.receive ?? null;
}
```
Imports **type-only** (`import type`) para no arrastrar runtime al `vitest run` en node. (AC-2/3/4/5/6 se testean acá, sin render.)

**W0-5 · `src/presentation/ui.tsx`** — agregar tono `warn` al `PILL` y a la union:
```ts
const PILL: Record<string, string> = {
  neutral: "bg-sand text-stone",
  active: "bg-cochineal/10 text-cochineal-ink",
  ok: "bg-verde-bg text-verde",
  bad: "bg-cochineal/10 text-cochineal-ink",
  warn: "bg-sand text-ink",            // <- nuevo (o bg-cochineal/10 text-cochineal-ink)
};
// y en la union:
tone?: "neutral" | "active" | "ok" | "bad" | "warn";
```
Copy/placement fino = criterio de diseño del Dev, dentro de la paleta existente. NO usar `ok`/verde.

### W1 — B2: recibo real (AC-1/2/3)

**W1-1 · `src/application/use-cases/track-remittance.ts:21`** — quitar el coalesce:
```ts
// antes:
r.markSettled(rec.txRef ?? "", rec.deliveredPen ?? Money.zero("PEN"), this.clock.nowIso());
// después:
r.markSettled(rec.txRef ?? "", rec.deliveredPen, this.clock.nowIso());
```
Si `Money` queda sin uso en el archivo, **eliminá el import** `import { Money } from "../../domain/money";` (l.1) para pasar `tsc --noEmit`. → **AC-1**

**W1-2 · `src/application/use-cases/confirm-and-send.ts:52`** — idem (DT-4, demo-inerte):
```ts
// antes:
r.markSettled(rec.txRef ?? "", rec.deliveredPen ?? Money.zero("PEN"), this.clock.nowIso());
// después:
r.markSettled(rec.txRef ?? "", rec.deliveredPen, this.clock.nowIso());
```
Ajustá el import de `Money` solo si queda sin uso (revisá el resto del archivo antes de borrarlo). Esta rama NO corre en el demo (el `FallbackPayoutGateway.submit()` devuelve `status:"submitted"`, nunca `settled`), pero elimina el bug latente idéntico. (CD-8)

**W1-3 · `src/presentation/flow.tsx` `Receipt` (l.576-577)** — usar el helper:
```ts
// antes:
const delivered = rem.deliveredPen ?? rem.quote?.receive;
// después:
const delivered = deliveredDisplay(rem);
```
Agregar import: `import { deliveredDisplay, isDemoMode } from "./flow-vm";`. La l.585 ya renderiza `{delivered ? delivered.format() : "—"}` ⇒ **AC-2** (fallback a `quote.receive`) y **AC-3** (`"—"` cuando ambos null) quedan cubiertas por el helper.

### W2 — B3: banner "Modo demo" (AC-4/5/6)

**W2-1 · `src/presentation/flow.tsx`** — indicador visible cuando `isDemoMode(rem) && (step === "review" || step === "track" || step === "done")`. Punto de render sugerido: bloque fijo **debajo del `Stepper`** (después de `flow.tsx:270`, `</div>` del Stepper wrapper), gateado por esa condición, para cubrir los 3 steps con un solo nodo. Usar `<Pill tone="warn">Modo demo — sin dinero real</Pill>` o un banner que reuse ese estilo. **AC-4**
- Cuidado: `rem` puede ser `null` (steps `send`/`connect`). Gateá con `rem && isDemoMode(rem) && …`.

**W2-2 · `Receipt` (done, l.584-586)** — mostrar el mismo indicador junto al monto entregado, para que no se confunda con dinero real. Podés reusar `isDemoMode(rem)` dentro de `Receipt` (ya importado en W1-3). **AC-5**

**W2-3** — Todo deriva de `isDemoMode` (que lee `provenance`). Sin flags, sin env vars. **AC-6 / CD-7**

### W3 — A4: KYC timeout + reset (AC-7/8/9)

**W3-0** — agregar estado: `const [timedOut, setTimedOut] = useState(false);` (junto a los otros `useState`, ~l.62).

**W3-1 · `src/presentation/flow.tsx` efecto resume, branch de timeout (l.124-127)** — hoy:
```ts
if (alive) {
  setResuming(false);
  setError("La verificación está tardando. Actualizá la página en un momento.");
}
```
Objetivo (limpiar pending + marcar timeout):
```ts
if (alive) {
  setResuming(false);
  await c.abandonPendingKyc.execute();   // <- limpia el pending (CD-6): próximo reload no repite el bloqueo
  setTimedOut(true);
  setError("La verificación está tardando.");
}
```
→ **AC-7** (pending limpio ⇒ el próximo `resumeKyc` devuelve `none`, sin re-bloqueo de ~100s).

**W3-2 · render del bloque timeout** — cuando `timedOut`, renderizar un `Card` con el mensaje de timeout + un **botón "Reintentar"** (usar `Button` de `./ui`, exemplar `flow.tsx:595`). **AC-8**

**W3-3 · handler `onRetryKyc`** — resetear sin reload:
```ts
const onRetryKyc = () => {
  setTimedOut(false);
  setError(null);
  resetTo(setStep, setRem, setPreview);   // step="send", rem=null, preview=null
};
```
`resumedRef` sigue en `true` ⇒ el efecto de resume NO se re-dispara (no re-entra al loop). Lleva a `step="send"` (fresh remittance), estado accionable presentación-only que además arregla el escenario post-reload (DT-6). **AC-9**
- **CD-5/DT-6**: el reset va a `send`, NO a `verify`/`connect` (esos re-disparan `startKyc` → `to("kyc_pending")` sobre `kyc_pending` → `invalid_transition`). PROHIBIDO tocar el dominio para permitirlo.

---

## 5. Mapa AC → Wave → Archivo

| AC | Descripción | Wave | Archivo(s) |
|---|---|---|---|
| AC-1 | `deliveredPen:null`+`settled` ⇒ mantener `null` (no coalescer a `Money.zero`) | W1-1 (+W0-1 habilitante) | `track-remittance.ts:21`, `remittance.ts:176` |
| AC-2 | Recibo con `deliveredPen` null ⇒ mostrar `quote.receive` | W1-3 (W0-4) | `flow.tsx:577,585`, `flow-vm.ts` |
| AC-3 | `deliveredPen` y `quote` null ⇒ placeholder `"—"` (no `S/0.00`) | W1-3 (W0-4) | `flow.tsx:585`, `flow-vm.ts` |
| AC-4 | Banner "Modo demo" en steps `review`/`track`/`done` | W2-1 (W0-4/W0-5) | `flow.tsx`, `flow-vm.ts`, `ui.tsx` |
| AC-5 | Mismo indicador junto al monto en `done` (Recibo) | W2-2 | `flow.tsx` Receipt |
| AC-6 | Indicador derivado SOLO de `provenance` (sin flag/env) | W2 (W0-4) | `flow-vm.ts` (`isDemoMode`) |
| AC-7 | Timeout KYC ⇒ limpiar pending (no re-bloqueo en reload) | W3-1 (W0-2/W0-3) | `flow.tsx:124-127`, `abandon-pending-kyc.ts`, `container.ts` |
| AC-8 | Timeout KYC ⇒ botón "Reintentar" junto al error | W3-2 (W3-0) | `flow.tsx` |
| AC-9 | "Reintentar" ⇒ nueva verificación sin refrescar página | W3-3 | `flow.tsx` (`onRetryKyc` + `resetTo`) |

---

## 6. Constraint Directives — CHECKLIST INVIOLABLE (no violar ninguna)

- [ ] **CD-1**: NO tocar el demo live (`yarvis` + `agentshop-*`, otros repos). Todo dentro de `chaski-v2/`.
- [ ] **CD-2**: NO tocar `src/app/api/**` ni `DiditKycGateway` (`src/infrastructure/didit/kyc-gateway.ts`) ni el server-truth de Didit.
- [ ] **CD-3**: "Modo demo" derivado de `provenance` (`Quote.provenance` / `KycVerification.provenance`). PROHIBIDO env var / flag nuevo.
- [ ] **CD-4**: NO modificar `FallbackPayoutGateway`/`FallbackKycGateway` (`src/infrastructure/fallback/gateways.ts`) para "simular menos" (identidad, `signMessage`, monto, `deliveredPen:null`). Solo se VISIBILIZA.
- [ ] **CD-5**: ÚNICO cambio de dominio = ampliar `markSettled` a `deliveredPen: Money | null`. PROHIBIDO alterar transiciones/invariantes; PROHIBIDO self-transition `kyc_pending→kyc_pending` (por eso el retry va a `send`).
- [ ] **CD-6**: la presentación NO importa ni instancia `LocalKycPendingStore`/`KycPendingStore`. El clear pasa SIEMPRE por `c.abandonPendingKyc.execute()`.
- [ ] **CD-7**: el indicador se computa SOLO vía `isDemoMode(rem)` (lee `provenance`). Refuerza CD-3.
- [ ] **CD-8**: NO cambiar el demo happy-path. Tras los cambios, la pantalla de Recibo del demo DEBE seguir mostrando el monto del quote (no `"—"`). El fix de `confirm-and-send.ts:52` es demo-inerte.
- [ ] **CD-9**: PROHIBIDO meter `deliveredPen` no-null "por las dudas" en los fallback gateways para esquivar el fix (violaría CD-4/anularía AC-1). El fake de test se ajusta SOLO vía inyección (`statusResult`), sin editar su default.

---

## 7. Test plan (≥1 por AC; el repo NO tiene harness de componente — `vitest run` en node, sin jsdom)

> Estrategia QUALITY del repo: testear lógica pura (dominio/aplicación/helpers), no renders. Por eso W0 extrae `flow-vm.ts` como seam puro. AC-8/9 (navegación/render) se validan por AR (code-review) + QA manual con evidencia.

**MOD · `src/application/use-cases.test.ts`**
- **(a) Alinear el fake mentiroso (AC-1)**: el happy-path (l.65) hoy asserta solo `r.snapshot.deliveredPen?.currency === "PEN"` — pasa AÚN con el bug (`Money.zero` también es PEN). Reforzar al monto real: `expect(r.snapshot.deliveredPen).toEqual(Money.of(368, "PEN"))` (el `FakePayoutGateway.status()` default devuelve `Money.of(368,"PEN")`, `fakes.ts:148`). Importar `Money` en el test si hace falta.
- **(b) NEW test passthrough del null (AC-1)**: `setup({ payout: new FakePayoutGateway({}, { deliveredPen: null }) })` → correr create→kyc→lock→confirm→track → `expect(r.snapshot.status).toBe("settled")` y `expect(r.snapshot.deliveredPen).toBeNull()`. El 2º arg del constructor es `statusResult: Partial<PayoutRecord>` (`fakes.ts:132`) ⇒ inyecta `deliveredPen:null` SIN editar el fake (CD-9).
- **(c) AC-7** (si no se usa el archivo opcional): test de `AbandonPendingKyc` — `const pending = new FakeKycPendingStore(); await pending.save({remittanceId,sessionId,address}); await new AbandonPendingKyc(pending).execute(); expect(await pending.get()).toBeNull();`.

**NEW · `src/presentation/flow-vm.test.ts`** (imports de `Money` runtime OK acá; el módulo bajo test usa `import type`):
- **AC-2**: `deliveredDisplay({ deliveredPen: null, quote: { receive: Money.of(1490,"PEN"), … } } as RemittanceState)` → `toEqual(Money.of(1490,"PEN"))`.
- **AC-3**: `deliveredDisplay({ deliveredPen: null, quote: null } as RemittanceState)` → `toBeNull()`.
- **AC-4**: `isDemoMode` con `quote.provenance="local-fallback"` → `true`; con `kyc.provenance="local-fallback"` → `true`.
- **AC-5**: estado `done` demo (`deliveredPen:null`, `quote.provenance="local-fallback"`) → `isDemoMode` `true`.
- **AC-6**: `isDemoMode` con ambos `provenance="didit"` → `false` (prueba que deriva de `provenance`, no de flag).
- Podés construir fixtures mínimos con `as RemittanceState` (cast parcial) — solo se leen los campos que el helper toca.

**NEW opcional · `src/application/use-cases/abandon-pending-kyc.test.ts`** (AC-7, si preferís aislarlo de `use-cases.test.ts`): mismo test (c) de arriba, con `FakeKycPendingStore`.

**AC-8 / AC-9** — sin harness de componente ⇒ **AR (code-review)** verifica: existe el botón "Reintentar" en el branch `timedOut`; `onRetryKyc` resetea a `step="send"` sin reload; `resumedRef` evita re-disparo del efecto. **QA manual** aporta evidencia visual.

**Regresión**: `src/domain/remittance.test.ts` (callers de `markSettled` con `Money`) debe seguir verde — la ampliación del param es compatible.

---

## 8. Definition of Done (el Dev cierra F3 cuando TODO esto pasa)

- [ ] `npx tsc --noEmit` **limpio** (0 errores — ojo con imports de `Money` huérfanos en W1).
- [ ] `npm test` (o `vitest run`) **verde**, incluyendo los tests nuevos (`flow-vm.test.ts`, opcional `abandon-pending-kyc.test.ts`) y los modificados (`use-cases.test.ts`).
- [ ] `npm run build` **OK**.
- [ ] Los 9 ACs implementados y mapeados (§5); las 9 CDs respetadas (§6).
- [ ] Cambios visuales verificables (para AR/QA):
  - Recibo con **monto real** (AC-1/2) y `"—"` en el caso inconsistente (AC-3) — NUNCA `S/0.00`.
  - **Banner "Modo demo — sin dinero real"** visible en `review`/`track`/`done` cuando el flujo es fallback (AC-4/5).
  - **Botón "Reintentar"** tras el timeout de KYC, que resetea a `send` sin refrescar (AC-8/9).
  - **CD-8 check manual**: el demo happy-path sigue mostrando el monto del quote en el Recibo (no `"—"`).
- [ ] Ningún archivo fuera del Scope IN (§2) fue tocado.

---

**Story File LISTO para F3.** El Dev implementa W0→W1→W2→W3 en un único run serial (todo comparte `flow.tsx`), corre los tests y valida el DoD.
