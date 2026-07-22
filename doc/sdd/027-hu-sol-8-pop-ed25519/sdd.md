# SDD #027: [WKH-211 / HU-SOL-8] PoP + atestación ed25519 VM-aware — GATE DE SEGURIDAD (money-path Solana)

## 1. Resumen

El gate G5 de proof-of-possession del payout (WKH-206) hoy es 100% ECDSA/viem: `pop-challenge.ts`
tipa `address: 0x+40hex` + `chainId:number`, `verifyPopChallenge` valida con `isAddress` de viem, y
los guards de `submit/route.ts` (P5) + `prepare/route.ts` (PR6) verifican con `viem.verifyMessage`.
Frente a una address Solana base58 todo eso rechaza siempre (o queda indefinido).

Esta HU agrega la **rama Solana** del gate, 100% aditiva detrás de `resolveActiveVm()`:

1. Un verificador ed25519 aislado (`pop-verify-solana.ts`, nuevo) que hace
   `nacl.sign.detached.verify(msgBytes, sigBytes, pubkeyBytes)` con un decode base58 **estricto de 32
   bytes** del pubkey reusando `new PublicKey(address).toBytes()` (HU-SOL-7, CD-4).
2. Tipos/funciones Solana paralelos en `pop-challenge.ts` (`SolanaPopChallenge`,
   `issueSolanaPopChallenge`, `verifySolanaPopChallenge`, `buildSolanaPopMessage`) que atan un
   **network-id CAIP-2** (`solana:devnet` | `solana:mainnet`) en vez del `chainId:number` EVM —
   anti-replay cross-cluster (CD-3, la clase "$400 por $0"). La rama EVM de `pop-challenge.ts` NO se
   toca ni un byte.
3. PoP **OBLIGATORIO** en el money-path Solana (a diferencia del opt-in EVM): sin config PoP →
   fail-closed 503, nunca skip silencioso (CD-2).
4. El nonce single-use (`pop-nonce-store.ts`, `claimPopNonceOnce`) y `buildPopMessage`/`http-pop-signer`
   se reusan sin duplicar lógica.

**Deliverable de seguridad (server):** el verificador + la emisión del challenge + la obligatoriedad +
el binding CAIP-2. Esto es lo que desbloquea a HU-SOL-9 (settle Solana). El firmado real del cliente
(wallet-adapter `signMessage`) es una extensión e2e necesaria y también se especifica acá (W2).

## 2. Work Item

`doc/sdd/027-hu-sol-8-pop-ed25519/work-item.md` — 8 ACs EARS, 5 DT-N, 8 CD-N, 3 `[NEEDS
CLARIFICATION]` (los tres RESUELTOS en §9). Smart Sizing **QUALITY** (gate de seguridad money-path).

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1**: `vm==='solana'` + address base58 ⇒ verificar con `nacl.sign.detached.verify(messageBytes,
  signatureBytes, pubkeyBytes)`, `pubkeyBytes` = decode base58 estricto de exactamente 32 bytes.
- **AC-2**: firma ed25519 forjada/inválida ⇒ mismo 403 opaco `payout_pop_unverified` que la rama EVM.
- **AC-3**: `vm==='solana'` en el money-path (`submit`/`prepare`) ⇒ PoP OBLIGATORIO; ausencia de config
  ⇒ fail-closed (503/501), NUNCA skip silencioso.
- **AC-4**: atestación de un network-id (`solana:devnet`) presentada contra otro
  (`solana:mainnet`) ⇒ rechazo (binding CAIP-2, análogo al chainId EVM A7″).
- **AC-5**: decode del pubkey base58 ≠ 32 bytes ⇒ rechazo fail-closed SIN invocar
  `nacl.sign.detached.verify`.
- **AC-6**: `buildPopMessage`/`buildSolanaPopMessage` = ÚNICA fuente de verdad del mensaje; extensión
  CAIP-2 aditiva, sin duplicar reconstrucción cliente/servidor.
- **AC-7**: firma Solana OK ⇒ reclama el nonce vía `claimPopNonceOnce`, fail-closed si Upstash caído.
- **AC-8**: `vm==='evm'` ⇒ verificación por el MISMO `viem.verifyMessage`/`isAddress` EXACTO,
  byte-idéntico, sin cambios en la suite de tests EVM.

## 3. Context Map (Codebase Grounding)

### Archivos leídos (verificados con Read en esta sesión)

| Archivo | Por qué | Qué extraje |
|---------|---------|-------------|
| `src/infrastructure/auth/pop-challenge.ts` | EVM SSOT del challenge PoP | `PopChallenge {address,chainId,nonce,exp}`; HMAC `node:crypto` sobre b64url del payload; `buildPopMessage` (5 líneas, sin `\n` final); `verifyPopChallenge` (HMAC-first, tipos por campo, `isAddress`, exp). **NO se toca.** |
| `src/infrastructure/auth/pop-challenge.test.ts` | límite de CD-1 | `toEqual({address,chainId,nonce,exp})` (L35) y `buildPopMessage(p)===` string EVM exacto (L96). **Ninguna assertion EVM puede cambiar.** |
| `app/api/a2a/payout/challenge/route.ts` | emisor del challenge (**GAP: no está en Scope IN**) | usa `isAddress` (L55) ⇒ rechaza base58; emite `issuePopChallenge`+`buildPopMessage`. Requiere rama Solana. |
| `app/api/a2a/payout/submit/route.ts` | guard PoP P1-P6 (money-path) | `if (POP_SECRET) {...}` opt-in (L126); P3 `canonicalizeAddress(...,resolveActiveVm())`; P4 `ch.chainId!==resolveChainId()`; P5 `verifyMessage` viem; P6 `claimPopNonceOnce`. |
| `app/api/payout/prepare/route.ts` | guard PoP PR6 | mismo patrón; **NO** P6 claim-once (nonce se quema en submit); `isAddress(address)` en el formato (L83). |
| `src/infrastructure/auth/http-pop-signer.ts` | cliente PoP | VM-agnóstico: llama `wallet.signMessage(popMessage)` VERBATIM (L29). **NO requiere cambio.** |
| `src/infrastructure/auth/pop-nonce-store.ts` | nonce single-use | `claimPopNonceOnce`, Upstash `SET NX`, namespace `pop:nonce:${nonce}` VM-agnóstico, fail-closed. **Se reusa sin cambios.** |
| `src/infrastructure/address.ts` | decode/canonicalización base58 (HU-SOL-7) | `canonicalizeAddress(address,'solana')` = `new PublicKey(address).toBase58()` (valida 32 bytes, case-sensitive, throw si malformado). |
| `src/infrastructure/chain.ts` | resolvers VM/red | `resolveActiveVm()` (`evm`/`solana`, throw en inválido); `resolveChainId()` EVM; `resolveSolanaNetworkConfig().cluster==='devnet'`. Home natural de `resolveSolanaNetworkId()`. |
| `src/application/ports.ts` | `WalletPort`/`PopSigner` | `WalletPort.signMessage(message):Promise<string>` YA existe (L250); `PopSigner.prove` (L262). |
| `src/infrastructure/solana-wallet.ts` | adapter Solana | **`signMessage` es un STUB** (L152-154, `solana-demosig-${Date.now()}`). Necesita impl real. `connect/getAddress` de HU-SOL-4. |
| `src/infrastructure/solana-wallet-bridge.ts` | seam React-free | tiene `registerSignTransaction`/`signTransaction`; **NO** tiene handle de `signMessage`. |
| `src/presentation/solana/solana-providers.tsx` | sync component | captura `useWallet().publicKey/connected` + `useWalletModal`; **NO** captura `useWallet().signMessage`. |

### Exemplars verificados (paths reales, confirmados con Glob/Read)

- Verificador cripto aislado con node:crypto + fail-closed en cada rama: `pop-challenge.ts` +
  `src/infrastructure/settlement/attestation.ts` (mirror byte-a-byte declarado en la cabecera).
- Guard-order en route con binding server-side + enum opaco: `submit/route.ts` §7-§8,
  `prepare/route.ts` PR6.
- Decode base58 auditado: `canonicalizeAddress` (`address.ts`) — reuso obligatorio (CD-4).
- Dispatch por VM sin object-injection: `resolveActiveNetworkConfig()` (`chain.ts` L176, `switch`).
- Test de route con `vi.stubEnv`: `app/api/a2a/payout/submit/route.test.ts`,
  `app/api/a2a/payout/challenge/route.test.ts`, `app/api/payout/prepare/route.test.ts`.
- Test de verificador con keypair real: `src/infrastructure/auth/pop-challenge.test.ts`.
- SDD/estructura de la casa: `doc/sdd/026-hu-sol-7-identidad-base58/sdd.md`.

### Componentes reutilizables (sin reinventar)

`canonicalizeAddress` (base58→32 bytes vía PublicKey, CD-4/CD-8) · `claimPopNonceOnce` (nonce, CD-5) ·
`resolveActiveVm`/`resolveChainId` (dispatch) · el esquema HMAC `node:crypto` de `pop-challenge.ts` ·
`http-pop-signer` (VM-agnóstico).

### Verificación de dependencias (DT-2, Missing Input #3) — RESUELTO

- `tweetnacl`: **NO resuelve en el árbol** (`npm ls tweetnacl` → empty; `node_modules/tweetnacl`
  ausente). Debe agregarse explícito.
- `@noble/curves/ed25519`: presente (v1.9.1 **hoisted, transitivo**, múltiples versiones 1.4.2/1.9.1/2.2.0
  en el árbol) — importarlo sin declararlo directo sería frágil (¿qué versión resuelve?) y viola el
  espíritu de CD-7 (dep no declarada).
- `bs58`: presente v6.0.0 (hoisted) + v4.0.1 (nested en anchor). No es dep directa.
- **`npm install tweetnacl@1.0.3 bs58@6.0.0 --dry-run` ⇒ exit 0, SIN ERESOLVE, SIN
  `--legacy-peer-deps`** (verificado en esta sesión). Ambas son zero-peer-dep (tweetnacl no tiene
  dependencias; bs58 solo `base-x`) ⇒ no pueden disparar el conflicto Kit v1/v2 que bloqueó HU-SOL-4.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `package.json` | **+dep** `tweetnacl@1.0.3` + `bs58@6.0.0` (pinned exactas) | W0 |
| 2 | `src/infrastructure/chain.ts` | **+** `resolveSolanaNetworkId(): string` (CAIP-2). Aditivo, EVM intacto | W0 |
| 3 | `src/infrastructure/auth/pop-challenge.ts` | **+** `SolanaPopChallenge` + `issueSolanaPopChallenge` + `verifySolanaPopChallenge` + `buildSolanaPopMessage`. **La rama EVM NO se toca (byte-idéntica).** | W0 |
| 4 | `src/infrastructure/auth/pop-verify-solana.ts` | **NUEVO** — verificador ed25519 (`nacl.sign.detached.verify` + decode base58 estricto) | W0 |
| 5 | `app/api/a2a/payout/challenge/route.ts` | **mod** — rama `vm==='solana'` que emite challenge/message Solana (**GAP: no listado en Scope IN, ver §6**) | W1 |
| 6 | `app/api/a2a/payout/submit/route.ts` | **mod** — guard 7: rama Solana OBLIGATORIA + EVM en `else if` byte-idéntico | W1 |
| 7 | `app/api/payout/prepare/route.ts` | **mod** — PR6: idem submit, sin claim-once | W1 |
| 8 | `src/infrastructure/solana-wallet-bridge.ts` | **+** `registerSignMessage`/`signMessage` handle (mirror de `signTransaction`) | W2 |
| 9 | `src/presentation/solana/solana-providers.tsx` | **+** capturar `useWallet().signMessage` en el sync component | W2 |
| 10 | `src/infrastructure/solana-wallet.ts` | **mod** — `signMessage` real (browser-safe, base58) en vez del stub | W2 |
| 11 | `src/infrastructure/auth/http-pop-signer.ts` | **SIN CAMBIO** (VM-agnóstico, ya llama `wallet.signMessage`) — confirmado | — |
| 12 | `src/infrastructure/auth/pop-nonce-store.ts` | **SIN CAMBIO** (namespace VM-agnóstico, CD-5) — confirmado | — |
| Tests | ver §12 | 5 archivos (2 nuevos + 3 extendidos, EVM intacto) | W3 |

### 4.2 `resolveSolanaNetworkId()` (DT-3, CAIP-2)

```
// chain.ts — aditivo. Mapea el cluster Solana activo al network-id CAIP-2 (label amigable del
// work-item: solana:devnet / solana:mainnet). En esta HU solo existe devnet; el mapa es explícito
// para que mainnet-beta futuro produzca solana:mainnet (switch sobre el literal, sin object-injection).
export function resolveSolanaNetworkId(): string {
  switch (resolveSolanaNetworkConfig().cluster) {
    case "devnet": return "solana:devnet";
    // mainnet-beta → "solana:mainnet" cuando HU-SOL-2/SOL-4 agreguen la entrada
  }
}
```

Set de network-ids válidos (para la validación de tipo en el verifier): `/^solana:(devnet|mainnet)$/`.
El **guard de la route** (no el verifier) hace el match contra `resolveSolanaNetworkId()` server-side
(AC-4/CD-3): el verifier acepta cualquier network-id bien formado; el binding lo cierra la route.

### 4.3 `SolanaPopChallenge` + build/issue/verify (DT-3, shape RESUELTO — Missing Input #2)

**Decisión de shape: tipos y funciones PARALELOS, NO una unión discriminada que mute el shape EVM.**
Razón dura (CD-1): `pop-challenge.test.ts` asserta `toEqual({address,chainId,nonce,exp})` y el string
exacto de `buildPopMessage`. Agregar un campo `vm` al `PopChallenge` EVM rompería esas assertions ⇒
prohibido. Por eso la rama EVM (`PopChallenge`, `issuePopChallenge`, `verifyPopChallenge`,
`buildPopMessage`) queda **literalmente intacta** y se agregan hermanos Solana:

```
export interface SolanaPopChallenge {
  address: string;   // base58 canónico (PublicKey.toBase58), case-sensitive (CD-8)
  networkId: string; // CAIP-2: "solana:devnet" | "solana:mainnet" (CD-3), REEMPLAZA a chainId
  nonce: string;     // 32 hex (mismo formato randomBytes(16).toString('hex') que EVM)
  exp: number;       // epoch segundos
}

// SSOT del mensaje Solana (CD-6). 5 líneas \n-separadas, SIN \n final — mirror estructural del EVM
// pero con `network:` en vez de `chainId:`. El cliente lo firma VERBATIM.
export function buildSolanaPopMessage(p: SolanaPopChallenge): string {
  return `Chaski Proof-of-Possession\naddress: ${p.address}\nnetwork: ${p.networkId}\nnonce: ${p.nonce}\nexpires: ${p.exp}`;
}
```

`issueSolanaPopChallenge` / `verifySolanaPopChallenge`: mismo esquema HMAC `node:crypto` que la rama
EVM (reusan la `secret()` privada + `createHmac`/`timingSafeEqual`, HMAC-first sobre el b64url del
payload). `verifySolanaPopChallenge` valida por campo:
- `address`: string no-vacío (la validez base58 la cierra el decode del verifier ed25519, no acá —
  evita duplicar; un address deforme colapsa en `verifySolanaPop`=false más adelante).
- `networkId`: string que matchea `/^solana:(devnet|mainnet)$/`.
- `nonce`: `/^[0-9a-f]{32}$/` (idéntico regex que EVM).
- `exp`: number finito, no vencido.
Devuelve `SolanaPopChallenge | null` (mismo contrato fail-closed → 403 opaco).

> Nota SSOT (CD-6): hay una función build por VM, cada una es la única fuente de verdad de SU mensaje.
> El emisor (`challenge/route.ts`) y el verificador (route) llaman a la MISMA `buildSolanaPopMessage`
> ⇒ byte-idéntico por construcción. No hay reconstrucción a mano en el cliente (firma VERBATIM).

### 4.4 `pop-verify-solana.ts` (NUEVO — DT-1, verificador ed25519)

```
import nacl from "tweetnacl";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";

// Decode del pubkey base58 → EXACTAMENTE 32 bytes vía el path AUDITADO de HU-SOL-7 (CD-4). PublicKey
// throwea si el largo decodificado ≠ 32 o el base58 es inválido ⇒ el input malformado NUNCA llega a
// nacl.verify (AC-5). PROHIBIDO un decoder base58 ad-hoc para el pubkey.
function pubkeyBytes(addressBase58: string): Uint8Array {
  return new PublicKey(addressBase58).toBytes(); // 32 bytes exactos o throw
}

// La FIRMA (64 bytes) NO es un PublicKey ⇒ PublicKey no sirve. Se decodifica con bs58 (browser-safe,
// isomórfica — evita Buffer node-only, lección auto-blindaje HU-SOL-5 BLQ-MED-1). Largo ≠ 64 ⇒ reject
// SIN llamar a nacl.verify (AC-5 análogo para la firma).
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

`nacl.sign.detached.verify(message, signature, publicKey)` es la API canónica de tweetnacl (orden
`msg, sig, pubkey`, verbatim al enunciado del AC-1). Verifica exactamente lo que Phantom/Solflare
producen con `signMessage` (ed25519 sobre los bytes crudos del mensaje, sin prefijo).

> **Fallback documentado (CD-7):** si por cualquier razón `tweetnacl` fuese rechazado en install, el
> reemplazo es `@noble/curves/ed25519` declarado directo+pinned: `ed25519.verify(sig, msg, pub)`
> (¡ojo: orden `sig, msg, pub`, DISTINTO de nacl!). Preferimos tweetnacl: zero-dep, verbatim al AC-1,
> install verificado limpio.

### 4.5 Emisión del challenge Solana (`challenge/route.ts` — GAP de Scope IN)

Restructura: leer `rawAddress` string primero, luego ramificar por `resolveActiveVm()`. El 501 por
`!POP_SECRET` (L31) queda ANTES de la rama (intacto). El rate-limit queda intacto.

```
const vm = resolveActiveVm();
if (vm === "solana") {
  let addr: string;
  try { addr = canonicalizeAddress(rawAddress, "solana"); } // base58, NO isAddress (CD-8)
  catch { return NextResponse.json({ error: "pop_invalid_request" }, { status: 400 }); }
  const networkId = resolveSolanaNetworkId();               // server-side, NUNCA del body (CD-3)
  const nonce = randomBytes(16).toString("hex");
  const exp = Math.floor(Date.now()/1000) + POP_CHALLENGE_TTL_SECONDS;
  const popChallenge = issueSolanaPopChallenge({ address: addr, networkId, nonce, exp });
  const popMessage   = buildSolanaPopMessage({ address: addr, networkId, nonce, exp });
  return NextResponse.json({ popChallenge, popMessage, exp }, { status: 200 });
}
// else: rama EVM EXACTA (isAddress + issuePopChallenge + buildPopMessage), byte-idéntica.
```

### 4.6 Guard PoP en `submit/route.ts` (§7) — OBLIGATORIO en Solana (DT-4/AC-3/CD-2)

Reestructurar el `if (POP_SECRET)` en un dispatch por VM. **El bloque EVM se mueve VERBATIM dentro de
un `else if (POP_SECRET)`** (misma condición efectiva para EVM que hoy ⇒ AC-8/CD-1):

```
const vm = resolveActiveVm();
const POP_SECRET = process.env.PAYOUT_POP_SECRET;
if (vm === "solana") {
  // CD-2 / AC-3: OBLIGATORIO. Sin secreto → 503 fail-closed (NUNCA skip).
  if (!POP_SECRET) return NextResponse.json({ error: "payout_pop_unavailable" }, { status: 503 });
  const popChallenge = body.popChallenge, popSignature = body.popSignature;
  // P1 presencia+tipo → 403; P2 verifySolanaPopChallenge → 403 opaco;
  if (typeof popChallenge!=="string" || !popChallenge.trim() || typeof popSignature!=="string" || !popSignature.trim())
    return 403 payout_pop_unverified;
  const ch = verifySolanaPopChallenge(popChallenge, Date.now());
  if (!ch) return 403 payout_pop_unverified;
  // P3 address match (CD-8, base58 case-sensitive). canonicalizeAddress throwea → try/catch → 403.
  try { if (canonicalizeAddress(ch.address,"solana") !== canonicalizeAddress(address,"solana")) return 403; }
  catch { return 403 payout_pop_unverified; }
  // P4 CAIP-2 binding (AC-4/CD-3): network-id del token vs el resuelto server-side.
  if (ch.networkId !== resolveSolanaNetworkId()) return 403 payout_pop_unverified;
  // P5 ed25519 (AC-1/AC-2): mensaje reconstruido con la MISMA buildSolanaPopMessage (CD-6).
  if (!verifySolanaPop({ addressBase58: ch.address, message: buildSolanaPopMessage(ch), signatureBase58: popSignature }))
    return 403 payout_pop_unverified;
  // P6 nonce single-use (AC-7/CD-5): reusa claimPopNonceOnce, fail-closed (409 replay / 503 Upstash).
  const claim = await claimPopNonceOnce(ch.nonce);
  if (!claim.ok) return ("alreadyUsed" in claim) ? 409 payout_pop_replayed : 503 payout_pop_unavailable;
} else if (POP_SECRET) {
  // ── RAMA EVM: bloque WKH-206 EXACTO, byte-idéntico (viem.verifyMessage/isAddress). CD-1. ──
}
```

Cuando `vm==='evm'`: la primera condición es falsa ⇒ se cae al `else if (POP_SECRET)` idéntico al
actual; `!POP_SECRET` + evm ⇒ skip (como hoy). **Comportamiento EVM byte-idéntico (AC-8).**

### 4.7 Guard PoP en `prepare/route.ts` (PR6)

Igual que §4.6 **pero SIN P6 claim-once** (el nonce se quema recién en submit — coincide con el
comentario EVM actual, `prepare/route.ts` L110-111). La rama Solana es igualmente OBLIGATORIA (503 sin
secreto). Nota: `prepare` valida el formato con `isAddress(address)` (L83) ⇒ hoy rechaza base58 antes
de llegar a PR6. **Corolario de scope:** para que la rama Solana de PR6 sea alcanzable, el guard de
formato PR4 debe aceptar base58 cuando `vm==='solana'` — pero ESO es el core de **HU-SOL-9**
(`prepare/route.ts` PR4/PR8, ver `_INDEX` fila HU-SOL-9). Ver §7 (Riesgo R-3) y §9.

### 4.8 Firmado real del cliente Solana (W2 — Missing Input #1 RESUELTO)

`WalletPort.signMessage(message):Promise<string>` YA existe en el port; `http-pop-signer` ya lo llama
VM-agnóstico (SIN cambio). Lo que falta es la IMPLEMENTACIÓN real en la rama Solana (hoy stub):

- `solana-wallet-bridge.ts`: `+ registerSignMessage(fn)` + `signMessage(bytes)` (mirror exacto de
  `registerSignTransaction`/`signTransaction`; fail-loud si el árbol no montó el handle; limpiar en
  `reset()`).
- `solana-providers.tsx`: en el sync component, `useEffect` que registra
  `solanaWalletBridge.registerSignMessage((bytes)=>signMessage(bytes))` desde `useWallet().signMessage`.
- `solana-wallet.ts`: reemplazar el stub por:
  ```
  async signMessage(message: string): Promise<string> {
    const bytes = new TextEncoder().encode(message);        // browser+node-safe (NO Buffer, HU-SOL-5)
    const sig = await solanaWalletBridge.signMessage(bytes); // Uint8Array(64) de la wallet
    return bs58.encode(sig instanceof Uint8Array ? sig : new Uint8Array(sig)); // base58, browser-safe
  }
  ```
  `bs58.encode` es isomórfico (evita `Buffer` node-only — auto-blindaje HU-SOL-5 BLQ-MED-1). El
  formato de transporte (base58) es simétrico con `verifySolanaPop.signatureBase58`.

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (vigentes, no repito el texto completo)
CD-1 (EVM byte-idéntico) · CD-2 (PoP obligatorio Solana) · CD-3 (CAIP-2 anti-cross-cluster) · CD-4
(decode base58 estricto vía PublicKey) · CD-5 (nonce single-use preservado) · CD-6 (`buildPopMessage`
SSOT) · CD-7 (sin `@solana/pay`, deps verificadas sin `--legacy-peer-deps`) · CD-8 (canonicalización
de address, nunca `.toLowerCase()` sobre base58).

### OBLIGATORIO (específicos de este SDD)
- **CD-SDD-1**: la rama EVM de `pop-challenge.ts` (interface `PopChallenge`, `issuePopChallenge`,
  `verifyPopChallenge`, `buildPopMessage`) se deja **sin tocar un byte**. Las funciones Solana son
  hermanas nuevas en el mismo archivo. Ninguna assertion de `pop-challenge.test.ts` EVM cambia.
- **CD-SDD-2**: en las routes, el bloque EVM del guard PoP se mueve a un `else if (POP_SECRET)` con el
  código **carácter por carácter** actual. El `git diff` de la rama EVM debe ser solo la
  indentación/condición del `else if`, nada de lógica.
- **CD-SDD-3** (browser-safe, auto-blindaje HU-SOL-5 BLQ-MED-1 — RECURRENTE): el código client-side
  (`solana-wallet.ts`) NUNCA usa `Buffer` node-only ni `node:crypto`. Codificación base58/bytes con
  `bs58` (isomórfica) + `TextEncoder`. El test-env `node` puede enmascarar la falla.
- **CD-SDD-4**: `resolveSolanaNetworkId()` y `resolveChainId()` se leen SIEMPRE server-side; el
  network-id / chainId NUNCA sale del body del caller (sería el binding falso que P4 mata).
- **CD-SDD-5**: el nonce Solana reusa `claimPopNonceOnce` con el namespace `pop:nonce:${nonce}` actual,
  sin sufijo por VM (CD-5; colisión de nonce 128-bit random cross-cluster = negligible, y el binding
  CAIP-2 ya cierra el replay).
- **CD-SDD-6** (dep-hygiene, auto-blindaje HU-SOL-4 ERESOLVE — RECURRENTE): agregar `tweetnacl@1.0.3`
  + `bs58@6.0.0` pinned exactas y **verificar `npm install ... --dry-run` exit 0 sin
  `--legacy-peer-deps`** antes de importar (ya pre-verificado en F2, re-confirmar en F3).
- **CD-SDD-7** (tsc completo, auto-blindaje HU-SOL-5 W3 + WKH-196 — RECURRENTE): el gate es
  `npx tsc --noEmit` COMPLETO (incluye tests), no `next build`. Respetar `noUncheckedIndexedAccess` en
  los tests (narrowing helpers, cero `!`/`any`).

### PROHIBIDO
- Agregar `vm` (o cualquier campo) a la interface `PopChallenge` EVM o a su payload HMAC.
- Un segundo mecanismo de nonce, o un nonce Solana stateless / que no falle cerrado.
- Un decoder base58 ad-hoc para el pubkey (usar `new PublicKey(...).toBytes()`, CD-4).
- Que `vm==='solana'` sin `PAYOUT_POP_SECRET` haga skip (debe ser 503 fail-closed, CD-2).
- Distinguir el motivo de rechazo en la respuesta (todo fallo cripto/stateless → mismo 403 opaco,
  no-oracle).
- `--legacy-peer-deps`, `--force`, `overrides` (Golden Path).
- Encender flags nuevos en ambientes compartidos (Solana sigue devnet/flags OFF).

## 6. Scope

### IN (heredado del work-item + refinamientos de F2)
`pop-challenge.ts` (aditivo Solana) · `pop-verify-solana.ts` (nuevo) · `submit/route.ts` ·
`prepare/route.ts` · `chain.ts` (`resolveSolanaNetworkId`) · tests. **Refinamientos que el Architect
agrega (justificados abajo):**
- `app/api/a2a/payout/challenge/route.ts` — **GAP**: el work-item lista el guard verificador
  (submit/prepare) pero NO el EMISOR. Sin la rama Solana del challenge, el cliente jamás obtiene un
  `popMessage`/`popChallenge` Solana ⇒ el gate sería inejercitable e2e. Es el mismo módulo-familia PoP
  (WKH-206), aditivo, EVM byte-idéntico. Se incluye.
- `solana-wallet.ts` + `solana-wallet-bridge.ts` + `solana-providers.tsx` — **resolución de Missing
  Input #1**: el port expone `signMessage` pero el impl Solana es un stub. Estos 3 archivos son el
  firmado real del cliente (W2). No estaban en el Scope IN literal (el work-item los cubría bajo
  "adaptar http-pop-signer si el WalletPort ya expone el método"). Se incluyen como extensión e2e
  mínima. **Descope permitido en el gate**: si el humano prefiere entregar solo el gate server-side
  (verificable por unit tests) y diferir el firmado cliente a una HU aparte, W2 se puede recortar sin
  afectar W0/W1/W3-server.

### OUT (heredado)
Path EVM (no se refactoriza ni se le agrega obligatoriedad) · broadcast/settle Solana (HU-SOL-9) ·
verificación server-side del deposit/escrow (HU-SOL-13) · broadcast gasless (HU-SOL-14) ·
`@solana/pay` · cambios a `authority.ts`/binding Didit · `prepare` PR4 aceptando base58 en el formato
(eso es HU-SOL-9, ver R-3) · flags encendidos en ambientes compartidos.

## 7. Riesgos

- **R-1 (Alto→Mitigado)**: romper el path EVM. Mitigación: CD-SDD-1/CD-SDD-2 (rama EVM sin tocar en
  `pop-challenge.ts`; bloque EVM movido verbatim a `else if`); test de regresión EVM sin editar
  assertions (AC-8); `guard8-intact.test.ts` existente como red adicional.
- **R-2 (Medio)**: `signMessage` de la wallet devuelve un shape distinto según adapter (Uint8Array vs
  `{signature}`). Mitigación: normalizar a `Uint8Array` en `solana-wallet.ts` (§4.8) y test unit del
  adapter con un fake bridge que devuelva `Uint8Array(64)`.
- **R-3 (Medio, cross-HU)**: la rama Solana de PR6 en `prepare` es **inalcanzable** hasta que HU-SOL-9
  haga que PR4 acepte base58 (`isAddress` hoy rechaza). Esta HU implementa la rama PR6 (lista para
  cuando PR4 abra) y la testea llamando al guard con `vm='solana'` + un formato que la deje pasar (o
  testeando el sub-guard aislado). **No se toca PR4** (OUT, es HU-SOL-9). Coordinar orden de merge con
  HU-SOL-9 (misma familia de archivos).
- **R-4 (Bajo)**: jsdom cross-realm Buffer rompe tests que ejercen `PublicKey`/PDA (auto-blindaje
  HU-SOL-5). Mitigación: `pop-verify-solana.test.ts` corre en env `node` (no jsdom); los tests de
  componente (providers) usan jsdom + `cleanup()` en `afterEach` (auto-blindaje HU-SOL-4 W3.2).

## 8. Dependencias
- HU-SOL-7 (WKH-213, DONE): `canonicalizeAddress` — reuso base58 (CD-4/CD-8). ✅
- HU-SOL-5 (WKH-207, DONE): wallet Solana + bridge `signTransaction` (patrón para `signMessage`). ✅
- `tweetnacl@1.0.3` + `bs58@6.0.0` (nuevas, install verificado limpio, CD-SDD-6).
- **Bloquea a HU-SOL-9** (settle Solana): el gate PoP debe estar cerrado antes de mover fondos.

## 9. Missing Inputs — RESUELTOS

- **#1 (WalletPort message-sign)** → RESUELTO: el port `WalletPort.signMessage(message):Promise<string>`
  YA existe (`ports.ts` L250) y `http-pop-signer` ya lo usa VM-agnóstico (SIN cambio). Lo que faltaba
  es la IMPL real Solana (el stub `solana-demosig-*`). Se diseña en §4.8 (W2): bridge handle +
  captura en providers + impl base58 browser-safe. **NO es bloqueante** (el gate server no depende del
  cliente para sus unit tests).
- **#2 (shape CAIP-2)** → RESUELTO (§4.3): tipos/funciones Solana PARALELOS (no unión discriminada que
  mute EVM), `networkId` reemplaza `chainId`, `buildSolanaPopMessage` con línea `network:`. Elegido
  porque la alternativa (agregar `vm` al shape compartido) rompería las assertions EVM (CD-1).
- **#3 (tweetnacl resuelve?)** → RESUELTO (§3): NO resuelve transitivamente; se agrega explícito
  `tweetnacl@1.0.3` + `bs58@6.0.0`; `--dry-run` exit 0 sin `--legacy-peer-deps` (verificado).
  `@noble/curves/ed25519` documentado como fallback (§4.4).

## 10. Uncertainty Markers
Ninguno abierto. Los 3 `[NEEDS CLARIFICATION]` del work-item están resueltos en §9. La única decisión
que el humano puede querer ajustar es el alcance de W2 (firmado cliente) vs diferirlo — documentado y
descopeable en §6, no bloquea el gate.

## 11. Plan de Implementación (Waves)

### Wave 0 (Serial Gate) — deps + contratos + verificador aislado
- **W0.1** `package.json`: `+tweetnacl@1.0.3` `+bs58@6.0.0` pinned; `npm install --dry-run` exit 0 sin
  `--legacy-peer-deps` (CD-SDD-6); confirmar tipos (`tweetnacl` trae `.d.ts` propios; `@types/bs58` si
  hiciera falta).
- **W0.2** `chain.ts`: `+resolveSolanaNetworkId()` (§4.2). Aditivo, EVM intacto.
- **W0.3** `pop-challenge.ts`: `+SolanaPopChallenge` + `issueSolanaPopChallenge` +
  `verifySolanaPopChallenge` + `buildSolanaPopMessage` (§4.3). **Rama EVM sin tocar.**
- **W0.4** `pop-verify-solana.ts` (nuevo, §4.4): `verifySolanaPop`.
- Gate W0: `npx tsc --noEmit` completo verde (CD-SDD-7).

### Wave 1 (Server wiring — coordinar por archivo, guard-order intacto)
- **W1.1** `challenge/route.ts`: rama `vm==='solana'` (§4.5). EVM byte-idéntico.
- **W1.2** `submit/route.ts`: guard 7 dispatch por VM (§4.6). Bloque EVM verbatim en `else if`.
- **W1.3** `prepare/route.ts`: PR6 dispatch por VM, sin claim-once (§4.7).

### Wave 2 (Firmado real del cliente Solana — descopeable, ver §6)
- **W2.1** `solana-wallet-bridge.ts`: `+registerSignMessage/signMessage` (mirror de signTransaction).
- **W2.2** `solana-providers.tsx`: capturar `useWallet().signMessage`.
- **W2.3** `solana-wallet.ts`: `signMessage` real base58 browser-safe (§4.8).
- `http-pop-signer.ts`: confirmar SIN cambio.

### Wave 3 (Tests — ver §12)
- **W3.1** `pop-verify-solana.test.ts` (nuevo, env `node`).
- **W3.2** `pop-challenge.test.ts`: +tests Solana (EVM intactos).
- **W3.3** `submit/route.test.ts` + `prepare/route.test.ts`: rama Solana + regresión EVM.
- **W3.4** `challenge/route.test.ts`: emisión Solana.
- **W3.5** `solana-wallet.test.ts`: `signMessage` real (fake bridge).
- Gate final: `npx tsc --noEmit` completo + toda la suite verde, **sin editar ninguna assertion EVM**.

## 12. Test Plan (≥1 por AC)

| AC | Test | Archivo | Qué prueba |
|----|------|---------|------------|
| AC-1 | firma ed25519 válida (keypair `nacl.sign.keyPair()`) sobre `buildSolanaPopMessage` ⇒ `verifySolanaPop`=true | `pop-verify-solana.test.ts` | verificación real ok |
| AC-2 | (a) firma forjada (64 bytes random) ⇒ false; (b) firma válida de OTRA key ⇒ false; (c) mensaje alterado ⇒ false; (d) en route: popSignature forjada ⇒ 403 `payout_pop_unverified` | `pop-verify-solana.test.ts` + `submit/route.test.ts` | **firma forjada rechazada** (opaco) |
| AC-3 | `vm='solana'` + `PAYOUT_POP_SECRET` unset ⇒ submit y prepare ⇒ 503 `payout_pop_unavailable`, NUNCA forward | `submit/route.test.ts`, `prepare/route.test.ts` | **PoP obligatorio** fail-closed |
| AC-4 | token con `networkId='solana:mainnet'` (HMAC válido) + server `resolveSolanaNetworkId()='solana:devnet'` ⇒ 403 | `submit/route.test.ts` | **atestación devnet↔mainnet inválida** (CD-3) |
| AC-5 | (a) base58 que decodifica a 31/33 bytes ⇒ false; (b) base58 inválido ⇒ false; (c) firma ≠64 bytes ⇒ false; con spy: `nacl.sign.detached.verify` NO invocado en (a)/(b) | `pop-verify-solana.test.ts` | decode estricto, no llega a cripto |
| AC-6 | (a) `buildSolanaPopMessage(p)` === string exacto de 5 líneas sin `\n` final, con `network:`; (b) round-trip issue→verify reconstruye idéntico; (c) el verifier de la route usa la MISMA `buildSolanaPopMessage` | `pop-challenge.test.ts` | SSOT aditivo |
| AC-7 | (a) firma OK ⇒ `claimPopNonceOnce` llamado; (b) replay (nonce ya usado) ⇒ 409 `payout_pop_replayed`; (c) Upstash unavailable ⇒ 503 `payout_pop_unavailable`, sin forward | `submit/route.test.ts` | nonce single-use fail-closed |
| AC-8 | `pop-challenge.test.ts` EVM corre **sin editar assertions**; `submit`/`prepare` con `vm='evm'`: POP_SECRET ausente ⇒ skip byte-idéntico; presente + firma viem válida ⇒ pasa por `verifyMessage`. `guard8-intact.test.ts` verde | tests EVM existentes + regresión | **EVM byte-idéntico** |
| — | `solana-wallet.signMessage` real: fake bridge devuelve `Uint8Array(64)` ⇒ retorna base58 de 64 bytes; NUNCA usa `Buffer` node-only | `solana-wallet.test.ts` | W2 client (CD-SDD-3) |
| — | `challenge/route` `vm='solana'`: address base58 válida ⇒ 200 con `popMessage` Solana; base58 inválido ⇒ 400 | `challenge/route.test.ts` | emisión Solana |

Notas de test-infra (auto-blindaje): tests que ejercen `PublicKey` corren en env **`node`** (NO jsdom,
cross-realm Buffer, HU-SOL-5); tests de componente (providers) usan jsdom + `cleanup()` en `afterEach`
(HU-SOL-4 W3.2); accesos por índice con narrowing helpers (`noUncheckedIndexedAccess`, HU-SOL-5 W3).

## 13. Readiness Check

- [x] Work-item leído completo (8 ACs, 5 DT, 8 CD, 3 NEEDS CLARIFICATION).
- [x] `project-context.md`/CLAUDE.md — stack confirmado (Next, TS strict, Solana web3.js v1, Golden Path).
- [x] Exemplars verificados con Read (paths reales): `pop-challenge.ts`, `attestation.ts`,
      `submit`/`prepare`/`challenge` routes, `address.ts`, `chain.ts`, `solana-wallet(-bridge).ts`,
      `solana-providers.tsx`, `ports.ts`, tests.
- [x] Missing Input #1 (WalletPort signMessage) RESUELTO — port existe, impl es stub, W2 lo cierra.
- [x] Missing Input #2 (shape CAIP-2) RESUELTO — tipos Solana paralelos, `networkId`, EVM intacto.
- [x] Missing Input #3 (tweetnacl) RESUELTO — no resuelve transitivo; `+tweetnacl@1.0.3 +bs58@6.0.0`;
      `--dry-run` exit 0 sin `--legacy-peer-deps` (verificado en F2). Fallback `@noble/curves`.
- [x] CD-1 (EVM byte-idéntico) blindado por diseño: `pop-challenge.ts` EVM sin tocar; bloque EVM en
      `else if` verbatim; assertions EVM sin editar.
- [x] Auto-blindaje histórico incorporado a los CD: browser-safe (HU-SOL-5), dep peer-conflict
      (HU-SOL-4), tsc completo/noUncheckedIndexedAccess (HU-SOL-5/WKH-196), base58 lowercase (HU-SOL-7).
- [x] GAP de Scope IN (`challenge/route.ts` emisor) surfaceado y justificado (§6).
- [x] Test plan con ≥1 test por AC (8/8) + firma forjada + devnet↔mainnet + obligatorio + EVM idéntico.
- [x] Sin `[NEEDS CLARIFICATION]` abiertos. Única decisión opcional del humano: alcance de W2
      (descopeable sin afectar el gate server, §6).

**Estado: LISTO para SPEC_APPROVED.**
</content>
</invoke>
