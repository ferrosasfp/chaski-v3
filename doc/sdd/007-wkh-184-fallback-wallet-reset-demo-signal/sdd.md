# SDD — [WKH-184] Reset explícito de KYC-once + señal soft de FallbackWallet (Opción D)

**Modo:** QUALITY · **SDD_MODE:** mini · **Estimación:** S
**Branch:** `feat/184-fallback-wallet-reset-demo-signal` (desde `main`)
**Input:** `work-item.md` (9 ACs, 5 CDs, DT-1..4) · gate HU_APPROVED otorgado
**Decisiones del orquestador incorporadas:** DT-3 = click directo + confirmación inline ligera (no modal); DT-4 = función separada `forgetAndDisconnect()` (no flag en `resetTo`).

---

## 1. Context Map (grounding con archivo:línea real, verificado 2026-07-11 sobre `main` post WKH-178..183)

| Archivo:línea | Qué contiene HOY | Qué extraje / rol en esta HU |
|---|---|---|
| `src/application/ports.ts:104-107` | `KycStore` = solo `get(address)` / `save(address, kyc)`. Sin método de borrado. | Punto de extensión: agregar `clear(address: string): Promise<void>`. |
| `src/infrastructure/kyc-store.ts:65-107` | `LocalKycStore`: `rawObject()` (68-76), `read()` saneado (81-88), `get()` lowercasea (91), `save()` lowercasea + `if(!s) mem` best-effort (97-106). `ls()` try/catch (57-63). Key `chaski.kyc.v1` (6). | Patrón exacto para `clear`: `read()` el mapa, `delete all[address.toLowerCase()]`, reescribir vía `ls()` con setItem envuelto (best-effort, mismo estilo que `save`/`ls`). |
| `src/application/use-cases/start-kyc.ts:36-41` | KYC-once: `const remembered = await this.kycStore.get(input.address); if (remembered && remembered.approved && remembered.payoutAllowed) { r.applyKyc(...); return {kind:"done"} }`. | CONFIRMADO: si `get()` → `null` tras el clear, esta rama NO se toma → cae al `this.kyc.start(...)` (re-verificación completa). Un `clear(address)` es SUFICIENTE; `start-kyc.ts` NO se toca. |
| `src/application/use-cases/abandon-pending-kyc.ts:1-11` | `AbandonPendingKyc`: constructor `(pending: KycPendingStore)`, `execute()` = `await this.pending.clear()`. | Exemplar de forma del use-case nuevo. Se conserva intacto (lo usa el timeout path en `flow.tsx:128`). |
| `src/application/ports.ts:56-60` | `KycPendingStore` YA tiene `clear(): Promise<void>` (global, un pending a la vez). | Reutilizable directo para AC-3 desde el use-case nuevo. |
| `src/composition/container.ts:28-39,55-66` | Interfaz `Container` expone `abandonPendingKyc` (38). `createContainer()` instancia `kycStore = new LocalKycStore()` (45), `kycPending = new LocalKycPendingStore()` (46), retorna `abandonPendingKyc: new AbandonPendingKyc(kycPending)` (65). | Patrón de wiring a clonar para `forgetKyc`. `kycStore` + `kycPending` ya instanciados y disponibles. |
| `src/infrastructure/wallet.ts:58-71` | `FallbackWallet.connect()` retorna string literal inline `"0xDEMO00000000000000000000000000000A11ce"` (62). | Extraer a `export const FALLBACK_WALLET_ADDRESS`; `connect()` retorna la constante (única fuente de verdad, CD-4/AC-9). |
| `src/infrastructure/wallet.ts:154-159` | `pickWallet()`: `InjectedWallet` si `injectedProvider()`; `WalletConnectWallet` si `window && NEXT_PUBLIC_REOWN_PROJECT_ID`; si no → `FallbackWallet`. | Condición exacta de AC-8. NO se toca (CD-2: no hard-require). |
| `src/presentation/flow-vm.ts:4-7` | `isDemoMode(rem)` puro, deriva de `rem.quote/kyc.provenance`. No conoce wallets. | Exemplar de helper puro sin I/O. `isFallbackWalletAddress(address)` va aparte (semántica distinta: wallet vs provenance). |
| `src/presentation/flow.tsx:62` | `const [address, setAddress] = useState<string \| null>(null)`. | Único lugar donde el front conoce la wallet. Lo limpia `forgetAndDisconnect`. |
| `src/presentation/flow.tsx:164-165` | `onConnect`: `const { address: addr } = await c.connectWallet.execute(); setAddress(addr)`. `addr` = valor crudo de `wallet.connect()` (mixed-case `0xDEMO…A11ce` en fallback). | El `address` del estado NO está lowercaseado → la comparación del helper debe ser case-insensitive. |
| `src/presentation/flow.tsx:272-277` | Badge de address en el header (`{address ? (<span>…{address.slice(0,6)}…{address.slice(-4)}</span>) : null}`), visible en cualquier step post-connect. | Ancla del control de reset (dentro del `{address ? … : null}` → AC-6 satisfecho por construcción). |
| `src/presentation/flow.tsx:283-287` | Banner "Modo demo — sin dinero real": `{rem && isDemoMode(rem) && (step==="review"\|\|step==="track") ? <Pill tone="warn">… : null}`. | Banner de WKH-178. NO modificar su condición (CD-6). El banner de fallback es SEPARADO. |
| `src/presentation/flow.tsx:637-645` | `resetTo(setStep,setRem,setPreview)`: `setRem(null); setPreview(null); setStep("send")`. NO limpia `address` (intencional — "enviar otra" reusa la wallet). Consumido por `onRetryKyc` (233) y `Receipt.onNew` (542). | NO tocar (DT-4/CD-7). `forgetAndDisconnect` es una función NUEVA separada. |
| `src/presentation/flow.tsx:150-158` | `onSend`: crea remesa → `setStep("connect")`. Orden de steps: send(0)→connect(1). | El estado "fresco" tras reset = `step:"send"` + `address:null` + `rem/preview:null` (el connect exige reconexión al re-alcanzarlo → AC-4). Consistente con `onRetryKyc`/`onNew`. |
| `src/test-support/fakes.ts:142-153,209-217` | `FakeKycPendingStore` (con `clear`), `FakeKycStore` implements `KycStore` con `get`/`save` case-insensitive. `ThrowingKycPendingStore` (155-168). | `FakeKycStore` DEBE recibir `clear` al extender el port (o el build rompe). Se agrega un fake que falla en `clear` para AC-5. |
| `src/infrastructure/kyc-store.test.ts:9-29` | `MemStorage implements Storage` (Map-backed, `setItem` no falla). Tests con `beforeEach` seteando `window.localStorage`. | Exemplar del harness de test de storage. Para AC-5: variante `MemStorage` con `setItem` que lanza (quota). |
| `src/presentation/flow-vm.test.ts:1-63` | Tests puros de `isDemoMode`/`deliveredDisplay`/`humanError` con `as RemittanceState`. | Exemplar para el test de `isFallbackWalletAddress`. |
| `src/application/use-cases/abandon-pending-kyc.test.ts:1-15` | Test del use-case con `FakeKycPendingStore`. | Exemplar de forma del test de `ForgetKyc`. |

**Auto-Blindaje histórico:** no existen archivos `auto-blindaje.md` en `chaski-v2/doc/sdd/` (WKH-178..183 no los generaron). Paso salteado (sin datos), no bloqueante.

---

## 2. Decisiones técnicas (DT-N)

### DT-1 — Forma del use-case de reset: `ForgetKyc` orquesta AMBOS clears
`ForgetKyc` depende de `KycStore` **y** `KycPendingStore`. `execute({ address })`:
1. Best-effort `kycStore.clear(address)` envuelto en try/catch interno (AC-1/2, no rompe por storage — CD-8).
2. `await this.pending.clear()` (AC-3).

Rationale: la orquestación de las dos piezas de memoria vive en la capa de aplicación (no en `flow.tsx`), y `flow.tsx` hace **una sola** llamada (`c.forgetKyc.execute`). No duplica *lógica*: `pending.clear()` es una llamada a método de port de una línea (igual que `AbandonPendingKyc`), no una regla de negocio replicada. `AbandonPendingKyc` queda **intacto** para el timeout path (`flow.tsx:128`). Descarta la alternativa "flow.tsx llama dos use-cases" por dejar orquestación en la UI.

### DT-2 — Detección de FallbackWallet: constante exportada (no método de port)
`export const FALLBACK_WALLET_ADDRESS = "0xDEMO00000000000000000000000000000A11ce"` en `wallet.ts`; `FallbackWallet.connect()` la retorna. `isFallbackWalletAddress(address)` en `flow-vm.ts` compara `address.toLowerCase() === FALLBACK_WALLET_ADDRESS.toLowerCase()`. Menor superficie: NO toca `WalletPort` ni `Injected/WalletConnectWallet`. Único consumidor conocido. (Confirma la recomendación DT-2 del work-item.)

> Nota de layering: `flow-vm.ts` (presentación) importa una **constante** de `wallet.ts` (infra). Es un import de valor puro (sin lógica ni deps pesadas — `@walletconnect/*` sigue siendo dynamic import), sancionado por el Scope IN del work-item. `wallet.ts` ya está en el bundle vía `flow.tsx → container`. Aceptable; alternativa (mover la constante a `domain/`) queda fuera de scope.

### DT-3 — Control de reset: click directo + confirmación inline ligera (decisión del orquestador)
Anclado dentro del bloque `{address ? … : null}` del header (`flow.tsx:272-277`), junto al badge. Máquina de 2 estados con un `useState<boolean>` local (`confirmReset`):
- **Reposo:** botón texto sutil **"¿No sos vos?"** al lado del badge.
- **Confirmando:** fila inline con copy **"Esto borra tu verificación en este dispositivo."** + botón **"Empezar de nuevo"** (dispara `forgetAndDisconnect`) + **"Cancelar"** (vuelve a reposo).

Sin modal pesado. Copy afinado a partir del lineamiento del orquestador ("¿No sos vos? Empezar de nuevo"). AC-6 satisfecho por construcción (vive dentro del `{address ? …}`).

### DT-4 — Reset del estado React: función separada `forgetAndDisconnect()` (decisión del orquestador)
NO se agrega flag a `resetTo()`. Handler nuevo en el componente (estilo `onRetryKyc`):
```
const forgetAndDisconnect = () => guard(async () => {
  try { if (address) await c.forgetKyc.execute({ address }); } catch { /* best-effort AC-5 */ }
  setAddress(null); setRem(null); setPreview(null); setStep("send");
  setConfirmReset(false);
});
```
El reset de estado React corre SIEMPPRE (el `try/catch` aísla el fallo de storage → AC-5/CD-5/CD-8). `resetTo()` y "enviar otra" quedan intactos (CD-7).

### DT-5 — Banner de FallbackWallet: banner SEPARADO (no extender el de WKH-178)
Se agrega un banner **distinto** del "Modo demo" (`flow.tsx:283-287`), porque:
- Semántica distinta: wallet (fallback) vs provenance de la remesa (`isDemoMode`).
- Ventana distinta: visible desde `connect` en adelante y en cualquier step con `address` seteado (no solo review/track).

Condición: `address && isFallbackWalletAddress(address)`. Copy sugerido: **"Sin aislamiento por wallet en este dispositivo — conectá MetaMask o WalletConnect para proteger tu verificación."** (`Pill tone="warn"` o card sutil). NO bloquea nada (AC-8). Se coloca en la zona global tras el `Stepper` (~línea 282), junto —pero independiente— al banner existente; ambos pueden coexistir (fallback + review). NO se altera la condición del banner de WKH-178 (CD-6).

---

## 3. Constraint Directives (heredados + nuevos)

**Heredados del work-item (siguen vigentes):**
- **CD-1**: PROHIBIDO tocar archivos fuera de `chaski-v2/`. PROHIBIDO tocar el demo live (`yarvis`, `wasiai-v2`, `agentshop-*`).
- **CD-2**: PROHIBIDO hard-require de wallet real — el flujo DEBE completar e2e vía `FallbackWallet` sin MetaMask/WalletConnect (AC-8). Cualquier gating nuevo → BLOQUEANTE.
- **CD-3**: `KycStore.clear(address)` scopeado EXCLUSIVAMENTE a la address recibida (case-insensitive `.toLowerCase()`, mismo criterio que WKH-181). PROHIBIDO borrar el mapa completo o afectar otras entries (AC-2).
- **CD-4**: PROHIBIDO duplicar el literal `0xDEMO…` en más de un archivo — consumir la constante de `wallet.ts` (AC-9/DT-2).
- **CD-5**: el reset degrada sin romper si `localStorage` falla (AC-5) — sin excepción no capturada que impida reconectar.

**Nuevos del SDD:**
- **CD-6**: PROHIBIDO modificar la condición del banner "Modo demo" existente (`flow.tsx:283-287`, WKH-178). El banner de fallback es un elemento SEPARADO (DT-5). Regresión de WKH-178 → BLOQUEANTE.
- **CD-7**: PROHIBIDO tocar `resetTo()` (`flow.tsx:637-645`) o hacer que `onRetryKyc`/`Receipt.onNew` limpien `address`. "Enviar otra" DEBE seguir preservando `address` (DT-4). Regresión → BLOQUEANTE.
- **CD-8**: `ForgetKyc.execute()` NUNCA rechaza por fallo de storage (best-effort en el `kycStore.clear`); el reset del estado React DEBE ejecutarse aunque el storage falle (AC-5).
- **CD-9**: `isFallbackWalletAddress` compara case-insensitive (el `address` del estado viene crudo mixed-case desde `connect`); PROHIBIDO re-derivar o re-hardcodear el string demo (CD-4/AC-9).
- **CD-10**: al agregar `clear` a la interfaz `KycStore`, TODOS los implementers (`LocalKycStore` + `FakeKycStore` en `test-support/fakes.ts`) DEBEN implementarlo en la MISMA wave (W1) o el build TS rompe.

---

## 4. Diseño por componente

### (a) `KycStore.clear(address)` — port + adapter (AC-1/2/5, CD-3)
- **`ports.ts:104-107`**: agregar `clear(address: string): Promise<void>;` a la interfaz `KycStore`.
- **`kyc-store.ts`** `LocalKycStore`: método nuevo apoyado en el patrón existente:
  ```
  async clear(address: string): Promise<void> {
    const all = this.read();            // mapa saneado (mismo que save)
    delete all[address.toLowerCase()];  // SOLO la key pedida (CD-3, case-insensitive)
    const s = ls();
    if (!s) { this.mem = all; return; } // SSR / storage no disponible → mem
    try { s.setItem(KEY, JSON.stringify(all)); } catch { /* quota/private-browsing: best-effort (AC-5/CD-5) */ }
  }
  ```
  Scopeado a la address; nunca borra el mapa completo. `setItem` envuelto → no throw (CD-8).

### (b) Use-case `ForgetKyc` (AC-1/2/3/5, DT-1)
- **`src/application/use-cases/forget-kyc.ts`** (nuevo, análogo a `AbandonPendingKyc`):
  ```
  export class ForgetKyc {
    constructor(private readonly kycStore: KycStore, private readonly pending: KycPendingStore) {}
    async execute(input: { address: string }): Promise<void> {
      try { await this.kycStore.clear(input.address); } catch { /* best-effort (AC-5/CD-8) */ }
      await this.pending.clear(); // AC-3
    }
  }
  ```
- **`container.ts`**: agregar `forgetKyc: ForgetKyc` a la interfaz `Container` (junto a `abandonPendingKyc`, línea 38) y `forgetKyc: new ForgetKyc(kycStore, kycPending)` al retorno (junto a línea 65). `kycStore` y `kycPending` ya existen (45/46).

### (c) `FALLBACK_WALLET_ADDRESS` — fuente única (AC-9, CD-4)
- **`wallet.ts`**: `export const FALLBACK_WALLET_ADDRESS = "0xDEMO00000000000000000000000000000A11ce";` (top-level). `FallbackWallet.connect()` (62) usa la constante en vez del literal. `pickWallet()` NO cambia (AC-8).

### (d) `isFallbackWalletAddress(address)` — helper puro (AC-7, CD-9)
- **`flow-vm.ts`** (nuevo helper, junto a `isDemoMode`):
  ```
  import { FALLBACK_WALLET_ADDRESS } from "../infrastructure/wallet";
  export function isFallbackWalletAddress(address: string | null): boolean {
    return !!address && address.toLowerCase() === FALLBACK_WALLET_ADDRESS.toLowerCase();
  }
  ```

### (e) Control de reset + `forgetAndDisconnect()` (AC-4/6, DT-3/DT-4)
- **`flow.tsx`**: `useState<boolean>` `confirmReset`; control 2-estados dentro del `{address ? … : null}` del header (272-277); handler `forgetAndDisconnect` (ver DT-4). Wired al botón "Empezar de nuevo".

### (f) Banner de fallback (AC-7/8, DT-5, CD-6)
- **`flow.tsx`**: banner SEPARADO tras el `Stepper` (~282), condición `address && isFallbackWalletAddress(address)`, `Pill tone="warn"` no-bloqueante. Import de `isFallbackWalletAddress` desde `./flow-vm`.

---

## 5. Waves de implementación

| Wave | Archivos | Contenido | Depende de |
|---|---|---|---|
| **W1** (serial, contrato) | `ports.ts`, `kyc-store.ts`, `test-support/fakes.ts`, `kyc-store.test.ts` | `KycStore.clear` en el port + impl `LocalKycStore.clear` (best-effort, scoped) + `FakeKycStore.clear` + fake que falla en `clear` + tests AC-2/AC-5/case-insensitive. (CD-10: interface + todos los implementers juntos.) | — |
| **W2** | `src/application/use-cases/forget-kyc.ts`, `container.ts`, `forget-kyc.test.ts` | Use-case `ForgetKyc` + wiring + tests AC-1/AC-3/AC-5-defensivo. | W1 |
| **W3** (paralelo a W1/W2) | `wallet.ts`, `flow-vm.ts`, `flow-vm.test.ts`, (`wallet.test.ts`) | `FALLBACK_WALLET_ADDRESS` + `FallbackWallet` usa la const + `isFallbackWalletAddress` + tests AC-7/AC-9. | — |
| **W4** | `flow.tsx` | Control "¿No sos vos?" + `forgetAndDisconnect` (AC-4/6) + banner fallback (AC-7/8). | W2 + W3 |

---

## 6. Plan de tests (≥1 por AC)

| AC | Test (archivo) | Qué asserta |
|---|---|---|
| **AC-1** | `forget-kyc.test.ts` (FakeKycStore + FakeKycPendingStore) | Tras `save(addr,kyc)` + `execute({address:addr})` → `kycStore.get(addr)` = `null` (fuerza re-verify: no se toma la rama `start-kyc.ts:37`). |
| **AC-2** | `kyc-store.test.ts` | `save("0xAAA")` + `save("0xBBB")`; `clear("0xAAA")` → `get("0xBBB")` intacto, `get("0xAAA")` = `null`. + case-insensitive: `clear("0xAAA")` borra la key `"0xaaa"`. |
| **AC-3** | `forget-kyc.test.ts` | Con pending guardado, `execute()` → `pending.get()` = `null`. |
| **AC-4** | Verificación por code review (QA/AR, archivo:línea) — `forgetAndDisconnect` setea `address/rem/preview=null`, `step="send"`, sin reload. (No hay harness RTL/jsdom en el repo; sin unit test de render.) | Handler limpia todo el estado local; el step `connect` re-exige conexión. |
| **AC-5** | `kyc-store.test.ts` (MemStorage con `setItem` que lanza) + `forget-kyc.test.ts` (FakeKycStore con `clear` que rechaza) | `LocalKycStore.clear` NO lanza con storage roto; `ForgetKyc.execute` resuelve (no rechaza) y aún así corre `pending.clear()`. |
| **AC-6** | Code review (archivo:línea) — control dentro del `{address ? … : null}`. | El control no se renderiza sin `address` (paso "send" inicial). |
| **AC-7** | `flow-vm.test.ts` + code review del banner | `isFallbackWalletAddress(FALLBACK_WALLET_ADDRESS)` = `true`; `isFallbackWalletAddress("0xReal…")` = `false`; `isFallbackWalletAddress(null)` = `false`. Banner condicionado (review). |
| **AC-8** | `wallet.test.ts` + code review | `FallbackWallet.connect()` retorna `FALLBACK_WALLET_ADDRESS`; `pickWallet()` sin injected + sin `REOWN_PROJECT_ID` → `FallbackWallet` (sin gating nuevo). Flujo e2e no bloqueado — verificación manual en demo. |
| **AC-9** | `flow-vm.test.ts` + CD-check | El helper importa la constante (no re-hardcodea). Grep: `0xDEMO…` literal aparece SOLO en `wallet.ts`. |

Notas honestas: **AC-4/AC-6 y el render de los banners (AC-7)** no tienen unit test (el repo no tiene jsdom/RTL — los tests de presentación son puros sobre `flow-vm`). Se validan por code review con evidencia archivo:línea en AR/CR/QA. La lógica testeable (helper, use-case, adapter) sí tiene cobertura unitaria.

---

## 7. Regresión (guardas explícitas)

- **"Enviar otra" intacto** (CD-7): `resetTo()` (637-645) NO se toca; `onRetryKyc` (230) y `Receipt.onNew` (542) siguen preservando `address`. `forgetAndDisconnect` es función aparte.
- **Banner WKH-178 intacto** (CD-6): condición de `flow.tsx:283-287` sin cambios; el banner de fallback es un elemento separado.
- **Aislamiento por wallet real WKH-181 intacto**: `Injected/WalletConnectWallet` NO se tocan; `clear`/`get`/`save` siguen lowercaseando (mismo scoping por-address). No se reabre WKH-181.
- **Flujo completa sin wallet real** (CD-2/AC-8): `pickWallet()` sin cambios; ningún gating nuevo. El control de reset y el banner son no-bloqueantes.
- **KYC-once sigue funcionando**: `start-kyc.ts` no se toca; el clear solo cambia el resultado de `get()` cuando el usuario lo activa explícitamente.

---

## 8. Riesgos

1. **Layering presentación→infra** (import de `FALLBACK_WALLET_ADDRESS` en `flow-vm.ts`): mitigado — constante pura, sancionada por Scope IN, sin deps nuevas al bundle. (MENOR.)
2. **`address` mixed-case en la comparación**: mitigado por CD-9 (`.toLowerCase()` en ambos lados).
3. **Cobertura de UI limitada** (sin RTL): AC-4/6/7-render dependen de code review con evidencia — explícito en el plan; el Dev NO debe declarar esos ACs cubiertos por unit test.
4. **Build-break si un implementer de `KycStore` queda sin `clear`**: mitigado por CD-10 (W1 agrupa port + `LocalKycStore` + `FakeKycStore`).

---

## 9. Readiness Check

- [x] Todos los archivos y líneas del work-item re-verificados sobre `main` (post WKH-178..183) — tabla §1.
- [x] Los 2 `[NEEDS CLARIFICATION]` no bloqueantes resueltos: DT-3 (click+confirm inline) y DT-4 (`forgetAndDisconnect` separada) — decisiones del orquestador incorporadas.
- [x] Exemplars verificados: `abandon-pending-kyc.ts` (use-case), `kyc-store.ts`/`save`/`ls` (adapter defensivo), `flow-vm.ts`/`isDemoMode` (helper puro), `container.ts` (wiring), `kyc-store.test.ts`/`flow-vm.test.ts`/`abandon-pending-kyc.test.ts` (tests), `fakes.ts` (dobles).
- [x] CD heredados (1-5) + nuevos (6-10) enumerados y mapeados a ACs.
- [x] Waves con dependencias explícitas (W1→W2, W3 paralelo, W4=W2+W3).
- [x] Plan de tests ≥1 por AC, con limitaciones honestas (AC-4/6/render por code review).
- [x] Regresiones cubiertas (resetTo, banner WKH-178, WKH-181, AC-8 no-bloqueo).
- [x] Sin `[NEEDS CLARIFICATION]` pendientes.

**Estado: LISTO para SPEC_APPROVED.**
