# Auto-Blindaje — HU-SOL-5 (WKH-207*) — wallet Solana firma el `deposit` al escrow

Registro de errores cometidos durante F3 y sus fixes, para blindar futuras HUs Solana/Anchor.

### [2026-07-21] Wave 1 — `anchor` usado como NAMESPACE de tipos desde un binding `await import`
- **Error**: `escrowIdl as anchor.Idl` / `{ connection } as anchor.Provider` → `TS2503 Cannot find namespace 'anchor'`.
- **Causa raíz**: `const anchor = await import("@coral-xyz/anchor")` es un binding de VALOR (runtime). No se puede usar como namespace de TIPOS. Los tipos deben importarse con `import type`.
- **Fix**: `import type { Idl, Provider } from "@coral-xyz/anchor"` (estático, se borra en el emit) + castear `escrowIdl as unknown as Idl` y `{ connection } as Provider`. El valor `anchor` sigue lazy.
- **Aplicar en**: cualquier adapter que lazy-importe una lib y necesite sus tipos → separar `import type { ... }` estático del `await import` de valor.

### [2026-07-21] Wave 1 — IDL `as const` no castea directo a `Idl`
- **Error**: `escrowIdl as Idl` → `TS2352 Conversion ... may be a mistake` (types of `instructions` incompatibles).
- **Causa raíz**: el IDL se declara `as const` (tuplas/literales readonly ultra-específicos). El tipo genérico `Idl` de anchor no solapa con esa forma readonly literal → TS bloquea el cast directo.
- **Fix**: doble cast `escrowIdl as unknown as Idl`. El IDL sigue `as const` (fuente pinneada, verificable), y el runtime de anchor valida args/accounts contra el IDL igual.
- **Aplicar en**: copias pinneadas de IDL `as const` → castear a `Idl` siempre vía `as unknown as Idl`.

### [2026-07-21] Wave 1 — `program.methods.deposit` posiblemente `undefined` con `Idl` genérico
- **Error**: `TS2722 Cannot invoke an object which is possibly 'undefined'` al llamar `.deposit(...)`.
- **Causa raíz**: con `Idl` genérico (no un IDL tipado por-instrucción), `program.methods` es un índice loose → `.deposit` es `possibly undefined`.
- **Fix**: castear `program.methods` a un shape loose explícito (`{ deposit: (...args) => { accounts(...): { remainingAccounts(...): { instruction(): Promise<TransactionInstruction> } } } }`). Los args/accounts se validan contra el IDL en runtime.
- **Aplicar en**: builders de anchor con IDL genérico → tipar el fluent chain a mano, no confiar en la inferencia por-instrucción.

### [2026-07-21] Wave 3 — `noUncheckedIndexedAccess` en los tests (accesos por índice)
- **Error**: `TS2532/TS18048 Object is possibly 'undefined'` en `tx.instructions[0]`, `ix.keys[len-1]`, `signSpy.mock.calls[0][0]`.
- **Causa raíz**: `tsconfig` tiene `noUncheckedIndexedAccess` → todo acceso `arr[i]` es `T | undefined`. Lección WKH-196: el gate es `tsc --noEmit` COMPLETO (incluye tests), no `next build`.
- **Fix**: helpers de narrowing (`capturedTx(spy)`, `firstIx(tx)`) que hacen fail-loud si el índice es undefined, y guard explícito para `last`. Cero `any`, cero `!`.
- **Aplicar en**: tests que inspeccionan arrays (instrucciones, keys, mock.calls) → narrowing helper, no index crudo.

### [2026-07-21] Wave 3 — `vi.spyOn` sobre método sobrecargado no encaja en `let` genérico
- **Error**: `TS2322 MockInstance<específico> is not assignable to MockInstance<(this:unknown,...args:unknown[])=>unknown>` al guardar el spy en `let sendRawSpy: ReturnType<typeof vi.spyOn>`.
- **Causa raíz**: `sendRawTransaction`/`sendTransaction` son métodos sobrecargados; el `MockInstance` de su overload NO es asignable al `MockInstance` genérico por defecto.
- **Fix**: no guardar el spy en una variable tipada; instalar el mock con `vi.spyOn(...).mockResolvedValue(...)` y asertar directo sobre `Connection.prototype.sendRawTransaction` (`.not.toHaveBeenCalled()`).
- **Aplicar en**: spies sobre métodos sobrecargados → asertar sobre `Proto.method` en vez de una variable `let` tipada.

## Fix-pack AR+CR (2026-07-21)

### [2026-07-21] Fix-pack BLQ-MED-1 — `node:crypto` NO resuelve en el bundle browser de Next
- **Error**: `remittanceIdToBytes16` hacía `await import("node:crypto")` con `createHash("sha256")`. El adapter Solana corre CLIENT-SIDE (`flow.tsx "use client"` → `createContainer` → `SolanaWalletAdapter`). `node:crypto` (prefijo `node:`) NO es polyfilleable en el bundle client → el dynamic import RECHAZA en el browser → `authorizePrincipal` lanza antes de armar la ix → deposit Solana roto en prod. Los tests verdes lo enmascaraban (corren en env `node`, donde `node:crypto` sí resuelve).
- **Causa raíz**: usar un builtin de Node en código que ejecuta en el runtime browser. El test-env `node` no refleja el runtime real.
- **Fix**: reemplazado por `sha256` de `@noble/hashes/sha256` (browser-safe, SÍNCRONO, ya es dep transitiva de `@solana/web3.js` y `@coral-xyz/anchor` — resuelve directo). Import ESTÁTICO al tope → una reintroducción de `node:crypto` estático falla el build de Next. Output byte-idéntico: `sha256(utf8(remittanceId)).subarray(0,16)` → `Uint8Array` de 16 bytes (crítico: HU-SOL-13 re-deriva el mismo PDA server-side). `new TextEncoder().encode(...)` para los utf8 bytes (browser+node-safe).
- **Aplicar en**: TODO adapter/util que corra client-side (`"use client"` chain) → NUNCA builtins de Node (`node:crypto`, `node:fs`, `Buffer`-solo-node, etc). Usar libs isomórficas (`@noble/hashes`, `TextEncoder`, `globalThis.crypto.subtle`). El test-env `node` puede enmascarar la falla.

### [2026-07-21] Fix-pack BLQ-MED-1 (parte test-env) — jsdom NO viable para tests que ejercen PDA de web3.js
- **Error**: agregar `// @vitest-environment jsdom` al tope de `solana-wallet.test.ts` (para reflejar el runtime browser) hace fallar 5 de 13 tests con `Error: Unable to find a viable program address nonce` en `PublicKey.findProgramAddressSync`. Reproducido en aislamiento (probe mínimo) → INDEPENDIENTE de los cambios de este fix-pack.
- **Causa raíz**: incompatibilidad cross-realm de vitest+jsdom. `createProgramAddressSync` hace `sha256(buffer)` con un `Buffer` (realm Node) y `@noble/hashes` valida `instanceof Uint8Array` contra el `Uint8Array` del realm jsdom → falla con "Uint8Array expected" (Error plano) → el loop de nonces lo captura y agota → "Unable to find a viable program address nonce". `@noble/hashes`/`@noble/curves` llamados DIRECTO bajo jsdom sí funcionan (usan `Uint8Array` del realm jsdom); sólo rompe el `Buffer` interno de web3.js. `resolve.conditions:["node"]` y `server.deps.inline` NO lo arreglan (probado). El fix real requiere config global de vitest (setupFiles/pool/alias Buffer) con riesgo de regresión sobre los 594 tests → FUERA de scope (Solana + chain.ts + .env.example).
- **Fix**: NO se aplicó el docblock jsdom a `solana-wallet.test.ts` (queda en env `node`, suite verde 594/594). La clase de regresión de `node:crypto` queda igualmente blindada por: (a) el import ESTÁTICO de `@noble/hashes` → una reintroducción estática de `node:crypto` rompe el build de Next; (b) `flow.test.tsx` (jsdom) ejercita el módulo del adapter sin PDA. ESCALADO al orquestador para decidir si autoriza una config global de test-infra.
- **Aplicar en**: cualquier test que ejerza `PublicKey.findProgramAddress*`/PDA de `@solana/web3.js` NO puede correr bajo jsdom sin una capa de compat cross-realm (inline + setup Buffer). Mantener esos tests en env `node`.

### [2026-07-21] Fix-pack AR-MNR-2 — RPC público hardcodeado en vez de env client-safe
- **Error**: `new Connection(clusterApiUrl(cluster))` fijaba el endpoint público (rate-limited). `resolveSolanaRpcUrl()` (server-only, env NO-`NEXT_PUBLIC`) NO sirve client-side.
- **Causa raíz**: no había resolver de RPC client-safe (las env server-only no llegan al bundle browser).
- **Fix**: nuevo `resolveSolanaRpcUrlPublic(cluster)` en `chain.ts` → lee `NEXT_PUBLIC_SOLANA_RPC_URL` con fallback fail-soft a `clusterApiUrl(cluster)` (nunca throw). Usado en `solana-wallet.ts`. Documentado en `.env.example`.
- **Aplicar en**: cualquier lectura RPC client-side → resolver `NEXT_PUBLIC_*` con fallback público, NUNCA el resolver server-only.

### [2026-07-21] Fix-pack AR-MNR-1 — dead code de PDAs no pasadas a `.accounts()`
- **Error**: `escrowStatePda` y `vault` se derivaban pero NO se pasaban a `.accounts()` (anchor los auto-derivaba) → dead code.
- **Fix**: pasados EXPLÍCITOS en `.accounts({ ..., escrowState: escrowStatePda, vault, senderAta })` (nombres camelCase del IDL `escrow_state`/`vault`). Más robusto ante cambios de resolución de anchor + elimina el dead code. Test que re-deriva las cuentas sigue verde.
- **Aplicar en**: builders de anchor → preferir cuentas PDA explícitas sobre la auto-derivación implícita.

### [2026-07-21] Fix-pack CR-MNR-1 — asimetría String/Number hacia `BN`
- **Error**: `deadline` pasaba `Number` crudo a `new anchor.BN(...)` mientras `amount` usaba `String(...)`.
- **Fix**: `new anchor.BN(String(Math.floor(...)))` — unificado con `amount`. Cosmético/consistencia.
- **Aplicar en**: args numéricos a `BN` → siempre `String(...)` para evitar edge-cases de precisión y mantener consistencia.
