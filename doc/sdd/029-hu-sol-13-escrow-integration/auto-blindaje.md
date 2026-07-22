# Auto-Blindaje — HU-SOL-13 / WKH-216 (Wave 13a, chaski-v3)

Errores cometidos durante F3 y su fix. Protege futuras HUs Solana del mismo tropiezo.

### [2026-07-22] Wave 13a.W1 — Enum Anchor 0.30: variantes en PascalCase, no camelCase
- **Error**: `refundEscrow` chequeaba `Object.keys(state.status)[0] !== "deposited"` y el test encodeaba `{ deposited: {} }`. `BorshAccountsCoder.encode` tiró `unable to infer src variant` y el decode habría dado la key equivocada.
- **Causa raíz**: asumí que anchor lowercasea la 1ª letra de la variante (como en otras versiones). Anchor 0.30.1 usa el **nombre EXACTO del IDL** (`Deposited`/`Released`/`Refunded`) tanto para encode como en el objeto decodeado.
- **Fix**: `statusKey !== "Deposited"` en `refundEscrow`; el test encodea `{ Deposited: {} }` / `{ Released: {} }`. Verificado con un test throwaway (encode/decode round-trip).
- **Aplicar en**: 13b (`readEscrowState`/`verifyVault` en el facilitator) DEBE comparar `status.Deposited` (PascalCase), NO `deposited`. Cualquier lectura de `EscrowStatus`/enums del IDL.

### [2026-07-22] Wave 13a.W0 — Default-param footgun: pasar `undefined` NO desactiva el default
- **Error**: el test "sin envelope solana" construía `new FakeSolanaWallet(undefined)` esperando que `authorizePrincipal` devolviera `{ tx }` sin `solana`. Falló: el gateway se llamó igual.
- **Causa raíz**: en JS, pasar `undefined` a un parámetro con valor por defecto **usa el default**. `constructor(solana = {…})` con `undefined` → envelope presente.
- **Fix**: el fake acepta `SolanaPrincipalAuthorization | null` y el "sin-envelope" es `null` EXPLÍCITO (`new FakeSolanaWallet(null)`). El default sigue siendo el envelope OK cuando se omite.
- **Aplicar en**: cualquier fake/adapter con default-param donde el test necesite el caso "ausente" — usar `null` (sentinel) o un flag, nunca `undefined`.

### [2026-07-22] Wave 13a.W1 — Signature de test inválida como base58 (contenía `l`)
- **Error**: `FAKE_SOLANA_SIGNATURE = "5Solanasignaturebase58…"` y el test de T5 fallaban `ok:true` esperado vs `ok:false`.
- **Causa raíz**: la cadena contenía `l` (L minúscula), EXCLUIDA del alfabeto base58 (junto a `0`, `O`, `I`). El type-guard `BASE58_SIGNATURE` la rechazaba correctamente (fail-closed) → el "happy" caso moría.
- **Fix**: `FAKE_SOLANA_SIGNATURE = bs58.encode(new Uint8Array(64).fill(7))` — base58 válido por construcción, longitud 64 bytes. Ídem en el test T5.
- **Aplicar en**: nunca inventar literales base58 a mano en tests Solana; generarlos con `bs58.encode` / `Keypair`. El alfabeto base58 excluye `0 O I l`.

### [2026-07-22] Wave 13a.W2 — flow-vm `isFallbackWalletAddress` crashea en modo Solana (Scope OUT)
- **Error**: el test T7 que renderizaba `RemittanceFlow` completo en `NEXT_PUBLIC_VM=solana` crasheaba con `address_canonicalization_failed`.
- **Causa raíz**: `flow-vm.isFallbackWalletAddress` (Scope OUT, NO en la tabla de archivos) canonicaliza el `FALLBACK_WALLET_ADDRESS` (una address EVM `0x…`) con `resolveActiveVm()` → en modo Solana `canonicalizeAddress("0x…","solana")` throwea (base58 inválido). Es un gap PRE-EXISTENTE del render del flujo en modo Solana.
- **Fix**: T7 testea `TrackView` **en aislamiento** (se exportó desde `flow.tsx`, en scope) en vez de navegar el flujo completo — cubre exactamente la acción refund (AC-6/AC-7) sin tocar `flow-vm`. NO se modificó `flow-vm` (fuera de scope).
- **Aplicar en**: el render e2e del flujo en modo Solana necesita que `flow-vm` sea VM-safe (canonicalizar el fallback con la VM correcta o gatear por VM) — follow-up fuera de esta HU. Documentar en el report para el Architect.

### [2026-07-22] Wave 13a.W1 — Colisión nombre clase↔interface (`SolanaEscrowRefundGateway`)
- **Error**: `export class SolanaEscrowRefundGateway implements SolanaEscrowRefundGateway` (import del port + clase mismo nombre) = redeclaración.
- **Causa raíz**: el exemplar (`LedgerRefundGateway implements RefundGateway`) tiene clase e interface con nombres distintos; acá el nombre natural de la clase coincide con el del port.
- **Fix**: aliasear el import — `import type { SolanaEscrowRefundGateway as SolanaEscrowRefundPort }` y `class SolanaEscrowRefundGateway implements SolanaEscrowRefundPort`.
- **Aplicar en**: cuando la clase infra reusa el nombre del port, aliasear el type en el import.

### [2026-07-22] Fix-pack AR/CR — BLQ-MED-1 cerrado: `isFallbackWalletAddress` fail-safe (el gap W2 resuelto)
- **Error**: (continuación del W2 de arriba) con `NEXT_PUBLIC_VM=solana` + wallet conectada, `flow.tsx:398` → `isFallbackWalletAddress(address)` canonicalizaba el `FALLBACK_WALLET_ADDRESS` EVM (`0xDEMO…`) bajo vm=solana → `new PublicKey("0xDEMO…")` throwea EN RENDER → el árbol completo de `RemittanceFlow` crasheaba → el usuario NO podía ver el flujo Solana (bloqueaba el e2e HU-SOL-11 y el flip del flag).
- **Causa raíz**: `isFallbackWalletAddress` canonicalizaba SIN try/catch, a diferencia de `addressEqualsVm` (address.ts:39-43) y del `resolveActiveVm` try/catch de `TrackView` (flow.tsx:747-752), que YA eran fail-safe. Inconsistencia de patrón.
- **Fix**: envuelto en try/catch → si el address no canonicaliza bajo el VM activo, NO es el fallback → `false`. Semántica: bajo solana el FALLBACK EVM nunca matchea → banner oculto (correcto). Rama EVM (`toLowerCase`, NUNCA throw) byte-idéntica. Se activó el test full-flow `RemittanceFlow` bajo vm=solana (T8 en flow.test.tsx) que prueba que ya NO crashea. `flow-vm.ts` entró de Scope-OUT por decisión del orquestador SOLO para este fix.
- **Aplicar en**: TODA función de presentación/helper que llame `canonicalizeAddress` con `resolveActiveVm()` sobre un literal cross-VM (un address de una VM canonicalizado bajo la otra) DEBE ir en try/catch fail-safe. El único canonicalizador que NUNCA throwea es el EVM; solana/otras VM throwean con input inválido.
