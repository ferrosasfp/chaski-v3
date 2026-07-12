# Story File — WKH-185 · Component test harness (jsdom + RTL) + backfill de ACs de UI

**Repo**: `chaski-v2/` (NO tocar `wasiai-a2a`, `wasiai-v2`, `yarvis`, ni ningún otro — CD-1)
**Fase**: F3 (implementación). Gate `SPEC_APPROVED` otorgado.
**Fuente de verdad**: este archivo + el SDD (`doc/sdd/008-wkh-185-component-test-harness-backfill/sdd.md`). El Dev SOLO lee este Story File; si algo no está acá, no se hace.
**Naturaleza**: deuda técnica **test-only**. El **único** cambio de runtime de producción = un prop opcional `container?` en `RemittanceFlow` (`flow.tsx`). Todo lo demás es harness + tests nuevos.

---

## 1. Contexto (por CONTENIDO, no por memoria)

`chaski-v2` NO tiene harness de tests de componente: en `package.json` (`devDependencies`, líneas 33-42) solo está `vitest@^2.1.1` — no hay `jsdom`, ni `@testing-library/*`, y **no existe** `vitest.config.ts` (Vitest corre con `environment: "node"` por default). Consecuencia: varios ACs de UI de WKH-178/181/184 quedaron validados en F4 solo por "inspección de código"/"code review (sin RTL)".

Esta HU:
1. Agrega el harness mínimo (jsdom per-file + React Testing Library).
2. Abre un seam de inyección de dependencias en `flow.tsx` para poder renderizar el flujo con fakes.
3. Backfillea con tests RTL reales **exactamente 5 ACs** (lista cerrada AC-5..AC-9, ver §6). PROHIBIDO expandir fuera de esta lista sin volver a F1 (CD-7).

**Regla de oro del cambio de prod (CD-2)**: en `flow.tsx`, el único cambio de *runtime* es el prop `container`. El único ripple type-only permitido es agregar `type Container` al import existente. **Ninguna otra línea de `flow.tsx` cambia.** Cuando `app/page.tsx` (único caller, no pasa props) renderiza `<RemittanceFlow />`, el comportamiento es byte-a-byte idéntico al actual.

---

## 2. Anti-Hallucination Anchors (archivo:línea EXACTO — verificado con Read en F2)

Ninguna de estas referencias se inventó. El Dev DEBE re-leer estos anchors antes de escribir cada pieza.

### 2.1 `package.json` — deps a agregar (hoy solo `vitest`)
- `devDependencies` en **líneas 33-42**. Contiene HOY: `@types/node`, `@types/react`, `@types/react-dom`, `autoprefixer`, `postcss`, `tailwindcss`, `typescript`, `vitest@^2.1.1`. **No hay jsdom ni RTL.**
- `dependencies` (líneas 17-31): `react`/`react-dom` = **`19.0.0`** (por eso RTL debe ser v16+), `framer-motion@^11.5.0` (línea 23), `next@^16.2.10` (línea 25).
- Scripts (líneas 13-15): `"test": "vitest run"`, `"test:core": "vitest run src/domain src/application"`, `"qa": "npm run typecheck && npm run test"`.
- **Agregar a `devDependencies` (versiones exactas)**:
  - `"jsdom": "^25.0.0"`
  - `"@testing-library/react": "^16.1.0"`  (compatible React 19)
  - `"@testing-library/user-event": "^14.5.0"`
  - `"@testing-library/jest-dom": "^6.6.0"`
- Correr `npm install` → regenera `package-lock.json` (consecuencia mecánica; NO editar el lock a mano).

### 2.2 `src/presentation/flow.tsx` — el seam
- **Línea 16**: `import { createContainer } from "../composition/container";` → pasa a `import { createContainer, type Container } from "../composition/container";` (import de TIPO, borrado en build, cero runtime).
- **Líneas 46-47** (el punto exacto de inyección):
  ```tsx
  export function RemittanceFlow() {
    const c = useMemo(() => createContainer(), []);
  ```
- **Ubicación de los steps/controles que cada test debe encontrar** (para no alucinar textos ni queries):
  - Badge de address + control reset: **líneas 295-327**, dentro de `{address ? ( ... ) : null}`.
    - Badge address: `{address.slice(0, 6)}…{address.slice(-4)}` (línea 299) → para `"0xSender"` renderiza `0xSend…nder`.
    - Botón `¿No sos vos?`: **líneas 319-324** (visible cuando `confirmReset === false`).
    - Botón `Empezar de nuevo` → `onClick={forgetAndDisconnect}`: **líneas 304-310** (visible cuando `confirmReset === true`).
  - Banner `Sin aislamiento por wallet…` (FallbackWallet): **líneas 333-339** (NO aplica a estos tests; `FakeWallet` da `"0xSender"`, no una fallback address).
  - Banner **`Modo demo — sin dinero real`** (`Pill tone="warn"`): **líneas 341-345**, condición `rem && isDemoMode(rem) && (step === "review" || step === "track")`.
  - Card `resuming` (`Verificando tu identidad…`): **líneas 347-356**.
  - Card `timedOut` con botón **`Reintentar`** (`<Button onClick={onRetryKyc}>Reintentar</Button>`): **líneas 357-366**.
  - `AnimatePresence mode="wait"` + `motion.div key={step}`: **líneas 368-376** (el motivo de CD-8).
  - Step `send`: **líneas 377-445**. Input monto `aria-label="Monto en dólares"` (línea 388, default `"400"` línea 53). Input recipient con `placeholder="Nombre de tu familiar"` (línea 410). Botones método (`Yape`/`Plin`/`Banco (CCI)`, líneas 416-428). Input destino `placeholder="999 888 777"` para `yape` (línea 435). Botón `Continuar` (líneas 441-443).
  - Step `connect`: **líneas 447-478**. Botón `Conectar wallet` (líneas 468-476).
  - Step `verify`: **líneas 480-546**. Botón `Escanear DNI + selfie` (líneas 536-544).
  - Step `review`: **líneas 548-596** (render gate `step === "review" && rem?.quote`).
    - Monto recibido: `{rem.quote.receive.format()}` (línea 559) — con `FakeQuoteGateway` es un PEN concreto, nunca `S/0.00` ni `—`.
    - Identidad KYC (líneas 568-580): `{rem.kyc.identity.firstName} {rem.kyc.identity.lastNamePaternal} {rem.kyc.identity.lastNameMaternal}` + `{rem.kyc.identity.documentType} ••••{rem.kyc.identity.documentNumberLast4}` — con los fakes = `Test Quispe Mamani` · `DNI ••••5678`.
  - `Receipt` (step `done`): **líneas 661-690**, `deliveredDisplay` (nunca `S/0.00`).
- **Handlers relevantes** (NO se modifican, solo se ejercitan):
  - `onRetryKyc` (líneas 231-235): `setTimedOut(false)` + `resetTo(...)` → step `"send"`, **sin `window.location.reload`**.
  - `forgetAndDisconnect` (líneas 239-257): limpia PII → `setRecipient("")` (251), `setDestination("")` (252), `setAmount("400")` (254), `setAddress(null)` (247), `setStep("send")` (255).
  - Resume-loop (líneas 88-137): `for (let i = 0; i < 40; i++)` con `await sleep(2500)` (línea 107) en `kind==="processing"`; al agotar → `abandonPendingKyc` (129) + `setTimedOut(true)` (130).

### 2.3 `app/page.tsx` — único caller
- **Línea 4**: `return <RemittanceFlow />;` (sin props). Un prop opcional es 100% backward-compatible. **NO se modifica este archivo.**

### 2.4 `src/composition/container.ts` — el contrato a inyectar
- **Líneas 29-41**: `export interface Container` = los 11 use-cases: `previewQuote`, `createRemittance`, `connectWallet`, `startKyc`, `resumeKyc`, `lockQuote`, `confirmAndSend`, `trackRemittance`, `listHistory`, `abandonPendingKyc`, `forgetKyc`.
- **Líneas 43-70**: `createContainer()` — orden de construcción EXACTO que `buildTestContainer` debe imitar (mismos constructores, mismos args), pero con dobles:
  - `previewQuote: new PreviewQuote(quotes)`
  - `createRemittance: new CreateRemittance(repo, clock, ids)`
  - `connectWallet: new ConnectWallet(wallet, kycStore)`
  - `startKyc: new StartKyc(kyc, kycStore, kycPending, repo, clock)`
  - `resumeKyc: new ResumeKyc(kyc, kycStore, kycPending, repo, clock)`
  - `lockQuote: new LockQuote(quotes, repo, clock)`
  - `confirmAndSend: new ConfirmAndSend(wallet, payouts, repo, clock, payoutAuthority)`
  - `trackRemittance: new TrackRemittance(payouts, repo, clock)`
  - `listHistory: new ListHistory(repo)`
  - `abandonPendingKyc: new AbandonPendingKyc(kycPending)`
  - `forgetKyc: new ForgetKyc(kycStore, kycPending)`
- `FallbackQuoteGateway` se importa acá (líneas 17-21, desde `../infrastructure/fallback/gateways`) → confirma que es importable para T1 (provenance `local-fallback`, infra pura sin red).

### 2.5 `src/test-support/fakes.ts` — los dobles disponibles (11 ports) + shapes
- `FixedClock` (36-44) · `SeqIds` (58-63) · `InMemoryRepo` (65-87).
- `FakeQuoteGateway` (89-105): `receive` = `Money.of((amountUsd - 0.5) * 3.7, "PEN")`, `provenance: "fake"`. Para `amount=400` → `receive ≈ S/ 1478.50` (concreto, no cero).
- `FakeKycGateway` (107-140): default `redirect=false` → `start()` devuelve `{ kind: "completed", verification }` con `identity` = `firstName "Test"`, `lastNamePaternal "Quispe"`, `lastNameMaternal "Mamani"`, `documentType "DNI"`, `documentNumber "12345678"` → `toPersistedIdentity` reduce a `documentNumberLast4 "5678"`. `approved:true`, `payoutAllowed:true`.
- `FakeKycPendingStore` (142-153) · `FakePayoutGateway` (185-210) · `FakeWallet` (212-222, `connect()→"0xSender"`) · `FakeKycStore` (224-235, empieza vacío) · `FakePayoutAuthorityGateway` (254-261, default `authorized:true`).
- `beneficiary()` helper (263-268).
- (Existen dobles `Throwing*` para casos de error — NO se usan en esta HU.)

### 2.6 Tipos para overrides — `src/application/ports.ts` + `resume-kyc.ts`
- Ports (líneas): `QuoteGateway` (21), `KycGateway` (44), `KycPendingStore` (56), `WalletPort` (97), `KycStore` (104), `PayoutAuthorityGateway` (91), `Clock` (119), `IdGenerator` (122). `KycStartResult` (36).
- `ResumeKyc` (clase) en `src/application/use-cases/resume-kyc.ts:14`; su result type `ResumeKycResult` (líneas 9-12) = `{kind:"none"} | {kind:"processing"} | {kind:"passed";snapshot} | {kind:"failed";snapshot}`. `execute(): Promise<ResumeKycResult>` (línea 23). Para el stub de T3 se reemplaza `resumeKyc` por un objeto con `execute: async () => ({ kind: "processing" })`.

### 2.7 `src/presentation/flow-vm.ts` — gating de "Modo demo"
- `isDemoMode` (líneas 6-8): `true` ⇔ `provenance === "local-fallback"`. Los fakes usan `"fake"` → NO disparan el banner. Por eso T1 usa `FallbackQuoteGateway` (provenance real `"local-fallback"`).
- Estilo de test del repo (`flow-vm.test.ts:1`): `import { describe, expect, it } from "vitest"` — **globals NO habilitados**. jest-dom debe registrarse per-file sin depender de globals.

---

## 3. Scope IN (lista exhaustiva de archivos a tocar)

| Archivo | Acción | Nota |
|---|---|---|
| `package.json` | Editar | +4 devDeps (§2.1). Nada en `dependencies`. |
| `package-lock.json` | Regenerado | Por `npm install`. No editar a mano. |
| `src/presentation/flow.tsx` | Editar (mínimo) | Solo líneas 16 + 46-47 (§4.1). CD-2. |
| `src/test-support/test-container.ts` | **NUEVO** | `buildTestContainer` (§4.2). |
| `src/presentation/flow.test.tsx` | **NUEVO** | Los 5 tests RTL (§5). |
| `doc/sdd/008-.../*` | Artefactos pipeline | Este story-file + reportes. |

**Scope OUT** (NO tocar): `vitest.config.ts` (no se crea — CD-3), `app/page.tsx`, `src/presentation/ui.tsx` (solo se consume por queries), cualquier use-case/dominio/infra fuera del seam, cualquier repo que no sea `chaski-v2`.

---

## 4. Diseño paso a paso — W0 (harness, SERIAL)

### 4.1 Seam DI en `flow.tsx` (CD-2 — único cambio de prod)
Cambio quirúrgico, solo 2 puntos:

**Línea 16** (agregar el import de tipo):
```tsx
import { createContainer, type Container } from "../composition/container";
```

**Líneas 46-47** (firma + memo):
```tsx
export function RemittanceFlow({ container }: { container?: Container } = {}) {
  const c = useMemo(() => container ?? createContainer(), [container]);
```
En prod `container === undefined` siempre → `[undefined]` estable → `createContainer()` corre una vez, idéntico al `[]` actual. **Ninguna otra línea de `flow.tsx` se toca.**

### 4.2 `buildTestContainer` en `src/test-support/test-container.ts` (NUEVO)
Ensambla los 11 dobles de `fakes.ts` en un `Container`, compartiendo `repo`/`clock`/`ids` entre los use-cases (para que `createRemittance → startKyc → lockQuote` operen sobre el mismo estado). Permite override a nivel gateway (para T1) y a nivel use-case (escape hatch `useCases` para el stub de T3). Imita el orden de `container.ts:57-69`.

API (del SDD DT-3):
```ts
import { Container } from "../composition/container";
import { PreviewQuote } from "../application/use-cases/preview-quote";
import { CreateRemittance } from "../application/use-cases/create-remittance";
import { ConnectWallet } from "../application/use-cases/connect-wallet";
import { StartKyc } from "../application/use-cases/start-kyc";
import { ResumeKyc } from "../application/use-cases/resume-kyc";
import { LockQuote } from "../application/use-cases/lock-quote";
import { ConfirmAndSend } from "../application/use-cases/confirm-and-send";
import { TrackRemittance } from "../application/use-cases/track-remittance";
import { ListHistory } from "../application/use-cases/list-history";
import { AbandonPendingKyc } from "../application/use-cases/abandon-pending-kyc";
import { ForgetKyc } from "../application/use-cases/forget-kyc";
import type {
  Clock, KycGateway, KycPendingStore, KycStore,
  PayoutAuthorityGateway, PayoutGateway, QuoteGateway, WalletPort,
} from "../application/ports";
import {
  FakeQuoteGateway, FakeKycGateway, FakeWallet, FakeKycStore,
  FakeKycPendingStore, FakePayoutGateway, FakePayoutAuthorityGateway,
  FixedClock, SeqIds, InMemoryRepo,
} from "./fakes";

export interface TestContainerOverrides {
  quotes?: QuoteGateway;                     // default: new FakeQuoteGateway()
  kyc?: KycGateway;                          // default: new FakeKycGateway()
  wallet?: WalletPort;                       // default: new FakeWallet()
  kycStore?: KycStore;                       // default: new FakeKycStore()
  pending?: KycPendingStore;                 // default: new FakeKycPendingStore()
  payouts?: PayoutGateway;                   // default: new FakePayoutGateway()
  payoutAuthority?: PayoutAuthorityGateway;  // default: new FakePayoutAuthorityGateway()
  clock?: Clock;                             // default: new FixedClock()
  useCases?: Partial<Container>;             // escape hatch (ej. resumeKyc stub para T3)
}

export function buildTestContainer(o: TestContainerOverrides = {}): Container {
  const clock = o.clock ?? new FixedClock();
  const ids = new SeqIds();
  const repo = new InMemoryRepo();
  const quotes = o.quotes ?? new FakeQuoteGateway();
  const kyc = o.kyc ?? new FakeKycGateway();
  const wallet = o.wallet ?? new FakeWallet();
  const kycStore = o.kycStore ?? new FakeKycStore();
  const pending = o.pending ?? new FakeKycPendingStore();
  const payouts = o.payouts ?? new FakePayoutGateway();
  const payoutAuthority = o.payoutAuthority ?? new FakePayoutAuthorityGateway();

  const base: Container = {
    previewQuote: new PreviewQuote(quotes),
    createRemittance: new CreateRemittance(repo, clock, ids),
    connectWallet: new ConnectWallet(wallet, kycStore),
    startKyc: new StartKyc(kyc, kycStore, pending, repo, clock),
    resumeKyc: new ResumeKyc(kyc, kycStore, pending, repo, clock),
    lockQuote: new LockQuote(quotes, repo, clock),
    confirmAndSend: new ConfirmAndSend(wallet, payouts, repo, clock, payoutAuthority),
    trackRemittance: new TrackRemittance(payouts, repo, clock),
    listHistory: new ListHistory(repo),
    abandonPendingKyc: new AbandonPendingKyc(pending),
    forgetKyc: new ForgetKyc(kycStore, pending),
  };
  return { ...base, ...(o.useCases ?? {}) };
}
```
> El Dev DEBE confirmar los nombres/orden de args de cada constructor releyendo `container.ts:57-69` (§2.4). NO importar nada con I/O real (CD-11). Única excepción (en el test, no acá): `FallbackQuoteGateway` para T1.

### 4.3 Mock de `framer-motion` — OBLIGATORIO en cada `*.test.tsx` (CD-8, DT-7)
`flow.tsx:368` usa `<AnimatePresence mode="wait">`; jsdom no implementa `requestAnimationFrame`, así que el exit no completa y el nuevo step **nunca monta** → `findBy*` cuelga. Los steps que el backfill necesita (`review`, vuelta a `send`) viven dentro de `AnimatePresence`. Snippet EXACTO (al tope del archivo, tras los imports):
```ts
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: any) =>
          React.createElement(tag, props, children),
    },
  ),
}));
```
`vi.mock` se hoistea por archivo. Solo elimina la animación (presentación), no la lógica.

### 4.4 jest-dom + jsdom per-file (DT-1, DT-4, CD-9, CD-4)
En `flow.test.tsx`:
- Docblock jsdom en la **primera línea** del archivo:
  ```ts
  // @vitest-environment jsdom
  ```
- Import de matchers (registra sobre el `expect` de Vitest, sin globals):
  ```ts
  import "@testing-library/jest-dom/vitest";
  ```
  Fallback documentado (SOLO si ese subpath no existe en la versión instalada):
  ```ts
  import * as jestDom from "@testing-library/jest-dom/matchers";
  import { expect } from "vitest";
  expect.extend(jestDom);
  ```
- `afterEach(cleanup)` (CD-4, no hay setupFiles global):
  ```ts
  import { cleanup } from "@testing-library/react";
  afterEach(() => cleanup());
  ```

### 4.5 Encabezado común de `flow.test.tsx`
```ts
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { FallbackQuoteGateway } from "../infrastructure/fallback/gateways";

vi.mock("framer-motion", () => ({ /* §4.3 */ }));

afterEach(() => cleanup());
```
> `screen`/`fireEvent`/`waitFor`/`findBy*` de RTL. `userEvent` es opcional; `fireEvent` alcanza. Usar `findBy*`/`waitFor` (auto-`act`) para transiciones async — NO `getBy*` inmediato tras un click que dispara un `await`.

---

## 5. Los 5 tests (T1..T5) — lista cerrada (CD-7)

Cada test: `render(<RemittanceFlow container={buildTestContainer(...)} />)`. Recorrido típico send→connect→verify→review: llenar monto (`aria-label "Monto en dólares"`, ya trae `"400"`), recipient (`placeholder "Nombre de tu familiar"`), destino (`placeholder "999 888 777"`), click `Continuar` → click `Conectar wallet` → click `Escanear DNI + selfie`. Con `FakeKycStore` vacío el flujo pasa por `verify`; con `FakeKycGateway` default (redirect=false) `onVerify` resuelve `done`/`kyc_passed` → `lockQuote` → `review`.

### T1 — AC-4 (harness smoke) + banner "Modo demo"
- Container: `buildTestContainer({ quotes: new FallbackQuoteGateway() })` (provenance `local-fallback` → dispara `isDemoMode`).
- Recorre: send → connect → verify → review.
- Asserta:
  - (a) el card de review muestra un monto PEN concreto de `quote.receive` — **nunca** `S/0.00` ni `—`. Ej.: `expect(screen.queryByText("—")` NO en el bloque de review / assertar que aparece un texto que matchea `/S\/\s?\d/`.
  - (b) el `Pill` **`Modo demo — sin dinero real`** está en el documento (`flow.tsx:341-345`): `expect(await screen.findByText(/Modo demo — sin dinero real/)).toBeInTheDocument()`.
  - (c) cero llamada a red (implícito por fakes — no hay `fetch` que mockear, CD-5).

### T2 — AC-9: review nombre + doc enmascarado (CD-12)
- Container: `buildTestContainer()` (defaults; `FakeKycGateway` provee `Test Quispe Mamani` / DNI last4 `5678`).
- Recorre: send → connect → verify → review.
- Asserta:
  - (a) nombre completo visible: `screen.findByText(/Test Quispe Mamani/)`.
  - (b) documento enmascarado visible: `••••5678` y `DNI` (líneas 577). Puede matchearse sobre el texto del bloque de identidad.
  - (c) **CD-12 (corazón del AC)**: el número completo NUNCA en el DOM → `expect(screen.queryByText(/12345678/)).toBeNull();` (o assert sobre `container.textContent` no incluye `"12345678"`).

### T3 — AC-5: botón "Reintentar" + retry sin reload (fake timers, CD-10)
- Container: stub de `resumeKyc` que siempre devuelve `processing`:
  ```ts
  buildTestContainer({
    useCases: {
      resumeKyc: { execute: async () => ({ kind: "processing" as const }) } as unknown as ResumeKyc,
    },
  })
  ```
  (`ResumeKyc` importado de `../application/use-cases/resume-kyc`.)
- Aislar en su propio `describe` con fake timers:
  ```ts
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); cleanup(); });
  ```
  > Necesita `KycPending` presente para que el resume-loop entre. El loop corre al montar (líneas 88-137). Con `resumeKyc` stub siempre `processing`, avanza 40× `sleep(2500)` = 100 s → `timedOut`. Setear un `pending` no es estrictamente necesario porque el stub ignora el store; el loop consume el stub directamente.
- Recorre: mount → `await act(async () => { await vi.advanceTimersByTimeAsync(100000); })` → estado `timedOut`.
- Asserta:
  - (a) `<Button>Reintentar</Button>` visible (`flow.tsx:365`): `screen.getByText("Reintentar")`.
  - (b) spy: `const reloadSpy = vi.fn();` sobre `window.location.reload` ANTES del click. Click `Reintentar` (`fireEvent.click`) → vuelve al step `"send"` (input `aria-label "Monto en dólares"` visible), `Reintentar` desaparece.
  - (c) `expect(reloadSpy).not.toHaveBeenCalled()` — `onRetryKyc` NO recarga (líneas 231-235).
  > Nota timers: tras el click, `resetTo` es síncrono (setState) → `screen.getByLabelText("Monto en dólares")` debería estar disponible; si hace falta flush, envolver en `act`.

### T4 — AC-7: control reset visible solo con address
- Container: `buildTestContainer()`.
- (i) render inicial (`address === null`):
  - (a) `expect(screen.queryByText("¿No sos vos?")).toBeNull();`
- (ii) send → connect (llenar form, `Continuar`, `Conectar wallet` → `FakeWallet.connect()` = `"0xSender"`, `FakeKycStore` vacío → step `verify`, address seteada):
  - (b) `expect(await screen.findByText("¿No sos vos?")).toBeInTheDocument();`
  - (b2) badge de address visible: `screen.getByText(/0xSend…nder/)` (o matchear `/0xSend/`).

### T5 — AC-6 + AC-8: reset limpia estado React + PII
- Container: `buildTestContainer()`.
- Recorre: en `send`, escribir recipient=`"Mamá"` (`placeholder "Nombre de tu familiar"`), destino=`"999888777"` (`placeholder "999 888 777"`); `Continuar` → `Conectar wallet` (address `"0xSender"`) → click `¿No sos vos?` → click `Empezar de nuevo` (`forgetAndDisconnect`, líneas 239-257).
- Asserta:
  - (a) vuelve a step `"send"` (input monto visible de nuevo).
  - (b) badge de address desaparece: `expect(screen.queryByText(/0xSend/)).toBeNull();` (address === null → control reset tampoco visible).
  - (c) input recipient (`placeholder "Nombre de tu familiar"`) con `value === ""` (`setRecipient("")`, línea 251).
  - (d) input destino con `value === ""` (`setDestination("")`, línea 252).
  - (e) input monto con `value === "400"` (default restaurado, `setAmount("400")`, línea 254).

---

## 6. Trazabilidad ACs → tests

| AC WKH-185 | Cubierto por | Backfillea F4 previo |
|---|---|---|
| AC-1 (suite 0 fallos, piso 167) | gate `npx vitest run` (§8) | — |
| AC-2 (jsdom per-file no altera node) | docblock `// @vitest-environment jsdom` + gate | — |
| AC-3 (sin prop = prod idéntico) | seam DT-2 + `app/page.tsx:4` sin cambios | — |
| AC-4 (render + recorre con fakes) | **T1** | — |
| AC-5 (Reintentar + retry sin reload) | **T3** | WKH-178 AC-8/AC-9 |
| AC-6 (reset limpia estado React) | **T5** | WKH-184 AC-4 |
| AC-7 (control visible solo con address) | **T4** | WKH-184 AC-6 |
| AC-8 (reset limpia PII beneficiario) | **T5** | WKH-184 MNR-1 |
| AC-9 (review nombre + doc enmascarado) | **T2** | WKH-181 AC-3/AC-13 |
| AC-10 (`cleanup()` por test) | `afterEach(cleanup)` (CD-4) | — |

---

## 7. Waves

### W0 — Harness (SERIAL, contratos primero)
1. `package.json`: +4 devDeps (§2.1) → `npm install` (regenera lock).
2. `flow.tsx`: seam DI (§4.1) — solo líneas 16 + 46-47.
3. `src/test-support/test-container.ts` (NUEVO): `buildTestContainer` (§4.2).
4. **Gate W0**: `npx tsc --noEmit` = 0 errores · `npx vitest run` = `PASS (167)` intacto (los `.test.tsx` aún no existen) · `npm run build` OK. Confirma que el seam no rompió prod ni los tests node.

### W1 — Tests de componente (`src/presentation/flow.test.tsx`, NUEVO)
Un solo archivo. Encabezado común §4.5 (docblock jsdom + `vi.mock("framer-motion")` + `import "@testing-library/jest-dom/vitest"` + `afterEach(cleanup)`).
- **W1a** (timers reales, `findBy*`/`waitFor`): T1, T2, T4, T5.
- **W1b** (fake timers, `describe` aislado con `useFakeTimers`/`useRealTimers`, CD-10): T3.

Los 5 tests son independientes (cada uno arma su container y limpia con `cleanup`); el orden dentro del archivo no importa; T3 debe aislar sus fake timers.

---

## 8. Anti-Hallucination Checklist (marcar antes de dar F3 por cerrado)

- [ ] `package.json` tiene EXACTAMENTE las 4 devDeps con las versiones de §2.1; `dependencies` sin cambios.
- [ ] `flow.tsx` cambió SOLO en la línea 16 (import de tipo) y 46-47 (prop + memo). `git diff flow.tsx` no muestra ninguna otra línea (CD-2).
- [ ] `app/page.tsx` sin cambios (AC-3).
- [ ] NO se creó `vitest.config.ts` (CD-3). NO se agregó `setupFiles` global (CD-9).
- [ ] `buildTestContainer` usa SOLO dobles de `fakes.ts` + (en test) `FallbackQuoteGateway`; cero I/O real (CD-5, CD-11).
- [ ] Cada `*.test.tsx` tiene: docblock `// @vitest-environment jsdom` (1ª línea), `vi.mock("framer-motion")` pass-through (CD-8), `import "@testing-library/jest-dom/vitest"` (CD-9), `afterEach(cleanup)` (CD-4).
- [ ] T3 usa fake timers aislados (`useFakeTimers`/`useRealTimers` en su `describe`, `advanceTimersByTimeAsync` dentro de `act`) y NO contamina otros tests (CD-10).
- [ ] T2 asserta negativamente `queryByText(/12345678/) === null` (CD-12).
- [ ] Solo existen 5 tests (T1..T5); ningún AC fuera de AC-4..AC-10 (CD-7).
- [ ] Ninguna referencia a archivo/función/línea sin verificar contra §2.

---

## 9. Regresión (obligatorio verificar)

- Los **15 archivos `*.test.ts`** existentes (167 tests) NO cambian de environment: siguen bajo el default `node` (el docblock jsdom es solo del `.test.tsx` nuevo). Piso CD-6 = **167**, no puede bajar.
- El prop `container` default (`undefined`) preserva prod byte-a-byte: `app/page.tsx` no pasa props → `createContainer()` una sola vez, `[undefined]` estable.
- `npm run build` (`next build --webpack`) en el gate W0 y en el gate final detecta cualquier ruptura del bundle de prod por las devDeps o el seam.

---

## 10. Done Definition

- [ ] W0 completo: deps instaladas, seam en `flow.tsx`, `buildTestContainer` creado.
- [ ] W1 completo: `flow.test.tsx` con T1..T5, todos verdes bajo jsdom.
- [ ] `npx tsc --noEmit` = **0 errores**.
- [ ] `npx vitest run` = **0 fallos**, con **≥167 tests node** (bajo `node`) + **5 tests nuevos** (`flow.test.tsx` bajo `jsdom`) verdes. El conteo node no baja de 167 (CD-6).
- [ ] `npm run build` (`next build --webpack`) OK.
- [ ] Anti-Hallucination Checklist (§8) completo.
- [ ] Sin cambios fuera de Scope IN (§3). CD-1..CD-12 respetadas.
