# Work Item — [WKH-211/HU-SOL-8] chaski-v3: PoP + atestación ed25519 (gate de seguridad, Solana)

## Resumen

El gate de proof-of-possession del payout (WKH-206/G5) hoy solo verifica ECDSA (`viem.verifyMessage`
+ `isAddress`) — ambos SIEMPRE rechazan (o peor, se comportan de forma indefinida) frente a una
address Solana base58. Esta HU agrega la rama Solana real: un verificador ed25519
(`nacl.sign.detached.verify`) sobre un decode base58 estricto de 32 bytes, preservando
`buildPopMessage` como SSOT y el nonce single-use (`pop-nonce-store.ts`). A diferencia de EVM (donde
PoP es opt-in vía la presencia de `PAYOUT_POP_SECRET`), el binding de Didit es débil para Solana
(`authority.ts:74-87`, `vendor_data`/`address` ambos caller-controlados) — por eso el PoP ed25519
**debe ser obligatorio** en el money-path Solana, no opcional. Además, las atestaciones deben atar un
network-id **CAIP-2** (`solana:devnet` vs `solana:mainnet`) en vez de `chainId:number` (que Solana no
tiene), para que un HMAC emitido en devnet nunca valide en mainnet (mismo vector que el "$400 por $0"
ya cerrado del lado EVM en `submit/route.ts` A7″).

Sitios de código confirmados en F0 (line numbers aproximados — el ticket cita 15/53/91,
143/155/223, 82/127/136; el grounding de esta sesión los encontró desplazados ±1-2 líneas por drift
normal del repo, mismo archivo/función):
- `src/infrastructure/auth/pop-challenge.ts` — tipo `PopChallenge` (hoy 100% EVM-shaped: `address:
  0x+40hex`, `chainId:number`), `buildPopMessage` (SSOT del mensaje firmado), `verifyPopChallenge`
  (usa `isAddress` de viem — rechaza SIEMPRE una address Solana).
- `app/api/a2a/payout/submit/route.ts` (P1-P6, líneas ~119-177) — guard PoP hoy 100% opt-in
  (`if (POP_SECRET)`), verificación con `viem.verifyMessage` (línea ~156).
- `app/api/payout/prepare/route.ts` (PR6, líneas ~109-147) — mismo guard PoP opt-in, mismo
  `viem.verifyMessage` (línea ~136), mismo `isAddress` (línea ~15,83,181).
- `src/infrastructure/auth/http-pop-signer.ts` — cliente que pide el challenge y llama
  `wallet.signMessage(popMessage)` (línea 29); para Solana requiere que el `WalletPort` exponga firma
  de mensaje arbitrario (ver Missing Inputs).
- `src/infrastructure/auth/pop-nonce-store.ts` — `claimPopNonceOnce` (Upstash `SET NX`, fail-closed):
  se reusa TAL CUAL para Solana, sin cambios (namespace `pop:nonce:${nonce}` es VM-agnóstico).
- `src/infrastructure/address.ts` (HU-SOL-7, DONE) — `canonicalizeAddress(address, vm)`: la rama
  `solana` ya hace `new PublicKey(address).toBase58()` (valida + normaliza case, fail-loud si
  malformado) y `.toBytes()` da los 32 bytes crudos — candidato de reuso para el decode estricto del
  pubkey antes de `nacl.sign.detached.verify` (evita reinventar un decoder base58 ad-hoc).
- `src/infrastructure/payout/authority.ts:74-87` — el binding Didit `vendor_data` vs `address` es
  best-effort y ambos son caller-controlados en un endpoint público (comentario MNR-B, línea ~76-84):
  confirma por qué PoP debe ser la defensa fuerte en Solana, no un nice-to-have.

## Sizing

- SDD_MODE: full
- Estimación: L
- Branch sugerido: `feat/027-hu-sol-8-pop-ed25519`
- Smart Sizing: **QUALITY** (gate de seguridad money-path, mismo criterio que WKH-206/WKH-211/HU-SOL-7)

## Acceptance Criteria (EARS)

- **AC-1**: WHEN el guard PoP recibe una address Solana (base58) y `resolveActiveVm() === 'solana'`,
  the system SHALL verificar la posesión con `nacl.sign.detached.verify(messageBytes, signatureBytes,
  pubkeyBytes)`, donde `pubkeyBytes` es un decode base58 estricto de exactamente 32 bytes.
- **AC-2**: IF una firma ed25519 forjada o inválida se presenta para un challenge PoP Solana, THEN
  the system SHALL rechazar la request con el mismo enum 403 opaco (`payout_pop_unverified`) que usa
  hoy la rama EVM (no-oracle, CD del gate original WKH-206 preservada).
- **AC-3**: WHILE `resolveActiveVm() === 'solana'` Y la request target es el money-path Solana
  (`submit`/`prepare`), the system SHALL exigir PoP como OBLIGATORIO — a diferencia del path EVM
  (opt-in por presencia de `PAYOUT_POP_SECRET`), la ausencia del secreto/config PoP en un deployment
  Solana SHALL fallar cerrado (503/501, mismo patrón que otros guards fail-closed del repo), nunca
  hacer skip silencioso del mecanismo.
- **AC-4**: IF una atestación PoP emitida para el network-id `solana:devnet` se presenta contra una
  request/entorno resuelto como `solana:mainnet` (o viceversa), THEN the system SHALL rechazarla —
  binding CAIP-2 análogo al binding `chainId` que ya existe para EVM (P4 en `submit/route.ts`, A7″ en
  la atestación de settlement).
- **AC-5**: WHEN se decodifica un pubkey Solana base58 para verificación de firma, IF el largo
  decodificado ≠ 32 bytes, THEN the system SHALL rechazar fail-closed SIN invocar
  `nacl.sign.detached.verify` (el input malformado nunca llega a la verificación criptográfica).
- **AC-6**: the system SHALL preservar `buildPopMessage` como ÚNICA fuente de verdad del mensaje
  firmado/verificado; la extensión para cargar el network-id CAIP-2 (en vez de/junto a `chainId`
  numérico) SHALL hacerse de forma ADITIVA, sin duplicar lógica de reconstrucción del mensaje en
  cliente y servidor.
- **AC-7**: WHEN una firma PoP Solana verifica exitosamente, the system SHALL reclamar el nonce
  single-use vía `claimPopNonceOnce` (`pop-nonce-store.ts`) existente, fail-closed si Upstash no está
  disponible — mismo patrón P6/A8-A9 que la rama EVM, sin módulo paralelo.
- **AC-8**: WHILE `resolveActiveVm() === 'evm'`, the system SHALL ejecutar la verificación PoP por el
  mismo código `viem.verifyMessage`/`isAddress` (ECDSA) EXACTO, byte-idéntico, sin ningún cambio de
  comportamiento ni de expectativa en la suite de tests EVM existente.

## Scope IN

- `src/infrastructure/auth/pop-challenge.ts` — generalizar `PopChallenge`/`buildPopMessage`/
  `verifyPopChallenge` a multi-VM (discriminado por `vm`), preservando la rama EVM intacta.
- `src/infrastructure/auth/pop-verify-solana.ts` (nuevo, nombre indicativo) — verificador ed25519
  (`nacl.sign.detached.verify` + decode base58 estricto, reusando `canonicalizeAddress`/`PublicKey`).
- `app/api/a2a/payout/submit/route.ts` — guard PoP (P1-P6): rama Solana + volver el mecanismo
  OBLIGATORIO cuando `vm==='solana'` (AC-3).
- `app/api/payout/prepare/route.ts` — guard PoP (PR6): mismo tratamiento que `submit/route.ts`.
- `src/infrastructure/auth/http-pop-signer.ts` — adaptar el cliente para firmar con la wallet Solana
  (si el `WalletPort` ya expone el método necesario — ver Missing Inputs).
- `src/infrastructure/auth/pop-nonce-store.ts` — SOLO si el binding CAIP-2 exige un namespace de
  nonce distinto por network-id (a decidir en F2); si no, se reusa sin cambios.
- Tests unitarios de todos los archivos de arriba (rama Solana nueva + rama EVM re-confirmada
  byte-idéntica).

## Scope OUT

- El path EVM (`viem`/ECDSA) — NO se refactoriza, NO se le agrega ningún requisito nuevo de
  "obligatoriedad" (permanece opt-in por `PAYOUT_POP_SECRET`, tal cual WKH-206 lo dejó).
- Broadcast/settle real del payout en Solana (HU-SOL-9) — esta HU es SOLO el gate de identidad PoP,
  no dispara ningún movimiento de fondos.
- Verificación server-side del deposit/escrow Solana (HU-SOL-13) y broadcast gasless (HU-SOL-14).
- `@solana/pay` — prohibido por constraint de programa (CD-7 de HU-SOL-1, reafirmado acá).
- Cualquier cambio a `authority.ts` / el binding Didit `vendor_data` (el hallazgo de auditoría lo usa
  como JUSTIFICACIÓN de por qué el PoP debe ser obligatorio, pero el hardening del binding Didit en sí
  mismo NO es scope de esta HU).
- Flags nuevos encendidos en ningún ambiente compartido — Solana sigue en devnet/flags OFF (CD del
  programa Solana LATAM Labs).

## Decisiones técnicas (DT-N)

- **DT-1**: el verificador ed25519 usa `nacl.sign.detached.verify(msgBytes, sigBytes, pubkeyBytes)` de
  `tweetnacl`; el decode del pubkey base58 reusa `new PublicKey(address).toBytes()` (ya usado por
  `canonicalizeAddress`, HU-SOL-7) — garantiza 32 bytes exactos o throw, evita reinventar un decoder
  base58 estricto ad-hoc. Justificación: reuso de código ya auditado (AR de HU-SOL-7 lo probó contra
  IDOR de colisión), menor superficie nueva de bugs criptográficos.
- **DT-2**: dependencia `tweetnacl` — a verificar en F2/F3 si ya resuelve transitivamente (candidatos:
  `@solana/web3.js`, `@coral-xyz/anchor`, `@solana/spl-token`, todos ya en `package.json`, suelen
  depender de `tweetnacl` internamente). Si no resuelve, agregarla explícita y pineada, verificando que
  no requiera `--legacy-peer-deps` contra el árbol actual (web3.js v1 pineado).
- **DT-3**: el binding CAIP-2 se implementa extendiendo `PopChallenge`/`buildPopMessage` con un campo
  nuevo para el network-id Solana (`solana:devnet` | `solana:mainnet`), en paralelo al `chainId:
  number` que la rama EVM sigue usando. El shape exacto (unión discriminada por `vm` vs campo opcional
  compartido) queda para el Architect en F2 — ambas alternativas cumplen las CDs de esta HU.
- **DT-4**: volver PoP obligatorio en Solana sin romper el patrón opt-in EVM requiere una rama de guard
  condicionada explícitamente por `resolveActiveVm()` en `submit/route.ts` y `prepare/route.ts` — el
  diseño exacto (nuevo guard temprano fail-closed vs modificar el `if (POP_SECRET)` existente
  agregando un `else if (vm === 'solana') return 503`) se define en el SDD de F2.
- **DT-5**: esta HU asume que el `WalletPort` Solana (construido en HU-SOL-4/HU-SOL-5) ya expone o
  puede exponer un método de firma de mensaje arbitrario (ed25519 "signMessage", análogo a
  `personal_sign` de EVM) para que el cliente firme el `popMessage`. No verificado en este F0 — el
  Architect debe confirmarlo en `src/infrastructure/wallet.ts`/el adapter Solana antes de cerrar el
  SDD (ver Missing Inputs).

## Constraint Directives (CD-N)

- **CD-1 (EVM byte-idéntico)**: PROHIBIDO modificar ni un byte del comportamiento de la rama EVM
  (`viem.verifyMessage`, `isAddress`) ni de ninguna assertion de test EVM existente. La rama Solana es
  100% aditiva detrás de la discriminación por `vm`.
- **CD-2 (PoP obligatorio en Solana)**: PROHIBIDO que la ausencia de config PoP (`PAYOUT_POP_SECRET` u
  otro secreto server-only equivalente) produzca un skip silencioso del mecanismo cuando
  `resolveActiveVm() === 'solana'` en el money-path (`submit`/`prepare`). OBLIGATORIO fail-closed
  (503/501) en ese caso — a diferencia de EVM, donde el skip es comportamiento deliberado (WKH-206
  DT-4/AC-1) y NO cambia.
- **CD-3 (CAIP-2 anti-cross-cluster)**: OBLIGATORIO que las atestaciones PoP Solana aten un network-id
  CAIP-2 explícito (`solana:devnet`/`solana:mainnet`), NUNCA un `chainId:number` inventado para
  Solana. PROHIBIDO compartir el mismo secreto HMAC entre devnet y mainnet sin que el guard verifique
  el network-id del token contra el network-id resuelto server-side (mismo patrón que el chainId
  binding EVM, A7″/`resolveChainId()`) — reabrir este vector reabre la clase de bug "$400 por $0" ya
  cerrada del lado EVM.
- **CD-4 (decode base58 estricto)**: PROHIBIDO aceptar un pubkey base58 sin validar EXACTAMENTE 32
  bytes antes de invocar `nacl.sign.detached.verify`. OBLIGATORIO reusar el decode ya auditado de
  `canonicalizeAddress`/`PublicKey` (HU-SOL-7) — PROHIBIDO reinventar un decoder base58 ad-hoc nuevo.
- **CD-5 (nonce single-use preservado)**: OBLIGATORIO que la rama Solana reuse `claimPopNonceOnce`
  (`pop-nonce-store.ts`) fail-closed, mismo patrón P6/A8-A9 de la rama EVM. PROHIBIDO un mecanismo de
  nonce paralelo, stateless-only, o que no falle cerrado ante Upstash no disponible.
- **CD-6 (`buildPopMessage` SSOT)**: OBLIGATORIO que `buildPopMessage` siga siendo la ÚNICA fuente de
  verdad del mensaje firmado/verificado. Cualquier extensión para cargar CAIP-2 debe ser aditiva; el
  cliente firma el mensaje VERBATIM (mismo patrón que `http-pop-signer.ts` ya documenta para EVM,
  "NO reconstruye el string").
- **CD-7 (sin `@solana/pay`, sin deps no verificadas)**: PROHIBIDO agregar `@solana/pay`. Si se agrega
  `tweetnacl` explícitamente (DT-2), OBLIGATORIO verificar que resuelve sin `--legacy-peer-deps`
  contra el árbol pineado (web3.js v1) antes de mergear.
- **CD-8 (canonicalización de address)**: OBLIGATORIO que cualquier comparación de address en los
  sitios nuevos/tocados use `canonicalizeAddress(address, vm)` (HU-SOL-7). PROHIBIDO `.toLowerCase()`
  crudo sobre una address base58 (reabriría el IDOR que HU-SOL-7 cerró).

## Missing Inputs

- **[NEEDS CLARIFICATION] No bloqueante**: ¿El `WalletPort` Solana (HU-SOL-4/HU-SOL-5) ya expone un
  método de firma de mensaje arbitrario (ed25519, análogo a `personal_sign`)? Este F0 no leyó el
  adapter Solana completo de `wallet.ts` (fuera del alcance de los "sitios" listados en la HU). Si NO
  existe, es una dependencia bloqueante que el Architect debe resolver en F2 (posiblemente agregar el
  método al port, coordinando con el scope ya cerrado de HU-SOL-4/5).
- **[NEEDS CLARIFICATION] No bloqueante**: shape exacto de la extensión CAIP-2 de `PopChallenge`/
  `buildPopMessage` (DT-3) — decisión de diseño para el Architect en F2, ambas alternativas
  (discriminada vs campo opcional) cumplen las CDs de esta HU.
- **[NEEDS CLARIFICATION] No bloqueante**: confirmar en F2/F3 si `tweetnacl` resuelve transitivamente
  en el árbol de deps actual (DT-2) — verificar antes de escribir el Story File; si no resuelve,
  agregarla como dependencia real pineada.

## Análisis de paralelismo

- **Depende de**: HU-SOL-7 (WKH-213, DONE 2026-07-21, `canonicalizeAddress`) y HU-SOL-5 (WKH-207,
  DONE 2026-07-21, wallet Solana firma). Ambas dependencias YA están DONE — sin bloqueo.
- **Bloquea a**: HU-SOL-9 (settle Solana), que necesita este gate cerrado antes de poder mover dinero
  real en el money-path Solana (mismo rol que WKH-206/G5 tuvo para el gate EVM).
- **Coordinación de archivos**: toca `submit/route.ts` y `prepare/route.ts` — los MISMOS archivos de
  más alto riesgo que tocó WKH-211 (ya DONE, no hay conflicto activo). Ninguna otra HU está corriendo
  en paralelo sobre `chaski-v3` en este momento (single analyst, confirmado por `_INDEX.md`). Futuras
  HUs EVM que toquen el guard-order de estos dos archivos deben coordinar orden de merge con
  cualquier HU-SOL-8 en curso.
- **Sin overlap** con `pop-challenge.ts`/`pop-nonce-store.ts` respecto de otro trabajo activo — son
  archivos exclusivos de la familia PoP (WKH-206/HU-SOL-8), sin otra HU tocándolos hoy.
