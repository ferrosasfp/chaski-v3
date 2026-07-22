# Story File — #025: [HU-SOL-5 / WKH-207*] chaski-v3: wallet Solana firma el `deposit` al escrow (SPL, gasless-facilitator)

> SDD: `doc/sdd/025-hu-sol-5-wallet-deposit-escrow/sdd.md` (SPEC_APPROVED)
> Work Item: `doc/sdd/025-hu-sol-5-wallet-deposit-escrow/work-item.md`
> Fecha: 2026-07-21
> Branch: `feat/025-hu-sol-5-wallet-deposit-escrow`
> Repo: `/home/ferdev/.openclaw/workspace/chaski-v3`

> **Dev lee SOLO este documento.** Todo lo necesario está acá: código concreto por símbolo,
> archivos exactos, prohibiciones por wave y el gate de cada wave. Si algo NO está acá → **PARÁ
> y escalá al Architect** (ver §Escalation). No inventes, no asumas, no improvises.

---

## ⛔ PRE-REQUISITO DURO DE F3 — LEÉ ESTO ANTES QUE NADA

> **Esta HU EXTIENDE el `SolanaWalletAdapter` de HU-SOL-4 (`024`). El F3 de esta HU NO ARRANCA
> hasta que HU-SOL-4 esté MERGEADA A `main`.**
>
> HU-SOL-4 aporta: `src/infrastructure/solana-wallet.ts` (el adapter con `connect`/`getAddress`
> reales + `authorizePrincipal` demo que ESTA HU reemplaza), `src/infrastructure/solana-wallet-bridge.ts`
> (el singleton React-free), y las deps `@solana/spl-token` + `@solana/wallet-adapter-*` en `package.json`.
>
> **Wave -1 (Environment Gate) verifica esto por vos.** Si esos archivos/deps NO están en `main`
> (o el branch base de esta HU no los trae mergeados) → **PARÁ y avisá al orquestador.** No
> re-implementes el adapter ni el bridge: son de HU-SOL-4.

---

## REGLA DE ORO (leé esto antes de tocar una línea)

> **AC-5 es la restricción dura de TODA la HU: el path EVM queda BYTE-IDÉNTICO.**
>
> 1. El widening de `WalletPort` es **100% ADITIVO** — todo lo nuevo (`escrow?` en el param,
>    `solana?` en el return) es **OPCIONAL**. `wallet.ts`, `pickWallet()`, `FakeWallet` (`fakes.ts`)
>    y `confirm-and-send.ts` quedan **byte-idénticos**. El destructuring `const { tx, eip3009 } = ...`
>    de `confirm-and-send.ts:182` sigue compilando sin cambios.
> 2. **Los tests EVM NO SE TOCAN.** Si un `expect(...)` de `wallet.test.ts`, `confirm-and-send.test.ts`,
>    `container.test.ts` o `flow.test.tsx` cambia para pasar → **PARÁ y escalá.** Cambiar una
>    assertion EVM = violación de proceso, no un fix. (Lección WKH-211: agregar un arg REQUERIDO
>    rompió 8 tests EIP-3009 — acá NADA nuevo es requerido.)
> 3. **NUNCA auto-broadcast.** El adapter SÓLO partial-signa + serializa + retorna. **PROHIBIDO**
>    `connection.sendTransaction` / `sendRawTransaction`. El broadcast es del facilitator (HU-SOL-14).
> 4. **`reference` SIN `@solana/pay`** (CD-SDD-13): peer-conflict irreconciliable (Kit v2 vs Kit v1
>    del árbol). Se genera con `@solana/web3.js` (`Keypair.generate().publicKey`).
> 5. Sólo **agregás** tests nuevos en `solana-wallet.test.ts`. Los de `connect`/`getAddress` de
>    HU-SOL-4 (ya en ese archivo) quedan intactos.

---

## Goal

Reemplazar el `SolanaWalletAdapter.authorizePrincipal()` **demo-simbólico** de HU-SOL-4 por el
**real**: construye la instrucción `deposit` del programa escrow Anchor (IDL de HU-SOL-12, program id
`BBQ9TcriBT7tqe5czR72CkUyxYg6z8pH7nk161yh79WA`, devnet) con los args canónicos, agrega la `reference`
como cuenta read-only, fija `feePayer` = Pubkey del facilitator (env), **partial-signa SÓLO con la
wallet conectada** (vía el bridge) y devuelve la tx serializada base64 para que el facilitator la
transmita (HU-SOL-14, Scope OUT). NUNCA auto-broadcast. Path EVM byte-idéntico.

---

## Anti-Hallucination Checklist (verificado por el Architect en F2 — NO re-investigar)

Todo lo de abajo YA fue confirmado con Read/Glob/Bash en el codebase. Usá estos hechos tal cual:

| # | Hecho verificado | Fuente |
|---|------------------|--------|
| AH-1 | `WalletPort` hoy = `connect()`, `getAddress()`, `authorizePrincipal(quote, remittanceId, deposit?: {address})` → `{ tx: string; eip3009?: {...} }`, `signMessage(message)`. **Se EXTIENDE aditivo** (W0.2). | `src/application/ports.ts:218-235` |
| AH-2 | `confirm-and-send.ts` consume `const { tx, eip3009 } = await this.wallet.authorizePrincipal(...)`. **NO se toca**; el widening opcional lo mantiene válido (ignora `solana?`). | `src/application/use-cases/confirm-and-send.ts:182` |
| AH-3 | `FakeWallet implements WalletPort` (`fakes.ts`): param `_deposit?: { address }`, return `{ tx; eip3009? }`. Con widening aditivo (método-bivarianza param + covarianza return) **sigue satisfaciendo el port sin cambios**. **NO se toca.** | `src/test-support/fakes.ts:253-275` |
| AH-4 | Exemplar del adapter EVM: `InjectedWallet.authorizePrincipal` (`wallet.ts:84-151`). Patrones: guard fail-loud `wallet_not_connected` (L90), fail-loud `deposit_address_missing` sin `deposit.address` (L100), `isParseableIso(quote.expiresAt)` + throw `quote_expires_at_invalid` (L103), `String(quote.send.minor)` (L137), `deterministicNonce(remittanceId, quote.quoteId)` (L102). **BYTE-IDÉNTICO — NO se toca.** | `src/infrastructure/wallet.ts:84-151` |
| AH-5 | Patrón lazy-import de lib pesada: `const { EthereumProvider } = await import("@walletconnect/ethereum-provider")` DENTRO del método (`wallet.ts:200`). Se replica para anchor/spl-token/web3.js. | `src/infrastructure/wallet.ts:200` |
| AH-6 | Exemplar del resolver nuevo: `resolveSolanaUsdcMint()` (`chain.ts:135-144`) — env-driven, valida con `new PublicKey(raw)` en try/catch, fail-loud `solana_usdc_mint_not_configured`. **NUNCA** `isAddress` de viem. `PublicKey` ya se importa en `chain.ts`. | `src/infrastructure/chain.ts:135-144, 6` |
| AH-7 | `resolveSolanaNetworkConfig().cluster === "devnet"`. La Connection del **browser** usa `clusterApiUrl(resolveSolanaNetworkConfig().cluster)`, **NUNCA** `resolveSolanaRpcUrl()` (server-only → undefined en browser). | `src/infrastructure/chain.ts:129-131, 146-152` |
| AH-8 | `SolanaWalletAdapter` (HU-SOL-4) hoy: `connect()`/`getAddress()` reales vía `solanaWalletBridge`; `authorizePrincipal(_quote): Promise<{ tx: string }>` **demo** (`return { tx: solana-demo-... }`, L37-39) = **lo que ESTA HU reemplaza**. Importa `PublicKey` de `@solana/web3.js` estático (OK, baseline). **NO importa `@solana/wallet-adapter-*`** (seam AC-3 de HU-SOL-4 — respetalo). | `src/infrastructure/solana-wallet.ts:11-44` |
| AH-9 | El bridge singleton `solanaWalletBridge` (HU-SOL-4) hoy expone `getState()`, `openModal()`, `waitForConnection()`, `cancelConnection()`, `reset()`, `setState()`, `registerOpenModal()`. **HOY NO expone `signTransaction`.** ⇒ Esta HU debe **extenderlo aditivamente** (fallback (b) del SDD §4.5). Ver W2.0. **NO tocar `connect`/`getAddress`/el core del deferred.** | `src/infrastructure/solana-wallet-bridge.ts:1-96` |
| AH-10 | El IDL `escrow.json` está en el repo **EXTERNO** `/home/ferdev/.openclaw/workspace/solana-programs/target/idl/escrow.json` — **NO dentro de chaski-v3**. No se puede `import` por path relativo desde `src/`. ⇒ Se **embebe una copia pinneada** dentro de chaski-v3 (W0.4, resuelve el `[TBD F3]` §11 del SDD). | `find` 2026-07-21 |
| AH-11 | Estructura REAL de la ix `deposit` (leída del IDL): discriminator `[242, 35, 198, 137, 82, 225, 242, 182]`; args (orden exacto) `remittance_id: [u8;16]`, `beneficiary: pubkey`, `authority: pubkey`, `amount: u64`, `deadline: i64`; accounts (orden exacto): `sender`(signer,writable), `mint`(-), `escrow_state`(writable,PDA), `vault`(writable,PDA), `sender_ata`(writable), `token_program`(addr `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`), `associated_token_program`(addr `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`), `system_program`(addr `11111111111111111111111111111111`). **NO declara account `reference`** → va en `remainingAccounts` (AC-4). | IDL leído íntegro |
| AH-12 | PDA `escrow_state`: seeds `[b"escrow", sender.toBuffer(), remittance_id(16 bytes)]`. `vault`: ATA `getAssociatedTokenAddressSync(mint, escrow_state, /*allowOwnerOffCurve*/ true)`. `sender_ata`: `getAssociatedTokenAddressSync(mint, sender)`. | IDL + SDD §4.4 |
| AH-13 | `@coral-xyz/anchor` **AUSENTE** de `package.json`. Se agrega PINNEADA `0.30.1` (sin `^`). `@solana/web3.js` presente `^1.98.4`. `@solana/spl-token` lo aporta HU-SOL-4 (`0.4.15`). **`@solana/pay` PROHIBIDO** (CD-SDD-13). | `package.json` + `npm view` 2026-07-21 |
| AH-14 | Gate de cada wave = `npm run qa` (= `tsc --noEmit` + `vitest run`), **NUNCA** `next build` (excluye tests — lección WKH-196/WKH-210). Baseline pre-HU: exit 0, 48 files / 562 tests (los `stderr` de ramas best-effort son deliberados, no fallos). | SDD §3 / CD-SDD-10 |

---

## Acceptance Criteria (EARS — copiados del SDD, QA los valida en F4)

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
  (dispatch en `container.ts` de HU-SOL-4; esta HU aporta el `authorizePrincipal` real).
- **AC-7**: IF no hay wallet Solana conectada (`getAddress()` → `null`) al armar el deposit, THEN THE
  system SHALL fallar fail-loud (throw) sin construir ni firmar una tx parcial.
- **AC-8**: THE system SHALL derivar `amount`/`deadline` de datos canónicos (`Money.minor` /
  `quote.expiresAt` en unix seconds), sin floats.

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `package.json` | Modificar | Agregar `@coral-xyz/anchor` PINNEADA **`0.30.1`** (sin `^`/`~`). `npm install`. Re-verificar que resuelve limpio POST-merge de HU-SOL-4; si no → fallback manual (W1, DT-SDD-6). **NO** agregar `@solana/pay`. | línea de `@solana/web3.js` |
| 2 | `src/application/ports.ts` | Modificar (ADITIVO) | Tipos `SolanaEscrowDeposit` + `SolanaPrincipalAuthorization`; widening opcional del param (`escrow?`) y del return (`solana?`) de `authorizePrincipal`. | `ports.ts:142-159, 218-235` |
| 3 | `src/infrastructure/chain.ts` | Modificar (ADITIVO) | Export `resolveSolanaFacilitatorPubkey(): string` (env `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`, valida `new PublicKey`, fail-loud). | `chain.ts:135-144` |
| 4 | `src/infrastructure/solana/escrow-idl.ts` | **Crear** | Copia PINNEADA del IDL `escrow.json` (repo externo) como `const` TS tipado + export. Resuelve el `[TBD F3]` (AH-10). | IDL externo leído |
| 5 | `src/infrastructure/solana-wallet.ts` | Modificar | Reemplazar el `authorizePrincipal` demo por el real (§Código W1/W2). `connect()`/`getAddress()`/`signMessage()` **NO se tocan**. Lazy-import anchor/spl-token/web3.js. | `wallet.ts:84-151` + AH-8 |
| 6 | `src/infrastructure/solana-wallet-bridge.ts` | Modificar (ADITIVO) | Agregar SÓLO un handle `signTransaction` (registrar + exponer). **NO tocar** connect/getAddress/deferred. Sólo si HU-SOL-4 no lo trae ya (W2.0 lo verifica). | AH-9 |
| 7 | `src/infrastructure/solana-wallet.test.ts` | Modificar (extender) | Tests nuevos de `authorizePrincipal` real (AC-1..AC-4, AC-7, AC-8) + mutation self-check. Los de connect/getAddress NO se tocan. | `wallet.test.ts` |

**NO se toca (byte-idéntico):** `wallet.ts`, `container.ts`, `confirm-and-send.ts`, `pickWallet()`,
`facilitator-client.ts`, `fakes.ts`, ni ningún test EVM. **NO se crea** ningún archivo fuera de esta tabla.
El programa/IDL en el repo externo `solana-programs/` es INMUTABLE (CD-5) — sólo se COPIA su IDL (#4).

---

## Contrato de salida (data-contract con HU-SOL-14, Scope OUT)

> Esta HU NO hace ninguna llamada HTTP (el POST al facilitator es HU-SOL-14). Sólo **define la forma
> del payload** que retorna `authorizePrincipal` para que HU-SOL-14 lo consuma. Es el único "contrato
> de integración" relevante — es un contrato de DATOS, no de red.

`authorizePrincipal(...)` retorna (variante Solana, ADITIVA):

```ts
{
  tx: string;                    // = partialSignedTx (base64) — compat con el shape base del port
  solana: {
    vm: "solana";
    partialSignedTx: string;     // tx legacy serializada base64, partial-signed (feePayer=facilitator,
                                 //   firma SÓLO wallet; falta la firma del facilitator que pone HU-SOL-14)
    reference: string;           // Pubkey base58 de la reference (trazabilidad off-chain)
  }
  // eip3009?: NO se setea en el path Solana
}
```

- `partialSignedTx` se serializa con `serialize({ requireAllSignatures: false, verifySignatures: false })`
  → base64 (la firma del facilitator falta a propósito; la agrega HU-SOL-14 al broadcastear).
- El caller (HU-SOL-13/flow) persiste `reference` para que el verifier/facilitator la watchee.

---

## Constraint Directives

### OBLIGATORIO
- **CD-SDD-1** (AC-3): `SolanaWalletAdapter` **NUNCA** llama `sendTransaction`/`sendRawTransaction`. Sólo
  partial-sign + serialización + return.
- **CD-SDD-2** (AC-1/CD-3): el deposit va SIEMPRE al **vault del escrow** (PDA `escrow_state` / ATA
  derivada), NUNCA a un address estático de TransFi.
- **CD-SDD-3** (AC-8): `amount = new anchor.BN(String(quote.send.minor))` y
  `deadline = new anchor.BN(Math.floor(Date.parse(quote.expiresAt) / 1000))` — **cero floats**,
  `String(...)` NUNCA `Number(...)` (lección WKH-196: precisión uint).
- **CD-SDD-4** (CD-6): program id (del `idl.address`), mint (`resolveSolanaUsdcMint`) y facilitator
  (`resolveSolanaFacilitatorPubkey`) son env-driven / del IDL — **PROHIBIDO hardcodear**.
- **CD-SDD-5** (AC-2): `feePayer = new PublicKey(resolveSolanaFacilitatorPubkey())`; la tx se firma
  **SÓLO** con la wallet (`bridge.signTransaction`). El adapter NO tiene ni conoce claves del facilitator.
- **CD-SDD-6** (AC-4): la `reference` va como cuenta **no-signer / no-writable** en `remainingAccounts`,
  SIN agregarla a los `.accounts` del IDL.
- **CD-SDD-7**: validar TODAS las Pubkey con `new PublicKey()` de `@solana/web3.js` — **NUNCA** `isAddress`
  de viem.
- **CD-SDD-9** (Auto-Blindaje WKH-211): importar tipos de dominio desde su módulo real. `WalletPort` de
  `ports`, `Quote` de `domain/remittance`. Los tipos NUEVOS `SolanaEscrowDeposit`/`SolanaPrincipalAuthorization`
  se DEFINEN y EXPORTAN en `ports.ts` (son contrato del port).
- **CD-SDD-10** (Auto-Blindaje WKH-196/210): el gate es `npm run qa` COMPLETO, NUNCA `next build`.
- **CD-SDD-11** (Auto-Blindaje WKH-211): widening ADITIVO, todo lo nuevo OPCIONAL. Cero cambios de
  expectativa en tests EVM. El guard `escrow` va JUNTO al guard de wallet-conectada (AC-7 primero).

### PROHIBIDO
- **CD-SDD-8** (CD-8): PROHIBIDO inventar/asumir un `beneficiary`/`authority` default — sin ellos, fail-loud
  (`escrow_params_missing`).
- PROHIBIDO tocar `wallet.ts`, `pickWallet()`, `container.ts` (dispatch), `confirm-and-send.ts`,
  `facilitator-client.ts`, `fakes.ts`, ni ningún test EVM (AC-5).
- PROHIBIDO redefinir `connect()`/`getAddress()`/`signMessage()` del `SolanaWalletAdapter` ni el core del
  `solana-wallet-bridge.ts` (son de HU-SOL-4; SÓLO se PERMITE agregar aditivamente el handle
  `signTransaction` si HU-SOL-4 no lo trae).
- PROHIBIDO modificar el programa/IDL en el repo externo `solana-programs/` (CD-5) — sólo se COPIA su IDL.
- PROHIBIDO usar `resolveSolanaRpcUrl()` para la Connection del browser (server-only → undefined). El
  endpoint sale de `clusterApiUrl(resolveSolanaNetworkConfig().cluster)`.
- PROHIBIDO importar `@solana/wallet-adapter-*` desde `solana-wallet.ts` (seam de HU-SOL-4). La firma la
  aporta el handle del bridge.
- PROHIBIDO convertir el widening de `WalletPort` en args/campos REQUERIDOS (rompería EVM).
- **CD-SDD-13**: PROHIBIDO `@solana/pay` (peer-conflict Kit v2 vs Kit v1). `reference` con `@solana/web3.js`
  (`Keypair.generate().publicKey`).
- PROHIBIDO agregar deps fuera de `@coral-xyz/anchor@0.30.1`; PROHIBIDO `^`/`~` en ella (pin).

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO — verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3

# 1) PRE-REQUISITO DURO: HU-SOL-4 mergeada (adapter + bridge + deps existen en el branch base)
ls src/infrastructure/solana-wallet.ts src/infrastructure/solana-wallet-bridge.ts \
   src/infrastructure/solana-wallet.test.ts 2>&1 || echo "FALTA HU-SOL-4 → PARAR"
grep -q '"@solana/spl-token"' package.json && echo "spl-token OK" || echo "FALTA @solana/spl-token (HU-SOL-4) → PARAR"

# 2) El IDL externo existe (fuente de la copia pinneada #4)
ls /home/ferdev/.openclaw/workspace/solana-programs/target/idl/escrow.json 2>&1 || echo "FALTA IDL externo → PARAR"

# 3) @solana/web3.js presente (baseline)
grep -q '"@solana/web3.js"' package.json && echo "web3.js OK" || echo "FALTA web3.js → PARAR"

# 4) Baseline verde ANTES de tocar nada
npm run qa   # DEBE ser exit 0 (48 files / 562 tests). Si no → PARAR y reportar.
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador. En particular, si el adapter/bridge/deps
de HU-SOL-4 NO están → HU-SOL-4 no está mergeada → **no se puede empezar** (pre-requisito duro).

---

### Wave 0 (Serial Gate — contratos/deps/IDL, EVM verde)

- [ ] **W0.1** — `package.json`: agregar `@coral-xyz/anchor` PINNEADA `0.30.1` (sin `^`/`~`) en
  `dependencies`. `npm install`. Verificar que resuelve limpio (los warns `@keystonehq/sdk`→`qrcode.react`
  react 17 vs 19 son ruido transitivo pre-existente, no de anchor). Si anchor NO resuelve post-merge →
  activar el fallback manual en W1 (DT-SDD-6) y escalar la nota al orquestador. **NO** `@solana/pay`.

- [ ] **W0.2** — `ports.ts`: widening ADITIVO. Agregar los tipos y extender el método (todo opcional):

  ```ts
  /** Datos del escrow que el CALLER (HU-SOL-13) resuelve y pasa a la wallet Solana. base58. */
  export interface SolanaEscrowDeposit {
    beneficiary: string; // Pubkey base58 — destino de la remesa (release). Resuelto por HU-SOL-13.
    authority: string;   // Pubkey base58 — quien puede release/refund. Resuelto por HU-SOL-13.
    mint?: string;       // opcional: override del mint; default resolveSolanaUsdcMint() (CD-SDD-4).
  }

  /** Variante Solana del retorno de authorizePrincipal (envelope, alineada con SolanaAuthorization). */
  export interface SolanaPrincipalAuthorization {
    vm: "solana";
    partialSignedTx: string; // tx legacy serializada base64, partial-signed (feePayer=facilitator, firma wallet-only)
    reference: string;       // Pubkey base58 de la reference (trazabilidad)
  }
  ```

  Y en `WalletPort.authorizePrincipal` (aditivo — el resto del método intacto):

  ```ts
  authorizePrincipal(
    quote: Quote,
    remittanceId: string,
    deposit?: { address: string; escrow?: SolanaEscrowDeposit }, // escrow? = ADITIVO (Solana)
  ): Promise<{
    tx: string;
    eip3009?: { authorization: Eip3009Authorization; signature: string };
    solana?: SolanaPrincipalAuthorization; // ADITIVO (Solana)
  }>;
  ```

  > **NO** convertir en union top-level el return (rompería el destructuring de `confirm-and-send.ts:182`).
  > `solana?` opcional + su discriminante interno `vm:"solana"` preserva byte-identidad EVM.

- [ ] **W0.3** — `chain.ts`: agregar el resolver (espejando `resolveSolanaUsdcMint`, `chain.ts:135-144`):

  ```ts
  /** Pubkey del facilitator Solana (feePayer). ÚNICA fuente (env NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY);
   *  fail-loud si falta/malformado. Valida con PublicKey (base58), NUNCA con isAddress de viem. */
  export function resolveSolanaFacilitatorPubkey(): string {
    const raw = process.env.NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY;
    if (!raw) throw new Error("solana_facilitator_not_configured");
    try {
      new PublicKey(raw);
    } catch {
      throw new Error("solana_facilitator_not_configured");
    }
    return raw;
  }
  ```

  Los resolvers EVM/Solana existentes quedan byte-idénticos.

- [ ] **W0.4** — Crear `src/infrastructure/solana/escrow-idl.ts`: copia PINNEADA del IDL externo
  (`/home/ferdev/.openclaw/workspace/solana-programs/target/idl/escrow.json`) como `const` TS exportado.
  Es un artefacto de HU-SOL-12 (inmutable); se COPIA, no se edita. Tipar como `anchor.Idl` (lazy-cast en
  el adapter) o `as const`. El `address` del IDL (`BBQ9…79WA`) es la ÚNICA fuente del program id (CD-SDD-4).

  > **Verificación obligatoria:** el IDL copiado debe traer, en la ix `deposit`, el discriminator
  > `[242, 35, 198, 137, 82, 225, 242, 182]`, los args `remittance_id[u8;16]`/`beneficiary`/`authority`/
  > `amount(u64)`/`deadline(i64)` en ese orden, y los 8 accounts del IDL (ver AH-11). Si el IDL externo
  > difiere de AH-11 → PARAR y escalá (el programa cambió).

- [ ] **Gate W0**: `npm run qa` verde. `wallet.test.ts`/`fakes.ts`/`confirm-and-send.test.ts`/`container.test.ts`
  byte-idénticos (cero cambio de expectativa). EVM 100% intacto.

---

### Wave 1 (Armado de la ix `deposit` desde el IDL — reemplaza el demo)

- [ ] **W1.1** — en `solana-wallet.ts`, reemplazar el body demo de `authorizePrincipal` (AH-8) por el real.
  Firma nueva: `authorizePrincipal(quote: Quote, remittanceId: string, deposit?: { address: string; escrow?: SolanaEscrowDeposit })`.
  Esta wave cubre GUARDS + args canónicos + PDAs/ATAs + reference + build de la ix (sin firmar aún):

  ```
  // ── GUARDS fail-loud (AC-7/CD-SDD-8) — ANTES de construir/firmar nada ──
  const sender = await this.getAddress();                 // base58 del bridge (HU-SOL-4)
  if (!sender) throw new Error("wallet_not_connected");    // AC-7
  if (!deposit?.escrow?.beneficiary || !deposit?.escrow?.authority)
      throw new Error("escrow_params_missing");            // CD-SDD-8

  // ── lazy-import (DT-SDD-8, patrón wallet.ts:200) ──
  const { PublicKey, Transaction, Connection, clusterApiUrl, Keypair } = await import("@solana/web3.js");
  const anchor = await import("@coral-xyz/anchor");
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const { escrowIdl } = await import("./solana/escrow-idl"); // la copia pinneada (W0.4)

  // ── Pubkeys (CD-SDD-7, validan base58) ──
  const senderPk      = new PublicKey(sender);
  const beneficiaryPk = new PublicKey(deposit.escrow.beneficiary);
  const authorityPk   = new PublicKey(deposit.escrow.authority);
  const mintPk        = new PublicKey(deposit.escrow.mint ?? resolveSolanaUsdcMint());   // CD-SDD-4
  const programId     = new PublicKey((escrowIdl as { address: string }).address);       // BBQ9…79WA, CD-SDD-4

  // ── Args canónicos (AC-8/CD-SDD-3) — String(...) NO Number(...) ──
  const remittanceIdBytes = remittanceIdToBytes16(remittanceId); // [u8;16] DETERMINÍSTICO (DT-SDD-5)
  const amount = new anchor.BN(String(quote.send.minor));        // u64, sin floats
  if (!isParseableIso(quote.expiresAt)) throw new Error("quote_expires_at_invalid");
  const deadline = new anchor.BN(Math.floor(Date.parse(quote.expiresAt) / 1000)); // i64 unix seconds

  // ── PDAs / ATAs (AC-1) ──
  const [escrowStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), senderPk.toBuffer(), Buffer.from(remittanceIdBytes)], programId);
  const vault     = getAssociatedTokenAddressSync(mintPk, escrowStatePda, /*allowOwnerOffCurve*/ true);
  const senderAta = getAssociatedTokenAddressSync(mintPk, senderPk);

  // ── reference (AC-4/CD-SDD-13) — Pubkey único, @solana/web3.js, NO @solana/pay ──
  const reference = Keypair.generate().publicKey; // la privada se DESCARTA (nunca firma)

  // ── Build ix (AC-1/AC-4) — vía anchor Program (recomendado) ──
  const connection = new Connection(clusterApiUrl(resolveSolanaNetworkConfig().cluster)); // devnet (browser)
  const program = new anchor.Program(escrowIdl as anchor.Idl, { connection });            // 0.30: programId del idl.address
  const ix = await program.methods
    .deposit(Array.from(remittanceIdBytes), beneficiaryPk, authorityPk, amount, deadline)
    .accounts({ sender: senderPk, mint: mintPk, senderAta })  // PDAs las deriva anchor del IDL; ver nota
    .remainingAccounts([{ pubkey: reference, isSigner: false, isWritable: false }])        // AC-4
    .instruction();
  ```

  **`remittanceIdToBytes16(remittanceId)`** (helper privado, DT-SDD-5): produce `[u8;16]` DETERMINÍSTICO
  (ej. `sha256(remittanceId)` truncado a 16 bytes; usar `createHash` de `node:crypto` o el equivalente ya
  presente en el repo). **Reproducible** por el verifier server-side (HU-SOL-13) que re-deriva la PDA.
  NUNCA `Math.random`. Es canónico de esta HU — documentar el algoritmo en un comment.

  **Nota `.accounts(...)` (verificar en F3, `[TBD]` §4.4 del SDD):** en Anchor 0.30 los PDAs con seeds
  declarados en el IDL (`escrow_state`, `vault`) y los program-accounts con `address` fijo (`token_program`,
  `associated_token_program`, `system_program`) los **auto-resuelve el builder**. Si al correr los tests
  anchor **exige** `escrowState`/`vault` explícitos → pasarlos con los valores ya derivados arriba
  (`escrowState: escrowStatePda`, `vault`). No inventes accounts fuera de AH-11.

  **FALLBACK MANUAL (DT-SDD-6 — SÓLO si `@coral-xyz/anchor` NO resuelve post-merge de HU-SOL-4):** armar la
  ix con `TransactionInstruction` de `@solana/web3.js`:
  - `data = Buffer.concat([ DISCRIMINATOR, borsh(remittance_id[16], beneficiary(32), authority(32), amount_u64_LE, deadline_i64_LE) ])`,
    con `DISCRIMINATOR = Buffer.from([242,35,198,137,82,225,242,182])` (del IDL, == `sha256("global:deposit")[:8]`).
  - `keys` (orden AH-11): `sender`(s,w), `mint`(-,-), `escrowStatePda`(-,w), `vault`(-,w), `senderAta`(-,w),
    `TOKEN_PROGRAM_ID`(-,-), `ASSOCIATED_TOKEN_PROGRAM_ID`(-,-), `SystemProgram.programId`(-,-),
    `reference`(-,-) ← al final, no-signer/no-writable (AC-4).
  - `ix = new TransactionInstruction({ programId, keys, data })`. Misma tx resultante.

- [ ] **Gate W1**: `npm run qa` verde. El test de armado de la ix (AC-1/AC-4/AC-8) passing; EVM intacto.

---

### Wave 2 (feePayer + partial-sign + serialización — SIN broadcast)

- [ ] **W2.0** — Verificar si `solanaWalletBridge` ya expone `signTransaction` (post-merge de HU-SOL-4).
  - Si **SÍ** → sólo consumirlo. NO tocar el bridge.
  - Si **NO** (estado actual, AH-9) → extender `solana-wallet-bridge.ts` ADITIVAMENTE: agregar un handle
    `private signTxHandle: ((tx) => Promise<...>) | null`, un `registerSignTransaction(fn)` (lo llama el
    `SolanaWalletBridgeSync` component capturando `useWallet().signTransaction`) y un
    `signTransaction(tx): Promise<Transaction>` que hace `if (!this.signTxHandle) throw new Error("wallet_sign_not_available"); return this.signTxHandle(tx);`. **NO tocar** connect/getAddress/deferred/`reset()`
    (sí incluir el nuevo handle en el `reset()` para tests). Tipar el tx como `unknown`/genérico para no
    importar `@solana/web3.js` types si complica el seam — evaluar en F3, sin romper el seam de HU-SOL-4.

- [ ] **W2.1** — en `solana-wallet.ts`, tras construir la `ix` (W1): fijar feePayer + blockhash +
  partial-sign + serializar + return:

  ```
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction().add(ix);
  tx.feePayer = new PublicKey(resolveSolanaFacilitatorPubkey());   // AC-2: facilitator paga el fee de red
  tx.recentBlockhash = blockhash;

  const signed = await solanaWalletBridge.signTransaction(tx);     // AC-2: partial-sign SÓLO wallet (bridge)
  const serialized = signed
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  // AC-3/CD-SDD-1: NUNCA connection.sendRawTransaction / sendTransaction acá.

  return {
    tx: serialized,
    solana: { vm: "solana", partialSignedTx: serialized, reference: reference.toBase58() },
  };
  ```

- [ ] **Gate W2**: `npm run qa` verde. Tests AC-2 (feePayer + firma wallet-only) + AC-3 (no broadcast) passing.

---

### Wave 3 (Tests + mutation self-check + regresión EVM)

- [ ] **W3.1** — `solana-wallet.test.ts`: agregar `describe`/`it` por AC (bridge fake + Connection mock del
  blockhash + anchor REAL para armar/asertar la ix). Ver §Test Expectations. Los tests de connect/getAddress
  de HU-SOL-4 NO se tocan.

- [ ] **W3.2** — Regresión EVM (AC-5): correr `wallet.test.ts`, `confirm-and-send.test.ts`, `container.test.ts`,
  `flow.test.tsx` — todos VERDES **sin cambio de expectativa**. Confirmar 0 diffs en esos archivos.

- [ ] **W3.3** — **Mutation self-check (CD-SDD-12) — OBLIGATORIO.** Hacé backup del adapter en el scratchpad
  (`/tmp/claude-1000/.../scratchpad`, NO `git checkout`). Montá 4 mutantes UNO A UNO y confirmá que ≥1 test
  MUERE por cada uno; restaurá desde el backup entre cada uno:
  - (a) `tx.feePayer = senderPk` (en vez del facilitator) → debe morir el test AC-2.
  - (b) `reference` con `isSigner: true` (o `isWritable: true`) → debe morir el test AC-4.
  - (c) agregar `await connection.sendRawTransaction(serialized)` → debe morir el test AC-3.
  - (d) quitar el guard `!sender` (o `!deposit?.escrow`) → debe morir el test AC-7.

  Al cerrar: `grep -rn MUTANT src app` = 0 (sin restos). Restauración desde backup, NO `git checkout`.

- [ ] **Gate W3**: `npm run qa` verde full. `@coral-xyz/anchor` resuelto (o fallback manual activo).

---

### Verificación Incremental

| Wave | Verificación al completar |
|------|--------------------------|
| W-1 | Pre-req HU-SOL-4 + IDL externo + baseline verde |
| W0 | `npm run qa` verde; EVM byte-idéntico |
| W1 | `npm run qa` verde; ix armada (AC-1/AC-4/AC-8) |
| W2 | `npm run qa` verde; feePayer + partial-sign + no-broadcast (AC-2/AC-3) |
| W3 | `npm run qa` verde full + mutation self-check (4 mutantes matan) + EVM 0-diff |

---

## Test Expectations

| Test (`solana-wallet.test.ts`) | ACs / CD | Framework | Tipo |
|--------------------------------|----------|-----------|------|
| Arma la ix `deposit`: programId `BBQ9…79WA`, discriminator correcto, args `remittance_id`(16)/`beneficiary`/`authority`/`amount`/`deadline`, accounts del IDL (escrow_state PDA, vault ATA, sender_ata, programs) | **AC-1** | vitest | unit |
| `tx.feePayer === resolveSolanaFacilitatorPubkey()`; `bridge.signTransaction` llamado 1×; ninguna clave del facilitator interviene | **AC-2, CD-SDD-5** | vitest | unit |
| `connection.sendRawTransaction`/`sendTransaction` NUNCA llamados (spy = 0); return trae `solana.partialSignedTx` base64 + `reference` base58 | **AC-3, CD-SDD-1** | vitest | unit |
| `reference` presente como cuenta `isSigner:false,isWritable:false` (remainingAccount); los accounts del IDL NO cambian | **AC-4, CD-SDD-6** | vitest | unit |
| Sin wallet (`getAddress()`→null) → throw `wallet_not_connected` SIN construir/firmar; sin `escrow` → throw `escrow_params_missing` | **AC-7, CD-SDD-8** | vitest | unit |
| `amount` = `new BN(String(quote.send.minor))` (u64, sin float); `deadline` = `floor(Date.parse(expiresAt)/1000)`; `expiresAt` inválido → throw | **AC-8, CD-SDD-3** | vitest | unit |
| Path EVM: `wallet.test.ts`/`confirm-and-send.test.ts`/`container.test.ts` VERDES, misma expectativa (0-diff) | **AC-5** | vitest | regresión |
| Mutation self-check (feePayer / reference-signer / no-broadcast / fail-loud) — 4 mutantes matan ≥1 test c/u | **CD-SDD-12** | manual | verificación |

**Criterio Test-First:** lógica de negocio (armado de ix, firma, serialización) → **SÍ test-first**.

**Setup de test (patrón):** bridge fake que devuelve un `Transaction` "firmado" desde `signTransaction`;
Connection mockeada para `getLatestBlockhash` (blockhash fijo — NUNCA pegar a devnet en el test); `anchor`
REAL para construir/inspeccionar la ix (programId/keys/data); spy sobre `sendRawTransaction`/`sendTransaction`
= 0 calls.

---

## Out of Scope (NO tocar bajo ninguna circunstancia)

- Broadcast gasless real / cliente HTTP del facilitator Solana → **HU-SOL-14**.
- Verificación server-side del vault → **HU-SOL-13**.
- Resolución de negocio de `beneficiary`/`authority` (mapeo TransFi→Solana) → **HU-SOL-13** (llegan resueltos).
- PoP ed25519 → **HU-SOL-8**.
- `connect()`/`getAddress()`/`signMessage()`/el core del bridge/`pickWallet()`/dispatch de `container.ts` → **HU-SOL-4**.
- Cerrar el `[TBD HU-SOL-2]` de `SolanaAuthorization` en `ports.ts`.
- mainnet-beta; el programa/IDL escrow en `solana-programs/` (repo externo, sólo se COPIA el IDL).
- NO "mejorar" código EVM adyacente. NO agregar funcionalidad no listada. NO agregar deps fuera de `@coral-xyz/anchor@0.30.1`.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala al Architect.** No inventar, no asumir, no improvisar.

Situaciones de escalation:
- El adapter/bridge/deps de HU-SOL-4 NO están en el branch base (HU-SOL-4 no mergeada) → **PARAR** (pre-req duro).
- El IDL externo difiere de AH-11 (el programa cambió) → PARAR.
- `@coral-xyz/anchor@0.30.1` NO resuelve limpio post-merge y el fallback manual tampoco → escalar.
- Anchor 0.30 exige accounts que el IDL no auto-deriva y no coinciden con AH-11/AH-12 → escalar.
- El bridge de HU-SOL-4 no expone `signTransaction` y extenderlo aditivamente rompería su seam → escalar.
- Un test EVM cambia de expectativa para pasar → PARAR (es violación de AC-5, no un fix).
- El cambio requiere tocar archivos fuera de la tabla "Files to Modify/Create" → escalar.

---

*Story File generado por NexusAgil — F2.5 — HU-SOL-5 / WKH-207\* (Solana LATAM Labs)*
