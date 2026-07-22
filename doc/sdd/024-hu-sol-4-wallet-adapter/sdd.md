# SDD — [HU-SOL-4 / WKH-212] Integración `@solana/wallet-adapter` (React) en chaski-v3

> SPEC_APPROVED: no
> Fase F2 (NexusAgil QUALITY). Input: `work-item.md` (aprobado, HU_APPROVED). Repo:
> `/home/ferdev/.openclaw/workspace/chaski-v3` (Next.js App Router, arquitectura hexagonal).
> SDD_MODE: full. Estimación: M. Branch sugerido: `feat/024-hu-sol-4-wallet-adapter`.
> Artefactos: `doc/sdd/024-hu-sol-4-wallet-adapter/`.

---

## 0. Resolución de los `[NEEDS CLARIFICATION]` del work-item (CERRADOS en F2)

Steers recibidos del orquestador — cerrados acá como decisiones firmes.

| # | Pregunta abierta (work-item) | **Decisión F2 (firme)** | Justificación |
|---|------------------------------|--------------------------|---------------|
| 1 | DT-4 — mecanismo del puente context→`WalletPort` (opción a: singleton que cachea `useWallet()`; opción b: promesa resuelta por el componente) | **Opción (a): un módulo singleton `solana-wallet-bridge.ts` (React-free) que un client component monta dentro del árbol de providers suscribe a `useWallet()`/`useWalletModal()`, cacheando el estado (`publicKey` base58 / `connected`) y registrando handles imperativos (`openModal`).** El `SolanaWalletAdapter` (fuera de React, instanciado en `container.ts`) LEE ese singleton. Ver **DT-SDD-1**. | Es la única opción coherente con el `WalletPort` imperativo (`connect()`/`getAddress()` se llaman desde use-cases, fuera del árbol React) + el singleton de `container.ts`. Crea un **seam** de un solo módulo entre el mundo React (heavy, `@solana/wallet-adapter-*`) y el mundo imperativo (adapter) — clave para AC-3 (§DT-SDD-5). |
| 2 | UI del modal: ¿el botón de conectar dispara el modal de `wallet-adapter-react-ui` cuando VM=solana? ¿dónde vive `WalletModalProvider`/`WalletMultiButton`? | **SÍ hay cambio de UI visible: el modal Phantom/Solflare.** Se abre **programáticamente** vía `useWalletModal().setVisible(true)` (registrado en el bridge), disparado por `SolanaWalletAdapter.connect()` — **sin tocar `flow.tsx`/`ui.tsx`**. `WalletModalProvider` vive en el árbol de providers Solana (montado SOLO con VM=solana). **NO se usa `WalletMultiButton`** (obligaría a editar la UI de conexión → riesgo AC-3). Ver **DT-SDD-4**. | El botón "Conectar wallet" existente (`flow.tsx:541-549`) ya llama `connectWallet.execute()` → `wallet.connect()`. Que `connect()` abra el modal vía el bridge deja `flow.tsx` **byte-idéntico** (AC-3) y la UI visible (el modal) la aporta 100% el árbol de providers condicional. |
| 3 | Numeración `_INDEX` (HU-SOL-4 vs HU-SOL-2) | **El spec del orquestador (wallet-adapter React) es autoritativo.** El drift de la tabla `_INDEX` L466-470 lo reconcilia el orquestador. NO afecta el diseño. | Instrucción explícita del orquestador (steer #3). No bloqueante. |

**Cero `[NEEDS CLARIFICATION]` quedan abiertos.** Ver §12 Readiness Check. Un único marcador cosmético `[TBD]` no-bloqueante se documenta en §11.

---

## 1. Resumen

Se introduce el árbol de providers `@solana/wallet-adapter-react` (`ConnectionProvider` +
`WalletProvider` + `WalletModalProvider`) en chaski-v3, **montado condicionalmente sólo cuando
`resolveActiveVm() === "solana"`**, conviviendo con el stack EVM imperativo actual
(`pickWallet()` / `InjectedWallet` / `WalletConnectWallet` / `FallbackWallet`) sin tocarlo. Un
**módulo singleton bridge** (React-free) conecta el `WalletContext` de React (Phantom/Solflare) con
un nuevo `SolanaWalletAdapter implements WalletPort`, que el resto del dominio consume por la
interfaz EXISTENTE. El wiring vive gateado en `container.ts` (dispatcher `resolveActiveVm()`, mismo
patrón que `resolveActiveNetworkConfig()` de `chain.ts:154-164`). La `address` que fluye es un
**string base58 OPACO** (case-sensitive, sin `toLowerCase`, CD-3).

**Restricción dura de toda la HU (AC-3):** con `NEXT_PUBLIC_VM` unset/`"evm"`, el path EVM queda
**byte-idéntico** — cero providers Solana montados, cero import side-effect en el bundle EVM. El
diseño lo garantiza POR CONSTRUCCIÓN vía el seam del bridge y la carga dinámica del árbol
(§DT-SDD-5). Esta HU **NO** implementa firma real SPL (HU-SOL-2), PoP Solana (HU-SOL-8) ni settle
no-custodial Solana; sólo la **conexión de wallet** (connect/getAddress con base58 real).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 024 (HU-SOL-4 / WKH-212) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Wallet Solana real (Phantom/Solflare) conectable desde la UI, puenteada al `WalletPort` imperativo, sin perturbar el path EVM. |
| **Reglas de negocio** | AC-3 regresión-cero EVM (hard); `address` base58 opaca (CD-3); providers montados sólo si VM=solana (DT-1); wiring sólo en `container.ts` (AC-4); fail-loud VM inválida (AC-5); 6 deps pinneadas (CD-5). |
| **Scope IN** | Árbol providers Solana condicional; `SolanaWalletAdapter` + bridge singleton; dispatcher en `container.ts`; wrapper `Providers` en `layout.tsx`; 6 deps pinneadas; tests. |
| **Scope OUT** | Firma real SPL (HU-SOL-2); `authorizePrincipal` real Solana; settle no-custodial Solana; PoP Solana (HU-SOL-8); cerrar `[TBD HU-SOL-2]` de `SolanaAuthorization`; cambios a `chain.ts` (solo lectura de resolvers); auditoría supply-chain (HU-SOL-25); mainnet-beta. |
| **Missing Inputs** | Ninguno bloqueante. Un `[TBD]` cosmético (label de red en el connect-card) diferido, §11. |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1**: WHEN `NEXT_PUBLIC_VM=solana` Y el usuario abre la app, THE system SHALL montar
  `ConnectionProvider` + `WalletProvider` + `WalletModalProvider` apuntando al cluster devnet
  (`resolveSolanaNetworkConfig().cluster`), con Phantom y Solflare seleccionables.
- **AC-2**: WHEN el usuario conecta Phantom/Solflare vía el modal, THE system SHALL propagar la
  `PublicKey` al `WalletPort` como string base58, de forma que `connectWallet.execute()` devuelva ese
  `address` sin transformación (mismo contrato que hoy con `0x...`).
- **AC-3**: WHILE `NEXT_PUBLIC_VM` es `"evm"` (default/unset incluido), THE system SHALL mantener el
  árbol de la app y `pickWallet()`/`InjectedWallet`/`WalletConnectWallet`/`FallbackWallet`
  **byte-idénticos** — CERO providers Solana montados, cero import side-effect que cambie el
  bundle/comportamiento EVM.
- **AC-4**: WHEN se agrega el puente (`SolanaWalletAdapter`), THE system SHALL instanciarlo ÚNICAMENTE
  en `container.ts` gateado por `resolveActiveVm() === "solana"` — ningún modo mixto silencioso.
- **AC-5**: IF `resolveActiveVm()` lanza (`unsupported_vm`), THEN THE system SHALL fallar la
  construcción (fail-loud, igual que HU-SOL-1/AC-6) — sin árbol de providers a medio montar.
- **AC-6**: WHEN `getAddress()` se llama tras `connect()` exitoso, THE system SHALL devolver el MISMO
  string base58 (case-sensitive, SIN `toLowerCase`) que devolvió `connect()`.

---

## 3. Context Map (Codebase Grounding)

**Baseline verificado**: `npm run qa` (typecheck `tsc --noEmit` + `vitest run`) = **exit 0, árbol
verde** (los `stderr` observados son `console.error` deliberados de tests de rama best-effort
`recordPrincipalIn_failed`/`recordPayoutOutcome_failed`, no fallos). El SDD parte de verde.

### 3.1 Archivos leídos (verificados con Read)

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `app/layout.tsx:1-33` | Punto de montaje del árbol de providers. Hoy `html > body > {children}` SIN wrapper de contexto (server component). | No hay `<Providers>` hoy. Se insertará un wrapper client `<Providers>{children}</Providers>` que en EVM es **passthrough transparente** (§DT-SDD-3). `RootLayout` sigue siendo server component. |
| `app/page.tsx:1-5` | Entrypoint. `<RemittanceFlow />` sin props. | El flujo se monta bajo el layout → el árbol de providers lo envuelve. `flow.tsx` hace `createContainer()` internamente. |
| `src/infrastructure/wallet.ts:1-331` | **Exemplar primario** del adapter + `pickWallet()`. **CD-1: PROHIBIDO tocar.** | (a) 3 clases `implements WalletPort` con `private address`; (b) `connect()` valida address (`isAddress`, EVM) antes de cachear; (c) `getAddress()` devuelve el campo cacheado; (d) `pickWallet()` selecciona en runtime sin React. El `SolanaWalletAdapter` copia esta forma (validación base58 en vez de `isAddress`). |
| `src/infrastructure/wallet.test.ts:1-491` | **Exemplar del test** del adapter nuevo. | Fakes de provider inyectados vía `vi.hoisted`/`vi.mock` del lazy-import; `afterEach` limpia envs; asserts por campo específico. El adapter Solana replica el patrón: fake bridge inyectado + asserts sobre `connect()`/`getAddress()` base58. |
| `src/composition/container.ts:1-134` | Único lugar que instancia adapters (AC-4). `const wallet = pickWallet()` (L79). | El wiring gateado entra ACÁ. Patrón de guard fail-loud EIP-3009 (L62-70) + singleton `getContainer()` (L129-134). El dispatcher espeja el ternario `useA2a`/`settlement`. |
| `src/application/ports.ts:218-235` | `WalletPort` — la interfaz que el adapter implementa. **CD-4: NO tocar.** | `connect(): Promise<string>`, `getAddress(): Promise<string\|null>`, `authorizePrincipal(quote, remittanceId, deposit?)`, `signMessage(message)`. El adapter Solana implementa las 4 (connect/getAddress REALES; authorizePrincipal/signMessage demo-simbólicos, §DT-SDD-6). |
| `src/application/use-cases/connect-wallet.ts:1-19` | Consumidor de `connect()`/`getAddress()`. | `execute()` = `await wallet.connect()` → `store.get(address)`. **No se toca**: el adapter Solana devuelve un base58; `KycStore` lo usa como key opaca. AC-2/AC-6 se validan por acá. |
| `src/infrastructure/chain.ts:98-164` | Resolvers Solana de HU-SOL-1 (DONE). | `resolveActiveVm()` (L121-126, `"evm"\|"solana"`, throw en inválido = AC-5); `resolveSolanaNetworkConfig()` (L129-131, `{cluster:"devnet"}`); `resolveActiveNetworkConfig()` (L154-164, **exemplar del dispatcher switch**, CD-7 sin object-injection); `resolveSolanaRpcUrl()` (L147-152, **server-only**, sin `NEXT_PUBLIC` → undefined en browser). |
| `src/presentation/flow.tsx:1-828` | UI. `onConnect` (L207-228) → `c.connectWallet.execute()`; connect-card (L520-551). **Se mantiene byte-idéntico (DT-SDD-4).** | El modal se abre vía el bridge dentro de `adapter.connect()`, NO editando `flow.tsx`. Nota: `resolveChain().name` (L537) es EVM-céntrico → label cosmético diferido (§11). |
| `src/presentation/flow.test.tsx:1` (656 líneas) | **Guardián de AC-3/CD-1.** | Docblock `// @vitest-environment jsdom` en **línea 1** (patrón per-file, sin `vitest.config`). Nunca setea `NEXT_PUBLIC_VM` → corre en rama `"evm"` → sus asserts no cambian. Usa `buildTestContainer` de `test-support/test-container.ts`. |
| `src/test-support/test-container.ts` + `fakes.ts` | Dobles de test. `FakeWallet` cubre `WalletPort`. | Para tests de componente del árbol Solana se puede reusar el patrón jsdom + fakes; el adapter Solana testea con un **bridge fake** inyectado (no necesita el árbol React). |
| `package.json:17-48` | DT-3/CD-5 (deps pinneadas). | `@solana/web3.js@^1.98.4` **ya presente** (usado por `chain.ts:6`). Las 6 nuevas AUSENTES hoy (confirmado). Resto usa `^`; las 6 nuevas van SIN `^` (CD-5). |
| `doc/sdd/023-.../sdd.md` + `.../story-HU-SOL-1.md` | Antecedente directo (HU-SOL-1). | `resolveActiveVm()`/`resolveSolanaNetworkConfig()` ya existen y verdes. Reuso, no reimplemento. |
| `doc/sdd/022/auto-blindaje.md`, `021/auto-blindaje.md` | Aprendizaje histórico (§3.3). | CDs heredados de errores recurrentes. |

### 3.2 Exemplars (verificados con Glob/Read → existen)

| Para crear/modificar | Seguir patrón de | Qué se copia |
|----------------------|------------------|--------------|
| `src/infrastructure/solana-wallet.ts` (`SolanaWalletAdapter`) | `src/infrastructure/wallet.ts` (`InjectedWallet`, L57-160) | Clase `implements WalletPort` con `private address`; `connect()` valida (base58 vía `PublicKey`, no `isAddress`) antes de cachear; `getAddress()` devuelve el cacheado. |
| `src/infrastructure/solana-wallet.test.ts` | `src/infrastructure/wallet.test.ts` (L142-205) | `describe`/`it` por AC; `afterEach` limpia env; fake inyectado; asserts por valor concreto. |
| Dispatcher en `container.ts` | `chain.ts:resolveActiveNetworkConfig()` (L154-164) | `switch (resolveActiveVm())` sin object-injection (CD-7); default throw defensivo. |
| `src/presentation/providers.tsx` (wrapper condicional) | `next/dynamic` (App Router) + `resolveActiveVm()` | Carga dinámica del árbol Solana sólo en la rama solana (§DT-SDD-5). |
| `src/presentation/solana/solana-providers.tsx` | Árbol estándar `@solana/wallet-adapter-react` (docs oficiales de la lib) + docblock `"use client"` (CD-2, patrón `flow.tsx:1`) | `ConnectionProvider`+`WalletProvider`+`WalletModalProvider` + componente de sync del bridge. |

### 3.3 Constraint Directives heredados del Auto-Blindaje histórico (últimas HUs DONE)

Leídos `022/auto-blindaje.md` (WKH-211) y `021/auto-blindaje.md` (WKH-210). Patrones recurrentes que
aplican a esta HU (ver CD-SDD-8..11 en §5):

- **CD-SDD-8** — *Importar tipos de dominio desde su módulo real, NO desde `ports`* (WKH-211 W1: `ports.ts`
  NO re-exporta `Beneficiary`/dominio → TS2459). El adapter Solana importa `WalletPort` de `ports` (correcto,
  es un port) y tipos de dominio (`Quote`) de `domain/remittance` si los necesita.
- **CD-SDD-9** — *El gate es `npm run qa` COMPLETO (typecheck + `vitest run`), NUNCA `next build`* (WKH-196/WKH-210:
  `build` excluye tests; los tests de componente jsdom se ejecutan sólo con `vitest`). Cada wave cierra con `npm run qa`.
- **CD-SDD-10** — *Tests EVM asertan por campo/valor específico, no `toEqual(objeto-entero)`* → agregar una rama VM no
  los rompe (patrón HU-SOL-1). No cambiar NINGUNA expectativa de `wallet.test.ts`/`container.test.ts`/`flow.test.tsx`.
- **CD-SDD-11** — *Mutation self-check OBLIGATORIO del guard central* (WKH-210/WKH-211 W6): montar un mutante que
  rompa el gating `resolveActiveVm()==="solana"` (ej. `=== "evm"`) y confirmar que ≥1 test muere; restaurar desde
  backup en scratchpad (NO `git checkout`); `grep -rn MUTANT src app` = 0 al cerrar.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar | Wave |
|---------|--------|-------------|----------|------|
| `package.json` | Modificar | Agregar 6 deps PINNEADAS (sin `^`): `@solana/wallet-adapter-react`, `@solana/wallet-adapter-react-ui`, `@solana/wallet-adapter-wallets`, `@solana/wallet-adapter-base`, `@solana/spl-token`, `@solana/pay`. | `package.json:17-34` | W0 |
| `src/infrastructure/solana-wallet-bridge.ts` | **Crear** | Singleton **React-free**: cachea `{ publicKey: string\|null; connected: boolean }`, registra handle `openModal()`, expone `waitForConnection()` (deferred). Sin imports de `@solana/wallet-adapter-*`. | (nuevo — seam) | W0 |
| `src/infrastructure/solana-wallet.ts` | **Crear** | `SolanaWalletAdapter implements WalletPort`. `connect()`: si conectado, devuelve base58; si no, `bridge.openModal()` + `await bridge.waitForConnection()` (timeout → throw). `getAddress()`: base58 cacheado (opaco, CD-3). `authorizePrincipal`/`signMessage`: demo-simbólicos (§DT-SDD-6). Valida base58 con `PublicKey` (no `isAddress`). | `wallet.ts:57-160` | W2 |
| `src/presentation/solana/solana-providers.tsx` | **Crear** | `"use client"`. Árbol `ConnectionProvider`(`endpoint=clusterApiUrl(cluster)`)+`WalletProvider`(`wallets=[Phantom,Solflare]`, `autoConnect`)+`WalletModalProvider`. Monta `<SolanaWalletBridgeSync/>` (usa `useWallet()`+`useWalletModal()`, empuja al singleton) + `{children}`. Importa el CSS de react-ui acá (carga sólo en solana). | docs `@solana/wallet-adapter-react`; `"use client"` de `flow.tsx:1` | W1 |
| `src/presentation/providers.tsx` | **Crear** | `"use client"`. `resolveActiveVm()==="solana"` → renderiza `<SolanaProviders>` (cargado con `next/dynamic(..., {ssr:false})`); `"evm"` → `<>{children}</>` passthrough (§DT-SDD-3/5). | `chain.ts` dispatcher | W1 |
| `app/layout.tsx` | Modificar | Envolver `{children}` en `<Providers>{children}</Providers>`. En EVM = passthrough (cero DOM/contexto nuevo). | `layout.tsx:27-32` | W1 |
| `src/composition/container.ts` | Modificar | Dispatcher: `const wallet = resolveActiveVm() === "solana" ? new SolanaWalletAdapter() : pickWallet();`. Import de `SolanaWalletAdapter` (adapter React-free → seguro para bundle EVM, §DT-SDD-5). | `container.ts:79` + `chain.ts:154-164` | W2 |
| `src/infrastructure/solana-wallet.test.ts` | **Crear** | Tests del adapter (bridge fake inyectado): AC-2 (connect abre modal + devuelve base58), AC-6 (getAddress == connect, case-sensitive), guard base58 malformado, timeout. | `wallet.test.ts` | W3 |
| `src/presentation/providers.test.tsx` | **Crear** | `// @vitest-environment jsdom` (línea 1). AC-1 (VM=solana monta el árbol) + AC-3 (VM=evm/unset → passthrough, NINGÚN provider Solana ni import del árbol). | `flow.test.tsx:1` | W3 |

**No se crea** ningún archivo fuera de esta lista. **No se toca** `wallet.ts`, `ports.ts`, `chain.ts`,
`connect-wallet.ts`, `flow.tsx`, ni ningún test EVM existente.

### 4.2 Modelo de datos

N/A — esta HU no toca BD ni persistencia. La `address` base58 fluye a `KycStore`/`RemittanceRepository`
(in-memory/local) como key opaca, sin cambios de esquema.

### 4.3 Arquitectura de la solución — el **seam** del bridge

```
  ┌─────────────────────────── Mundo React (SOLO montado si VM=solana) ───────────────────────────┐
  │  app/layout.tsx                                                                                │
  │    └─ <Providers>            (client, passthrough en EVM)                                      │
  │         └─ next/dynamic → <SolanaProviders>   (chunk cargado SÓLO en solana)                  │
  │              ConnectionProvider(endpoint=clusterApiUrl('devnet'))                              │
  │                WalletProvider(wallets=[Phantom,Solflare], autoConnect)                         │
  │                  WalletModalProvider                                                           │
  │                    ├─ <SolanaWalletBridgeSync/>  ── useWallet()/useWalletModal() ──┐           │
  │                    └─ {children}  (= <RemittanceFlow/>)                            │           │
  └───────────────────────────────────────────────────────────────────────────────────┼──────────┘
                                                                                        │ push state
                                            ┌───────────────────────────────────────────▼──────────┐
                                            │  solana-wallet-bridge.ts  (SINGLETON, React-free)     │
                                            │   state: { publicKey(base58) | null, connected }      │
                                            │   openModal(): registrado por el sync component        │
                                            │   waitForConnection(): Promise (deferred)              │
                                            └───────────────────────────────────────────▲──────────┘
                                                                                        │ read/openModal
  ┌─────────────────────────── Mundo imperativo (SIEMPRE compilado, sin @wallet-adapter) ┼─────────┐
  │  container.ts → resolveActiveVm()==="solana" ? new SolanaWalletAdapter() : pickWallet()         │
  │  SolanaWalletAdapter implements WalletPort → LEE el singleton (connect/getAddress base58)        │
  └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Regla del seam (crítica para AC-3):** el `SolanaWalletAdapter` y el `bridge` **NUNCA importan**
`@solana/wallet-adapter-*` — sólo el árbol de providers (`solana-providers.tsx`) lo hace, y ese módulo
sólo se alcanza por el `next/dynamic` gateado por `resolveActiveVm()==="solana"`. Por eso `container.ts`
puede importar el adapter estáticamente sin arrastrar la lib Solana al bundle EVM.

### 4.4 Flujo principal (Happy Path — VM=solana)

1. `NEXT_PUBLIC_VM=solana`. `layout.tsx` renderiza `<Providers>` → `resolveActiveVm()==="solana"` →
   `next/dynamic` carga `<SolanaProviders>` → monta `ConnectionProvider`/`WalletProvider`/
   `WalletModalProvider` + `<SolanaWalletBridgeSync/>` (AC-1).
2. `<SolanaWalletBridgeSync/>` registra `openModal` (`useWalletModal().setVisible`) en el singleton y,
   vía `useEffect([publicKey,connected])`, empuja el estado (`publicKey.toBase58()`) al singleton.
3. Usuario avanza a `connect` y toca "Conectar wallet" → `onConnect` → `connectWallet.execute()` →
   `SolanaWalletAdapter.connect()`.
4. `connect()`: no conectado → `bridge.openModal()` (abre el modal Phantom/Solflare, AC-2) +
   `await bridge.waitForConnection()`.
5. Usuario elige Phantom → adapter-react conecta → el sync component empuja `publicKey` base58 →
   `waitForConnection()` resuelve → `connect()` valida base58 (`new PublicKey(str)`) y cachea → devuelve
   el base58 **sin transformar** (AC-2/CD-3).
6. `connectWallet.execute()` sigue igual que EVM: `store.get(address)` con el base58 como key opaca.
7. `getAddress()` posterior devuelve el MISMO base58 case-sensitive (AC-6).

### 4.5 Flujo de error

- VM inválida (`NEXT_PUBLIC_VM="aptos"`): `resolveActiveVm()` lanza `unsupported_vm` tanto en
  `container.ts` (construcción) como en `<Providers>` → fail-loud, sin árbol a medio montar (AC-5).
- Usuario cierra el modal sin conectar / timeout: `waitForConnection()` rechaza (`wallet_connect_timeout`
  o `wallet_connect_cancelled`) → `connect()` throw → `flow.tsx guard()` (L183-193) lo captura y muestra
  `humanError` (path de error EXISTENTE, sin cambios).
- Base58 malformado devuelto por el bridge (defensa en profundidad): `connect()` lanza `invalid_address`
  antes de cachear (espeja el guard `isAddress` de `InjectedWallet:66`).

### 4.6 Microcopy

Ningún copy nuevo en esta HU (el modal usa los textos de `@solana/wallet-adapter-react-ui`).
`flow.tsx` no se toca. El label de red del connect-card (`resolveChain().name` → "Base Sepolia") queda
EVM-céntrico también en solana — **cosmético, diferido** (§11, `[TBD]` no-bloqueante).

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-SDD-1** (= CD-1 work-item): con VM unset/`"evm"`, path EVM **byte-idéntico**. Ningún test EVM
  (`wallet.test.ts`, `container.test.ts`, `flow.test.tsx`) cambia de expectativa.
- **CD-SDD-2** (= CD-2): TODO provider/hook de `@solana/wallet-adapter-react` vive bajo `"use client"`
  (`solana-providers.tsx`, `providers.tsx`). Ningún import de la lib en un server component.
- **CD-SDD-3** (= CD-3): la `address` base58 es OPACA (string) — SIN `.toLowerCase()` ni normalizador
  EVM. Solana base58 es case-sensitive.
- **CD-SDD-4** (= CD-5): las 6 deps nuevas PINNEADAS (sin `^`/`~`).
- **CD-SDD-5** — Validar base58 con `new PublicKey()` de `@solana/web3.js` (ya presente), **NUNCA**
  `isAddress` de viem (mismo criterio que `resolveSolanaUsdcMint`, `chain.ts:139`).
- **CD-SDD-8..11** — heredados del Auto-Blindaje (§3.3): tipos de dominio desde su módulo; gate =
  `npm run qa` completo; asserts por valor; mutation self-check del gating.

### PROHIBIDO
- **CD-SDD-6** (= CD-4): PROHIBIDO tocar `WalletPort` (`ports.ts:218-235`). El adapter implementa la
  interfaz EXISTENTE. En esta HU `authorizePrincipal`/`signMessage` del adapter Solana son
  **demo-simbólicos** (retornan un `tx`/firma sintética como `FallbackWallet:173-179`) — la firma real
  SPL es HU-SOL-2 y el PoP es HU-SOL-8 (Scope OUT). NO se inventa firma real.
- **CD-SDD-7**: PROHIBIDO tocar `wallet.ts`, `pickWallet()`, `chain.ts` (salvo LEER resolvers),
  `connect-wallet.ts`, `flow.tsx`/`ui.tsx`, `ports.ts`.
- PROHIBIDO montar el árbol Solana incondicionalmente (DT-1): siempre gateado por `resolveActiveVm()`.
- PROHIBIDO importar `@solana/wallet-adapter-*` desde `container.ts`, `solana-wallet.ts` o
  `solana-wallet-bridge.ts` (rompería el seam AC-3, §DT-SDD-5).
- PROHIBIDO usar `resolveSolanaRpcUrl()` como endpoint del `ConnectionProvider` (es **server-only**,
  undefined en browser) — el endpoint sale de `clusterApiUrl(resolveSolanaNetworkConfig().cluster)`.
- PROHIBIDO agregar deps fuera de las 6 listadas; PROHIBIDO usar `^`/`~` en ellas.
- PROHIBIDO usar `WalletMultiButton` en `flow.tsx` (obligaría a editar la UI → riesgo AC-3). El modal
  se abre programáticamente vía el bridge.

---

## 6. Decisiones Técnicas (DT-SDD-N) — mapeo a DT-1..4 del work-item

### DT-SDD-1 — Puente = singleton bridge (resuelve DT-4 opción **a**)
`solana-wallet-bridge.ts` es un módulo singleton React-free con: (1) `state {publicKey, connected}`;
(2) `setState()` que llama el sync component en cada cambio de `useWallet()`; (3) `openModal()` handle
registrado por el sync component (captura `useWalletModal().setVisible`); (4) `waitForConnection()` que
devuelve una promesa (deferred) resuelta cuando `state` transiciona a `connected && publicKey`. El
`SolanaWalletAdapter` (fuera de React) lo lee. **Justificación**: es el único mecanismo compatible con
`WalletPort` imperativo llamado desde use-cases + el singleton de `container.ts`. La opción (b)
(promesa resuelta por el componente vía ref) requeriría que el componente React conociera el ciclo de
vida del use-case → acopla presentación a aplicación; (a) mantiene la inversión de dependencia.

### DT-SDD-2 — Dispatcher de wallet en `container.ts` (resuelve DT-2, AC-4)
`const wallet = resolveActiveVm() === "solana" ? new SolanaWalletAdapter() : pickWallet();` — mismo
patrón dispatcher que `resolveActiveNetworkConfig()` (`chain.ts:154-164`). `pickWallet()` sigue EVM-only
e intacto. Un solo `resolveActiveVm()` gobierna wallet **y** (a futuro) config → imposible modo mixto
silencioso (AC-4): ambos leen la misma fuente. Es el análogo del guard fail-loud EIP-3009.

### DT-SDD-3 — `<Providers>` passthrough transparente en EVM (AC-3)
`providers.tsx` en la rama `"evm"` devuelve `<>{children}</>` — cero nodos DOM, cero contexto, cero
provider Solana. El árbol React renderizado es efectivamente idéntico al actual (un Fragment no altera
la hidratación). `layout.tsx` sólo gana un wrapper client transparente. AC-3 (árbol de la app
byte-idéntico) se cumple: no se monta NINGÚN provider Solana con VM=evm.

### DT-SDD-4 — Modal programático, `flow.tsx` byte-idéntico (resuelve steer #2, AC-3)
El modal se abre desde `SolanaWalletAdapter.connect()` → `bridge.openModal()` → `setVisible(true)`. El
botón "Conectar wallet" y `onConnect` de `flow.tsx` **no cambian**. La UI visible (modal Phantom/Solflare)
la aporta 100% `WalletModalProvider` (montado sólo en solana). Cero churn en `flow.tsx`/`ui.tsx` →
AC-3/CD-1 airtight en la capa de presentación.

### DT-SDD-5 — Carga dinámica + seam = cero side-effect EVM (AC-3, el núcleo)
Dos capas de aislamiento: (1) el **árbol React** (heavy, `@solana/wallet-adapter-*` + CSS) se importa
SÓLO vía `next/dynamic(() => import("./solana/solana-providers"), {ssr:false})`, alcanzado únicamente en
la rama `resolveActiveVm()==="solana"` → en EVM el chunk **nunca se carga** (cero import side-effect,
cero cambio de bundle observable en runtime EVM). (2) El **adapter + bridge** son React-free y no
importan la lib → `container.ts` los importa estáticamente sin arrastrar Solana al bundle EVM. El único
acoplamiento entre ambos mundos es el singleton bridge (plain TS). Esto es lo que hace AC-3 verdadero
**por construcción**, no por convención.

### DT-SDD-6 — `authorizePrincipal`/`signMessage` demo-simbólicos en esta HU (Scope OUT)
El adapter Solana implementa las 4 firmas de `WalletPort`, pero sólo `connect()`/`getAddress()` son
reales. `authorizePrincipal()` devuelve `{ tx: "solana-demo-..." }` y `signMessage()` una firma
sintética (espejo de `FallbackWallet`), porque la firma real SPL (HU-SOL-2) y el PoP (HU-SOL-8) están
fuera de scope. `NEXT_PUBLIC_EIP3009_ENABLED` es EVM-money-path y permanece OFF en solana (demo
byte-idéntico). Esto satisface el contrato del port sin inventar firma real (CD-SDD-6).

### DT-SDD-7 — Deps `@solana/spl-token` y `@solana/pay` se agregan pinneadas pero NO se usan aún
Las 6 deps del Scope IN se agregan pinneadas por coordinación supply-chain (HU-SOL-25). `spl-token` y
`pay` son para la firma/transfer SPL de HU-SOL-2 — se instalan ahora, sin import en esta HU. Documentado
para que AR/QA no lo marquen como dead-dep: es staging deliberado, no drift.

---

## 7. Scope

**IN:** árbol de providers Solana condicional; `SolanaWalletAdapter` + `solana-wallet-bridge`; wrapper
`Providers` + edición mínima de `layout.tsx`; dispatcher en `container.ts`; 6 deps pinneadas; tests del
adapter + del gating de providers.

**OUT:** firma real SPL (HU-SOL-2); `authorizePrincipal`/settle no-custodial Solana; PoP Solana
(HU-SOL-8); cerrar `[TBD HU-SOL-2]` de `SolanaAuthorization`; cambios a `chain.ts`/`ports.ts`/`wallet.ts`;
auditoría supply-chain (HU-SOL-25); mainnet-beta; polish del label de red del connect-card (§11).

---

## 8. Plan de Implementación (Waves)

> Cada wave cierra con `npm run qa` (typecheck + `vitest run`) **verde** (CD-SDD-9). En W0/W1/W2 con
> `NEXT_PUBLIC_VM` unset → los tests corren en rama EVM y deben quedar byte-idénticos (AC-3).

### Wave 0 (Serial Gate — contratos/andamiaje, EVM verde)
- **W0.1**: `package.json` — agregar las 6 deps PINNEADAS (CD-SDD-4). `npm install`. Verificar que el
  lockfile resuelve versiones compatibles entre los hermanos `@solana/wallet-adapter-*` (DT-3: pinneo
  coordinado). → gate: `npm run qa` verde (deps instaladas, nada montado aún).
- **W0.2**: crear `solana-wallet-bridge.ts` (singleton React-free: state + `openModal` handle +
  `waitForConnection` deferred). Sin montar nada, sin React, sin `@solana/wallet-adapter-*`.
- **Gate W0**: `npm run qa` verde. EVM 100% intacto (el bridge no se referencia aún).

### Wave 1 (Árbol de providers condicional — client boundary)
- **W1.1**: `src/presentation/solana/solana-providers.tsx` (`"use client"`): árbol
  `ConnectionProvider`(`endpoint=clusterApiUrl(resolveSolanaNetworkConfig().cluster)`)+`WalletProvider`
  (`wallets=[PhantomWalletAdapter, SolflareWalletAdapter]`, `autoConnect`)+`WalletModalProvider` +
  `<SolanaWalletBridgeSync/>` (registra `openModal`, empuja `publicKey.toBase58()`/`connected` al
  singleton) + `{children}`. Import del CSS de react-ui acá.
- **W1.2**: `src/presentation/providers.tsx` (`"use client"`): `resolveActiveVm()==="solana"` →
  `<SolanaProviders>` (vía `next/dynamic`, `ssr:false`); else `<>{children}</>` (DT-SDD-3).
- **W1.3**: `app/layout.tsx` — envolver `{children}` en `<Providers>`.
- **Gate W1**: `npm run qa` verde. Con VM unset: `Providers` = passthrough (§DT-SDD-3/5), chunk Solana
  no cargado → EVM byte-idéntico.

### Wave 2 (Adapter + wiring gateado)
- **W2.1**: `src/infrastructure/solana-wallet.ts` — `SolanaWalletAdapter implements WalletPort`:
  `connect()` (bridge.openModal + waitForConnection + validación base58 + cache), `getAddress()` (base58
  opaco, CD-3), `authorizePrincipal`/`signMessage` demo-simbólicos (DT-SDD-6). React-free.
- **W2.2**: `container.ts` — dispatcher `resolveActiveVm()==="solana" ? new SolanaWalletAdapter() :
  pickWallet()` (DT-SDD-2, AC-4). Import estático del adapter (seam-safe, §DT-SDD-5).
- **Gate W2**: `npm run qa` verde. `container.test.ts` (VM unset → evm) intacto.

### Wave 3 (Tests + verificación)
- **W3.1**: `src/infrastructure/solana-wallet.test.ts` (bridge fake inyectado): AC-2, AC-6, guard base58
  malformado, timeout/cancel.
- **W3.2**: `src/presentation/providers.test.tsx` (`// @vitest-environment jsdom` línea 1): AC-1
  (VM=solana monta el árbol) + AC-3 (VM=evm/unset → passthrough, NINGÚN provider Solana).
- **W3.3**: regresión EVM — correr `wallet.test.ts`/`container.test.ts`/`flow.test.tsx` sin cambios de
  expectativa (AC-3/CD-1). Confirmar 0 diffs de expectativa.
- **W3.4**: **Mutation self-check** (CD-SDD-11): mutar el gating (`=== "solana"` → `=== "evm"`),
  confirmar que ≥1 test de `providers.test.tsx`/`container` muere; restaurar desde backup en scratchpad;
  `grep -rn MUTANT src app` = 0.
- **Gate W3**: `npm run qa` verde full.

---

## 9. Test Plan

| Test (archivo) | AC / CD que cubre | Wave | Framework |
|----------------|-------------------|------|-----------|
| `solana-wallet.test.ts` — `connect()` abre modal (bridge.openModal llamado) + devuelve base58 del bridge sin transformar | AC-2, CD-3 | W3 | vitest (node) |
| `solana-wallet.test.ts` — `getAddress()` tras `connect()` == mismo base58, **case-sensitive** (ej. `"So1anA...Xz"` no se lowercasea) | AC-6, CD-3 | W3 | vitest (node) |
| `solana-wallet.test.ts` — base58 malformado del bridge → `throw invalid_address` sin cachear (defensa) | CD-SDD-5 | W3 | vitest (node) |
| `solana-wallet.test.ts` — modal cerrado/timeout → `waitForConnection` rechaza → `connect()` throw | 4.5 error | W3 | vitest (node) |
| `providers.test.tsx` — VM=solana → monta `ConnectionProvider`/`WalletProvider`/`WalletModalProvider` (Phantom/Solflare disponibles) | AC-1 | W3 | vitest (jsdom) |
| `providers.test.tsx` — VM=evm/unset → `<Providers>` renderiza `{children}` sin NINGÚN provider Solana ni carga del chunk | AC-3, CD-SDD-1 | W3 | vitest (jsdom) |
| `wallet.test.ts` (existente, sin cambios) — todos los tests EVM VERDES, misma expectativa | **AC-3, CD-1, CD-SDD-10** | W3 | vitest (node) |
| `container.test.ts` (existente, sin cambios) — VM unset → `pickWallet()` (evm), wiring intacto | AC-3, CD-1 | W3 | vitest |
| `flow.test.tsx` (existente, sin cambios) — flujo EVM byte-idéntico | AC-3, CD-1 | W3 | vitest (jsdom) |
| Mutation self-check del gating `resolveActiveVm()==="solana"` | AC-4, CD-SDD-11 | W3 | manual + vitest |

**Cobertura por AC**: AC-1 → `providers.test.tsx`; AC-2 → `solana-wallet.test.ts`; **AC-3/CD-1 → todos
los tests EVM existentes verdes sin cambio de expectativa** + `providers.test.tsx` (passthrough); AC-4 →
mutation self-check + `container`; AC-5 → cubierto por `resolveActiveVm()` (ya testeado en HU-SOL-1;
verificación cruzada de que ni container ni providers quedan a medio montar); **AC-6 →
`solana-wallet.test.ts` (base58 case-sensitive)**.

---

## 10. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Import estático del árbol Solana filtra `@solana/wallet-adapter-*` al bundle EVM (rompe AC-3) | M | A | Seam: adapter/bridge React-free + árbol sólo vía `next/dynamic` gateado (DT-SDD-5). `providers.test.tsx` verifica passthrough. |
| Versiones incompatibles entre hermanos `@solana/wallet-adapter-*` | M | M | Pin coordinado (DT-3/CD-SDD-4); W0.1 verifica que el lockfile resuelve un set compatible antes de avanzar. |
| `connect()` (imperativo) no resuelve porque el modal/estado vive en React | M | A | `waitForConnection()` deferred + `openModal` handle registrado por el sync component (DT-SDD-1). Test de timeout. |
| `ConnectionProvider` sin endpoint (server-only RPC undefined en browser) | B | M | Endpoint = `clusterApiUrl(cluster)`, no `resolveSolanaRpcUrl()` (CD-SDD prohibición explícita). |
| Tocar `flow.tsx` y romper `flow.test.tsx` | B | A | DT-SDD-4: `flow.tsx` byte-idéntico; modal programático vía bridge. |
| `container.test.ts` rompe por el nuevo import/dispatcher | B | M | Dispatcher sólo cambia comportamiento con VM=solana; VM unset → rama `pickWallet()` idéntica (CD-SDD-10). |

---

## 11. Missing Inputs / Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| `[TBD]` | §4.6 / §7 | El connect-card muestra `resolveChain().name` ("Base Sepolia") también en VM=solana (label EVM-céntrico). Polir el label para Solana obligaría a editar `flow.tsx` (riesgo AC-3). **Diferido** a HU-SOL-2 o un follow-up cosmético mínimo. La conexión funciona correctamente; sólo el texto de red es impreciso. | **No** |

Cero `[NEEDS CLARIFICATION]`. El único `[TBD]` es cosmético y explícitamente fuera de scope.

---

## 12. Implementation Readiness Check

```
[x] Cada AC tiene ≥1 archivo asociado en §4.1 y ≥1 test en §9
    AC-1→providers.tsx/test · AC-2/AC-6→solana-wallet.ts/test · AC-3→passthrough+tests EVM existentes
    AC-4→container.ts+mutation · AC-5→resolveActiveVm() (HU-SOL-1) + gating container/providers
[x] Cada archivo en §4.1 tiene Exemplar verificado con Glob/Read (§3.2)
[x] No hay [NEEDS CLARIFICATION] pendientes (los 3 steers cerrados en §0)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (§5: 7 PROHIBIDO)
[x] Context Map tiene ≥2 archivos leídos (§3.1: 13 archivos)
[x] Scope IN y OUT explícitos y no ambiguos (§7)
[x] BD: N/A (sin cambios de esquema) — declarado §4.2
[x] Flujo principal (Happy Path) completo (§4.4)
[x] Flujo de error definido (§4.5: VM inválida, timeout/cancel, base58 malformado)
[x] Baseline verde confirmado (npm run qa exit 0)
[x] Auto-Blindaje histórico leído → CD-SDD-8..11 heredados (§3.3)
[x] AC-3 (regresión-cero EVM) garantizada por construcción (seam + dynamic import, DT-SDD-5)
```

**No blockers.** SDD listo para `SPEC_APPROVED`.

---

*SDD generado por NexusAgil — FULL — HU-SOL-4 / WKH-212*
