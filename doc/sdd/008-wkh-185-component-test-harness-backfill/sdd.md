# SDD — WKH-185 · Component test harness (jsdom + RTL) + backfill de ACs de UI

**Repo**: `chaski-v2/` · **SDD_MODE**: full · **Fase**: F2 · **Fecha**: 2026-07-11
**Input**: `doc/sdd/008-wkh-185-component-test-harness-backfill/work-item.md` (HU_APPROVED)
**Naturaleza**: deuda técnica **test-only**. Único cambio de producción = seam DI en `flow.tsx` (prop `container?` opcional, comportamiento por defecto preservado byte-a-byte).

---

## 1. Context Map (archivos leídos — grounding con archivo:línea)

| Archivo | Líneas clave | Qué extraje / por qué importa |
|---|---|---|
| `package.json` | `devDependencies` L33-42 (solo `vitest@^2.1.1`); scripts L13-15 (`"test":"vitest run"`, `"qa"`); `dependencies` L26-27 (`react`/`react-dom` **19.0.0**) | No hay `jsdom` ni RTL ni jest-dom. React 19 → RTL debe ser v16+. No hay `vitest.config.*` (confirmado: `ls vitest.config.*` sin match). |
| `src/presentation/flow.tsx` | L46-47 (`export function RemittanceFlow()` + `const c = useMemo(() => createContainer(), [])`); L88-137 (resume-loop: 40× `await sleep(2500)`, L129 `abandonPendingKyc`, L130 `setTimedOut(true)`); L231-235 (`onRetryKyc` → `resetTo`, sin reload); L239-257 (`forgetAndDisconnect`: L246-254 limpia PII `setRecipient("")`/`setDestination("")`/`setAmount("400")`); L295-327 (control reset dentro de `{address ? ... : null}`, "¿No sos vos?"/"Empezar de nuevo"); L333-339 (banner FallbackWallet); L341-345 (banner "Modo demo" en review/track); L357-366 (Card `timedOut` + `<Button onClick={onRetryKyc}>Reintentar</Button>`); L568-580 (review: nombre `firstName/lastNamePaternal/lastNameMaternal` + `••••{documentNumberLast4}`); L661-690 (`Receipt`: `deliveredDisplay` → nunca "S/0.00") | **Único punto de inyección posible** = el `useMemo(createContainer())` de L47. Sin prop, `flow.tsx` cablea infra real (imposible testear con fakes). Todos los ACs a backfillear se renderizan desde acá. |
| `app/page.tsx` | L4 `<RemittanceFlow />` (sin props) | Único caller en prod. Un prop opcional es 100% backward-compatible (no pasa props → default). |
| `src/composition/container.ts` | L29-41 (`interface Container` = 11 use-cases); L43-70 (`createContainer()` cablea `DiditKycGateway`, `HttpPayoutAuthorityGateway`, `pickWallet()`, `Fallback*Gateway`) | El tipo `Container` es el contrato a inyectar. `createContainer()` = default de prod. `FallbackQuoteGateway` es infra **pura sin red** (útil para el test del banner demo, ver DT-6). |
| `src/test-support/fakes.ts` | L89-105 `FakeQuoteGateway` (provenance `"fake"`); L107-140 `FakeKycGateway` (default `redirect=false` → `{kind:"completed"}` con `identity` `Test Quispe Mamani` / DNI `documentNumberLast4="5678"` desde `"12345678"`); L142-153 `FakeKycPendingStore`; L185-210 `FakePayoutGateway`; L212-222 `FakeWallet` (`connect()→"0xSender"`); L224-235 `FakeKycStore`; L254-261 `FakePayoutAuthorityGateway` (default `authorized:true`); L36-63 `FixedClock`/`SeqIds`; L263-268 `beneficiary()` | Dobles completos de los 11 ports. Ensamblables 1:1 en un `Container` fake. **Base para `buildTestContainer` (DT-3)**. `FakeKycGateway` default resuelve completed → habilita llegar a `review` con identidad sin redirect. |
| `src/application/ports.ts` | L21-23 `QuoteGateway`; L44-47 `KycGateway`; L56-60 `KycPendingStore`; L97-101 `WalletPort`; L104-108 `KycStore`; L91-94 `PayoutAuthorityGateway`; L119-124 `Clock`/`IdGenerator` | Firmas de los ports para tipar los overrides de `buildTestContainer`. |
| `src/application/use-cases/start-kyc.ts` | L10-12 (`StartKycResult` = `done`\|`redirect`); L36-56 (KYC-once: si `kycStore.get` vacío → `kyc.start` → `completed` → `done`) | Con `FakeKycStore` vacío + `FakeKycGateway` (redirect=false), `onVerify` resuelve `done` con `kyc_passed` → `lockQuote` → `review`. Ruta que el test de AC-9 recorre. |
| `src/application/use-cases/connect-wallet.ts` | L14-18 (`connect()` + `store.get` → `rememberedKyc`) | Con `FakeKycStore` vacío → `rememberedKyc:null` → `onConnect` lleva a `verify` (no saltea). |
| `src/domain/remittance.ts` | L42-48 `PersistedIdentity` (`documentNumberLast4`, "nunca el número completo"); L52-61 `toPersistedIdentity` (`dn.slice(-4)`); L63-70 `KycVerification` (`identity: PersistedIdentity\|null`); L121-131 `RemittanceState` | La identidad ya viaja **reducida** (last-4). El test de AC-9 asserta que el número completo `"12345678"` NUNCA aparece en el DOM (solo `"5678"`). |
| `src/presentation/flow-vm.ts` | L6-8 `isDemoMode` (⇔ `provenance === "local-fallback"`); L17-19 `deliveredDisplay` (`?? null` → UI "—") | El banner "Modo demo" **solo** aparece con provenance `"local-fallback"`. Los fakes usan `"fake"` → NO dispara el banner. Para testear el banner hay que inyectar `FallbackQuoteGateway` (provenance real `"local-fallback"`) — ver DT-6. |
| `src/presentation/flow-vm.test.ts` | L1 (`import { describe, expect, it } from "vitest"` — **globals NO habilitados**); estilo de tests existente | Convención del repo: import explícito de vitest (no globals). El setup de jest-dom debe funcionar sin globals (ver DT-4). |
| `doc/sdd/001-wkh-178-demo-safe-fixes/f4-report.md` | L33 (AC-8 Reintentar "inspección de código, sin harness"); L34 (AC-9 idem) | Fuente del backfill de AC-5 (WKH-185). |
| `doc/sdd/004-wkh-181-pii-persistence-history-per-wallet/f4-report.md` | L28 (AC-3 "Read"), L38 (AC-13 `••••{documentNumberLast4}`, "Read + tsc") | Fuente del backfill de AC-9 (WKH-185). |
| `doc/sdd/007-wkh-184-fallback-wallet-reset-demo-signal/f4-report.md` | L59 (AC-4 reset "code review, sin RTL"); L61 (AC-6 control visibility "code review, sin RTL"); L75-76 (fix-pack MNR-1 PII "no hay test, es estado de UI") | Fuente del backfill de AC-6/AC-7/AC-8 (WKH-185). |

**Baseline verificado (F2)**: `npx vitest run` → **`PASS (167) FAIL (0)`** en **15 archivos** `*.test.ts` bajo el default `environment: node`. Este 167 es el **piso de CD-6**.

**Auto-blindaje histórico**: no existe ningún `auto-blindaje.md`/`retro.md` en `doc/sdd/` (verificado con `find`). Sin patrones de error previos que heredar. Paso salteado (no bloqueante).

---

## 2. Decisiones técnicas (DT-N)

- **DT-1 · Environment jsdom per-file** (hereda del work-item). Docblock `// @vitest-environment jsdom` en la 1ª línea de cada `*.test.tsx` nuevo. Sin `vitest.config.ts`. Los 15 archivos `*.test.ts` existentes siguen bajo el default `node`, sin tocarse. Vitest lo soporta nativamente.

- **DT-2 · Seam DI en `flow.tsx`** (único cambio de producción). Firma:
  ```tsx
  export function RemittanceFlow({ container }: { container?: Container } = {}) {
    const c = useMemo(() => container ?? createContainer(), [container]);
  ```
  - En prod (`app/page.tsx` no pasa props) → `container` es `undefined` → `createContainer()` corre una vez, dep `[undefined]` estable → **comportamiento byte-a-byte idéntico** al `useMemo(() => createContainer(), [])` actual.
  - Ripple type-only aceptado: la línea de import `import { createContainer } from "../composition/container";` (L16) pasa a `import { createContainer, type Container } from "../composition/container";`. Es un import **de tipo** (borrado en build, cero runtime). Se documenta explícitamente para que AR/CR no lo lea como violación de CD-2 (el espíritu de CD-2 = "ninguna línea de *comportamiento* cambia"; un import de tipo no altera runtime).
  - **Ninguna otra línea de `flow.tsx` se modifica.**

- **DT-3 · `buildTestContainer(overrides?)` en `src/test-support/`** (cierra Missing Input #1 — decisión del orquestador: SÍ). Nuevo archivo `src/test-support/test-container.ts`. Ensambla los 11 ports fake de `fakes.ts` en un `Container`, compartiendo `repo`/`clock` entre los use-cases que los necesitan, y permite **overridear a nivel gateway** (para el banner demo) **y a nivel use-case** (para el stub `resumeKyc→processing`). API:
  ```ts
  export interface TestContainerOverrides {
    quotes?: QuoteGateway;              // default: new FakeQuoteGateway()
    kyc?: KycGateway;                   // default: new FakeKycGateway()
    wallet?: WalletPort;                // default: new FakeWallet()
    kycStore?: KycStore;                // default: new FakeKycStore()
    pending?: KycPendingStore;          // default: new FakeKycPendingStore()
    payouts?: PayoutGateway;            // default: new FakePayoutGateway()
    payoutAuthority?: PayoutAuthorityGateway; // default: new FakePayoutAuthorityGateway()
    clock?: Clock;                      // default: new FixedClock()
    // escape hatch: reemplaza use-cases ya construidos (ej. resumeKyc stub)
    useCases?: Partial<Container>;
  }
  export function buildTestContainer(o: TestContainerOverrides = {}): Container
  ```
  Internamente: crea `repo = new InMemoryRepo()`, `ids = new SeqIds()`, resuelve gateways (default ← override), construye los 11 use-cases (mismo patrón que `createContainer`, `container.ts:57-69`, pero con dobles), y retorna `{ ...base, ...(o.useCases ?? {}) }`. Vive en `test-support/` (carpeta test-only) → cero impacto de producción. Evita repetir el wiring en cada test.

- **DT-4 · jest-dom sin setup global** (cierra Missing Input #2 — decisión del orquestador: SÍ incluirlo, menor fricción). Estrategia **per-file**: primera línea de imports de cada `*.test.tsx`:
  ```ts
  import "@testing-library/jest-dom/vitest";
  ```
  El subpath `/vitest` de `@testing-library/jest-dom@^6` registra los matchers **contra el `expect` de Vitest** (hace `import { expect } from "vitest"; expect.extend(...)` internamente) **y** aplica la augmentation de tipos — **funciona sin `globals:true` y sin `setupFiles`**, consistente con el estilo import-explícito del repo (DT observado en `flow-vm.test.ts:1`). Es la opción de **menor fricción** (no crea `vitest.config.ts`, respeta CD-3). **Fallback documentado** (si la versión instalada no expone `/vitest`): `import * as jestDom from "@testing-library/jest-dom/matchers"; expect.extend(jestDom);` per-file. El Dev elige el primario; solo cae al fallback si el import falla.

- **DT-5 · Fake timers SOLO en el test de AC-5** (hereda del work-item DT-4). El resume-loop real = 40× `sleep(2500)` = 100 s (`flow.tsx:88-133`). El test de AC-5 usa `vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(100000)` (envuelto en `act()`), con `resumeKyc` stubbeado a `{kind:"processing"}` (vía `useCases` override de DT-3). **Todos los demás tests usan timers reales** + `findBy*`/`waitFor` (los `sleep(400)`/debounce 300 ms son cortos, entran en el timeout default de RTL de 1000 ms).

- **DT-6 · Banner "Modo demo" vía `FallbackQuoteGateway` real**. `isDemoMode` (`flow-vm.ts:7`) exige `provenance === "local-fallback"`; los fakes usan `"fake"`. Para el test que valida el banner (AC-4 harness smoke), se inyecta `quotes: new FallbackQuoteGateway()` (`src/infrastructure/fallback/gateways.ts` — infra **pura, sin red**, provenance `"local-fallback"`, `receive` consistente con el money-path). Así `rem.quote.provenance === "local-fallback"` → el banner "Modo demo — sin dinero real" aparece en `review`. **No re-abre** los unit-tests de `isDemoMode` de WKH-178 (siguen intactos en `flow-vm.test.ts`); es la validación de *render* del banner desde el harness (AC-4), no un re-test de la lógica pura.

- **DT-7 · Mock de `framer-motion` en cada `*.test.tsx`** (crítico para determinismo). `flow.tsx:368` usa `<AnimatePresence mode="wait">`: al cambiar de `step`, el `motion.div` saliente **anima su exit antes** de montar el nuevo. jsdom **no implementa `requestAnimationFrame`** → el exit puede no completarse → el nuevo step **nunca monta** → `findBy*` cuelga/timeoutea. Los steps que el backfill necesita (`review` para AC-9, vuelta a `send` para AC-6) viven **dentro** de `AnimatePresence`. Mitigación obligatoria: stub pass-through al tope de cada `*.test.tsx`:
  ```ts
  vi.mock("framer-motion", () => ({
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: new Proxy({}, { get: (_t, tag: string) =>
      ({ children, ...props }: any) => React.createElement(tag, props, children) }),
  }));
  ```
  Solo elimina la animación (presentación), no la lógica. `vi.mock` se hoistea por-archivo.

---

## 3. Constraint Directives (CD-N)

**Heredadas del work-item (obligatorias, sin cambio):**
- **CD-1**: PROHIBIDO tocar código fuera de `chaski-v2/`.
- **CD-2**: HU test-only. Único archivo de producción modificable = `src/presentation/flow.tsx`, y el único cambio de *runtime* permitido es el prop `container` (DT-2). Ripple type-only del import de `Container` aceptado y documentado (DT-2).
- **CD-3**: PROHIBIDO crear/editar `vitest.config.ts` para cambiar el `environment` global a jsdom. Estrategia obligatoria = docblock per-file (DT-1).
- **CD-4**: OBLIGATORIO `cleanup()` de `@testing-library/react` en un `afterEach` en cada `*.test.tsx` (no hay `setupFiles` global que lo automatice).
- **CD-5**: PROHIBIDO red real / mocks de `fetch` a Didit/Upstash / RPC de blockchain. SIEMPRE inyectar el `Container` fake vía `buildTestContainer`.
- **CD-6**: `npx vitest run` final = 0 fallos y el conteo de tests node preexistentes **no baja de 167** (piso verificado en F2).
- **CD-7**: PROHIBIDO expandir el backfill fuera de la lista cerrada (AC-5..AC-9 del work-item, ver §5) sin volver a F1.

**Nuevas (específicas del SDD):**
- **CD-8**: OBLIGATORIO mockear `framer-motion` (pass-through) en cada `*.test.tsx` (DT-7). Sin esto, los tests que cruzan `step` (`review`, vuelta a `send`) cuelgan bajo jsdom.
- **CD-9**: jest-dom se registra per-file vía `import "@testing-library/jest-dom/vitest"` (DT-4). PROHIBIDO agregarlo vía `setupFiles` en un config global.
- **CD-10**: `vi.useFakeTimers()` SOLO en el test de AC-5 (retry). Debe llamarse `vi.useRealTimers()` en su `afterEach` para no contaminar otros tests del archivo. Envolver `advanceTimersByTimeAsync` en `act()`.
- **CD-11**: `buildTestContainer` NO importa infra con I/O real. Única excepción permitida = `FallbackQuoteGateway` (pura, sin red, DT-6). Todo lo demás = dobles de `fakes.ts`.
- **CD-12**: el test de AC-9 DEBE assertar negativamente que el número de documento completo (`"12345678"`) **no** aparece en el DOM (`expect(screen.queryByText(/12345678/)).toBeNull()` o sobre `container.textContent`) — es el corazón del AC de PII enmascarada.

---

## 4. Diseño

### 4.1 Seam DI (`flow.tsx`) — DT-2
Ver DT-2. Cambio quirúrgico: firma de `RemittanceFlow` + `useMemo` + import de tipo. Nada más.

### 4.2 `buildTestContainer` (`src/test-support/test-container.ts`) — DT-3
Nuevo archivo. Ensamblador de `Container` fake con overrides gateway-level + use-case-level. Ver DT-3 para la API exacta. Comparte `repo`/`clock` entre use-cases (para que `createRemittance`→`startKyc`→`lockQuote` operen sobre el mismo estado).

### 4.3 jest-dom — DT-4
Per-file `import "@testing-library/jest-dom/vitest"`.

### 4.4 Lista cerrada de tests de componente (`src/presentation/flow.test.tsx`)

> Cada test: renderiza `<RemittanceFlow container={buildTestContainer(...)} />`. Todos comparten al tope del archivo: docblock jsdom (DT-1), `vi.mock("framer-motion", ...)` (DT-7), `import "@testing-library/jest-dom/vitest"` (DT-4), `afterEach(cleanup)` (CD-4).

| # | AC (WKH-185) | Backfillea | Container | Recorre | Asserta |
|---|---|---|---|---|---|
| T1 | **AC-4** (harness smoke) + banner demo | WKH-178 UX (via AC-4, no re-abre flow-vm) | `buildTestContainer({ quotes: new FallbackQuoteGateway() })` | send→connect→verify→review (llena monto/recipient/destination, click "Continuar", "Conectar wallet", "Escanear DNI + selfie") | (a) el card de review muestra un monto PEN concreto de `quote.receive` — **nunca** `"S/0.00"` ni `"—"`; (b) el `Pill` **"Modo demo — sin dinero real"** está en el documento (`flow.tsx:341-345`); (c) cero llamada a red (implícito por fakes) |
| T2 | **AC-9** review nombre + doc enmascarado | WKH-181 AC-3/AC-13 | `buildTestContainer()` (defaults; `FakeKycGateway` provee `Test Quispe Mamani` / DNI last4 `"5678"`) | send→connect→verify→review | (a) el nombre completo `Test Quispe Mamani` está visible; (b) `••••5678` / `documentType "DNI"` visible; (c) **CD-12**: `"12345678"` NO aparece en el DOM |
| T3 | **AC-5** botón "Reintentar" + retry sin reload | WKH-178 AC-8/AC-9 | `buildTestContainer({ useCases: { resumeKyc: { execute: async () => ({ kind: "processing" }) } as unknown as ResumeKyc } })` | mount → resume-loop agota 40 intentos (fake timers, `advanceTimersByTimeAsync(100000)` en `act`) → `timedOut` | (a) `<Button>Reintentar</Button>` visible en la Card de timeout (`flow.tsx:357-366`); (b) al hacer click (`fireEvent.click`) → vuelve al step `"send"` (form de monto visible), Reintentar desaparece; (c) `window.location.reload` NUNCA invocado (spy sobre él → `not.toHaveBeenCalled`) |
| T4 | **AC-7** control reset solo con address | WKH-184 AC-6 | `buildTestContainer()` | (i) render inicial (address null); (ii) send→connect (click "Conectar wallet" → address `"0xSender"`, `FakeKycStore` vacío → step `verify`) | (a) con address null: `queryByText("¿No sos vos?")` === `null`; (b) tras conectar: `"¿No sos vos?"` visible + badge de address (`0xSend…nder`) |
| T5 | **AC-6 + AC-8** reset limpia estado React + PII | WKH-184 AC-4 + fix-pack MNR-1 | `buildTestContainer()` | send (escribe recipient="Mamá", destination="999888777") → connect → click "¿No sos vos?" → click "Empezar de nuevo" (`forgetAndDisconnect`) | (a) vuelve a step `"send"`; (b) badge de address desaparece (`address===null`); (c) input recipient (placeholder "Nombre de tu familiar") con value `""`; (d) input destination con value `""`; (e) input monto con value `"400"` (default, `flow.tsx:254`) |

**Nota de scope (CD-7)**: T1 se ancla a **AC-4 de WKH-185** (el harness renderiza el flujo completo con fakes) — NO re-abre los unit-tests de `isDemoMode`/`deliveredDisplay` de WKH-178, que siguen intactos en `flow-vm.test.ts`. El banner + monto-no-cero son asserts de *render* del harness, dentro de la lista cerrada. No se agrega ningún AC fuera de AC-4..AC-9 + AC-10 (cleanup).

---

## 5. Mapa de trazabilidad (ACs WKH-185 → tests)

| AC WKH-185 | Cubierto por | Backfillea F4 previo |
|---|---|---|
| AC-1 (suite completa 0 fallos, piso 167) | gate `npx vitest run` (Readiness) | — |
| AC-2 (jsdom per-file no altera node) | docblock DT-1 + gate (los 15 `.test.ts` siguen node) | — |
| AC-3 (sin prop = prod idéntico) | DT-2 + `app/page.tsx` sin cambios | — |
| AC-4 (render + recorre con fakes) | T1 (y habilita T2-T5) | — |
| AC-5 (Reintentar + retry sin reload) | T3 | WKH-178 AC-8/AC-9 (`001-.../f4-report.md:33-34`) |
| AC-6 (reset limpia estado React) | T5 | WKH-184 AC-4 (`007-.../f4-report.md:59`) |
| AC-7 (control visible solo con address) | T4 | WKH-184 AC-6 (`007-.../f4-report.md:61`) |
| AC-8 (reset limpia PII beneficiario) | T5 | WKH-184 MNR-1 (`007-.../f4-report.md:75-76`) |
| AC-9 (review nombre + doc enmascarado) | T2 | WKH-181 AC-3/AC-13 (`004-.../f4-report.md:28,38`) |
| AC-10 (`cleanup()` por test) | `afterEach(cleanup)` en cada archivo (CD-4) | — |

---

## 6. Waves de implementación

### W0 — Harness (SERIAL, contratos primero)
1. **`package.json`** — agregar a `devDependencies` (versiones mínimas recomendadas, el Dev corre `npm install` que resuelve/regenera `package-lock.json`):
   - `jsdom` (`^25.0.0` — entorno DOM)
   - `@testing-library/react` (`^16.1.0` — compatible React 19)
   - `@testing-library/user-event` (`^14.5.0`)
   - `@testing-library/jest-dom` (`^6.6.0`)
   - Sin cambios en `dependencies`. `npm install` regenera el lockfile (consecuencia mecánica).
2. **`src/presentation/flow.tsx`** — seam DI (DT-2): prop `container?` + `useMemo(() => container ?? createContainer(), [container])` + import de tipo `Container`. **Nada más.**
3. **`src/test-support/test-container.ts`** (NUEVO) — `buildTestContainer(overrides?)` (DT-3).
4. **Gate W0**: `npx tsc --noEmit` = 0 errores · `npx vitest run` = `PASS (167)` intacto (los `.test.tsx` aún no existen o vacíos) · `npm run build` OK. Confirma que el seam no rompió prod ni los tests node.

### W1 — Tests de componente (`src/presentation/flow.test.tsx`, NUEVO)
Un solo archivo (Scope IN). Encabezado común: docblock jsdom (DT-1) + `vi.mock("framer-motion")` (DT-7, CD-8) + `import "@testing-library/jest-dom/vitest"` (DT-4) + `afterEach(cleanup)` (CD-4). Se escribe test por test:
- **W1a** (timers reales): T1 (AC-4 + demo banner), T2 (AC-9), T4 (AC-7), T5 (AC-6+AC-8).
- **W1b** (fake timers, aislado con `useFakeTimers`/`useRealTimers` en su propio `describe` + `afterEach`, CD-10): T3 (AC-5).

Los 5 tests son independientes entre sí (cada uno arma su propio container y limpia con `cleanup`) → dentro del archivo el orden no importa; T3 debe aislar sus fake timers.

### Gate final (Readiness, ver §8)
`tsc --noEmit` + `npx vitest run` (≥167 node + 5 nuevos tsx, 0 fallos) + `npm run build`.

---

## 7. Exemplars verificados (paths confirmados con Read)

| Patrón | Exemplar (path real) |
|---|---|
| Wiring de un `Container` (orden de construcción de los 11 use-cases) | `src/composition/container.ts:43-70` |
| Dobles de los 11 ports + `beneficiary()` helper | `src/test-support/fakes.ts:36-268` |
| Estilo de test del repo (import explícito de vitest, `describe`/`it`/`expect`, naming `"AC-N: ..."`) | `src/presentation/flow-vm.test.ts:1-107` |
| Tipos de los ports para tipar overrides | `src/application/ports.ts:21-124` |
| Estructura del render a testear (steps, controles, textos exactos) | `src/presentation/flow.tsx` (líneas en §1) |
| `FallbackQuoteGateway` (provenance `local-fallback`, para T1) | `src/infrastructure/fallback/gateways.ts` (confirmado importable desde `container.ts:17-21`) |

---

## 8. Readiness Check (F2 — listo para SPEC_APPROVED)

- [x] Work-item leído completo (ACs, 7 CDs, DT-1..5, lista cerrada).
- [x] `project-context.md`/`CLAUDE.md`: stack Next 16 + React 19 + Vitest confirmado. Sin drift.
- [x] Baseline verificado ejecutando `npx vitest run` → **167 tests, 0 fallos, 15 archivos** (piso CD-6).
- [x] Seam DI diseñado con comportamiento de prod preservado byte-a-byte (DT-2, único caller `app/page.tsx:4` no pasa props).
- [x] Missing Input #1 (buildTestContainer) → **resuelto: SÍ** (DT-3, API definida).
- [x] Missing Input #2 (jest-dom) → **resuelto: SÍ, per-file `/vitest`, sin config global** (DT-4, con fallback).
- [x] Estrategia jsdom per-file + `cleanup` afterEach (DT-1, CD-4).
- [x] Riesgo framer-motion identificado y mitigado (DT-7/CD-8) — **bloqueante técnico resuelto en diseño**.
- [x] Riesgo fake-timers aislado (DT-5/CD-10).
- [x] Los 5 tests mapean 1:1 a la lista cerrada AC-5..AC-9 (§5). Sin scope creep (CD-7).
- [x] Exemplars verificados con Read (paths reales, §7).
- [x] Regresión cubierta: los 15 `.test.ts` node no cambian de environment; prop default preserva prod; `npm run build` en el gate.
- [x] Cero `[NEEDS CLARIFICATION]`.

**Estado: LISTO PARA SPEC_APPROVED.**

---

## 9. Regresión / riesgos

| Riesgo | Mitigación |
|---|---|
| `AnimatePresence mode="wait"` bloquea el mount del nuevo step bajo jsdom (sin rAF) | **CD-8/DT-7**: mock pass-through de framer-motion en cada `*.test.tsx`. Bloqueante resuelto en diseño. |
| jest-dom rompe el estilo import-explícito (globals off) | **DT-4**: `/vitest` registra sobre el `expect` de Vitest sin globals. Fallback `expect.extend(matchers)` documentado. |
| Fake timers de T3 contaminan otros tests | **CD-10**: `useFakeTimers`/`useRealTimers` acotados al `describe` de T3 + `afterEach`. |
| El seam `[container]` cambia el memo en prod | En prod `container===undefined` siempre → `[undefined]` estable → `createContainer()` una sola vez, idéntico al `[]` actual. |
| RTL v16 vs React 19 incompat | RTL 16.x soporta oficialmente React 19; `react`/`react-dom` 19.0.0 ya en deps. `npm install` valida peer deps en W0. |
| `npm install` regenera lockfile con cambios inesperados | Solo se agregan 4 devDeps; `npm run build` en el gate W0 detecta cualquier ruptura. |
| Act warnings de React 19 en transiciones async | Usar `findBy*`/`waitFor` (auto-`act`) y envolver `advanceTimersByTimeAsync` en `act()` (T3). No bloquean, pero se prescribe el patrón. |
