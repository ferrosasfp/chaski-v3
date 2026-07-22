# SDD — [HU-SOL-5 / WKH-207*] chaski-v3: wallet Solana firma el `deposit` al escrow (SPL, gasless-facilitator)

> SPEC_APPROVED: no
> Fase F2 (NexusAgil QUALITY). Input: `work-item.md` (aprobado, HU_APPROVED) + `024/sdd.md` (HU-SOL-4,
> SDD aprobado — se diseña ENCIMA de él). Repo: `/home/ferdev/.openclaw/workspace/chaski-v3`
> (Next.js App Router, arquitectura hexagonal). SDD_MODE: full. Estimación: L.
> Branch sugerido: `feat/025-hu-sol-5-wallet-deposit-escrow`. Artefactos: `doc/sdd/025-hu-sol-5-wallet-deposit-escrow/`.
> *Numeración: WKH-207 es reuso cross-programa (el ticket Jira `WKH-207` ya está DONE para otra HU —
> `_INDEX.md` fila 24). El programa Solana LATAM Labs usa `HU-SOL-N` propio. NNN=`025` confirmado sin colisión.

---

## 0. Resolución de los `[NEEDS CLARIFICATION]` / Missing Inputs del work-item (CERRADOS en F2)

Steers del orquestador — cerrados acá como decisiones firmes. Los 6 Missing Inputs del work-item quedan resueltos.

| # (work-item) | Pregunta abierta | **Decisión F2 (firme)** | Justificación |
|---|---|---|---|
| MI-1 (BLQ) DT-5-source | Cómo se resuelven `beneficiary`/`authority` Pubkey | **El CALLER los provee YA resueltos.** Se EXTIENDE el 3er arg `deposit?` de `authorizePrincipal` con un slot Solana `escrow?: { beneficiary, authority, mint? }` (base58). La capa de negocio que los resuelve (mapeo TransFi→Solana / identidad del facilitator) es **HU-SOL-13 (Scope OUT)**. Mismo patrón aditivo que WKH-211 usó para inyectar `deposit.address` (fail-loud sin él). Ver **DT-SDD-1**. | Recomendación del Analyst (opción a). Mantiene el port como único contrato wallet, sin inventar un beneficiary/authority default (CD-8). |
| MI-2 (BLQ) dispatch por VM | ¿`pickWallet()` vs `container.ts`? | **NO se toca el dispatch — es de HU-SOL-4.** El dispatch multi-VM vive en `container.ts` (`resolveActiveVm()==="solana" ? new SolanaWalletAdapter() : pickWallet()`, DT-SDD-2 de HU-SOL-4). Esta HU **SOLO agrega `authorizePrincipal()` real** al `SolanaWalletAdapter` que HU-SOL-4 ya diseñó. `pickWallet()` permanece EVM-only y byte-idéntico. Ver **DT-SDD-2**. | Instrucción explícita del orquestador. Elimina la tensión de MI-2: el "dispatch por VM" del work-item es el comportamiento OBSERVABLE del conjunto `container.ts`+`SolanaWalletAdapter`, no un cambio a `pickWallet()`. Cero colisión con HU-SOL-4 en el dispatch. |
| MI-3 (BLQ) return de `WalletPort` | ¿extender `WalletPort` o crear port nuevo? | **Se EXTIENDE `WalletPort.authorizePrincipal` de forma ADITIVA** (return gana `solana?`, param gana `escrow?`). Es el "estrictamente necesario" que la CD-4 de HU-SOL-4 anticipó. Los adapters EVM (`wallet.ts`) y los fakes quedan **byte-idénticos** por método-bivarianza + covarianza de retorno (§DT-SDD-3, verificado en §3.1). Ver **DT-SDD-3**. | Un port nuevo duplicaría la interfaz wallet y forzaría un 2º dispatch. El widening aditivo NO rompe ningún consumidor (a diferencia de WKH-211, que agregó un arg y rompió tests: acá TODO lo nuevo es OPCIONAL). |
| MI-4 (no-blq) Jira WKH-207 dup | colisión de identificador | Reuso intencional cross-programa (igual que HU-SOL-1/WKH-206). NNN=`025` sin colisión. No afecta diseño. | Documentado. |
| MI-5 (no-blq) `@coral-xyz/anchor` | dep nueva para construir la ix desde el IDL | **SÍ: `@coral-xyz/anchor@0.30.1` PINNEADA — VERIFICADA que resuelve limpio** (`npm install --dry-run`, exit 0; depende de `@solana/web3.js@^1.68.0` **v1** + `@coral-xyz/borsh` + `bn.js`, SIN conflicto con Kit v2). Coordinada con HU-SOL-25. Se **lazy-importa** en `authorizePrincipal` → NO entra al bundle EVM. **Fallback documentado si post-merge de HU-SOL-4 anchor deja de resolver: armado MANUAL de la ix con `@solana/web3.js` (`TransactionInstruction` + discriminador del IDL + borsh).** Ver **DT-SDD-6/DT-SDD-8**. | El `escrow.json` es IDL Anchor 0.30 → requiere anchor ≥0.30. |
| MI-5b (steer orquestador) | `@solana/pay` para el `reference` | **NO se usa `@solana/pay`** (peer-conflict IRRECONCILIABLE: `@solana/pay@1.x` exige Kit v2 `@solana/kit@^6`, pero el árbol pinea Kit v1 `5.5.1` vía walletconnect→reown→coinbase). El `reference` es sólo un Pubkey único → se genera MANUALMENTE con `@solana/web3.js` (ya presente) y se agrega como cuenta read-only/non-signer. Ver **DT-SDD-5** + **CD-SDD-13**. | Evita el conflicto de raíz + una dep menos. Hallazgo del F3 de HU-SOL-4. |
| MI-6 (no-blq) rent vs gasless | el `deposit` crea `escrow_state`+`vault` con `payer=sender` | **CAVEAT documentado, NO resuelto acá** (§9). El gasless (HU-SOL-14) sólo cubre el fee de red (feePayer); el rent-exemption de las 2 cuentas lo paga el `sender` en SOL. Un sender con 0 SOL no puede depositar. Se documenta para HU-SOL-13/14. | El `payer=sender` está fijado en el programa (HU-SOL-12 DONE, inmutable, CD-5). Fuera de scope. |

**Cero `[NEEDS CLARIFICATION]` quedan abiertos.** Ver §12 Readiness Check.

---

## 1. Resumen

`SolanaWalletAdapter.authorizePrincipal()` (hoy demo-simbólico en HU-SOL-4) pasa a construir la
instrucción **`deposit`** del programa escrow Anchor (IDL `escrow.json`, program id
`BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA`, devnet) usando **`@coral-xyz/anchor`** desde el IDL
real, con:
- args canónicos: `remittance_id: [u8;16]` (derivado determinísticamente del `remittanceId`),
  `beneficiary`/`authority` (base58, provistos por el caller vía `deposit.escrow`), `amount: u64`
  (`String(quote.send.minor)`, sin floats), `deadline: i64` (`floor(Date.parse(quote.expiresAt)/1000)`);
- accounts del IDL (`sender`, `mint`, `escrow_state` PDA, `vault` ATA, `sender_ata`, `token_program`,
  `associated_token_program`, `system_program`);
- la **`reference` de Solana Pay** (un Pubkey único generado con `@solana/web3.js` — **NO** `@solana/pay`,
  ver DT-SDD-5/CD-SDD-13) como cuenta extra **no-signer/no-writable** (`remainingAccounts`), sin tocar los
  accounts del IDL;
- `feePayer` = Pubkey del facilitator (env `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`, resolver nuevo);
- **partial-sign SÓLO con la wallet conectada** (vía el bridge de HU-SOL-4) — **NUNCA** con clave del
  facilitator, **NUNCA** `sendTransaction`/`sendRawTransaction`;
- return: variante Solana ADITIVA del retorno de `WalletPort.authorizePrincipal` → `solana: { vm:"solana",
  partialSignedTx (base64), reference (base58) }`. El gateway (HU-SOL-14, Scope OUT) la manda al
  facilitator; esta HU **define la forma de salida** y NO auto-envía.

**Restricción dura (AC-5/CD-4):** el path EVM (`wallet.ts`, `pickWallet()`, EIP-3009, dispatch de
`container.ts`) queda **byte-idéntico** — el widening de `WalletPort` es 100% ADITIVO (todo lo nuevo es
opcional). Esta HU **NO** implementa el broadcast gasless real (HU-SOL-14), la verificación server-side
del vault (HU-SOL-13), ni resuelve `beneficiary`/`authority` (HU-SOL-13).

**DEPENDENCIA F3 (dura):** el F3 de esta HU **NO arranca hasta que HU-SOL-4 (`024`) mergee a main** —
necesita el `SolanaWalletAdapter` + el `solana-wallet-bridge.ts` + las deps `@solana/spl-token`/
`@solana/wallet-adapter-*`. Ver §8 y §10.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 025 (HU-SOL-5 / WKH-207*) |
| **Tipo** | feature |
| **SDD_MODE** | full · **Estimación** L |
| **Objetivo** | Que la wallet Solana conectada firme (partial-sign) la ix `deposit` al vault del escrow, con `reference` Solana Pay y feePayer=facilitator, y entregue la tx serializada para el facilitator — sin auto-broadcast y sin perturbar EVM. |
| **Reglas de negocio** | AC-5 regresión-cero EVM (hard); deposit SIEMPRE al vault del escrow, nunca a un address TransFi (CD-3); feePayer=facilitator + partial-sign wallet-only (AC-2); NUNCA auto-broadcast (AC-3/CD-1/CD-2); `reference` como remainingAccount no-signer (AC-4); `amount`/`deadline` canónicos sin floats (AC-8/CD-7); fail-loud sin wallet (AC-7) y sin `beneficiary`/`authority` (CD-8); program id/mint/facilitator env-driven (CD-6); IDL/programa inmutables (CD-5). |
| **Scope IN** | `SolanaWalletAdapter.authorizePrincipal()` real (deposit-ix builder vía anchor); widening aditivo de `WalletPort` (tipos `SolanaEscrowDeposit`/`SolanaPrincipalAuthorization`); resolver `resolveSolanaFacilitatorPubkey()`; dep `@coral-xyz/anchor` pinneada; tests del adapter. |
| **Scope OUT** | Broadcast gasless real (HU-SOL-14); verificación server-side del vault (HU-SOL-13); resolución de negocio de `beneficiary`/`authority` (HU-SOL-13); PoP ed25519 (HU-SOL-8); `connect()`/`getAddress()`/bridge/`pickWallet()`/dispatch de container (HU-SOL-4); cerrar `[TBD HU-SOL-2]` de `SolanaAuthorization`; mainnet-beta; el programa escrow (`solana-programs/`, HU-SOL-12 DONE, repo externo). |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1**: WHEN VM=solana y el usuario confirma el envío del principal, THE system SHALL construir vía
  `SolanaWalletAdapter` la ix `deposit` (IDL HU-SOL-12, program id `BBQ9…79WA`) con los args
  `remittance_id`/`beneficiary`/`authority`/`amount`/`deadline` y los accounts exigidos por el IDL.
- **AC-2**: WHEN se arma la tx, THE system SHALL fijar `feePayer` a la Pubkey del facilitator (env-driven)
  Y firmarla ÚNICAMENTE con la wallet Solana conectada (partial-sign) — NUNCA con clave del facilitator.
- **AC-3**: IF la tx fue partial-signed, THEN THE system SHALL NUNCA transmitirla a la red
  (`sendTransaction`/`sendRawTransaction`) — la entrega serializada para el facilitator (HU-SOL-14).
- **AC-4**: WHEN se arma la ix, THE system SHALL incluir la `reference` de Solana Pay como cuenta extra
  no-signer/no-writable (`remainingAccounts`), SIN alterar los accounts del IDL.
- **AC-5**: WHILE VM=EVM (`resolveActiveVm() !== "solana"`), THE system SHALL mantener `pickWallet()`,
  `InjectedWallet`, `WalletConnectWallet`, `FallbackWallet` y EIP-3009 byte-idénticos — cero regresión.
- **AC-6**: WHEN `resolveActiveVm() === "solana"`, THE system SHALL despachar hacia `SolanaWalletAdapter`
  (mecanismo = dispatch en `container.ts` de HU-SOL-4; esta HU aporta el `authorizePrincipal` real).
- **AC-7**: IF no hay wallet Solana conectada (`getAddress()` → `null`) al armar el deposit, THEN THE
  system SHALL fallar fail-loud (throw) sin construir ni firmar una tx parcial.
- **AC-8**: THE system SHALL derivar `amount`/`deadline` de datos canónicos (`Money.minor` /
  `quote.expiresAt` en unix seconds), sin floats (mismo criterio CD-16 de WKH-168).

---

## 3. Context Map (Codebase Grounding)

**Baseline verificado**: `npm run qa` (typecheck `tsc --noEmit` + `vitest run`) = **exit 0, 48 files /
562 tests passed**. Los `stderr` (`[ledger] recordPrincipalIn_failed Error: db down`, etc.) son
`console.error` deliberados de ramas best-effort (WKH-207 CD-17), no fallos. El SDD parte de verde.

### 3.1 Archivos leídos (verificados con Read)

| Archivo | Por qué | Patrón extraído / hallazgo |
|---------|---------|----------------------------|
| `src/application/ports.ts:118-235` | `WalletPort.authorizePrincipal` (L224-231) + `VmAuthorization`/`SolanaAuthorization` (L134-159, HU-SOL-1). **Se EXTIENDE (aditivo).** | Return hoy `{ tx; eip3009? }`. `SolanaAuthorization` (L150-157) ya tiene `vm:"solana"` + campos base58 (placeholder). El slot Solana del return se alinea con ese envelope. El widening agrega `escrow?` al param y `solana?` al return — ambos OPCIONALES. |
| `src/infrastructure/wallet.ts:1-331` | **Exemplar del adapter EVM + del lazy-import.** **CD-4: byte-idéntico.** | (a) `authorizePrincipal(quote, remittanceId, deposit?: { address })` con `deposit.address` REQUERIDO (`isAddress` L100); (b) fail-loud `deposit_address_missing` (L100) = espejo para `beneficiary`/`authority` (CD-8); (c) `deterministicNonce` (L42-44, `keccak256`) = patrón para derivar `remittance_id`/`reference` determinísticos; (d) **lazy-import `await import("@walletconnect/…")` (L200)** = patrón para lazy-importar anchor/spl-token (§DT-SDD-8); (e) `BigInt(quote.send.minor)`/`String(quote.send.minor)` (L104,137) + `isParseableIso(quote.expiresAt)` (L103) = canónicos sin floats (AC-8). |
| `src/infrastructure/chain.ts:98-164` | Resolvers Solana (HU-SOL-1). **Se AGREGA un resolver (aditivo).** | `resolveSolanaUsdcMint()` (L135-144, valida con `new PublicKey()`, NUNCA `isAddress`); `resolveSolanaNetworkConfig()` (L129-131, `{cluster:"devnet"}`); `resolveSolanaRpcUrl()` (L147-152, **server-only** → undefined en browser). `resolveSolanaFacilitatorPubkey()` copia el patrón fail-loud de `resolveSolanaUsdcMint`. |
| `src/composition/container.ts:1-134` | Dispatch de wallet (**de HU-SOL-4, NO se toca**). | HU-SOL-4 introduce `resolveActiveVm()==="solana" ? new SolanaWalletAdapter() : pickWallet()`. Esta HU no lo modifica: sólo el adapter que ya instancia. |
| `src/application/use-cases/confirm-and-send.ts:182` | Consumidor de `authorizePrincipal`: `const { tx, eip3009 } = await this.wallet.authorizePrincipal(quote, s.id, deposit)`. **NO se toca** (money-path EVM, byte-idéntico). | El destructuring `{ tx, eip3009 }` sigue válido con el return widened (ignora `solana?`). El wiring del gateway Solana→facilitator es HU-SOL-13/14 (Scope OUT). |
| `src/infrastructure/settlement/facilitator-client.ts:1-143` | **Exemplar del patrón "cliente firma, facilitator transmite" (CD-20).** | Único archivo que conoce el facilitador y hace el POST `/settle`; NUNCA la wallet transmite. El equivalente Solana (POST de la tx serializada) es **HU-SOL-14** — esta HU sólo produce el payload (`solana.partialSignedTx`) que HU-SOL-14 consumirá. NO se crea cliente Solana acá. |
| `src/test-support/fakes.ts:253-275` | `FakeWallet implements WalletPort`. **Byte-idéntico (verificado).** | Param `_deposit?: { address }`, return `{ tx; eip3009? }`. Con el widening aditivo: método-bivarianza (param) + covarianza (return) ⇒ sigue satisfaciendo `WalletPort` **sin cambios**. |
| `src/infrastructure/wallet.test.ts:1-491` | **Exemplar del test del adapter** + guardián de AC-5. | `describe`/`it` por AC; fakes inyectados; asserts por campo concreto. 20+ tests EIP-3009 quedan byte-idénticos (el widening es aditivo, NO agrega args requeridos — a diferencia de WKH-211, ver Auto-Blindaje §3.3). |
| `solana-programs/target/idl/escrow.json` | **IDL real del programa** (leído íntegro). | Ix `deposit` (L174-355): discriminator `[242,35,198,137,82,225,242,182]`; args `remittance_id:[u8;16]`, `beneficiary:pubkey`, `authority:pubkey`, `amount:u64`, `deadline:i64`; accounts `sender(signer,mut)`, `mint`, `escrow_state`(PDA seeds `[b"escrow"(101,115,99,114,111,119), sender, remittance_id]`), `vault`(ATA PDA, owner=escrow_state), `sender_ata(mut)`, `token_program`, `associated_token_program`, `system_program`. **NO declara ningún account `reference`** (AC-4 → remainingAccount). Errores: `ZeroAmount(6000)`, `InvalidDeadline(6001)`. `EscrowState` guarda `sender/beneficiary/authority/mint/amount/deadline/status/bump`. |
| `doc/sdd/024-hu-sol-4-wallet-adapter/sdd.md` (íntegro) | **El SDD encima del cual se diseña.** | `SolanaWalletAdapter implements WalletPort` (`src/infrastructure/solana-wallet.ts`, React-free); `connect()`/`getAddress()` reales vía `solana-wallet-bridge.ts` (singleton que cachea `{publicKey,connected}` + `openModal` + `waitForConnection`); `authorizePrincipal`/`signMessage` **demo-simbólicos** (DT-SDD-6 de HU-SOL-4) — **esta HU reemplaza el `authorizePrincipal` demo por el real**. Deps de HU-SOL-4: `@solana/spl-token`+`@solana/wallet-adapter-*` pinneadas (`@solana/pay` **descartado por el F3 de HU-SOL-4** por el peer-conflict Kit v2 — esta HU tampoco lo usa, CD-SDD-13). Regla del seam: el adapter NO importa `@solana/wallet-adapter-*`. Esta HU depende de `@solana/spl-token` (ATAs) que HU-SOL-4 aporta. |
| `package.json:17-48` | Deps. | `@solana/web3.js@^1.98.4` presente. `@coral-xyz/anchor` **AUSENTE** (se agrega pinneada). `@solana/spl-token` lo agrega HU-SOL-4. `@walletconnect/ethereum-provider` = precedente de lazy-import de lib pesada. |

### 3.2 Exemplars (verificados con Read → existen)

| Para crear/modificar | Seguir patrón de | Qué se copia |
|----------------------|------------------|--------------|
| `SolanaWalletAdapter.authorizePrincipal()` (real) en `src/infrastructure/solana-wallet.ts` | `wallet.ts:84-151` (`InjectedWallet.authorizePrincipal`) | Guard fail-loud pre-firma (wallet conectada + inputs), derivación determinística (`deterministicNonce`), canónicos sin floats, `await import()` lazy de la lib pesada (`wallet.ts:200`). |
| `resolveSolanaFacilitatorPubkey()` en `src/infrastructure/chain.ts` | `chain.ts:135-144` (`resolveSolanaUsdcMint`) | Env-driven, valida con `new PublicKey()`, fail-loud (`solana_facilitator_not_configured`), NUNCA `isAddress` de viem. |
| Tipos `SolanaEscrowDeposit`/`SolanaPrincipalAuthorization` en `src/application/ports.ts` | `ports.ts:142-159` (`EvmAuthorization`/`SolanaAuthorization`) | Envelope discriminado `vm:"solana"`; campos base58 como strings. |
| `src/infrastructure/solana-wallet.test.ts` (extender) | `wallet.test.ts:260-320` + HU-SOL-4 `solana-wallet.test.ts` | `describe`/`it` por AC; bridge fake inyectado; Connection mockeada (blockhash); anchor REAL para construir la ix y asertar estructura (programId/keys/data); assert `sendRawTransaction` NO llamado. |

### 3.3 Constraint Directives heredados del Auto-Blindaje histórico

Leídos `022/auto-blindaje.md` (WKH-211), `021/auto-blindaje.md` (WKH-210). `023` (HU-SOL-1) aún sin
auto-blindaje. Patrones recurrentes (≥2 HUs) → **CD-SDD-9..12** (§5):

- **CD-SDD-9** — *Importar tipos de dominio desde su módulo real, NO desde `ports`* (WKH-211 W1: `ports.ts`
  NO re-exporta `Beneficiary` → TS2459). El adapter importa `WalletPort` de `ports` (correcto) y `Quote`
  de `domain/remittance`; los tipos NUEVOS `SolanaEscrowDeposit`/`SolanaPrincipalAuthorization` se DEFINEN
  y EXPORTAN en `ports.ts` (son contrato del port, no dominio).
- **CD-SDD-10** — *El gate es `npm run qa` COMPLETO (typecheck + `vitest run`), NUNCA `next build`*
  (WKH-196/WKH-210: `build` excluye tests). Cada wave cierra con `npm run qa`.
- **CD-SDD-11** — *Widening aditivo, NO args requeridos* (WKH-211 W2: agregar un arg requerido rompió 8
  tests EIP-3009). Acá TODO lo nuevo (`escrow?`, `solana?`) es OPCIONAL ⇒ cero cambios de expectativa en
  tests EVM. Verificado contra `wallet.test.ts`/`fakes.ts` (§3.1). *Además*: al volver obligatorio un
  binding revisar el ORDEN de guards fail-loud (lección WKH-211 W2) — acá el guard `escrow` va junto al de
  wallet-conectada (AC-7 primero).
- **CD-SDD-12** — *Mutation self-check OBLIGATORIO del guard central* (WKH-210/WKH-211 W6): montar mutantes
  que rompan (a) feePayer=facilitator, (b) reference no-signer, (c) el "NUNCA sendRawTransaction", (d) el
  fail-loud sin wallet/escrow → confirmar que ≥1 test muere; restaurar desde backup en scratchpad (NO
  `git checkout`); `grep -rn MUTANT src app` = 0 al cerrar.
- **Mock supabase/Connection = doble inyectado** (WKH-210 nota): la Connection (blockhash) se inyecta/mock,
  NUNCA se pega a devnet en el test.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar | Wave |
|---------|--------|-------------|----------|------|
| `package.json` | Modificar | Agregar `@coral-xyz/anchor` **PINNEADA `0.30.1`** (sin `^`). `npm install`. **VERIFICADO resuelve limpio** (peer web3.js v1). **NO agregar `@solana/pay`** (CD-SDD-13). F3 re-verifica post-merge HU-SOL-4. | `package.json:18` | W0 |
| `src/application/ports.ts` | Modificar (ADITIVO) | (1) `SolanaEscrowDeposit { beneficiary: string; authority: string; mint?: string }`; (2) `SolanaPrincipalAuthorization { vm:"solana"; partialSignedTx: string; reference: string }`; (3) widening de `authorizePrincipal`: param `deposit?: { address: string; escrow?: SolanaEscrowDeposit }`, return `{ tx; eip3009?; solana?: SolanaPrincipalAuthorization }`. TODO opcional (§DT-SDD-3). | `ports.ts:142-159,224-231` | W0 |
| `src/infrastructure/chain.ts` | Modificar (ADITIVO) | `resolveSolanaFacilitatorPubkey(): string` — env `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`, valida con `new PublicKey()`, fail-loud `solana_facilitator_not_configured`. Export nuevo; resolvers EVM/Solana existentes byte-idénticos. | `chain.ts:135-144` | W0 |
| `src/infrastructure/solana-wallet.ts` | Modificar | Reemplazar el `authorizePrincipal()` **demo-simbólico de HU-SOL-4** por el real: builder de la ix `deposit` (§4.3/§4.4). `connect()`/`getAddress()`/`signMessage()`/bridge **NO se tocan** (HU-SOL-4). Lazy-import de anchor/spl-token. | `wallet.ts:84-151` + HU-SOL-4 adapter | W1+W2 |
| `src/infrastructure/solana-wallet.test.ts` | Modificar (extender) | Agregar tests de `authorizePrincipal` real (AC-1..AC-4, AC-7, AC-8). Los tests de `connect`/`getAddress` de HU-SOL-4 quedan intactos. | `wallet.test.ts` | W3 |

**No se toca**: `wallet.ts`, `container.ts`, `confirm-and-send.ts`, `pickWallet()`, `facilitator-client.ts`,
`solana-wallet-bridge.ts` (salvo la dependencia de contrato §4.5), ni ningún test EVM. **No se crea** ningún
archivo fuera de esta lista. El programa/IDL en `solana-programs/` es INMUTABLE (CD-5).

### 4.2 Modelo de datos

N/A on-disk. La ix `deposit` mueve SPL on-chain (devnet) vía el vault del escrow; el estado on-chain
(`EscrowState`) lo gestiona el programa (HU-SOL-12). Esta HU no toca BD ni persistencia local.

### 4.3 Contratos de tipos (el widening aditivo, W0)

```ts
// ports.ts — ADITIVO. Cero cambio a Eip3009Authorization / EvmAuthorization / SolanaAuthorization.

/** Datos del escrow que el CALLER (HU-SOL-13) resuelve y pasa a la wallet Solana. base58. */
export interface SolanaEscrowDeposit {
  beneficiary: string; // Pubkey base58 — destino de la remesa (release). Resuelto por HU-SOL-13.
  authority: string;   // Pubkey base58 — quien puede release/refund. Resuelto por HU-SOL-13.
  mint?: string;       // opcional: override del mint; default resolveSolanaUsdcMint() (CD-6).
}

/** Variante Solana del retorno de authorizePrincipal (envelope, alineada con SolanaAuthorization). */
export interface SolanaPrincipalAuthorization {
  vm: "solana";
  partialSignedTx: string; // tx legacy serializada base64, partial-signed (feePayer=facilitator, firma wallet-only)
  reference: string;       // Pubkey base58 de la reference Solana Pay (trazabilidad)
}

export interface WalletPort {
  connect(): Promise<string>;
  getAddress(): Promise<string | null>;
  authorizePrincipal(
    quote: Quote,
    remittanceId: string,
    deposit?: { address: string; escrow?: SolanaEscrowDeposit }, // escrow? = ADITIVO (Solana)
  ): Promise<{
    tx: string;
    eip3009?: { authorization: Eip3009Authorization; signature: string };
    solana?: SolanaPrincipalAuthorization; // ADITIVO (Solana)
  }>;
  signMessage(message: string): Promise<string>;
}
```

**Por qué ADITIVO y no un union discriminado en el top-level del return** (DT-SDD-3): `confirm-and-send.ts:182`
hace `const { tx, eip3009 } = await …`. Un union `{vm:"evm";…} | {vm:"solana";…}` haría que `eip3009` no
exista en todos los miembros → error de destructuring → obligaría a tocar `confirm-and-send.ts` (money-path
EVM) → viola CD-4. El slot `solana?` opcional preserva byte-identidad y lleva su propio discriminante
`vm:"solana"` internamente (honra "discriminada por vm" a nivel envelope, coherente con `SolanaAuthorization`).
Idéntico razonamiento para `escrow?` en el param (aditivo, wallet.ts lee `deposit.address` sin cambios).

### 4.4 Armado de la ix `deposit` (`SolanaWalletAdapter.authorizePrincipal`, W1→W2)

```
authorizePrincipal(quote, remittanceId, deposit?):
  // ── GUARDS fail-loud (W1) ─────────────────────────────────────────────
  sender = this.getAddress()                       // base58 del bridge (HU-SOL-4)
  if (!sender) throw "wallet_not_connected"         // AC-7 (espejo wallet.ts:90)
  if (!deposit?.escrow?.beneficiary || !deposit?.escrow?.authority)
      throw "escrow_params_missing"                 // CD-8 (espejo deposit_address_missing)
  const { PublicKey, Transaction, Connection, clusterApiUrl, Keypair } = await import("@solana/web3.js")
  const anchor = await import("@coral-xyz/anchor")                 // lazy (DT-SDD-8). Fallback manual: DT-SDD-6
  const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID }
      = await import("@solana/spl-token")                          // lazy (dep de HU-SOL-4)

  senderPk      = new PublicKey(sender)             // valida base58 (throw si malformado)
  beneficiaryPk = new PublicKey(deposit.escrow.beneficiary)
  authorityPk   = new PublicKey(deposit.escrow.authority)
  mintPk        = new PublicKey(deposit.escrow.mint ?? resolveSolanaUsdcMint())  // CD-6
  facilitatorPk = new PublicKey(resolveSolanaFacilitatorPubkey())               // CD-6, feePayer

  // ── Args canónicos (W1, AC-8/CD-7) ────────────────────────────────────
  remittanceIdBytes = remittanceIdToBytes16(remittanceId)   // [u8;16] determinístico (DT-SDD-5)
  amount   = new anchor.BN(String(quote.send.minor))         // u64 sin floats (WKH-196: String, no number)
  if (!isParseableIso(quote.expiresAt)) throw "quote_expires_at_invalid"   // fail-loud (wallet.ts:103)
  deadline = new anchor.BN(Math.floor(Date.parse(quote.expiresAt)/1000))   // i64 unix seconds

  // ── PDAs / ATAs (W1, AC-1) ────────────────────────────────────────────
  [escrowStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), senderPk.toBuffer(), Buffer.from(remittanceIdBytes)], PROGRAM_ID)
  vault    = getAssociatedTokenAddressSync(mintPk, escrowStatePda, /*allowOwnerOffCurve*/ true)
  senderAta= getAssociatedTokenAddressSync(mintPk, senderPk)

  // ── reference (W1, AC-4) — Pubkey único, @solana/web3.js, NO @solana/pay (CD-SDD-13) ──
  reference = Keypair.generate().publicKey   // marcador indexable; NO se usa la privada. Se retorna en solana.reference

  // ── Build ix (W1, AC-1) — VÍA anchor Program (recomendado, anchor resuelve limpio) ──
  program = new anchor.Program(escrowIdl, { connection })   // 0.30: programId sale de idl.address
  ix = await program.methods
      .deposit(Array.from(remittanceIdBytes), beneficiaryPk, authorityPk, amount, deadline)
      .accounts({ sender: senderPk, mint: mintPk, senderAta, /* PDAs las deriva anchor del IDL */ })
      .remainingAccounts([{ pubkey: reference, isSigner: false, isWritable: false }])  // AC-4
      .instruction()
  // FALLBACK MANUAL (DT-SDD-6, sólo si anchor NO resuelve post-merge de HU-SOL-4): construir la ix con
  // @solana/web3.js sin el Program client — misma semántica, misma tx:
  //   data = Buffer.concat([ DISCRIMINATOR, borsh(remittance_id[16], beneficiary, authority, amount_u64, deadline_i64) ])
  //     · DISCRIMINATOR = del IDL: Buffer.from([242,35,198,137,82,225,242,182])  (== sha256("global:deposit")[:8])
  //     · borsh vía @coral-xyz/borsh (viene con anchor) o serialización manual LE (u64/i64 little-endian)
  //   keys = [ sender(s,w), mint(-,-), escrowStatePda(-,w), vault(-,w), senderAta(-,w),
  //            TOKEN_PROGRAM_ID(-,-), ASSOCIATED_TOKEN_PROGRAM_ID(-,-), SystemProgram.programId(-,-),
  //            reference(-,-) ]   // reference al final, no-signer/no-writable (AC-4)
  //   ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data })

  // ── feePayer + blockhash + partial-sign (W2, AC-2/AC-3) ───────────────
  connection = new Connection(clusterApiUrl(resolveSolanaNetworkConfig().cluster))  // devnet (browser, NO resolveSolanaRpcUrl server-only)
  { blockhash } = await connection.getLatestBlockhash()
  tx = new Transaction().add(ix)
  tx.feePayer = facilitatorPk                       // AC-2: facilitator paga el fee de red
  tx.recentBlockhash = blockhash
  signed = await bridge.signTransaction(tx)         // AC-2: partial-sign SOLO wallet (HU-SOL-4 bridge, §4.5)
  serialized = signed.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64")
  // AC-3/CD-1/CD-2: NUNCA connection.sendRawTransaction / sendTransaction acá.

  return { tx: serialized, solana: { vm: "solana", partialSignedTx: serialized, reference: reference.toBase58() } }
```

Notas:
- `PROGRAM_ID` sale del `idl.address` (`BBQ9…79WA`) — NO hardcodeado aparte (CD-6). El IDL se importa como
  JSON (o se embebe pinneado del artefacto de HU-SOL-12; decisión de import concreta en F3, ver §11).
- `.accounts({...})`: en Anchor 0.30 los PDAs con seeds declarados en el IDL (`escrow_state`, `vault`) los
  **resuelve el builder automáticamente** desde `sender`+`remittance_id`+`mint`; se pasan explícitos sólo
  los no-derivables (`sender`, `mint`, `sender_ata`). Los program-accounts (`token_program`,
  `associated_token_program`, `system_program`) tienen `address` fijo en el IDL → auto. F3 valida contra el
  IDL real que la lista de `.accounts` requerida por anchor es exactamente esa (defensa: si anchor exige
  `escrowState`/`vault` explícitos, derivarlos con `findProgramAddressSync` como arriba — ver §11 `[TBD]`).
- Solana Pay `reference`: cuenta **read-only no-signer** que el programa IGNORA (no está en el IDL) pero que
  queda en el message → indexable por el facilitator/verifier (AC-4). NO altera los accounts del IDL.

### 4.5 Dependencia de contrato con el bridge de HU-SOL-4 (partial-sign)

`authorizePrincipal` necesita firmar la tx con la wallet. El bridge de HU-SOL-4 (`solana-wallet-bridge.ts`)
hoy expone `{publicKey, connected}` + `openModal` + `waitForConnection`. Esta HU requiere que el bridge
**también exponga un handle `signTransaction(tx): Promise<Transaction>`** (capturado de
`useWallet().signTransaction` por el `SolanaWalletBridgeSync` component). Dos caminos, resueltos en F3
(post-merge de HU-SOL-4):
- **(a) preferido**: HU-SOL-4 ya expone `signTransaction` en el bridge → esta HU sólo lo consume.
- **(b) fallback**: si HU-SOL-4 no lo expone, esta HU **extiende el bridge de forma aditiva** (registra un
  handle más en el `SolanaWalletBridgeSync`), sin tocar `connect`/`getAddress` (CD: no redefinir HU-SOL-4).

Se **coordina explícitamente con HU-SOL-4** antes del F3 (ver §10). El adapter sigue sin importar
`@solana/wallet-adapter-*` (regla del seam de HU-SOL-4): la firma la aporta el handle del bridge.

### 4.6 Flujo de error (fail-loud, sin efectos parciales)

- Sin wallet conectada (`getAddress()` → null): `throw "wallet_not_connected"` **antes** de construir/firmar
  (AC-7). Ninguna tx parcial.
- Sin `beneficiary`/`authority` en `deposit.escrow`: `throw "escrow_params_missing"` (CD-8) — NUNCA se
  inventa un default (mismo criterio `deposit_address_missing` de wallet.ts).
- base58 malformado (`beneficiary`/`authority`/`mint`/facilitator): `new PublicKey()` lanza → propaga
  fail-loud (CD-6, defensa en profundidad).
- `quote.expiresAt` no parseable: `throw "quote_expires_at_invalid"` (espejo wallet.ts:103) antes de firmar.
- Fallo del `signTransaction` del bridge (usuario rechaza / timeout): propaga el throw → el caller
  (HU-SOL-13/flow) lo degrada por su path de error. NUNCA deja una tx a medio firmar transmitida (CD-1).

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO
- **CD-SDD-1** (=CD-1/CD-2 work-item, AC-3): `SolanaWalletAdapter` **NUNCA** llama
  `sendTransaction`/`sendRawTransaction`. Sólo partial-sign + serialización + return. El broadcast es
  HU-SOL-14 vía el facilitator.
- **CD-SDD-2** (=CD-3): el deposit va SIEMPRE al **vault del escrow** (PDA `escrow_state` / ATA derivada del
  IDL), NUNCA a un address estático de TransFi.
- **CD-SDD-3** (=CD-7, AC-8): `amount = new BN(String(quote.send.minor))`, `deadline = new
  BN(Math.floor(Date.parse(quote.expiresAt)/1000))` — cero floats, `String()` no `Number()` (lección WKH-196).
- **CD-SDD-4** (=CD-6): program id (del `idl.address`), mint (`resolveSolanaUsdcMint`) y facilitator pubkey
  (`resolveSolanaFacilitatorPubkey`) son env-driven / del IDL — **PROHIBIDO hardcodear**.
- **CD-SDD-5** (=AC-2): `feePayer = resolveSolanaFacilitatorPubkey()`; la tx se firma **SÓLO** con la wallet
  (bridge). NUNCA con una clave del facilitator (el adapter no tiene ni conoce claves del facilitator).
- **CD-SDD-6** (=AC-4): la `reference` va como cuenta **no-signer / no-writable** en `remainingAccounts`, SIN
  agregarla a los `.accounts` del IDL.
- **CD-SDD-7**: validar TODAS las Pubkey con `new PublicKey()` de `@solana/web3.js` — **NUNCA** `isAddress`
  de viem (mismo criterio `resolveSolanaUsdcMint`, `chain.ts:139`).
- **CD-SDD-9..12** — heredados del Auto-Blindaje (§3.3).

### PROHIBIDO
- **CD-SDD-8** (=CD-8): PROHIBIDO inventar/asumir un `beneficiary`/`authority` default — sin ellos, fail-loud.
- PROHIBIDO tocar `wallet.ts`, `pickWallet()`, `container.ts` (dispatch), `confirm-and-send.ts`,
  `facilitator-client.ts`, ni ningún test EVM (CD-4/AC-5, byte-idéntico).
- PROHIBIDO redefinir `connect()`/`getAddress()`/`signMessage()` del `SolanaWalletAdapter` ni el core del
  `solana-wallet-bridge.ts` (son de HU-SOL-4; sólo se PERMITE agregar aditivamente el handle
  `signTransaction` si HU-SOL-4 no lo trae — §4.5).
- PROHIBIDO modificar el programa escrow / su IDL (`solana-programs/`, HU-SOL-12 DONE, CD-5).
- PROHIBIDO usar `resolveSolanaRpcUrl()` para la Connection del browser (es server-only → undefined). El
  endpoint sale de `clusterApiUrl(resolveSolanaNetworkConfig().cluster)` (mismo criterio que HU-SOL-4).
- PROHIBIDO importar `@solana/wallet-adapter-*` desde `solana-wallet.ts` (regla del seam de HU-SOL-4). La
  firma la aporta el handle del bridge.
- PROHIBIDO convertir el widening de `WalletPort` en args/campos REQUERIDOS (rompería EVM — CD-SDD-11).
- **CD-SDD-13**: PROHIBIDO usar `@solana/pay` (peer-conflict irreconciliable: exige Kit v2 `@solana/kit@^6`
  vs Kit v1 `5.5.1` del árbol). El `reference` se genera con `@solana/web3.js` (`Keypair.generate().publicKey`).
- PROHIBIDO agregar deps fuera de `@coral-xyz/anchor@0.30.1`; PROHIBIDO `^`/`~` en ella (pin, HU-SOL-25).

---

## 6. Decisiones Técnicas (DT-SDD-N) — mapeo a DT-1..5 del work-item

### DT-SDD-1 — `beneficiary`/`authority` provistos por el caller (resuelve MI-1, DT-1/DT-4)
`deposit.escrow: { beneficiary, authority, mint? }` los provee el caller (HU-SOL-13). El adapter NO los
resuelve ni asume default (CD-8). `authority` viene del caller (NO se fuerza a == facilitator, a diferencia
de DT-4 del work-item que sugería reusar el facilitator): en la práctica HU-SOL-13 probablemente resolverá
`authority = facilitator pubkey`, pero esta HU los mantiene **desacoplados** (authority=negocio,
feePayer=env) para no cablear política de negocio en la wallet.

### DT-SDD-2 — Sólo se agrega `authorizePrincipal` al adapter de HU-SOL-4 (resuelve MI-2, AC-6)
El dispatch VM vive en `container.ts` (HU-SOL-4). Esta HU NO toca `pickWallet()` ni el dispatch: reemplaza el
`authorizePrincipal()` demo del `SolanaWalletAdapter` por el real. AC-6 (dispatch por VM) queda satisfecho por
el conjunto `container.ts`(HU-SOL-4) + este `authorizePrincipal`. Cero colisión de merge con HU-SOL-4 fuera de
`solana-wallet.ts` (mismo archivo, distinto método → coordinación de orden de merge, §10).

### DT-SDD-3 — Widening ADITIVO de `WalletPort` (resuelve MI-3)
Return gana `solana?: SolanaPrincipalAuthorization`; param gana `escrow?`. Ambos OPCIONALES → `wallet.ts`,
`fakes.ts`, `confirm-and-send.ts` byte-idénticos (método-bivarianza param + covarianza return, verificado
§3.1). Es el "estrictamente necesario" que la CD-4 de HU-SOL-4 dejó abierto. NO un port nuevo (duplicaría la
interfaz + forzaría 2º dispatch). NO un union top-level en el return (rompería el destructuring de
`confirm-and-send.ts`, §4.3).

### DT-SDD-4 — `feePayer=facilitator` estructural, partial-sign wallet-only, NUNCA auto-broadcast (DT-2, AC-2/AC-3)
El adapter fija `feePayer` a la Pubkey del facilitator (env) y firma SÓLO con la wallet
(`bridge.signTransaction`). NO agrega la firma del facilitator (no tiene su clave) ni transmite. Serializa con
`requireAllSignatures:false` (falta la firma del facilitator, que la pondrá HU-SOL-14 al broadcastear).

### DT-SDD-5 — `remittance_id` determinístico; `reference` con `@solana/web3.js` (NO `@solana/pay`)
`remittanceIdToBytes16(remittanceId)` produce `[u8;16]` **determinístico** (p.ej. `sha256(remittanceId)`
truncado a 16 bytes) — reproducible por el verifier server-side (HU-SOL-13) que debe re-derivar la PDA
`escrow_state`. Mismo espíritu anti-doble-pago que el nonce determinístico EIP-3009 (WKH-168/CD-19), sin
`Math.random`. **La derivación EXACTA es canónica de esta HU y HU-SOL-13 DEBE reusarla** (§9).
El **`reference`** (Solana Pay) es sólo un Pubkey único usado como cuenta read-only/non-signer para indexar
la tx off-chain — se genera con `Keypair.generate().publicKey` de **`@solana/web3.js`** (ya presente); NO se
usa **`@solana/pay`** (peer-conflict irreconciliable Kit v2 vs Kit v1 del árbol — hallazgo del F3 de HU-SOL-4,
CD-SDD-13). La privada del keypair se descarta (nunca firma). El `reference` se RETORNA en `solana.reference`
para que el caller lo persista y el verifier/facilitator (HU-SOL-13/14) lo watchee — patrón estándar Solana
Pay (reference random tracked off-chain).

### DT-SDD-6 — Builder de la ix: `@coral-xyz/anchor` (recomendado, VERIFICADO) con fallback MANUAL (DT-1, MI-5)
**Vía recomendada — anchor client**: `anchor.Program(idl).methods.deposit(...).instruction()`. El
discriminator/orden de args/PDAs salen del IDL real (HU-SOL-12) → menos superficie de error que re-implementar
borsh a mano. **`@coral-xyz/anchor@0.30.1` VERIFICADO que resuelve limpio** contra el árbol actual (`npm
install --dry-run`, exit 0; peer `@solana/web3.js@^1.68.0` **v1** — alineado con el `^1.98.4` presente; trae
`@coral-xyz/borsh`+`bn.js`; SIN el conflicto Kit v2 de `@solana/pay`). Los warns ERESOLVE observados son de
`@keystonehq/sdk`→`qrcode.react` (react 17 vs 19), ruido transitivo pre-existente, no de anchor.
**Fallback MANUAL (documentado, sólo si anchor deja de resolver post-merge de HU-SOL-4 —que agrega
`@solana/spl-token`/`@solana/wallet-adapter-*`—)**: construir la ix con `@solana/web3.js`
(`TransactionInstruction`) usando el **discriminador literal del IDL** `[242,35,198,137,82,225,242,182]`
(== `sha256("global:deposit")[:8]`) + args serializados borsh (u64/i64 little-endian) + las cuentas del IDL
(§4.4). **F3 DEBE re-correr `npm install` post-merge de HU-SOL-4 y elegir la vía que resuelva limpio**; el
diseño de §4.4 cubre ambas (la tx resultante es idéntica). Pinneada (HU-SOL-25).

### DT-SDD-7 — Endpoint del blockhash = `clusterApiUrl(devnet)` en el browser (no server-only)
La Connection para `getLatestBlockhash` usa `clusterApiUrl(resolveSolanaNetworkConfig().cluster)` (browser),
NO `resolveSolanaRpcUrl()` (server-only → undefined en browser), consistente con HU-SOL-4 (endpoint del
`ConnectionProvider`). El blockhash debe fijarse ANTES de la firma (la wallet firma sobre el message que lo
incluye); el facilitator debe broadcastear dentro de la ventana de validez (~2 min) — nota para HU-SOL-14.

### DT-SDD-8 — Lazy-import de anchor/spl-token (regresión-cero EVM + seam de HU-SOL-4)
`@coral-xyz/anchor` y `@solana/spl-token` se cargan con `await import()` DENTRO de `authorizePrincipal`
(patrón `wallet.ts:200`), no como import estático de `solana-wallet.ts`. Así NO entran al bundle EVM (que
importa `container.ts`→`solana-wallet.ts` estáticamente) y refuerzan AC-5 por construcción. Sólo la validación
base58 puede quedar estática (`@solana/web3.js` ya es baseline vía `chain.ts`).

---

## 7. Scope

**IN:** `authorizePrincipal()` real del `SolanaWalletAdapter` (deposit-ix builder vía anchor); widening
aditivo de `WalletPort` + tipos `SolanaEscrowDeposit`/`SolanaPrincipalAuthorization`;
`resolveSolanaFacilitatorPubkey()`; dep `@coral-xyz/anchor` pinneada; tests del adapter.

**OUT:** broadcast gasless real / cliente HTTP del facilitator Solana (HU-SOL-14); verificación server-side
del vault (HU-SOL-13); resolución de `beneficiary`/`authority` (HU-SOL-13); PoP ed25519 (HU-SOL-8);
`connect`/`getAddress`/bridge/`pickWallet`/dispatch (HU-SOL-4); cerrar `[TBD HU-SOL-2]` de
`SolanaAuthorization`; mainnet-beta; el programa/IDL escrow.

---

## 8. Plan de Implementación (Waves)

> **PRE-REQUISITO F3 (dura):** HU-SOL-4 (`024`) DEBE estar mergeada a main (aporta `solana-wallet.ts`,
> `solana-wallet-bridge.ts` y las deps `@solana/spl-token`/`@solana/wallet-adapter-*`). Sin ella no hay
> `SolanaWalletAdapter` que extender. Ver §10.
> Cada wave cierra con `npm run qa` (typecheck + `vitest run`) **verde** (CD-SDD-10). Con `NEXT_PUBLIC_VM`
> unset los tests corren en rama EVM y deben quedar byte-idénticos (AC-5).

### Wave 0 (Serial Gate — contratos/deps, EVM verde)
- **W0.1**: `package.json` — agregar `@coral-xyz/anchor` PINNEADA **`0.30.1`** (sin `^`). `npm install`.
  **Re-verificar** que resuelve limpio POST-merge de HU-SOL-4 (que agrega `@solana/spl-token`/
  `@solana/wallet-adapter-*`); si anchor deja de resolver → activar el fallback manual (DT-SDD-6). **NO**
  agregar `@solana/pay` (CD-SDD-13). Verificado hoy pre-merge: exit 0, peer web3.js v1.
- **W0.2**: `ports.ts` — widening ADITIVO: tipos `SolanaEscrowDeposit`/`SolanaPrincipalAuthorization` +
  `escrow?` en el param + `solana?` en el return de `authorizePrincipal` (§4.3).
- **W0.3**: `chain.ts` — `resolveSolanaFacilitatorPubkey()` (fail-loud, `new PublicKey()`).
- **Gate W0**: `npm run qa` verde. `wallet.test.ts`/`fakes.ts`/`confirm-and-send.test.ts` byte-idénticos
  (widening aditivo, CD-SDD-11). EVM 100% intacto.

### Wave 1 (Armado de la ix `deposit` desde el IDL)
- **W1.1**: en `solana-wallet.ts`, reemplazar el `authorizePrincipal` demo por: guards fail-loud (AC-7/CD-8),
  lazy-import de anchor/spl-token, derivación de `remittanceIdToBytes16`/`reference` (DT-SDD-5), Pubkeys
  (CD-SDD-7), args canónicos `amount`/`deadline` (CD-SDD-3/AC-8), PDAs/ATAs (AC-1), build de la ix vía
  `program.methods.deposit(...).accounts(...).remainingAccounts([reference])` (AC-1/AC-4).
- **Gate W1**: `npm run qa` verde. Test de armado de ix (AC-1/AC-4/AC-8) passing; EVM intacto.

### Wave 2 (feePayer + partial-sign + serialización, sin broadcast)
- **W2.1**: `feePayer=resolveSolanaFacilitatorPubkey()`, `recentBlockhash` vía `clusterApiUrl(devnet)`
  (DT-SDD-7), `bridge.signTransaction(tx)` (partial-sign wallet-only, §4.5), `serialize({requireAllSignatures:
  false})` → base64, return `{ tx, solana:{ vm, partialSignedTx, reference } }`. **NUNCA** send* (CD-SDD-1/AC-3).
- **Gate W2**: `npm run qa` verde. Test AC-2 (feePayer + firma wallet-only) + AC-3 (no broadcast) passing.

### Wave 3 (Tests + verificación)
- **W3.1**: `solana-wallet.test.ts` — extender con AC-1 (ix args/accounts/programId), AC-2 (feePayer===
  facilitator; `bridge.signTransaction` llamado, sin clave facilitator), AC-3 (`sendRawTransaction`/
  `sendTransaction` NUNCA llamados; return serializado), AC-4 (reference no-signer/no-writable en
  remainingAccounts; accounts del IDL intactos), AC-7 (sin wallet → throw), AC-8 (amount=String(minor),
  deadline=floor(unix)). Bridge fake + Connection mock (blockhash) + anchor REAL para la ix.
- **W3.2**: regresión EVM (AC-5/CD-4) — `wallet.test.ts`, `confirm-and-send.test.ts`, y demás tests EVM
  verdes sin cambio de expectativa. Confirmar 0 diffs.
- **W3.3**: **Mutation self-check** (CD-SDD-12): mutar (a) `feePayer` → sender, (b) reference `isSigner:true`,
  (c) agregar un `sendRawTransaction`, (d) quitar el guard `!sender`/`!escrow` → confirmar que ≥1 test muere
  por cada mutante; restaurar desde backup en scratchpad; `grep -rn MUTANT src app` = 0.
- **Gate W3**: `npm run qa` verde full.

---

## 9. Test Plan + Caveat del rent

| Test (`solana-wallet.test.ts`) | AC / CD | Wave |
|--------------------------------|---------|------|
| `authorizePrincipal` arma la ix `deposit` con program id `BBQ9…79WA`, discriminator correcto, args `remittance_id`(16)/`beneficiary`/`authority`/`amount`/`deadline` y accounts del IDL (escrow_state PDA, vault ATA, sender_ata, programs) | **AC-1** | W3 |
| `feePayer === resolveSolanaFacilitatorPubkey()`; `bridge.signTransaction` llamado 1×; ninguna clave del facilitator interviene | **AC-2, CD-SDD-5** | W3 |
| NUNCA `connection.sendRawTransaction`/`sendTransaction` (spy = 0 calls); return incluye `solana.partialSignedTx` base64 + `reference` | **AC-3, CD-SDD-1** | W3 |
| `reference` presente en la tx como cuenta `isSigner:false,isWritable:false` (remainingAccount); los accounts del IDL NO cambian | **AC-4, CD-SDD-6** | W3 |
| VM=EVM: `wallet.test.ts`/`confirm-and-send.test.ts` y todo test EVM VERDES, misma expectativa | **AC-5, CD-4, CD-SDD-11** | W3 |
| dispatch VM=solana → `SolanaWalletAdapter` (cubierto por `container.test.ts` de HU-SOL-4; cross-ref) + este `authorizePrincipal` es el real (no demo) | **AC-6** | W3 |
| sin wallet (`getAddress()`→null) → throw `wallet_not_connected` SIN construir/firmar; sin `escrow` → throw `escrow_params_missing` | **AC-7, CD-SDD-8** | W3 |
| `amount === new BN(String(quote.send.minor))` (uint64, sin float); `deadline === floor(Date.parse(expiresAt)/1000)`; `expiresAt` inválido → throw | **AC-8, CD-SDD-3** | W3 |
| Mutation self-check (feePayer / reference-signer / no-broadcast / fail-loud) | **CD-SDD-12** | W3 |

**Cobertura por AC**: AC-1→ix-builder test; AC-2→feePayer/sign test; AC-3→no-broadcast test; AC-4→reference
test; AC-5→tests EVM existentes verdes; AC-6→`container.test.ts`(HU-SOL-4) + este adapter real; AC-7→fail-loud
test; AC-8→canónicos test.

**CAVEAT rent (MI-6, documentado — NO resuelto acá, para HU-SOL-13/14):** el `deposit` crea `escrow_state`+
`vault` con `payer = sender` (fijado en el programa Anchor, HU-SOL-12 DONE e inmutable). El gasless de
HU-SOL-14 sólo puede cubrir el **fee de red** (5000 lamports, vía `feePayer=facilitator`); el
**rent-exemption** de esas 2 cuentas se deduce en SOL de la wallet del `sender`. **Un sender con 0 SOL no
puede depositar aunque el facilitator pague el fee.** HU-SOL-13/14 deben contemplar funding previo del sender
(o un ajuste al programa, fuera de scope de este programa). Esta HU sólo lo documenta.

---

## 10. Riesgos + Coordinación con HU-SOL-4

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| **Colisión de merge con HU-SOL-4 en `solana-wallet.ts`** (mismo archivo, distinto método) | A | A | **F3 de esta HU NO arranca hasta HU-SOL-4 mergeada** (§8 pre-req). Se extiende el adapter ya en main. Coordinación de orden explícita con el orquestador. |
| El bridge de HU-SOL-4 no expone `signTransaction` | M | M | §4.5: fallback aditivo (registrar el handle en el bridge sin tocar connect/getAddress). Coordinado con HU-SOL-4. |
| Anchor 0.30 exige `.accounts` explícitos que el IDL no auto-deriva | M | M | §4.4 nota: si el builder no auto-deriva `escrowState`/`vault`, derivarlos con `findProgramAddressSync`/`getAssociatedTokenAddressSync` y pasarlos explícitos. F3 valida contra el IDL real. `[TBD]` §11. |
| `@coral-xyz/anchor` deja de resolver post-merge de HU-SOL-4 (que agrega spl-token/wallet-adapter) | B | M | Anchor 0.30.1 VERIFICADO limpio hoy (peer web3.js v1, sin Kit v2). **Fallback MANUAL** con `TransactionInstruction` + discriminador del IDL + borsh (DT-SDD-6/§4.4). F3 re-corre `npm install` y elige la vía limpia. |
| `@solana/pay` arrastra Kit v2 y rompe el árbol | — | — | **Eliminado de raíz**: NO se usa `@solana/pay`; `reference` con `@solana/web3.js` (CD-SDD-13). |
| Import estático de anchor filtra la lib al bundle EVM (AC-5) | M | A | DT-SDD-8: lazy-import `await import()` dentro de `authorizePrincipal`. Test EVM verde lo verifica. |
| Widening de `WalletPort` rompe un consumidor/fake | B | M | Aditivo/opcional (CD-SDD-11); verificado contra `wallet.ts`/`fakes.ts`/`confirm-and-send.ts` (§3.1). Gate W0 lo confirma. |
| blockhash expira antes del broadcast del facilitator | B | M | Nota para HU-SOL-14 (broadcast dentro de ~2 min); fuera de scope acá (esta HU no transmite). |

---

## 11. Missing Inputs / Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| `[TBD F3]` | §4.4 | Forma EXACTA de import del IDL (`escrow.json` como JSON import vs copia pinneada en el repo chaski-v3) y la lista precisa de `.accounts` que Anchor 0.30 exige explícitos vs auto-deriva. Se resuelve en F3 contra el IDL/anchor reales; el diseño cubre ambos caminos (auto-derivación o `findProgramAddressSync` explícito). NO bloquea el SDD. | **No** |
| `[TBD F3]` | §4.4/DT-SDD-6 | Vía de armado de la ix: **anchor client (recomendado, verificado limpio hoy)** vs **fallback MANUAL** (`TransactionInstruction`+discriminador IDL+borsh). F3 re-corre `npm install` post-merge de HU-SOL-4 y elige la que resuelva limpio; ambas producen la MISMA tx. NO bloquea el SDD. | **No** |
| `[TBD F3]` | §4.5 | Si el bridge de HU-SOL-4 expone `signTransaction`. Se confirma post-merge de HU-SOL-4; fallback aditivo definido. | **No** |

Cero `[NEEDS CLARIFICATION]`. Los dos `[TBD]` son de implementación (F3), con ambos caminos ya diseñados.

---

## 12. Implementation Readiness Check

```
[x] Cada AC (1..8) tiene ≥1 archivo en §4.1 y ≥1 test en §9
    AC-1/4/8→solana-wallet.ts+test · AC-2/3→feePayer/partial-sign/no-broadcast · AC-5→tests EVM existentes
    AC-6→container.test.ts(HU-SOL-4)+adapter real · AC-7→fail-loud
[x] Cada archivo en §4.1 tiene Exemplar verificado con Read (§3.1/§3.2)
[x] Los 6 Missing Inputs del work-item CERRADOS (§0)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (§5: 8 PROHIBIDO)
[x] Context Map ≥2 archivos leídos (§3.1: 11 archivos + IDL)
[x] Scope IN/OUT explícitos (§7)
[x] BD: N/A — declarado §4.2
[x] Flujo principal completo (§4.4) + flujo de error (§4.6)
[x] Baseline verde confirmado (npm run qa exit 0, 48 files / 562 tests)
[x] Auto-Blindaje histórico leído → CD-SDD-9..12 heredados (§3.3)
[x] Widening de WalletPort verificado ADITIVO (wallet.ts/fakes.ts/confirm-and-send byte-idénticos, §3.1)
[x] Caveat del rent documentado para HU-SOL-13/14 (§9)
[x] Dependencia F3 de HU-SOL-4 documentada (§8/§10)
[x] `@coral-xyz/anchor@0.30.1` VERIFICADO resuelve limpio (npm --dry-run exit 0) + fallback manual (DT-SDD-6)
[x] `@solana/pay` DESCARTADO (Kit v2 conflict) → reference con @solana/web3.js (CD-SDD-13)
```

**No blockers.** SDD listo para `SPEC_APPROVED`. (F3 gated por el merge de HU-SOL-4, §8/§10.)

---

*SDD generado por NexusAgil — FULL — HU-SOL-5 / WKH-207\* (Solana LATAM Labs)*
</content>
</invoke>
