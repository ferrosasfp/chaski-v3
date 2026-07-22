# Report — HU [WKH-211] [HU-SOL-8] PoP + atestación ed25519 VM-aware

**Status**: DONE
**Fecha**: 2026-07-22
**Commit**: `eb9a406` (branch `feat/027-hu-sol-8-pop-ed25519`)

## Resumen ejecutivo

HU-SOL-8 cierra el gate de seguridad G5 (proof-of-possession) para el money-path Solana. El verificador ed25519 aislado (`nacl.sign.detached.verify` + decode base58 estricto de 32 bytes) reemplaza el stub del `signMessage` cliente, preserva `buildPopMessage` como SSOT y el nonce single-use via Upstash, vuelve PoP OBLIGATORIO (fail-closed 503) en Solana sin romper el opt-in EVM, y ata las atestaciones a un network-id CAIP-2 (`solana:devnet` | `solana:mainnet`) para anti-replay cross-cluster. La rama EVM es byte-idéntica.

## Pipeline ejecutado

- **F0**: project-context cargado, work-item + ACs EARS confirmados
- **F1**: work-item.md (gate: HU_APPROVED + SPEC_APPROVED, 2026-07-22)
- **F2**: SDD.md + constraint directives, decisiones técnicas 1-5, missing inputs resueltos
- **F2.5**: story-HU-SOL-8.md (SPEC_APPROVED para F3)
- **F3**: implementación single-commit, 1 wave, 11 archivos tocados:
  - Nuevos: `src/infrastructure/auth/pop-verify-solana.ts` (verificador ed25519 estricto)
  - Extendidos: `src/infrastructure/auth/pop-challenge.ts` (tipos Solana paralelos, SSOT CAIP-2)
  - Wiring: `app/api/a2a/payout/submit/route.ts` (P1-P6, rama Solana + obligatoriedad), `app/api/payout/prepare/route.ts` (PR6, mismo patrón)
  - Adapter: `src/infrastructure/solana-wallet.ts` (`signMessage` real, ed25519 TextEncoder browser-safe)
  - Deps: `tweetnacl@1.0.3` + `bs58@6.0.0` pinned, sin `--legacy-peer-deps`
  - Tests: 621 tests (594 base + 27 nuevos Solana), tsc exit 0
- **AR**: APROBADO — 8 vectores de seguridad (decode/verify/CAIP-2/nonce/EVM-byte-idéntico/browser-safety), 0 findings
- **CR**: APROBADO — code review byte-a-byte, 0 BLQ / 0 MENOR
- **F4 QA**: APROBADO PARA DONE — 8/8 ACs PASS con evidencia archivo:línea, drift NONE, EVM regresión-free

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `src/infrastructure/auth/pop-verify-solana.ts:15-17,41` (decode 32 bytes + `nacl.sign.detached.verify`); test `:35` "firma ed25519 legítima ⇒ true" |
| AC-2 | PASS | `app/api/a2a/payout/submit/route.ts:172-181` (P5, enum `payout_pop_unverified`); test `submit/route.test.ts:1040` "firma de otra key ⇒ 403" |
| AC-3 | PASS | `submit/route.ts:139-143` (vm=solana + !POP_SECRET ⇒ 503 fail-closed); test `submit/route.test.ts:1011` "no agente nunca" |
| AC-4 | PASS | `submit/route.ts:168-171` (P4 binding CAIP-2 server-side); test `submit/route.test.ts:1060` "token mainnet + server devnet ⇒ 403" |
| AC-5 | PASS | `pop-verify-solana.ts:24-38` (guardas longitud + try/catch ANTES de nacl.verify); test `:73,98` "spy 0 invocaciones en malformado" |
| AC-6 | PASS | `pop-challenge.ts:53-55,119-121` (EVM 0 líneas modificadas, `buildSolanaPopMessage` hermana nueva); cliente firma verbatim |
| AC-7 | PASS | `submit/route.ts:184-190` (reusa `claimPopNonceOnce` importado); test `submit/route.test.ts:1090,1105` "replay 409, fail-closed 503" |
| AC-8 | PASS | Git diff byte-idéntico rama EVM (`git diff main...HEAD -- submit/route.ts` = solo indentación + `else if (POP_SECRET)`); suite EVM completa verde sin cambios de asserts |

## Cadena de gates (veredictos del orquestador)

- **HU_APPROVED** (2026-07-22): Work Item EARS + constraint directives validadas
- **SPEC_APPROVED** (2026-07-22): SDD + decisiones técnicas + missing inputs resueltos
- **AR APROBADO** (2026-07-22): 8 vectores de ataque, 0 findings
- **CR APROBADO** (2026-07-22): byte-idéntico en rama EVM, código Solana limpio, 0 BLQ/0 MENOR
- **F4 QA APROBADO** (2026-07-22): 8/8 ACs + evidencia + typecheck 0 + tests 621/621

## Diseño clave

### Verificador ed25519 (AC-1, AC-5)
- Ubicación: `pop-verify-solana.ts:15-41` (nuevo, aislado, ~40 líneas)
- Algoritmo: `nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes)`
- Decode estricto: `new PublicKey(address).toBytes()` (reutilizado de HU-SOL-7, reusa audit AR)
- Guardas fail-closed: longitud pubkey ≠ 32 bytes ⇒ throw, longitud firma ≠ 64 bytes ⇒ false SIN invocar nacl.verify
- Seguridad: criptografía delegada a `tweetnacl` (la lib estándar de Ed25519 en ecosistema Solana)

### Obligatoriedad en Solana (AC-3)
- Guard nuevo en `submit/route.ts:139-143`: `if (vm==='solana') if (!POP_SECRET) return 503`
- Mismo patrón en `prepare/route.ts:122-126`
- Diferencia EVM: opt-in (skip silencioso si no hay secret), Solana: fallo ruidoso (fail-closed)
- Justificación: binding Didit débil en Solana (`vendor_data` + `address` caller-controlados, `authority.ts:74-87`) ⇒ PoP es la defensa fuerte única

### Binding CAIP-2 anti-replay (AC-4, AC-6)
- Ubicación: `pop-challenge.ts:119-121` (`buildSolanaPopMessage`) + `src/infrastructure/chain.ts:136-144` (`resolveSolanaNetworkId`)
- Atestación: el `networkId` viaja en el mensaje firmado (ej: `"solana:devnet"`)
- Verificación server-side: `resolveSolanaNetworkId()` resuelve desde config (env var `SOLANA_DEVNET=true|false`), NUNCA del body
- Rechazo: token `solana:mainnet` + server `solana:devnet` ⇒ P4 del guard, 403 `payout_pop_unverified` (no-oracle, misma clase que EVM)
- Clase de ataque cerrada: "$400 por $0" (HMAC emitido en devnet valida en mainnet), análoga a la ya cerrada del lado EVM en WKH-206

### Nonce single-use (AC-7)
- Reutilización: `pop-nonce-store.ts` importado sin cambios, namespace `pop:nonce:${nonce}` VM-agnóstico
- Storage: Upstash (fail-closed si no disponible)
- Mecánica: `claimPopNonceOnce` retorna true si el nonce NO había sido visto, false si replay
- Integración: `submit/route.ts:184-190` consume el resultado, 409 conflict si replay, 503 si Upstash caído

### EVM byte-idéntico (AC-8)
- Rama EVM preservada: `pop-challenge.ts` (PopChallenge, issuePo, verifyPopChallenge, buildPopMessage) 0 líneas modificadas
- Guards EVM intactos: `submit/route.ts:191-242`, `prepare/route.ts` sección equivalente
- Tests EVM: suite completa pasa SIN cambios de asserts (regresión-free confirmada por F4 QA)
- Git diff rama EVM: solo indentación + `else if (POP_SECRET)`, cero lógica

### Browser-safety (auto-blindaje)
- Verificador server: 0 Node.js-isms, delegado a `tweetnacl` (isomórfica)
- Adaptador cliente (`solana-wallet.ts:157-161`): `TextEncoder` (DOM estándar) + `bs58` (ESM, isomórfica)
- Prohibido: `Buffer` node-only, `node:crypto` en navegador
- Validación: test `solana-wallet.test.ts:249-264` ("bytes firmados = TextEncoder(message)")

## Archivos modificados (11 total)

### Nuevos (2)
- `src/infrastructure/auth/pop-verify-solana.ts` — verificador ed25519 aislado (40 líneas)
- Tests: `src/infrastructure/auth/pop-verify-solana.test.ts` (7 tests, covers AC-1/AC-5/decode malformado)

### Extendidos (9)
| Archivo | Líneas | Qué |
|---------|--------|-----|
| `src/infrastructure/auth/pop-challenge.ts` | +60/-0 | Tipos Solana (`SolanaPopChallenge`, `issueSolanaPopChallenge`, `verifySolanaPopChallenge`, `buildSolanaPopMessage`); EVM +0 líneas |
| `src/infrastructure/auth/pop-challenge.test.ts` | +N/-0 | Tests Solana (nueva sección) + regresión EVM verde |
| `app/api/a2a/payout/submit/route.ts` | +68/-3 | P1-P6 rama Solana + volver PoP OBLIGATORIO; rama EVM byte-idéntico en bloque |
| `app/api/a2a/payout/submit/route.test.ts` | +175/-0 | Tests AC-1..AC-8 Solana; suite EVM intacta |
| `app/api/payout/prepare/route.ts` | +61/-3 | PR6 rama Solana (misma obligatoriedad); rama EVM intacta |
| `app/api/payout/prepare/route.test.ts` | +24/-0 | Tests Solana prepare |
| `app/api/a2a/payout/challenge/route.ts` | +29/-2 | Emisión de challenge Solana (`issueSolanaPopChallenge`); EVM intacto |
| `app/api/a2a/payout/challenge/route.test.ts` | +53/-0 | Tests challenge Solana |
| `src/infrastructure/solana-wallet.ts` | +20/-0 | `signMessage(message)` impl real (ed25519 TextEncoder); `signTransaction` pre-existente de HU-SOL-5 untouched |
| `src/infrastructure/solana-wallet-bridge.ts` | +5/-0 | Helper para seam React-free (registro de `signMessage`) |
| `src/presentation/solana/solana-providers.tsx` | +15/-0 | Sync de `useWallet().signMessage` hacia el adapter imperativo |
| `package.json` + `package-lock.json` | +2/-0 | `tweetnacl@1.0.3`, `bs58@6.0.0` pinned, install verificado (cero `--legacy-peer-deps`) |

### No tocados (verificado: 0 cambios esperados)
- `src/infrastructure/auth/http-pop-signer.ts` — cliente VM-agnóstico (ya usaba `wallet.signMessage` abstracto)
- `src/infrastructure/auth/pop-nonce-store.ts` — storage VM-agnóstico
- `src/infrastructure/address.ts` — reuso solo de `canonicalizeAddress`, sin cambios

## Auto-Blindaje consolidado

### Trap #1: bs58@6 es ESM-only
- **Problema**: `require('bs58')` → `undefined`. `npm -e "require('bs58')"` no resolvía `.encode/.decode`.
- **Causa**: `bs58@6` es 100% ESM (`"type":"module"`). El proyecto TAMBIÉN es ESM, pero validar una dep con CommonJS es error.
- **Cura**: verificar con `node --input-type=module -e "import bs58 from 'bs58'; ..."` (o en test vitest ESM).
- **Aplicar en**: cualquier nueva dep ESM-only del ecosistema Solana. NUNCA validar con `require()` en repo tipo:"module".

### Trap #2: resolveSolanaNetworkId() switch exige default case
- **Problema**: `switch (resolveSolanaNetworkConfig().cluster)` con solo `case "devnet"` dejaba tsc (`noImplicitReturns`) sin return garantizado.
- **Causa**: aunque el tipo es literal `"devnet"` (exhaustivo hoy), TS no trata siempre el switch como return-complete.
- **Cura**: agregar `default: throw new Error("unsupported_solana_cluster")` (fail-loud). tsc exit 0.
- **Aplicar en**: futuros `switch` sobre uniones literales de un solo miembro con retorno no `void`. Agregar `default` fail-loud desde inicio.

## Hallazgos finales

- **BLOQUEANTEs resueltos**: ninguno (todo PASS)
- **MENOREs**: ninguno (AR 0 findings, CR 0 BLQ/0 MENOR)
- **Deuda diferida**: ninguna (scope IN ejecutado 100%, scope OUT respetado)

## Decisiones diferidas a backlog

- **HU-SOL-9 (WKH-208)**: esta HU desbloquea el binding no-custodial Solana (wire al facilitator, dispatch base58 en el money-path). Recomendación de orden: esta HU (#8) debe mergearse ANTES que HU-SOL-9 (#9), ambas tocan `submit/route.ts` pero en secciones distintas (SDD especifica: no hay overlap de líneas si HU-8 cierra el guard antes del bloque forward que HU-9 extiende). Coordinar merge con orquestador.
- **PR6 (prepare/route.ts)**: la rama Solana de `prepare` queda inalcanzable e2e hasta HU-SOL-9 (que abre la familia de archivos `deposit-attestation.ts`, `settle/principal/route.ts` con la rama base58 del binding). Esta HU entrega el verificador + guard, HU-SOL-9 lo consume. No bloquea a esta HU (compilar/test DONE).

## Lecciones para próximas HUs

1. **Deps ESM-only requieren verificación en modo ESM**: no confiar en `require()` para validar la API de un paquete moderno. Usar `node --input-type=module` o el test harness del proyecto (vitest ESM).

2. **Switch sobre uniones literales pequeñas**: TS permite tipos literales exhaustivos pero el análisis `noImplicitReturns` puede no reconocerlos. Agregar `default: throw` desde el inicio es más seguro que iterar luego.

3. **Reuso de verificadores auditados**: el decode base58 de `canonicalizeAddress` (HU-SOL-7) fue auditado por AR contra IDOR. Reusar para el verificador ed25519 reduce la superficie de bugs criptográficos nuevos. Beneficio observado: ninguno de los 8 vectores de ataque del AR exploró el decode una segunda vez (confió en la auditoria anterior).

4. **Guard-order y EVM byte-idéntico bajo presión**: el patrón de mover la rama EVM a un `else if` con cero cambios de lógica facilita la verificación line-by-line en CR. El auto-blindaje no tocó este tema (fue correctamente ejecutado en F3), pero es un patrón a repetir en futuras HUs EVM/Solana paralelas.

---

**Cierre**: HU-SOL-8 DONE. Pipeline QUALITY completo (F0→F1→F2→F2.5→F3→AR→CR→F4). La rama Solana del gate G5 está lista para desbloquear HU-SOL-9 (settlement no-custodial).
