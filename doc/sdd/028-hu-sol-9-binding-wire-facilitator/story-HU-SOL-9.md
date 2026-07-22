# Story File — #028: [WKH-208 / HU-SOL-9] Binding no-custodial + wire-format Solana al facilitator

> SDD: `doc/sdd/028-hu-sol-9-binding-wire-facilitator/sdd.md` (SPEC_APPROVED)
> Work Item: `doc/sdd/028-hu-sol-9-binding-wire-facilitator/work-item.md`
> Fecha: 2026-07-22
> Branch: `feat/028-hu-sol-9-binding-wire-facilitator`
> Cross-repo: **chaski-v3** (Waves W0-W3, código de ESTA HU) + **wasiai-facilitator** (Wave WF, companion — DOCUMENTADO aquí, se codea en OTRO repo/branch)

---

## Goal

Ramificar por VM la validación/comparación de address en los 3 sitios de `chaski-v3` que hoy asumen EVM `0x`-hex de forma dura, reusando `canonicalizeAddress(address, "solana")` (HU-SOL-7), y agregar el wire-format Solana hacia el `/settle` del facilitator. Todo **dark/aditivo detrás de flags OFF** (devnet, cero plata real). El path EVM (Base, EIP-3009) queda **byte-idéntico**: ningún test EVM cambia su assertion. La release-authority pubkey y el contrato `to atestado == beneficiary` que define esta HU los **consume HU-SOL-13** (release).

**Frontera dura (Scope OUT):** esta HU NO firma/broadcastea el `release` (HU-SOL-13), NO verifica el vault on-chain (HU-SOL-13), NO resuelve el `beneficiary` real (HU-SOL-13), NO implementa PoP ed25519 (HU-SOL-8), NO hace broadcast gasless (HU-SOL-14). Define el CONTRATO y el WIRE; los prueba con mocks.

---

## Acceptance Criteria (EARS)

> Copiados del SDD aprobado (§2). QA los verifica en F4.

1. **AC-1** (ramificación de address por VM): WHEN `resolveActiveVm() === "solana"`, THE system SHALL aceptar/validar base58 vía `canonicalizeAddress(address, "solana")` — SIN `isAddress`/`isAddressEqual` de viem sobre esos campos — en `deposit-attestation.ts`, `settle/principal/route.ts` (B6/S12/S13) y `prepare/route.ts` (PR4).
2. **AC-2** (EVM byte-idéntico): WHILE `resolveActiveVm() === "evm"` (default), THE system SHALL preservar EXACTAMENTE el comportamiento actual — mismos checks, mismos códigos de error, mismo shape de `DepositAttestation`, mismo payload `eip3009` de `facilitator-client.ts`. **Ningún test EVM existente cambia su assertion.**
3. **AC-3** (payload Solana representable): WHEN se invoca la rama Solana de `facilitator-client.ts`, THE system SHALL construir un envelope x402 con `accepted.network = solana:<cluster>`, `asset`/`payTo` base58, `payload.signature`/`reference` base58 que `solana-adapter.ts::_parseSolanaInput` espera — SIN mutar ni un campo del objeto `payload` de la rama `eip3009`.
4. **AC-4** (release authority / `to` atestado == beneficiary): WHEN se emite o verifica una atestación Solana, THE system SHALL exigir que el `payTo` atestado (HMAC server-firmado) sea igual — por `canonicalizeAddress` — al `SolanaEscrowDeposit.beneficiary` (resuelto por HU-SOL-13). IF el valor del cliente no coincide con el atestado, THEN THE system SHALL rechazar PRE-broadcast/pre-verify (patrón B6), sin fetch de red.
5. **AC-5** (anti-replay / anti-inyección fail-closed no-oracle): IF una atestación Solana está expirada / deforme / con HMAC inválido / binding cruzado, THEN THE system SHALL rechazarla con el mismo código opaco fail-closed que la rama EVM, reusando el mismo esqueleto (formato → HMAC → parse → tipos → expiración → binding).
6. **AC-6** (refund trustless no bloqueado): THE system SHALL NO hardcodear ni sobrescribir `SolanaEscrowDeposit.authority`/`beneficiary` a un valor de plataforma en ningún punto — ambos se resuelven EXCLUSIVAMENTE vía HU-SOL-13; la vía de refund del sender queda intacta.

---

## Files to Modify/Create

### chaski-v3 (código de ESTA HU — Waves W0-W3)

| # | Archivo | Acción | Qué hacer | Wave | Exemplar |
|---|---------|--------|-----------|------|----------|
| 1 | `src/infrastructure/chain.ts` | Modificar (aditivo) | +`resolveSolanaReleaseAuthorityPubkey()` (env `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, base58 fail-loud). Los resolvers Solana existentes NO se tocan. | W0 | `chain.ts:148-157` (`resolveSolanaFacilitatorPubkey`) |
| 2 | `src/infrastructure/settlement/deposit-attestation.ts` | Modificar (aditivo) | +`SolanaDepositAttestation` (interface) + `issueSolanaDepositAttestation` + `verifySolanaDepositAttestation`. Helper HMAC privado compartido. **Las 3 funciones EVM existentes NO se tocan (CD-8).** | W0 | `deposit-attestation.ts:47-99` |
| 3 | `src/infrastructure/settlement/facilitator-client.ts` | Modificar (aditivo) | +`SolanaSettleInput` (interface) + `verifySolanaSettlement()` + tipo de resultado. Reusa `isBroadcasterConfigured`/`mapStatus`. NO reusa el regex `^0x…{64}$` de respuesta (CD-9). **`broadcastSettle` y su `payload` NO se tocan.** | W1 | `facilitator-client.ts:82-143` |
| 4 | `app/api/settle/principal/route.ts` | Modificar | Helper `addressEquals(a, b, vm)`; B6 (L181), S12 (L187), S13 (L192) VM-discriminados. **EVM byte-idéntico.** | W2 | El propio archivo, L181/187/192 |
| 5 | `app/api/payout/prepare/route.ts` | Modificar | PR4 (L83) validación de `address` VM-discriminada. Emisión de atestación Solana = CONTRATO gated (NO se cablea el `beneficiary` — Scope OUT). **EVM byte-idéntico.** | W2 | El propio archivo, L82-85; PR6 (L128) ya VM-aware |
| 6 | `src/infrastructure/settlement/deposit-attestation.test.ts` | Modificar | +`describe("Solana deposit attestation")` (T1) + regresión EVM (T2). | W0/W3 | El propio archivo (patrón HMAC test) |
| 7 | `src/infrastructure/chain.test.ts` (o `chain.solana.test.ts`) | Modificar/Crear | T3: `resolveSolanaReleaseAuthorityPubkey`. | W0 | Tests existentes de resolvers Solana |
| 8 | `src/infrastructure/settlement/facilitator-client.test.ts` | Modificar/Crear | T4 (`verifySolanaSettlement` shape) + T5 (regresión `broadcastSettle`). | W1 | El propio archivo si existe; si no, patrón mock-fetch |
| 9 | `app/api/settle/principal/route.binding.test.ts` | Modificar | T6: `vm==="solana"` acepta `to`==beneficiary, rechaza mismatch PRE-broadcast (sin fetch). | W2 | El propio archivo (patrón binding B6) |
| 10 | `app/api/settle/principal/route.test.ts` + `.../route.static.test.ts` + `app/api/payout/prepare/route.test.ts` | Modificar | T7: regresión EVM byte-idéntica. | W3 | Los propios archivos |

> **Nota exemplars de test:** verificá con `ls` en Wave -1 qué archivos de test existen. Los paths exactos (`route.binding.test.ts` / `route.static.test.ts`) pueden variar; si un archivo no existe, seguí el patrón del archivo de test más cercano en la misma carpeta y escalá si hay ambigüedad. NO inventes un framework distinto a **vitest**.

### wasiai-facilitator (companion — Wave WF, OTRO repo, NO se codea en esta branch)

> ⛔ **CD-4: PROHIBIDO tocar cualquier archivo de `wasiai-facilitator` desde esta HU.** Este bloque es la **especificación** para el ticket/branch separado (candidato `HU-SOL-9b`/`WFAC-solana-wire`), que ejecuta el orquestador/founder en el repo del facilitator. Se documenta aquí con detalle archivo:línea para que el Dev del facilitator lo implemente en SU branch.

| Archivo (wasiai-facilitator) | Acción (para el companion ticket) |
|---|---|
| `src/core/schemas.ts` | +`Base58PubkeySchema` + `Base58SignatureSchema` + `SolanaAcceptedSchema` + `SolanaPayloadSchema` + `SolanaRequestSchema` (3ª rama). `VerifyRequestSchema = z.union([Eip3009RequestSchema, NonEip3009RequestSchema, SolanaRequestSchema])`. **Las 2 ramas EVM SIN tocar.** |
| tests del facilitator | +suite Solana wire (TF1) + regresión EVM byte-idéntica (~849 tests, TF2) + integración `routes/settle` (TF3). |

---

## Exemplars

> Fragmentos reales verificados con Read durante el Codebase Grounding. Paths + líneas confirmados 2026-07-22.

### Exemplar 1: Resolver env-driven base58 fail-loud
**Archivo**: `src/infrastructure/chain.ts:148-157` (`resolveSolanaFacilitatorPubkey`)
**Usar para**: Archivo #1 (`resolveSolanaReleaseAuthorityPubkey`)
**Patrón clave**:
- Lee `process.env.<VAR>` DENTRO de la función (nunca top-level — CD para `vi.stubEnv`).
- `if (!raw) throw new Error("solana_release_authority_not_configured")` (fail-loud).
- `try { new PublicKey(raw); } catch { throw new Error("solana_release_authority_not_configured") }` — valida base58 con `@solana/web3.js`, **NUNCA `isAddress` de viem** (CD-2).
- Retorna el `raw` base58, jamás derivado del body (CD-3/CD-9).
- Env var nueva: `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`.

### Exemplar 2: Esqueleto HMAC de atestación (issue/verify fail-closed)
**Archivo**: `src/infrastructure/settlement/deposit-attestation.ts:39-99`
**Usar para**: Archivo #2 (`SolanaDepositAttestation` + issue/verify Solana)
**Patrón clave**:
- Formato: `` `${b64url(JSON.stringify(payload))}.${b64url(hmac(b64urlPayload))}` ``. HMAC sobre el STRING base64url, NO sobre el JSON crudo.
- `verify`: (1) formato 2-partes no vacías → (2) sin secreto ⇒ `null` → (3) **HMAC PRIMERO** (longitud primero porque `timingSafeEqual` tira con buffers de distinta longitud, luego `timingSafeEqual`) → (4) `JSON.parse` en try/catch → (5) validar tipo de CADA campo → (6) expiración `exp*1000 <= nowMs ⇒ null`.
- Fail-closed: devuelve `null` en cada paso, NUNCA throw por token inválido.
- Secreto: MISMO `DEPOSIT_ATTESTATION_SECRET` (mismo dominio "pre-settlement deposit binding"), leído dentro de `secret()`. **NO crear un secreto Solana nuevo.**
- Extraé la lógica HMAC común (`sign`/`secret`) a un helper privado compartido; la salida EVM debe quedar byte-a-byte igual (CD-8).

### Exemplar 3: Construcción del envelope x402 hacia /settle
**Archivo**: `src/infrastructure/settlement/facilitator-client.ts:82-143` (`broadcastSettle`)
**Usar para**: Archivo #3 (`verifySolanaSettlement`)
**Patrón clave**:
- `isBroadcasterConfigured()` (L56-58) y `mapStatus()` (L66-73) se **reusan sin cambios**.
- POST a `${BASE}/settle` con `authorization: Bearer ${KEY}`, `AbortSignal.timeout`.
- Env leída DENTRO de la función; sin config ⇒ retorno de fallo, **nunca throw** (toda excepción → `settle_unavailable`).
- Respuesta: `body.settled !== true ⇒ fallo`. **PERO** para Solana NO reusar `/^0x[0-9a-fA-F]{64}$/` sobre `transactionHash` (rechazaría base58) — validar signature base58 (`/^[1-9A-HJ-NP-Za-km-z]+$/` + longitud 64-120), mismo criterio que `isBase58Signature` del adaptador (CD-9).
- El objeto `payload` de la rama Solana es un **literal NUEVO**; el `payload` EIP-3009 (L88-104) NO se muta (AC-3, T5).

### Exemplar 4: Comparación de address server-controlada (B6/S12/S13)
**Archivo**: `app/api/settle/principal/route.ts:145-194`
**Usar para**: Archivo #4 (`addressEquals` + branching)
**Patrón clave**:
- B6 (L181): `isAddressEqual(to, att.depositAddress)` ⇒ `settle_receiver_mismatch` (400). El `to` firmado DEBE ser el depositAddress atestado, rechazo PRE-broadcast (nunca llama `broadcastSettle`).
- S12 (L187): modo estático `isAddressEqual(to, receiver)`.
- S13 (L192): `isAddressEqual(from, address)` ⇒ `settle_sender_mismatch`.
- Helper nuevo: `addressEquals(a, b, vm)`:
  - `vm==="evm"` ⇒ `isAddressEqual(a, b)` (**byte-idéntico al actual**).
  - `vm==="solana"` ⇒ `try { canonicalizeAddress(a,"solana") === canonicalizeAddress(b,"solana") } catch { return false }` (fail-closed; `canonicalizeAddress` TIRA con base58 malformado — envolver).
- Los códigos de error (`settle_receiver_mismatch`, `settle_sender_mismatch`, `settle_invalid_request`) NO cambian.

### Exemplar 5: PR4 validación de address del caller
**Archivo**: `app/api/payout/prepare/route.ts:82-85`
**Usar para**: Archivo #5 (PR4 VM-branch)
**Patrón clave**:
- Hoy: `if (!remittanceId.trim() || !quoteId.trim() || !kycVerificationId.trim() || !isAddress(address))` ⇒ `prepare_invalid_request` (400).
- VM-branch: `vm==="solana"` ⇒ validar `address` con `canonicalizeAddress(address, "solana")` en try/catch (throw ⇒ mismo 400 `prepare_invalid_request`), en vez de `isAddress`.
- **PR6 (L128) YA usa `canonicalizeAddress(..., resolveActiveVm())`** — es el resultado de HU-SOL-8. NO lo dupliques ni lo toques (ver Coordinación).

### Exemplar 6 (companion, wasiai-facilitator — LECTURA para el ticket): shape esperado por el adaptador Solana
**Archivo**: `wasiai-facilitator/src/chains/solana-adapter.ts` (`_parseSolanaInput` L142-196, `BASE58_RE` L48, `isBase58Signature` L104)
**Usar para**: el companion (`SolanaRequestSchema`) y para asegurar que el envelope de Archivo #3 matchea el parse del adaptador.
**Patrón clave**:
- `BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/`; `isBase58Pubkey = new PublicKey(v)` try/catch; `isBase58Signature = BASE58_RE.test && len∈[64,120]`.
- `_parseSolanaInput` lee `accepted.{network, asset(mint), payTo}` + `payload.{signature, reference}`, valida base58, `BigInt(accepted.amount)`.
- El gate Zod (`routes/settle.ts:100`) corre ANTES del dispatch namespace (`core/settle.ts:43`) ⇒ sin el companion, el request Solana muere en `400 INVALID_PAYLOAD`.

---

## Contrato de Integración ⚠️ BLOQUEANTE

> Esta HU tiene comunicación chaski → facilitator (`verifySolanaSettlement` → `POST /settle`). Además define un contrato interno consumido por HU-SOL-13.

### A) chaski `verifySolanaSettlement` → wasiai-facilitator `POST /settle` (namespace `solana`)

**Envelope construido (request body) — objeto literal NUEVO, sin mutar la rama eip3009 (AC-3):**
```json
{
  "x402Version": 2,
  "resource": { "url": "<resourceUrl>" },
  "accepted": {
    "scheme": "exact",
    "network": "solana:<cluster>",          // string, "solana:devnet" (namespace → dispatch al adaptador Solana)
    "amount": "<amountMinor>",              // u64 decimal canónico (SPL base units), string
    "asset": "<mint base58>",               // base58 (NO 0x-hex) — resuelto server-side (CD-9)
    "payTo": "<payTo base58>",              // base58 (NO 0x-hex) — == beneficiary ATESTADO (AC-4)
    "maxTimeoutSeconds": 60                  // SIN extra.assetTransferMethod (no aplica a SPL)
  },
  "payload": {
    "signature": "<tx signature base58>",   // base58 (NO 0x-hex, NO objeto authorization) — tx YA finalizada
    "reference": "<reference base58>"        // base58 (Solana Pay correlation)
  }
}
```

**`SolanaSettleInput` (contrato de entrada de la función, chaski-side):**
```ts
export interface SolanaSettleInput {
  cluster: "devnet";       // → accepted.network = `solana:${cluster}`
  mint: string;            // base58 — accepted.asset (server-side, jamás el body crudo)
  payTo: string;           // base58 — accepted.payTo (== beneficiary ATESTADO)
  amountMinor: string;     // u64 decimal canónico
  signature: string;       // base58 — tx sig YA FINALIZADA (origen: HU-SOL-14, Scope OUT)
  reference: string;       // base58 — payload.reference
  resourceUrl: string;
}
```

**Response exitoso (2xx) esperado del facilitator:**
```json
{ "settled": true, "transactionHash": "<signature base58>" }
```
> El `transactionHash` transporta la **signature base58** (el adaptador Solana la castea `as 0x-string` por tipo, es una "mentira de tipo"). Por eso `verifySolanaSettlement` valida `transactionHash` como base58 (64-120), **NO** como `^0x…{64}$` (CD-9).

**Resultado de la función:** `{ ok: true, signature }` o `{ ok: false, reason }`.

**Errores (mapeados, no-oracle):**
| Situación | reason |
|---|---|
| Sin config (`FACILITATOR_BASE_URL`/`_API_KEY` ausente) | `settle_unavailable` |
| 400 / 401 / 403 | `settle_rejected` |
| 409 | `settle_in_flight` |
| 429 / 503 | `settle_unavailable` |
| 500 | `settle_reverted` |
| timeout / fetch throw | `settle_unavailable` |
| 200 con `settled!==true` / signature shape malo | `settle_unverified` |

> **Enum de resultado:** el SDD (§10) deja como decisión NO-bloqueante de F3 reusar `FacilitatorFailure` vs. un `SolanaFacilitatorFailure` propio. **Recomendación del SDD: enum propio** (semántica verify-only más honesta). Ambos cumplen CD-12/tsc. Elegí uno, documentá la elección; si dudás, escalá — no mezcles semántica broadcast/verify sin criterio.

### B) Contrato interno CONSUMIDO por HU-SOL-13 (release) — debe quedar EXPLÍCITO

- La release-authority pubkey se resuelve **server-side, env-driven** vía `resolveSolanaReleaseAuthorityPubkey()` (env `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, base58). La keypair PRIVADA que firma el release es founder-gated y **NO vive en chaski** — esta HU solo conoce el PUBKEY.
- **Invariante que HU-SOL-13 cablea en runtime:** `SolanaDepositAttestation.authority === resolveSolanaReleaseAuthorityPubkey()` **y** `SolanaDepositAttestation.authority === deposit.escrow.authority` (de la ix del wallet, `solana-wallet.ts:87`). Esta HU DEFINE el invariante; su wiring en el settle Solana runtime es HU-SOL-13.
- **`beneficiary`**: esta HU NUNCA lo resuelve/hardcodea/sobrescribe (AC-6). Solo lo **atesta** (si el caller lo provee vía HU-SOL-13) y lo **compara** (`att.beneficiary === payTo` vía `canonicalizeAddress`, AC-4). La resolución real es EXCLUSIVA de HU-SOL-13.

---

## Constraint Directives

> Copiados del SDD §5 (heredados del work-item CD-1..CD-7 + nuevos CD-8..CD-12). NO se relajan.

### OBLIGATORIO
- **CD-1** — EVM **byte-idéntico** en los 4 archivos chaski (+ 2 ramas EVM del facilitator en el companion). Ningún test EVM cambia su assertion. **Aplica a AMBOS repos.**
- **CD-2** — Para base58, SOLO `canonicalizeAddress(x, "solana")`. Comparar sobre la forma canónica **case-sensitive**.
- **CD-3** — `to`/`payTo`/`authority` Solana SIEMPRE server-controlado (HMAC/atestación/env), NUNCA eco crudo del body.
- **CD-5** — Address Solana sin atestación válida NUNCA alcanza un `fetch` de red (patrón B1/B6 pre-broadcast).
- **CD-7** (Ownership Guard, WKH-53) — Si se extiende una escritura al `SettlementLedger` con campos Solana, preservar el scoping por `owner_ref`/caller; ninguna query nueva por `id` sin ese filtro.
- **CD-8** — DT-2 = tipos/funciones **SEPARADAS** (`SolanaDepositAttestation`, `issueSolanaDepositAttestation`, `verifySolanaDepositAttestation`). El helper HMAC común se extrae sin cambiar la salida EVM.
- **CD-10** (Auto-Blindaje SOL-7) — En comparación de identidad Solana, NUNCA asumir que `lowercase(pubkey)` es inválido. La igualdad se hace sobre la forma canónica case-sensitive; lowercasear reintroduce la clase IDOR de aliasing.
- **CD-11** (Auto-Blindaje SOL-5/SOL-7) — Si se extiende un port cuyo impl/fake usa object-literals inline (ej. `SettlementLedger`/`FakeSettlementLedger`), actualizar impl **y** fake **y** los inputs literales de los tests (la bivarianza de métodos oculta el campo faltante en `tsc`).
- **CD-12** (Auto-Blindaje SOL-5 / WKH-196) — El gate de tipos es `npx tsc --noEmit` **COMPLETO** (incluye tests), no solo `next build`. Si lazy-importás una lib, separá `import type { … }` estático del `await import(...)` de valor.

### PROHIBIDO
- **CD-2 (bis)** — NO `.toLowerCase()` ni normalización ad-hoc sobre un address Solana (reabre el IDOR de HU-SOL-7).
- **CD-4** — NO modificar NINGÚN archivo de `wasiai-facilitator` desde esta HU/branch. El companion es ticket + branch separados.
- **CD-6** — NO encender flags compartidos (`NEXT_PUBLIC_VM`, `NEXT_PUBLIC_EIP3009_ENABLED`, secretos nuevos en entorno). Todo dark/aditivo, devnet.
- **CD-8 (bis)** — NO agregar campos al `DepositAttestation` EVM ni a su serialización JSON (rompería `deposit-attestation.test.ts:39` `toEqual(payload())`).
- **CD-9** — `verifySolanaSettlement` NO reusa el regex `^0x…{64}$` en la respuesta. NO asumir shape 0x en la respuesta Solana.
- NO agregar dependencias nuevas (todo lo necesario ya existe: `@solana/web3.js`, `node:crypto`, `viem`). Si creés que falta algo, escalá.
- NO mutar el objeto `payload` de la rama `eip3009` en `facilitator-client.ts` (AC-3). Rama Solana = función + objeto literal NUEVOS.
- NO reescribir el cuerpo EIP-3009 (S5-S13) de `settle/principal/route.ts` a un cuerpo Solana. Esta HU solo VM-discrimina las **comparaciones de address** (B6/S12/S13). La orquestación del settle Solana completo es HU-SOL-13.
- NO resolver/hardcodear/sobrescribir `beneficiary` (AC-6). NO cablear la emisión de la atestación con el `beneficiary` real (HU-SOL-13).
- NO tocar `wallet.ts` / firma SPL / programa Anchor. NO usar `@solana/pay` (prohibido por constraint de programa).
- NO modificar archivos fuera de la tabla "Files to Modify/Create".

---

## Test Expectations

### chaski-v3 (vitest)

| Test | ACs | Archivo | Tipo | Qué asserta |
|------|-----|---------|------|-------------|
| **T1** | AC-1, AC-5 | `deposit-attestation.test.ts` (`describe("Solana deposit attestation")`) | unit | round-trip (`beneficiary`/`authority`/`cluster` base58 verifican íntegros); HMAC forjado (cambiar `beneficiary` reusando MAC ⇒ `null`); `cluster!=="devnet"` ⇒ `null`; `beneficiary`/`authority` base58 deforme ⇒ `null` (NO throw); exp-frontera; fail-closed sin/otro secreto |
| **T2** | **AC-2** | `deposit-attestation.test.ts` (regresión) | unit | Los casos EVM existentes **sin cambio de assertion**; `verifyDepositAttestation`/`issueDepositAttestation` intactos; `toEqual(payload())` de L39 sin campo nuevo |
| **T3** | AC-4, AC-6 | `chain.test.ts` / `chain.solana.test.ts` | unit | `resolveSolanaReleaseAuthorityPubkey`: base58 válido ⇒ devuelve; ausente/malformado ⇒ throw `solana_release_authority_not_configured`; jamás lee del body |
| **T4** | **AC-3** | `facilitator-client.test.ts` | unit | `verifySolanaSettlement`: el body construido matchea el shape de `_parseSolanaInput` (`network=solana:devnet`, `asset`/`payTo` base58, `payload.signature`/`reference` base58, SIN `authorization`); mock `fetch` captura el body y se asserta campo a campo; `settled:true`+signature base58 ⇒ `{ok:true}`; signature 0x/shape malo ⇒ `settle_unverified`; 4xx/5xx ⇒ enum vía `mapStatus`; sin config ⇒ `settle_unavailable` |
| **T5** | **AC-2** | `facilitator-client.test.ts` (regresión) | unit | `broadcastSettle`: payload EIP-3009 **byte-idéntico**; ningún assertion existente cambia; el objeto `payload` eip3009 no se muta |
| **T6** | **AC-4**, AC-5 | `route.binding.test.ts` (settle) | integration | con `vm==="solana"` (stub `NEXT_PUBLIC_VM`): `addressEquals`/B6 acepta `to`==beneficiary atestado (base58) y **rechaza PRE-broadcast** un `to`!=beneficiary (nunca llama `verifySolanaSettlement`/`broadcastSettle`) — sin fetch de red |
| **T7** | **AC-2** | `route.test.ts` + `route.static.test.ts` + `prepare/route.test.ts` (regresión) | integration | modo estático y deposit-flow byte-idénticos; PR4 EVM intacto |

### wasiai-facilitator (companion ticket — especificado para el orquestador, NO se ejecuta aquí)

| Test | ACs | Qué asserta |
|------|-----|-------------|
| **TF1** | AC-3 (e2e-reachability) | un body Solana (base58 asset/payTo, payload signature base58) **PASA** `SettleRequestSchema.safeParse` y matchea `SolanaRequestSchema` |
| **TF2** | **AC-2 cross-repo** | regresión: los ~849 tests EVM byte-idénticos; un body EVM sigue matcheando rama 1/2; un body base58 en asset/payTo de una rama EVM sigue siendo rechazado |
| **TF3** | AC-3 | integración `routes/settle`: un body Solana ya no da `400 INVALID_PAYLOAD`; alcanza el dispatch namespace `solana` → `adapter.settle` (adapter mock/no-registrado ⇒ `CHAIN_UNAVAILABLE`, prueba que el gate Zod se pasó) |

### Criterio Test-First
| Tipo de cambio | Test-first? |
|---|---|
| Lógica de atestación HMAC (Archivo #2) | Sí |
| Wire/envelope al facilitator (Archivo #3) | Sí |
| Branching de comparación en routes (Archivos #4, #5) | Sí |
| Resolver env-driven (Archivo #1) | Sí |

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO — verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
npm install 2>/dev/null || echo "Sin package.json"

# Confirmar rebase sobre HU-SOL-8 (ver Coordinación): PR6 de prepare/route.ts YA debe usar canonicalizeAddress
grep -n "canonicalizeAddress(ch.address, resolveActiveVm())" app/api/payout/prepare/route.ts || echo "ADVERTENCIA: HU-SOL-8 (PR6) NO mergeado aún — coordinar orden de merge con el orquestador"

# Confirmar que los archivos base del Scope IN existen con las líneas esperadas
ls src/infrastructure/chain.ts \
   src/infrastructure/address.ts \
   src/infrastructure/settlement/deposit-attestation.ts \
   src/infrastructure/settlement/facilitator-client.ts \
   app/api/settle/principal/route.ts \
   app/api/payout/prepare/route.ts 2>/dev/null || echo "FALTA archivo base"

# Confirmar exemplars reusables
grep -n "resolveSolanaFacilitatorPubkey" src/infrastructure/chain.ts
grep -n "isBroadcasterConfigured\|function mapStatus" src/infrastructure/settlement/facilitator-client.ts
grep -n "export function canonicalizeAddress" src/infrastructure/address.ts

# Descubrir los archivos de test reales (los paths de la tabla pueden variar)
ls src/infrastructure/settlement/*.test.ts app/api/settle/principal/*.test.ts app/api/payout/prepare/*.test.ts 2>/dev/null

# Flags: TODO OFF (dark). NO setear ninguna. Los tests stubean con vi.stubEnv.
```
**Si algo falla en Wave -1:** PARAR y reportar al orquestador. En particular, si HU-SOL-8 (PR6 VM-aware) NO está mergeado, **coordinar el orden de merge antes de tocar `prepare/route.ts`** (ver Coordinación).

---

### Wave 0 — chaski (Serial · contratos/tipos, sin runtime wiring)
- [ ] **W0.1** `chain.ts`: `resolveSolanaReleaseAuthorityPubkey()` → Archivo #1 → Exemplar 1.
- [ ] **W0.2** `deposit-attestation.ts`: `SolanaDepositAttestation` + `issueSolanaDepositAttestation`/`verifySolanaDepositAttestation` + helper HMAC privado compartido (EVM intacto) → Archivo #2 → Exemplar 2. **CD-8.**
- [ ] **W0.3** Tests **T1, T2, T3** (aislados).

**`SolanaDepositAttestation` (interface a crear):**
```ts
export interface SolanaDepositAttestation {
  remittanceId: string;   // no-vacío
  quoteId: string;        // no-vacío
  beneficiary: string;    // base58 — destino del release (== payTo atestado, AC-4)
  authority: string;      // base58 — release-authority (facilitator, env-driven server-side)
  cluster: "devnet";      // análogo Solana de chainId (anti-replay cross-cluster, AC-5)
  exp: number;            // epoch SEGUNDOS
}
```
Validaciones de campo en `verify` (AC-5): `remittanceId`/`quoteId` string no-vacío; `beneficiary`/`authority` string y `canonicalizeAddress(x,"solana")` no-throwea (try/catch → `null`, sin ecoar la address, **NUNCA `isAddress`** CD-2); `cluster === "devnet"`; `exp` number finito y `exp*1000 > nowMs`.

---

### Wave 1 — chaski (Wire al facilitator · paralelizable tras W0)
- [ ] **W1.1** `facilitator-client.ts`: `SolanaSettleInput` + `verifySolanaSettlement` (reusa `isBroadcasterConfigured`/`mapStatus`; NO reusa el regex 0x-64 de respuesta — CD-9) → Archivo #3 → Exemplar 3. Ver **Contrato de Integración A**.
- [ ] **W1.2** Tests **T4, T5**.

---

### Wave 2 — chaski (Route branching VM-safe · tras W0)
- [ ] **W2.1** Helper `addressEquals(a, b, vm)` + branching en `settle/principal/route.ts` (B6 L181 / S12 L187 / S13 L192) → Archivo #4 → Exemplar 4. EVM byte-idéntico.
- [ ] **W2.2** PR4 (L83) VM-branch en `prepare/route.ts` → Archivo #5 → Exemplar 5. EVM byte-idéntico. **Rebasado sobre PR6 de HU-SOL-8 (ver Coordinación).**
- [ ] **W2.3** Tests **T6, T7**.

---

### Wave 3 — chaski (Gate de tipos + regresión completa)
- [ ] **W3.1** `npx tsc --noEmit` **COMPLETO** (CD-12, incluye tests) + `npm run test` (suite entera verde, **cero assertion EVM cambiada**).

---

### Wave WF — COMPANION (repo `wasiai-facilitator`, ticket + branch SEPARADOS — NO en esta branch)
> ⛔ **NO se codea en esta HU (CD-4).** Documentado para el orquestador/founder. El Dev del facilitator lo implementa en su branch (`feat/NNN-wfac-solana-wire`).
- [ ] **WF.1** `src/core/schemas.ts`: `Base58PubkeySchema` + `Base58SignatureSchema` + `SolanaAcceptedSchema` + `SolanaPayloadSchema` + `SolanaRequestSchema` (3ª rama). `VerifyRequestSchema = z.union([Eip3009RequestSchema, NonEip3009RequestSchema, SolanaRequestSchema])`. **Las 2 ramas EVM SIN tocar** (union prueba en orden; agregar 3ª rama al final nunca cambia un match previo).
- [ ] **WF.2** Tests **TF1-TF3** + regresión EVM (~849 tests byte-idénticos).
- [ ] **WF.3** Diferidos MENORes de HU-SOL-6 (report §Follow-ups #4): CR-MNR-2 (`SOLANA_CLUSTER` env vs. inferir por substring) + AR-MNR-2 (excluir adapters no-EVM de `anyChainDown`/`degraded`).
- [ ] **WF.4** Merge a `main` del facilitator + deploy Railway + migración `003_facilitator_solana_dedup.sql` (founder-gated, junto con el merge de HU-SOL-6 HELD).

**Diseño de referencia del `SolanaRequestSchema`** (para el ticket companion):
```ts
const Base58PubkeySchema = z.string().refine((s) => { try { new PublicKey(s); return true; } catch { return false; } }, 'must be a base58 pubkey');
const Base58SignatureSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]+$/u, 'base58').refine((s) => s.length >= 64 && s.length <= 120, 'solana signature length');
const SolanaAcceptedSchema = z.object({
  scheme: z.literal('exact'),
  network: z.string().regex(/^solana:(devnet|mainnet)$/u),
  amount: Uint256StringSchema,        // u64 ⊂ uint256 — reusa el primitivo existente
  asset: Base58PubkeySchema,
  payTo: Base58PubkeySchema,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.unknown().optional(),      // el adaptador Solana no lo lee; NO forzar assetTransferMethod
}).strict();
const SolanaPayloadSchema = z.object({ signature: Base58SignatureSchema, reference: Base58PubkeySchema.optional() }).strict();
const SolanaRequestSchema = z.object({ x402Version: z.literal(2), resource: ResourceSchema, accepted: SolanaAcceptedSchema, payload: SolanaPayloadSchema }).strict();
```

### Verificación Incremental
| Wave | Verificación al completar |
|------|--------------------------|
| W0 | `tsc --noEmit` pasa; T1/T2/T3 verdes |
| W1 | `tsc` + T4/T5 verdes; payload eip3009 sin mutar |
| W2 | `tsc` + T6/T7 verdes; EVM byte-idéntico |
| W3 | full QA: `npx tsc --noEmit` completo + suite entera verde, cero assertion EVM cambiada |

---

## Coordinación (cross-HU / cross-repo)

### Overlap con HU-SOL-8 (027) en `app/api/payout/prepare/route.ts`
- HU-SOL-8 toca **PR6** (guard PoP, ~L109-147). Esta HU toca **PR4** (validación `address`, L82-85). **Secciones distintas, sin overlap de líneas.**
- **Orden de merge (lo maneja el orquestador): HU-SOL-8 F3 corre ANTES.** El Dev de HU-SOL-9 debe **rebasar sobre el resultado de HU-SOL-8** — cuando arranque, PR6 (L128) YA usa `canonicalizeAddress(ch.address, resolveActiveVm())`. NO dupliques ni reviertas ese cambio; solo agregá el branch en PR4.
- Wave -1 incluye el `grep` que confirma que PR6 ya está VM-aware. Si NO lo está ⇒ escalá al orquestador antes de tocar `prepare/route.ts`.

### Dependencia con HU-SOL-13 (029, consume esta HU)
- La release-authority pubkey (`resolveSolanaReleaseAuthorityPubkey`) y el invariante `authority === release-authority == deposit.escrow.authority`, más el binding `att.beneficiary === payTo`, los **consume HU-SOL-13** para el release runtime. El contrato está en **Contrato de Integración B** — debe quedar intacto y explícito. Esta HU NO cablea el `beneficiary` real (AC-6).

### Companion cross-repo (wasiai-facilitator)
- Sin el companion (`SolanaRequestSchema`), el código chaski es correcto y unit-tested con mocks, pero **NO es HTTP-reachable e2e** (el gate Zod rechaza base58). Esto **NO bloquea el merge de esta HU** (dark/aditivo). La e2e-reachability es founder-gated (companion + merge de HU-SOL-6 HELD).

---

## Out of Scope

> Lo que Dev NO debe tocar bajo ninguna circunstancia.

- Firmar/co-firmar/broadcastear la tx de `release` del escrow → **HU-SOL-13**.
- Verificación server-side del vault on-chain / resolución del `beneficiary` real / wiring de la emisión de `SolanaDepositAttestation` en prepare → **HU-SOL-13**.
- PoP ed25519 obligatorio en Solana / sección PR6 → **HU-SOL-8** (solo coexistir, no reimplementar).
- Broadcast gasless / co-firma que produce la `signature` finalizada → **HU-SOL-14** (la `signature` es INPUT de `verifySolanaSettlement`).
- Schema Zod del facilitator (`wasiai-facilitator/src/core/schemas.ts`) y cualquier archivo de ese repo → companion ticket (CD-4).
- `wallet.ts` / firma SPL / programa Anchor del escrow. `@solana/pay` (prohibido).
- Encender cualquier flag compartido en cualquier ambiente (CD-6).
- NO "mejorar" código EVM adyacente. NO reescribir S5-S13 a cuerpo Solana. NO agregar funcionalidad no listada.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y pregunta a Architect.** No inventar. No asumir. No improvisar.

Situaciones de escalation:
- HU-SOL-8 (PR6 VM-aware) NO está mergeado al arrancar → coordinar orden de merge (Wave -1).
- Un archivo de test de la tabla no existe con el nombre esperado (`route.binding.test.ts` / `route.static.test.ts`) → seguir el patrón del test más cercano y confirmar.
- El shape de `SolanaEscrowDeposit` / `ports.ts` difiere de lo documentado (`beneficiary`/`authority`/`mint?`) → escalar.
- `canonicalizeAddress` cambió de firma o comportamiento → escalar.
- El cambio requiere tocar un archivo fuera de la tabla "Files to Modify/Create" → escalar.
- Ambigüedad en la elección del enum de resultado (`FacilitatorFailure` vs. propio) que no puedas resolver con la recomendación del SDD → escalar.

---

*Story File generado por NexusAgil — F2.5 · nexus-architect*
