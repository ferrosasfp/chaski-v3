# Work Item — [WKH-208 / HU-SOL-9] chaski-v3: binding no-custodial + wire al facilitator (Solana)

## Resumen
Ramifica la validación de address por VM (acepta base58 cuando `vm === "solana"`) en los 3 sitios
donde `chaski-v3` hoy asume EVM 0x-hex de forma dura (`deposit-attestation.ts`, `settle/principal/
route.ts`, `prepare/route.ts`), y hace que `facilitator-client.ts` pueda construir/enviar un payload
Solana representable hacia el `wasiai-facilitator` — dejando el path EVM (Base, EIP-3009) 100%
byte-idéntico. Con el escrow futuro (HU-SOL-13), el binding no-custodial de esta HU pasa a ser la
**authority del `release`**: el facilitator solo libera el vault → TransFi tras verificar el deposit +
KYC + orden, y el `to` atestado debe ser exactamente el `beneficiary` del escrow. Sprint 3 (Seguridad
+ e2e) del programa Solana LATAM Labs.

## Sizing
- SDD_MODE: full
- Estimación: L
- Branch sugerido: `feat/028-hu-sol-9-binding-wire-facilitator`
- Smart Sizing: **QUALITY** (money-path, cross-cutting VM discriminado + dependencia cross-repo)

## Grounding (F0) — hallazgos clave

1. **Los 3 sitios citados por la HU están confirmados y son 100% EVM-shaped hoy**:
   - `src/infrastructure/settlement/deposit-attestation.ts` — `DepositAttestation.depositAddress:
     string // 0x + 40 hex (isAddress)`, `chainId: number`; `verifyDepositAttestation` L91 hace
     `!isAddress(depositAddress)` (viem) — SIEMPRE rechaza un base58.
   - `app/api/settle/principal/route.ts` — S12/B1-B6 (L145-190) comparan `to` contra `expectedTo` con
     `isAddressEqual` (viem) tanto en modo estático (receiver de env) como en modo deposit-flow
     (depositAddress atestado); ambos caminos son EVM-only.
   - `app/api/payout/prepare/route.ts` — PR8 (L180-183) exige `depositAddress` con `isAddress`; el
     `address` del caller (PR PoP, L82-83) también se valida con `isAddress`.
   - Ya existe `canonicalizeAddress(address, vm)` (`src/infrastructure/address.ts`, HU-SOL-7, DONE)
     que resuelve exactamente este problema de forma VM-discriminada, auditado (AR probó anti-IDOR de
     colisión de case) — candidato de reuso directo, NO reinventar.

2. **`facilitator-client.ts` (L82-143) es hoy el ÚNICO archivo que conoce `FACILITATOR_BASE_URL`/
   `FACILITATOR_API_KEY` y hace el POST a `/settle`** (CD-20 del propio archivo — directiva legal/PSAV:
   si el broadcaster cambia, se reemplaza ESTE archivo, no la HU). El payload que construye hoy
   (`x402Version:2`, `accepted.network: eip155:<chainId>`, `accepted.asset`/`payTo` 0x-hex,
   `accepted.extra.assetTransferMethod:"eip3009"`, `payload.signature`+`payload.authorization`) es
   100% EIP-3009/EVM.

3. **Hallazgo CRÍTICO cross-repo (bloqueante)**: el adaptador Solana del facilitator (HU-SOL-6/WKH-205,
   `DONE (2026-07-21) · HELD`, branch `feat/026-wkh-205-solana-adapter`, sin mergear a `main` del
   facilitator ni deployado a Railway) es **verify-only** — su `settle()` (`src/chains/
   solana-adapter.ts:363-410`) NO transmite ninguna transacción; re-ejecuta `_verifyCore` sobre una tx
   Solana YA finalizada on-chain (leída por RPC) y persiste el dedup (`UNIQUE(signature)` Postgres,
   fail-CLOSED). Es decir: para Solana, `/settle` del facilitator es semánticamente un
   **verify+dedup**, no un broadcast — el broadcast/co-firma ocurre por otra vía (wallet del cliente
   auto-envía, o el facilitator gasless de HU-SOL-14, NO implementado aún).
   Pero **el propio `report.md` de HU-SOL-6** (`wasiai-facilitator/doc/sdd/026-hu-sol-6-solana-adapter/
   report.md` L27-31, sección "Activación / follow-ups") dice literalmente: *"Wire-format HTTP
   Solana (follow-up **HU-SOL-9/13**): el schema Zod HTTP no representa aún un request Solana
   (asset/payTo 0x-hex); el adapter está completo + unit-tested pero no HTTP-reachable e2e hasta ese
   wire-format."* — nombrando EXPLÍCITAMENTE a esta HU como la responsable.
   Verificado en el código del facilitator (`wasiai-facilitator/src/core/schemas.ts` L60-70,99-141 y
   `src/methods/eip3009/schemas.ts` L22-24,73-80): `AcceptedSchema.asset`/`payTo` usan
   `AddressHexSchema` (`^0x[0-9a-fA-F]{40}$`) en **AMBAS** ramas del `z.union` (`Eip3009RequestSchema`
   Y `NonEip3009RequestSchema`, que solo `.extend()` el campo `extra` — `asset`/`payTo` se heredan
   0x-hex sin cambios). Confirmado en `src/routes/verify.ts:91`/`src/routes/settle.ts:100`: el Zod
   `.safeParse(request.body)` corre ANTES de que `core/verify.ts`/`core/settle.ts` dispachen por
   namespace (`namespace === 'solana'`, `core/verify.ts:46-63`) — así que **un payload Solana con
   `asset`/`payTo` base58 se rechaza con 400 `INVALID_PAYLOAD` en el gate Zod, sin importar qué tan
   bien lo construya `facilitator-client.ts` del lado chaski**. Esta HU NO puede tocar
   `wasiai-facilitator` (directiva explícita del orquestador) → ver Missing Inputs #1 (BLOQUEANTE).

4. **Hallazgo de coordinación**: `doc/sdd/027-hu-sol-8-pop-ed25519/work-item.md` (F1, NNN `027`, la HU
   inmediatamente anterior en este mismo repo) declara en su propio "Análisis de paralelismo":
   *"Bloquea a: HU-SOL-9 (settle Solana), que necesita este gate cerrado antes de poder mover dinero
   real en el money-path Solana"* — porque el binding Didit (`authority.ts:74-87`) es débil para
   Solana y el PoP ed25519 debe ser OBLIGATORIO (no opt-in) en ese VM. La HU original (texto Jira de
   HU-SOL-9) NO lista a HU-SOL-8 como dependencia — es un hallazgo NUEVO de F0, no anticipado por el
   ticket. Además, **overlap de archivo real**: HU-SOL-8 toca `app/api/payout/prepare/route.ts` (PR6,
   guard PoP, L109-147) y esta HU toca el MISMO archivo (PR7-PR11, L149-224, forward+depositAddress+
   atestación) — secciones distintas, sin overlap de líneas hoy, pero mismo archivo → coordinar orden
   de merge (ver Análisis de paralelismo).

5. **`app/api/a2a/payout/submit/route.ts`** (guard 8, atestación de settlement pre-payout, WKH-211) NO
   está en el Scope IN de esta HU (la HU original solo cita los 3 archivos + facilitator-client.ts) —
   confirmado que su firma no necesita tocarse para el binding/wire de esta HU (el settlement
   attestation de `submit/route.ts` es un artefacto downstream que no valida el address VM
   directamente).

## Acceptance Criteria (EARS)

- **AC-1** (ramificación de address por VM en los 3 sitios): WHEN `resolveActiveVm() === "solana"`, the
  system SHALL aceptar y validar un address base58 — vía `canonicalizeAddress(address, "solana")`,
  SIN `isAddress`/`isAddressEqual` de viem sobre esos campos — en `deposit-attestation.ts`
  (`issueDepositAttestation`/`verifyDepositAttestation`), `settle/principal/route.ts` (comparaciones
  `to`/`address`/B1-B6) y `prepare/route.ts` (`address`, `depositAddress`).

- **AC-2** (EVM byte-idéntico): WHILE `resolveActiveVm() === "evm"` (default), the system SHALL
  preservar EXACTAMENTE el comportamiento actual — mismos checks `isAddress`/`isAddressEqual`, mismos
  códigos de error, mismo shape/campos de `DepositAttestation`, mismo payload `eip3009` que construye
  `facilitator-client.ts` HOY (byte a byte) — en los 4 archivos tocados. Ningún test EVM existente
  cambia su assertion.

- **AC-3** (payload Solana representable hacia `/settle`): WHEN se invoca la rama Solana de
  `facilitator-client.ts` con un envelope `SolanaAuthorization`/`SolanaPrincipalAuthorization` (HU-SOL-1/
  HU-SOL-5), the system SHALL construir un objeto `x402` con `accepted.network` = `solana:<cluster>`,
  `accepted.asset`/`accepted.payTo` en base58, y el `payload` con la `signature`/`reference` base58 que
  el adaptador Solana del facilitator (`solana-adapter.ts::_parseSolanaInput`) espera — SIN mutar ni un
  campo del objeto `payload` de la rama `eip3009`.

- **AC-4** (release authority / `to` atestado == beneficiary del escrow): WHEN se emite o verifica una
  atestación de depósito no-custodial en rama Solana, the system SHALL exigir que el `to`/`payTo`
  atestado (HMAC, server-firmado) sea igual — por `canonicalizeAddress` — al `beneficiary` resuelto por
  el escrow (`SolanaEscrowDeposit.beneficiary`, tipo ya declarado por HU-SOL-5 en `ports.ts:163-167`,
  resuelto en runtime por HU-SOL-13). IF el valor firmado/enviado por el cliente no coincide con el
  atestado, THEN the system SHALL rechazar PRE-broadcast/pre-verify (mismo patrón B6 ya existente en
  la rama EVM), sin excepción y sin invocar ningún fetch de red.

- **AC-5** (anti-replay / anti-inyección de destino, fail-closed no-oracle): IF una atestación de
  depósito Solana está expirada, mal formada, con HMAC inválido, o referencia un `remittanceId`/
  `quoteId`/cluster distinto al de la request, THEN the system SHALL rechazarla con el mismo código
  opaco fail-closed (sin distinguir el motivo exacto al caller) que usa hoy la rama EVM — reusando el
  mismo esqueleto de verificación (formato → HMAC → parse → tipos → expiración → binding), sin nuevas
  ramas de fallo silencioso ni de aceptación implícita.

- **AC-6** (refund trustless no bloqueado): the system SHALL NO hardcodear ni sobrescribir
  `SolanaEscrowDeposit.authority`/`beneficiary` a un valor de plataforma en ningún punto tocado por esta
  HU — ambos se resuelven EXCLUSIVAMENTE vía HU-SOL-13, de modo que la vía de refund trustless del
  sender (implementación de firma diferida a HU-SOL-13) queda intacta y no capturada por el binding.

## Scope IN
- `src/infrastructure/settlement/deposit-attestation.ts` — rama Solana ADITIVA en
  `issueDepositAttestation`/`verifyDepositAttestation` (o el diseño de tipos que decida F2, ver DT-2).
- `app/api/settle/principal/route.ts` — sección S12/B1-B6 (~L145-190): comparación `to`/`expectedTo`/
  `address` discriminada por `resolveActiveVm()`.
- `app/api/payout/prepare/route.ts` — validación `address` (PR4) y `depositAddress` (PR8, ~L82-83,
  L180-183) discriminada por VM.
- `src/infrastructure/settlement/facilitator-client.ts` — payload Solana ADITIVO hacia `/settle`
  (nombre/contrato exacto de la función es F2, ver DT-4); reuso de `mapStatus`/`isBroadcasterConfigured`
  donde aplique.
- Reuso de `canonicalizeAddress(address, vm)` (`src/infrastructure/address.ts`, HU-SOL-7, YA EXISTE) —
  sin modificarlo salvo que F2 justifique explícitamente una extensión.
- Tests unitarios: rama Solana nueva en los 4 archivos + regresión EVM byte-idéntica (AC-2) + test de
  integración del payload Solana contra el shape esperado por `solana-adapter.ts::_parseSolanaInput`
  (mock, sin red real).

## Scope OUT
- Firmar/co-firmar/broadcastear la tx de `release` del escrow (**HU-SOL-13**).
- Verificación server-side del vault/estado del escrow on-chain (**HU-SOL-13**).
- Proof-of-Possession ed25519 / binding CAIP-2 obligatorio en Solana (**HU-SOL-8**, 027, F1 en
  paralelo — ver hallazgo #4 de grounding; esta HU NO implementa el gate PoP, solo coexiste con él).
- Broadcast gasless / completar la co-firma `partial-signed` del facilitator (**HU-SOL-14**) — el
  "wire al facilitator" de esta HU asume la tx Solana YA finalizada on-chain cuando se llama a `/settle`
  (consistente con el diseño verify-only de `solana-adapter.ts`).
- **Fix del schema Zod HTTP del facilitator** (`wasiai-facilitator/src/core/schemas.ts::AcceptedSchema`,
  `asset`/`payTo: AddressHexSchema`) — repo externo, PROHIBIDO tocarlo desde esta HU (directiva del
  orquestador). Ver Missing Inputs #1, BLOQUEANTE cross-repo.
- Cualquier cambio a `wallet.ts` / firma SPL (HU-SOL-2, DONE) o al programa Anchor del escrow.
- Encender cualquier flag compartido (`NEXT_PUBLIC_VM=solana`, `NEXT_PUBLIC_EIP3009_ENABLED`,
  `DEPOSIT_ATTESTATION_SECRET` en un entorno nuevo, etc.) en ningún ambiente — todo el código de esta
  HU queda dark/aditivo detrás de flags OFF (mismo patrón que todo el programa Solana LATAM Labs).
- `@solana/pay` (prohibido por constraint de programa, reafirmado por HU-SOL-1/HU-SOL-8).

## Decisiones técnicas (DT-N)
- **DT-1**: reusar `canonicalizeAddress(address, vm)` (HU-SOL-7, ya auditado contra IDOR de colisión de
  case) en los 3 sitios en vez de introducir un nuevo helper — cero superficie nueva de bugs de
  comparación de identidad.
- **DT-2**: `DepositAttestation` es hoy 100% EVM-shaped (`depositAddress: 0x-hex`, `chainId: number`).
  Para no violar AC-2, la rama Solana requiere que F2 decida entre (a) discriminar por `vm` DENTRO del
  mismo tipo/función (análogo a `VmAuthorization`, HU-SOL-1) o (b) tipos/funciones separados
  (`issueDepositAttestation` vs. `issueSolanaDepositAttestation`) — ambas alternativas cumplen las CDs,
  el Architect elige en F2 (ver Missing Inputs #2).
- **DT-3**: el "`to` atestado == `beneficiary` del escrow" (AC-4) implica que esta HU solo LEE/COMPARA
  `SolanaEscrowDeposit.beneficiary` — la resolución real de ese valor (consultar el vault on-chain,
  derivar la PDA, etc.) sigue siendo responsabilidad exclusiva de HU-SOL-13; esta HU no lo calcula.
- **DT-4**: dado el hallazgo #3 de grounding (el `settle()` Solana del facilitator es verify+dedup, NO
  broadcast), la función nueva en `facilitator-client.ts` probablemente NO debe llamarse
  `broadcastSettle` para la rama Solana (nombre engañoso semánticamente) — el nombre/contrato exacto
  (p.ej. `verifySolanaSettlement`) es decisión de F2, documentada explícitamente para que el Architect
  no la asuma en silencio.
- **DT-5**: el "wire-format" HTTP hacia el facilitator (hallazgo #3) es un BLOQUEANTE cross-repo que
  esta HU NO puede resolver por directiva explícita. Se recomienda al orquestador el mismo patrón de
  SPLIT ya usado en este repo (WKH-210/WKH-211, WKH-168/WKH-207): esta HU entrega el código chaski-side
  completo (dark, testeado con mocks del shape esperado), y un companion ticket separado en el repo
  `wasiai-facilitator` (candidato "HU-SOL-9b" o el nombre que decida el orquestador) relaja
  `AcceptedSchema.asset`/`payTo` a un union `AddressHexSchema | Base58PubkeySchema` condicionado por el
  prefijo de `network`. Sin ese companion, el código de esta HU es funcionalmente correcto pero NO
  HTTP-reachable e2e contra el facilitator real (mismo lenguaje que usó el propio report de HU-SOL-6).

## Constraint Directives (CD-N)
- **CD-1 (EVM byte-idéntico)**: PROHIBIDO mutar un solo byte del payload EIP-3009/comportamiento EVM en
  ninguno de los 4 archivos tocados (`deposit-attestation.ts`, `settle/principal/route.ts`,
  `prepare/route.ts`, `facilitator-client.ts`). Ningún test EVM existente cambia su assertion (AC-2).
- **CD-2 (canonicalización, anti-IDOR)**: PROHIBIDO `.toLowerCase()` u otra normalización ad-hoc sobre
  un address Solana en cualquiera de los 3 sitios — SIEMPRE `canonicalizeAddress(address, "solana")`
  (reabrir esto reabriría la clase de IDOR que HU-SOL-7 cerró).
- **CD-3 (`to`/`payTo` server-controlado)**: PROHIBIDO que el `to`/`payTo` atestado en rama Solana salga
  directamente del body del request sin pasar por HMAC/atestación server-firmada — mismo patrón CD-9
  histórico de la rama EVM (WKH-168/211), NUNCA un eco crudo del cliente.
- **CD-4 (no tocar el facilitator)**: PROHIBIDO modificar cualquier archivo de `wasiai-facilitator`
  desde esta HU (repo externo, standalone). Cualquier fix necesario en su schema Zod es un companion
  ticket separado, coordinado pero NO ejecutado por esta HU (DT-5).
- **CD-5 (anti-inyección de destino, rechazo PRE-red)**: OBLIGATORIO que un `to`/`payTo` Solana sin
  atestación válida NUNCA llegue a ningún fetch de red (ni al facilitator ni a ningún RPC) — mismo
  patrón B1/B6 pre-broadcast ya existente en la rama EVM (AC-4).
- **CD-6 (flags dark)**: PROHIBIDO encender cualquier flag compartido (`NEXT_PUBLIC_VM`,
  `NEXT_PUBLIC_EIP3009_ENABLED`, secretos de atestación en un entorno nuevo) como efecto colateral de
  esta HU — todo el código Solana queda dark/aditivo, en devnet, cero plata real.
- **CD-7 (Ownership Guard, WKH-53)**: SI esta HU extiende cualquier escritura al `SettlementLedger`
  (`recordOrderPrepared`/`recordPrincipalIn`) con campos Solana, OBLIGATORIO preservar el mismo
  scoping por `owner_ref`/caller ya existente — PROHIBIDO ninguna query nueva por `id` sin ese filtro.

## Missing Inputs
- **[BLOQUEANTE cross-repo, para F2/founder]** El schema Zod HTTP del facilitator
  (`wasiai-facilitator/src/core/schemas.ts::AcceptedSchema`) exige `asset`/`payTo` 0x-hex en AMBAS
  ramas del `z.union` — un request Solana con base58 se rechaza en el gate Zod ANTES del dispatch por
  namespace, sin importar cómo se construya el payload del lado chaski. Confirmado explícitamente por
  el propio `report.md` de HU-SOL-6 (nombra a esta HU como responsable del "wire-format"). Esta HU NO
  puede tocar `wasiai-facilitator` (directiva explícita). Recomendación del Analyst (DT-5): SPLIT —
  companion ticket separado en `wasiai-facilitator` para relajar el schema, coordinado por el
  orquestador/founder antes de que el Architect cierre el SDD de esta HU (o al menos antes de declarar
  esta HU "e2e-reachable").
- **[NO bloqueante, F2]** Forma exacta del envelope discriminado en `DepositAttestation` (DT-2): mismo
  objeto con `vm` discriminante vs. tipos/funciones separados.
- **[NO bloqueante, F2]** Nombre/contrato exacto de la función Solana en `facilitator-client.ts` (DT-4).
- **[NO bloqueante, F2]** Código/enum HTTP exacto que devuelven los 3 sitios chaski cuando
  `canonicalizeAddress` lanza en rama Solana (mismo shape 400 opaco que hoy, mensaje/enum exacto es F2).
- **[NO bloqueante, F2]** Confirmar si `SolanaPrincipalAuthorization.partialSignedTx` (HU-SOL-5,
  `ports.ts:170-174`) ya trae la `signature`/`reference` base58 en el shape que `facilitator-client.ts`
  necesita reenviar, o si hace falta un paso de extracción intermedio (el Architect debe leer el
  wiring completo de HU-SOL-5 en F2, fuera del alcance de grounding de esta HU).

## Análisis de paralelismo
- **Depende de** (confirmado DONE): HU-SOL-1/WKH-206 (`023`, config multi-VM + `VmAuthorization`),
  HU-SOL-4/WKH-212 (`024`, wallet-adapter-react), HU-SOL-5/WKH-207* (`025`, wallet firma deposit al
  escrow), HU-SOL-6/WKH-205 (facilitator, DONE pero **HELD** — sin merge a `main` del facilitator ni
  deploy a Railway, otro pre-requisito operativo founder-gated para runtime real), HU-SOL-7/WKH-213
  (`026`, `canonicalizeAddress`).
- **Bloqueada por** (hallazgo NUEVO de F0, no listado por el ticket original): HU-SOL-8/WKH-211
  (`027`, F1 en curso) para que el money-path Solana sea seguro de activar en real — HU-SOL-8 declara
  explícitamente en su propio work-item que bloquea a esta HU. El CÓDIGO de esta HU puede construirse
  en paralelo (dark, sin flags), pero NO debería declararse "lista para dinero real" sin HU-SOL-8
  cerrada.
- **Bloquea a**: HU-SOL-13 (release authority / verificación del vault) — consume el binding
  `to === beneficiary` que esta HU define (AC-4).
- **Coordinación de archivo con HU-SOL-8**: ambas tocan `app/api/payout/prepare/route.ts` — HU-SOL-8 la
  sección PR6 (guard PoP), esta HU las secciones PR4/PR7-PR11 (forward + depositAddress + atestación).
  Sin overlap de líneas hoy, pero mismo archivo → coordinar orden de merge con el Architect/orquestador
  antes de F3 de cualquiera de las dos.
- **Bloqueada (a nivel e2e-real, no a nivel de código) por el companion cross-repo** del facilitator
  (Missing Inputs #1) — el código de esta HU puede completarse/mergearse igual, pero no será
  "HTTP-reachable e2e" (mismo lenguaje que usó HU-SOL-6) hasta que ese companion se resuelva.
- Sin overlap de archivos con ninguna otra HU EVM activa (WKH-210/211 ya DONE, sin trabajo en curso
  sobre `wallet.ts`/`confirm-and-send.ts`/`submit/route.ts` fuera del scope PoP de HU-SOL-8).
