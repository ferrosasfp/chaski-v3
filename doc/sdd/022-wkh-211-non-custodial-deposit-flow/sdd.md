# SDD #022: [WKH-211] Value-delivery no-custodial — el USDC del sender va directo al `depositAddress` de TransFi

> SPEC_APPROVED: no
> Fecha: 2026-07-18
> Tipo: feature (cambio de modelo de seguridad money-path)
> SDD_MODE: full
> Branch: feat/022-wkh-211-non-custodial-deposit-flow
> Artefactos: doc/sdd/022-wkh-211-non-custodial-deposit-flow/
> Binding = **OPCIÓN B** (decidido por el founder, gate cerrado — NO se reabre)
> Cross-repo = **RESUELTO** (WKH-212 mergeado: el agente ya expone `depositAddress` en su output HTTP)

---

## 1. Resumen

Hoy el settle del principal firma y transmite `transferWithAuthorization(to = RECEIVER_ESTÁTICO)` —
un env fijo (`NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`) usado como invariante de seguridad en 4 puntos
independientes. Esta HU reordena el money-path para que el sender firme **directo a un
`depositAddress` que TransFi asigna POR ORDEN**, cerrando el principio no-custodial ("WasiAI NUNCA
custodia el USDC"). El `to` deja de ser un literal comparable byte-a-byte y pasa a ser un valor
dinámico por remesa; para que ese cambio NO abra un vector de desvío de fondos, se introduce una
**DepositAddress Attestation** HMAC (mismo mecanismo criptográfico que `attestation.ts`, contenido y
momento de emisión NUEVOS) que ata `remittanceId + quoteId + depositAddress + chainId + exp`, emitida
server-side ANTES de que el cliente firme, y verificada por el guard reescrito de `/api/settle/principal`.

La HU **construye y testea mockeado**; no mueve plata real, no crea una orden TransFi real (gateado al
founder, CD-1). Todo el reorder + binding es **código muerto** sin `NEXT_PUBLIC_EIP3009_ENABLED=true`
(cliente) + `DEPOSIT_ATTESTATION_SECRET` (server): el demo/mock queda **byte-idéntico** (AC-5).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 022 / WKH-211 |
| **Tipo** | feature — cambio de modelo de seguridad money-path |
| **SDD_MODE** | full |
| **Objetivo** | El sender firma EIP-3009 con `to = depositAddress` atestado server-side por remesa, nunca al receiver estático; sin debilitar ninguna garantía previa. |
| **Reglas de negocio** | No-custodial: el USDC va directo a TransFi. Binding = Opción B (endpoint `prepare`). Sandbox/testnet only. Flags OFF por default. |
| **Scope IN** | `deposit-attestation.ts` (nuevo), `/api/payout/prepare` (nuevo), `wallet.ts`, `settle/principal/route.ts`, `confirm-and-send.ts`, `ports.ts`, `container.ts`, adapters de prepare, `.env.example`, ledger aditivo, tests. |
| **Scope OUT** | Encender flags en cualquier entorno; orden/settle real; tocar `wasiai-remittance-agents` (ya cerrado WKH-212); cancelación real de órdenes TransFi huérfanas (follow-up); webhook TransFi (WKH-210, intacto). |
| **Missing Inputs** | Ver §10 — 1 [TBD no-bloqueante] (cancelación TransFi de órdenes huérfanas, cross-repo). Cero [NEEDS CLARIFICATION] bloqueantes. |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1**: WHEN el flujo real está habilitado (`NEXT_PUBLIC_EIP3009_ENABLED=true` cliente +
  `DEPOSIT_ATTESTATION_SECRET` server; el `depositAddress` real exige el agente con
  `TRANSFI_ADAPTER_READY=true` — ver DT-8), THE system SHALL firmar/transmitir la EIP-3009 con
  `to = depositAddress` atestado para ESA `remittanceId`, NUNCA al `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`.
- **AC-2**: WHEN el server emite el binding, THE system SHALL producir un token no-falsificable sin el
  secreto server-side, atado a `remittanceId + quoteId + chainId + exp` (TTL ≤ 15 min; usamos 10 min,
  DT-5).
- **AC-3**: IF un caller intenta que la wallet firme o que `settle/principal` acepte un `to` que NO
  coincide con el `depositAddress` atestado para ese `remittanceId`/`quoteId` (inyectado, de un tercero,
  reciclado), THEN THE system SHALL rechazar SIN transmitir ni verificar nada on-chain con ese `to`.
- **AC-4**: THE system SHALL ejecutar el reorder solo contra Base Sepolia + sandbox TransFi en tests;
  ningún test dispara una orden/settle real (todo mockeado; el real gateado al founder).
- **AC-5**: WHILE los flags permanecen OFF/ausentes, THE system SHALL mantener el demo/mock byte-idéntico
  (reorder + binding = código muerto).
- **AC-6**: THE system SHALL preservar sin debilitar TODAS las garantías previas (WKH-168 V1-V9, WKH-202
  autoridad KYC, WKH-206 PoP, WKH-207 ledger, WKH-209 domain EIP-712, WKH-210 webhook); cada cambio de
  guard-order = DT justificado.
- **AC-7**: IF el `depositAddress` no se obtuvo (agente caído, orden rechazada, KYC no-auth, campo
  ausente/null del mock), THEN THE system SHALL fallar ANTES de pedir la firma.
- **AC-8**: THE system SHALL NUNCA persistir/loguear el `depositAddress` junto a PII del beneficiario
  (solo `remittanceId`/`quoteId`/`depositAddress`/`chainId` — hechos operativos).

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos — verificados con Read (archivo:línea)

| Archivo | Por qué | Qué se extrajo (verificado) |
|---------|---------|------------------------------|
| `src/infrastructure/settlement/attestation.ts` | **Exemplar del binding HMAC** | `SettlementAttestation` (15-23); `issue`/`verify` (44-98); `sign()` HMAC-SHA256 `node:crypto` sobre string b64url (36-38); secreto leído DENTRO de la función (30-34, CD-14 vi.stubEnv); verify null-en-todo, **HMAC-first longitud-primero timing-safe** (68-73), parse en try/catch (76-81), validación por-campo (85-92), exp (95); `ATTESTATION_TTL_SECONDS = 15*60` (27). |
| `src/infrastructure/auth/pop-challenge.ts` | 2º exemplar (mirror byte-a-byte del anterior) | Mismo patrón `issue`/`verify`/`build`; `PopChallenge` (17-22); `POP_CHALLENGE_TTL_SECONDS = 10*60` (26). Confirma que el repo tiene DOS atestaciones HMAC idénticas en forma → la 3ª (deposit) sigue el mismo molde. |
| `src/infrastructure/settlement/attestation-store.ts` | single-use (por si aplica al deposit) | `claimAttestationOnce(txHash)` Upstash `SET NX` fail-CLOSED (44-60); TTL 86_400 (25). Conclusión DT-6: el deposit-binding NO necesita claim-once (el nonce determinístico ya hace el doble-settle contract-imposible). |
| `src/infrastructure/wallet.ts` | **Invariante `to` — punto 1** | `InjectedWallet.authorizePrincipal` firma con `to = resolveReceiverAddress()` en **97 / 117 / 133**; `WalletConnectWallet` idéntico byte-a-byte en **251 / 271 / 286**. Domain EIP-712 por red (104-112). `eip3009Enabled()` (29-31). Nonce determinístico (43-45). Ambas wallets se editan JUNTAS. |
| `app/api/settle/principal/route.ts` | **Invariante `to` — punto 2 (el más fuerte)** | S1 flag-gate (47-49); resolvers fail-loud (62-68); S12 `isAddressEqual(to, receiver)` (145); **V1-V9 `verifySettlementOnChain({ expectedTo: receiver })` (177-182, comentario "CD-9: env, NO el `to` del body")**; issue settlement-attestation post-V9 (189-199); ledger aditivo post-V9 (211-238). Guard-order: flag→config→env→body→formato→binding→broadcast→verify→attest. |
| `src/application/use-cases/confirm-and-send.ts` | **Invariante `to` — punto 3 + el reorder** | Orden actual: confirm (88) → authority WKH-180 (100-107) → expiry M2 (112-116) → **authorizePrincipal (120)** → **settle (139-146)** → C4 (173) / **C5 `isAddressEqual(res.to, this.settlement.receiver)` (181-191)** → markPrincipalIn (197) → 2º expiry (210-214) → **submit (237-251)**. `settlement?: {gateway, receiver}` (42) y `pop?` (46) = 7º/8º params opcionales (undefined ⇔ demo, AC-5 por construcción). `principalReallyIn` (202). |
| `src/infrastructure/chain.ts` | **Invariante `to` — punto 4** | `resolveReceiverAddress()` (86-90) fail-loud `isAddress` sobre `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`. `resolveChainId()` fallback 84532 (42-46, NUNCA tira). `resolveNetworkConfig`/`resolveUsdcAddress`. |
| `src/application/ports.ts` | firmas a cambiar | `WalletPort.authorizePrincipal(quote, remittanceId)` (162-168); `PrincipalSettlementGateway.settle(...)` (142-154) con `remittanceId` (149); `PayoutGateway.submit` (92-95); `SettlementLedger` + `SettlementLedgerStatus` (211-275) — SIN `depositAddress`/`prepared`; `PayoutSubmit` (63-83). |
| `src/infrastructure/a2a/gateways.ts` | wiring `depositAddress` (WKH-212) | `RawPayoutResult` (29-36) + `isValidPayoutShape` (57-70) + `mapResultToPayoutRecord` (85-94) **NO incluyen `depositAddress`** → hay que extender. `A2aPayoutGateway.submit` (119-150) es el patrón del nuevo `A2aPayoutPrepareGateway`. |
| `app/api/a2a/payout/submit/route.ts` | **guard 8 (G3/WKH-168) — convivencia** | Guards 1-6 autoridad (62-116); **7 PoP** (118-176, P1-P6, claim-once P6 en 168); **8 atestación settlement** (178-267: A1/A2 skip/503, A3 ausente, A4/A5 HMAC/exp, A6 monto, A7 pagador, A7′ quote, A7″ chain, A8/A9 claim-once). Forward al agente crea la orden (299-304). Ledger aditivo (268-333). |
| `src/infrastructure/settlement/http-settlement-gateway.ts` | **Exemplar del adapter cliente→ruta** | type-guards explícitos, `mapErrorStatus` fail-closed sin default permisivo (23-51), `isValidSettleShape` (55-67), fetch con red-caída→fail-closed (82-99). Molde de `HttpPayoutPrepareGateway`. |
| `src/infrastructure/auth/http-pop-signer.ts` | Exemplar contrato 501-vs-otros | 501⇒null (SKIP), otros !ok⇒throw (fail-closed controlado). Molde para el fail-closed del prepare (AC-7). |
| `app/api/a2a/payout/challenge/route.ts` | **Exemplar del endpoint emisor HMAC** | Guard-order: secreto ausente→501 (30-33); rate-limit IP TRAS el 501 y ANTES de parsear/HMAC (35-46); body null-safe (50-51); `isAddress`→400 (53-56); emite HMAC con `resolveChainId()` server-side (58-66). Molde de `/api/payout/prepare`. |
| `src/composition/container.ts` | wiring | Guard fail-loud money-path (61-69); `settlement = flag ? {gateway, receiver} : undefined` (89-92); `pop = flag ? … : undefined` (96-97); inyección a `ConfirmAndSend` (106-115). |
| `.env.example` (83-142) | envs | `NEXT_PUBLIC_EIP3009_ENABLED` (87), `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` (90), `SETTLE_ATTESTATION_SECRET` (129, server-only), `PAYOUT_POP_SECRET` (139). Patrón doble-flag (server-secret habilita guard + `NEXT_PUBLIC_` enciende cliente). |
| **cross-repo** `wasiai-remittance-agents/src/agents/cashout-payout.ts:50-60` | contrato HTTP del agente (WKH-212) | **`CashoutPayoutOutput.depositAddress: string \| null` (59) — YA EXPUESTO** (commit `3d5d1cf`). `null` en mock/blocked; valor real en `executed`. `route.ts` serializa `{result}` verbatim → el campo viaja. |
| **cross-repo** `.../src/providers/types.ts:112-123` | fuente | `PayoutResult.depositAddress: string \| null` (122). `TRANSFI_ADAPTER_READY=true` (agent-side) es lo que hace no-null el valor real. |

### 3.2 Exemplars (verificados con Glob/Read → paths reales)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `deposit-attestation.ts` (nuevo) | `settlement/attestation.ts` + `auth/pop-challenge.ts` | 3ª atestación HMAC del repo — mismo molde `issue`/`verify`, `node:crypto`, secreto interno, verify HMAC-first timing-safe, null-en-todo. |
| `/api/payout/prepare/route.ts` (nuevo) | `api/a2a/payout/challenge/route.ts` (emisor HMAC) + `api/a2a/payout/submit/route.ts` (guards autoridad+PoP+forward) | Compone: guards 1-7 de submit (autoridad WKH-202 + PoP WKH-206) + forward al agente + emisión HMAC estilo challenge. |
| `HttpPayoutPrepareGateway` (nuevo) | `settlement/http-settlement-gateway.ts` | Adapter cliente→ruta con type-guards, mapErrorStatus fail-closed, red-caída fail-closed. |
| `wallet.ts` (mod) | el propio archivo (ambas wallets, byte-a-byte) | `to = depositAddress` en lugar de `resolveReceiverAddress()`, fail-loud isAddress. |
| `settle/principal/route.ts` (mod) | guard-order propio + `verifyDepositAttestation` | `expectedTo` dinámico atestado; V1-V9 intacto. |
| ledger `prepared` | `SettlementLedger.recordPrincipalIn` (ports.ts:239-248) + supabase impl | status aditivo + `depositAddress` en la columna `receiverAddress` existente (semánticamente ES el receiver). |

### 3.3 Estado de BD relevante

| Tabla | Existe | Columnas relevantes | Cambio de esta HU |
|-------|--------|---------------------|-------------------|
| `remittance_settlements` (WKH-207) | Sí | `remittance_id, quote_id, idempotency_key, tx_hash, chain_id, sender_address, receiver_address, value_minor, status, attempts, payout_id, last_error` | **Aditivo**: nuevo valor de `status` `'prepared'`. `depositAddress` se guarda en `receiver_address` (existente) — **NO se agrega columna nueva** (el `to` no-custodial ES el receiver). **[TBD W5.0]**: verificar si hay `CHECK` constraint sobre `status`; si existe, migración aditiva `ALTER … ADD VALUE`/relajar el CHECK. |

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué hace | Exemplar | Wave |
|---------|--------|----------|----------|------|
| `src/infrastructure/settlement/deposit-attestation.ts` | Crear | `DepositAttestation` + `issueDepositAttestation` + `verifyDepositAttestation` + `DEPOSIT_ATTESTATION_TTL_SECONDS` | `attestation.ts` | W0 |
| `src/application/ports.ts` | Modificar | +`PayoutPrepareGateway`; `authorizePrincipal` 3er arg `deposit`; `settlement.receiver`→removido; +`'prepared'` a `SettlementLedgerStatus`; +`recordOrderPrepared` en `SettlementLedger` | — | W0 |
| `app/api/payout/prepare/route.ts` | Crear | Endpoint: guards autoridad(202)+PoP(206) → forward agente (crea orden) → lee `depositAddress` → emite DepositAttestation; fail-closed | `challenge/route.ts` + `submit/route.ts` | W1 |
| `src/infrastructure/settlement/http-payout-prepare-gateway.ts` | Crear | Adapter cliente→`/api/payout/prepare` | `http-settlement-gateway.ts` | W1 |
| `src/infrastructure/fallback/gateways.ts` | Modificar | `FallbackPayoutPrepareGateway` (mock; nunca produce depositAddress real → no se cablea en real) | patrón Fallback existente | W1 |
| `src/infrastructure/wallet.ts` | Modificar | Ambas wallets: `to = deposit.address` (fail-loud isAddress) en modo real; elimina uso de `resolveReceiverAddress()` en `authorizePrincipal` | archivo propio | W2 |
| `app/api/settle/principal/route.ts` | Modificar | Guard reescrito: `expectedTo` = depositAddress atestado (cuando `DEPOSIT_ATTESTATION_SECRET` configurado); verifica binding remittanceId/quoteId/chainId/exp; rechaza mismatch pre-broadcast | guard-order propio | W3 |
| `src/application/use-cases/confirm-and-send.ts` | Modificar | Reorder real: prepare→sign(to=depositAddress)→settle(con depositAttestation); C5 usa depositAddress runtime; real-mode marca submitted desde el payoutId de prepare (no llama submit) | archivo propio | W4 |
| `src/composition/container.ts` | Modificar | Inyecta `prepare` gateway (flag-gated); `settlement` sin `receiver` | archivo propio | W4 |
| `src/infrastructure/a2a/gateways.ts` | Modificar | Extiende `RawPayoutResult`+`isValidPayoutShape`+map para leer `depositAddress` (WKH-212) | archivo propio | W4 |
| `src/infrastructure/persistence/supabase-settlement-ledger.ts` + `ports`/fakes | Modificar | `recordOrderPrepared` (status `'prepared'`, depositAddress→receiver_address, best-effort flag-gated) | `recordPrincipalIn` | W5 |
| `.env.example` | Modificar | Documenta `DEPOSIT_ATTESTATION_SECRET` (server-only) + relación con `TRANSFI_ADAPTER_READY` (agent) | bloque WKH-168 | W5 |
| tests (múltiples `*.test.ts`) | Crear/Modificar | ≥1 por AC, todos mockeados (ver §Test Plan) | tests existentes | W6 |

### 4.2 La DepositAddress Attestation (el corazón del binding — AC-2)

**Interfaz** (`deposit-attestation.ts`):

```
interface DepositAttestation {
  remittanceId: string;   // no-vacío
  quoteId: string;        // no-vacío
  depositAddress: string; // 0x + 40 hex (isAddress)
  chainId: number;        // entero
  exp: number;            // epoch SEGUNDOS
}
DEPOSIT_ATTESTATION_TTL_SECONDS = 10 * 60   // 10 min: bound de la ventana de orden huérfana (DT-5)
```

**Formato** (idéntico a `SettlementAttestation`): `${b64url(JSON.stringify(payload))}.${b64url(hmac(b64urlPayload))}`.
HMAC-SHA256 con `node:crypto`, secreto **`DEPOSIT_ATTESTATION_SECRET`** leído DENTRO de `secret()`
(nunca top-level → `vi.stubEnv`, CD-14). NUEVO secreto, separado del `SETTLE_ATTESTATION_SECRET`
(dominios distintos: pre-settlement vs post-settlement — nunca reusar un secreto entre atestaciones de
naturaleza distinta).

**`verifyDepositAttestation(token, nowMs): DepositAttestation | null`** — mirror byte-a-byte de
`verifySettlementAttestation`:
1. Formato: exactamente 2 partes no vacías.
2. Sin secreto → null (la route ya cortó antes).
3. **HMAC PRIMERO**, longitud-primero (timingSafeEqual tira con distinta longitud), timing-safe.
4. Parse en try/catch.
5. Validación por-campo: `remittanceId` string no-vacío, `quoteId` string no-vacío, `depositAddress`
   `isAddress`, `chainId` entero, `exp` finito.
6. Expiración `exp*1000 <= nowMs → null`.

Devuelve `null` ante CUALQUIER problema (fail-closed, no-oracle). **No hay claim-once** (ver DT-6).

### 4.3 El endpoint `/api/payout/prepare` (AC-1/AC-7 — contrato)

**Método**: `POST`. **Body**: `{ remittanceId, quoteId, kycVerificationId, address, amountUsd,
beneficiary, idempotencyKey, popChallenge?, popSignature? }`. **Respuesta OK (200)**:
`{ depositAddress, attestation, payoutId, provenance }`. **Errores**: enums opacos, PII-free, nunca 500 crudo.

**Guard-order fail-closed** (compone challenge + submit):
1. **PR1** — `REMIT_AGENTS_BASE_URL` ausente → 501 (`prepare_not_configured`). Sin backend no hay orden.
2. **PR2** — `DEPOSIT_ATTESTATION_SECRET` ausente → **503 fail-closed** (`prepare_unavailable`).
   A diferencia del submit (que skipea local sin secreto para el demo), prepare SOLO existe en el path
   real (EIP-3009 on) → sin secreto NO puede atestar → nunca fail-open. El demo nunca llama a prepare
   (no se cablea con flags OFF) ⇒ AC-5 intacto.
3. **PR3** — Rate-limit IP-only (mirror challenge:35-46), TRAS PR2 y ANTES de parsear/forwardear.
   **Crítico**: cada prepare dispara un create-order real → sin rate-limit, spam = órdenes huérfanas
   masivas (DT-5). Nuevo limiter `DEPOSIT_PREPARE_RL`.
4. **PR4** — Body null-safe (`req.json().catch(()=>null)` + `isRecord`); formato: `remittanceId`,
   `quoteId`, `kycVerificationId`, `address` no-vacíos → 400 sin fetch.
5. **PR5 (guard 4-6, WKH-202)** — `resolvePayoutAuthority({verificationId, address})`; `simulated_dev`
   en Vercel → 503; `!authorized` → mismo switch que submit (403/503/502 no-oracle).
6. **PR6 (guard 7, WKH-206)** — PoP: si `PAYOUT_POP_SECRET` set, exige `popChallenge`/`popSignature`
   válidos (P1-P5: HMAC + address + chainId + firma). **NO** claim-once (P6) — el nonce se quema recién
   en el submit del webhook/tracking; acá stateless (evita quemar el nonce antes de la firma real).
   → cualquier fallo cripto = 403 opaco.
7. **PR7** — Forward al agente `POST ${BASE}/api/agents/remit-cashout-payout/invoke` con el body
   (idempotencyKey intacto CD-10, `AbortSignal.timeout(10_000)`). `!res.ok`/timeout → 502 opaco.
8. **PR8** — Valida el shape del result (mismo `isValidPayoutResult` que submit) **+ exige
   `depositAddress` string no-vacío + `isAddress`** (AC-7 fail-closed: mock devuelve `null` →
   `prepare_no_deposit_address` 502; nunca se emite atestación sin address confirmada).
9. **PR9** — Emite `issueDepositAttestation({ remittanceId, quoteId, depositAddress, chainId:
   resolveChainId(), exp: now+TTL })`. `chainId` de la ENV server-side (CD-9, nunca del body).
10. **PR10** — Ledger best-effort flag-gated: `recordOrderPrepared({ remittanceId, quoteId,
    idempotencyKey, depositAddress→receiver_address, chainId, senderAddress: address, payoutId,
    status:'prepared' })` (visibilidad de huérfanas; NUNCA PII, CD-7/AC-8). En su try/catch, nunca rompe.
11. **PR11** — 200 `{ depositAddress, attestation, payoutId, provenance }`. NUNCA `BASE`/PII/beneficiary.

### 4.4 El guard reescrito de `settle/principal` (AC-3 — la prueba de que es TAN fuerte)

**Cambio**: `expectedTo` deja de ser SIEMPRE `resolveReceiverAddress()`; pasa a ser el `depositAddress`
del binding atestado — **flag-gated por la presencia de `DEPOSIT_ATTESTATION_SECRET`** (doble-flag,
mismo patrón que WKH-168/206):

- **Modo deposit-flow** (`DEPOSIT_ATTESTATION_SECRET` presente): el body trae `depositAttestation`
  (string). NUEVOS guards, insertados ENTRE S11 (monto) y el broadcast, reemplazando S12:
  - **B1** — `depositAttestation` ausente/no-string → 400 (`settle_binding_missing`). En este modo es
    MANDATORIO (sin él no hay `to` legítimo).
  - **B2** — `att = verifyDepositAttestation(token, Date.now())`; `null` → 400 (`settle_binding_invalid`).
  - **B3** — `att.remittanceId === body.remittanceId` (exacto) → si no, 400. Ata el binding a ESTA remesa.
  - **B4** — `att.quoteId === body.quoteId` (exacto) → si no, 400. Mata el reciclado cross-quote.
  - **B5** — `att.chainId === resolveChainId()` (ENV server-side, nunca body) → si no, 400. Mata replay
    cross-entorno (mismo espíritu que A7″).
  - **B6** — `isAddressEqual(to, att.depositAddress)` → si no, **400 (`settle_receiver_mismatch`)
    SIN broadcast ni verify** (AC-3: rechazo antes de tocar la cadena).
  - `expectedTo := att.depositAddress` para el broadcast (`payTo`) y para **V1-V9**
    (`verifySettlementOnChain({ expectedTo: att.depositAddress })`).
- **Modo estático** (secreto ausente → path WKH-168/209 sin cambios): S12 + V6 usan
  `resolveReceiverAddress()`. **Byte-idéntico** a hoy (AC-5/AC-6 para el path existente).

**Prueba de fuerza equivalente (DT-3)** — el guard nuevo es ≥ el estático:

| Propiedad del guard estático (hoy) | Preservada en el guard nuevo |
|---|---|
| `to` es un valor **server-controlado**, no del body | Sí: `att.depositAddress` viene de un HMAC firmado con `DEPOSIT_ATTESTATION_SECRET` (server-only). El caller no puede forjarlo → no puede inyectar un `to` propio (mata el vector central de desvío). |
| S12: el `to` firmado se compara byte-a-byte contra el valor server | Sí: B6 `isAddressEqual(to, att.depositAddress)`, rechazo pre-broadcast. |
| **V1-V9: verificación ON-CHAIN independiente** (lee el log Transfer real, no la firma) | **INTACTA**: sigue corriendo con `expectedTo = att.depositAddress`. La única línea que cambia es el VALOR de `expectedTo`; el mecanismo de lectura on-chain (V6/V8) es idéntico. |
| No hay path por el `to` del body | Sí: `to` sigue viniendo de `authorization.to` (firmado) y se compara contra el server-value; el body NUNCA es la fuente del `expectedTo`. |

**Adicionalmente el guard nuevo es MÁS fuerte**: ata el `to` a `remittanceId + quoteId + chainId + exp`
(el estático era un único valor global reusable entre TODAS las remesas). El TTL de 10 min acota la
ventana. → No debilita; refuerza (AC-6).

### 4.5 El reorder de `confirm-and-send.ts` (AC-1) + convivencia con el guard 8 (DT-2)

**Flujo real nuevo** (modo demo = `settlement === undefined` = byte-idéntico, AC-5):

```
confirm → authority(WKH-180) → expiry(M2)
  → PREPARE (nuevo): prepare.prepare({remittanceId, quoteId, kyc, address, amountUsd, beneficiary, idempotencyKey, pop?})
      · !ok → failAndRefund(reason, principalReallyIn=false) → return  (AC-7: falla ANTES de firmar)
      · ok → { depositAddress, attestation, payoutId, provenance }
  → authorizePrincipal(quote, s.id, { address: depositAddress })   ← to = depositAddress (AC-1)
  → settle({ …, remittanceId, depositAttestation: attestation })    ← guard reescrito (§4.4)
      · C5 (detector cliente): isAddressEqual(res.to, depositAddress) runtime (ya NO this.settlement.receiver)
  → markPrincipalIn (solo con res.txHash verificado on-chain — CD-6)
  → expiry(2º re-check)
  → markPayoutSubmitted(payoutId de PREPARE)   ← la orden YA fue creada en prepare; NO se llama submit
```

**Por qué el forward al agente se mueve de submit → prepare** (necesario para tener el `depositAddress`
ANTES de la firma). El `PayoutGateway.submit()` **ya NO se invoca en modo real**: la orden se creó en
prepare; el PEN lo libera TransFi al detectar el depósito on-chain en el `depositAddress` (webhook
WKH-210 → ledger). El estado `settled` llega async por ese webhook (sin cambios).

**DT-2 — convivencia con el guard 8 (G3/WKH-168), AC-6/CD-3, la parte más delicada:**

- El guard 8 de `submit/route.ts` (exige `settlementAttestation` = "el USDC YA entró") **NO se toca:
  queda intacto, byte-a-byte**. El endpoint `/api/a2a/payout/submit` sigue existiendo con su guard 8
  para el path demo/fallback y como defensa en profundidad. **No se remueve ni se debilita** → CD-3
  literalmente satisfecho.
- La GARANTÍA del guard 8 ("no hay entrega de valor sin evidencia on-chain de que el principal entró")
  se preserva y **se refuerza** en el nuevo path, re-alojada en DOS ataduras (las "dos ataduras" del
  DT-2 del work-item):
  1. **El settle reescrito (§4.4)**: markPrincipalIn SOLO ocurre tras V1-V9 verificando on-chain que el
     USDC llegó **al `depositAddress` atestado correcto** (evidencia on-chain, igual que hoy, + destino
     correcto). CD-6: el ledger nunca avanza a principal_in sin esa evidencia.
  2. **La liberación de PEN es deposit-gated por TransFi**: TransFi solo libera el PEN cuando detecta el
     depósito on-chain en el `depositAddress` de ESA orden. Un atacante con KYC propio aprobado que crea
     una orden (prepare) NO obtiene PEN sin depositar USDC real en la dirección de TransFi — no puede
     "pedir un payout arbitrario sin pagar" (el bug exacto que WKH-168/G3 cerró). El vector queda cerrado
     por construcción del modelo no-custodial.
- **Resultado**: el guard 8 no se debilita (intacto en submit) Y su garantía se cumple en el path real
  en un punto de fuerza ≥ (settle-binding on-chain + TransFi deposit-gating). Cada cambio de orden está
  documentado (este DT) — AC-6 satisfecho.

### 4.6 Flujo de error (fail-closed en cada punto)

| Punto | Condición | Respuesta |
|-------|-----------|-----------|
| prepare | agente caído / timeout / orden rechazada / `depositAddress` null (mock) / KYC no-auth | prepare devuelve `{ok:false, reason}` → `failAndRefund(reason, false)` **antes de firmar** (AC-7); nunca se muestra firma con `to` no confirmado |
| wallet real | `deposit.address` ausente/malformada en modo real | `throw` fail-loud (NUNCA fallback a `resolveReceiverAddress()`) |
| settle B1-B6 | binding ausente/inválido/mismatch remesa/quote/chain/to | 400 **sin broadcast ni verify on-chain** (AC-3) |
| settle V1-V9 | on-chain no confirma o `to` ≠ depositAddress | 502/503 (intacto WKH-168) |
| ledger prepared | DB caída | log enum sin PII, best-effort, money-path responde igual (CD-17) |

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- Binding = **Opción B** (gate cerrado). NO reabrir.
- La DepositAttestation sigue el molde EXACTO de `attestation.ts` (`node:crypto`, secreto interno,
  verify HMAC-first timing-safe, null-en-todo).
- `depositAddress` SIEMPRE atestado server-side; el `to` de la firma NUNCA de un campo del body/UI.
- Guard-order del prepare: 501 → 503-secreto → rate-limit → formato → autoridad → PoP → forward → shape+depositAddress → attest.
- V1-V9 on-chain **intacta**; solo cambia el VALOR de `expectedTo`.
- Ambas wallets (`InjectedWallet` + `WalletConnectWallet`) se editan **juntas, byte-a-byte**.
- Flag-gating doble: `NEXT_PUBLIC_EIP3009_ENABLED` (cliente) + `DEPOSIT_ATTESTATION_SECRET` (server).

### PROHIBIDO
- **CD-1**: mover USDC real o crear orden TransFi real fuera de un test mockeado (gateado al founder).
- **CD-2**: aceptar un `to`/`depositAddress` no atestado criptográficamente por el server.
- **CD-3**: remover o debilitar el guard 8 de `submit/route.ts` (queda intacto; su garantía se re-aloja, DT-2).
- **CD-4**: encender `NEXT_PUBLIC_EIP3009_ENABLED` / `DEPOSIT_ATTESTATION_SECRET` / `TRANSFI_ADAPTER_READY` en cualquier entorno compartido.
- **CD-5**: tocar `wasiai-remittance-agents` (ya cerrado por WKH-212).
- **CD-6**: reportar `principal_in` o disparar PEN sin evidencia on-chain real (una orden 'prepared' huérfana NUNCA es principal_in).
- **CD-7/AC-8**: persistir/loguear `depositAddress` junto a PII del beneficiario. Solo IDs/address/chainId.
- **CD-8** (heredado histórico — auto-blindaje WKH-210 FIX-A): en cualquier dedup por token single-use
  (`SET NX`) + mutación externa, quemar el token DESPUÉS de la mutación exitosa, nunca antes (aplica si
  se agrega claim-once; en esta HU el deposit-binding es stateless → no aplica, DT-6).
- **CD-9** (heredado histórico — auto-blindaje WKH-202/205/BLQ-BAJO-1): `req.json()` RESUELVE con `null`
  ante el body literal `null`; usar `.catch(()=>null)` + `isRecord`. NUNCA `Number(x)`/`String(x)`/`Money.of(Number(x))`
  sobre campos del caller sin guard de tipo previo (500 crudo / fail-open). Verificado como recurrente en 3 HUs.
- **CD-10** (heredado histórico — auto-blindaje WKH-212): toda HU que agregue un campo a un output/wire
  serializado DEBE actualizar los tests de contrato (`Object.keys(...).sort()` / snapshot) en `*/route.test.ts`.
- **CD-11**: sin `any` explícito (TS strict); type-guards explícitos para todo shape crudo del agente.

## 6. Scope

**IN**: DepositAttestation + `/api/payout/prepare` + adapters prepare + reorder confirm-and-send +
wallet to=depositAddress + settle guard reescrito + wiring `depositAddress` (WKH-212) + ledger 'prepared'
aditivo + `.env.example` + tests mockeados.

**OUT**: encender flags; orden/settle real; tocar el repo del agente; **cancelación real de órdenes
TransFi huérfanas** (follow-up — necesita API de cancelación de TransFi, no confirmada; §10); webhook
TransFi (WKH-210, intacto); migrar persistencia salvo el status aditivo.

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Desvío de fondos: caller inyecta `depositAddress` propio y la wallet firma `to=ese` | B | Crítico | DepositAttestation HMAC server-only (CD-2); wallet firma el valor server-atestado; B6 en settle re-verifica pre-broadcast (AC-3) |
| Guard S12/V6 reescrito más débil (compara contra valor mal derivado) | B | Crítico | V1-V9 on-chain INTACTA; solo cambia el valor de `expectedTo`, atado al HMAC (DT-3, tabla de fuerza) |
| Guard 8 removido/salteado → payout sin pagar (regresión WKH-168) | B | Crítico | Guard 8 INTACTO en submit (CD-3); garantía re-alojada en settle-binding + TransFi deposit-gating (DT-2) |
| Orden TransFi huérfana (prepare ok + settle falla) | M | Medio (operativo) | TTL 10 min en la atestación (bound de ventana); ledger 'prepared' para visibilidad de reconcile; **cancelación = follow-up** (§10) |
| Replay de una atestación vieja para otra remesa | B | Alto | B3/B4/B5 atan remittanceId+quoteId+chainId; TTL 10 min; nonce determinístico hace el doble-settle contract-imposible (DT-6) |
| `depositAddress` null del mock tratado como válido | B | Alto | PR8 fail-closed: exige string+isAddress; null → 502 (AC-7) |
| PII + depositAddress en log/DB | B | Medio | CD-7/AC-8; solo IDs/address/chainId al binding y ledger |
| Test de contrato del wire stale al agregar campo | M | Bajo | CD-10 (lección WKH-212): actualizar `Object.keys` de `gateways`/route tests |

## 8. Dependencias

- **WKH-212 (DONE, mergeado `3d5d1cf`)**: el agente expone `depositAddress` en `CashoutPayoutOutput`. ✅ RESUELTO.
- `DEPOSIT_ATTESTATION_SECRET` server-only (nuevo env) — solo para encender el path real (gateado al founder).
- El `depositAddress` real (no-null) exige el agente con `TRANSFI_ADAPTER_READY=true` + `TRANSFI_API_KEY` (agent-side, DT-8).

## 9. Decisiones Técnicas (DT-N)

- **DT-1 (binding = Opción B, gate cerrado)**: endpoint `/api/payout/prepare` crea la orden + emite la
  DepositAttestation ANTES de la firma. NO se reabre. Es la única forma de tener el `depositAddress`
  server-atestado antes de que el cliente firme.
- **DT-2 (convivencia guard 8)**: el guard 8 de submit queda **intacto**; su garantía se re-aloja en el
  settle-binding (evidencia on-chain al depositAddress correcto) + el deposit-gating de TransFi. Ver §4.5.
- **DT-3 (guard settle reescrito ≥ estático)**: la fuerza se preserva porque el `to` sigue siendo
  server-controlado (HMAC en vez de env) y V1-V9 on-chain queda intacta; se refuerza con binding
  per-remesa + TTL. Ver tabla §4.4.
- **DT-4 (secreto separado)**: `DEPOSIT_ATTESTATION_SECRET` ≠ `SETTLE_ATTESTATION_SECRET`. Atestaciones
  de naturaleza distinta (pre-settlement vs post-settlement) NUNCA comparten secreto (aislamiento de dominio).
- **DT-5 (huérfanas)**: TTL 10 min (< 15 min del settlement) acota la ventana; ledger 'prepared'
  (best-effort, depositAddress en `receiver_address`, sin columna nueva) da visibilidad a reconcile.
  **Cancelación real de la orden TransFi = follow-up** (necesita API de cancelación no confirmada por
  WKH-208; cross-repo). Documentado, no implícito.
- **DT-6 (sin claim-once en el deposit-binding)**: a diferencia del settlement-attestation (single-use en
  submit), el deposit-binding NO necesita claim-once: el nonce EIP-3009 determinístico
  (`keccak256(remittanceId:quoteId)`) hace que el 2º settle de la MISMA autorización REVIERTA a nivel
  CONTRATO; y B3/B4/B5 impiden reusar la atestación para otra remesa. El binding queda stateless (sin
  dependencia de Upstash en el settle path) — más simple y sin el footgun claim-before-mutate (CD-8).
- **DT-7 (submit no se llama en real)**: la orden se crea en prepare; el PEN lo dispara TransFi
  (deposit-gated) y llega por webhook (WKH-210). El endpoint submit y su guard 8 permanecen (demo +
  defensa en profundidad). `markPayoutSubmitted` usa el `payoutId` de prepare.
- **DT-8 (flags cross-repo)**: en chaski-v2 el código muerto se gatea con `NEXT_PUBLIC_EIP3009_ENABLED`
  (cliente) + `DEPOSIT_ATTESTATION_SECRET` (server). `TRANSFI_ADAPTER_READY` vive en el **agente** y es
  lo que hace el `depositAddress` no-null; con el agente en mock (default) → `null` → prepare fail-closed
  (AC-7). El "ambos flags OFF" de AC-5 se cumple con `NEXT_PUBLIC_EIP3009_ENABLED` off (el demo nunca
  cablea prepare/settle-binding).

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [TBD] | §4.1 W5 / DT-5 | Cancelación/expiración real de la orden TransFi huérfana — API de cancelación no confirmada (WKH-208 `TODO(sandbox)`), cross-repo. **Follow-up explícito**; mínimo viable de esta HU = TTL + ledger 'prepared' + fail-closed. | No |
| [TBD] | §3.3 W5.0 | Verificar si `remittance_settlements.status` tiene un `CHECK` constraint antes de usar `'prepared'`; si existe, migración aditiva. | No (se resuelve en W5) |

> Cero [NEEDS CLARIFICATION] de seguridad: el vector central (desvío por `to` inyectado) queda cerrado
> por el HMAC server-only + B6 + V1-V9 intacta; el guard 8 no se debilita (intacto + garantía re-alojada).

---

## Plan de Implementación — Waves

### Wave 0 (Serial Gate — contratos/tipos)
- [ ] **W0.1**: `deposit-attestation.ts` — `DepositAttestation` + `issue`/`verify` + TTL (mirror `attestation.ts`). → Exemplar: `settlement/attestation.ts`
- [ ] **W0.2**: `ports.ts` — `PayoutPrepareGateway`; `authorizePrincipal(quote, remittanceId, deposit?)` (fail-loud en real, no fail-open); `settlement` sin `receiver`; `'prepared'` en `SettlementLedgerStatus`; `recordOrderPrepared` en `SettlementLedger`.
- [ ] Verificación: `npx tsc --noEmit` (completo, incluye tests — lección WKH-196/MEMORY).

### Wave 1 (Endpoint prepare + adapters — depende de W0)
- [ ] **W1.1**: `app/api/payout/prepare/route.ts` (guards PR1-PR11, §4.3). → Exemplar: `challenge/route.ts` + `submit/route.ts`
- [ ] **W1.2**: `http-payout-prepare-gateway.ts`. → Exemplar: `http-settlement-gateway.ts`
- [ ] **W1.3**: `FallbackPayoutPrepareGateway` en `fallback/gateways.ts` (mock, para tests/demo).

### Wave 2 (Wallet to=depositAddress — depende de W0)
- [ ] **W2.1**: `wallet.ts` — ambas wallets: `to = deposit.address` fail-loud; elimina `resolveReceiverAddress()` de `authorizePrincipal`. (Paralelo a W1.)

### Wave 3 (Guard settle reescrito — depende de W0)
- [ ] **W3.1**: `settle/principal/route.ts` — B1-B6 flag-gated por `DEPOSIT_ATTESTATION_SECRET`; `expectedTo` dinámico; modo estático byte-idéntico. (Paralelo a W1/W2.)

### Wave 4 (Integración reorder + wiring — depende de W1, W2, W3)
- [ ] **W4.1**: `gateways.ts` (a2a) — extiende `RawPayoutResult`/`isValidPayoutShape`/map para `depositAddress` (WKH-212). Actualiza tests de contrato del wire (CD-10).
- [ ] **W4.2**: `confirm-and-send.ts` — reorder (§4.5): inserta prepare; `to=depositAddress`; `depositAttestation` al settle; C5 runtime; real-mode marca submitted desde payoutId de prepare (no submit).
- [ ] **W4.3**: `container.ts` — inyecta `prepare` (flag-gated); `settlement` sin `receiver`.

### Wave 5 (Política de huérfanas + env — depende de W1, W4)
- [ ] **W5.0**: verificar CHECK constraint de `status` (TBD §3.3); migración aditiva si aplica.
- [ ] **W5.1**: `recordOrderPrepared` en supabase-ledger + fake + ports; llamada best-effort en PR10.
- [ ] **W5.2**: `.env.example` — `DEPOSIT_ATTESTATION_SECRET` + nota `TRANSFI_ADAPTER_READY` cross-repo.

### Wave 6 (Tests — depende de todo)
- [ ] **W6.1-W6.8**: ver Test Plan.

## Test Plan (≥1 por AC, TODOS mockeados — AC-4/CD-1)

| Test | AC | Wave | Qué cubre |
|------|-----|------|-----------|
| `deposit-attestation.test.ts` | AC-2 | W6 | issue→verify round-trip; HMAC inválido→null; exp vencida→null; cada campo deforme→null; falta secreto→null; timing-safe longitud-primero; TTL≤15min (=10min). |
| `prepare.route.test.ts` — happy | AC-1 | W6 | secreto+BASE set, autoridad ok, agente mock devuelve depositAddress real → 200 `{depositAddress, attestation, payoutId}`; attestation verifica. |
| `prepare.route.test.ts` — fail-closed | AC-7 | W6 | agente 502 → 502; timeout → 502; `depositAddress:null` (mock) → `prepare_no_deposit_address`; KYC no-auth → 403; secreto ausente → 503; `null` body → 400 (CD-9). |
| `prepare.route.test.ts` — guards | AC-6 | W6 | autoridad `simulated_dev` en Vercel → 503; PoP inválido (con PAYOUT_POP_SECRET) → 403; rate-limit → 429/503. |
| `settle.route.binding.test.ts` — **ataque AC-3** (múltiples vectores) | AC-3 | W6 | (a) `to` inyectado ≠ att.depositAddress → 400 sin broadcast (spy: broadcastSettle NO llamado); (b) attestation de OTRO remittanceId (B3) → 400; (c) attestation de OTRO quoteId (B4) → 400; (d) attestation de OTRO chainId (B5) → 400; (e) HMAC forjado/sin secreto → 400; (f) attestation vencida → 400; (g) attestation ausente en modo deposit → 400 (B1). En TODOS: `verifySettlementOnChain` NO llamado. |
| `settle.route.binding.test.ts` — happy | AC-1 | W6 | binding válido → `expectedTo=att.depositAddress` pasa a V1-V9 (mock verifier) → 200 + settlement-attestation. |
| `settle.route.static.test.ts` — byte-idéntico | AC-5/AC-6 | W6 | sin `DEPOSIT_ATTESTATION_SECRET` → path estático `resolveReceiverAddress()` idéntico a WKH-209 (regresión). |
| `wallet.test.ts` | AC-1 | W6 | modo real: `to=deposit.address` en la firma (ambas wallets); `deposit` ausente en real → throw fail-loud; modo demo → signMessage byte-idéntico (AC-5). |
| `confirm-and-send.reorder.test.ts` | AC-1/AC-7 | W6 | orden real: prepare→sign→settle→submitted; prepare `!ok` → failAndRefund **sin** authorizePrincipal (spy: wallet.authorizePrincipal NO llamado, AC-7); C5 usa depositAddress runtime; real-mode NO llama `payouts.submit`. |
| `confirm-and-send.demo.test.ts` — byte-idéntico | AC-5 | W6 | `settlement===undefined` → flujo pre-HU intacto (llama submit, sin prepare). |
| `guard8-intact.test.ts` | AC-6/CD-3 | W6 | submit/route.ts guard 8 sin cambios: sin settlementAttestation → 403 (regresión WKH-168). |
| `gateways.deposit-wiring.test.ts` | AC-1 | W6 | `isValidPayoutShape` acepta `depositAddress`; map lo propaga; test de contrato del wire actualizado (CD-10). |
| `orphan-ledger.test.ts` | AC-8/CD-6 | W6 | prepare registra 'prepared' sin PII; una 'prepared' huérfana NUNCA es principal_in; DB caída → best-effort no rompe. |
| grep `MUTANT` = 0 + mutation self-check | — | W6 | mutar B6 (aceptar `to` cualquiera) → el ataque AC-3 debe MORIR; restaurar. |

## Verificación Incremental

| Wave | Verificación |
|------|--------------|
| W0 | `npx tsc --noEmit` completo |
| W1-W3 | tsc + unit del módulo |
| W4 | tsc + tests integración reorder |
| W5 | tsc + tests ledger + migración verificada |
| W6 | full QA: todos los AC + byte-identidad OFF (`git diff` del demo path limpio) + mutation self-check |

---

## Readiness Check

```
[x] Cada AC tiene ≥1 archivo asociado (tabla 4.1) y ≥1 test (Test Plan)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read (paths reales confirmados)
[x] No hay [NEEDS CLARIFICATION] de seguridad pendientes (2 [TBD] no-bloqueantes: cancelación TransFi + CHECK constraint)
[x] Constraint Directives: 11 (≥3 PROHIBIDO) — incluye 3 heredados de auto-blindaje histórico (CD-8/9/10)
[x] Context Map: 17 archivos leídos (chaski-v2 + cross-repo agente) con archivo:línea
[x] Scope IN/OUT explícitos y no ambiguos
[x] BD: tabla verificada (remittance_settlements existe; cambio aditivo, sin columna nueva)
[x] Happy Path completo (§4.5) + Flujo de error (§4.6)
[x] Los 4 puntos del invariante `to` verificados (wallet 97/117/133+251/271/286, settle S12/V1-V9 145/177-182, confirm C5 181-191, chain 86-90)
[x] El binding B, el guard reescrito, la convivencia con guard 8 y las huérfanas → cada uno con DT (DT-1..DT-8)
```

**READINESS: VERDE.** SDD listo para SPEC_APPROVED.

---

*SDD generado por NexusAgil — FULL — nexus-architect F2 — WKH-211*
