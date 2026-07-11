# Work Item — [WKH-184] Reset explícito de KYC-once + señal soft de FallbackWallet (Opción D)

## Resumen
Residual de WKH-181 (AC-8, diferido por decisión de producto D2, `doc/sdd/004-wkh-181-.../done-report.md`
§"El Residual Diferido"): `FallbackWallet.connect()` (`src/infrastructure/wallet.ts:58-71`) devuelve
siempre la MISMA constante `0xDEMO00000000000000000000000000000A11ce` cuando no hay wallet real
inyectada ni WalletConnect configurado. En un teléfono compartido sin wallet real, esto colapsa a
todos los usuarios en la misma "wallet", anulando el aislamiento por-address que WKH-181 (AC-5/6/7)
ya implementó — el KYC-once reutiliza automáticamente la identidad de la primera persona que
verificó en ese dispositivo ("María Elena vieja"). El founder decidió **Opción D** (demo-safe, NO
hard-require de wallet real): (1) un control de reset explícito que limpia el KYC-once de la
address actual, dando una salida manual para el caso de dispositivo compartido; (2) una señal soft
que surfacea que `FallbackWallet` está activo (sin aislamiento real) y sugiere conectar una wallet
real, SIN bloquear el flujo (el jurado del hackathon debe poder probar sin wallet). Esta HU NO
reabre ni reemplaza WKH-181; agrega la capa de mitigación decidida por el founder sobre el estado ya
mergeado.

## Sizing
- Modo de proceso: QUALITY (chaski-v2 sigue el pipeline completo NexusAgil, mismo criterio que
  WKH-178/179/180/181/182/183)
- SDD_MODE: mini (1 método nuevo en 1 port + 1 adapter, 1 use-case nuevo de una línea de lógica
  (análogo a `AbandonPendingKyc`), 1 constante exportada en `wallet.ts`, 1 helper nuevo en
  `flow-vm.ts`, cambios acotados en `flow.tsx` (1 control + ajuste de banner existente). Sin cambios
  de dominio (`RemittanceState`/`RemittanceStatus` no se tocan), sin nuevas pantallas.)
- Estimación: S
- Branch sugerido: `feat/184-fallback-wallet-reset-demo-signal`

## Contexto verificado (F0 grounding, líneas reales al 2026-07-11, sobre `main` post WKH-178/179/180/181/182/183)

### `FallbackWallet` — la causa raíz (sin cambios respecto al grounding de WKH-181)
- `src/infrastructure/wallet.ts:58-71` — `FallbackWallet.connect()` retorna SIEMPRE
  `"0xDEMO00000000000000000000000000000A11ce"` (línea 62). `pickWallet()` (línea 154-159) cae a
  `FallbackWallet` solo si NO hay `injectedProvider()` Y (no hay `window` O no hay
  `NEXT_PUBLIC_REOWN_PROJECT_ID`). No hay HOY ninguna constante exportada — la address vive inline
  como string literal dentro del método.
- `InjectedWallet` (línea 15-55) y `WalletConnectWallet` (línea 82-146) SÍ devuelven una address
  real/distinta por usuario — Opción D no las toca; el gap es exclusivo de `FallbackWallet`.

### KYC-once — dónde vive la memoria a limpiar
- `src/application/ports.ts:104-107` — `KycStore` **solo tiene `get(address)`/`save(address, kyc)`**.
  NO existe ningún método `clear`/`delete`/`forget`. Confirmado por grep — no hay ningún método de
  borrado en la interfaz.
- `src/infrastructure/kyc-store.ts` (`LocalKycStore`) — implementa `get`/`save` (líneas 90-106) sobre
  un mapa `Record<address, KycEntry>` persistido en `localStorage["chaski.kyc.v1"]` (línea 6). El
  método `read()` (línea 81-88) ya sanea/normaliza TODAS las entries en cada lectura (fix MNR-1 de
  WKH-181) — un `clear(address)` nuevo puede apoyarse en el mismo patrón: leer el mapa completo,
  borrar solo la key de la address dada, reescribir. NO hay método de borrado hoy.
- `src/application/use-cases/start-kyc.ts:36-41` — el punto donde el KYC-once se REUSA:
  `const remembered = await this.kycStore.get(input.address); if (remembered && remembered.approved
  && remembered.payoutAllowed) { r.applyKyc(remembered, ...); ... return { kind: "done", ... } }`.
  Si `kycStore.get(address)` devuelve `null` tras el reset, esta rama NO se toma — el flujo cae al
  `this.kyc.start(...)` normal (re-verificación completa). Confirma que un `clear(address)` en
  `KycStore` es SUFICIENTE para forzar re-verificación en el próximo `StartKyc.execute()`, sin tocar
  `start-kyc.ts`.

### KYC pendiente — segunda pieza de memoria (defensiva, no la causa del bug pero relevante al reset)
- `src/application/ports.ts:56-60` — `KycPendingStore` YA tiene `clear(): Promise<void>` (sin
  parámetro de address — es global/singleton, un solo pendiente a la vez, patrón usado hoy por
  `AbandonPendingKyc`, ver abajo).
- `src/application/use-cases/abandon-pending-kyc.ts` — use-case existente **ya implementado (WKH-178)**
  que hace `await this.pending.clear()`. Se usa hoy en `flow.tsx:128` cuando el resume-loop agota el
  timeout (`c.abandonPendingKyc.execute()`). **Reutilizable directo** para la parte "limpia el
  pending" del reset de esta HU — no hace falta un use-case nuevo para esa mitad.

### `container.ts` — wiring existente (referencia para F2)
- `src/composition/container.ts:28-39` — interfaz `Container` ya expone `abandonPendingKyc:
  AbandonPendingKyc`. Un nuevo use-case (ej. `ForgetKyc`) se agrega al mismo patrón: constructor recibe
  `kycStore` (ya instanciado línea 45 `const kycStore = new LocalKycStore()`), se agrega a la interfaz
  y al objeto retornado de `createContainer()` (líneas 55-66).

### `flow.tsx` — dónde vive el estado y el banner existente
- `src/presentation/flow.tsx:62` — `const [address, setAddress] = useState<string | null>(null)`.
  Es el único lugar donde el frontend conoce la wallet conectada.
- `src/presentation/flow.tsx:272-277` — el badge de address (`address.slice(0,6)…slice(-4)`) en el
  header, SIEMPRE visible mientras `address` no es `null` — independiente del `step` actual. Es la
  ubicación natural para anclar el control de reset (visible en cualquier paso post-connect, sin
  interferir con el contenido específico de cada `step`).
- `src/presentation/flow.tsx:283-287` — el banner "Modo demo" existente (WKH-178) se muestra
  SOLO en `step === "review" || step === "track"` y depende de `isDemoMode(rem)` (provenance de
  `quote`/`kyc`, NO del tipo de wallet). Es un banner DISTINTO del que pide esta HU (activo desde
  `connect` en adelante, condicionado al wallet, no al quote/kyc).
- `src/presentation/flow.tsx:389-420` (step `"connect"`) — pantalla donde el usuario conecta la
  wallet; es el punto más temprano donde se podría anticipar la señal de `FallbackWallet` (antes de
  llamar `c.connectWallet.execute()` no se sabe qué wallet se va a usar — el signal solo puede
  surgir DESPUÉS de `onConnect()`, cuando `address` ya está seteado).
- `src/presentation/flow.tsx:637-645` — `resetTo()` ya existe (usado por `onRetryKyc` y `Receipt`'s
  `onNew`): limpia `rem`/`preview` y vuelve a `step: "send"`. NO limpia `address` (intencional hoy —
  "enviar otra" reusa la misma wallet conectada). El reset de esta HU es DISTINTO: debe limpiar
  también `address` (para forzar reconexión) — no puede reusar `resetTo()` tal cual.

### `flow-vm.ts` — dónde vive `isDemoMode` (helper puro, sin I/O)
- `src/presentation/flow-vm.ts:4-7` — `isDemoMode(rem)` es 100% derivado de
  `rem.quote?.provenance`/`rem.kyc?.provenance`. No conoce nada de wallets. Un helper nuevo
  (ej. `isFallbackWalletAddress(address)`) es una función PURA distinta, del mismo archivo, siguiendo
  el mismo patrón (sin I/O, testeable en aislamiento) — no se debe mezclar con `isDemoMode` (semántica
  distinta: uno es sobre datos de la remesa, el otro sobre el tipo de wallet conectada).

## Acceptance Criteria (EARS)

### Reset explícito del KYC-once (core, BLOQUEANTE)
- **AC-1**: WHEN the user activates the "¿No sos vos? / Empezar de nuevo" control while a wallet
  `address` is connected, the system SHALL clear the recorded KYC verification (`KycStore`) for
  that exact `address`, so that the next `StartKyc.execute()` call for that address does NOT take
  the KYC-once shortcut (`start-kyc.ts:36-41`) and instead runs full re-verification.
- **AC-2**: WHEN the reset control clears the KYC-once record for the current `address`, the system
  SHALL NOT alter or delete any `KycStore` entry recorded for a DIFFERENT `address` — the clear
  operation SHALL be scoped exclusively to the currently connected wallet.
- **AC-3**: WHEN the reset control is activated, the system SHALL also clear any in-flight pending
  KYC session (`KycPendingStore`, via the existing `AbandonPendingKyc` use-case) so a stale pending
  session does not leak into the next person's resume-loop on the same device.
- **AC-4**: WHEN the reset completes, the system SHALL clear the local `address` (and any in-progress
  remittance/`rem` state) client-side and return the UI to a state where a NEW wallet connection is
  required, WITHOUT requiring a full page reload.
- **AC-5**: IF `KycStore.clear(address)` fails (e.g., `localStorage` quota exceeded or unavailable —
  private browsing), THEN the system SHALL NOT throw an unhandled error to the user — the reset
  SHALL still clear the client-side React state (address/rem) so the UI reaches a fresh state even
  if the underlying storage write failed (best-effort, degrada sin romper, mismo patrón defensivo ya
  usado en `ls()` de `kyc-store.ts:57-63`).
- **AC-6**: WHERE the reset control is rendered, the system SHALL only display it when there is a
  connected `address` (`address !== null`) — it SHALL NOT appear on the initial "send" step (antes
  de que exista ninguna wallet/sesión que resetear).

### Señal soft de FallbackWallet (core, BLOQUEANTE)
- **AC-7**: WHILE the currently connected wallet is `FallbackWallet` (detected via a single exported
  constant/detector, no adivinar el string en la capa de presentación), the system SHALL surface a
  visible indicator (extendiendo el banner "Modo demo" existente de WKH-178, o uno adicional
  claramente asociado) comunicando que este dispositivo NO tiene aislamiento real por wallet y
  sugiriendo conectar una wallet real (MetaMask/WalletConnect).
- **AC-8**: WHEN no injected wallet provider is available AND no WalletConnect `projectId` is
  configured (the exact condition `pickWallet()` already uses, `wallet.ts:154-159`), the system
  SHALL continue to allow the full remittance flow to complete end-to-end via `FallbackWallet`
  WITHOUT requiring the user to connect a real wallet — Opción D es NO hard-require (el jurado del
  hackathon debe poder probar sin wallet real).
- **AC-9**: the system SHALL detect `FallbackWallet` usage from a single source of truth (ej. una
  constante exportada desde `wallet.ts`, comparada en la capa de presentación) — PROHIBIDO duplicar
  el string literal de la address demo en más de un archivo (riesgo de que uno se actualice y el
  otro no, mismo criterio que CD-2 de WKH-181 sobre el helper de reducción de PII).

## Scope IN
- `src/application/ports.ts` — extender la interfaz `KycStore` (líneas 104-107) con un método nuevo
  de borrado (ej. `clear(address: string): Promise<void>`).
- `src/infrastructure/kyc-store.ts` — implementar el método nuevo en `LocalKycStore`, reutilizando el
  patrón de lectura/saneo ya existente (`read()`/`rawObject()`/`ls()`).
- `src/application/use-cases/` — nuevo use-case (ej. `forget-kyc.ts`, patrón análogo a
  `abandon-pending-kyc.ts`) que orquesta `kycStore.clear(address)` (AC-1/2) + reutiliza
  `AbandonPendingKyc` o su lógica interna para el pending (AC-3).
- `src/composition/container.ts` — wiring del use-case nuevo en la interfaz `Container` y en
  `createContainer()` (mismo patrón que `abandonPendingKyc` líneas 38/65).
- `src/infrastructure/wallet.ts` — exportar la address demo como constante nombrada (ej.
  `export const FALLBACK_WALLET_ADDRESS = "0x..."`) en lugar de string literal inline, para que sea
  la única fuente de verdad consumible desde presentación (AC-9).
- `src/presentation/flow-vm.ts` — nuevo helper puro (ej. `isFallbackWalletAddress(address)`) que
  compara contra la constante exportada de `wallet.ts` (AC-7).
- `src/presentation/flow.tsx` — (a) control "¿No sos vos? / Empezar de nuevo" anclado cerca del badge
  de address del header (línea ~272-277), visible solo con `address` seteado (AC-6); wired al
  use-case nuevo + reset del estado local (`address`, `rem`, `step`) (AC-4); (b) extensión/ajuste del
  banner "Modo demo" (línea 283-287) o uno adicional para cubrir la señal de `FallbackWallet` (AC-7),
  visible desde el step `connect` en adelante (no solo `review`/`track`, a definir por el Architect).
- Tests: `src/infrastructure/kyc-store.test.ts` (método `clear`), nuevo test para el use-case
  (`forget-kyc.test.ts` o extensión de `use-cases.test.ts`), `src/presentation/flow-vm.test.ts`
  (helper nuevo `isFallbackWalletAddress`).

## Scope OUT
- Pseudo-address por instalación de navegador (la alternativa DT-2 que WKH-181 había dejado
  `[NEEDS CLARIFICATION]`) — el founder decidió Opción D (reset + señal soft) en su lugar; esa
  alternativa queda descartada para esta HU, no se re-explora.
- Hard-require de wallet real (bloquear el flujo sin MetaMask/WalletConnect) — explícitamente
  PROHIBIDO por Opción D (AC-8); el jurado debe poder probar sin wallet.
- Cifrado o hashing del `address` en `KycStore`/`localStorage` — fuera de esta HU (mismo scope-out
  que WKH-181 sobre cifrado real sin key-management).
- Cualquier cambio a `InjectedWallet`/`WalletConnectWallet` — el gap es exclusivo de `FallbackWallet`;
  las wallets reales ya aíslan correctamente (WKH-181 AC-5/6/7 funcionan para ellas).
- Pantalla de historial (`ListHistory`/`listHistory` use-case) — no se construye ninguna UI de
  historial en esta HU; el reset opera sobre el KYC-once y el pending, no sobre `RemittanceRepository`.
- El demo live (`yarvis`/`wasiai-v2`, fuera de `chaski-v2/`) — NO SE TOCA (CD-1).
- Confirmación/UX del texto exacto de copy del control y del banner (queda a criterio del Architect
  en F2, dentro del lineamiento funcional de esta HU).

## Decisiones técnicas (DT-N)

- **DT-1 (forma del use-case de reset)**: se recomienda un use-case nuevo y pequeño (ej. `ForgetKyc`)
  que internamente hace `await this.kycStore.clear(address)` y delega el pending al
  `AbandonPendingKyc` existente (inyectado o llamado desde `flow.tsx` como una segunda llamada) — NO
  duplicar la lógica de `pending.clear()` en 2 use-cases distintos. El Architect define en F2 si
  `ForgetKyc` depende de `KycPendingStore` directamente o si `flow.tsx` orquesta ambas llamadas (más
  simple, ya que ambas ya están en el `Container`).
- **DT-2 (detección de FallbackWallet — constante vs nuevo método de port)**: se recomienda exportar
  una constante (`FALLBACK_WALLET_ADDRESS`) desde `wallet.ts` en lugar de agregar un método nuevo a
  `WalletPort` (ej. `getProvenance()`) — es la opción de MENOR superficie de cambio (no toca la
  interfaz de dominio del wallet, no afecta `InjectedWallet`/`WalletConnectWallet`) y suficiente para
  el único consumidor conocido (`isFallbackWalletAddress` en `flow-vm.ts`). Alternativa (agregar
  provenance al `WalletPort`) es más "correcta" arquitectónicamente pero mayor cambio para un caso de
  uso acotado — el Architect puede reconsiderar en F2 si aparece otro consumidor.
- **DT-3 (ubicación exacta del control de reset)**: se recomienda anclarlo cerca del badge de address
  en el header (`flow.tsx:272-277`), visible en cualquier `step` post-connect — es la única zona hoy
  visible independientemente del `step` activo, evitando que el control "desaparezca" según en qué
  paso del flujo esté el usuario. El Architect define el copy/interacción exacta (ej. click directo
  vs. confirmación en 2 pasos) en F2.
- **DT-4 (alcance del reset del estado React)**: el reset de esta HU limpia `address` ADEMÁS de
  `rem`/`preview` (a diferencia de `resetTo()` existente, que preserva `address` para el caso "enviar
  otra" con la misma wallet). El Architect debe decidir si introduce una variante de `resetTo()` con
  un flag (`clearAddress: boolean`) o una función nueva separada — evitar que el fix rompa el flujo
  "enviar otra" ya existente (`Receipt`'s `onNew`, línea 542/627-629), que SÍ debe seguir preservando
  `address`.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO tocar cualquier archivo fuera de `chaski-v2/`. PROHIBIDO tocar el demo live
  (`yarvis`, `wasiai-v2`, cualquier ruta bajo `agentshop-*`). Esta HU es exclusivamente
  `chaski-v2/src/{application,infrastructure,presentation}/*` según Scope IN.
- **CD-2**: PROHIBIDO implementar hard-require de wallet real — cualquier cambio que impida completar
  el flujo end-to-end sin MetaMask/WalletConnect (via `FallbackWallet`) es una regresión de Opción D
  y debe marcarse BLOQUEANTE en AR/CR (AC-8).
- **CD-3**: OBLIGATORIO que el `clear(address)` de `KycStore` esté scopeado EXCLUSIVAMENTE a la
  address recibida — PROHIBIDO cualquier implementación que borre el mapa completo o afecte otras
  entries (AC-2). Mismo criterio de scoping-por-address que WKH-181 (CD-5, case-insensitive
  `address.toLowerCase()`).
- **CD-4**: PROHIBIDO duplicar el string literal de la address demo (`0xDEMO...`) en más de un
  archivo — DEBE consumirse desde la constante exportada de `wallet.ts` (AC-9/DT-2), no
  hardcodearse de nuevo en `flow-vm.ts` o `flow.tsx`.
- **CD-5**: OBLIGATORIO que el reset degrade sin romper si `localStorage` falla (AC-5) — PROHIBIDO
  dejar una excepción no capturada que impida al usuario reconectar tras un fallo de storage.

## Missing Inputs
- `[resuelto — decisión del founder ya tomada]` Opción D confirmada (reset + señal soft, no
  pseudo-address, no hard-require). No re-abrir.
- `[NEEDS CLARIFICATION — no bloqueante, resolver en F2]` DT-3: copy/interacción exacta del control
  de reset (¿click directo con toast de confirmación, o modal de 2 pasos "¿Estás seguro?"?) — no
  especificado por el founder, el Architect/UX define un default razonable para un demo de
  hackathon (mínima fricción, sin modal pesado).
- `[NEEDS CLARIFICATION — no bloqueante, resolver en F2]` DT-4: si el reset del estado React reusa
  `resetTo()` con un flag nuevo o introduce una función separada — decisión de implementación, no
  de producto.

## Análisis de paralelismo
- Depende del estado ya mergeado de **WKH-178/179/180/181/182/183** (todas en `main`). Esta HU
  trabaja exclusivamente sobre ese estado; no reabre ningún gap ya cerrado por esas HUs.
- Toca `src/infrastructure/wallet.ts` y `src/application/ports.ts` — mismos archivos que WKH-182
  tocó (money-path robustez, ya mergeado); sin HU activa en paralelo conocida hoy que los modifique,
  bajo riesgo de colisión.
- No bloquea otras HUs conocidas del backlog. Cierra formalmente el residual AC-8 de WKH-181 (deja
  esa HU 100% resuelta, incluyendo el ítem diferido).
- Es autocontenida — no requiere coordinación de merge con ninguna otra HU activa hoy en `chaski-v2`.
- Branch: `feat/184-fallback-wallet-reset-demo-signal` desde `main`.

## Waves sugeridas (para F3, referencia — el Architect define las definitivas en F2.5)
- **Wave 1**: `ports.ts` (`KycStore.clear`) + `kyc-store.ts` (`LocalKycStore.clear` impl) + test.
- **Wave 2**: use-case nuevo (`ForgetKyc` o equivalente) + wiring en `container.ts` + test.
- **Wave 3**: `wallet.ts` (constante exportada) + `flow-vm.ts` (`isFallbackWalletAddress`) + test —
  independiente de Wave 1/2, puede ir en paralelo.
- **Wave 4**: `flow.tsx` — control de reset (consume Wave 1/2) + banner extendido de FallbackWallet
  (consume Wave 3). Depende de que Wave 1-3 estén completas.

## Evidencia de verificación F0

| Afirmación HU | Archivo:línea | Estado |
|---------------|---------------|--------|
| `FallbackWallet` devuelve constante hardcodeada | `src/infrastructure/wallet.ts:58-71` (línea 62) | CONFIRMADO |
| `KycStore` no tiene método de borrado | `src/application/ports.ts:104-107` | CONFIRMADO |
| `LocalKycStore` no implementa `clear`/`delete` | `src/infrastructure/kyc-store.ts:65-107` | CONFIRMADO |
| KYC-once se reusa vía `kycStore.get()` en `start-kyc.ts` | `src/application/use-cases/start-kyc.ts:36-41` | CONFIRMADO |
| `AbandonPendingKyc` ya existe y limpia el pending | `src/application/use-cases/abandon-pending-kyc.ts:1-11`; uso en `src/presentation/flow.tsx:128` | CONFIRMADO |
| `KycPendingStore.clear()` ya existe en el port | `src/application/ports.ts:56-60` | CONFIRMADO |
| `container.ts` ya cablea `abandonPendingKyc` (patrón a seguir) | `src/composition/container.ts:38,65` | CONFIRMADO |
| Badge de address en header, visible en cualquier step post-connect | `src/presentation/flow.tsx:272-277` | CONFIRMADO |
| Banner "Modo demo" (WKH-178) existente, condicionado a `isDemoMode(rem)` y solo en `review`/`track` | `src/presentation/flow.tsx:283-287`; `src/presentation/flow-vm.ts:4-7` | CONFIRMADO |
| `isDemoMode` no conoce nada de wallets (solo provenance de quote/kyc) | `src/presentation/flow-vm.ts:4-7` | CONFIRMADO |
| `resetTo()` existente preserva `address` (no lo limpia) | `src/presentation/flow.tsx:637-645` | CONFIRMADO |
