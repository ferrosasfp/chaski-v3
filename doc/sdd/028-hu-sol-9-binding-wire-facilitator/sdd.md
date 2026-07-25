# SDD #028: [WKH-208 / HU-SOL-9] Binding no-custodial + wire-format Solana al facilitator

> NexusAgil QUALITY · F2 (SDD) · 2026-07-22 (**regenerado** tras resolución del orquestador — CD-4 levantada)
> Cross-repo IN-SCOPE: **chaski-v3** (binding/wire, YA MERGEADO) + **wasiai-facilitator** (schema Zod, NET-NEW F3)
> Input: `doc/sdd/028-hu-sol-9-binding-wire-facilitator/work-item.md` (6 ACs EARS · 5 DT · 7 CD · 5 Missing Inputs)

---

## 0. Estado real y alcance de esta regeneración (LEER PRIMERO)

Este SDD reemplaza la versión previa que trataba el fix del facilitator como **companion ticket separado
PROHIBIDO** (por CD-4/DT-5, porque en F1 el repo `wasiai-facilitator` NO estaba montado). **Cambios de esta
regeneración**, por resolución explícita del orquestador (2026-07-22):

1. **`wasiai-facilitator` ahora está montado** → el fix puntual del schema Zod entra **EN EL SCOPE de esta
   HU**, como un esfuerzo cross-repo coordinado (no un ticket aparte). **CD-4 queda LEVANTADA solo para el
   cambio del schema** (`src/core/schemas.ts` + el mínimo de `src/methods/eip3009/schemas.ts` para los
   primitivos base58). **El resto del facilitator sigue intocable** (CD-4' abajo).

2. **La mitad chaski-v3 YA ESTÁ IMPLEMENTADA Y MERGEADA** — commit `a177825`
   *"feat(WKH-208/HU-SOL-9): binding no-custodial + wire Solana al facilitator"* (+ `7b15ab7` docs/report/_INDEX
   DONE). Verificado leyendo el código real en esta sesión: `SolanaDepositAttestation` +
   `issueSolanaDepositAttestation`/`verifySolanaDepositAttestation` (`deposit-attestation.ts:33-180`),
   `verifySolanaSettlement` + `SolanaSettleInput` (`facilitator-client.ts:145-241`), `addressEqualsVm`
   (`address.ts:37-46`). **DT-2 y DT-4 quedaron resueltas tal como este SDD las especifica** (tipos separados +
   `verifySolanaSettlement` verify-only). Para F3, el código chaski **NO se re-implementa**: es el **contrato/
   exemplar verificado** contra el que se alinea el schema del facilitator.

3. **Contexto verificado on-chain** (para no reinventar): el money-path Solana no-custodial ya corrió e2e en
   devnet — escrow Anchor deployado en `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`, deposit gasless vía
   `POST /solana/sponsor` (co-firma fee-payer, tx Finalized, vault 10 USDC). El `/settle` Solana del
   facilitator (`solana-adapter.ts::settle`) es **verify+dedup de una tx YA finalizada, NO broadcast** —
   confirmado leyendo `_parseSolanaInput`/`_verifyCore` (base de DT-4).

**Net-new executable de esta HU en F3 = la Wave del facilitator (§7 W4)**: relajar el `AcceptedSchema`/union
del facilitator para aceptar un request Solana base58, sin tocar ni un byte de las dos ramas EVM. Sin esa wave,
el código chaski (correcto + unit-tested con mocks) NO es HTTP-reachable e2e contra el facilitator real — el
gate Zod lo rechaza con `400 INVALID_PAYLOAD` antes del dispatch por namespace.

---

## 1. Resumen

Dos piezas del money-path Solana no-custodial, ambas **dark/aditivas detrás de flags OFF** (devnet, cero plata real):

1. **chaski-v3 (YA MERGEADO, a177825)**: ramifica por VM la validación/comparación de address en los 3 sitios
   que asumían EVM `0x`-hex de forma dura, reusando `canonicalizeAddress(address, vm)`/`addressEqualsVm`
   (HU-SOL-7). Agrega la variante Solana de la `DepositAttestation` (HMAC, mismo esqueleto) y la rama Solana de
   `facilitator-client.ts` (`verifySolanaSettlement`) que construye el envelope x402 `solana:<cluster>` en base58
   hacia el MISMO `/settle`. El path EVM (Base, EIP-3009) quedó byte-idéntico.

2. **wasiai-facilitator (NET-NEW, F3)**: el schema Zod HTTP (`src/core/schemas.ts::VerifyRequestSchema`/
   `SettleRequestSchema`) exige `asset`/`payTo` `0x`-hex en **AMBAS** ramas del `z.union` → un payload Solana
   base58 se rechaza con `400 INVALID_PAYLOAD` en el gate Zod (`routes/settle.ts` `safeParse`) **ANTES** del
   dispatch por namespace (`core/settle.ts:43` `namespace==='solana'`). Este SDD especifica una **TERCERA rama de
   union** (`SolanaRequestSchema`) que representa el request Solana sin mutar ni un byte de las dos ramas EVM. Es
   el "wire-format HTTP Solana" que el propio `report.md` de HU-SOL-6 nombra como responsabilidad de esta HU.

**Frontera dura**: este SDD NO firma/broadcastea el `release` (HU-SOL-13), NO verifica el vault on-chain
(HU-SOL-13), NO implementa PoP ed25519 (HU-SOL-8), NO hace broadcast gasless (HU-SOL-14). El binding
`to === beneficiary` (AC-4) define el CONTRATO de release-authority; su wiring runtime es HU-SOL-13.

---

## 2. Work Item — Acceptance Criteria (EARS, heredados)

- **AC-1** — VM branch en los 3 sitios: `resolveActiveVm()==="solana"` ⇒ aceptar/validar base58 vía
  `canonicalizeAddress(address,"solana")`, SIN `isAddress`/`isAddressEqual` de viem sobre esos campos.
- **AC-2** — EVM byte-idéntico (default `vm==="evm"`): mismos checks, códigos de error, shape de
  `DepositAttestation`, payload `eip3009`. **Ningún test EVM cambia su assertion — en AMBOS repos.**
- **AC-3** — Payload Solana representable hacia `/settle`: envelope x402 con `accepted.network=solana:<cluster>`,
  `asset`/`payTo` base58, `payload.signature`/`reference` base58 que `solana-adapter.ts::_parseSolanaInput`
  espera, SIN mutar el objeto `payload` de la rama `eip3009`. **Y** el gate Zod del facilitator debe DEJARLO
  PASAR (net-new de esta regeneración).
- **AC-4** — Release authority / `to` atestado == `beneficiary`: el `payTo` atestado (HMAC server-firmado) debe
  igualar por `canonicalizeAddress` al `SolanaEscrowDeposit.beneficiary` (resuelto por HU-SOL-13). Mismatch ⇒
  rechazo PRE-broadcast/pre-verify (patrón B6), sin fetch de red.
- **AC-5** — Anti-replay / anti-inyección fail-closed no-oracle: atestación Solana expirada/deforme/HMAC
  inválido/binding cruzado ⇒ mismo código opaco fail-closed que EVM, reusando el mismo esqueleto.
- **AC-6** — Refund trustless no bloqueado: NO hardcodear ni sobrescribir
  `SolanaEscrowDeposit.authority`/`beneficiary` a un valor de plataforma — la resolución del `beneficiary` es
  EXCLUSIVA de HU-SOL-13.

---

## 3. Context Map (Codebase Grounding — verificado con Read en esta sesión)

### 3.1 chaski-v3 (código YA MERGEADO — leído como contrato/exemplar)

| Archivo | Qué confirmé (real, post-merge a177825) |
|---------|------------------------------------------|
| `src/infrastructure/settlement/deposit-attestation.ts` (L20-180) | EVM: `DepositAttestation {depositAddress:0x-hex, chainId:number}`, `verifyDepositAttestation` L106 usa `!isAddress` (viem). Solana (ADITIVO, DT-2 tipos SEPARADOS): `SolanaDepositAttestation {remittanceId,quoteId,beneficiary(base58),authority(base58),cluster:"devnet",exp}` + `issue`/`verifySolanaDepositAttestation` L117-180 — mismo esqueleto HMAC (`sign()` compartido, mismo `DEPOSIT_ATTESTATION_SECRET`), formato→HMAC-primero(timingSafe,len-primero)→parse try/catch→tipos→exp. `beneficiary`/`authority` validados vía `canonicalizeAddress(x,"solana")` en try/catch→null (NUNCA `isAddress`, CD-2). EVM byte-intacto. |
| `src/infrastructure/settlement/facilitator-client.ts` (L145-241) | Solana (DT-4): `verifySolanaSettlement(input:SolanaSettleInput)` VERIFY-ONLY. Construye objeto literal NUEVO x402 (`network:solana:${cluster}`, `asset`=mint base58, `payTo` base58, `amount` u64 str, `maxTimeoutSeconds:60`, **SIN** `extra`; `payload:{signature(base58),reference(base58)}`, **SIN** `authorization`). Reusa `isBroadcasterConfigured`/`mapStatus` sin cambios. Respuesta: `settled===true` + `transactionHash` validado `isBase58Signature` (`BASE58_RE` + len 64-120), NO el regex 0x-64. Enum propio `SolanaFacilitatorFailure`. El `payload` EIP-3009 (`broadcastSettle`) NO se muta (AC-3). |
| `src/infrastructure/address.ts` (L13-46) | `canonicalizeAddress(addr,"evm"\|"solana")` (HU-SOL-7): evm=`toLowerCase()` nunca-throw; solana=`new PublicKey(addr).toBase58()` valida+normaliza, malformado⇒throw. `addressEqualsVm(a,b,vm)` (HU-SOL-9): solana=`canonicalizeAddress===` en try/catch→false; evm=`isAddressEqual` byte-idéntico. NUNCA `isAddressEqual` sobre base58 (TIRA). |
| `app/api/settle/principal/route.ts` + `app/api/payout/prepare/route.ts` | Comparaciones VM-branch (helper `addressEquals` NO-exportado del route — ver Auto-Blindaje §5). PR4 base58 en solana. EVM byte-idéntico. |

### 3.2 wasiai-facilitator (LECTURA para el schema NET-NEW)

| Archivo | Qué extraje (real) |
|---------|--------------------|
| `src/core/schemas.ts` (L60-158) | **El gate HTTP real.** `AcceptedSchema` (`.strict()`): `asset`/`payTo` = `AddressHexSchema` (`^0x…{40}$`). Dos ramas: `Eip3009RequestSchema` (payload `.strict()`) + `NonEip3009RequestSchema` (solo `.extend()` el `extra` a `permit2/erc7710`; `asset`/`payTo` heredan 0x-hex). `VerifyRequestSchema = z.union([Eip3009, NonEip3009])`; `SettleRequestSchema = VerifyRequestSchema` (alias, L157). **Este es el archivo a modificar.** Boundary comment (L13,33): los primitivos viven en `eip3009/schemas.ts`, NO duplicar acá. |
| `src/methods/eip3009/schemas.ts` (L14-82) | Primitivos: `AddressHexSchema`, `Uint256StringSchema` (u64⊂uint256), `Bytes32HexSchema`, `Eip3009AuthorizationSchema`. **No existe** `Base58PubkeySchema`. Aquí van los primitivos base58 nuevos (respeta OWNERS). Ojo: el `AcceptedSchema` de ESTE archivo (L73-80, `.passthrough()`) es method-local, **NO** es el gate HTTP — no confundir con el de `core/schemas.ts`. |
| `src/chains/solana-adapter.ts` (L48-196) | `BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/` (L48). `isBase58Pubkey`= `new PublicKey(v)` try/catch (L93). `isBase58Signature`= `BASE58_RE.test && len∈[64,120]` (L104). `_parseSolanaInput` (L142-196) lee `accepted.{network,asset(mint),payTo}` + `payload.{signature,reference?}`, valida base58, `BigInt(accepted.amount)`. **Shape exacto confirmado** (ver §4.4). |
| `src/core/settle.ts` (L36-61) / `src/core/verify.ts` (L46-63) | Dispatch por namespace: `namespace==='solana'` ⇒ valida `/^solana:(devnet\|mainnet)$/` ⇒ `getAdapterByNetworkId` ⇒ `adapter.settle()`. Corre DESPUÉS del Zod gate (`routes/settle.ts safeParse`). El branch solana NO chequea `assetTransferMethod` (early-return antes del check EVM L60) ⇒ **el request Solana NO necesita `extra`**. |
| `doc/sdd/026-hu-sol-6-solana-adapter/report.md` | HU-SOL-6 `DONE·HELD`, sin merge/deploy. Follow-up: nombra a HU-SOL-9 como responsable del wire-format. Diferidos MENORes: CR-MNR-2 (`SOLANA_CLUSTER` env), AR-MNR-2 (`degraded` global). |

### 3.3 Mecanismo del bloqueo (confirmado end-to-end)
`routes/settle.ts` → `SettleRequestSchema.safeParse(body)` → **ambas** ramas exigen `asset`/`payTo`=`AddressHexSchema` → un body base58 falla el gate → `400 INVALID_PAYLOAD` → `settleCore` (y su dispatch `namespace==='solana'`, `core/settle.ts:43`) es **inalcanzable**. El adaptador Solana está completo + unit-tested pero NO HTTP-reachable hasta el schema.

### 3.4 Estado de flags / config (todo OFF por default)
- chaski: `NEXT_PUBLIC_VM` unset⇒`"evm"`; `NEXT_PUBLIC_EIP3009_ENABLED` gate del settle; `DEPOSIT_ATTESTATION_SECRET` gate del deposit-flow.
- facilitator: adaptador Solana `opt-in-off` (`SOLANA_RPC_URL` + `SOLANA_USDC_MINT` ausentes ⇒ `null`, no registrado). Migración `003_facilitator_solana_dedup.sql` PENDING-DEPLOY (founder-gated). **El schema Zod es agnóstico de estos flags**: relajarlo NO enciende nada — un body Solana pasa el Zod pero cae en `CHAIN_UNAVAILABLE` mientras el adapter no esté registrado.

### 3.5 Componentes reutilizables (NO reinventar)
`canonicalizeAddress`/`addressEqualsVm` (HU-SOL-7/9), esqueleto HMAC de `deposit-attestation.ts`,
`isBroadcasterConfigured`/`mapStatus` (`facilitator-client.ts`) — todos YA en el merge chaski. En el facilitator:
`BASE58_RE`/`isBase58Pubkey`/`isBase58Signature` (`solana-adapter.ts`) como criterio de referencia para los
primitivos Zod (mismo criterio ⇒ lo que pasa el Zod pasa el `_parseSolanaInput`, sin doble-estándar).

---

## 4. Diseño Técnico

### 4.1 Archivos por repo

**chaski-v3 — YA MERGEADO (a177825). NO se re-implementa en F3.** Documentado como contrato verificado:
`deposit-attestation.ts` (variante Solana), `facilitator-client.ts` (`verifySolanaSettlement`), `address.ts`
(`addressEqualsVm`), `settle/principal/route.ts` + `prepare/route.ts` (VM-branch), + sus tests (ver §6).

**wasiai-facilitator — NET-NEW en F3 (CD-4 levantada SOLO para estos 2 archivos):**

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/methods/eip3009/schemas.ts` | +`Base58PubkeySchema` + `Base58SignatureSchema` (primitivos, respeta OWNERS boundary — los primitivos viven acá). Nada existente se toca. | W4 |
| `src/core/schemas.ts` | +`SolanaAcceptedSchema` + `SolanaPayloadSchema` + `SolanaRequestSchema` (3ª rama). `VerifyRequestSchema = z.union([Eip3009, NonEip3009, Solana])`. `SettleRequestSchema` hereda el alias. Las 2 ramas EVM **sin tocar un byte**. | W4 |
| tests del facilitator | +suite Solana wire (acepta base58) + regresión: los **979** tests EVM byte-idénticos. | W4 |

**PROHIBIDO en F3** (CD-4', resto del facilitator intocable): `solana-adapter.ts`, `core/settle.ts`,
`core/verify.ts`, `routes/*`, `infra/*`, registry, cualquier lógica. **Solo los 2 archivos de schema.**

### 4.2 DT-2 [RESUELTO, ya en el merge] — Variante Solana de `DepositAttestation`: tipos/funciones SEPARADAS

`SolanaDepositAttestation` + `issue`/`verifySolanaDepositAttestation` separadas (NO `vm` discriminante dentro del
tipo EVM). **Por qué**: agregar un campo al `DepositAttestation` EVM tocaría su serialización JSON y rompería
`deposit-attestation.test.ts` (`toEqual`) ⇒ violación de AC-2. El esqueleto HMAC (`sign()`/secret) se comparte
sin cambiar la salida EVM. **Confirmado byte-a-byte en el código merged** (`deposit-attestation.ts:33-40,117-180`).

### 4.3 DT-4 [RESUELTO, ya en el merge] — `verifySolanaSettlement` (verify-only, NO broadcast)

El `/settle` Solana del facilitator es verify+dedup de una tx YA finalizada (`solana-adapter.ts` verify-only,
confirmado). Por eso el nombre NO es `broadcastSettle`: es `verifySolanaSettlement`. Recibe `signature` como
**input** (producido por el broadcast gasless, HU-SOL-14/`/solana/sponsor`, Scope OUT). Objeto literal + enum
NUEVOS; el `payload` EIP-3009 no se muta. **Confirmado en `facilitator-client.ts:145-241`.**

### 4.4 Shape base58 EXACTO que `_parseSolanaInput` espera (base del schema NET-NEW)

Confirmado leyendo `solana-adapter.ts:142-196`. El schema Zol nuevo debe representar EXACTAMENTE esto (ni más
estricto, ni más laxo), y matchea 1:1 lo que `verifySolanaSettlement` YA envía:

| Campo | Fuente | Validación del adapter | Primitivo Zod nuevo |
|-------|--------|------------------------|---------------------|
| `accepted.network` | `accepted.network` | `string` (core valida `/^solana:(devnet\|mainnet)$/` después) | `z.string().regex(/^solana:(devnet\|mainnet)$/)` |
| `accepted.asset` (mint) | `accepted.asset` | `isBase58Pubkey` (`new PublicKey`) | `Base58PubkeySchema` |
| `accepted.payTo` | `accepted.payTo` | `isBase58Pubkey` | `Base58PubkeySchema` |
| `accepted.amount` | `accepted.amount` | `BigInt(...)` parseable | `Uint256StringSchema` (u64⊂uint256, reusa el primitivo) |
| `accepted.maxTimeoutSeconds` | (no leído por el adapter) | — (chaski envía `60`) | `z.number().int().positive()` |
| `accepted.scheme` | (no leído) | — (chaski envía `"exact"`) | `z.literal('exact')` |
| `payload.signature` | `payload.signature` | `isBase58Signature` (`BASE58_RE`+len 64-120) | `Base58SignatureSchema` |
| `payload.reference` | `payload.reference` | opcional; si string no-vacío ⇒ `isBase58Pubkey` | `Base58PubkeySchema.optional()` |

**NO** hay `extra` en el request Solana (el dispatch solana hace early-return antes del check
`assetTransferMethod`; chaski no lo envía). El schema Solana NO exige `extra`.

### 4.5 Companion facilitator — `SolanaRequestSchema` (3ª rama de union, EVM byte-idéntico)

```ts
// src/methods/eip3009/schemas.ts  (ADITIVO — primitivos base58; nada existente se toca)
import { PublicKey } from '@solana/web3.js';

/** base58 pubkey (32-byte) — mismo criterio que solana-adapter.ts::isBase58Pubkey. */
export const Base58PubkeySchema = z
  .string()
  .refine((s) => { try { new PublicKey(s); return true; } catch { return false; } }, 'must be a base58 pubkey');

/** base58 tx signature — mismo criterio que solana-adapter.ts::isBase58Signature. */
export const Base58SignatureSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/u, 'base58')
  .refine((s) => s.length >= 64 && s.length <= 120, 'solana signature length');
```

```ts
// src/core/schemas.ts  (ADITIVO — las 2 ramas EVM existentes NO se tocan)
import { AddressHexSchema, Uint256StringSchema, Eip3009AuthorizationSchema,
         Base58PubkeySchema, Base58SignatureSchema } from '../methods/eip3009/schemas.js';

const SolanaAcceptedSchema = z.object({
  scheme: z.literal('exact'),
  network: z.string().regex(/^solana:(devnet|mainnet)$/u, 'network must be solana:<devnet|mainnet>'),
  amount: Uint256StringSchema,            // u64 ⊂ uint256 — reusa el primitivo existente
  asset: Base58PubkeySchema,              // mint base58 (NO 0x-hex)
  payTo: Base58PubkeySchema,              // beneficiary base58 (NO 0x-hex)
  maxTimeoutSeconds: z.number().int().positive(),
}).strict();                              // sin `extra`: el adapter no lo lee y chaski no lo envía

const SolanaPayloadSchema = z.object({
  signature: Base58SignatureSchema,       // tx sig finalizada (NO 0x-hex, NO objeto authorization)
  reference: Base58PubkeySchema.optional(),
}).strict();

const SolanaRequestSchema = z.object({
  x402Version: z.literal(2),
  resource: ResourceSchema,
  accepted: SolanaAcceptedSchema,
  payload: SolanaPayloadSchema,
}).strict();

export const VerifyRequestSchema = z.union([Eip3009RequestSchema, NonEip3009RequestSchema, SolanaRequestSchema]);
// SettleRequestSchema = VerifyRequestSchema (alias existente L157) — hereda la 3ª rama sin cambios.
```

**Por qué es EVM byte-idéntico (AC-2 cross-repo, CD-1)**: `z.union` prueba las ramas **en orden** y devuelve la
primera que matchea. Un body EVM (0x-hex) matchea rama 1 ó 2 **exactamente como hoy** — agregar una 3ª rama al
final NUNCA cambia el resultado de un input que ya matcheaba, ni el mensaje de error de un input que fallaba las
dos primeras de forma más específica que hoy (Zod union agrega el issue de la 3ª rama al agregado, pero el
`safeParse().success` de todo body EVM válido/ inválido preexistente **no cambia**). Las definiciones de
`Eip3009RequestSchema`/`NonEip3009RequestSchema`/`AcceptedSchema`/`PayloadSchema` **no se editan**. Los **979
tests EVM** del facilitator quedan verdes sin cambiar assertions.

**Consistencia con el adaptador**: `Base58PubkeySchema`/`Base58SignatureSchema` usan el MISMO criterio
(`new PublicKey` / `BASE58_RE`+len) que `_parseSolanaInput` ⇒ un body que pasa el Zol también pasa el parse del
adapter (sin doble-estándar que lo rechace después con `NETWORK_MISMATCH`).

**Riesgo de mensaje de error (AR watch)**: hay un caso teórico donde un body que HOY falla con un issue
específico de la rama EVM podría, con 3 ramas, cambiar el TEXTO agregado del error (no el `.success`). Si algún
test EVM asserta el string exacto del error de `safeParse`, se cubre en W4 (TF2 revisa esos asserts). El
contrato observable HTTP (`400 INVALID_PAYLOAD` + código) NO cambia porque `routes/settle.ts` mapea cualquier
fallo Zod al mismo error opaco.

**Diferidos MENORes de HU-SOL-6** (report §Follow-ups): **NO** entran en esta HU (fuera del scope autorizado del
schema). CR-MNR-2 (`SOLANA_CLUSTER` env) / AR-MNR-2 (`degraded` global) quedan para el merge de HU-SOL-6 HELD.

### 4.6 Release-authority + binding (AC-4 vs AC-6) — CONTRATO, wiring en HU-SOL-13

- **`authority`** (release-authority pubkey): valor de plataforma pero **env-driven, NO hardcodeado**
  (`SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`/`resolveSolanaFacilitatorPubkey`, patrón `chain.ts`). La keypair
  PRIVADA que firma el release es founder-gated y NO vive en chaski (firma = HU-SOL-13). Esta HU solo conoce el
  pubkey y lo atesta.
- **Binding (AC-4)**: la `SolanaDepositAttestation.beneficiary` atestada (HMAC server-firmado) DEBE igualar el
  `payTo` enviado — comparado vía `addressEqualsVm(...,"solana")` (canónico case-sensitive, CD-2/CD-10). Mismatch
  ⇒ rechazo PRE-red (patrón B6), sin fetch. El wiring runtime completo del settle Solana (resolver el
  `beneficiary` del vault + orquestar `verifySolanaSettlement`) es **HU-SOL-13**.
- **`beneficiary`** (AC-6): esta HU NUNCA lo resuelve/hardcodea/sobrescribe a un valor de plataforma; solo lo
  atesta (si el caller lo provee) y lo compara. La vía de refund trustless del sender queda intacta.

### 4.7 Flujo de error (fail-closed, no-oracle)
`canonicalizeAddress` throwea con base58 malformado ⇒ try/catch colapsa al MISMO 400/`null` opaco que EVM
(mensaje/enum por sitio: `settle_invalid_request`, `settle_binding_invalid`, `prepare_invalid_request`). Ningún
motivo Solana nuevo se ecoa (CD-12). Ningún address inválido alcanza un `fetch` (CD-5). En el facilitator, todo
fallo Zol ⇒ `400 INVALID_PAYLOAD` opaco (sin distinguir rama).

---

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (CD-1..CD-7) — vigentes, con CD-4 ENMENDADA
- **CD-1** — EVM byte-idéntico: 4 archivos chaski **+ 2 ramas EVM del facilitator**; **ningún test EVM cambia
  assertion en NINGÚN repo** (chaski + los 979 del facilitator).
- **CD-2** — Solo `canonicalizeAddress(x,"solana")`/`addressEqualsVm` para base58; PROHIBIDO `.toLowerCase()`/
  normalización ad-hoc (reabre el IDOR de HU-SOL-7).
- **CD-3** — `to`/`payTo`/`authority` Solana SIEMPRE server-controlado (HMAC/atestación/env), NUNCA eco crudo del body.
- **CD-4 [ENMENDADA por el orquestador 2026-07-22]** — El facilitator entra EN SCOPE **SOLO** para el schema Zod:
  `src/core/schemas.ts` + `src/methods/eip3009/schemas.ts` (primitivos base58). **CD-4' (nueva)**: PROHIBIDO tocar
  cualquier OTRO archivo del facilitator (`solana-adapter.ts`, `core/settle.ts`/`verify.ts`, `routes/*`,
  `infra/*`, registry, migraciones). El fix es aditivo (3ª rama de union), cero cambios a las 2 ramas EVM.
- **CD-5** — Address Solana sin atestación válida NUNCA alcanza un fetch de red (patrón B1/B6 pre-broadcast).
- **CD-6** — PROHIBIDO encender flags compartidos (`NEXT_PUBLIC_VM`, `NEXT_PUBLIC_EIP3009_ENABLED`,
  `SOLANA_RPC_URL`/`SOLANA_USDC_MINT` del facilitator, secretos en entorno nuevo). Relajar el schema NO enciende
  el adapter (queda `null`/no-registrado ⇒ `CHAIN_UNAVAILABLE`). Todo dark/aditivo, devnet.
- **CD-7** — Ownership Guard (WKH-53): si se extiende una escritura al `SettlementLedger` con campos Solana,
  preservar el scoping por `owner_ref`/caller; ninguna query nueva por `id` sin ese filtro.

### Nuevos del SDD (CD-8..CD-13)
- **CD-8** — DT-2 = tipos/funciones SEPARADAS: PROHIBIDO agregar campos al `DepositAttestation` EVM ni a su JSON.
- **CD-9** — `verifySolanaSettlement` NO reusa el regex de respuesta `^0x…{64}$`; valida signature base58
  (`BASE58_RE`+len 64-120). En el facilitator, el `Base58*Schema` usa el MISMO criterio que `_parseSolanaInput`
  (no crear un doble-estándar que acepte en Zol y rechace en el adapter, o viceversa).
- **CD-10 (Auto-Blindaje SOL-7)** — En comparación de identidad Solana, NUNCA asumir que `lowercase(pubkey)` es
  inválido: el riesgo IDOR es la colisión/aliasing, no el throw. Igualdad sobre la forma canónica case-sensitive.
- **CD-11 (Auto-Blindaje #028 W2)** — PROHIBIDO exportar un helper desde un `route.ts` de Next.js (rompe
  `tsc --noEmit` completo vía `.next/types`). Los helpers compartibles/testeables viven en `src/infrastructure/*`.
- **CD-12 (Auto-Blindaje SOL-5 / WKH-196)** — El gate de tipos es `npx tsc --noEmit` **COMPLETO** (incluye tests
  y `.next/types`), no solo `next build`. En el facilitator: el gate es `npm run typecheck` + `npm test` COMPLETOS.
- **CD-13 (Auto-Blindaje #028 W2)** — Al VM-branchear un guard que otra HU dejó EVM-only "hasta la siguiente HU"
  (ej. PR4 de HU-SOL-8), actualizar los tests de esa HU que en modo `NEXT_PUBLIC_VM=solana` mandaban un `0x` — al
  input base58 nuevo, **sin tocar sus assertions** (siguen siendo tests no-EVM, AC-2 intacto).

---

## 6. Plan de Tests (≥1 por AC)

**chaski-v3** — YA en el merge (a177825), enumerados como cobertura verificada (NO se re-escriben en F3):

| # | Test | Cubre |
|---|------|-------|
| T1 | `deposit-attestation.test.ts` "Solana": round-trip (`beneficiary`/`authority`/`cluster` base58 íntegros), HMAC forjado (mutar `beneficiary` reusando MAC ⇒ null), `cluster!=="devnet"`⇒null, base58 deforme⇒null (no throw), exp-frontera, fail-closed sin/otro secreto | AC-1, AC-5 |
| T2 | `deposit-attestation.test.ts`: casos EVM **sin cambio de assertion**; `verifyDepositAttestation` intacto | **AC-2** |
| T3 | `address.test.ts`: `addressEqualsVm` solana (canónico case-sensitive; base58 deforme⇒false, no throw) + EVM `isAddressEqual` byte-idéntico | AC-1, AC-4 |
| T4 | `facilitator-client.test.ts`: `verifySolanaSettlement` — mock `fetch` captura el body y assertea campo a campo el shape que `_parseSolanaInput` espera (`network=solana:devnet`, `asset`/`payTo` base58, `payload.signature`/`reference` base58, SIN `authorization`, SIN `extra`); `settled:true`+sig base58⇒`{ok:true}`; sig 0x/shape malo⇒`settle_unverified`; 4xx/5xx⇒enum vía `mapStatus`; sin config⇒`settle_unavailable` | **AC-3** |
| T5 | `facilitator-client.test.ts`: regresión `broadcastSettle` payload EIP-3009 **byte-idéntico**; el `payload.eip3009` no se muta | **AC-2** |
| T6 | route settle/prepare `vm=solana` (stub `NEXT_PUBLIC_VM`): `addressEquals`/B6 acepta `to`==beneficiary atestado (base58) y **rechaza PRE-broadcast** un `to`!=beneficiary (nunca fetch) | **AC-4**, AC-5 |
| T7 | route EVM (settle estático + deposit-flow + prepare PR4/PR8): byte-idéntico | **AC-2** |

**wasiai-facilitator** — NET-NEW en F3 (W4):

| # | Test | Cubre |
|---|------|-------|
| TF1 | schemas: un body Solana (base58 `asset`/`payTo`, `payload.signature` base58, con y sin `reference`) **PASA** `SettleRequestSchema.safeParse` y matchea `SolanaRequestSchema`. El MISMO body que `verifySolanaSettlement` construye (copiar el objeto literal del test T4 chaski como fixture) | **AC-3** (e2e-reachability) |
| TF2 | schemas regresión: los **979 tests EVM byte-idénticos**; un body EVM sigue matcheando rama 1/2; un body con `asset`/`payTo` base58 en una rama EVM sigue rechazado; ningún assert de string de error Zol EVM cambia (§4.5 riesgo) | **AC-2 cross-repo** |
| TF3 | schemas negativos Solana: `network` `solana:mainnet-beta`/`eip155:…`⇒falla; `asset` no-base58 (`"0x…"`, `"Il0O"`)⇒falla; `signature` corta (<64)⇒falla; `extra` presente⇒`.strict()` falla (chaski no lo manda); `x402Version:"2"` string⇒falla | AC-3, fail-closed |
| TF4 | integración `routes/settle`: el body Solana YA NO da `400 INVALID_PAYLOAD`; alcanza `settleCore` dispatch `namespace==='solana'` → con adapter no-registrado ⇒ `CHAIN_UNAVAILABLE` (prueba que el gate Zol se pasó, sin encender el adapter — CD-6) | AC-3 |

---

## 7. Waves de Implementación

### Waves chaski (W0-W3) — YA MERGEADAS (a177825). NO se ejecutan en F3.
Documentadas por completitud: W0 tipos/HMAC Solana + `resolveSolanaReleaseAuthorityPubkey`; W1
`verifySolanaSettlement`; W2 route VM-branch (`addressEquals` NO-exportado); W3 `tsc --noEmit` + suite verde.
El F3 de esta regeneración **arranca en W4**.

### Wave 4 (NET-NEW · facilitator schema · CD-4 levantada solo acá)
- **W4.1** `src/methods/eip3009/schemas.ts`: +`Base58PubkeySchema` + `Base58SignatureSchema` (aditivo puro).
- **W4.2** `src/core/schemas.ts`: +`SolanaAcceptedSchema` + `SolanaPayloadSchema` + `SolanaRequestSchema`; 3ª
  rama en `z.union`. Las 2 ramas EVM y `AcceptedSchema`/`PayloadSchema` **sin tocar**. `SettleRequestSchema`
  hereda por alias.
- **W4.3** Tests TF1-TF4 + regresión: `npm run typecheck` + `npm test` COMPLETOS (CD-12), 979 EVM byte-idénticos.
- **W4.4 (founder-gated, fuera de F3-dev)** merge a `main` del facilitator + deploy Railway + registrar el
  adapter Solana (`SOLANA_RPC_URL`/`SOLANA_USDC_MINT`) + migración `003` — junto con el merge de HU-SOL-6 HELD.
  Esto NO lo hace el Dev; queda documentado como el paso operativo que cierra la e2e-reachability real.

**Orden de merge cross-repo**: el schema del facilitator (W4) puede mergearse independiente del chaski (ya
mergeado). El adapter Solana (HU-SOL-6 HELD) debe estar en `main` del facilitator + deployado para que W4.4
tenga efecto e2e; W4.1-W4.3 (schema + tests) son válidos y verdes sin ese deploy.

---

## 8. Frontera de Scope (qué NO hace esta HU)
- **HU-SOL-13**: firmar/broadcastear el `release`, verificar el vault on-chain, resolver el `beneficiary` real,
  cablear la emisión de la `SolanaDepositAttestation` en prepare, orquestar el settle Solana completo.
- **HU-SOL-14 / `/solana/sponsor`**: broadcast gasless que produce la `signature` finalizada (input de
  `verifySolanaSettlement`).
- **HU-SOL-8** (027): PoP ed25519 obligatorio. Overlap de archivo en `prepare/route.ts` (PR6 vs PR4) — ya
  reconciliado en el merge (Auto-Blindaje #028 W2: los tests solana de HU-SOL-8 usan input base58).
- **Facilitator, todo salvo el schema** (CD-4'): adapter, core dispatch, routes, infra, migraciones, y los
  diferidos MENORes CR-MNR-2/AR-MNR-2 de HU-SOL-6.

---

## 9. Riesgos

| Riesgo | Mitigación |
|--------|-----------|
| La 3ª rama de union cambia el TEXTO del error Zol de algún body EVM (no el `.success`) | §4.5; TF2 revisa asserts de string; el contrato HTTP (`400 INVALID_PAYLOAD` opaco) no cambia. |
| Doble-estándar Zol vs adapter (Zol acepta lo que `_parseSolanaInput` rechaza) | CD-9: `Base58*Schema` usa el MISMO criterio (`new PublicKey`/`BASE58_RE`+len); §4.4 tabla 1:1. |
| Relajar el schema "enciende" algo en prod | CD-6: el schema es agnóstico de flags; adapter no-registrado ⇒ `CHAIN_UNAVAILABLE`; migración founder-gated. |
| Tocar por error otro archivo del facilitator | CD-4': solo `core/schemas.ts` + `eip3009/schemas.ts`; el diff de F3 se acota a esos 2 + tests. |
| `beneficiary` capturado a valor de plataforma ⇒ rompe refund | AC-6/§4.6: esta HU nunca lo resuelve/hardcodea; solo atesta/compara (ya en el merge chaski). |

---

## 10. Uncertainty Markers
- `[NO bloqueante · founder]` **W4.4** (merge+deploy facilitator + registrar adapter + migración `003`) es
  operativo founder-gated, no trabajo de F3-dev. La e2e-reachability real depende de él + del merge de HU-SOL-6
  HELD. No bloquea el merge del schema (W4.1-W4.3 son válidos y verdes solos).
- `[NO bloqueante · F3]` Ubicación exacta de los primitivos base58: `eip3009/schemas.ts` (recomendado, respeta
  el OWNERS boundary "primitivos acá, no duplicar en core") vs un módulo neutro nuevo. El SDD fija
  `eip3009/schemas.ts` (mínimo cambio, sin archivo nuevo). Si el Dev encuentra un conflicto de naming/lint,
  puede crear `src/methods/solana/schemas.ts` — decisión menor, ambas respetan CD-4'.

**No hay `[NEEDS CLARIFICATION]` BLOQUEANTE**: el bloqueante cross-repo original (schema Zol, DT-5/Missing #1)
queda RESUELTO — no por SPLIT diferido, sino por inclusión IN-SCOPE (CD-4 levantada) con el diseño de §4.5
verificado contra el shape real de `_parseSolanaInput`.

---

## 11. Readiness Check
- [x] Los 4 archivos chaski leídos post-merge (a177825) y confirmados como contrato verificado (DT-2/DT-4 tal
  como este SDD los especifica).
- [x] Los 2 archivos del facilitator a modificar leídos con Read: `core/schemas.ts` (el gate real, `asset`/`payTo`
  = `AddressHexSchema` en ambas ramas) + `eip3009/schemas.ts` (primitivos, sin base58). Distinción confirmada
  con el `AcceptedSchema` method-local (passthrough) que NO es el gate.
- [x] Shape base58 EXACTO de `_parseSolanaInput` confirmado con Read (`solana-adapter.ts:142-196`) y mapeado 1:1
  a primitivos Zol (§4.4). Coincide con lo que `verifySolanaSettlement` ya envía.
- [x] Mecanismo del bloqueo confirmado end-to-end: `routes/settle` `safeParse` → union EVM-only → 400 antes del
  dispatch `namespace==='solana'` (`core/settle.ts:43`).
- [x] EVM byte-idéntico argumentado para el `z.union` de 3 ramas (orden, primera-que-matchea) + riesgo de string
  de error acotado (TF2).
- [x] CD-4 enmendada (levantada solo para el schema) + CD-4' (resto del facilitator intocable) explícitas.
- [x] CD-1 reafirmada sobre el facilitator (979 tests EVM byte-idénticos).
- [x] Auto-Blindaje incorporado: #028 W2 (CD-11 export desde route.ts, CD-13 tests VM-branch), SOL-7 (CD-10),
  SOL-5/WKH-196 (CD-12).
- [x] Plan de tests ≥1 por AC: T1-T7 chaski (merged) + TF1-TF4 facilitator (net-new); base58 e2e, EVM
  byte-idéntico en ambos repos, schema Solana aceptado + `.strict()` negativos, dispatch alcanzado.
- [x] Waves separan chaski (W0-W3, merged) de facilitator (W4, net-new); orden de merge cross-repo documentado.
- [x] Cero `[NEEDS CLARIFICATION]` BLOQUEANTE. Los 2 markers restantes son NO-bloqueantes (founder/F3-menor).

**Veredicto: LISTO PARA SPEC_APPROVED.**
