# SDD #028: [WKH-208 / HU-SOL-9] Binding no-custodial + wire-format Solana al facilitator

> NexusAgil QUALITY · F2 (SDD) · 2026-07-22
> Cross-repo: **chaski-v3** (código de esta HU) + **wasiai-facilitator** (companion, documentado NO codeado aquí)
> Input: `doc/sdd/028-hu-sol-9-binding-wire-facilitator/work-item.md` (6 ACs EARS · 5 DT · 7 CD · 5 Missing Inputs)

---

## 1. Resumen

Dos piezas del money-path Solana no-custodial, ambas **dark/aditivas detrás de flags OFF** (devnet, cero plata real):

1. **chaski-v3** (código): ramifica por VM la validación/comparación de address en los 3 sitios que hoy asumen EVM `0x`-hex de forma dura (`deposit-attestation.ts:91`, `settle/principal/route.ts` S12/B1-B6, `prepare/route.ts` PR4/PR8), reusando `canonicalizeAddress(address, vm)` (HU-SOL-7). Agrega la **variante Solana de la `DepositAttestation`** (HMAC, mismo esqueleto), un **resolver env-driven de la release-authority** y la **rama Solana de `facilitator-client.ts`** (`verifySolanaSettlement`) que construye el envelope x402 `solana:<cluster>` en base58 hacia el MISMO `/settle`. El path EVM (Base, EIP-3009) queda **byte-idéntico**: ningún test EVM cambia su assertion.

2. **wasiai-facilitator** (companion — DISEÑADO aquí, NO codeado): el schema Zod HTTP (`src/core/schemas.ts::VerifyRequestSchema`/`SettleRequestSchema`) exige `asset`/`payTo` `0x`-hex + `extra.assetTransferMethod ∈ {eip3009,permit2,erc7710}` en **AMBAS** ramas del `z.union` → un payload Solana base58 se rechaza con `400 INVALID_PAYLOAD` en el gate Zod (`routes/settle.ts:100`) **ANTES** del dispatch por namespace (`core/settle.ts:43`). Este SDD especifica una **TERCERA rama de union** (`SolanaRequestSchema`) que representa el request Solana sin mutar ni un byte de las dos ramas EVM. Es el "wire-format HTTP Solana" que el propio `report.md` de HU-SOL-6 nombra como responsabilidad de esta HU.

**Frontera dura**: este SDD NO firma/broadcastea el `release` (HU-SOL-13), NO verifica el vault on-chain (HU-SOL-13), NO implementa PoP ed25519 (HU-SOL-8), NO hace broadcast gasless (HU-SOL-14). Define el **CONTRATO** de cómo la release-authority y el `beneficiary` fluyen al deposit y al payload; la resolución runtime del `beneficiary` real + la verificación del vault son EXCLUSIVAS de HU-SOL-13.

---

## 2. Work Item — Acceptance Criteria (EARS, heredados)

- **AC-1** — VM branch en los 3 sitios: `resolveActiveVm()==="solana"` ⇒ aceptar/validar base58 vía `canonicalizeAddress(address,"solana")`, SIN `isAddress`/`isAddressEqual` de viem sobre esos campos.
- **AC-2** — EVM byte-idéntico (default `vm==="evm"`): mismos checks, mismos códigos de error, mismo shape de `DepositAttestation`, mismo payload `eip3009` de `facilitator-client.ts`. **Ningún test EVM existente cambia su assertion.**
- **AC-3** — Payload Solana representable hacia `/settle`: envelope x402 con `accepted.network=solana:<cluster>`, `asset`/`payTo` base58, `payload.signature`/`reference` base58 que `solana-adapter.ts::_parseSolanaInput` espera, SIN mutar el objeto `payload` de la rama `eip3009`.
- **AC-4** — Release authority / `to` atestado == `beneficiary` del escrow: el `payTo` atestado (HMAC server-firmado) debe igualar por `canonicalizeAddress` al `SolanaEscrowDeposit.beneficiary` (resuelto por HU-SOL-13). Mismatch ⇒ rechazo PRE-broadcast/pre-verify (patrón B6), sin fetch de red.
- **AC-5** — Anti-replay / anti-inyección de destino fail-closed no-oracle: atestación Solana expirada/deforme/HMAC inválido/binding cruzado ⇒ mismo código opaco fail-closed que la rama EVM, reusando el mismo esqueleto (formato → HMAC → parse → tipos → expiración → binding).
- **AC-6** — Refund trustless no bloqueado: NO hardcodear ni sobrescribir `SolanaEscrowDeposit.authority`/`beneficiary` a un valor de plataforma en ningún punto que capture la vía de refund del sender — la resolución del `beneficiary` es EXCLUSIVA de HU-SOL-13.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos (chaski-v3) — verificados con Read

| Archivo | Qué extraje |
|---------|-------------|
| `src/infrastructure/settlement/deposit-attestation.ts` (L1-99) | `DepositAttestation` 100% EVM (`depositAddress: 0x-hex isAddress`, `chainId: number`). Esqueleto HMAC: `issue` = `b64url(JSON).b64url(hmac)`; `verify` = formato → HMAC-primero (timingSafe, longitud-primero) → parse try/catch → tipos por-campo → exp. Fail-closed devuelve `null`. L91 = `!isAddress(depositAddress)` (viem, SIEMPRE rechaza base58). |
| `src/infrastructure/settlement/facilitator-client.ts` (L1-143) | `broadcastSettle` construye el payload x402 EIP-3009 (`x402Version:2`, `network: eip155:<chainId>`, `asset`/`payTo` `0x`-hex, `extra.assetTransferMethod:"eip3009"`, `payload.{signature,authorization}`). `isBroadcasterConfigured()` + `mapStatus()` reutilizables. Respuesta EVM: `settled===true` + `transactionHash` regex `^0x[0-9a-fA-F]{64}$`. CD-20: ÚNICO archivo que conoce `FACILITATOR_BASE_URL`/`_API_KEY`. |
| `src/infrastructure/address.ts` (L1-25) | `canonicalizeAddress(address, "evm"\|"solana")`: evm = `toLowerCase()` (byte-idéntico, NUNCA throw); solana = `new PublicKey(address).toBase58()` (valida base58 32-byte + normaliza, case-sensitive; malformado ⇒ **throw** `address_canonicalization_failed`). |
| `app/api/settle/principal/route.ts` (L1-296) | S5/L114 `isAddress(from/to)`; S9/L120 `isAddress(address)`; B6/L181 `isAddressEqual(to, att.depositAddress)`; S12/L187 `isAddressEqual(to, receiver)`; S13/L192 `isAddressEqual(from, address)`. Todo EVM-only. Doble-modo por presencia de `DEPOSIT_ATTESTATION_SECRET`. `resolveActiveVm()` ya importado (L19, usado en el ledger L275). |
| `app/api/payout/prepare/route.ts` (L1-224) | PR4/L83 `isAddress(address)`; PR8/L181 `isAddress(depositAddress)`; PR9/L194 `issueDepositAttestation`. PR6 (PoP) YA usa `canonicalizeAddress(..., resolveActiveVm())` (L128) — **overlap de sección con HU-SOL-8**. `resolveActiveVm`/`canonicalizeAddress` ya importados. |
| `src/infrastructure/chain.ts` (L98-186) | Resolvers Solana devnet: `resolveActiveVm()` (`NEXT_PUBLIC_VM`, unset⇒"evm", inválido⇒throw), `resolveSolanaNetworkConfig()` (cluster "devnet"), `resolveSolanaUsdcMint()`, `resolveSolanaFacilitatorPubkey()`, todos base58 vía `PublicKey`, fail-loud. **Patrón exacto** para el nuevo `resolveSolanaReleaseAuthorityPubkey()`. |
| `src/infrastructure/solana-wallet.ts` (L1-155) | `authorizePrincipal` (HU-SOL-5): construye ix `deposit` del escrow Anchor, `feePayer=facilitator`, partial-sign SOLO wallet, retorna `{ tx, solana:{ vm, partialSignedTx (base64), reference (base58) } }`. **NUNCA broadcastea** (CD-SDD-1). `deposit.escrow.{beneficiary,authority}` son inputs (validados base58) provistos por el caller (HU-SOL-13). |
| `src/application/ports.ts` (L148-228) | `SolanaAuthorization`, `SolanaEscrowDeposit {beneficiary, authority, mint?}` (base58, "Resuelto por HU-SOL-13"), `SolanaPrincipalAuthorization {vm, partialSignedTx (base64), reference (base58)}`. **NO** hay un campo `signature` de tx finalizada en el envelope Solana (ver §4.7 / Missing Input #5). |
| `src/infrastructure/settlement/deposit-attestation.test.ts` (L1-101) | Patrón de test HMAC: `payload(over)` helper, `vi.stubEnv("DEPOSIT_ATTESTATION_SECRET")`, casos round-trip / HMAC forjado / formato / exp-frontera / campo-deforme / fail-closed sin secreto. **Modelo directo** para el test Solana. |

### 3.2 Archivos leídos (wasiai-facilitator) — solo LECTURA para diseñar el companion

| Archivo | Qué extraje |
|---------|-------------|
| `src/core/schemas.ts` (L60-158) | `AcceptedSchema` (`.strict()`): `asset`/`payTo` = `AddressHexSchema` (`^0x…{40}$`), `extra` = `AcceptedExtraSchema`. Dos ramas del union: `Eip3009RequestSchema` + `NonEip3009RequestSchema` (solo `.extend()` el `extra` — `asset`/`payTo` heredan 0x-hex). `VerifyRequestSchema = z.union([Eip3009, NonEip3009])`; `SettleRequestSchema = VerifyRequestSchema` (alias). |
| `src/methods/eip3009/schemas.ts` (L14-82) | `AddressHexSchema` (0x+40hex), `Uint256StringSchema` (decimal canónico, ≤2^256-1), `Bytes32HexSchema`. Estos son los primitivos reusados. **No existe** un `Base58PubkeySchema` — el companion lo agrega. |
| `src/chains/solana-adapter.ts` (L48-410) | `BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/` (L48). `isBase58Pubkey` = `new PublicKey(v)` try/catch (L93). `isBase58Signature` = `BASE58_RE.test && len∈[64,120]` (L104). `_parseSolanaInput` (L142-196) lee `accepted.{network,asset(mint),payTo}` + `payload.{signature,reference}`, valida base58, `BigInt(accepted.amount)`. `settle()` (L363-410) = verify-only + dedup `UNIQUE(signature)`; éxito ⇒ `{ ok:true, settled:true, transactionHash: <signature base58> as 0x-string, ... }` (L400-409 — el `transactionHash` transporta la **base58 signature**, el `as 0x` es solo mentira de tipo). |
| `src/core/settle.ts` (L36-61) + `src/routes/settle.ts` (L100-...) | `settleCore` dispatch por namespace: `namespace==='solana'` ⇒ `adapter.settle()` **ANTES** de la lógica EIP-155. PERO `routes/settle.ts:100` corre `SettleRequestSchema.safeParse(request.body)` **ANTES** de `settleCore` ⇒ el Zod gate rechaza base58 → **el dispatch por namespace es inalcanzable sin el companion**. Idéntico en `routes/verify.ts:91` + `core/verify.ts:46`. |
| `doc/sdd/026-hu-sol-6-solana-adapter/report.md` (L27-34) | Status `DONE (2026-07-21) · HELD`, branch `feat/026-wkh-205-solana-adapter` sin merge/deploy. Follow-up #3: *"Wire-format HTTP Solana (HU-SOL-9/13): el schema Zod HTTP no representa aún un request Solana (asset/payTo 0x-hex)…"* — nombra a esta HU. Follow-up #4 (diferidos MENORes a esta HU): CR-MNR-2 (cluster por env `SOLANA_CLUSTER`), AR-MNR-2 (`degraded` global). |

### 3.3 Estado de flags / config (todo OFF por default)
- `NEXT_PUBLIC_VM` unset⇒`"evm"` (chaski). `NEXT_PUBLIC_EIP3009_ENABLED` gate del settle. `DEPOSIT_ATTESTATION_SECRET` gate del deposit-flow.
- Facilitator: adaptador Solana `opt-in-off` (`SOLANA_RPC_URL` + `SOLANA_USDC_MINT` ausentes ⇒ `null`, no registrado). Migración `003_facilitator_solana_dedup.sql` PENDING-DEPLOY (founder-gated).

### 3.4 Componentes reutilizables (NO reinventar)
`canonicalizeAddress` (HU-SOL-7), esqueleto HMAC de `deposit-attestation.ts`, `isBroadcasterConfigured()`/`mapStatus()` (`facilitator-client.ts`), patrón de resolver env-driven de `chain.ts`, `PublicKey`/`BASE58_RE`/`isBase58Pubkey`/`isBase58Signature` (facilitator, para el companion).

---

## 4. Diseño Técnico

### 4.1 Archivos a crear / modificar

**chaski-v3 (código de esta HU):**

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/infrastructure/chain.ts` | +`resolveSolanaReleaseAuthorityPubkey()` (env `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`, base58 fail-loud) | W0 |
| `src/infrastructure/settlement/deposit-attestation.ts` | +`SolanaDepositAttestation` + `issueSolanaDepositAttestation` + `verifySolanaDepositAttestation` (esqueleto HMAC compartido vía helper privado; EVM 100% intacto) | W0 |
| `src/infrastructure/settlement/facilitator-client.ts` | +`verifySolanaSettlement(input)` + `SolanaSettleInput` + tipos de resultado (reusa `isBroadcasterConfigured`/`mapStatus`; NO reusa el regex 0x-64 de respuesta) | W1 |
| `app/api/payout/prepare/route.ts` | PR4 `address`: VM-branch (`canonicalizeAddress` en solana). Emisión de atestación Solana = **CONTRATO** (ver §4.6, gated para HU-SOL-13) | W2 |
| `app/api/settle/principal/route.ts` | Comparaciones de address VM-discriminadas (helper `addressEquals(a,b,vm)`); B6/S12/S13 en solana usan `canonicalizeAddress`. EVM byte-idéntico | W2 |
| Tests (5 archivos, ver §6) | Rama Solana nueva + regresión EVM byte-idéntica | W3 |

**wasiai-facilitator (companion — DISEÑADO, NO codeado aquí; branch propio `feat/NNN-wfac-solana-wire`):**

| Archivo | Acción (para el companion ticket) |
|---------|-----------------------------------|
| `src/core/schemas.ts` | +`SolanaRequestSchema` (3ª rama de union) + `Base58PubkeySchema`/`Base58SignatureSchema`/`SolanaAcceptedSchema`/`SolanaPayloadSchema`. `VerifyRequestSchema = z.union([Eip3009, NonEip3009, Solana])`. Las 2 ramas EVM **sin tocar**. |
| tests del facilitator | +suite Solana wire (acepta base58) + regresión: los ~849 tests EVM byte-idénticos. |

### 4.2 DT-2 [RESUELTO] — Variante Solana de `DepositAttestation`: **tipos/funciones SEPARADAS (Opción b)**

**Decisión**: `SolanaDepositAttestation` + `issueSolanaDepositAttestation`/`verifySolanaDepositAttestation` separadas, NO un `vm` discriminante dentro del tipo EVM.

**Por qué (supera la Opción a)**: agregar `vm` (aunque sea `vm?:`) al `DepositAttestation` EVM tocaría el shape JSON que `issue`/`verify` serializan y obligaría a `deposit-attestation.test.ts:39` (`toEqual(payload())`) a incluir el campo ⇒ **violación directa de AC-2/CD-1** ("ningún test EVM cambia su assertion"). Las funciones EVM quedan **byte-a-byte intactas**; la lógica HMAC común se extrae a un helper privado `signB64(payloadB64, secret)` sin cambiar la salida EVM.

```ts
// deposit-attestation.ts (ADITIVO — las 3 funciones EVM existentes NO se tocan)
export interface SolanaDepositAttestation {
  remittanceId: string;   // no-vacío
  quoteId: string;        // no-vacío
  beneficiary: string;    // base58 — destino del release del escrow (== payTo atestado, AC-4)
  authority: string;      // base58 — release-authority (facilitator, resuelto server-side env-driven)
  cluster: "devnet";      // análogo Solana de chainId (anti replay cross-cluster, AC-5)
  exp: number;            // epoch SEGUNDOS
}
```

`verifySolanaDepositAttestation(token, nowMs)` = **mismo esqueleto** que `verifyDepositAttestation` (formato 2-partes → HMAC-primero timingSafe longitud-primero → parse try/catch → tipos por-campo → exp), con estas validaciones de campo (AC-5):
- `remittanceId`/`quoteId`: `string` no-vacío (idéntico a EVM).
- `beneficiary`/`authority`: `string` y `canonicalizeAddress(x,"solana")` **no throwea** — envuelto en try/catch que colapsa a `null` (fail-closed, sin ecoar la address). **NUNCA** `isAddress` (CD-2). La igualdad se compara canónica (case-sensitive), NO lowercaseada (Auto-Blindaje SOL-7: lowercasear una pubkey NO la invalida, reintroduce el IDOR).
- `cluster`: literal `=== "devnet"` (única entrada de esta HU; mainnet ⇒ null hasta HU-SOL-2/4).
- `exp`: `number` finito, `exp*1000 > nowMs`.

El secreto es el MISMO `DEPOSIT_ATTESTATION_SECRET` (mismo dominio "pre-settlement deposit binding"; NO se crea un secreto Solana nuevo). El HMAC-primero + fail-closed en cada paso garantiza AC-5 (no-oracle: el motivo exacto nunca se distingue al caller).

### 4.3 DT-4 [RESUELTO] — Rama Solana de `facilitator-client.ts`: **`verifySolanaSettlement` (verify-only)**

**Decisión**: la función NO se llama `broadcastSettle`. La semántica del `/settle` Solana del facilitator es **verify + dedup** (`solana-adapter.ts:363`, la tx ya está finalizada on-chain), NO broadcast. Nombre: `verifySolanaSettlement`.

```ts
export interface SolanaSettleInput {
  cluster: "devnet";       // → accepted.network = `solana:${cluster}`
  mint: string;            // base58 — accepted.asset (CD-9: resuelto server-side, jamás el body crudo)
  payTo: string;           // base58 — accepted.payTo (== beneficiary ATESTADO, AC-4)
  amountMinor: string;     // u64 decimal canónico (SPL base units) — accepted.amount
  signature: string;       // base58 — tx signature YA FINALIZADA on-chain (origen: HU-SOL-14/broadcast, Scope OUT)
  reference: string;       // base58 — payload.reference (Solana Pay correlation)
  resourceUrl: string;
}
```

Construye el envelope x402 que `_parseSolanaInput` (L142-196) espera **sin tocar el objeto `payload` de la rama EIP-3009** (AC-3, es una función y un objeto literal NUEVOS):

```ts
const payload = {
  x402Version: 2,
  resource: { url: input.resourceUrl },
  accepted: {
    scheme: "exact",
    network: `solana:${input.cluster}`,   // namespace → dispatch al adaptador Solana
    amount: input.amountMinor,
    asset: input.mint,                     // base58 (NO 0x-hex)
    payTo: input.payTo,                    // base58 (NO 0x-hex)
    maxTimeoutSeconds: 60,
    // SIN `extra.assetTransferMethod`: el adaptador Solana NO lo lee; el companion lo hace opcional (§4.5)
  },
  payload: {
    signature: input.signature,            // base58 tx sig (NO 0x-hex, NO objeto authorization)
    reference: input.reference,            // base58
  },
};
```

- Reusa `isBroadcasterConfigured()` (S2) y `mapStatus()` (S14-S18) **sin cambios**.
- **Respuesta**: NO reusa el regex `^0x[0-9a-fA-F]{64}$` (rechazaría una signature base58). Valida `body.settled === true` + `body.transactionHash` = `BASE58_RE.test && len∈[64,120]` (mismo criterio que `isBase58Signature` del adaptador). Devuelve `{ ok:true, signature }` o `{ ok:false, reason }` (mismo enum `FacilitatorFailure`, o uno análogo `SolanaFacilitatorFailure` si se prefiere no-mezclar — decisión menor de F3, ambas cumplen CD-12).
- **Nunca throw** (toda excepción → `settle_unavailable`). Env leída DENTRO de la función (CD-14).

### 4.4 [RESUELTO] — Release-authority: resolver env-driven + contrato de flujo (AC-4 vs AC-6)

**Tensión**: el orquestador pide que esta HU DEFINA cómo se resuelve server-side la `authority` del release; AC-6 prohíbe "hardcodear/sobrescribir `authority`/`beneficiary` a un valor de plataforma".

**Resolución**:
- **`authority`** (release-authority pubkey) es, por diseño del escrow no-custodial, el árbitro de release/refund — es un valor de la **plataforma/facilitator**, pero **env-driven, NO hardcodeado**. Esta HU implementa el resolver seam:
  ```ts
  // chain.ts (patrón EXACTO de resolveSolanaFacilitatorPubkey, L148-157)
  export function resolveSolanaReleaseAuthorityPubkey(): string {
    const raw = process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY;
    if (!raw) throw new Error("solana_release_authority_not_configured"); // fail-loud
    try { new PublicKey(raw); } catch { throw new Error("solana_release_authority_not_configured"); }
    return raw; // base58, jamás del body (CD-3/CD-9)
  }
  ```
  La keypair PRIVADA (que firma el release) es founder-gated y NO vive en chaski (firma = HU-SOL-13). Esta HU solo conoce el **pubkey**.
- **Contrato definido (consumido por HU-SOL-13)**: la `SolanaDepositAttestation.authority` atestada DEBE igualar `resolveSolanaReleaseAuthorityPubkey()` y DEBE igualar `deposit.escrow.authority` de la ix del wallet (`solana-wallet.ts:87`). El chequeo `att.authority === resolveSolanaReleaseAuthorityPubkey()` se documenta como el invariante; su **wiring runtime en el settle Solana** es HU-SOL-13.
- **`beneficiary`** (destino real del dinero): esta HU **NUNCA** lo resuelve, hardcodea ni sobrescribe. Su valor lo resuelve HU-SOL-13 (orden/vault). Esta HU solo lo **atesta** (si el caller lo provee) y lo **compara** (`att.beneficiary === payTo` vía canonicalize, AC-4). **Cumple AC-6**: la vía de refund trustless del sender (instrucción `refund` del escrow, firma diferida a HU-SOL-13) queda intacta porque esta HU no captura el `beneficiary` a un valor de plataforma.

### 4.5 Companion facilitator — `SolanaRequestSchema` (3ª rama de union, EVM byte-idéntico)

**Mecanismo del bloqueo (confirmado)**: `routes/settle.ts:100` → `SettleRequestSchema.safeParse(body)` → ambas ramas exigen `asset`/`payTo` = `AddressHexSchema` (0x-hex) y `extra.assetTransferMethod ∈ enum` → un body base58 falla el gate → `400 INVALID_PAYLOAD` → `settleCore` (y su dispatch namespace `solana`) es **inalcanzable**.

**Diseño del companion** (branch propio del facilitator, NO codeado aquí):

```ts
// nuevos primitivos base58 — mismos criterios que solana-adapter.ts (isBase58Pubkey / isBase58Signature)
const Base58PubkeySchema = z.string().refine((s) => { try { new PublicKey(s); return true; } catch { return false; } },
  'must be a base58 pubkey');
const Base58SignatureSchema = z.string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/u, 'base58')
  .refine((s) => s.length >= 64 && s.length <= 120, 'solana signature length');

const SolanaAcceptedSchema = z.object({
  scheme: z.literal('exact'),
  network: z.string().regex(/^solana:(devnet|mainnet)$/u),
  amount: Uint256StringSchema,        // u64 ⊂ uint256 — reusa el primitivo existente
  asset: Base58PubkeySchema,          // mint base58
  payTo: Base58PubkeySchema,          // beneficiary base58
  maxTimeoutSeconds: z.number().int().positive(),
  // extra OPCIONAL: el adaptador Solana no lo lee. NO se fuerza assetTransferMethod (no aplica a SPL).
  extra: z.unknown().optional(),
}).strict();

const SolanaPayloadSchema = z.object({
  signature: Base58SignatureSchema,   // tx sig finalizada (NO 0x-hex)
  reference: Base58PubkeySchema.optional(),
}).strict();

const SolanaRequestSchema = z.object({
  x402Version: z.literal(2),
  resource: ResourceSchema,
  accepted: SolanaAcceptedSchema,
  payload: SolanaPayloadSchema,
}).strict();

export const VerifyRequestSchema = z.union([Eip3009RequestSchema, NonEip3009RequestSchema, SolanaRequestSchema]);
```

**Por qué es EVM byte-idéntico** (AC-2 cross-repo): `z.union` prueba las ramas **en orden** y devuelve la primera que matchea. Un body EVM (0x-hex) matchea rama 1 ó 2 **exactamente como hoy** — agregar una 3ª rama al final NUNCA cambia el resultado de un input que ya matcheaba. Un body Solana (base58) falla 1 y 2 (exigen 0x-hex) y cae a la 3ª. Las definiciones de `Eip3009RequestSchema`/`NonEip3009RequestSchema` **no se tocan**. Los ~849 tests EVM del facilitator quedan verdes sin cambiar assertions. **Consistencia con el adaptador**: `Base58PubkeySchema`/`Base58SignatureSchema` usan el MISMO criterio (`new PublicKey` / `BASE58_RE`+len) que `_parseSolanaInput`, así un body que pasa Zod también pasa el parse del adaptador (sin doble-estándar que rechace después).

**Diferidos MENORes de HU-SOL-6** a resolver en el companion (report §Follow-ups #4): CR-MNR-2 (`SOLANA_CLUSTER` env en vez de inferir por substring) y AR-MNR-2 (excluir adapters no-EVM de `anyChainDown`/`degraded`).

### 4.6 Flujo Solana (habilitado dark, wiring runtime parcial — frontera HU-SOL-13)

- **prepare/route.ts** (esta HU): PR4 valida `address` (caller) VM-discriminado. La **emisión** de la `SolanaDepositAttestation` (que ata `beneficiary` + `authority`) requiere el `beneficiary` real ⇒ **resuelto por HU-SOL-13**. Esta HU deja el punto de emisión especificado (helper `issueSolanaDepositAttestation` listo + `resolveSolanaReleaseAuthorityPubkey` listo) pero **NO** cablea la resolución del `beneficiary` (Scope OUT / AC-6).
- **settle/principal/route.ts** (esta HU): las **comparaciones de address** (B6/S12/S13) se vuelven VM-safe con un helper `addressEquals(a, b, vm)` (`vm==="evm"` ⇒ `isAddressEqual` byte-idéntico; `vm==="solana"` ⇒ `canonicalizeAddress(a,"solana")===canonicalizeAddress(b,"solana")`, fail-closed si throw). Esto evita que `isAddressEqual` (que TIRA con base58) reviente el guard cuando `vm==="solana"`. La **orquestación completa del settle Solana** (llamar `verifySolanaSettlement`, resolver el `beneficiary` del vault, firmar el release) es **HU-SOL-13** — esta HU NO reescribe el cuerpo EIP-3009 (S5-S13) a un cuerpo Solana.
- **facilitator-client.ts** (esta HU): `verifySolanaSettlement` entregado + unit-tested contra el shape de `_parseSolanaInput` (mock fetch, sin red).

### 4.7 Missing Input #5 [RESUELTO] — de dónde sale `payload.signature`

`SolanaPrincipalAuthorization` (HU-SOL-5) entrega `partialSignedTx` (base64, **NO** broadcasteada) + `reference`. El `/settle` Solana del facilitator es **verify-only sobre una tx YA FINALIZADA** ⇒ necesita la **tx signature base58** (64 bytes), que **solo existe post-broadcast**. Por lo tanto `verifySolanaSettlement` recibe `signature` como **input** (producido por el broadcast gasless, **HU-SOL-14, Scope OUT**); esta HU define el WIRE y testea el shape con un signature mockeado. NO hay un paso de extracción del `partialSignedTx` en esta HU.

### 4.8 Flujo de error (fail-closed, no-oracle — todos los sitios)
`canonicalizeAddress` throwea con base58 malformado ⇒ envuelto en try/catch que colapsa al MISMO 400/`null` opaco que la rama EVM (mensaje/enum idéntico al existente por sitio: `settle_invalid_request`, `settle_binding_invalid`, `prepare_invalid_request`). Ningún motivo Solana nuevo se ecoa al caller (CD-12). Ningún path de address inválida alcanza un `fetch` (CD-5).

---

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (CD-1..CD-7) — vigentes
- **CD-1** — EVM byte-idéntico en los 4 archivos chaski + 2 ramas EVM del facilitator; ningún test EVM cambia assertion.
- **CD-2** — Solo `canonicalizeAddress(x,"solana")` para base58; PROHIBIDO `.toLowerCase()`/normalización ad-hoc (reabre el IDOR de HU-SOL-7).
- **CD-3** — `to`/`payTo`/`authority` Solana SIEMPRE server-controlado (HMAC/atestación/env), NUNCA eco crudo del body.
- **CD-4** — PROHIBIDO modificar cualquier archivo de `wasiai-facilitator` desde esta HU. El companion es ticket + branch separados.
- **CD-5** — Address Solana sin atestación válida NUNCA alcanza un fetch de red (patrón B1/B6 pre-broadcast).
- **CD-6** — PROHIBIDO encender flags compartidos (`NEXT_PUBLIC_VM`, `NEXT_PUBLIC_EIP3009_ENABLED`, secretos en entorno nuevo). Todo dark/aditivo, devnet.
- **CD-7** — Ownership Guard (WKH-53): si se extiende una escritura al `SettlementLedger` con campos Solana, preservar el scoping por `owner_ref`/caller; ninguna query nueva por `id` sin ese filtro.

### Nuevos del SDD (CD-8..CD-12) — derivados del grounding y del Auto-Blindaje histórico
- **CD-8** — DT-2 = tipos/funciones SEPARADAS (`SolanaDepositAttestation`): PROHIBIDO agregar campos al `DepositAttestation` EVM ni a su serialización JSON (rompería `deposit-attestation.test.ts:39`).
- **CD-9** — `verifySolanaSettlement` NO reusa el regex de respuesta `^0x…{64}$`; valida signature base58 (`BASE58_RE`+len 64-120). PROHIBIDO asumir shape 0x en la respuesta Solana.
- **CD-10 (Auto-Blindaje SOL-7)** — En comparación de identidad Solana, NUNCA asumir que `lowercase(pubkey)` es inválido: el riesgo IDOR es la **colisión/aliasing**, no el throw. La igualdad se hace sobre la forma canónica case-sensitive.
- **CD-11 (Auto-Blindaje SOL-5/SOL-7 — cascada de port/inline-types)** — Si se extiende un port cuyo impl/fake usa object-literals inline (ej. `SettlementLedger`, `FakeSettlementLedger`), actualizar impl **y** fake **y** los inputs literales de los tests, no solo el port (la bivarianza de métodos oculta el campo faltante en `tsc`).
- **CD-12 (Auto-Blindaje SOL-5 / WKH-196)** — El gate de tipos es `npx tsc --noEmit` **COMPLETO** (incluye tests), no solo `next build`. Si `facilitator-client`/tests lazy-importan una lib, separar `import type { … }` estático del `await import(...)` de valor.

---

## 6. Plan de Tests (≥1 por AC)

**chaski-v3** (vitest; patrón `deposit-attestation.test.ts` / `route.binding.test.ts`):

| # | Test (archivo) | Cubre |
|---|----------------|-------|
| T1 | `deposit-attestation.test.ts` — nuevo `describe("Solana deposit attestation")`: round-trip (`beneficiary`/`authority`/`cluster` base58 verifican íntegros), HMAC forjado (cambiar `beneficiary` reusando MAC ⇒ null), `cluster!=="devnet"` ⇒ null, `beneficiary`/`authority` base58 deforme ⇒ null (no throw), exp-frontera, fail-closed sin/otro secreto | AC-1, AC-5 |
| T2 | `deposit-attestation.test.ts` — regresión: los casos EVM existentes **sin cambio de assertion**; `verifyDepositAttestation` intacto | **AC-2** |
| T3 | `chain.test.ts` (o `chain.solana.test.ts`) — `resolveSolanaReleaseAuthorityPubkey`: base58 válido ⇒ devuelve; ausente/malformado ⇒ throw `solana_release_authority_not_configured`; jamás lee del body | AC-4, AC-6 |
| T4 | `facilitator-client.test.ts` (nuevo o extendido) — `verifySolanaSettlement`: **el payload construido matchea el shape que `_parseSolanaInput` espera** (`network=solana:devnet`, `asset`/`payTo` base58, `payload.signature`/`reference` base58, SIN objeto `authorization`); mock `fetch` captura el body y se asserta campo a campo; respuesta `settled:true`+signature base58 ⇒ `{ok:true}`; signature 0x/shape malo ⇒ `settle_unverified`; status 4xx/5xx ⇒ enum vía `mapStatus`; sin config ⇒ `settle_unavailable` | **AC-3** |
| T5 | `facilitator-client.test.ts` — regresión `broadcastSettle`: payload EIP-3009 **byte-idéntico**, ningún assertion existente cambia; el objeto `payload.eip3009` no se muta | **AC-2** |
| T6 | `route.binding.test.ts` (settle) — con `vm==="solana"` (stub `NEXT_PUBLIC_VM`): `addressEquals`/B6 acepta `to`==beneficiary atestado (base58) y **rechaza PRE-broadcast** un `to`!=beneficiary (nunca llama `verifySolanaSettlement`) — sin fetch de red | **AC-4**, AC-5 |
| T7 | `route.test.ts`/`route.static.test.ts` (settle) + `prepare/route.test.ts` — regresión EVM: modo estático y deposit-flow byte-idénticos; PR4/PR8 EVM intactos | **AC-2** |

**wasiai-facilitator** (companion ticket — especificado aquí para el orquestador):

| # | Test | Cubre |
|---|------|-------|
| TF1 | `schemas` — un body Solana (base58 asset/payTo, payload signature base58) **PASA** `SettleRequestSchema.safeParse` y matchea `SolanaRequestSchema` | AC-3 (e2e-reachability) |
| TF2 | `schemas` — regresión: los ~849 tests EVM byte-idénticos; un body EVM sigue matcheando rama 1/2, un body base58 en asset/payTo de una rama EVM sigue siendo rechazado | **AC-2 cross-repo** |
| TF3 | integración `routes/settle` — un body Solana ya no da `400 INVALID_PAYLOAD`; alcanza el dispatch namespace `solana` → `adapter.settle` (con adapter mock/no registrado ⇒ `CHAIN_UNAVAILABLE`, prueba que el gate Zod se pasó) | AC-3 |

---

## 7. Waves de Implementación

### Wave 0 (Serial — contratos/tipos, sin runtime wiring)
- W0.1 `chain.ts`: `resolveSolanaReleaseAuthorityPubkey()` (patrón `resolveSolanaFacilitatorPubkey`).
- W0.2 `deposit-attestation.ts`: `SolanaDepositAttestation` + `issue`/`verify` Solana (helper HMAC privado compartido; EVM intacto).
- W0.3 Tests T1, T2, T3 (aislados).

### Wave 1 (Wire al facilitator — paralelizable tras W0)
- W1.1 `facilitator-client.ts`: `SolanaSettleInput` + `verifySolanaSettlement` (reusa `isBroadcasterConfigured`/`mapStatus`).
- W1.2 Tests T4, T5.

### Wave 2 (Route branching VM-safe — tras W0)
- W2.1 helper `addressEquals(a,b,vm)` + branching en `settle/principal/route.ts` (B6/S12/S13) y `prepare/route.ts` (PR4). EVM byte-idéntico.
- W2.2 Tests T6, T7.

### Wave 3 (Gate de tipos + regresión completa)
- W3.1 `npx tsc --noEmit` COMPLETO (CD-12) + `npm run test` (suite entera verde, cero assertion EVM cambiada).

### Companion (repo wasiai-facilitator — ticket + branch SEPARADOS, founder/orquestador)
- WF.1 `SolanaRequestSchema` + primitivos base58 + 3ª rama union.
- WF.2 Tests TF1-TF3 + regresión EVM.
- WF.3 Merge a `main` del facilitator + deploy Railway + migración `003` (founder-gated, junto con el merge de HU-SOL-6 HELD).

---

## 8. Frontera de Scope (qué NO hace esta HU)

- **HU-SOL-13**: firmar/broadcastear el `release`, verificar el vault on-chain, resolver el `beneficiary` real, cablear la emisión de la `SolanaDepositAttestation` en prepare, orquestar el settle Solana completo llamando `verifySolanaSettlement`.
- **HU-SOL-14**: broadcast gasless / co-firma del facilitator que produce la `signature` finalizada.
- **HU-SOL-8** (027, F1 en paralelo): PoP ed25519 obligatorio. **Overlap de archivo** en `prepare/route.ts`: HU-SOL-8 = sección PR6 (guard PoP, L109-147); esta HU = PR4 (L82-83). Secciones distintas, sin overlap de líneas. **Orden de merge lo maneja el orquestador (HU-SOL-8 antes que HU-SOL-9)** — si HU-SOL-8 mergea primero, esta HU rebasa sobre PR6 ya VM-aware (ya usa `canonicalizeAddress`).
- **Companion**: el código del schema Zod del facilitator (repo externo, CD-4).

---

## 9. Riesgos

| Riesgo | Mitigación |
|--------|-----------|
| Tocar `payload.eip3009` al agregar la rama Solana | Rama Solana = función + objeto literal NUEVOS (§4.3); T5 asserta byte-identidad. |
| `isAddressEqual` TIRA con base58 en el guard Solana | Helper `addressEquals(a,b,vm)` con try/catch fail-closed; nunca 500 crudo. |
| Cascada port/inline-type oculta campo faltante en tsc | CD-11 + CD-12 (tsc COMPLETO); si se toca `SettlementLedger`, actualizar impl+fake+tests. |
| Companion no mergeado ⇒ código chaski no e2e-reachable | Explícito (§1, DT-5 del work-item): código chaski correcto + unit-tested con mocks; e2e-reachability = companion + HU-SOL-6 merge, founder-gated. **NO bloquea el merge de esta HU.** |
| `beneficiary` resuelto a valor de plataforma ⇒ captura refund | AC-6: esta HU NUNCA resuelve/hardcodea `beneficiary`; solo atesta/compara. §4.4. |

---

## 10. Uncertainty Markers

- `[NEEDS CLARIFICATION — NO bloqueante F3]` **Enum de resultado de `verifySolanaSettlement`**: reusar `FacilitatorFailure` (mezcla semántica broadcast/verify) vs. un `SolanaFacilitatorFailure` propio. Ambos cumplen CD-12. **Recomendación**: enum propio (semántica verify-only más honesta), decisión final en F3.
- `[NEEDS CLARIFICATION — NO bloqueante F3]` **Punto de entrada del settle Solana runtime**: si HU-SOL-13 reusa `settle/principal/route.ts` con una rama Solana o crea una route nueva. Esta HU solo entrega las comparaciones VM-safe + el wire; no fija la orquestación. Diferido a HU-SOL-13.
- `[NO bloqueante]` **Nombre/NNN del companion ticket** en `wasiai-facilitator`: lo asigna el orquestador/founder (candidato "HU-SOL-9b"/"WFAC-solana-wire").

**No hay `[NEEDS CLARIFICATION]` BLOQUEANTE en F2**: el bloqueante cross-repo del work-item (schema Zod) queda RESUELTO por diseño vía el SPLIT (companion especificado en §4.5). El código de esta HU es completo y testeable con mocks sin el companion; la e2e-reachability es founder-gated (documentada, no ambigua).

---

## 11. Readiness Check

- [x] Los 4 archivos chaski del Scope IN leídos y confirmados EVM-shaped (paths + líneas verificados con Read).
- [x] `canonicalizeAddress` (HU-SOL-7), esqueleto HMAC (`deposit-attestation.ts`), `isBroadcasterConfigured`/`mapStatus`, patrón resolver (`chain.ts`) — todos verificados como reusables.
- [x] Contrato del facilitator (`_parseSolanaInput`, `settle` return, gate Zod `routes/settle.ts:100`, `settleCore` dispatch) leído directamente — el bloqueo confirmado y el companion diseñado sin ambigüedad.
- [x] DT-2 (tipos separados) y DT-4 (`verifySolanaSettlement`) RESUELTOS con justificación.
- [x] AC-4/AC-6 (release-authority vs refund) reconciliados en §4.4 (resolver env-driven + contrato, sin capturar `beneficiary`).
- [x] Missing Input #5 (origen de `signature`) RESUELTO: input de HU-SOL-14 (Scope OUT).
- [x] Auto-Blindaje histórico incorporado como CD-10/CD-11/CD-12 (SOL-5, SOL-7, WKH-196).
- [x] Plan de tests ≥1 por AC (T1-T7 chaski + TF1-TF3 companion), incluyendo base58 e2e, EVM byte-idéntico en ambos repos, schema Solana aceptado + EVM intacto, `to`==beneficiary pre-broadcast.
- [x] Waves separan claramente chaski (W0-W3) vs companion (WF).
- [x] Overlap con HU-SOL-8 documentado (§8); orden de merge delegado al orquestador.
- [x] Cero `[NEEDS CLARIFICATION]` BLOQUEANTE. Los 3 markers restantes son NO-bloqueantes (decisiones de F3 / founder).

**Veredicto: LISTO PARA SPEC_APPROVED.**
