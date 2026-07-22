# Story File — #027: [WKH-211 / HU-SOL-8] PoP + atestación ed25519 VM-aware — GATE DE SEGURIDAD (money-path Solana)

> SDD: `doc/sdd/027-hu-sol-8-pop-ed25519/sdd.md` (SPEC_APPROVED)
> Work Item: `doc/sdd/027-hu-sol-8-pop-ed25519/work-item.md`
> Fecha: 2026-07-22
> Branch: `feat/027-hu-sol-8-pop-ed25519`
> Tipo: security-gate (money-path Solana). **AR OBLIGATORIO tras F3.** Smart Sizing **QUALITY**.

---

## Goal

El gate G5 de proof-of-possession del payout (WKH-206) hoy es 100% ECDSA/viem: tipa `address: 0x+40hex`
+ `chainId:number`, valida con `isAddress`/`viem.verifyMessage`, y frente a una address Solana base58
rechaza siempre. Esta HU agrega la **rama Solana** del gate, 100% aditiva detrás de `resolveActiveVm()`:
(1) un verificador ed25519 aislado (`pop-verify-solana.ts`, nuevo) con decode base58 **estricto de 32
bytes**; (2) tipos/funciones Solana paralelos en `pop-challenge.ts` que atan un **network-id CAIP-2**
(`solana:devnet`/`solana:mainnet`) en vez del `chainId:number` EVM (anti-replay cross-cluster, clase
"$400 por $0"); (3) PoP **OBLIGATORIO** en el money-path Solana (fail-closed 503, nunca skip silencioso);
(4) el nonce single-use se reusa sin duplicar. Además, el **firmado real del cliente Solana (W2)** cierra
el `signMessage` que hoy es un stub — verificador server + firma cliente juntos deben permitir que un
usuario Solana legítimo **PASE** el gate G5 e2e. La rama EVM NO se toca ni un byte.

---

## 🥇 REGLA DE ORO (leé esto ANTES de tocar código)

1. **CD-1 / CD-SDD-1 es la regla suprema: la rama EVM de `pop-challenge.ts` (`PopChallenge`,
   `issuePopChallenge`, `verifyPopChallenge`, `buildPopMessage`) se deja SIN TOCAR UN BYTE.** Las
   funciones Solana son **hermanas nuevas** en el mismo archivo. **PROHIBIDO** agregar un campo `vm` (ni
   ningún campo) a la interface `PopChallenge` EVM ni a su payload HMAC. Si para compilar la rama Solana
   necesitás editar una assertion de `pop-challenge.test.ts` EVM → **diseño incorrecto, PARÁ y escalá al
   Architect**.
2. **CD-SDD-2 (EVM byte-idéntico en routes):** en `submit`/`prepare` el bloque EVM del guard PoP se mueve
   a un `else if (POP_SECRET)` con el código **carácter por carácter** actual. El `git diff` de la rama
   EVM debe ser **solo** la indentación + la condición del `else if`, **cero lógica**. `vm==='evm'` +
   `!POP_SECRET` ⇒ skip byte-idéntico a hoy (AC-8).
3. **CD-2 (PoP OBLIGATORIO Solana):** cuando `vm==='solana'` en `submit`/`prepare`, la ausencia de
   `PAYOUT_POP_SECRET` ⇒ **503 `payout_pop_unavailable` fail-closed**. **PROHIBIDO** el skip silencioso que
   sí es correcto en EVM.
4. **CD-3 / CD-SDD-4 (CAIP-2 anti-cross-cluster):** el `networkId` del binding se resuelve SIEMPRE
   server-side vía `resolveSolanaNetworkId()`. **NUNCA** sale del body del caller. Un token
   `solana:mainnet` contra un server `solana:devnet` ⇒ 403 (P4).
5. **CD-4 / CD-8 (decode base58 estricto):** el pubkey se decodifica SOLO con `new PublicKey(addr).toBytes()`
   (32 bytes exactos o throw). **PROHIBIDO** un decoder base58 ad-hoc para el pubkey. **PROHIBIDO**
   `.toLowerCase()` sobre base58. Un input malformado NUNCA llega a `nacl.sign.detached.verify` (AC-5).
6. **CD-5 / CD-SDD-5 (nonce single-use):** la rama Solana reusa `claimPopNonceOnce` con el namespace
   `pop:nonce:${nonce}` actual, **sin sufijo por VM**. **PROHIBIDO** un segundo mecanismo de nonce o uno
   que no falle cerrado ante Upstash caído.
7. **CD-SDD-3 (browser-safe — RECURRENTE, auto-blindaje HU-SOL-5 BLQ-MED-1):** el código client-side
   (`solana-wallet.ts`) **NUNCA** usa `Buffer` node-only ni `node:crypto`. Codificación con `bs58`
   (isomórfica) + `TextEncoder`. El test-env `node` puede enmascarar la falla.
8. **No-oracle (AC-2):** todo fallo cripto/stateless (P1-P5) devuelve el MISMO 403 opaco
   `payout_pop_unverified`. NUNCA distinguir el motivo en la respuesta.

---

## Acceptance Criteria (EARS) — copiados del SDD aprobado

- **AC-1**: `vm==='solana'` + address base58 ⇒ verificar con `nacl.sign.detached.verify(messageBytes,
  signatureBytes, pubkeyBytes)`, `pubkeyBytes` = decode base58 estricto de exactamente 32 bytes.
- **AC-2**: firma ed25519 forjada/inválida ⇒ mismo 403 opaco `payout_pop_unverified` que la rama EVM.
- **AC-3**: `vm==='solana'` en el money-path (`submit`/`prepare`) ⇒ PoP OBLIGATORIO; ausencia de config
  ⇒ fail-closed (503/501), NUNCA skip silencioso.
- **AC-4**: atestación de un network-id (`solana:devnet`) presentada contra otro (`solana:mainnet`) ⇒
  rechazo (binding CAIP-2, análogo al chainId EVM A7″).
- **AC-5**: decode del pubkey base58 ≠ 32 bytes ⇒ rechazo fail-closed SIN invocar
  `nacl.sign.detached.verify`.
- **AC-6**: `buildPopMessage`/`buildSolanaPopMessage` = ÚNICA fuente de verdad del mensaje; extensión
  CAIP-2 aditiva, sin duplicar reconstrucción cliente/servidor.
- **AC-7**: firma Solana OK ⇒ reclama el nonce vía `claimPopNonceOnce`, fail-closed si Upstash caído.
- **AC-8**: `vm==='evm'` ⇒ verificación por el MISMO `viem.verifyMessage`/`isAddress` EXACTO,
  byte-idéntico, sin cambios en la suite de tests EVM.

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Wave | Exemplar |
|---|---------|--------|-----------|------|----------|
| 1 | `package.json` | Modificar | `+ "tweetnacl": "1.0.3"` + `"bs58": "6.0.0"` (pinned EXACTAS, sin `^`) en `dependencies` | W0 | resto de deps pinned |
| 2 | `src/infrastructure/chain.ts` | Modificar | `+ resolveSolanaNetworkId(): string` tras `resolveSolanaNetworkConfig` (L131). Aditivo, EVM/Solana existente intacto | W0 | `chain.ts:128-131`, `:175-184` (switch) |
| 3 | `src/infrastructure/auth/pop-challenge.ts` | Modificar | `+ SolanaPopChallenge` + `issueSolanaPopChallenge` + `verifySolanaPopChallenge` + `buildSolanaPopMessage` (hermanas nuevas). **Rama EVM L14-100 SIN TOCAR** | W0 | `pop-challenge.ts:43-100` (mirror estructural) |
| 4 | `src/infrastructure/auth/pop-verify-solana.ts` | **Crear** | `verifySolanaPop({addressBase58, message, signatureBase58}): boolean` — ed25519 + decode estricto | W0 | `attestation.ts` (verificador aislado fail-closed) |
| 5 | `app/api/a2a/payout/challenge/route.ts` | Modificar | rama `vm==='solana'` que emite challenge/message Solana. EVM byte-idéntico | W1 | mismo archivo L54-67 (rama EVM) |
| 6 | `app/api/a2a/payout/submit/route.ts` | Modificar | Guard §7 (L119-177): dispatch por VM. Solana OBLIGATORIO; bloque EVM verbatim en `else if (POP_SECRET)`. +imports | W1 | mismo archivo L126-177 |
| 7 | `app/api/payout/prepare/route.ts` | Modificar | PR6 (L109-147): idem submit **SIN P6 claim-once**. +imports | W1 | mismo archivo L113-147 |
| 8 | `src/infrastructure/solana-wallet-bridge.ts` | Modificar | `+ registerSignMessage(fn)` + `signMessage(bytes)` (mirror de signTransaction L48-57) + limpiar en `reset()` (L91-96) | W2 | mismo archivo L16, L21, L47-57, L95 |
| 9 | `src/presentation/solana/solana-providers.tsx` | Modificar | capturar `useWallet().signMessage` en el sync component + `useEffect` de registro | W2 | mismo archivo L16, L20-22 |
| 10 | `src/infrastructure/solana-wallet.ts` | Modificar | reemplazar el STUB `signMessage` (L152-154) por impl real base58 browser-safe | W2 | `solana-wallet.ts:60-62` (sha256 browser-safe) |
| — | `src/infrastructure/auth/http-pop-signer.ts` | **SIN CAMBIO** | VM-agnóstico, ya llama `wallet.signMessage(popMessage)` (L29). Confirmar, no editar | — | — |
| — | `src/infrastructure/auth/pop-nonce-store.ts` | **SIN CAMBIO** | namespace VM-agnóstico, se reusa. Confirmar, no editar | — | — |
| T1 | `src/infrastructure/auth/pop-verify-solana.test.ts` | **Crear** | AC-1/AC-2/AC-5 (env `node`) | W3 | `pop-challenge.test.ts` (keypair real) |
| T2 | `src/infrastructure/auth/pop-challenge.test.ts` | Modificar | +tests Solana AC-6. **Assertions EVM SIN EDITAR** | W3 | mismo archivo (rama EVM) |
| T3 | `app/api/a2a/payout/submit/route.test.ts` | Modificar | +rama Solana AC-2/AC-3/AC-4/AC-7 + regresión EVM AC-8 | W3 | `submit/route.test.ts` (`vi.stubEnv`) |
| T4 | `app/api/payout/prepare/route.test.ts` | Modificar | +rama Solana AC-3 (503 obligatorio) + regresión EVM | W3 | `prepare/route.test.ts` |
| T5 | `app/api/a2a/payout/challenge/route.test.ts` | Modificar | +emisión Solana (200 con popMessage / 400 base58 inválido) | W3 | `challenge/route.test.ts` |
| T6 | `src/infrastructure/solana-wallet.test.ts` | Modificar | `signMessage` real con fake bridge (CD-SDD-3) | W3 | `solana-wallet.test.ts` |

---

## Contratos / Tipos exactos

### `resolveSolanaNetworkId()` — `chain.ts` (tras L131)

```ts
/** Network-id CAIP-2 del cluster Solana activo (CD-3, anti-replay cross-cluster). switch sobre el
 *  literal cluster (sin object-injection, patrón de resolveActiveNetworkConfig L175). En esta HU solo
 *  existe devnet; mainnet-beta → "solana:mainnet" cuando HU-SOL-2/SOL-4 agreguen la entrada. */
export function resolveSolanaNetworkId(): string {
  switch (resolveSolanaNetworkConfig().cluster) {
    case "devnet":
      return "solana:devnet";
    // mainnet-beta → "solana:mainnet"
  }
}
```
> Nota TS: `cluster` hoy es el tipo literal `"devnet"` (chain.ts:101) ⇒ el `switch` es exhaustivo sin
> `default`. Si `tsc` exige un return en todos los paths, agregá `default: throw new Error("unsupported_solana_cluster")`.

### `SolanaPopChallenge` + funciones — `pop-challenge.ts` (hermanas nuevas, EVM intacto)

```ts
export interface SolanaPopChallenge {
  address: string;   // base58 canónico (PublicKey.toBase58), case-sensitive (CD-8)
  networkId: string; // CAIP-2: "solana:devnet" | "solana:mainnet" (CD-3) — REEMPLAZA a chainId
  nonce: string;     // 32 hex (mismo randomBytes(16).toString('hex') que EVM)
  exp: number;       // epoch SEGUNDOS
}

// SSOT del mensaje Solana (CD-6). 5 líneas \n-separadas, SIN \n final. Mirror estructural de
// buildPopMessage pero con `network:` en vez de `chainId:`. El cliente lo firma VERBATIM.
export function buildSolanaPopMessage(p: SolanaPopChallenge): string {
  return `Chaski Proof-of-Possession\naddress: ${p.address}\nnetwork: ${p.networkId}\nnonce: ${p.nonce}\nexpires: ${p.exp}`;
}
```
- `issueSolanaPopChallenge(p: SolanaPopChallenge): string` — reusa la `secret()` privada + `sign()`
  (HMAC `node:crypto` sobre el b64url del payload), MISMO esquema `issuePopChallenge` L43-46.
- `verifySolanaPopChallenge(token: string, nowMs: number): SolanaPopChallenge | null` — mirror de
  `verifyPopChallenge` L62-100 (HMAC-first, parse en try/catch, expiración), validación por campo:
  - `address`: `typeof === "string"` no-vacío (la validez base58 la cierra el verifier ed25519, NO acá).
  - `networkId`: `typeof === "string"` && `/^solana:(devnet|mainnet)$/.test(networkId)`.
  - `nonce`: `/^[0-9a-f]{32}$/` (idéntico regex que EVM L93).
  - `exp`: `typeof === "number"` && `Number.isFinite(exp)` && `exp*1000 > nowMs`.
  - Devuelve `SolanaPopChallenge | null` (fail-closed → 403 opaco).
> `secret()`/`sign()`/`isRecord()` YA son privados en el módulo — reusarlos, NO duplicarlos.

### `verifySolanaPop` — `pop-verify-solana.ts` (NUEVO)

```ts
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

// Decode del pubkey base58 → EXACTAMENTE 32 bytes vía el path AUDITADO de HU-SOL-7 (CD-4). PublicKey
// throwea si el largo ≠ 32 o el base58 es inválido ⇒ el input malformado NUNCA llega a nacl.verify (AC-5).
function pubkeyBytes(addressBase58: string): Uint8Array {
  return new PublicKey(addressBase58).toBytes(); // 32 bytes exactos o throw
}

export function verifySolanaPop(params: {
  addressBase58: string;
  message: string;          // buildSolanaPopMessage(...) VERBATIM (CD-6)
  signatureBase58: string;  // 64 bytes base58
}): boolean {
  let pub: Uint8Array;
  try { pub = pubkeyBytes(params.addressBase58); } catch { return false; } // AC-5
  if (pub.length !== 32) return false;                                     // defensa en profundidad
  let sig: Uint8Array;
  try { sig = bs58.decode(params.signatureBase58); } catch { return false; }
  if (sig.length !== 64) return false;                                     // AC-5 (firma)
  const msg = new TextEncoder().encode(params.message);                    // browser+node-safe
  try { return nacl.sign.detached.verify(msg, sig, pub); } catch { return false; } // AC-1
}
```
> La FIRMA (64 bytes) NO es un PublicKey ⇒ se decodifica con `bs58` (isomórfico, evita `Buffer` node-only).
> Orden de args de `nacl.sign.detached.verify` = `(msg, sig, pubkey)` — VERBATIM al AC-1.

### `signMessage` real — `solana-wallet.ts` (reemplaza el stub L152-154)

```ts
async signMessage(message: string): Promise<string> {
  const bytes = new TextEncoder().encode(message);         // browser+node-safe (NO Buffer, CD-SDD-3)
  const sig = await solanaWalletBridge.signMessage(bytes); // Uint8Array(64) de la wallet
  return bs58.encode(sig instanceof Uint8Array ? sig : new Uint8Array(sig)); // base58, browser-safe
}
```
> Importar `bs58` en `solana-wallet.ts`. `bs58.encode` es isomórfico. El shape base58 es simétrico con
> `verifySolanaPop.signatureBase58`. Normalizar a `Uint8Array` cubre adapters que devuelvan `{signature}`
> u otro shape (R-2 del SDD).

### `solana-wallet-bridge.ts` — handle de signMessage (mirror de signTransaction)

```ts
type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>;
// campo privado:  private signMsgHandle: SignMessageFn | null = null;
registerSignMessage(fn: SignMessageFn): void { this.signMsgHandle = fn; }
async signMessage(message: Uint8Array): Promise<Uint8Array> {
  if (!this.signMsgHandle) throw new Error("wallet_sign_not_available"); // fail-loud, mirror L55
  return this.signMsgHandle(message);
}
// en reset() (L91-96): this.signMsgHandle = null;  // aditivo, junto a signTxHandle
```

### `solana-providers.tsx` — capturar signMessage

```tsx
const { publicKey, connected, signMessage } = useWallet(); // + signMessage
// nuevo useEffect (junto a los de L20-35):
useEffect(() => {
  if (signMessage) solanaWalletBridge.registerSignMessage((bytes) => signMessage(bytes));
}, [signMessage]);
```
> `useWallet().signMessage` es `((message: Uint8Array) => Promise<Uint8Array>) | undefined` en el
> wallet-adapter. Registrar solo si está definido (Phantom/Solflare lo exponen).

---

## Contrato de Integración ⚠️ BLOQUEANTE

> Esta HU tiene comunicación cliente ↔ servidor (wallet Solana firma ↔ routes verifican).

### Cliente (`http-pop-signer.ts`, SIN cambio) → `POST /api/a2a/payout/challenge`  [emisión, W1]

**Request:** `{ "address": "string — base58 (vm=solana) o 0xhex (vm=evm)" }`

**Response 200 (vm=solana):**
```json
{
  "popChallenge": "string — <b64url(payload)>.<b64url(hmac)>, payload = SolanaPopChallenge",
  "popMessage":   "string — buildSolanaPopMessage(...) VERBATIM, 5 líneas, línea 'network: solana:devnet'",
  "exp":          "number — epoch segundos"
}
```
**Errores:** `400 pop_invalid_request` (base58 no canonicalizable) · `501 pop_not_configured`
(sin `PAYOUT_POP_SECRET` — ANTES de la rama VM, intacto) · `429`/`503` rate-limit (intacto).

### Cliente (`SolanaWalletAdapter.signMessage`, W2) → firma la wallet

- El cliente firma `popMessage` VERBATIM (CD-6). `signMessage(popMessage)` ⇒ base58 de 64 bytes.
- Transporte: el use-case adjunta `{ popChallenge, popSignature }` al body de submit/prepare.

### Cliente → `POST /api/a2a/payout/submit` (guard §7) y `POST /api/payout/prepare` (PR6)  [verificación]

**Request (campos PoP):** `{ "popChallenge": "string", "popSignature": "string — base58 64 bytes (solana) | 0xhex (evm)", ...resto del payout }`

**Errores (rama Solana):**
| HTTP | error | Cuándo |
|---|---|---|
| 503 | `payout_pop_unavailable` | `vm=solana` + `PAYOUT_POP_SECRET` ausente (**OBLIGATORIO**, AC-3/CD-2) · o Upstash caído en P6 (AC-7) |
| 403 | `payout_pop_unverified` | P1 presencia/tipo · P2 HMAC/exp/tipos · P3 address mismatch · P4 CAIP-2 mismatch · P5 firma ed25519 inválida (todo opaco, AC-2) |
| 409 | `payout_pop_replayed` | P6 nonce ya usado (solo `submit`, AC-7) |
| 200/forward | — | firma válida + nonce fresco ⇒ el guard pasa (usuario Solana legítimo PASA el gate G5) |

> `prepare` PR6 **NO** tiene P6 (no claim-once; el nonce se quema en submit). El resto idéntico.

---

## Guard §7 de `submit/route.ts` — estructura exacta (dispatch por VM)

Reestructurar el `if (POP_SECRET)` actual (L126) en un dispatch. **El bloque EVM L126-177 se mueve
VERBATIM al `else if (POP_SECRET)`:**

```ts
const vm = resolveActiveVm();
const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler
if (vm === "solana") {
  // CD-2 / AC-3: OBLIGATORIO. Sin secreto → 503 fail-closed (NUNCA skip).
  if (!POP_SECRET) return NextResponse.json({ error: "payout_pop_unavailable" }, { status: 503 });
  const popChallenge = body.popChallenge, popSignature = body.popSignature;
  // P1 presencia+tipo → 403 opaco
  if (typeof popChallenge !== "string" || !popChallenge.trim()
   || typeof popSignature !== "string" || !popSignature.trim())
    return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  // P2 HMAC+exp+tipos → 403 opaco
  const ch = verifySolanaPopChallenge(popChallenge, Date.now());
  if (!ch) return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  // P3 address match (CD-8, base58 case-sensitive). canonicalizeAddress throwea → try/catch → 403.
  try {
    if (canonicalizeAddress(ch.address, "solana") !== canonicalizeAddress(address, "solana"))
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  } catch { return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 }); }
  // P4 CAIP-2 binding (AC-4/CD-3): network-id del token vs el resuelto server-side.
  if (ch.networkId !== resolveSolanaNetworkId())
    return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  // P5 ed25519 (AC-1/AC-2): mensaje reconstruido con la MISMA buildSolanaPopMessage (CD-6).
  if (!verifySolanaPop({ addressBase58: ch.address, message: buildSolanaPopMessage(ch), signatureBase58: popSignature }))
    return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  // P6 nonce single-use (AC-7/CD-5): reusa claimPopNonceOnce, fail-closed.
  const claim = await claimPopNonceOnce(ch.nonce);
  if (!claim.ok) {
    if ("alreadyUsed" in claim) return NextResponse.json({ error: "payout_pop_replayed" }, { status: 409 });
    return NextResponse.json({ error: "payout_pop_unavailable" }, { status: 503 });
  }
} else if (POP_SECRET) {
  // ── RAMA EVM: bloque WKH-206 L127-176 EXACTO, byte-idéntico (verifyPopChallenge/verifyMessage/
  //    isAddress/resolveChainId). CD-SDD-2: el diff EVM es solo indentación + condición del else if. ──
}
```
> `vm==='evm'`: la 1ª condición es falsa ⇒ cae al `else if (POP_SECRET)` idéntico al actual;
> `!POP_SECRET` + evm ⇒ skip (como hoy). **EVM byte-idéntico (AC-8).**

**`prepare/route.ts` PR6 (L109-147):** MISMA estructura **sin el bloque P6** (claim-once). Rama Solana
igualmente OBLIGATORIA (503 sin secreto). Ver R-3 abajo sobre la alcanzabilidad de PR4.

### Imports a agregar en `submit/route.ts` y `prepare/route.ts`
Del módulo `.../pop-challenge`: `verifySolanaPopChallenge, buildSolanaPopMessage` (junto a
`verifyPopChallenge, buildPopMessage` ya importados). Nuevo import `verifySolanaPop` de
`.../auth/pop-verify-solana`. De `.../chain`: `resolveSolanaNetworkId` (junto a `resolveChainId,
resolveActiveVm`). `canonicalizeAddress` y `claimPopNonceOnce` ya están importados.

---

## Constraint Directives

### OBLIGATORIO
- **CD-1 / CD-SDD-1**: rama EVM de `pop-challenge.ts` (L14-100) sin tocar un byte. Funciones Solana = hermanas nuevas.
- **CD-SDD-2**: bloque EVM del guard en routes movido a `else if (POP_SECRET)` carácter por carácter.
- **CD-2**: `vm==='solana'` sin `PAYOUT_POP_SECRET` ⇒ 503 fail-closed. Nunca skip.
- **CD-3 / CD-SDD-4**: `networkId` desde `resolveSolanaNetworkId()` server-side, nunca del body. Match en P4.
- **CD-4 / CD-8**: pubkey vía `new PublicKey(addr).toBytes()`. Address compare vía `canonicalizeAddress(x,"solana")`. Nunca `.toLowerCase()` sobre base58.
- **CD-5 / CD-SDD-5**: reusar `claimPopNonceOnce` con `pop:nonce:${nonce}`, fail-closed. Sin sufijo VM.
- **CD-6**: `buildSolanaPopMessage` = SSOT del mensaje Solana. El cliente firma VERBATIM. El verifier de la route reconstruye con la MISMA función.
- **CD-SDD-3**: client-side (`solana-wallet.ts`) sin `Buffer` node-only ni `node:crypto`. `bs58` + `TextEncoder`.
- **CD-SDD-6 (dep-hygiene — RECURRENTE, auto-blindaje HU-SOL-4 ERESOLVE)**: agregar `tweetnacl@1.0.3` + `bs58@6.0.0` pinned EXACTAS y **verificar `npm install tweetnacl@1.0.3 bs58@6.0.0 --dry-run` exit 0 SIN `--legacy-peer-deps`** antes de importar (ver Wave -1).
- **CD-SDD-7 (tsc completo — RECURRENTE, auto-blindaje HU-SOL-5/WKH-196)**: el gate es `npx tsc --noEmit` COMPLETO (incluye tests), NO `next build`. Respetar `noUncheckedIndexedAccess` (narrowing helpers, cero `!`/`any`).

### PROHIBIDO
- Agregar `vm` (o cualquier campo) a `PopChallenge` EVM o a su payload HMAC.
- Un segundo mecanismo de nonce, o un nonce Solana stateless / que no falle cerrado.
- Un decoder base58 ad-hoc para el pubkey (usar `new PublicKey(...).toBytes()`).
- Que `vm==='solana'` sin `PAYOUT_POP_SECRET` haga skip (debe ser 503).
- Distinguir el motivo de rechazo en la respuesta (todo fallo cripto/stateless → 403 opaco).
- `--legacy-peer-deps`, `--force`, `overrides` (Golden Path). `@solana/pay` (CD-7).
- Encender flags nuevos en ambientes compartidos (Solana sigue devnet/flags OFF).
- Editar cualquier assertion EVM de `pop-challenge.test.ts` / `submit`/`prepare`/`challenge` route tests.
- Modificar archivos fuera de la tabla "Files to Modify/Create".

---

## Test Expectations (≥1 por AC)

| Test (archivo) | ACs | Qué prueba | Framework | Env |
|---|---|---|---|---|
| `pop-verify-solana.test.ts` | AC-1 | keypair `nacl.sign.keyPair()` firma `buildSolanaPopMessage` ⇒ `verifySolanaPop`=true | vitest | **node** |
| `pop-verify-solana.test.ts` | AC-2/AC-5 | (a) firma 64B random ⇒ false; (b) firma de OTRA key ⇒ false; (c) mensaje alterado ⇒ false; (d) base58 pubkey→31/33 bytes ⇒ false; (e) base58 inválido ⇒ false; (f) firma ≠64B ⇒ false; **spy: `nacl.sign.detached.verify` NO invocado** en (d)/(e)/(f) | vitest | node |
| `pop-challenge.test.ts` | AC-6 | (a) `buildSolanaPopMessage(p)` === string exacto de 5 líneas SIN `\n` final, con `network:`; (b) round-trip `issueSolanaPopChallenge`→`verifySolanaPopChallenge` reconstruye idéntico; (c) `networkId` fuera de `/^solana:(devnet\|mainnet)$/` ⇒ null | vitest | node |
| `pop-challenge.test.ts` | AC-8 | **assertions EVM existentes corren SIN editar** (`toEqual({address,chainId,nonce,exp})`, string exacto de `buildPopMessage`) | vitest | node |
| `submit/route.test.ts` | AC-3 | `vm='solana'` (`NEXT_PUBLIC_VM=solana`) + `PAYOUT_POP_SECRET` unset ⇒ 503 `payout_pop_unavailable`, NUNCA forward | vitest + `vi.stubEnv` | node |
| `submit/route.test.ts` | AC-2 | `vm='solana'` + popSignature forjada ⇒ 403 `payout_pop_unverified` | vitest | node |
| `submit/route.test.ts` | AC-4 | token `networkId='solana:mainnet'` (HMAC válido) + server `resolveSolanaNetworkId()='solana:devnet'` ⇒ 403 | vitest | node |
| `submit/route.test.ts` | AC-7 | (a) firma OK ⇒ `claimPopNonceOnce` llamado; (b) nonce ya usado ⇒ 409 `payout_pop_replayed`; (c) Upstash unavailable ⇒ 503, sin forward | vitest | node |
| `submit/route.test.ts` | AC-8 | `vm='evm'`: `POP_SECRET` ausente ⇒ skip byte-idéntico; presente + firma viem válida ⇒ pasa por `verifyMessage`. `guard8-intact.test.ts` verde | vitest | node |
| `prepare/route.test.ts` | AC-3 | `vm='solana'` + secreto unset ⇒ 503; + regresión EVM | vitest | node |
| `challenge/route.test.ts` | — | `vm='solana'`: address base58 válida ⇒ 200 con `popMessage` con `network:`; base58 inválido ⇒ 400 | vitest | node |
| `solana-wallet.test.ts` | — (W2) | fake bridge devuelve `Uint8Array(64)` ⇒ `signMessage` retorna base58 de 64 bytes; NUNCA usa `Buffer` node-only | vitest | node |

> **Test-First**: obligatorio para el verificador (`pop-verify-solana.ts`), las routes y el adapter
> (lógica de negocio + security gate). Ver criterio del template.

### Notas de test-infra (auto-blindaje — NO negociable)
- Tests que ejercen `PublicKey`/PDA corren en env **`node`** (NO jsdom; cross-realm `Buffer`, HU-SOL-5).
- Tests de componente (providers, si se agregan) usan jsdom + `cleanup()` en `afterEach` (HU-SOL-4 W3.2).
- Accesos por índice con narrowing helpers (`noUncheckedIndexedAccess`, HU-SOL-5 W3). Cero `!`/`any`.
- Para forzar `vm='solana'` en route tests: `vi.stubEnv("NEXT_PUBLIC_VM", "solana")` (el secreto se lee dentro del handler, CD-14 ⇒ `vi.stubEnv` funciona).

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO — antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
# 1) Dependencias resuelven SIN --legacy-peer-deps (CD-SDD-6, RECURRENTE HU-SOL-4)
npm install tweetnacl@1.0.3 bs58@6.0.0 --dry-run   # DEBE ser exit 0, SIN ERESOLVE
# 2) Archivos base del Scope IN existen
ls src/infrastructure/auth/pop-challenge.ts \
   app/api/a2a/payout/challenge/route.ts \
   app/api/a2a/payout/submit/route.ts \
   app/api/payout/prepare/route.ts \
   src/infrastructure/chain.ts \
   src/infrastructure/solana-wallet.ts \
   src/infrastructure/solana-wallet-bridge.ts \
   src/presentation/solana/solana-providers.tsx
# 3) Baseline verde ANTES de cambiar nada
npx tsc --noEmit && npm test -- --run
```
**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar sobre un entorno roto.
En particular, si el `--dry-run` pide `--legacy-peer-deps` → **PARÁ y escalá** (viola CD-7/CD-SDD-6; el
fallback es `@noble/curves/ed25519` pinned, SDD §4.4, pero requiere aprobación del Architect).

### Wave 0 (Serial Gate — deps + contratos + verificador aislado)
- [ ] **W0.1** `package.json`: `+tweetnacl@1.0.3` `+bs58@6.0.0` pinned exactas; `npm install`; confirmar tipos (`tweetnacl` trae `.d.ts`; `bs58@6` trae tipos propios).
- [ ] **W0.2** `chain.ts`: `+resolveSolanaNetworkId()` tras L131. Aditivo.
- [ ] **W0.3** `pop-challenge.ts`: `+SolanaPopChallenge` + `issueSolanaPopChallenge` + `verifySolanaPopChallenge` + `buildSolanaPopMessage`. **Rama EVM L14-100 sin tocar.**
- [ ] **W0.4** `pop-verify-solana.ts` (nuevo): `verifySolanaPop`.
- **Gate W0**: `npx tsc --noEmit` COMPLETO verde.

### Wave 1 (Server wiring — guard-order intacto, EVM byte-idéntico)
- [ ] **W1.1** `challenge/route.ts`: rama `vm==='solana'` (emite challenge/message Solana). EVM byte-idéntico.
- [ ] **W1.2** `submit/route.ts`: guard §7 dispatch por VM. Bloque EVM verbatim en `else if (POP_SECRET)`. +imports.
- [ ] **W1.3** `prepare/route.ts`: PR6 dispatch por VM, SIN claim-once. +imports.
- **Gate W1**: `npx tsc --noEmit` + tests de las 3 routes (incluida regresión EVM) verdes.

### Wave 2 (Firmado real del cliente Solana — cierra el gate e2e, IN SCOPE)
- [ ] **W2.1** `solana-wallet-bridge.ts`: `+registerSignMessage/signMessage` (mirror signTransaction) + limpiar en `reset()`.
- [ ] **W2.2** `solana-providers.tsx`: capturar `useWallet().signMessage` + `useEffect` de registro.
- [ ] **W2.3** `solana-wallet.ts`: `signMessage` real base58 browser-safe (reemplaza el stub L152-154).
- [ ] Confirmar `http-pop-signer.ts` SIN cambio.
- **Gate W2**: `npx tsc --noEmit` verde.

### Wave 3 (Tests)
- [ ] **W3.1** `pop-verify-solana.test.ts` (nuevo, env `node`) — AC-1/AC-2/AC-5.
- [ ] **W3.2** `pop-challenge.test.ts`: +tests Solana AC-6 (EVM intactos).
- [ ] **W3.3** `submit/route.test.ts` + `prepare/route.test.ts`: rama Solana AC-2/3/4/7 + regresión EVM AC-8.
- [ ] **W3.4** `challenge/route.test.ts`: emisión Solana.
- [ ] **W3.5** `solana-wallet.test.ts`: `signMessage` real (fake bridge).
- **Gate final**: `npx tsc --noEmit` COMPLETO + **toda** la suite verde, **sin editar ninguna assertion EVM**.

### Verificación Incremental
| Wave | Verificación al completar |
|------|--------------------------|
| W-1 | dry-run deps exit 0 + baseline verde |
| W0 | `npx tsc --noEmit` verde |
| W1 | tsc + tests de routes (con regresión EVM) |
| W2 | tsc verde |
| W3 | tsc COMPLETO + suite completa verde, assertions EVM intactas |

---

## Out of Scope (NO tocar bajo ninguna circunstancia)

- **Rama EVM** de `pop-challenge.ts` (L14-100) — ni un byte. Ni el bloque EVM de las routes (solo se re-indenta al `else if`).
- Path EVM: NO se le agrega obligatoriedad (sigue opt-in por `PAYOUT_POP_SECRET`).
- `prepare/route.ts` **PR4** (`isAddress(address)` L83) — hace la rama Solana de PR6 **inalcanzable** e2e hoy; abrirlo a base58 es **HU-SOL-9**, NO esta HU. Implementá PR6 lista (testeable con `vm='solana'` forzado), pero **NO toques PR4** (ver R-3).
- Broadcast/settle Solana (HU-SOL-9), verificación deposit/escrow (HU-SOL-13), broadcast gasless (HU-SOL-14).
- `authority.ts` / binding Didit. `@solana/pay`.
- `http-pop-signer.ts` (VM-agnóstico, ya funciona) y `pop-nonce-store.ts` (namespace VM-agnóstico) — SIN cambio.
- Flags encendidos en ambientes compartidos.
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada.

### R-3 (recordatorio de alcanzabilidad — Medio, cross-HU)
La rama Solana de PR6 en `prepare` es **inalcanzable** hasta que HU-SOL-9 abra PR4 a base58 (`isAddress`
hoy rechaza en L83). Implementá y testeá PR6 con `vm='solana'` forzado (`vi.stubEnv`) llamando la route
con un formato que la deje pasar, o testeando el sub-guard. Coordinar orden de merge con HU-SOL-9 (misma
familia de archivos). En `submit` NO hay `isAddress` de formato previo al guard §7 ⇒ la rama Solana ahí
SÍ es ejercitable directo.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar, no asumir, no improvisar.

Situaciones de escalation:
- `npm install tweetnacl@1.0.3 bs58@6.0.0 --dry-run` pide `--legacy-peer-deps` o da ERESOLVE.
- Un test EVM necesita cambiar su `expect(...)` para compilar (⇒ diseño incorrecto, CD-1).
- El wallet-adapter `useWallet().signMessage` no existe o tiene otra firma que la documentada.
- `nacl.sign.detached.verify` no está disponible con ese nombre/orden de args en `tweetnacl@1.0.3`.
- El cambio requiere tocar archivos fuera de la tabla "Files to Modify/Create" (ej. PR4 de prepare).
- Ambigüedad en un AC o en el shape del challenge/mensaje.

---

*Story File generado por NexusAgil — F2.5 (Architect). Exemplars verificados con Read/Grep en esta sesión.*
