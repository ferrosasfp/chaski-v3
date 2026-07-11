# Story File — [WKH-184] Reset explícito de KYC-once + señal soft de FallbackWallet (Opción D)

> **Contrato autosuficiente para el Dev (F3).** Este es el ÚNICO documento que necesitás leer para implementar.
> Si algo NO está acá, NO lo hagas. Todos los anchors (archivo:línea) fueron verificados sobre `main` el 2026-07-11.
> **Repo:** `/home/ferdev/.openclaw/workspace/chaski-v2/` · **Branch:** `feat/184-fallback-wallet-reset-demo-signal` (desde `main`).
> **SDD fuente:** `doc/sdd/007-wkh-184-fallback-wallet-reset-demo-signal/sdd.md` (gate SPEC_APPROVED otorgado).

---

## 1. Contexto (qué construís y por qué)

Esta HU **cierra el residual AC-8 de WKH-181** (diferido por decisión de producto). `FallbackWallet.connect()`
devuelve SIEMPRE la misma address demo `0xDEMO00000000000000000000000000000A11ce` cuando no hay wallet real
inyectada ni WalletConnect configurado. En un teléfono compartido sin wallet real, todos los usuarios colapsan
en esa "wallet", así el KYC-once reutiliza la identidad de la primera persona que verificó ("María Elena vieja"),
anulando el aislamiento por-address de WKH-181.

El founder eligió **Opción D** (demo-safe). Son DOS mitigaciones, sin hard-require:

1. **Reset explícito**: un control manual que limpia el KYC-once de la address actual (+ el pending) y devuelve
   la UI a un estado fresco que exige reconexión. Salida manual para el caso de dispositivo compartido.
2. **Señal soft**: un indicador visible de que `FallbackWallet` está activo (sin aislamiento real), sugiriendo
   conectar una wallet real, **SIN bloquear** el flujo (el jurado del hackathon debe poder probar sin wallet).

**Opción D es reset + señal SOFT, NO hard-require.** Cualquier gating que impida completar el flujo e2e vía
`FallbackWallet` es una **regresión BLOQUEANTE** (CD-2/AC-8). Esta HU **NO reabre ni reemplaza WKH-181**: agrega
una capa de mitigación sobre el estado ya mergeado (`Injected/WalletConnectWallet` funcionan y NO se tocan).

**Alcance del repo (CD-1):** SOLO `chaski-v2/src/{application,infrastructure,presentation,composition,test-support}/*`.
PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/` (el demo live `yarvis`/`wasiai-v2`/`agentshop-*` NO SE TOCA).

---

## 2. Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Cambio | Wave |
|---|---------|--------|------|
| 1 | `src/application/ports.ts` | Agregar `clear(address)` a interfaz `KycStore` (`:104-107`) | W1 |
| 2 | `src/infrastructure/kyc-store.ts` | Implementar `LocalKycStore.clear(address)` scoped + best-effort | W1 |
| 3 | `src/test-support/fakes.ts` | `FakeKycStore.clear` (`:209-217`) + nuevo fake que falla en `clear` (AC-5) | W1 |
| 4 | `src/infrastructure/kyc-store.test.ts` | Tests AC-2 (scoped/case-insensitive) + AC-5 (storage roto) | W1 |
| 5 | `src/application/use-cases/forget-kyc.ts` | **NUEVO** use-case `ForgetKyc` | W2 |
| 6 | `src/composition/container.ts` | Wiring de `forgetKyc` (interfaz `:38` + retorno `:65`) | W2 |
| 7 | `src/application/use-cases/forget-kyc.test.ts` | **NUEVO** tests AC-1/AC-3/AC-5-defensivo | W2 |
| 8 | `src/infrastructure/wallet.ts` | `export const FALLBACK_WALLET_ADDRESS` + `FallbackWallet.connect` la usa (`:62`) | W3 |
| 9 | `src/presentation/flow-vm.ts` | Helper puro `isFallbackWalletAddress(address)` (junto a `isDemoMode` `:4-7`) | W3 |
| 10 | `src/presentation/flow-vm.test.ts` | Tests AC-7/AC-9 del helper | W3 |
| 11 | `src/infrastructure/wallet.test.ts` | (crear si no existe) AC-8/AC-9: `connect()` retorna la const; `pickWallet` sin gating | W3 |
| 12 | `src/presentation/flow.tsx` | Control reset + `forgetAndDisconnect` + banner fallback | W4 |

**Fuera de scope (NO tocar):** `InjectedWallet`/`WalletConnectWallet` (`wallet.ts:15-55,82-146`), `pickWallet()`
(`wallet.ts:154-159`), `start-kyc.ts`, `resetTo()` (`flow.tsx:637-645`), `AbandonPendingKyc`, dominio
(`RemittanceState`/`RemittanceStatus`), cualquier UI de historial.

---

## 3. Anti-Hallucination Checklist (anchors EXACTOS verificados 2026-07-11)

Antes de escribir código, confirmá que cada anchor sigue igual. Si difiere, **pará y reportá drift** — no improvises.

- [ ] **`src/application/ports.ts:104-107`** — `interface KycStore { get(address): ...; save(address, kyc): ...; }`.
      Solo 2 métodos, sin borrado. Agregás `clear(address: string): Promise<void>;`.
- [ ] **`src/infrastructure/kyc-store.ts`** — `LocalKycStore` (`:65-107`). Piezas a reusar:
      `KEY = "chaski.kyc.v1"` (`:6`), `ls()` try/catch (`:57-63`), `rawObject()` (`:68-76`), `read()` saneado
      (`:81-88`), `get()` lowercasea (`:91`), `save()` lowercasea + `if(!s){this.mem=all;return}` best-effort (`:97-106`).
      `clear` sigue el patrón de `save`: `read()` → `delete all[address.toLowerCase()]` → reescribir vía `ls()` con `setItem` envuelto.
- [ ] **`src/application/use-cases/abandon-pending-kyc.ts:1-11`** — exemplar de forma del use-case
      (`constructor(pending: KycPendingStore)`, `execute()` = `await this.pending.clear()`). **NO lo modifiques**
      (lo usa el timeout path en `flow.tsx:128`).
- [ ] **`src/application/ports.ts:56-60`** — `KycPendingStore` YA tiene `clear(): Promise<void>` (global, sin address). Reusable directo.
- [ ] **`src/composition/container.ts:38,65`** — interfaz expone `abandonPendingKyc: AbandonPendingKyc` (`:38`);
      `createContainer()` retorna `abandonPendingKyc: new AbandonPendingKyc(kycPending)` (`:65`).
      `kycStore = new LocalKycStore()` (`:45`) y `kycPending = new LocalKycPendingStore()` (`:46`) ya existen. Clonás ese patrón.
- [ ] **`src/application/use-cases/start-kyc.ts:36-41`** — `const remembered = await this.kycStore.get(input.address);
      if (remembered && remembered.approved && remembered.payoutAllowed) { ...return {kind:"done"} }`. Si `get()` → `null`
      tras el `clear`, esta rama NO se toma → re-verificación completa. **NO tocar `start-kyc.ts`.**
- [ ] **`src/infrastructure/wallet.ts:58-71`** — `FallbackWallet.connect()` asigna string literal inline
      `"0xDEMO00000000000000000000000000000A11ce"` en `:62`. Es el ÚNICO lugar del repo con ese literal
      (grep confirmado). Extraés a `FALLBACK_WALLET_ADDRESS`; `connect()` retorna la constante.
- [ ] **`src/infrastructure/wallet.ts:154-159`** — `pickWallet()`. **NO tocar** (CD-2: condición de AC-8 intacta).
- [ ] **`src/presentation/flow-vm.ts:4-7`** — `isDemoMode(rem)` puro (deriva de `rem.quote/kyc.provenance`, no conoce wallets).
      Exemplar de helper puro. `isFallbackWalletAddress` va **aparte** (semántica distinta).
- [ ] **`src/presentation/flow.tsx:62`** — `const [address, setAddress] = useState<string | null>(null)`.
- [ ] **`src/presentation/flow.tsx:164-165`** — `onConnect`: `setAddress(addr)` con `addr` crudo mixed-case desde `connect()` →
      la comparación del helper DEBE ser case-insensitive (CD-9).
- [ ] **`src/presentation/flow.tsx:272-277`** — badge de address dentro de `{address ? (<span>…</span>) : null}` en el header.
      El control de reset vive DENTRO de ese `{address ? …}` (satisface AC-6 por construcción).
- [ ] **`src/presentation/flow.tsx:283-287`** — banner "Modo demo — sin dinero real" (WKH-178), condición
      `rem && isDemoMode(rem) && (step==="review"||step==="track")`. **NO modificar esta condición** (CD-6). El banner de fallback es SEPARADO.
- [ ] **`src/presentation/flow.tsx:637-645`** — `resetTo(setStep,setRem,setPreview)`: `setRem(null); setPreview(null); setStep("send")`.
      NO limpia `address` (intencional). Consumido por `onRetryKyc` (`:233`) y `Receipt.onNew` (`:627`). **NO tocar** (CD-7).
- [ ] **`src/presentation/flow.tsx:138-148`** — `guard(fn)` helper (`useCallback`, setBusy/setError/try-catch). Usalo en `forgetAndDisconnect`.
- [ ] **`src/presentation/flow.tsx:230-234`** — `onRetryKyc` (exemplar de forma de handler que llama `resetTo`). NO tocar.
- [ ] **`src/test-support/fakes.ts:142-153`** — `FakeKycPendingStore` (con `clear`). `:155-168` `ThrowingKycPendingStore`
      (exemplar de doble que falla). `:209-217` `FakeKycStore implements KycStore` (`get`/`save` case-insensitive) →
      **DEBE recibir `clear`** o el build TS rompe (CD-10).

---

## 4. Diseño de las 5 piezas (snippets objetivo)

### Pieza (a) — `KycStore.clear(address)`: port + adapter (AC-1/2/5, CD-3/CD-5)

**`ports.ts`** — agregar a la interfaz `KycStore` (`:104-107`):
```ts
export interface KycStore {
  get(address: string): Promise<KycVerification | null>;
  save(address: string, kyc: KycVerification): Promise<void>;
  clear(address: string): Promise<void>;   // ← NUEVO (WKH-184)
}
```

**`kyc-store.ts`** — método nuevo en `LocalKycStore`, apoyado en el patrón de `save`/`ls`:
```ts
async clear(address: string): Promise<void> {
  const all = this.read();               // mapa saneado (mismo que save)
  delete all[address.toLowerCase()];     // SOLO la key pedida (CD-3, case-insensitive)
  const s = ls();
  if (!s) { this.mem = all; return; }    // SSR / storage no disponible → mem
  try {
    s.setItem(KEY, JSON.stringify(all));
  } catch {
    /* quota / private-browsing: best-effort — no throw (AC-5/CD-5) */
  }
}
```
- **CD-3:** scopeado EXCLUSIVAMENTE a la address recibida (`delete all[key]`), NUNCA borra el mapa completo ni otras entries.
- **CD-5:** `setItem` envuelto en try/catch → nunca lanza si el storage falla.

### Pieza (b) — Use-case `ForgetKyc` + wiring (AC-1/2/3/5, DT-1, CD-8)

**`src/application/use-cases/forget-kyc.ts`** (NUEVO, análogo a `abandon-pending-kyc.ts`):
```ts
import type { KycStore, KycPendingStore } from "../ports";

/** Reset explícito del KYC-once (WKH-184, Opción D): olvida la verificación recordada para esta
 *  address Y limpia cualquier pending en curso, para forzar re-verificación completa. */
export class ForgetKyc {
  constructor(
    private readonly kycStore: KycStore,
    private readonly pending: KycPendingStore,
  ) {}

  async execute(input: { address: string }): Promise<void> {
    try {
      await this.kycStore.clear(input.address);   // AC-1/2 — best-effort (CD-8)
    } catch {
      /* storage roto: no rompe el reset (AC-5/CD-8) */
    }
    await this.pending.clear();                    // AC-3 — limpia el pending
  }
}
```
> **DT-1:** `ForgetKyc` orquesta AMBOS clears en la capa de aplicación (no en `flow.tsx`). `AbandonPendingKyc`
> queda **intacto** (lo usa el timeout path). No se duplica lógica de negocio: `pending.clear()` es una llamada de port de una línea.
> **CD-8:** `execute()` NUNCA rechaza por fallo de storage — el `clear` va en try/catch; `pending.clear()` siempre corre.

**`container.ts`** — wiring (clonar el patrón de `abandonPendingKyc`):
```ts
// import (junto a los otros use-cases, arriba)
import { ForgetKyc } from "../application/use-cases/forget-kyc";

// interfaz Container (junto a la línea 38)
forgetKyc: ForgetKyc;

// retorno de createContainer() (junto a la línea 65) — kycStore(:45) y kycPending(:46) ya existen
forgetKyc: new ForgetKyc(kycStore, kycPending),
```

### Pieza (c) — `FALLBACK_WALLET_ADDRESS`: fuente única (AC-9, CD-4)

**`wallet.ts`** — constante top-level exportada; `FallbackWallet.connect()` la usa:
```ts
// top-level del módulo
export const FALLBACK_WALLET_ADDRESS = "0xDEMO00000000000000000000000000000A11ce";

// dentro de FallbackWallet.connect() (:62) — reemplazar el literal por la constante
this.address = FALLBACK_WALLET_ADDRESS;
```
- **CD-4:** el literal `0xDEMO…` debe existir en UN SOLO archivo (`wallet.ts`). Presentación consume la constante, no lo re-hardcodea.
- `pickWallet()` NO cambia (AC-8).

### Pieza (d) — `isFallbackWalletAddress(address)`: helper puro (AC-7, CD-9)

**`flow-vm.ts`** — nuevo helper junto a `isDemoMode` (`:4-7`):
```ts
import { FALLBACK_WALLET_ADDRESS } from "../infrastructure/wallet";

/** true si la wallet conectada es la FallbackWallet demo (sin aislamiento real por wallet). */
export function isFallbackWalletAddress(address: string | null): boolean {
  return !!address && address.toLowerCase() === FALLBACK_WALLET_ADDRESS.toLowerCase();
}
```
- **CD-9:** case-insensitive (el `address` del estado viene crudo mixed-case desde `connect`). PROHIBIDO re-hardcodear el string demo (importás la const).
- Import de VALOR puro de infra → presentación (sancionado por Scope IN; `wallet.ts` ya está en el bundle vía `container`).

### Pieza (e) — Control de reset + `forgetAndDisconnect()` (AC-4/6, DT-3/DT-4)

**`flow.tsx`** — (1) estado local nuevo junto a los otros `useState` (`:48-60`):
```ts
const [confirmReset, setConfirmReset] = useState(false);
```

(2) Handler **SEPARADO** de `resetTo` (estilo `onRetryKyc`, usando `guard` `:138`):
```ts
// Reset explícito (WKH-184): olvida el KYC-once de esta address + pending, y vuelve a estado fresco.
// SEPARADO de resetTo (que preserva address para "enviar otra" — CD-7).
const forgetAndDisconnect = () =>
  guard(async () => {
    try {
      if (address) await c.forgetKyc.execute({ address });
    } catch {
      /* best-effort — el reset del estado corre igual (AC-5/CD-8) */
    }
    setAddress(null);
    setRem(null);
    setPreview(null);
    setStep("send");
    setConfirmReset(false);
  });
```
- **DT-4/CD-7:** función NUEVA, NO se agrega flag a `resetTo`. Limpia `address` ADEMÁS de `rem`/`preview` → fuerza reconexión (AC-4). Sin `window.location.reload()`.

(3) Control 2-estados DENTRO del `{address ? … : null}` del header (`:272-277`, junto al badge) → AC-6 por construcción:
- **Reposo:** botón texto sutil **"¿No sos vos?"**.
- **Confirmando** (`confirmReset === true`): fila inline con copy **"Esto borra tu verificación en este dispositivo."**
  + botón **"Empezar de nuevo"** (`onClick={forgetAndDisconnect}`) + **"Cancelar"** (`onClick={() => setConfirmReset(false)}`).
- **Sin modal pesado.** Usar clases Tailwind del repo (`text-xs text-stone`, `Button`/link sutil coherente con el header).

### Pieza (f) — Banner de fallback (AC-7/8, DT-5, CD-6)

**`flow.tsx`** — banner SEPARADO del "Modo demo" (WKH-178), colocado tras el `Stepper` (~`:282`), junto pero
INDEPENDIENTE del banner existente (ambos pueden coexistir: fallback + review):
```tsx
{address && isFallbackWalletAddress(address) ? (
  <div className="mb-4 flex items-center justify-center">
    <Pill tone="warn">Sin aislamiento por wallet en este dispositivo — conectá MetaMask o WalletConnect.</Pill>
  </div>
) : null}
```
- Importar `isFallbackWalletAddress` desde `./flow-vm` (junto al import de `isDemoMode`).
- **DT-5/CD-6:** condición `address && isFallbackWalletAddress(address)` — visible desde `connect` en adelante en cualquier step con `address`. **NO alterar** la condición del banner WKH-178 (`:283-287`).
- **AC-8/CD-2:** NO bloquea nada. Es puramente informativo.

---

## 5. Waves (orden de implementación)

| Wave | Archivos | Contenido | Depende de |
|---|---|---|---|
| **W1** (serial, contrato) | `ports.ts`, `kyc-store.ts`, `test-support/fakes.ts`, `kyc-store.test.ts` | Pieza (a): `KycStore.clear` en port + `LocalKycStore.clear` + `FakeKycStore.clear` + fake que falla en `clear` (AC-5) + tests. **CD-10: port + TODOS los implementers en la misma wave o el build TS rompe.** | — |
| **W2** | `use-cases/forget-kyc.ts`, `container.ts`, `use-cases/forget-kyc.test.ts` | Pieza (b): `ForgetKyc` + wiring + tests AC-1/AC-3/AC-5-defensivo. | W1 |
| **W3** (paralelo a W1/W2) | `wallet.ts`, `flow-vm.ts`, `flow-vm.test.ts`, `wallet.test.ts` | Piezas (c)+(d): `FALLBACK_WALLET_ADDRESS`, `FallbackWallet` usa la const, `isFallbackWalletAddress`, tests AC-7/AC-8/AC-9. | — |
| **W4** | `flow.tsx` | Piezas (e)+(f): control "¿No sos vos?" + `forgetAndDisconnect` (AC-4/6) + banner fallback (AC-7/8). | W2 + W3 |

**CD-10 recordatorio (W1):** al agregar `clear` a `KycStore`, `LocalKycStore` **y** `FakeKycStore` DEBEN implementarlo
en W1 o el `tsc --noEmit` rompe. Verificá también cualquier otro `implements KycStore` (grep) — al 2026-07-11 solo hay esos dos.

---

## 6. Mapa de ACs (9) → evidencia

| AC | Cómo se cubre | Evidencia esperada |
|---|---|---|
| **AC-1** — reset limpia KYC-once de la address, fuerza re-verify | `forget-kyc.test.ts` | `save(addr,kyc)` + `execute({address:addr})` → `kycStore.get(addr) === null` |
| **AC-2** — clear scopeado, NO afecta otras addresses | `kyc-store.test.ts` | `save("0xAAA")`+`save("0xBBB")`; `clear("0xAAA")` → `get("0xBBB")` intacto, `get("0xAAA")===null`; case-insensitive (`clear("0xAAA")` borra `"0xaaa"`) |
| **AC-3** — reset limpia el pending | `forget-kyc.test.ts` | con pending guardado, `execute()` → `pending.get() === null` |
| **AC-4** — reset limpia estado React, exige reconexión, sin reload | **Code review + evidencia archivo:línea (SIN RTL)** | `forgetAndDisconnect` setea `address/rem/preview=null`, `step="send"`, sin `window.location.reload` |
| **AC-5** — reset degrada sin romper si storage falla | `kyc-store.test.ts` (MemStorage con `setItem` que lanza) + `forget-kyc.test.ts` (FakeKycStore con `clear` que rechaza) | `LocalKycStore.clear` NO lanza; `ForgetKyc.execute` resuelve y aún así corre `pending.clear()` |
| **AC-6** — control solo con `address !== null` | **Code review + evidencia archivo:línea (SIN RTL)** | control dentro del `{address ? … : null}` del header (`:272-277`) |
| **AC-7** — señal soft de FallbackWallet | `flow-vm.test.ts` (helper) + code review (banner) | `isFallbackWalletAddress(FALLBACK_WALLET_ADDRESS)===true`, `("0xReal…")===false`, `(null)===false`; banner condicionado |
| **AC-8** — flujo completa e2e vía FallbackWallet sin wallet real (NO hard-require) | `wallet.test.ts` + code review | `FallbackWallet.connect()` retorna `FALLBACK_WALLET_ADDRESS`; `pickWallet()` sin injected + sin `REOWN_PROJECT_ID` → `FallbackWallet`; ningún gating nuevo |
| **AC-9** — detección desde fuente única, sin duplicar literal | `flow-vm.test.ts` + grep | helper importa la const; `grep -rn "0xDEMO" src/` → SOLO `wallet.ts` |

> **AC-4 y AC-6 se cubren por CODE REVIEW con evidencia archivo:línea, NO por unit test.** El repo NO tiene
> jsdom/RTL — los tests de presentación son puros sobre `flow-vm`. El render del banner (parte de AC-7) también
> es code review. **NO declares AC-4/AC-6/render como cubiertos por unit test.** La lógica testeable
> (helper, use-case, adapter) SÍ lleva cobertura unitaria.

---

## 7. Constraint Directives (checklist obligatorio)

- [ ] **CD-1** — Ningún archivo fuera de `chaski-v2/`. Nada del demo live (`yarvis`/`wasiai-v2`/`agentshop-*`).
- [ ] **CD-2** — SIN hard-require de wallet real. El flujo completa e2e vía `FallbackWallet`. `pickWallet()` intacto. (Regresión → BLOQUEANTE.)
- [ ] **CD-3** — `LocalKycStore.clear` scopeado a la address (case-insensitive `.toLowerCase()`), NUNCA borra el mapa completo.
- [ ] **CD-4** — El literal `0xDEMO…` en UN SOLO archivo (`wallet.ts`). Presentación consume la const.
- [ ] **CD-5** — `clear` degrada sin romper si `localStorage` falla (no throw que impida reconectar).
- [ ] **CD-6** — Condición del banner WKH-178 (`:283-287`) SIN cambios. Banner de fallback SEPARADO. (Regresión → BLOQUEANTE.)
- [ ] **CD-7** — `resetTo()` (`:637-645`) intacto; `onRetryKyc`/`Receipt.onNew` siguen preservando `address`. (Regresión → BLOQUEANTE.)
- [ ] **CD-8** — `ForgetKyc.execute()` NUNCA rechaza por storage; el reset del estado React corre siempre.
- [ ] **CD-9** — `isFallbackWalletAddress` case-insensitive; importa la const, no re-hardcodea.
- [ ] **CD-10** — `KycStore.clear` en el port + `LocalKycStore` + `FakeKycStore` en la MISMA wave (W1).

---

## 8. Test plan (≥1 por AC testeable)

**`kyc-store.test.ts`** (harness `MemStorage implements Storage` ya existe `:9-29`):
- `clear` NO borra otras addresses (AC-2): guardar 2, clear 1, verificar la otra intacta + la borrada `null`.
- `clear` case-insensitive (AC-2): `save("0xAAA")` → `clear("0xaaa")` → `get("0xAAA") === null`.
- `clear` con `setItem` que lanza (variante `MemStorage` que tira quota) NO propaga la excepción (AC-5).

**`forget-kyc.test.ts`** (NUEVO, exemplar `abandon-pending-kyc.test.ts:1-15`, con `FakeKycStore` + `FakeKycPendingStore`):
- AC-1: `save` + `execute({address})` → `kycStore.get(address) === null`.
- AC-3: pending guardado → `execute()` → `pending.get() === null`.
- AC-5 defensivo: con un `FakeKycStore` cuyo `clear` **rechaza** (nuevo doble en `fakes.ts`), `execute()` resuelve (no rechaza) y `pending.clear()` igual corrió (`pending.get() === null`).

**`flow-vm.test.ts`** (exemplar `:1-63`, tests puros):
- AC-7/AC-9: `isFallbackWalletAddress(FALLBACK_WALLET_ADDRESS) === true`; con address real mixed-case → `false`; `null` → `false`; variante case (`.toUpperCase()` de la const) → `true`.

**`wallet.test.ts`** (crear si no existe):
- AC-8/AC-9: `new FallbackWallet().connect()` retorna `FALLBACK_WALLET_ADDRESS`.
- (opcional) `pickWallet()` en entorno sin injected/sin `REOWN_PROJECT_ID` → instancia de `FallbackWallet`.

**e2e AC-8 (manual):** validación en el demo — el flujo completa sin MetaMask/WalletConnect (jurado del hackathon). NO hay harness automático.

---

## 9. Regresiones a guardar (verificá que NO rompés esto)

- **"Enviar otra" preserva `address`** (CD-7): `resetTo()` (`:637-645`) NO se toca; `onRetryKyc` (`:230-234`) y `Receipt.onNew` (`:627`) siguen sin limpiar `address`. `forgetAndDisconnect` es función aparte.
- **Banner WKH-178 intacto** (CD-6): condición `:283-287` sin cambios; el banner de fallback es un elemento separado.
- **Aislamiento WKH-181 intacto**: `Injected/WalletConnectWallet` NO se tocan; `clear`/`get`/`save` siguen lowercaseando (mismo scoping por-address). NO se reabre WKH-181.
- **Flujo completa sin wallet real** (CD-2/AC-8): `pickWallet()` sin cambios; control de reset y banner NO bloqueantes.
- **KYC-once sigue funcionando**: `start-kyc.ts` NO se toca; el `clear` solo cambia el resultado de `get()` cuando el usuario activa el reset explícitamente.

---

## 10. Done Definition (F3 termina cuando)

- [ ] W1→W4 implementadas exactamente como los snippets de §4, con los anchors de §3 respetados.
- [ ] Los 10 CDs de §7 verificados.
- [ ] Tests de §8 escritos y verdes.
- [ ] `npx tsc --noEmit` → sin errores (clave: CD-10, todos los `implements KycStore` con `clear`).
- [ ] `npx vitest run` → toda la suite verde (incluida la preexistente — sin regresiones).
- [ ] `npx next build` → build de producción OK.
- [ ] `grep -rn "0xDEMO" src/` → aparece SOLO en `wallet.ts` (CD-4/AC-9).
- [ ] Ningún archivo modificado fuera de `chaski-v2/src/{application,infrastructure,presentation,composition,test-support}/*` (CD-1).

**Comandos de cierre:**
```bash
cd /home/ferdev/.openclaw/workspace/chaski-v2
npx tsc --noEmit && npx vitest run && npx next build
grep -rn "0xDEMO" src/    # debe listar SOLO wallet.ts
```
