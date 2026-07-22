# Auto-Blindaje — #028 [WKH-208 / HU-SOL-9]

Errores cometidos y corregidos durante F3. Cada entrada protege futuras HUs del mismo error.

### [2026-07-22 01:26] Wave 2 — Export de helper desde un `route.ts` de Next.js rompe `tsc`
- **Error**: exporté `addressEquals` desde `app/api/settle/principal/route.ts` para poder unit-testearlo (T6). `npx tsc --noEmit` falló: `Property 'addressEquals' is incompatible with index signature. Type '(a,b,vm)=>boolean' is not assignable to type 'never'`.
- **Causa raíz**: Next.js App Router genera `.next/types/**/route.ts` que valida los exports de cada `route.ts` contra el set cerrado de handlers HTTP (GET/POST/…). Cualquier export extra debe ser `never` → un helper exportado rompe el typecheck. El gate es `tsc --noEmit` COMPLETO (CD-12), que incluye `.next/types`, así que no se puede exportar aunque en un checkout fresco sin `.next/` pasaría.
- **Fix**: `addressEquals` queda como función **NO exportada** (privada del route). T6 no puede importarla; se cubre la rama EVM vía los 8 tests B1-B6 existentes (byte-idéntico) + la igualdad canónica base58 vía `address.test.ts` (`canonicalizeAddress`) + un test de route en `vm=solana` que prueba el fail-closed PRE-broadcast (CD-5, sin fetch). La rama Solana de `addressEquals` es forward-looking (el settle Solana completo — resolvers/att Solana-aware — es HU-SOL-13), no alcanzable e2e vía la route en esta HU.
- **Aplicar en**: cualquier HU que quiera compartir/testear un helper de un `route.ts` de Next → el helper va en un módulo NO-route (ej. `src/infrastructure/*`), nunca exportado desde el `route.ts`.

### [2026-07-22 01:28] Wave 2 — Test Solana de HU-SOL-8 asumía `0x` en PR4, roto por la apertura base58
- **Error**: tras VM-branchear PR4 en `prepare/route.ts` (solana → `canonicalizeAddress` base58), 2 tests de HU-SOL-8 (`PR6 rama Solana`) fallaron: enviaban un `address` `0x…` con `NEXT_PUBLIC_VM=solana` y esperaban llegar a PR6; ahora PR4 rechaza `0x` en solana (un address `0x…` empieza por `0`, excluido del alfabeto base58) → `400 prepare_invalid_request` antes de PR6.
- **Causa raíz**: HU-SOL-8 dejó PR4 en `isAddress` (aceptaba `0x` incluso en solana) y sus tests lo explotaban, con un comentario explícito "abrir base58 es HU-SOL-9". Esta HU cumple justamente esa apertura → el `address` del caller en solana ahora DEBE ser base58.
- **Fix**: los 2 tests solana usan `address: SOL_ADDR` (pubkey base58) para pasar PR4 y llegar a PR6. Las assertions (503 `payout_pop_unavailable` / 403 `payout_pop_unverified` / ningún fetch) NO cambian. NO son tests EVM (corren con `NEXT_PUBLIC_VM=solana`), así que la invariante "ningún test EVM cambia su assertion" (AC-2/CD-1) se mantiene.
- **Aplicar en**: al VM-branchear un guard que otra HU dejó EVM-only "hasta la HU siguiente", revisar los tests de esa HU que dependían del comportamiento viejo en modo Solana y actualizarlos al nuevo contrato (input base58), sin tocar sus assertions.
