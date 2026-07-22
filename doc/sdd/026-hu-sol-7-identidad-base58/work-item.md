# Work Item — [WKH-213][HU-SOL-7] Identidad multi-VM (address base58) — GATE DE SEGURIDAD (IDOR)

## Resumen
HU-SOL-1 (WKH-206, DONE, mergeada) generalizó `chain.ts`/`ports.ts` a multi-VM (`vm: 'evm'|'solana'`)
pero NO tocó ninguno de los sitios de negocio que normalizan/comparan direcciones. F0 confirmó el
hallazgo crítico de la auditoría (CR-2): `.toLowerCase()` es correcto en EVM (checksum case-insensitive)
pero **corrompe base58** (Solana es case-sensitive — dos pubkeys distintas pueden colapsar al mismo
string lowercaseado), lo que abre un **IDOR cross-tenant** (viola el Ownership Guard del CLAUDE.md,
`owner_ref`/`sender_address` filtering con service-key BYPASSRLS) y rompe el KYC-once (una wallet
Solana podría recibir el KYC-once de otra por colisión de canonicalización). Esta HU introduce
canonicalización **VM-aware** en los 15 sitios reales encontrados en F0 y migra el tipo de
`remittance_settlements.chain_id` (hoy `integer`, EVM-only) hacia una identidad de red que también
sirva para Solana (cluster/CAIP-2). GATE DE SEGURIDAD: bloquea HU-SOL-8 (PoP ed25519) y HU-SOL-9
(binding no-custodial Solana).

## Sizing
- SDD_MODE: full
- Estimación: L (money-path + owner-scoping en 9 archivos, gate de seguridad ⇒ AR obligatorio)
- Branch sugerido: feat/024-hu-sol-7-identidad-base58

## Grounding (F0 — archivo:línea verificado, blast-radius real)

**Total: 25 invocaciones de `.toLowerCase()` sobre direcciones/owner/binding en 9 archivos (15
sitios lógicos de comparación/normalización distintos).** Detalle por archivo:

### 1. `src/infrastructure/persistence/supabase-settlement-ledger.ts` (5 invocaciones, 3 sitios) — SERVER-ONLY, BYPASSRLS
- `L104` — `recordOrderPrepared`: `input.senderAddress.toLowerCase()`.
- `L105` — `recordOrderPrepared`: `input.depositAddress.toLowerCase()` (el depositAddress ES el receiver).
- `L134` — `recordPrincipalIn`: `input.senderAddress.toLowerCase()`.
- `L135` — `recordPrincipalIn`: `input.receiverAddress.toLowerCase()`.
- `L163` — `recordPayoutOutcome`: `.eq("sender_address", input.senderAddress.toLowerCase())` — **ÉSTE es
  el guard REAL de ownership (CD-9 del módulo, comentario propio del archivo: "el service key
  bypassea RLS"). Es el sitio más crítico de toda la HU**: si `senderAddress` es una pubkey Solana y se
  lowercasea, dos pagadores Solana distintos con la misma versión-lowercase de su pubkey mutarían la
  MISMA fila — exactamente el IDOR que CR-2 describe.
- Migración asociada: `supabase/migrations/20260716T000000_create_remittance_settlements.sql:9` —
  `chain_id integer not null` (comentario propio: "sender_address ... lowercased — OWNER (AC-9)").
  `integer` no representa una identidad de red Solana (cluster/genesis, no numérica). **PENDING-DEPLOY**
  (aún no aplicada a prod según WKH-207/report.md) — ventana de migración limpia, sin filas EVM que
  reconciliar con un tipo nuevo.

### 2. `src/infrastructure/persistence.ts` (4 invocaciones, 2 sitios) — `LocalRepo` (localStorage, owner-scoping cliente)
- `L119,121` — `list(address)`: `const target = address.toLowerCase()` + `s.ownerAddress.toLowerCase() === target`.
- `L129,132` — `clearByOwner(address)`: mismo patrón (reset WKH-201, purga PII por owner).

### 3. `src/infrastructure/kyc-store.ts` (3 invocaciones, 3 sitios) — `LocalKycStore` (KYC-once)
- `L91` — `get(address)`: `this.read()[address.toLowerCase()]`.
- `L99` — `save(address, kyc)`: `all[address.toLowerCase()] = {...}`.
- `L116` — `clear(address)`: `delete all[address.toLowerCase()]`.
- Es el KYC-once literal que la HU debe preservar: "el mismo AC de reencontrar por la misma wallet"
  depende de que la KEY del Record sea canónica y estable para esa wallet — hoy asume EVM.

### 4. `src/infrastructure/payout/authority.ts` (2 invocaciones, 1 sitio) — autoridad server-side (WKH-180)
- `L83` — `d.vendorData.toLowerCase() !== address.toLowerCase()` — ownership binding Didit
  (`vendor_data` eco del `senderAddress` vs `address` del caller). Comentario propio ya documenta
  "direcciones EVM" — hoy asume EVM explícitamente.

### 5. `app/api/a2a/payout/submit/route.ts` (4 invocaciones, 2 sitios) — gate G3/G5 money-path
- `L143` — PoP (WKH-206): `ch.address.toLowerCase() !== address.toLowerCase()`.
- `L223` — atestación de settlement (WKH-168, guard A7): `att.from.toLowerCase() !== address.toLowerCase()`
  — ata el pagador ON-CHAIN al address KYC-validado. Es el 2º guard más crítico de money-path.

### 6. `app/api/payout/prepare/route.ts` (2 invocaciones, 1 sitio) — WKH-211
- `L127` — PoP (mismo patrón que submit): `ch.address.toLowerCase() !== address.toLowerCase()`.

### 7. `app/api/a2a/payout/challenge/route.ts` (1 invocación, 1 sitio) — emisor del PoP challenge
- `L61` — `const addr = address.toLowerCase()` — normaliza ANTES de emitir el HMAC (`issuePopChallenge`);
  el valor persiste dentro del challenge firmado y se re-compara en `submit`/`prepare` arriba.

### 8. `app/api/settle/principal/route.ts` (2 invocaciones, 1 sitio) — settle real (WKH-168/211)
- `L263` — `expectedNonce.toLowerCase() !== nonce.toLowerCase()` — comparación de un **nonce bytes32**
  (no una address), determinístico (`keccak256(remittanceId:quoteId)`, `wallet.ts:37-39`). Se documenta
  por completitud del grep pero es EVM-only por naturaleza (Solana no tiene este nonce hex ni este
  settle-path — Scope OUT, HU-SOL-9). **NO se generaliza en esta HU** — ver Scope OUT.

### 9. `src/presentation/flow-vm.ts` (2 invocaciones, 1 sitio) — UI, detección de FallbackWallet
- `L28` — `isFallbackWalletAddress()`: `address.toLowerCase() === FALLBACK_WALLET_ADDRESS.toLowerCase()`.
  `FALLBACK_WALLET_ADDRESS` (`wallet.ts:48`) es un literal EVM (`"0xDEMO..."`). La función acepta
  `address: string | null` genérico — si se le pasa una pubkey Solana, hoy la lowercasea igual (no
  rompe nada hoy porque Solana no está wireado en runtime, pero es el mismo patrón defectuoso y debe
  migrar al helper VM-aware para no quedar como el 16º sitio "olvidado").

### Grounding negativo (verificado, NO tienen `.toLowerCase()` sobre address/owner)
`settlement/attestation.ts`, `settlement/deposit-attestation.ts`, `auth/pop-challenge.ts` (el verify,
solo el issuer en challenge/route.ts normaliza), `settlement/onchain-verifier.ts`,
`infrastructure/a2a/gateways.ts`, `infrastructure/fallback/gateways.ts`, `composition/container.ts`,
`infrastructure/kyc-auth.ts`, `infrastructure/kyc-pending-store.ts`,
`infrastructure/webhooks/{webhook-event-store,transfi-hmac}.ts`, `infrastructure/auth/http-pop-signer.ts`,
`infrastructure/settlement/{http-payout-prepare-gateway,http-settlement-gateway}.ts`,
`infrastructure/payout/payout-authority-gateway.ts`, `infrastructure/didit/{decision,kyc-gateway}.ts`,
`app/api/{kyc/session,kyc/decision,payout/validate,admin/reconcile-orphans}/route.ts`,
`application/use-cases/{connect-wallet,forget-kyc,list-history}.ts` — estos delegan el canonicalizado
a `kyc-store.ts`/`persistence.ts` (ya contados arriba), no lo re-implementan.

### Patrón del Ownership Guard (CLAUDE.md) confirmado en este repo
Aunque `chaski-v2` no usa la tabla `a2a_agent_keys` de `wasiai-a2a`, el MISMO patrón (service-key
BYPASSRLS ⇒ el guard real es el filtro app-layer `.eq(<owner_col>, <caller>)`) está documentado
literalmente en `supabase-settlement-ledger.ts:4-6` y aplicado en `recordPayoutOutcome` (`L163`, sitio
#1 de esta lista). El fix de esta HU es el equivalente Solana de ese mismo guardrail.

## Acceptance Criteria (EARS)

- **AC-1 (canonicalización VM-aware, CENTRAL):** the system SHALL exponer una función única
  `canonicalizeAddress(address: string, vm: 'evm' | 'solana')` (helper nuevo, ubicación a decidir en
  F2) que, WHEN `vm === 'evm'`, normaliza con `.toLowerCase()` (comportamiento actual byte-idéntico) y,
  WHEN `vm === 'solana'`, SHALL preservar el casing exacto del base58 (NUNCA `.toLowerCase()`) —
  validando el formato con `PublicKey` de `@solana/web3.js` (mismo patrón que
  `resolveSolanaUsdcMint`, `chain.ts:135-143`).

- **AC-2 (no-colisión, CENTRAL):** WHEN se canonicalizan dos pubkeys base58 Solana que difieren SOLO en
  case, the system SHALL producir dos valores canónicos DISTINTOS (nunca deben colapsar al mismo
  string) — verificado con un test explícito que instancie dos pubkeys Solana válidas de distinto
  casing y confirme `canonicalizeAddress(a, 'solana') !== canonicalizeAddress(b, 'solana')` cuando
  `a !== b`.

- **AC-3 (owner-scoping aísla cross-tenant):** WHEN `SupabaseSettlementLedger.recordPayoutOutcome`
  (`supabase-settlement-ledger.ts:159-164`, el guard CD-9 real) filtra por `sender_address`, the system
  SHALL canonicalizar `senderAddress` con la variante correcta de `vm` ANTES del `.eq(...)` — de forma
  que un owner Solana NUNCA pueda leer/mutar la fila de otro owner Solana por colisión de
  canonicalización (mismo invariante que ya protege a los owners EVM hoy).

- **AC-4 (KYC-once reencuentra la misma wallet):** WHEN `LocalKycStore.get/save/clear` (`kyc-store.ts`)
  opera sobre una wallet Solana, the system SHALL usar SIEMPRE la MISMA clave canónica para esa wallet
  en las tres operaciones — de forma que un `save(address)` seguido de un `get(address)` con el MISMO
  casing SIEMPRE encuentre la entry (round-trip íntegro), y un `get` con OTRA pubkey (aunque comparta
  prefijo/sufijo) SIEMPRE devuelva `null`.

- **AC-5 (EVM byte-idéntico, OBLIGATORIO):** WHILE la VM activa es `evm`, the system SHALL producir el
  mismo comportamiento observable que hoy en los 9 archivos de Scope IN — la suite de tests existente
  (incluyendo `chain.test.ts` y cualquier test de `kyc-store.ts`/`persistence.ts`/`authority.ts`/las
  routes de `submit`/`prepare`/`challenge`/`settle/principal`) SHALL pasar SIN cambios de expectativa.

- **AC-6 (unwanted — VM ambigua o address malformada):** IF `canonicalizeAddress` recibe un `vm`
  distinto de `'evm'`/`'solana'`, O una address que no valida contra el formato de esa VM (ni
  `isAddress` de viem para EVM ni `PublicKey` para Solana), THEN the system SHALL fallar fail-loud
  (throw) — NUNCA devolver la address sin normalizar ni un canónico silenciosamente incorrecto.

- **AC-7 (single-source, sin duplicación):** the system SHALL reemplazar los 25 usos directos de
  `.toLowerCase()` sobre address/owner listados en el Grounding (los 15 sitios lógicos, EXCLUYENDO el
  nonce bytes32 de `settle/principal/route.ts:263`, ver Scope OUT) por una llamada a
  `canonicalizeAddress(address, vm)` — PROHIBIDO que quede un `.toLowerCase()` crudo sobre una address
  en ninguno de esos 9 archivos tras esta HU.

- **AC-8 (migración chain_id → identidad de red):** the system SHALL migrar (aditivamente, sin romper
  el guard-order ni las filas EVM) la columna `remittance_settlements.chain_id` (hoy `integer not
  null`, EVM-only) hacia un shape que TAMBIÉN represente una red Solana (cluster/CAIP-2) — el
  Architect decide en F2 la estrategia exacta (columna nueva vs generalización del tipo, ver DT-3) y
  DEBE marcar la migración `-- PENDING-DEPLOY` (mismo patrón que las 2 migraciones existentes del
  repo) porque la aplica el founder, no el pipeline.

- **AC-9 (unwanted — nonce EVM no se toca):** WHILE `settle/principal/route.ts:263` compara un nonce
  `bytes32` determinístico (`keccak256(remittanceId:quoteId)`), the system SHALL dejarlo intacto (SIN
  generalizar a `canonicalizeAddress`) — no es una address, es un valor hex EVM-only y su settle-path
  completo es Scope OUT de esta HU (HU-SOL-9).

## Scope IN
- `src/infrastructure/persistence/supabase-settlement-ledger.ts:104,105,134,135,163` — canonicalizar
  `senderAddress`/`receiverAddress`/`depositAddress` con `vm` (el `chainId` numérico de la fila hoy
  determina implícitamente `vm`; el Architect define en F2 cómo se resuelve/propaga `vm` en este
  módulo server-only).
- `supabase/migrations/` — nueva migración (AC-8), aditiva, `-- PENDING-DEPLOY`.
- `src/infrastructure/persistence.ts:119,121,129,132` (`LocalRepo.list`/`clearByOwner`).
- `src/infrastructure/kyc-store.ts:91,99,116` (`LocalKycStore.get`/`save`/`clear`).
- `src/infrastructure/payout/authority.ts:83` (`resolvePayoutAuthority`, ownership binding Didit).
- `app/api/a2a/payout/submit/route.ts:143,223` (PoP + atestación de settlement, guards P3/A7).
- `app/api/payout/prepare/route.ts:127` (PoP, guard equivalente a P3).
- `app/api/a2a/payout/challenge/route.ts:61` (emisor del PoP, normaliza antes de firmar el HMAC).
- `src/presentation/flow-vm.ts:28` (`isFallbackWalletAddress`, UI).
- Helper nuevo: `canonicalizeAddress(address, vm)` — ubicación exacta (`src/infrastructure/chain.ts`
  vs módulo nuevo `src/infrastructure/address.ts`) a decidir en F2 (DT-2).
- Tests nuevos: AC-2 (no-colisión Solana), AC-4 (KYC-once round-trip Solana), AC-6 (fail-loud VM
  desconocida/address malformada) — como mínimo en `kyc-store.test.ts`, `persistence.test.ts`, y un
  test nuevo del helper.

## Scope OUT (explícito)
- **PoP (proof-of-possession) ed25519 para Solana** — HU-SOL-8. Esta HU NO implementa firma/verify
  ed25519; solo asegura que la CANONICALIZACIÓN de la address que el PoP EVM ya usa (`submit`,
  `prepare`, `challenge`) sea VM-aware para cuando HU-SOL-8 la reutilice.
- **Binding no-custodial Solana / settle real** — HU-SOL-9. `settle/principal/route.ts` en su
  totalidad (broadcast/verify/attest EVM) queda intacto salvo el guard puntual de AC-9 (que
  explícitamente NO se toca).
- **El nonce bytes32 de `settle/principal/route.ts:263`** — EVM-only por naturaleza (ver AC-9).
- **Wallet Solana / conexión / firma SPL** — HU-SOL-2 (ya scopeada fuera desde HU-SOL-1).
- **Cualquier flag que active comportamiento Solana runtime en un ambiente compartido** — esta HU es
  refactor de canonicalización + tipos/migración; ningún deploy existente cambia de comportamiento
  (AC-5 lo garantiza para EVM, y Solana no está wireado en runtime todavía).
- **Aplicar la migración a prod** — la ejecuta el founder (acción gated, mismo patrón que las 2
  migraciones existentes del repo).

## Decisiones técnicas (DT-N)
- **DT-1**: el helper Solana NO es una identidad pura — se recomienda `new PublicKey(raw).toBase58()`
  (no solo un passthrough) para validar formato Y normalizar a la codificación base58 canónica de esos
  32 bytes en el mismo paso (mismo patrón fail-loud que `resolveSolanaUsdcMint`, `chain.ts:138-142`).
  El Architect confirma en F2 si el passthrough simple basta (base58 no tiene múltiples encodings
  válidos para los mismos bytes, a diferencia del checksum mixed-case de EVM) o si el round-trip vía
  `PublicKey` es el criterio (recomendado, por consistencia con el resto del repo).
- **DT-2**: ubicación del helper — `chain.ts` (ya tiene `resolveActiveVm`, cohesión con el resto de
  los resolvers multi-VM) vs un módulo nuevo `src/infrastructure/address.ts` (separa la concern de
  "canonicalización" de "config de red"). El Architect decide en F2; cualquiera de las dos preserva
  AC-1/AC-7.
- **DT-3 (la más delicada, requiere decisión del founder)**: estrategia de migración de `chain_id`
  (AC-8). Opciones: (A) mantener `chain_id integer` EVM-only + agregar `network_id text null`
  (Solana, valor tipo cluster/genesis) con un `CHECK` que exija exactamente uno de los dos según una
  columna `vm` nueva; (B) generalizar `chain_id` de `integer` a `text` con valores CAIP-2
  (`"eip155:8453"` / `"solana:<genesis-hash-corto>"`) — más "correcto" como estándar pero exige tocar
  TODOS los call-sites que hoy leen/escriben `chain_id` como `number` (`chainId: number` en
  `NetworkConfig`, `resolveChainId()`, comparaciones `att.chainId !== resolveChainId()` en 3 guards de
  money-path). Recomendación del Analyst: Opción A (aditiva, cero riesgo sobre el money-path EVM
  existente, migración PENDING-DEPLOY sin filas que reconciliar) — el Architect debe confirmar con
  este criterio conservador dado el gate de seguridad.
- **DT-4**: `vm` en `supabase-settlement-ledger.ts` — hoy el módulo no recibe ni persiste `vm`
  explícitamente (solo `chainId: number`). El Architect decide en F2 cómo se resuelve `vm` en este
  contexto server-only para poder llamar `canonicalizeAddress(address, vm)` (opciones: inferir de
  `chainId` con una tabla de lookup, o agregar `vm` como parámetro explícito de cada método del
  `SettlementLedger` — más verboso pero sin inferencia implícita, más alineado con CD-5).

## Constraint Directives (CD-N)
- **CD-1 (OBLIGATORIO, la más crítica)**: PROHIBIDO dejar cualquier `.toLowerCase()` crudo sobre una
  address/owner en los 9 archivos de Scope IN tras esta HU — TODOS pasan por
  `canonicalizeAddress(address, vm)`. Si un CR encuentra un `.toLowerCase()` residual sobre una
  address en esos archivos, es BLOQUEANTE.
- **CD-2 (OBLIGATORIO)**: EVM byte-idéntico — la variante `evm` de `canonicalizeAddress` DEBE producir
  EXACTAMENTE el mismo string que `address.toLowerCase()` produce hoy. Ningún test EVM existente
  cambia su expectativa (AC-5). Si un test EVM necesita cambiar para que esta HU compile, es señal de
  diseño incorrecto — parar y escalar.
- **CD-3**: PROHIBIDO usar `.toLowerCase()` para "normalizar" una pubkey Solana en NINGÚN sitio nuevo
  ni existente — es el bug central que esta HU cierra (CR-2). Y viceversa: PROHIBIDO comparar
  addresses EVM con `===` sin normalizar primero (perdería el case-insensitive real de EVM).
- **CD-4**: PROHIBIDO inferir la VM de una address por su SHAPE (ej. "empieza con 0x → EVM"). El `vm`
  SIEMPRE viaja explícito (parámetro, columna de DB, o `resolveActiveVm()` en el único punto donde hoy
  hay una sola VM activa por deployment) — nunca heurística sobre el string. Un caller hostil podría
  mandar una pubkey Solana que "parece" empezar distinto y forzar una rama equivocada.
- **CD-5**: el guard de ownership de `recordPayoutOutcome` (`supabase-settlement-ledger.ts:159-164`,
  CD-9 preexistente del módulo) NUNCA se debilita — sigue siendo un `.eq("sender_address", ...)`
  server-side, ahora sobre el valor YA canonicalizado correctamente. Ningún cambio de esta HU relaja
  ese guard ni lo hace condicional.
- **CD-6**: la migración de `chain_id` (AC-8/DT-3) es ADITIVA — ninguna columna EVM existente
  (`chain_id integer`) cambia de tipo sin coordinación explícita del Architect + founder (dado que
  DT-3 recomienda la Opción A aditiva). PROHIBIDO un `ALTER COLUMN ... TYPE` destructivo sin migración
  de datos explícita si se elige la Opción B.
- **CD-7**: `npm run typecheck` (`tsc --noEmit` completo, no solo `npm run build`) OBLIGATORIO antes de
  considerar la HU lista — mismo criterio que HU-SOL-1 (lección WKH-196, precision-loss solo visible
  con `tsc --noEmit` sobre tests).
- **CD-8**: PROHIBIDO tocar la lógica de negocio de `authority.ts`, `submit/route.ts`, `prepare/route.ts`
  más allá del reemplazo puntual de `.toLowerCase()` → `canonicalizeAddress(...)` — el guard-order
  completo (money-path WKH-168/202/206/207/209/211) queda intacto; ningún guard se reordena, elimina
  ni cambia de status HTTP.
- **CD-9 (test obligatorio, AR lo exige)**: al menos un test IDOR explícito por sitio crítico
  (`recordPayoutOutcome`, `kyc-store.get/save/clear`, el guard PoP de `submit`) que pruebe que DOS
  pubkeys Solana que solo difieren en case NO colisionan — el Adversarial Review de esta HU (gate de
  seguridad) debe poder ejecutar el ataque descrito en CR-2 y verlo FALLAR.

## Missing Inputs
- `[NEEDS CLARIFICATION]` BLOQUEANTE para F2 (DT-3) — estrategia exacta de migración de `chain_id`:
  Opción A (aditiva, `network_id` nueva columna, recomendada) vs Opción B (generalizar `chain_id` a
  CAIP-2 text). Impacta 3+ guards de money-path que comparan `chainId: number` — requiere confirmación
  explícita del founder antes de que el Architect cierre el SDD (dado que WKH-207/DT-3 ya estableció
  el precedente de escalar decisiones de schema al founder).
- `[NEEDS CLARIFICATION]` NO bloqueante — ubicación exacta del helper `canonicalizeAddress` (DT-2,
  `chain.ts` vs módulo nuevo). El Architect puede decidir en F2 sin gate humano.
- `[NEEDS CLARIFICATION]` NO bloqueante — si `canonicalizeAddress` normaliza Solana con passthrough
  simple o round-trip `PublicKey.toBase58()` (DT-1). Recomendación del Analyst: round-trip (más
  consistente con el resto del repo), el Architect confirma.
- `[resuelto en F2]` — cómo se resuelve `vm` dentro de `supabase-settlement-ledger.ts` (DT-4, hoy el
  módulo no lo recibe) — el Architect decide entre inferencia por `chainId`/lookup vs parámetro
  explícito nuevo en cada método del `SettlementLedger`.

## Análisis de paralelismo
- Esta HU es GATE DE SEGURIDAD: bloquea HU-SOL-8 (PoP ed25519) y HU-SOL-9 (binding no-custodial
  Solana) — ninguna de las dos puede asumir una canonicalización de address confiable hasta que ésta
  esté en `main`.
- Overlap de archivos ALTO con cualquier HU futura de money-path EVM que toque
  `supabase-settlement-ledger.ts`, `authority.ts`, `submit/route.ts`, `prepare/route.ts` o
  `challenge/route.ts` — son los mismos 5 archivos de más alto riesgo ya señalados por WKH-210/211/207
  en `_INDEX.md`. Coordinar orden de merge si corre en paralelo con cualquier HU que toque esos
  archivos (ninguna conocida activa al momento de este F1).
- Sin overlap con HU-SOL-1 (ya mergeada) — esta HU consume su output (`resolveActiveVm`,
  `resolveSolanaUsdcMint`, `VmNetworkConfig`) pero no reabre `chain.ts` salvo posiblemente para alojar
  el helper nuevo (DT-2).
- La migración SQL (AC-8) puede prepararse en paralelo al resto del código (es un archivo nuevo,
  aditivo, sin dependencias de otros cambios de esta HU) pero el founder debe aplicarla ANTES de que
  cualquier código que dependa del nuevo shape de `chain_id`/`network_id` llegue a runtime real —
  mismo patrón gated que las 2 migraciones existentes.
