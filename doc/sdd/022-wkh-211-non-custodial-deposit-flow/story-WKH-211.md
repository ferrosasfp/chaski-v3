# Story File — WKH-211: Value-delivery no-custodial (el USDC va directo al `depositAddress` de TransFi)

> Contrato autocontenido para el Dev. Generado por nexus-architect (F2.5) DESPUÉS de SPEC_APPROVED.
> Fuente: `sdd.md` (SDD #022, 7 waves, DT-1..DT-8) + `work-item.md` (8 ACs). NO reabrir el SDD.
> Branch: `feat/022-wkh-211-non-custodial-deposit-flow`.
> **Esta es la HU de seguridad money-path más delicada del repo. Leé la sección "⚠️ ADVERTENCIA CRÍTICA" ANTES de tocar nada.**

---

## ⚠️ ADVERTENCIA CRÍTICA PARA EL DEV (leer primero)

1. **NUNCA aceptes un `to` (destino de la firma EIP-3009) que no haya sido ATESTADO criptográficamente por el server.** El `to` deja de ser un env fijo y pasa a ser dinámico por remesa. La única forma legítima de que la wallet firme un `depositAddress` es que venga de una `DepositAttestation` HMAC emitida server-side. Si en algún punto el `to` puede venir del body/UI sin verificar el HMAC → es el bug exacto (desvío de fondos) que esta HU vino a cerrar. PARÁ.
2. **Si el reorder parece debilitar CUALQUIER guard existente** (V1-V9 de settle, guard 8 de submit, autoridad KYC, PoP, ledger) → PARÁ y marcá `[STORY-GAP]` en tu reporte. NO improvises un "ajuste sobre la marcha". El guard 8 de `submit/route.ts` NO SE TOCA (CD-3).
3. **Ningún test dispara plata real ni una orden TransFi real** (CD-1/AC-4). Todo mockeado. `mockImplementation`, nunca `mockResolvedValue` a secas para gateways (mutation self-check lo exige).
4. **Flags OFF = código muerto byte-idéntico.** Con `NEXT_PUBLIC_EIP3009_ENABLED` off (default), el demo/mock debe quedar byte-a-byte igual a pre-HU (AC-5). El `git diff` del path demo debe ser vacío en comportamiento.

---

## 1. Contexto mínimo (qué se construye y por qué)

Hoy el sender firma `transferWithAuthorization(to = NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS)` — un receiver estático de plataforma (custodial). Esta HU cierra el principio **no-custodial** ("WasiAI NUNCA custodia el USDC"): el sender firma **directo al `depositAddress` que TransFi asigna por orden**.

Para que volver el `to` dinámico NO abra un vector de desvío de fondos, se introduce el **binding = Opción B** (gate cerrado por el founder, NO se reabre):

- Un endpoint nuevo `POST /api/payout/prepare` crea la orden TransFi (invoca al agente) y emite una **`DepositAttestation` HMAC** que ata `remittanceId + quoteId + depositAddress + chainId + exp`, **ANTES** de que el cliente firme.
- La wallet firma `to = depositAddress` (de la atestación).
- El guard reescrito de `/api/settle/principal` verifica la atestación (HMAC + binding + no vencida) y usa `expectedTo = att.depositAddress` para V1-V9 **on-chain intacta**.

**Todo es código muerto sin `NEXT_PUBLIC_EIP3009_ENABLED=true` (cliente) + `DEPOSIT_ATTESTATION_SECRET` (server).** Sandbox/testnet only, cero plata real (CD-1). El `depositAddress` real (no-null) exige el agente con `TRANSFI_ADAPTER_READY=true` — vive en el repo del agente (WKH-212 ya lo expone, `3d5d1cf`).

---

## 2. Scope IN — archivos exactos a tocar (exhaustivo)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `src/infrastructure/settlement/deposit-attestation.ts` | **Crear** | W0 |
| 2 | `src/application/ports.ts` | Modificar | W0 |
| 3 | `app/api/payout/prepare/route.ts` | **Crear** | W1 |
| 4 | `src/infrastructure/settlement/http-payout-prepare-gateway.ts` | **Crear** | W1 |
| 5 | `src/infrastructure/fallback/gateways.ts` | Modificar (`FallbackPayoutPrepareGateway`) | W1 |
| 6 | `src/infrastructure/wallet.ts` | Modificar (ambas wallets) | W2 |
| 7 | `app/api/settle/principal/route.ts` | Modificar (guard reescrito) | W3 |
| 8 | `src/infrastructure/a2a/gateways.ts` | Modificar (wiring `depositAddress`) | W4 |
| 9 | `src/application/use-cases/confirm-and-send.ts` | Modificar (reorder) | W4 |
| 10 | `src/composition/container.ts` | Modificar (wiring flag-gated) | W4 |
| 11 | `supabase/migrations/2026...T000000_add_prepared_status.sql` | **Crear** (aditivo) | W5 |
| 12 | `src/infrastructure/persistence/supabase-settlement-ledger.ts` | Modificar (`recordOrderPrepared`) | W5 |
| 13 | `.env.example` | Modificar (`DEPOSIT_ATTESTATION_SECRET`) | W5 |
| 14 | tests (`*.test.ts`, ver W6) | Crear/Modificar | W6 |

**Scope OUT** (NO tocar): encender flags en cualquier entorno (CD-4); `wasiai-remittance-agents` (CD-5, WKH-212 cerrado); guard 8 de `submit/route.ts` (CD-3, INTACTO); webhook TransFi (WKH-210); cancelación real de órdenes huérfanas (follow-up); columna nueva en `remittance_settlements` (el `depositAddress` va en `receiver_address` existente).

---

## 3. Anti-Hallucination Checklist (verificado con Read por el Architect)

Todos los paths, firmas y contratos de abajo YA fueron verificados. NO inventes variantes.

- [ ] Exemplar HMAC: `src/infrastructure/settlement/attestation.ts` (existe, líneas 15-98). Clon exacto en forma.
- [ ] 2º exemplar HMAC: `src/infrastructure/auth/pop-challenge.ts` (existe, mirror byte-a-byte). Confirma que el molde se repite → la 3ª atestación lo sigue idéntico.
- [ ] Exemplar endpoint emisor HMAC: `app/api/a2a/payout/challenge/route.ts` (existe, 28-67): guard-order 501→rate-limit→body null-safe→isAddress→emite.
- [ ] Exemplar endpoint guards autoridad+PoP+forward: `app/api/a2a/payout/submit/route.ts` (existe, guards 1-8 en 62-334).
- [ ] Exemplar adapter cliente→ruta: `src/infrastructure/settlement/http-settlement-gateway.ts` (existe, 23-128): type-guards, `mapErrorStatus` fail-closed sin default permisivo, red-caída fail-closed.
- [ ] Exemplar fail-closed 501-vs-otros: `src/infrastructure/auth/http-pop-signer.ts` (existe, 16-31).
- [ ] Autoridad KYC: `resolvePayoutAuthority({verificationId, address})` en `src/infrastructure/payout/authority.ts` (existe, devuelve `{authorized, reason?, httpStatus}`; `simulated_dev` con `reason:"simulated_dev"`).
- [ ] PoP verify: `verifyPopChallenge(token, nowMs)` + `buildPopMessage(ch)` en `src/infrastructure/auth/pop-challenge.ts`; `verifyMessage` de viem (async, ERC-1271).
- [ ] Rate-limit: `checkRouteRateLimit(cfg, {ip})` + `clientIp(req)` + patrón `RouteRateLimitConfig` en `src/infrastructure/rate-limit.ts` (existe). Necesitás declarar `DEPOSIT_PREPARE_RL` acá (nuevo bucket, IP-only).
- [ ] `resolveChainId()` (fallback 84532, NUNCA tira) + `resolveReceiverAddress()` (fail-loud) + `resolveUsdcAddress()` en `src/infrastructure/chain.ts`.
- [ ] Wallet: `InjectedWallet.authorizePrincipal` firma con `resolveReceiverAddress()` en `wallet.ts:97` (usado en 117/133); `WalletConnectWallet` idéntico en `wallet.ts:251` (usado en 271/286). `eip3009Enabled()` en 29-31. `deterministicNonce` en 43-45.
- [ ] Settle: `S12 isAddressEqual(to, receiver)` en `route.ts:145`; `V1-V9 verifySettlementOnChain({expectedTo: receiver})` en 177-182; issue attestation 189-199; ledger 211-238.
- [ ] Confirm-and-send: `authorizePrincipal(quote, s.id)` en 120; settle 139-146; C5 en 181-191; `settlement?: {gateway, receiver}` en 42; `pop?` en 46; `markPrincipalIn` 197; `markPayoutSubmitted` 252.
- [ ] Gateways a2a: `RawPayoutResult` (29-36), `isValidPayoutShape` (57-70), `mapResultToPayoutRecord` (85-94) — **NO incluyen `depositAddress`** → hay que extender.
- [ ] Ledger: `SettlementLedgerStatus` (ports.ts:211-217) = `principal_in|submitted|settled|failed|forward_error|manual_review` — **SIN `prepared`**. `SettlementLedger` interface (237-...). `recordPrincipalIn` (76-103) exemplar del nuevo `recordOrderPrepared`.
- [ ] **CHECK constraint CONFIRMADO** (resuelve [TBD §3.3/W5.0]): `remittance_settlements_status_chk` en `supabase/migrations/20260716T000000_create_remittance_settlements.sql:19-20` lista los 6 estados actuales, **sin `prepared`** → migración aditiva OBLIGATORIA en W5. La migración es PENDING-DEPLOY (la aplica el founder, gated).
- [ ] Cross-repo (solo lectura, NO tocar): `CashoutPayoutOutput.depositAddress: string | null` YA expuesto por el agente (WKH-212).

---

## Wave 0 — Contratos/tipos (SERIAL GATE). Nada de W1-W6 arranca antes de que W0 pase `npx tsc --noEmit`.

### W0.1 — Crear `src/infrastructure/settlement/deposit-attestation.ts`

Clon EXACTO en forma de `attestation.ts` (mirror también de `pop-challenge.ts`). Contrato VERBATIM:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { isAddress } from "viem";

export interface DepositAttestation {
  remittanceId: string;   // no-vacío
  quoteId: string;        // no-vacío
  depositAddress: string; // 0x + 40 hex (isAddress)
  chainId: number;        // entero
  exp: number;            // epoch SEGUNDOS
}

// 10 min: acota la ventana de orden huérfana (DT-5). < 15 min del settlement (DT-4).
export const DEPOSIT_ATTESTATION_TTL_SECONDS = 10 * 60;

// Secreto NUEVO, SEPARADO de SETTLE_ATTESTATION_SECRET (DT-4: dominios distintos, jamás compartir).
// Leído DENTRO de la función (nunca top-level) para que vi.stubEnv funcione (CD-14).
function secret(): string {
  const s = process.env.DEPOSIT_ATTESTATION_SECRET;
  if (!s) throw new Error("DEPOSIT_ATTESTATION_SECRET missing"); // la route corta antes (503)
  return s;
}
```

- `issueDepositAttestation(p: DepositAttestation): string` → `${b64url(JSON.stringify(p))}.${b64url(hmac(b64urlPayload))}` (HMAC sobre el STRING b64url, no el JSON crudo — igual que attestation.ts:44-47).
- `verifyDepositAttestation(token: string, nowMs: number): DepositAttestation | null` — mirror byte-a-byte de `verifySettlementAttestation` (attestation.ts:54-98), EN ESTE ORDEN:
  1. `typeof token !== "string"` → null; split "." ; `parts.length !== 2` → null; ambas partes no vacías.
  2. `if (!process.env.DEPOSIT_ATTESTATION_SECRET) return null;` (la route ya cortó).
  3. **HMAC PRIMERO**, longitud-primero (`expected.length !== received.length → null`), luego `timingSafeEqual`.
  4. Parse en try/catch; `isRecord(parsed)` o null.
  5. Por-campo: `remittanceId` string no-vacío; `quoteId` string no-vacío; `depositAddress` string + `isAddress`; `chainId` number + `Number.isInteger`; `exp` number + `Number.isFinite`.
  6. `if (exp * 1000 <= nowMs) return null;`
  7. `return { remittanceId, quoteId, depositAddress, chainId, exp };`
- **NO hay claim-once** (DT-6: el binding es stateless; el nonce EIP-3009 determinístico hace el doble-settle contract-imposible; B3/B4/B5 matan el reuse). NO importar `attestation-store`.

### W0.2 — Modificar `src/application/ports.ts`

1. **Nuevo port** (después de `PrincipalSettlementGateway`):
```ts
export interface PayoutPrepareResult {
  depositAddress: string;
  attestation: string;
  payoutId: string;
  provenance: string;
}
export interface PayoutPrepareGateway {
  prepare(input: {
    remittanceId: string;
    quoteId: string;
    kycVerificationId: string;
    address: string;
    amountUsd: number;
    beneficiary: Beneficiary;
    idempotencyKey: string;
    popChallenge?: string;
    popSignature?: string;
  }): Promise<
    | { ok: true; result: PayoutPrepareResult }
    | { ok: false; reason: string }
  >;
}
```
2. **`WalletPort.authorizePrincipal`** — 3er arg opcional `deposit?: { address: string }`:
```ts
authorizePrincipal(
  quote: Quote,
  remittanceId: string,
  deposit?: { address: string },
): Promise<{ tx: string; eip3009?: { authorization: Eip3009Authorization; signature: string } }>;
```
   Regla fail-loud (NO fail-open): en modo real (`eip3009Enabled()`), `deposit` ausente/malformado → `throw` (W2). Opcional en el tipo solo para preservar la firma demo.
3. **`SettlementLedgerStatus`** — agregar `'prepared'`:
```ts
export type SettlementLedgerStatus =
  | 'prepared'   // WKH-211: orden TransFi creada, aún sin principal_in on-chain
  | 'principal_in' | 'submitted' | 'settled' | 'failed' | 'forward_error' | 'manual_review';
```
4. **`SettlementLedger`** — nuevo método `recordOrderPrepared` (firma; impl en W5):
```ts
recordOrderPrepared(input: {
  remittanceId: string;
  quoteId: string;
  idempotencyKey: string;
  depositAddress: string;   // → columna receiver_address (NO columna nueva)
  chainId: number;
  senderAddress: string;
  payoutId: string;
}): Promise<void>;
```
5. **`settlement` de ConfirmAndSend** — el `receiver` se remueve. Ver [SDD-GAP #1] abajo para la forma exacta del acople `settlement`/`prepare`.

**Gate W0**: `npx tsc --noEmit` (COMPLETO, incluye tests — lección WKH-196/MEMORY: `npm run build` excluye tests). Debe compilar aun con los impl pendientes (agregá stubs `throw new Error("not implemented")` si hace falta para tipar, y quitalos en su wave).

---

## Wave 1 — Endpoint prepare + adapters (depende de W0; paralelo a W2/W3)

### W1.1 — Crear `app/api/payout/prepare/route.ts`

Compone: guard-order de `challenge/route.ts` (501→rate-limit→body) + guards autoridad+PoP de `submit/route.ts`. **Body**: `{ remittanceId, quoteId, kycVerificationId, address, amountUsd, beneficiary, idempotencyKey, popChallenge?, popSignature? }`. **200**: `{ depositAddress, attestation, payoutId, provenance }`. Errores: enums opacos, PII-free, NUNCA 500 crudo, NUNCA ecoa `BASE`/beneficiary.

Guard-order fail-closed (todos dentro del handler, envs leídas en runtime — CD-14):

- **PR1** — `const BASE = process.env.REMIT_AGENTS_BASE_URL;` ausente → 501 `{error:"prepare_not_configured"}`. PRIMERO (sin backend no hay orden).
- **PR2** — `process.env.DEPOSIT_ATTESTATION_SECRET` ausente → **503 `{error:"prepare_unavailable"}`** (fail-closed; prepare SOLO existe en el path real, sin secreto no puede atestar → NUNCA fail-open. El demo nunca llama a prepare con flags OFF ⇒ AC-5 intacto). **Diferencia deliberada con el submit** (que skipea local sin secreto).
- **PR3** — Rate-limit IP-only con `checkRouteRateLimit(DEPOSIT_PREPARE_RL, { ip: clientIp(req) })`, TRAS PR2 y ANTES de parsear/forwardear. `rl.unavailable` → 503; `!rl.ok` → 429 con `Retry-After`. Declará `DEPOSIT_PREPARE_RL` en `rate-limit.ts` (IP-only, sin addr; sugerido max 10/"10 m"). **Crítico**: cada prepare crea una orden real → sin rate-limit, spam = órdenes huérfanas masivas.
- **PR4** — Body null-safe: `const parsed: unknown = await req.json().catch(() => null);` + `isRecord` (CD-9: `req.json()` resuelve `null` con el body literal `null`, el `.catch` NO dispara). Coerción a `""` de campos string. Exigí `remittanceId`, `quoteId`, `kycVerificationId`, `address` no-vacíos (y `isAddress(address)`) → 400 `{error:"prepare_invalid_request"}` SIN fetch.
- **PR5** (autoridad, WKH-202) — `const d = await resolvePayoutAuthority({ verificationId: kycVerificationId, address });`
  - `d.reason === "simulated_dev" && (process.env.VERCEL_ENV ?? "") !== ""` → 503 (mismo espíritu que submit:94-96).
  - `!d.authorized` → switch idéntico a submit (98-116): `kyc_not_approved`/`kyc_ownership_mismatch` → 403 `payout_not_authorized`; `kyc_authority_unavailable` → 503; default → 502 (fail-closed no-oracle).
- **PR6** (PoP, WKH-206) — `const POP_SECRET = process.env.PAYOUT_POP_SECRET;` si set: exige `popChallenge`/`popSignature` string no-vacíos (P1) → `verifyPopChallenge` (P2) → `ch.address.toLowerCase() === address.toLowerCase()` (P3) → `ch.chainId === resolveChainId()` (P4) → `verifyMessage({address, message: buildPopMessage(ch), signature})` (P5). Cualquier fallo → 403 `payout_pop_unverified`. **NO claim-once (P6)**: el nonce se quema recién en submit/tracking; acá stateless (no quemar antes de la firma real).
- **PR7** — Forward al agente: `fetch(\`${BASE}/api/agents/remit-cashout-payout/invoke\`, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) })`. `idempotencyKey` intacto (CD-10). `!res.ok`/timeout/parse → 502 `{error:"prepare_upstream_error"}` (todo en try/catch, nunca 500).
- **PR8** — `const { result } = await res.json();` valida shape con `isValidPayoutResult` (reusá el de submit) **+ exige `result.depositAddress` string no-vacío + `isAddress`** → si null/ausente/malformado → 502 `{error:"prepare_no_deposit_address"}` (AC-7 fail-closed: el mock devuelve `null` → aquí muere; NUNCA se atesta sin address confirmada).
- **PR9** — `const attestation = issueDepositAttestation({ remittanceId, quoteId, depositAddress, chainId: resolveChainId(), exp: Math.floor(Date.now()/1000) + DEPOSIT_ATTESTATION_TTL_SECONDS });` (chainId de la ENV server-side, CD-9, NUNCA del body).
- **PR10** — Ledger best-effort flag-gated (patrón submit:273-294): `const ledger = getSettlementLedger(); if (ledger) { try { await ledger.recordOrderPrepared({ remittanceId, quoteId, idempotencyKey, depositAddress, chainId: resolveChainId(), senderAddress: address, payoutId }); } catch (e) { console.error("[ledger] recordOrderPrepared_failed", e); } }`. NUNCA PII (CD-7/AC-8: solo IDs/address/chainId). NUNCA rompe el money-path (CD-17).
- **PR11** — 200 `{ depositAddress, attestation, payoutId: result.payoutId, provenance: result.provenance }`. NUNCA `BASE`/PII/beneficiary.

### W1.2 — Crear `src/infrastructure/settlement/http-payout-prepare-gateway.ts`

Molde de `http-settlement-gateway.ts`: corre en el cliente, llama SIEMPRE a `/api/payout/prepare` (nunca al agente directo). `class HttpPayoutPrepareGateway implements PayoutPrepareGateway`:
- `fetch("/api/payout/prepare", {...})` con try/catch → red caída → `{ ok:false, reason:"prepare_unavailable" }`.
- `!res.ok` → mapErrorStatus fail-closed (sin default permisivo): mapeá el enum de la route a un reason estable; status desconocido → reason que bloquea.
- 200 → `isValidPrepareShape(body)` (type-guard explícito: `depositAddress`/`attestation`/`payoutId`/`provenance` strings no-vacíos; `isAddress(depositAddress)`) → `{ ok:true, result: {...} }`; shape raro → `{ ok:false, reason:"prepare_bad_shape" }` (CD-10: nunca asumir éxito por el status).

### W1.3 — `FallbackPayoutPrepareGateway` en `src/infrastructure/fallback/gateways.ts`

Mock para tests/demo. NUNCA produce un `depositAddress` real → nunca se cablea en modo real (el container solo inyecta el `Http*` con flags ON). Devolvé un `{ ok:false, reason:"prepare_mock" }` o un `depositAddress` demo claramente sintético según lo que los tests necesiten — pero el path real jamás lo usa.

**Gate W1**: `npx tsc --noEmit` + unit de `prepare.route.test.ts` y `http-payout-prepare-gateway.test.ts`.

---

## Wave 2 — Wallet `to = depositAddress` (depende de W0; paralelo a W1/W3)

### W2.1 — `src/infrastructure/wallet.ts` (AMBAS wallets, byte-a-byte juntas)

En `InjectedWallet.authorizePrincipal` (85-147) **y** `WalletConnectWallet.authorizePrincipal` (240-300), dentro del bloque `if (eip3009Enabled())`:

- Agregá el 3er param `deposit?: { address: string }` a la firma (coincide con `WalletPort`).
- Reemplazá `const receiver = resolveReceiverAddress();` (líneas 97 y 251) por:
```ts
// WKH-211: en modo real el `to` es el depositAddress ATESTADO server-side (NUNCA el receiver estático).
// fail-loud: sin deposit válido no se firma (CD-2/AC-7). NO fallback a resolveReceiverAddress().
if (!deposit || !isAddress(deposit.address)) throw new Error("deposit_address_missing");
const receiver = deposit.address as \`0x${string}\`;
```
- El resto del bloque (nonce determinístico, domain EIP-712 por red, `to: receiver` en el message y en `authorization.to`) queda IDÉNTICO — solo cambia el ORIGEN de `receiver`.
- **Modo demo** (`else`, líneas 141-146 / 294-299): NO se toca. `deposit` se ignora. `signMessage` byte-idéntico (AC-5).
- `FallbackWallet.authorizePrincipal` (169-171): NO se toca (demo).

**Gate W2**: `npx tsc --noEmit` + `wallet.test.ts` (real: `to=deposit.address` en ambas wallets; deposit ausente en real → throw; demo byte-idéntico).

---

## Wave 3 — Guard reescrito de `settle/principal` (depende de W0; paralelo a W1/W2)

### W3.1 — `app/api/settle/principal/route.ts`

**Doble-modo flag-gated por la presencia de `DEPOSIT_ATTESTATION_SECRET`** (leído en runtime, CD-14):

- **Modo estático** (secreto AUSENTE): path WKH-168/209 SIN CAMBIOS. S12 (`isAddressEqual(to, receiver)` con `resolveReceiverAddress()`) + V6 (`expectedTo: receiver`) BYTE-IDÉNTICOS a hoy. Esto preserva AC-5/AC-6 para el path existente. **Regresión test obligatorio.**
- **Modo deposit-flow** (secreto PRESENTE): el body trae `depositAttestation: string`. Insertá B1-B6 **ENTRE S11 (monto, línea 141-143) y el broadcast (línea 155)**, reemplazando S12:
  - **B1** — `depositAttestation` ausente/no-string → 400 `{error:"settle_binding_missing"}` (MANDATORIO en este modo).
  - **B2** — `const att = verifyDepositAttestation(token, Date.now());` `null` → 400 `{error:"settle_binding_invalid"}`.
  - **B3** — `att.remittanceId === parsed.remittanceId` (exacto) → si no, 400 `settle_binding_invalid`. (Ata a ESTA remesa. `parsed.remittanceId` ya se lee en el ledger 214; validá que sea string no-vacío en este modo.)
  - **B4** — `att.quoteId === quoteId` (exacto, el `quoteId` ya validado en S de la línea 133) → si no, 400. (Mata reciclado cross-quote.)
  - **B5** — `att.chainId === resolveChainId()` (ENV server-side, NUNCA body) → si no, 400. (Mata replay cross-entorno, espíritu A7″.)
  - **B6** — `if (!isAddressEqual(to, att.depositAddress)) return 400 {error:"settle_receiver_mismatch"}` **SIN broadcast ni verify** (AC-3: rechazo antes de tocar la cadena).
  - `expectedTo := att.depositAddress` para el `payTo` del broadcast (línea 156) **y** para V1-V9 (`verifySettlementOnChain({ expectedTo: att.depositAddress })`, línea 180).
- **V1-V9 INTACTA**: la ÚNICA línea que cambia es el VALOR de `expectedTo`. El mecanismo de lectura on-chain (V6/V8) es idéntico. **NO toques `verifySettlementOnChain` ni `onchain-verifier.ts`.**
- El resto (broadcast, attestation post-V9 con `SETTLE_ATTESTATION_SECRET`, ledger `recordPrincipalIn`) queda igual.

**Prueba de fuerza (DT-3, para tu propia validación)**: el `to` sigue siendo server-controlado (HMAC en vez de env); V1-V9 on-chain intacta; el body NUNCA es la fuente de `expectedTo`. El guard nuevo es MÁS fuerte (ata `to` a remittanceId+quoteId+chainId+exp, no un valor global reusable).

**Gate W3**: `npx tsc --noEmit` + `settle.route.binding.test.ts` (ataque AC-3, 7 vectores) + `settle.route.static.test.ts` (byte-idéntico).

---

## Wave 4 — Integración reorder + wiring (depende de W1, W2, W3)

### W4.1 — `src/infrastructure/a2a/gateways.ts` (wiring `depositAddress`, WKH-212)

- Extendé `RawPayoutResult` (29-36): `+ depositAddress: string | null;`
- Extendé `isValidPayoutShape` (57-70): `if (!(typeof v.depositAddress === "string" || v.depositAddress === null)) return false;`
- `mapResultToPayoutRecord` (85-94): propagá `depositAddress` si `PayoutRecord` lo necesita, o dejalo pasar solo por el shape (el submit no lo usa; prepare lo lee del result crudo). **NO rompas el contrato del submit demo.**
- **CD-10 (auto-blindaje WKH-212)**: actualizá el/los test(s) de contrato del wire (`Object.keys(...).sort()` / snapshot) en `gateways.test.ts`. Agregar un campo al shape sin actualizar el test de contrato = el bug recurrente que CD-10 previene.

### W4.2 — `src/application/use-cases/confirm-and-send.ts` (reorder, SDD §4.5 autoritativo)

**Modo demo (`settlement === undefined`): flujo pre-HU byte-idéntico** (llama `authorizePrincipal(quote, s.id)` sin deposit; llama `payouts.submit`; sin prepare). AC-5.

**Modo real (`settlement !== undefined`)**, orden nuevo:
1. confirm → authority (WKH-180, 100-107) → expiry M2 (112-116) — SIN CAMBIOS.
2. **PREPARE (nuevo, ANTES de authorizePrincipal)**: si modo real, `const prep = await <prepareGateway>.prepare({ remittanceId: s.id, quoteId: quote.quoteId, kycVerificationId: kyc.verificationId, address: address ?? "", amountUsd: s.sendUsd.major, beneficiary: s.beneficiary, idempotencyKey: \`${s.id}:${quote.quoteId}\`, popChallenge, popSignature });`
   - Si necesitás la prueba PoP para prepare: obtenela ANTES vía `this.pop?.prove(address ?? "")` (mismo patrón que hoy en 230-236) y pasá `popChallenge`/`popSignature` a prepare.
   - `!prep.ok` → `await this.failAndRefund(r, prep.reason, false); return r;` **ANTES de pedir la firma** (AC-7: la wallet NUNCA firma con un `to` no confirmado).
3. `const { tx, eip3009 } = await this.wallet.authorizePrincipal(quote, s.id, { address: prep.result.depositAddress });` ← **`to = depositAddress` (AC-1)**. En demo: `authorizePrincipal(quote, s.id)` sin 3er arg.
4. settle (bloque C1-C6, 130-195) con un arg nuevo: `depositAttestation: prep.result.attestation` (el gateway `settle` debe pasarlo al body de `/api/settle/principal`). **C5** (181-191): comparar `res.to` contra `prep.result.depositAddress` runtime (ya NO `this.settlement.receiver`, que se removió).
5. `markPrincipalIn(res.txHash)` SOLO tras V1-V9 (CD-6). `principalReallyIn = true` en real.
6. 2º expiry re-check (210-214) — SIN CAMBIOS.
7. **Real mode NO llama `payouts.submit`** (DT-7): la orden ya se creó en prepare. `markPayoutSubmitted(prep.result.payoutId, nowIso, prep.result.provenance)`. El estado `settled` llega async por el webhook TransFi (WKH-210). En demo: el path submit (216-274) queda IGUAL.

**Cambios de firma necesarios**: `PrincipalSettlementGateway.settle` (ports.ts:142-154) y `HttpSettlementGateway.settle` deben aceptar `depositAttestation?: string` (aditivo; el server lo usa solo en modo deposit-flow). Actualizá `http-settlement-gateway.ts` para incluirlo en el body del fetch.

### W4.3 — `src/composition/container.ts` (wiring flag-gated)

- Instanciá el `HttpPayoutPrepareGateway` SOLO con `NEXT_PUBLIC_EIP3009_ENABLED === "true"` (mismo ternario que `settlement`, 89-92).
- `settlement` pierde `receiver` (ver [SDD-GAP #1]). Recomendación: `settlement = flag ? { gateway: new HttpSettlementGateway(), prepare: new HttpPayoutPrepareGateway() } : undefined`.
- Inyectá a `ConfirmAndSend` (106-115). El guard fail-loud money-path (61-69) queda INTACTO (garantiza adapter=a2a + usdc antes de arrancar).

**Gate W4**: `npx tsc --noEmit` + `confirm-and-send.reorder.test.ts` + `confirm-and-send.demo.test.ts` + `gateways.deposit-wiring.test.ts`.

---

## Wave 5 — Política de huérfanas + env (depende de W1, W4)

### W5.0 — Migración aditiva del CHECK constraint (RESUELTO, ya no es TBD)

El CHECK `remittance_settlements_status_chk` existe y NO incluye `'prepared'`. Creá `supabase/migrations/2026...T000000_add_prepared_status.sql` (timestamp posterior al `20260716T000000`), aditivo, **PENDING-DEPLOY** (la aplica el founder, gated — mismo header que la migración original):
```sql
-- WKH-211 — aditivo: 'prepared' al enum de status (orden TransFi creada, sin principal_in aún).
alter table public.remittance_settlements drop constraint remittance_settlements_status_chk;
alter table public.remittance_settlements add constraint remittance_settlements_status_chk
  check (status in ('prepared','principal_in','submitted','settled','failed','forward_error','manual_review'));
```
`'prepared'` NO se agrega al índice parcial de stale statuses (es visibilidad de reconcile, no re-procesamiento automático — la cancelación real es follow-up, DT-5). Documentalo en un comentario.

### W5.1 — `recordOrderPrepared` en `supabase-settlement-ledger.ts` (impl del método de W0.2)

Molde de `recordPrincipalIn` (76-103). Upsert por `idempotency_key` (o insert) con `status: 'prepared'`, `receiver_address: input.depositAddress.toLowerCase()` (el `depositAddress` va en la columna `receiver_address` existente — semánticamente ES el receiver no-custodial; **NO columna nueva**), `sender_address: input.senderAddress.toLowerCase()`, `payout_id: input.payoutId`. `value_minor` no se conoce aún en prepare → poné `'0'` o el mínimo que el NOT NULL exija (documentá; el valor real llega en `recordPrincipalIn`). Actualizá también el/los fakes del ledger en tests.

### W5.2 — `.env.example`

Documentá `DEPOSIT_ATTESTATION_SECRET` (server-only, SIN `NEXT_PUBLIC_`) junto al bloque WKH-168, con nota: "habilita el guard deposit-flow de /api/settle/principal + el endpoint /api/payout/prepare. Separado de SETTLE_ATTESTATION_SECRET (dominios distintos, DT-4). El depositAddress real (no-null) exige el agente con TRANSFI_ADAPTER_READY=true (repo wasiai-remittance-agents, cross-repo)."

**Gate W5**: `npx tsc --noEmit` + `orphan-ledger.test.ts` + verificación de la migración (sintaxis).

---

## Wave 6 — Tests (depende de todo). ≥1 por AC, TODOS mockeados (AC-4/CD-1).

| Test file | AC | Qué cubre |
|-----------|-----|-----------|
| `deposit-attestation.test.ts` | AC-2 | issue→verify round-trip; HMAC inválido→null; exp vencida→null; cada campo deforme→null; falta secreto→null; timing-safe longitud-primero; TTL === 10 min. |
| `prepare.route.test.ts` (happy) | AC-1 | secreto+BASE set, autoridad ok, agente mock con `depositAddress` real → 200 `{depositAddress, attestation, payoutId, provenance}`; la attestation verifica con `verifyDepositAttestation`. |
| `prepare.route.test.ts` (fail-closed) | AC-7 | agente 502 → 502; timeout → 502; `depositAddress:null` (mock) → `prepare_no_deposit_address`; KYC no-auth → 403; secreto ausente → 503; BASE ausente → 501; body `null` → 400 (CD-9). |
| `prepare.route.test.ts` (guards) | AC-6 | autoridad `simulated_dev` en Vercel → 503; PoP inválido (con PAYOUT_POP_SECRET) → 403; rate-limit → 429/503. |
| **`settle.route.binding.test.ts` (ATAQUE AC-3, 7 vectores)** | AC-3 | ver "Vector AC-3" abajo. |
| `settle.route.binding.test.ts` (happy) | AC-1 | binding válido → `expectedTo=att.depositAddress` a V1-V9 (mock verifier) → 200 + settlement-attestation. |
| `settle.route.static.test.ts` (byte-idéntico) | AC-5/AC-6 | sin `DEPOSIT_ATTESTATION_SECRET` → path estático `resolveReceiverAddress()` idéntico a WKH-209 (regresión). |
| `wallet.test.ts` | AC-1/AC-5 | real: `to=deposit.address` en la firma (AMBAS wallets); `deposit` ausente en real → throw fail-loud; demo → `signMessage` byte-idéntico. |
| `confirm-and-send.reorder.test.ts` | AC-1/AC-7 | orden real: prepare→sign→settle→markPayoutSubmitted; prepare `!ok` → failAndRefund **sin** `wallet.authorizePrincipal` (spy: NO llamado, AC-7); C5 usa depositAddress runtime; real-mode NO llama `payouts.submit` (spy). |
| `confirm-and-send.demo.test.ts` (byte-idéntico) | AC-5 | `settlement===undefined` → flujo pre-HU intacto (llama submit, sin prepare). |
| `guard8-intact.test.ts` | AC-6/CD-3 | submit/route.ts guard 8 SIN cambios: sin `settlementAttestation` (con secreto set) → 403 (regresión WKH-168). |
| `gateways.deposit-wiring.test.ts` | AC-1/CD-10 | `isValidPayoutShape` acepta `depositAddress`; map lo propaga; test de contrato del wire actualizado. |
| `orphan-ledger.test.ts` | AC-8/CD-6 | prepare registra `'prepared'` sin PII; una `'prepared'` huérfana NUNCA es `principal_in`; DB caída → best-effort no rompe. |

### Vector AC-3 — `settle.route.binding.test.ts` (las 7 variantes de inyección)

Con `DEPOSIT_ATTESTATION_SECRET` set y un mock de `broadcastSettle` + `verifySettlementOnChain` con **spies**. En CADA variante: assert `broadcastSettle` NO llamado (o para f/g que caen antes) y `verifySettlementOnChain` NUNCA llamado, y status 400:

- **(a)** `to` firmado ≠ `att.depositAddress` (B6) → 400 `settle_receiver_mismatch`.
- **(b)** attestation de OTRO `remittanceId` (B3) → 400.
- **(c)** attestation de OTRO `quoteId` (B4) → 400.
- **(d)** attestation de OTRO `chainId` (B5) → 400.
- **(e)** HMAC forjado / sin secreto correcto (B2 → verify null) → 400.
- **(f)** attestation vencida (B2 → verify null por exp) → 400.
- **(g)** attestation ausente en modo deposit (B1) → 400 `settle_binding_missing`.

**Gate W6**: `npm run qa` COMPLETO (todos los AC + byte-identidad OFF con `git diff` del path demo limpio + mutation self-check). `npx tsc --noEmit` incluye tests.

---

## 4. Constraint Directives (reglas verificables) — ÉNFASIS SEGURIDAD

| CD | Regla | Cómo se verifica |
|----|-------|------------------|
| **CD-1** | PROHIBIDO mover USDC real o crear orden TransFi real fuera de test mockeado. | Todos los gateways/fetch mockeados en tests; ningún test apunta a mainnet/sandbox real. |
| **CD-2** | El `depositAddress` usado como `to` SIEMPRE atestado server-side; NUNCA de un campo del body/UI sin verificar el HMAC. | wallet.ts firma `deposit.address` (que viene de prepare/HMAC); settle B6 re-verifica contra `att.depositAddress`. |
| **CD-3** | PROHIBIDO remover/debilitar el guard 8 de `submit/route.ts`. Queda INTACTO byte-a-byte. | `guard8-intact.test.ts`; `git diff submit/route.ts` = sin cambios de guard. |
| **CD-4** | PROHIBIDO encender `NEXT_PUBLIC_EIP3009_ENABLED`/`DEPOSIT_ATTESTATION_SECRET`/`TRANSFI_ADAPTER_READY` en cualquier entorno compartido. | `.env.example` documenta OFF; ningún deploy config los enciende. |
| **CD-5** | PROHIBIDO tocar `wasiai-remittance-agents`. | El diff no incluye ese repo. |
| **CD-6** | Una orden `'prepared'` huérfana NUNCA es `principal_in` ni dispara PEN. markPrincipalIn solo tras V1-V9. | `orphan-ledger.test.ts`; confirm-and-send solo marca principal_in con `res.txHash` verificado. |
| **CD-7/AC-8** | NUNCA persistir/loguear `depositAddress` junto a PII. Solo IDs/address/chainId. | PR10 pasa solo hechos operativos; `orphan-ledger.test.ts` verifica sin PII. |
| **CD-8** (heredado, auto-blindaje WKH-210) | Dedup single-use (`SET NX`) + mutación: quemar el token DESPUÉS de la mutación. **No aplica** acá (deposit-binding stateless, DT-6) — NO agregues claim-once. | verify sin claim-once; no import de `attestation-store`. |
| **CD-9** (heredado, auto-blindaje WKH-202/205) | `req.json()` resuelve `null` con body literal `null` → usá `.catch(()=>null)`+`isRecord`. NUNCA `Number(x)`/`Money.of(Number(x))` sobre campos del caller sin guard de tipo previo. | PR4; test body `null` → 400. |
| **CD-10** (heredado, auto-blindaje WKH-212) | Toda HU que agregue campo a un wire serializado DEBE actualizar los tests de contrato (`Object.keys().sort()`/snapshot). | `gateways.deposit-wiring.test.ts`. |
| **CD-11** | Sin `any` explícito (TS strict); type-guards explícitos para todo shape crudo del agente. | `npx tsc --noEmit`; biome. |
| **AC-6** | NO debilitar WKH-168/202/206/207/209/210. Cada cambio de guard-order = DT justificado (ya en el SDD). | tests de regresión (guard8-intact, settle static, byte-idéntico demo). |

---

## 5. Auto-Blindaje (OBLIGATORIO en W6)

1. **`grep -rn "MUTANT" src app` = 0** antes de cerrar (ningún marcador de mutación quedó pegado).
2. **Mutation self-check del vector AC-3 (OBLIGATORIO)**: mutá el check B6 de `settle/principal/route.ts` para que acepte cualquier `to` (ej: comentá `isAddressEqual(to, att.depositAddress)` o hacelo `true`). Confirmá que **muere ≥1 test** de las 7 variantes de `settle.route.binding.test.ts` (idealmente el vector (a)). Restaurá. Si NO muere ningún test → el test no protege el guard → arreglá el test ANTES de cerrar.
3. **Mutation self-check adicional recomendado**: mutá B3 (remittanceId binding) → debe morir el vector (b). Mutá B5 (chainId) → debe morir (d).
4. **CD-9 (req.json null)**: test con body literal `null` en prepare y settle → 400, nunca 500.
5. **CD-8 (claim-before-mutate)**: confirmá que NO agregaste claim-once en el deposit-binding (stateless por DT-6).
6. **CD-10 (wire-contract)**: el test de contrato de `gateways.ts` incluye `depositAddress` en el `Object.keys` esperado.
7. **`mockImplementation` no `mockResolvedValue`** para gateways cuyo comportamiento el test necesita variar (evita mocks que no reflejan el flujo real).
8. **Contá los tests ejecutando**: `npm run qa` debe mostrar N tests nuevos corriendo (≥1 por AC + 7 del vector AC-3). Un test que "pasa" sin ejecutarse (skip/typo en el describe) no cuenta.

---

## 6. Done Definition

- [ ] W0-W6 completas; cada wave pasó su gate (`npx tsc --noEmit` completo + `npm run qa` al final).
- [ ] `deposit-attestation.ts` es mirror en forma de `attestation.ts` (HMAC-first timing-safe, null-en-todo, secreto interno, sin claim-once).
- [ ] `/api/payout/prepare` con PR1-PR11 fail-closed; nunca 500 crudo; nunca ecoa BASE/PII.
- [ ] Ambas wallets firman `to = deposit.address` en real; throw fail-loud sin deposit; demo byte-idéntico.
- [ ] settle guard: modo deposit-flow B1-B6 con V1-V9 INTACTA; modo estático byte-idéntico (regresión pasa).
- [ ] confirm-and-send reorder: prepare→sign→settle→markSubmitted-from-prepare; demo llama submit sin prepare (byte-idéntico).
- [ ] guard 8 de submit INTACTO (CD-3); migración `'prepared'` aditiva PENDING-DEPLOY.
- [ ] ≥1 test por AC-1..8 + 7 variantes del vector AC-3, todos mockeados; mutation self-check del `to` mata ≥1 test.
- [ ] `grep MUTANT` = 0; `git diff` del path demo limpio en comportamiento (AC-5).
- [ ] Sin `any` explícito; los 3 CD heredados (CD-8/9/10) respetados.

---

## 7. [SDD-GAP] detectados por el Architect (F2.5)

- **[SDD-GAP #1] (menor) — forma del acople `settlement`/`prepare` en `ConfirmAndSend`**: el SDD §4.5 escribe `prepare.prepare(...)` (sugiere un param separado `this.prepare`), pero §4.1 dice "settlement.receiver removido" + "inyecta prepare gateway (flag-gated)" sin fijar si `prepare` es un 9º param suelto o va acoplado dentro de `settlement`. El propio `confirm-and-send.ts:31-41` documenta EXTENSAMENTE por qué el `receiver`/gateway van ACOPLADOS (evitar el fail-open de un opcional suelto `undefined` que saltee un guard en silencio — mismo riesgo que un `prepare?` suelto).
  **Resolución recomendada (para que el Dev NO improvise)**: acoplá `prepare` DENTRO del objeto settlement → `settlement?: { gateway: PrincipalSettlementGateway; prepare: PayoutPrepareGateway }`. Así `settlement !== undefined ⇔ modo real ⇔ gateway Y prepare presentes juntos`, preservando el invariante anti-fail-open ya establecido. NO introduce un opcional que pueda quedar `undefined` en real. Ajustá `ports.ts` W0.2 punto 5 y `container.ts` W4.3 en consecuencia. Si el Adversary/founder prefiere param separado, es equivalente en fuerza SOLO si se agrega un guard que garantice "real ⇒ prepare presente"; el acople lo da gratis.
  *No es bloqueante: ambas formas cumplen los ACs; se documenta para que la decisión sea explícita y no un ajuste sobre la marcha.*

- **[TBD resuelto, NO es gap]**: el CHECK constraint de `remittance_settlements.status` (§3.3 W5.0 del SDD) quedaba abierto — CONFIRMADO que existe (`remittance_settlements_status_chk`, migración `20260716T000000:19-20`) y requiere migración aditiva (detallada en W5.0). Ya no es incertidumbre.
- **[TBD no-bloqueante, sigue como follow-up]**: cancelación real de órdenes TransFi huérfanas (DT-5) — fuera de scope de esta HU; mínimo viable = TTL 10 min + ledger `'prepared'` + fail-closed. NO lo implementes.
