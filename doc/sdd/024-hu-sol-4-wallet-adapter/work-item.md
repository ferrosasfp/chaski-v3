# Work Item — [HU-SOL-4 / WKH-212] chaski-v3: integración `@solana/wallet-adapter` (React)

## Resumen
Introduce el árbol de providers `@solana/wallet-adapter-react` (ConnectionProvider +
WalletProvider + WalletModalProvider) en la UI de chaski-v3, conviviendo con el stack EVM
imperativo actual (`pickWallet()` / `WalletPort`), y construye el puente entre el `WalletContext`
de React (Phantom/Solflare) y el `WalletPort` que consume el resto del dominio. Es la HU que le da
a HU-SOL-1 (config multi-VM, DONE) una wallet Solana real conectable desde la UI. Sprint 2 del
programa Solana LATAM Labs.

## Grounding (F0)

- **Stack EVM de wallet hoy — 100% imperativo, SIN provider tree**: `app/layout.tsx` (`RootLayout`)
  renderiza `{children}` sin ningún wrapper de contexto (`html > body > children`, línea 27-32,
  sin `<Providers>`). NO existe `WagmiProvider`, `ConnectKitProvider` ni ningún otro árbol de
  contexto de wallet en el repo (`Glob **/providers*.tsx` = 0 resultados). `wagmi`/`viem` están en
  `package.json` pero `wagmi` no se usa como provider — `viem` sí se usa directo
  (`createWalletClient`, `custom`) dentro de `src/infrastructure/wallet.ts`.
- **`pickWallet()`** (`src/infrastructure/wallet.ts:326-331`) selecciona en runtime, SIN contexto
  React: `InjectedWallet` (si `window.ethereum` existe, MetaMask/Rabby vía viem
  `createWalletClient` + `custom`), `WalletConnectWallet` (si hay
  `NEXT_PUBLIC_REOWN_PROJECT_ID`, lazy-import de `@walletconnect/ethereum-provider`), o
  `FallbackWallet` (demo, si ninguna de las anteriores). El `Container` (composition root,
  `src/composition/container.ts:79`) llama `pickWallet()` UNA vez (`getContainer()` singleton,
  línea 129-134) y esa instancia de `WalletPort` fluye a todos los use-cases.
- **`WalletPort`** (`src/application/ports.ts:218-235`): `connect(): Promise<string>`,
  `getAddress(): Promise<string | null>`, `authorizePrincipal(quote, remittanceId, deposit?)`,
  `signMessage(message: string): Promise<string>`. El `address` que devuelve `connect()` es lo que
  el resto del dominio usa como "login" (KYC-once por address, ownership de remesas, PoP). Hoy
  SIEMPRE devuelve una address EVM `0x...` (validada con `isAddress` de viem en los 2 adapters
  reales).
- **`VmAuthorization`** (`ports.ts:134-159`, HU-SOL-1/WKH-206 DONE): unión discriminada
  `EvmAuthorization | SolanaAuthorization` a nivel ENVELOPE. `SolanaAuthorization` (línea 150-157)
  YA es un placeholder de TIPOS (`vm: "solana"`, `from`/`to` base58, `amount` uint64 string,
  `recentBlockhash`, `signature` base58) — SIN lógica de firma/verificación, marcado
  `[TBD HU-SOL-2]` en varios campos. Esta HU NO cierra esos `[TBD]` (son de HU-SOL-2, firma SPL).
- **`chain.ts`** (HU-SOL-1 DONE): `resolveActiveVm()` (líneas 121-126) lee `NEXT_PUBLIC_VM`
  (`"evm"` default / `"solana"` / throw en cualquier otro valor). `resolveSolanaNetworkConfig()`
  devuelve devnet (única entrada), `resolveSolanaUsdcMint()` valida con `PublicKey` de
  `@solana/web3.js` (NUNCA `isAddress` de viem — CD-6 de esa HU). `@solana/web3.js` YA está en
  `dependencies` (`^1.98.4`).
- **Composition root**: `container.ts` es el ÚNICO lugar que instancia adapters concretos
  (comentario línea 1-3). Cualquier wiring de un `SolanaWalletAdapter` (nueva clase que implemente
  `WalletPort` puenteando el context de `@solana/wallet-adapter-react`) tiene que entrar ACÁ,
  gateado por `resolveActiveVm()`.
- **Tests**: `vitest run` (`npm run test`), `test:core` acota a `src/domain` + `src/application`
  (sin infra/presentation). `src/infrastructure/wallet.test.ts` ya existe y cubre
  `InjectedWallet`/`FallbackWallet`/`WalletConnectWallet`/`pickWallet()` — es el patrón a replicar
  para el adapter Solana nuevo. No hay `vitest.config.ts` propio; los tests de componente usan el
  docblock `// @vitest-environment jsdom` per-file (patrón de WKH-185).
- **Deps a agregar** (ninguna instalada hoy — confirmado negativo en `package.json`):
  `@solana/wallet-adapter-react`, `@solana/wallet-adapter-react-ui`,
  `@solana/wallet-adapter-wallets`, `@solana/wallet-adapter-base`, `@solana/spl-token`,
  `@solana/pay`. Pinneadas (sin `^`), coordinado con HU-SOL-25 (supply-chain, fuera de esta HU).

## Sizing
- SDD_MODE: full
- Estimación: M
- Branch sugerido: `feat/024-hu-sol-4-wallet-adapter`

## Acceptance Criteria (EARS)

- AC-1: WHEN `NEXT_PUBLIC_VM=solana` Y el usuario abre la app, the system SHALL montar el árbol
  `ConnectionProvider` + `WalletProvider` + `WalletModalProvider` de `@solana/wallet-adapter-react`
  apuntando al cluster devnet resuelto por `resolveSolanaNetworkConfig()` (HU-SOL-1), con Phantom y
  Solflare disponibles como wallets seleccionables.
- AC-2: WHEN el usuario conecta Phantom o Solflare vía el modal del wallet-adapter, the system
  SHALL propagar la `PublicKey` conectada al `WalletPort` (vía el adapter puente) como un string
  base58, de forma que `connectWallet.execute()` (`ConnectWallet`, `application/use-cases/
  connect-wallet.ts`) devuelva ese `address` sin transformación adicional (mismo contrato que hoy
  con `0x...` EVM).
- AC-3: WHILE `NEXT_PUBLIC_VM` es `"evm"` (default, unset incluido), the system SHALL mantener el
  árbol de la app y el comportamiento de `pickWallet()`/`InjectedWallet`/`WalletConnectWallet`/
  `FallbackWallet` byte-idénticos a hoy — CERO providers de Solana montados, cero import
  side-effect que cambie el bundle/comportamiento del path EVM (regresión cero, AC central).
- AC-4: WHEN se agrega el puente context→`WalletPort` (nuevo adapter, ej. `SolanaWalletAdapter`
  implementando `WalletPort`), the system SHALL ser instanciado ÚNICAMENTE en `container.ts`
  (composition root) gateado por `resolveActiveVm() === "solana"`, preservando el mismo patrón que
  el guard fail-loud de EIP-3009 (CD-3/CD-4 de WKH-186/211): ningún modo mixto silencioso
  EVM-wallet + Solana-config o viceversa.
- AC-5: IF `resolveActiveVm()` lanza (`"unsupported_vm"`, valor de `NEXT_PUBLIC_VM` inválido),
  THEN the system SHALL fallar la construcción del container (fail-loud, misma semántica que
  HU-SOL-1/AC-6) — no debe quedar en un estado con árbol de providers a medio montar.
- AC-6: WHEN `getAddress()` se llama sobre el `WalletPort` Solana tras un `connect()` exitoso, the
  system SHALL devolver el mismo string base58 (case-sensitive, SIN normalización a lowercase —
  a diferencia de EVM, Solana base58 es case-sensitive) que `connect()` devolvió — regresión-cero
  respecto al contrato `getAddress()` que hoy usan `KycStore`/`RemittanceRepository` (scoping
  case-insensitive EVM-específico, `ports.ts:261-265`, NO debe romperse ni asumirse para Solana).

## Scope IN
- Árbol de providers `@solana/wallet-adapter-react` (`ConnectionProvider`, `WalletProvider`,
  `WalletModalProvider`), montado condicionalmente por `resolveActiveVm()`.
- Nuevo archivo(s) de infraestructura: adapter que implementa `WalletPort` puenteando el
  `WalletContext` de React hacia el patrón imperativo (`connect()`/`getAddress()`) que consume
  `container.ts` — arquitectura exacta (hook + módulo singleton vs. Context API completo) es
  decisión de F2 (Architect).
- Wiring en `container.ts` gateado por `resolveActiveVm()`.
- Deps nuevas en `package.json` (pinneadas): `@solana/wallet-adapter-react`,
  `@solana/wallet-adapter-react-ui`, `@solana/wallet-adapter-wallets`,
  `@solana/wallet-adapter-base`, `@solana/spl-token`, `@solana/pay`.
- Tests unitarios/componente del adapter nuevo (mismo patrón que `wallet.test.ts`).
- `app/layout.tsx` (o un wrapper `Providers` nuevo) si el árbol de providers requiere un client
  component boundary (Next App Router: `ConnectionProvider`/`WalletProvider` son client-only).

## Scope OUT
- Firma real de transacciones Solana / SPL token transfer (**HU-SOL-2**).
- `authorizePrincipal()` real para Solana, binding no-custodial, settle on-chain Solana
  (**HU-SOL-4 real / equivalente WKH-211+WKH-168 del lado Solana** — nota: el roadmap del programa
  en `_INDEX.md` L466-470 nombra "HU-SOL-4" para ESE alcance (binding+settle); ver
  `[NEEDS CLARIFICATION]` abajo sobre el desalineamiento de numeración).
- Proof-of-Possession (SIWE-equivalente) para Solana (**HU-SOL-8**, mencionada en la tarea del
  orquestador).
- Cerrar los `[TBD HU-SOL-2]` de `SolanaAuthorization` (`ports.ts:150-157`).
- Cualquier cambio al `NetworkConfig`/`SolanaNetworkConfig` de `chain.ts` (HU-SOL-1, ya DONE) salvo
  lectura de los resolvers existentes.
- Auditoría de supply-chain de las deps nuevas (**HU-SOL-25**, mencionada explícitamente en la
  tarea del orquestador) — esta HU solo las agrega pinneadas, no las audita.
- Mainnet-beta Solana (solo devnet, config ya resuelta por HU-SOL-1).

## Decisiones técnicas (DT-N)
- DT-1: El árbol de providers Solana se monta SOLO cuando `NEXT_PUBLIC_VM === "solana"` — nunca
  incondicionalmente. Justificación: AC-3 (regresión cero EVM) es la restricción dura de toda la
  HU; un provider tree montado siempre (aunque inerte) arriesga side-effects de bundle/hidratación
  en el 100% de los deploys EVM actuales (todos, hoy).
- DT-2: El puente `WalletPort` Solana es un ADAPTER nuevo (ej. `SolanaWalletAdapter`), NO una
  reescritura de `WalletPort` ni de `pickWallet()`. `pickWallet()` sigue siendo EVM-only; el
  `container.ts` decide entre `pickWallet()` (evm) y el adapter Solana nuevo según
  `resolveActiveVm()` — mismo patrón de dispatcher que `resolveActiveNetworkConfig()` en
  `chain.ts:154-164`.
- DT-3: Deps del wallet-adapter PINNEADAS (sin `^`), a diferencia del resto de `package.json` que
  usa rangos `^`. Justificación: coordinación explícita pedida por el orquestador con HU-SOL-25
  (supply-chain) — el ecosistema `@solana/wallet-adapter-*` tiene un historial de incompatibilidades
  entre versiones minor de sus paquetes hermanos (react/react-ui/wallets/base deben matchear).
- DT-4: [NEEDS CLARIFICATION — decisión de F2] Mecanismo exacto del puente context→imperativo:
  (a) un módulo singleton que se suscribe al hook `useWallet()` desde un client component y
  cachea el estado más reciente para que `connect()`/`getAddress()` (llamados desde use-cases,
  fuera de React) lo lean; o (b) exponer `connect()` como una promesa que el propio componente
  React resuelve (ej. via un ref/callback registrado). Ambas opciones son viables; el Architect
  decide en F2 con el detalle de cómo `RemittanceFlow` (`presentation/flow.tsx`) invoca
  `connectWallet.execute()` hoy.

## Constraint Directives (CD-N)
- CD-1: OBLIGATORIO — con `NEXT_PUBLIC_VM` unset o `"evm"`, el bundle/comportamiento del path EVM
  (`pickWallet`, `InjectedWallet`, `WalletConnectWallet`, `FallbackWallet`, `container.ts` línea
  79) queda BYTE-IDÉNTICO a hoy. Ningún test EVM existente (`wallet.test.ts`,
  `container.test.ts`, `flow.test.tsx`) cambia de expectativa.
- CD-2: PROHIBIDO instanciar cualquier provider/hook de `@solana/wallet-adapter-react` fuera de un
  client component boundary (`"use client"`) — Next App Router server components no pueden usar
  esos hooks; un import mal ubicado rompe el build, no solo el runtime.
- CD-3: OBLIGATORIO — el `address` base58 que fluye desde el `WalletPort` Solana hacia
  `ConnectWallet`/`KycStore`/`RemittanceRepository` se trata como OPACO (string), SIN aplicar
  `.toLowerCase()` ni ningún otro normalizador EVM-específico (Solana base58 es case-sensitive;
  normalizar rompería la identidad de la wallet).
- CD-4: PROHIBIDO tocar `WalletPort` (la interfaz en `ports.ts:218-235`) en esta HU salvo que F2
  determine que es estrictamente necesario para el puente — preferir un adapter que implemente la
  interfaz EXISTENTE sin cambiarla (mismo criterio conservador que HU-SOL-1 aplicó a
  `Eip3009Authorization`).
- CD-5: OBLIGATORIO — las 6 deps nuevas se agregan PINNEADAS (sin `^` ni `~`) en `package.json`.

## Missing Inputs
- [NEEDS CLARIFICATION, NO bloqueante] **Desalineamiento de numeración del programa**: el roadmap
  documentado en `_INDEX.md` (líneas 460-470, sección "⚪ SOLANA LATAM LABS") nombra "HU-SOL-4" para
  el alcance de "Binding no-custodial + settle Solana (equivalente a WKH-211/WKH-168 del lado
  Solana)" — un alcance DISTINTO al de esta tarea (wallet-adapter React, más cercano
  conceptualmente a "HU-SOL-2: Wallet Solana (conexión + firma SPL)" de esa misma tabla, aunque
  ESTA HU explícitamente excluye la firma SPL real). El memory del agente (engram) referencia un
  backlog de 27 HUs para el programa Solana LATAM Labs — probablemente una descomposición más
  granular posterior al roadmap de 4 HUs documentado en `_INDEX.md`, con WKH-212 como el ticket
  Jira real de ESTA pieza (conexión de wallet vía React, sin firma). NO bloqueante porque el
  contenido de la tarea (spec autoritativo del orquestador) es inequívoco sobre el alcance; se
  recomienda que el orquestador actualice la tabla de `_INDEX.md` L466-470 al declarar
  `HU_APPROVED` para reflejar la numeración real (HU-SOL-2 = esta HU, o renombrar explícitamente).
- [resuelto en F2] Mecanismo exacto del puente context→`WalletPort` (DT-4 arriba) — dos opciones
  viables documentadas, decisión del Architect.
- [NEEDS CLARIFICATION, NO bloqueante] ¿El botón/UI de "conectar wallet" existente en
  `presentation/flow.tsx`/`ui.tsx` debe mostrar el modal de `@solana/wallet-adapter-react-ui`
  cuando `NEXT_PUBLIC_VM=solana`, o esta HU se limita al wiring de infraestructura sin tocar la UI
  de conexión visible? La tarea del orquestador dice "el usuario conecta Phantom/Solflare en la
  UI" — se asume que SÍ hay cambio de UI visible (al menos el botón dispara el modal correcto
  según la VM activa), pero el detalle exacto de dónde se renderiza el `WalletModalProvider`/
  `WalletMultiButton` es decisión de F2.

## Análisis de paralelismo
- **Bloquea a**: HU-SOL-2 (firma SPL real — necesita la wallet conectada de esta HU) y HU-SOL-8
  (PoP Solana, mencionada en la tarea, necesita `signMessage`-equivalente sobre una wallet ya
  conectada).
- **Bloqueada por**: HU-SOL-1 (WKH-206, `023`, DONE) — consume `resolveActiveVm()`,
  `resolveSolanaNetworkConfig()`, `SolanaAuthorization` (tipos).
- **No puede correr en paralelo** con ninguna otra HU que toque `container.ts` (composition root,
  alto riesgo de colisión histórico en este repo — ver notas de WKH-178/179/180/181, WKH-198/199/
  200/201 en `_INDEX.md`) sin coordinación explícita de orden de merge. Al momento de este F1, no
  se detectó otra HU activa sobre `chaski-v3` que toque `container.ts`/`app/layout.tsx`.
- Esta HU es INDEPENDIENTE del path EVM en producción (WKH-168/202/206/207/209/210/211, todas
  DONE) — no los toca, no los bloquea, no depende de ellas salvo por AC-3 (regresión cero, que es
  una restricción de NO-tocar, no una dependencia funcional).
