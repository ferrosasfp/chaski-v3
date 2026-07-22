# Story File — #024: [HU-SOL-4 / WKH-212] Integración `@solana/wallet-adapter` (React) en chaski-v3

> SDD: `doc/sdd/024-hu-sol-4-wallet-adapter/sdd.md` (SPEC_APPROVED)
> Work Item: `doc/sdd/024-hu-sol-4-wallet-adapter/work-item.md`
> Fecha: 2026-07-21
> Branch: `feat/024-hu-sol-4-wallet-adapter`
> Repo: `/home/ferdev/.openclaw/workspace/chaski-v3`

> **Dev lee SOLO este documento.** Todo lo necesario está acá: código concreto por símbolo,
> archivos exactos, prohibiciones por wave y el gate de cada wave. Si algo NO está acá → **PARÁ
> y escalá al Architect** (ver §Escalation). No inventes, no asumas, no improvises.

---

## Goal

Dar a chaski-v3 una wallet **Solana real (Phantom/Solflare)** conectable desde la UI, puenteada al
`WalletPort` imperativo existente vía un **singleton React-free** (`solana-wallet-bridge.ts`), montada
**condicionalmente sólo cuando `NEXT_PUBLIC_VM=solana`**. El path EVM queda **byte-idéntico**
(regresión-cero, AC-3). Esta HU implementa SÓLO connect/getAddress con base58 real — NO firma SPL, NO
PoP, NO settle Solana (Scope OUT).

---

## REGLA DE ORO (leé esto antes de tocar una línea)

> **AC-3 es la restricción dura de TODA la HU.** Con `NEXT_PUBLIC_VM` unset o `"evm"`, el path EVM
> queda byte-idéntico: **CERO providers Solana montados, CERO cambio de comportamiento EVM.**
>
> **Los tests EVM existentes NO SE TOCAN.** Si un `expect(...)` de `wallet.test.ts`,
> `container.test.ts` o `flow.test.tsx` cambia para pasar → **PARÁ y escalá.** Esos tests son el
> guardián de AC-3; cambiar una assertion EVM = violación de proceso, no un fix.
>
> Sólo **agregás** tests nuevos (`solana-wallet.test.ts`, `providers.test.tsx`) y tests nuevos DENTRO
> de `container.test.ts` (sin tocar los existentes).

---

## Anti-Hallucination Checklist (verificado por el Architect en F2 — NO re-investigar)

Todo lo de abajo YA fue confirmado con Read/Glob en el codebase. Usá estos hechos tal cual:

| # | Hecho verificado | Fuente |
|---|------------------|--------|
| AH-1 | `WalletPort` = `connect()`, `getAddress()`, `authorizePrincipal(quote, remittanceId, deposit?)`, `signMessage(message)`. **NO se toca** (CD-4). | `src/application/ports.ts:218-235` |
| AH-2 | `FallbackWallet` (exemplar de los métodos demo-simbólicos) tiene `private address: string \| null`, `authorizePrincipal(_quote: Quote): Promise<{ tx: string }>` y `signMessage(_message): Promise<string>` que devuelven strings sintéticos. | `src/infrastructure/wallet.ts:163-180` |
| AH-3 | `InjectedWallet` (exemplar del connect real) valida la address (`if (!isAddress(addr)) throw new Error("invalid_address")`) **antes** de cachear en `this.address`. El adapter Solana espeja esto con `new PublicKey(...)`. | `src/infrastructure/wallet.ts:57-82` |
| AH-4 | `resolveActiveVm(): "evm" \| "solana"` — unset/`""` → `"evm"`; `"solana"` → `"solana"`; cualquier otro → `throw new Error("unsupported_vm")`. **Ya existe, NO se toca.** | `src/infrastructure/chain.ts:121-126` |
| AH-5 | `resolveSolanaNetworkConfig().cluster === "devnet"`. **Ya existe.** El endpoint del `ConnectionProvider` sale de `clusterApiUrl(resolveSolanaNetworkConfig().cluster)`. **NUNCA** de `resolveSolanaRpcUrl()` (server-only, undefined en browser). | `src/infrastructure/chain.ts:129-131, 146-152` |
| AH-6 | `PublicKey` se importa de `@solana/web3.js` (**ya en `dependencies` `^1.98.4`**, ya usado en `chain.ts:139`). Validar base58 con `new PublicKey(str)` (lanza si es inválido), **NUNCA** con `isAddress` de viem (CD-SDD-5). | `src/infrastructure/chain.ts:6,139` + `package.json:18` |
| AH-7 | `container.ts` línea 79 hoy: `const wallet = pickWallet();`. Importa `pickWallet` (L33) y de `chain` sólo `resolveReceiverAddress` (L18). El wiring gateado entra ACÁ (único lugar, AC-4). | `src/composition/container.ts:18,33,79` |
| AH-8 | `app/layout.tsx` es **server component**, `RootLayout` renderiza `<body ...>{children}</body>` (L30) SIN wrapper de contexto. Se envuelve `{children}` en `<Providers>`. `RootLayout` sigue siendo server component (el wrapper es client). | `app/layout.tsx:27-32` |
| AH-9 | Alias TS: `@/*` → `./src/*`. `app/page.tsx` usa `import { RemittanceFlow } from "@/presentation/flow"`. Desde `app/layout.tsx` importá `Providers` con `@/presentation/providers`. Dentro de `src/` los vecinos usan imports **relativos** (ej. `container.ts` usa `../infrastructure/chain`) → seguí relativo dentro de `src/`. | `tsconfig.json:23-27`, `app/page.tsx:1` |
| AH-10 | Los tests de componente usan el docblock `// @vitest-environment jsdom` en **línea 1** (per-file, no hay `vitest.config.ts`). Confirmado en `flow.test.tsx:1`. | `src/presentation/flow.test.tsx:1` |
| AH-11 | `container.test.ts` **NO** setea `NEXT_PUBLIC_VM` → corre en rama `"evm"`; usa `vi.stubEnv` + `afterEach(() => vi.unstubAllEnvs())`; NO asserta el tipo del wallet hoy. | `src/composition/container.test.ts:1-49` |
| AH-12 | `wallet.test.ts` usa `vi.hoisted` + `vi.mock` para el lazy-import + `makeProvider()` fake + asserts por valor. Env de test = node (stub de `globalThis.window`). | `src/infrastructure/wallet.test.ts:1-60` |
| AH-13 | Versiones **reales** disponibles en npm (para pinnear, CD-5): react `0.15.39`, react-ui `0.9.39`, wallets `0.19.38`, base `0.9.27`, spl-token `0.4.15`, pay `1.0.23`. | `npm view` 2026-07-21 |

---

## Acceptance Criteria (EARS — copiados del SDD, QA los valida en F4)

- **AC-1**: WHEN `NEXT_PUBLIC_VM=solana` y el usuario abre la app, THE system SHALL montar
  `ConnectionProvider` + `WalletProvider` + `WalletModalProvider` apuntando a devnet
  (`resolveSolanaNetworkConfig().cluster`), con Phantom y Solflare seleccionables.
- **AC-2**: WHEN el usuario conecta Phantom/Solflare vía el modal, THE system SHALL propagar la
  `PublicKey` al `WalletPort` como string base58, de forma que `connectWallet.execute()` devuelva ese
  `address` sin transformación.
- **AC-3**: WHILE `NEXT_PUBLIC_VM` es `"evm"` (default/unset incluido), THE system SHALL mantener el
  árbol de la app y `pickWallet()`/`InjectedWallet`/`WalletConnectWallet`/`FallbackWallet`
  **byte-idénticos** — CERO providers Solana montados, cero import side-effect EVM.
- **AC-4**: WHEN se agrega `SolanaWalletAdapter`, THE system SHALL instanciarlo ÚNICAMENTE en
  `container.ts` gateado por `resolveActiveVm() === "solana"` — sin modo mixto silencioso.
- **AC-5**: IF `resolveActiveVm()` lanza (`unsupported_vm`), THEN THE system SHALL fallar la
  construcción (fail-loud) — sin árbol a medio montar.
- **AC-6**: WHEN `getAddress()` se llama tras `connect()` exitoso, THE system SHALL devolver el MISMO
  string base58 (case-sensitive, SIN `toLowerCase`).

---

## Constraint Directives

### OBLIGATORIO
- **CD-1 (AC-3, la ley)**: path EVM byte-idéntico con VM unset/`"evm"`. Ningún test EVM cambia de
  expectativa (`wallet.test.ts`, `container.test.ts` existentes, `flow.test.tsx`).
- **CD-2**: TODO provider/hook de `@solana/wallet-adapter-*` vive bajo `"use client"`
  (`providers.tsx`, `solana-providers.tsx`). Ningún import de la lib en un server component.
- **CD-3**: la `address` base58 es OPACA (string). **PROHIBIDO** `.toLowerCase()` o cualquier
  normalizador EVM. Solana base58 es case-sensitive.
- **CD-4**: **PROHIBIDO tocar** `WalletPort` (`ports.ts:218-235`). El adapter implementa la interfaz
  EXISTENTE. `authorizePrincipal`/`signMessage` del adapter Solana son **demo-simbólicos** (espejo de
  `FallbackWallet` — Scope OUT: firma real SPL = HU-SOL-2, PoP = HU-SOL-8).
- **CD-5**: las 6 deps nuevas PINNEADAS (sin `^`/`~`), con las versiones exactas de AH-13.
- **CD-SDD-5**: validar base58 con `new PublicKey()` de `@solana/web3.js`, **NUNCA** `isAddress` de
  viem.
- **CD-SDD-8**: tipos de dominio (`Quote`) se importan de `../domain/remittance`, NO de `ports`.
- **CD-SDD-9**: el gate de cada wave es `npm run qa` **completo** (typecheck + `vitest run`), NUNCA
  `next build` (build excluye tests).

### PROHIBIDO
- **PROHIBIDO** importar `@solana/wallet-adapter-*` desde `container.ts`, `solana-wallet.ts` o
  `solana-wallet-bridge.ts`. Rompe el **seam** que garantiza AC-3. SÓLO `solana-providers.tsx`
  importa la lib. El adapter y el bridge son **React-free / plain TS**.
- **PROHIBIDO** montar el árbol Solana incondicionalmente — siempre gateado por `resolveActiveVm()`.
- **PROHIBIDO** usar `resolveSolanaRpcUrl()` como endpoint del `ConnectionProvider` (server-only).
- **PROHIBIDO** tocar `wallet.ts`, `pickWallet()`, `chain.ts` (salvo LEER resolvers),
  `connect-wallet.ts`, `flow.tsx`/`ui.tsx`, `ports.ts`.
- **PROHIBIDO** usar `WalletMultiButton` en `flow.tsx` (obligaría a editar la UI). El modal se abre
  **programáticamente** vía el bridge dentro de `adapter.connect()`.
- **PROHIBIDO** agregar deps fuera de las 6 listadas, o usar `^`/`~` en ellas.

---

## Files to Create / Modify

| Archivo | Acción | Wave | Exemplar |
|---------|--------|------|----------|
| `package.json` | Modificar (6 deps pinneadas) | W0 | `package.json:17-34` |
| `src/infrastructure/solana-wallet-bridge.ts` | **Crear** (singleton React-free) | W0 | seam nuevo (código abajo) |
| `src/presentation/solana/solana-providers.tsx` | **Crear** (`"use client"`, árbol + sync) | W1 | docs `@solana/wallet-adapter-react`; `"use client"` de `flow.tsx:1` |
| `src/presentation/providers.tsx` | **Crear** (`"use client"`, dispatcher + dynamic) | W1 | `chain.ts:154-164` dispatcher |
| `app/layout.tsx` | Modificar (envolver en `<Providers>`) | W1 | `layout.tsx:27-32` |
| `src/infrastructure/solana-wallet.ts` | **Crear** (`SolanaWalletAdapter`) | W2 | `wallet.ts:57-160` |
| `src/composition/container.ts` | Modificar (dispatcher gateado) | W2 | `container.ts:79` + `chain.ts:154-164` |
| `src/infrastructure/solana-wallet.test.ts` | **Crear** | W3 | `wallet.test.ts` |
| `src/presentation/providers.test.tsx` | **Crear** (jsdom) | W3 | `flow.test.tsx:1` |
| `src/composition/container.test.ts` | Modificar (AGREGAR 2 tests, sin tocar los existentes) | W3 | `container.test.ts:9-19` |

**NO** se crea/toca ningún archivo fuera de esta tabla.

---

## Wave -1: Environment Gate (verificar ANTES de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
node -v && npm -v
# Baseline verde OBLIGATORIO antes de empezar:
npm run qa    # DEBE terminar exit 0 (los stderr recordPrincipalIn_failed/recordPayoutOutcome_failed
              # son console.error deliberados de tests best-effort, NO fallos)
# Archivos base del Scope IN existen:
ls src/infrastructure/wallet.ts src/composition/container.ts app/layout.tsx \
   src/infrastructure/chain.ts src/application/ports.ts
```

**Si `npm run qa` NO está verde ANTES de empezar → PARÁ y reportá al orquestador.** No se
implementa sobre un baseline rojo.

---

## Wave 0 — Andamiaje (deps + bridge singleton). EVM verde, nada montado.

### W0.1 — `package.json`: 6 deps pinneadas (CD-5)

Agregá EXACTAMENTE estas 6 líneas dentro de `"dependencies"` (orden alfabético, **sin `^`**). NO
toques ninguna otra dep, NO cambies `@solana/web3.js` (queda `^1.98.4`):

```jsonc
    "@solana/pay": "1.0.23",
    "@solana/spl-token": "0.4.15",
    "@solana/wallet-adapter-base": "0.9.27",
    "@solana/wallet-adapter-react": "0.15.39",
    "@solana/wallet-adapter-react-ui": "0.9.39",
    "@solana/wallet-adapter-wallets": "0.19.38",
```

Luego:
```bash
npm install
```
Verificá que el lockfile resuelve el set de hermanos `@solana/wallet-adapter-*` sin conflictos de
peer-deps (los 4 wallet-adapter deben resolver compatibles entre sí). Si `npm install` reporta
conflicto de peer irreconciliable → PARÁ y escalá (no fuerces `--legacy-peer-deps` sin avisar).

> **Nota (DT-SDD-7):** `@solana/spl-token` y `@solana/pay` se agregan pinneadas pero **NO se
> importan en esta HU** (son para HU-SOL-2). Es staging deliberado, no dead-dep. NO las importes.

### W0.2 — `src/infrastructure/solana-wallet-bridge.ts` (singleton React-free)

Creá el archivo con este contenido. **NO importa nada de `@solana/wallet-adapter-*` ni de React**
(preserva el seam AC-3):

```ts
// src/infrastructure/solana-wallet-bridge.ts
// SEAM React-free entre el árbol @solana/wallet-adapter-react (mundo React, montado SOLO si
// VM=solana) y el SolanaWalletAdapter (mundo imperativo, instanciado en container.ts). Este módulo
// es plain TS: NUNCA importa @solana/wallet-adapter-* ni React (garantiza AC-3 por construcción).

/** Estado que el sync component (dentro del árbol React) empuja en cada cambio de useWallet(). */
export interface SolanaWalletState {
  publicKey: string | null; // base58 OPACO (CD-3) — nunca toLowerCase
  connected: boolean;
}

type OpenModalFn = () => void;

class SolanaWalletBridge {
  private state: SolanaWalletState = { publicKey: null, connected: false };
  private openModalHandle: OpenModalFn | null = null;
  private pendingResolve: (() => void) | null = null;
  private pendingReject: ((e: Error) => void) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  /** El sync component lo llama en cada cambio de useWallet(). Resuelve la espera si conectó. */
  setState(next: SolanaWalletState): void {
    this.state = next;
    if (next.connected && next.publicKey) this.settle();
  }

  getState(): SolanaWalletState {
    return this.state;
  }

  /** Registrado por el sync component (captura useWalletModal().setVisible). */
  registerOpenModal(fn: OpenModalFn): void {
    this.openModalHandle = fn;
  }

  /** Abre el modal Phantom/Solflare. Throw si el árbol de providers no está montado. */
  openModal(): void {
    if (!this.openModalHandle) throw new Error("wallet_bridge_not_mounted");
    this.openModalHandle();
  }

  /** Deferred: resuelve cuando el estado transiciona a connected && publicKey; timeout → reject. */
  waitForConnection(timeoutMs = 120_000): Promise<void> {
    if (this.state.connected && this.state.publicKey) return Promise.resolve();
    if (this.pendingResolve) {
      // ya hay una espera en curso: no dupliques deferred, reusá una promesa nueva encadenada
      return new Promise<void>((res, rej) => {
        const prevRes = this.pendingResolve;
        const prevRej = this.pendingReject;
        this.pendingResolve = () => { prevRes?.(); res(); };
        this.pendingReject = (e) => { prevRej?.(e); rej(e); };
      });
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.pendingTimer = setTimeout(() => {
        const rej = this.pendingReject;
        this.clearPending();
        rej?.(new Error("wallet_connect_timeout"));
      }, timeoutMs);
    });
  }

  /** El sync component la llama cuando el modal se cierra sin conectar (best-effort cancel). */
  cancelConnection(): void {
    const rej = this.pendingReject;
    if (!rej) return;
    this.clearPending();
    rej(new Error("wallet_connect_cancelled"));
  }

  /** Test-only: resetea el singleton entre tests. */
  reset(): void {
    this.clearPending();
    this.state = { publicKey: null, connected: false };
    this.openModalHandle = null;
  }

  private settle(): void {
    const res = this.pendingResolve;
    this.clearPending();
    res?.();
  }

  private clearPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingResolve = null;
    this.pendingReject = null;
  }
}

/** Singleton compartido (browser). El sync component escribe, el adapter lee. */
export const solanaWalletBridge = new SolanaWalletBridge();
```

### PROHIBIDO en W0
- Importar `@solana/wallet-adapter-*` o React en `solana-wallet-bridge.ts`.
- Referenciar el bridge desde `container.ts` todavía (eso es W2).

### Gate W0
```bash
npm run qa    # exit 0. EVM 100% intacto (el bridge no se referencia aún; nada montado).
```

---

## Wave 1 — Árbol de providers condicional (client boundary)

### W1.1 — `src/presentation/solana/solana-providers.tsx` (`"use client"`)

Creá el archivo. Este es el ÚNICO archivo que importa `@solana/wallet-adapter-*`. El CSS de react-ui
se importa ACÁ (carga sólo en la rama solana). **Default export** obligatorio (lo consume
`next/dynamic`):

```tsx
"use client";
// Árbol @solana/wallet-adapter-react — montado SOLO cuando VM=solana (vía next/dynamic en
// providers.tsx). Único archivo que importa la lib + su CSS (seam AC-3). El sync component empuja
// el estado de useWallet() al singleton React-free y registra openModal.
import { useEffect, useMemo } from "react";
import { clusterApiUrl } from "@solana/web3.js";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { resolveSolanaNetworkConfig } from "../../infrastructure/chain";
import { solanaWalletBridge } from "../../infrastructure/solana-wallet-bridge";
import "@solana/wallet-adapter-react-ui/styles.css";

/** Suscribe useWallet()/useWalletModal() y empuja al singleton React-free. No renderiza DOM. */
function SolanaWalletBridgeSync(): null {
  const { publicKey, connected } = useWallet();
  const { setVisible, visible } = useWalletModal();

  // Registra el handle imperativo openModal (capturado desde useWalletModal).
  useEffect(() => {
    solanaWalletBridge.registerOpenModal(() => setVisible(true));
  }, [setVisible]);

  // Empuja el estado en cada cambio. base58 OPACO (CD-3): publicKey.toBase58(), SIN toLowerCase.
  useEffect(() => {
    solanaWalletBridge.setState({
      publicKey: publicKey ? publicKey.toBase58() : null,
      connected,
    });
  }, [publicKey, connected]);

  // Best-effort cancel: modal cerrado sin conexión → rechaza la espera pendiente del adapter.
  useEffect(() => {
    if (!visible && !connected) solanaWalletBridge.cancelConnection();
  }, [visible, connected]);

  return null;
}

export default function SolanaProviders({ children }: { children: React.ReactNode }) {
  // Endpoint = clusterApiUrl(cluster) — NUNCA resolveSolanaRpcUrl() (server-only, PROHIBIDO).
  const endpoint = useMemo(() => clusterApiUrl(resolveSolanaNetworkConfig().cluster), []);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SolanaWalletBridgeSync />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
```

### W1.2 — `src/presentation/providers.tsx` (`"use client"`)

Creá el archivo. Gatea el árbol Solana por `resolveActiveVm()`; en EVM es passthrough transparente
(`<>{children}</>`). El árbol Solana entra SÓLO vía `next/dynamic(..., {ssr:false})` → en EVM el
chunk **nunca se carga** (cero side-effect, AC-3):

```tsx
"use client";
// Dispatcher de providers gateado por VM. En "evm" → passthrough (cero DOM/contexto/chunk Solana,
// AC-3). En "solana" → árbol Solana cargado vía next/dynamic (chunk aislado). resolveActiveVm()
// throwea con VM inválida → fail-loud en render (AC-5).
import dynamic from "next/dynamic";
import { resolveActiveVm } from "../infrastructure/chain";

const SolanaProviders = dynamic(() => import("./solana/solana-providers"), { ssr: false });

export function Providers({ children }: { children: React.ReactNode }) {
  if (resolveActiveVm() === "solana") {
    return <SolanaProviders>{children}</SolanaProviders>;
  }
  return <>{children}</>;
}
```

### W1.3 — `app/layout.tsx` (envolver `{children}`)

`RootLayout` sigue siendo **server component**. Sólo agregás el import y envolvés `{children}`:

```tsx
import { Providers } from "@/presentation/providers";
```

y en el `<body>`:

```tsx
      <body className="min-h-dvh bg-paper text-ink">
        <Providers>{children}</Providers>
      </body>
```

> Con VM unset/`"evm"`, `<Providers>` = passthrough (Fragment) → DOM/hidratación efectivamente
> idénticos. NO agregues props, NO cambies `<html>`/`<body>`/metadata/fonts.

### PROHIBIDO en W1
- Import ESTÁTICO de `solana-providers.tsx` desde `providers.tsx` (rompe el aislamiento del chunk).
  Debe ser `dynamic(() => import(...), {ssr:false})`.
- Tocar `flow.tsx`/`ui.tsx` (el modal es programático, no hay `WalletMultiButton`).
- Endpoint distinto a `clusterApiUrl(resolveSolanaNetworkConfig().cluster)`.

### Gate W1
```bash
npm run qa    # exit 0. Con VM unset: Providers = passthrough, chunk Solana no cargado → EVM
              # byte-idéntico. typecheck valida los tipos de los providers.
```

---

## Wave 2 — Adapter + wiring gateado

### W2.1 — `src/infrastructure/solana-wallet.ts` (`SolanaWalletAdapter`)

Creá el archivo. **React-free**: NO importa `@solana/wallet-adapter-*`. Sólo lee el singleton +
valida base58 con `PublicKey`:

```ts
// src/infrastructure/solana-wallet.ts
// SolanaWalletAdapter implements WalletPort — puente React-free hacia el árbol Solana vía el
// singleton bridge. NUNCA importa @solana/wallet-adapter-* (seam AC-3). Valida base58 con PublicKey
// de @solana/web3.js (CD-SDD-5), NUNCA isAddress de viem. connect()/getAddress() son REALES;
// authorizePrincipal/signMessage son demo-simbólicos (Scope OUT: firma SPL=HU-SOL-2, PoP=HU-SOL-8).
import { PublicKey } from "@solana/web3.js";
import type { WalletPort } from "../application/ports";
import type { Quote } from "../domain/remittance";
import { solanaWalletBridge } from "./solana-wallet-bridge";

export class SolanaWalletAdapter implements WalletPort {
  private address: string | null = null;

  async connect(): Promise<string> {
    const state = solanaWalletBridge.getState();
    if (!state.connected || !state.publicKey) {
      solanaWalletBridge.openModal(); // abre el modal Phantom/Solflare (AC-2)
      await solanaWalletBridge.waitForConnection(); // throw en timeout/cancel (§flujo de error)
    }
    const base58 = solanaWalletBridge.getState().publicKey;
    if (!base58) throw new Error("wallet_not_connected");
    // Defensa en profundidad: valida base58 ANTES de cachear (espeja InjectedWallet:66).
    try {
      new PublicKey(base58);
    } catch {
      throw new Error("invalid_address");
    }
    this.address = base58; // OPACO, SIN toLowerCase (CD-3)
    return this.address;
  }

  async getAddress(): Promise<string | null> {
    return this.address; // el MISMO base58 case-sensitive (AC-6)
  }

  // Scope OUT (CD-4 / DT-SDD-6): firma real SPL = HU-SOL-2. Demo-simbólico como FallbackWallet.
  async authorizePrincipal(_quote: Quote): Promise<{ tx: string }> {
    return { tx: `solana-demo-${Date.now().toString(16)}` };
  }

  async signMessage(_message: string): Promise<string> {
    return `solana-demosig-${Date.now().toString(16)}`;
  }
}
```

### W2.2 — `src/composition/container.ts` (dispatcher gateado)

Dos ediciones mínimas. **(1)** Agregá `resolveActiveVm` al import de `chain` y el import del adapter.
Línea 18 actual (`import { resolveReceiverAddress } from "../infrastructure/chain";`) →

```ts
import { resolveActiveVm, resolveReceiverAddress } from "../infrastructure/chain";
```

Agregá cerca del import de `pickWallet` (L33):

```ts
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
```

**(2)** Línea 79 actual (`const wallet = pickWallet();`) →

```ts
  // Dispatcher de wallet gateado por VM (AC-4): un solo resolveActiveVm() gobierna el wiring; imposible
  // modo mixto silencioso. El adapter Solana es React-free (seam AC-3) → import estático seguro para el
  // bundle EVM. VM=evm/unset → pickWallet() EVM INTACTO. VM inválida → resolveActiveVm() throw (AC-5).
  const wallet =
    resolveActiveVm() === "solana" ? new SolanaWalletAdapter() : pickWallet();
```

> NO cambies nada más en `container.ts` (el `pop = new HttpPopSigner(wallet)` de L103 y el
> `ConnectWallet(wallet, kycStore)` de L108 ya reciben `wallet` — quedan igual).

### PROHIBIDO en W2
- Importar `@solana/wallet-adapter-*` en `solana-wallet.ts` o `container.ts`.
- Usar `isAddress` de viem para validar base58 (usá `new PublicKey`).
- Aplicar `.toLowerCase()` / normalizar la address.
- Darle a `authorizePrincipal`/`signMessage` lógica real de firma Solana.

### Gate W2
```bash
npm run qa    # exit 0. container.test.ts (VM unset → rama pickWallet) intacto, sin cambios de
              # expectativa. El import estático del adapter NO arrastra la lib Solana (seam).
```

---

## Wave 3 — Tests + verificación

### W3.1 — `src/infrastructure/solana-wallet.test.ts` (node)

Creá el test manejando el singleton real (reset en `afterEach`). Fixture base58 válido (mixed-case,
sirve para el check case-sensitive de AC-6): `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (es un
base58 válido — el mint USDC devnet de `chain.ts:113`).

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { SolanaWalletAdapter } from "./solana-wallet";
import { solanaWalletBridge } from "./solana-wallet-bridge";

const VALID_B58 = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // base58 válido (mixed-case)

afterEach(() => {
  solanaWalletBridge.reset();
  vi.restoreAllMocks();
});

describe("SolanaWalletAdapter", () => {
  it("connect() abre el modal y devuelve el base58 del bridge sin transformar (AC-2, CD-3)", async () => {
    const openSpy = vi.fn();
    solanaWalletBridge.registerOpenModal(openSpy);
    const adapter = new SolanaWalletAdapter();
    const p = adapter.connect();
    expect(openSpy).toHaveBeenCalledOnce(); // openModal se llamó antes del await
    // simula que el usuario conectó Phantom → el sync component empuja el estado
    solanaWalletBridge.setState({ publicKey: VALID_B58, connected: true });
    await expect(p).resolves.toBe(VALID_B58); // sin transformación (CD-3)
  });

  it("getAddress() tras connect() devuelve el MISMO base58 case-sensitive (AC-6, CD-3)", async () => {
    solanaWalletBridge.setState({ publicKey: VALID_B58, connected: true });
    const adapter = new SolanaWalletAdapter();
    await adapter.connect();
    const got = await adapter.getAddress();
    expect(got).toBe(VALID_B58);
    expect(got).not.toBe(VALID_B58.toLowerCase()); // NO se lowercasea (base58 case-sensitive)
  });

  it("base58 malformado del bridge → throw invalid_address sin cachear (CD-SDD-5)", async () => {
    // '0OIl' contiene chars fuera del alfabeto base58 → new PublicKey lanza
    solanaWalletBridge.setState({ publicKey: "0OIl-not-base58", connected: true });
    const adapter = new SolanaWalletAdapter();
    await expect(adapter.connect()).rejects.toThrow("invalid_address");
    expect(await adapter.getAddress()).toBeNull(); // no cacheó nada
  });

  it("modal cerrado sin conectar → waitForConnection rechaza → connect() throw", async () => {
    solanaWalletBridge.registerOpenModal(() => {});
    const adapter = new SolanaWalletAdapter();
    const p = adapter.connect();
    solanaWalletBridge.cancelConnection(); // usuario cierra el modal
    await expect(p).rejects.toThrow("wallet_connect_cancelled");
  });

  it("openModal sin árbol montado → throw wallet_bridge_not_mounted", async () => {
    const adapter = new SolanaWalletAdapter(); // bridge reseteado, sin openModal registrado
    await expect(adapter.connect()).rejects.toThrow("wallet_bridge_not_mounted");
  });
});
```

### W3.2 — `src/presentation/providers.test.tsx` (jsdom)

**Línea 1 = docblock jsdom** (AH-10). Para AC-1 se **mockea** `./solana/solana-providers` con un stub
liviano: evita cargar el CSS de react-ui + la lib pesada en vitest (no hay `vitest.config.ts` que
maneje CSS), y testea deterministamente el **gating** (que es el núcleo de AC-1/AC-3/AC-4). El árbol
real (ConnectionProvider/WalletProvider/WalletModalProvider) queda cubierto estructuralmente por el
código de W1.1 + el mutation self-check de W3.4.

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "./providers";

// Stub liviano del árbol Solana (evita CSS + lib pesada en vitest). El dynamic import de
// providers.tsx resuelve a este mock.
vi.mock("./solana/solana-providers", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="solana-tree">{children}</div>
  ),
}));

const ORIGINAL_VM = process.env.NEXT_PUBLIC_VM;
afterEach(() => {
  if (ORIGINAL_VM === undefined) delete process.env.NEXT_PUBLIC_VM;
  else process.env.NEXT_PUBLIC_VM = ORIGINAL_VM;
  vi.clearAllMocks();
});

describe("Providers — gating por VM", () => {
  it("VM=solana → monta el árbol Solana envolviendo children (AC-1)", async () => {
    process.env.NEXT_PUBLIC_VM = "solana";
    render(
      <Providers>
        <div data-testid="child">app</div>
      </Providers>,
    );
    // next/dynamic({ssr:false}) resuelve el chunk tras el mount
    await waitFor(() => expect(screen.getByTestId("solana-tree")).toBeInTheDocument());
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("VM unset/evm → passthrough, NINGÚN provider Solana montado (AC-3)", () => {
    delete process.env.NEXT_PUBLIC_VM; // default = evm
    render(
      <Providers>
        <div data-testid="child">app</div>
      </Providers>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.queryByTestId("solana-tree")).toBeNull(); // cero árbol Solana
  });
});
```

> Si `@testing-library/jest-dom` matchers (`toBeInTheDocument`) no están auto-importados en este
> proyecto, seguí el patrón EXACTO de `flow.test.tsx` para el setup de matchers. Si `flow.test.tsx`
> los usa sin import explícito → hay setup global; usalos igual. Si no → escalá (no inventes un
> `setup.ts` nuevo).

### W3.3 — `src/composition/container.test.ts` (AGREGAR 2 tests, NO tocar los existentes)

Agregá un `describe` nuevo al final del archivo (NO modifiques ningún test/expectativa existente —
CD-1). Importá el bridge para el reset:

```ts
// (agregar al tope, junto a los imports existentes)
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
```

```ts
describe("createContainer — dispatcher de wallet por VM (HU-SOL-4, AC-4/AC-5)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    solanaWalletBridge.reset();
  });

  it("AC-4: VM=solana → cablea el SolanaWalletAdapter (no pickWallet)", async () => {
    vi.stubEnv("NEXT_PUBLIC_VM", "solana");
    const c = createContainer();
    // El adapter Solana sin árbol montado → openModal throw wallet_bridge_not_mounted.
    // (En rama evm, FallbackWallet resolvería a la address demo → distinguible = mata la mutación.)
    await expect(c.connectWallet.execute()).rejects.toThrow("wallet_bridge_not_mounted");
  });

  it("AC-5: VM inválida → createContainer throw unsupported_vm (fail-loud)", () => {
    vi.stubEnv("NEXT_PUBLIC_VM", "aptos");
    expect(() => createContainer()).toThrow("unsupported_vm");
  });
});
```

> El `afterEach(() => vi.unstubAllEnvs())` existente (L7) sigue; este `describe` agrega su propio
> `afterEach` con el reset del bridge. NO borres ni edites el `afterEach` de L7.

### W3.4 — Mutation self-check (CD-SDD-11) — OBLIGATORIO

Verificá que el gating está REALMENTE cubierto. Hacelo con **backup a scratchpad** (NO `git
checkout`), un gate a la vez:

```bash
SP=/tmp/claude-1000/-home-ferdev--openclaw-workspace-wasiai-a2a/09093fcc-fffd-496d-96e4-bed79f905a62/scratchpad
mkdir -p "$SP"

# --- Mutante 1: gate de providers.tsx ---
cp src/presentation/providers.tsx "$SP/providers.tsx.bak"
# editar a mano: `resolveActiveVm() === "solana"` → `resolveActiveVm() === "evm"`  (comentar // MUTANT)
npx vitest run src/presentation/providers.test.tsx   # DEBE fallar ≥1 test (AC-1 y AC-3 mueren)
cp "$SP/providers.tsx.bak" src/presentation/providers.tsx   # restaurar

# --- Mutante 2: gate de container.ts ---
cp src/composition/container.ts "$SP/container.ts.bak"
# editar a mano: `resolveActiveVm() === "solana"` → `resolveActiveVm() === "evm"`  (// MUTANT)
npx vitest run src/composition/container.test.ts     # DEBE fallar el test AC-4 (wallet_bridge_not_mounted)
cp "$SP/container.ts.bak" src/composition/container.ts      # restaurar

# --- Confirmar limpieza ---
grep -rn "MUTANT" src app    # DEBE devolver 0 resultados
```

Si al mutar un gate **ningún** test muere → el test no cubre el gating → **PARÁ y escalá** (falta
cobertura, no lo dejes pasar).

### Gate W3 (final)
```bash
npm run qa           # exit 0 FULL: todos los tests EVM existentes verdes SIN cambio de expectativa
                     # + los 3 tests nuevos (solana-wallet.test.ts, providers.test.tsx, container AC-4/AC-5)
npm run build        # OK (typecheck de producción; el chunk Solana no se carga en runtime EVM)
grep -rn "MUTANT" src app   # 0 (limpieza post mutation self-check)
```

---

## Test Expectations (resumen)

| Test | ACs / CD | Framework | Tipo |
|------|----------|-----------|------|
| `solana-wallet.test.ts` — connect abre modal + base58 sin transformar | AC-2, CD-3 | vitest (node) | unit |
| `solana-wallet.test.ts` — getAddress == connect, case-sensitive | AC-6, CD-3 | vitest (node) | unit |
| `solana-wallet.test.ts` — base58 malformado → invalid_address | CD-SDD-5 | vitest (node) | unit |
| `solana-wallet.test.ts` — modal cerrado/timeout → throw | flujo error | vitest (node) | unit |
| `providers.test.tsx` — VM=solana monta el árbol | AC-1 | vitest (jsdom) | component |
| `providers.test.tsx` — VM unset/evm passthrough | AC-3, CD-1 | vitest (jsdom) | component |
| `container.test.ts` (nuevos) — VM=solana → SolanaWalletAdapter / VM inválida → throw | AC-4, AC-5 | vitest (node) | integration |
| `wallet.test.ts` / `container.test.ts` (existentes) / `flow.test.tsx` — SIN CAMBIOS, verdes | **AC-3, CD-1** | vitest | regresión |
| Mutation self-check (providers + container gate) | AC-4, CD-SDD-11 | manual + vitest | — |

**Criterio Test-First**: los tests nuevos (adapter + gating) son lógica condicional → escribilos
junto con / antes del código que validan dentro de cada wave. Los tests EVM existentes NO se tocan.

---

## Done Definition

- [ ] `npm run qa` = **exit 0**: TODOS los tests EVM existentes verdes **sin ningún cambio de
      expectativa** (`wallet.test.ts`, `container.test.ts` existentes, `flow.test.tsx`) + los tests
      Solana nuevos (`solana-wallet.test.ts`, `providers.test.tsx`, `container.test.ts` AC-4/AC-5).
- [ ] `npm run build` = OK.
- [ ] Path EVM byte-idéntico: con `NEXT_PUBLIC_VM` unset, `<Providers>` = passthrough y el chunk
      `solana-providers` NO se carga (verificado por `providers.test.tsx` AC-3 + el seam React-free).
- [ ] Las 6 deps en `package.json` PINNEADAS (sin `^`/`~`), con las versiones de AH-13.
- [ ] `SolanaWalletAdapter` y `solana-wallet-bridge.ts` NO importan `@solana/wallet-adapter-*`
      (seam intacto). Sólo `solana-providers.tsx` importa la lib.
- [ ] `WalletPort`, `wallet.ts`, `chain.ts`, `connect-wallet.ts`, `flow.tsx`, `ui.tsx`, `ports.ts`
      **sin cambios**.
- [ ] Mutation self-check: mutar el gate de `providers.tsx` mata `providers.test.tsx`; mutar el gate
      de `container.ts` mata `container.test.ts` AC-4. `grep -rn MUTANT src app` = 0.

---

## Out of Scope (NO tocar bajo ninguna circunstancia)

- Firma real de transacciones Solana / SPL transfer (**HU-SOL-2**).
- `authorizePrincipal()` real Solana / binding no-custodial / settle on-chain Solana.
- Proof-of-Possession Solana (**HU-SOL-8**).
- Cerrar los `[TBD HU-SOL-2]` de `SolanaAuthorization` (`ports.ts`).
- Cambios a `chain.ts`/`ports.ts`/`wallet.ts`/`flow.tsx`/`ui.tsx` (sólo LECTURA de resolvers).
- Auditoría supply-chain de las deps (**HU-SOL-25**).
- Mainnet-beta Solana (sólo devnet).
- Polir el label de red del connect-card (`resolveChain().name` → "Base Sepolia" también en solana):
  **cosmético, diferido** — editarlo obligaría a tocar `flow.tsx` (riesgo AC-3). NO lo toques.
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada.

---

## Escalation Rule

> **Si algo NO está en este Story File → Dev PARA y escala al Architect.** No inventar, no asumir.

Escalá si:
- `npm run qa` NO está verde ANTES de empezar (Wave -1).
- `npm install` da un conflicto de peer-deps irreconciliable entre los `@solana/wallet-adapter-*`.
- Un test EVM existente empieza a fallar y el "fix" implicaría cambiar su `expect(...)`.
- El árbol real de `solana-providers.tsx` no compila/typechea con las versiones pinneadas (posible
  drift de API entre minors del wallet-adapter).
- El mutation self-check no mata ningún test (falta cobertura del gating).
- Los matchers `toBeInTheDocument` no resuelven y no hay un setup global evidente en `flow.test.tsx`.
- Cualquier necesidad de tocar un archivo fuera de la tabla "Files to Create / Modify".

---

*Story File generado por NexusAgil — F2.5 — HU-SOL-4 / WKH-212*
