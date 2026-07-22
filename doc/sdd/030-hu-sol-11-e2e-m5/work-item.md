# Work Item — [WKH-214 / HU-SOL-11] e2e Solana devnet + deploy + smoke (entrega M5)

## Resumen
Cierra el gap de código que bloquea el e2e no-custodial en Solana devnet (KYC → orquestación →
wallet firma+envía SPL USDC al escrow → facilitator verifica vault → release → orden TransFi
sandbox USDCSOL → tx verificable en Solana Explorer). Esta HU entrega SOLO la porción que el equipo
de ingeniería puede construir y testear con mocks/CI: la rama Solana faltante de
`/api/payout/prepare`, un smoke script parametrizable por env, y la documentación de variables de
entorno necesarias. El cierre real de M5 (deploy + keypairs + tx verificable en explorer) es un
runbook founder-gated, NO un entregable de F3.

## Sizing
- SDD_MODE: full
- Estimación: L (código M + smoke script M + docs/runbook S, pero cross-repo y de alto riesgo
  money-path)
- Branch sugerido: `feat/030-hu-sol-11-e2e-m5`
- Skills Router (máx 2): `nexus-agile` (metodología QUALITY, ya activa) + ninguna skill de dominio
  adicional declarada — el trabajo es 100% dentro de patrones ya establecidos en HU-SOL-1/4/5/7/8/9/13
  (multi-VM config, fail-closed guards, atestación HMAC). No se detectó necesidad de una skill nueva.

## Grounding (F0) — hallazgos clave
- **H1 confirmado en código, no solo en el report**: `app/api/payout/prepare/route.ts` (PR7-PR11,
  L220-294) NO tiene NINGUNA rama por `resolveActiveVm()`. El único guard multi-VM del archivo es el
  de validación de `address` de ENTRADA (L93-105, PR4) y PoP (L138-218, PR6) — la respuesta 200 de
  salida (L294) siempre arma `{depositAddress, attestation, payoutId, provenance}` shape-EVM, y L252
  exige `isAddress(depositAddress)` (viem, SIEMPRE `false` para un address base58 Solana). Con
  `vm==="solana"`, un `depositAddress` base58 real del agente hace que el prepare muera en L252-254
  con `502 prepare_no_deposit_address` — fail-closed (seguro), pero el money-path Solana NO puede
  completarse nunca.
- `HttpSolanaPayoutPrepareGateway` (`src/infrastructure/settlement/http-solana-prepare-gateway.ts`,
  ya mergeado en HU-SOL-13a) YA espera consumir `{beneficiary, authority, attestation, payoutId,
  provenance}` (`isValidSolanaPrepareShape`, L48-58) — el cliente está listo, el server no.
- `resolveSolanaReleaseAuthorityPubkey()` (`src/infrastructure/chain.ts:178-187`, HU-SOL-9) ya existe
  y resuelve `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` (fail-loud si falta/malformado, valida con
  `PublicKey` base58). Nadie lo invoca todavía desde `prepare/route.ts`.
- `.env.example` (raíz de `chaski-v3`, 193 líneas) **NO documenta** `SOLANA_ESCROW_RELEASE_AUTHORITY_
  PUBKEY` ni `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY` (ambas ya consumidas por `chain.ts` desde
  HU-SOL-5/HU-SOL-9) — gap de documentación confirmado, no solo teórico.
- **Los repos `wasiai-facilitator` y `wasiai-remittance-agents` NO están montados en este workspace**
  (`Glob` sobre `/home/ferdev/.openclaw/workspace/` no los encuentra). El grounding de sus envs se
  basa ÚNICAMENTE en las citas ya documentadas en
  `doc/sdd/029-hu-sol-13-escrow-integration/report.md` (L37, L43): facilitator necesita
  `SOLANA_ESCROW_RELEASE_AUTHORITY_SECRET_KEY` + un secreto de atestación + (de HU-SOL-14, no releído
  en esta sesión) fee-payer/RPC/mint; remit-agents necesita `TRANSFI_USDC_NETWORK=solana`. Esto se
  documenta como checklist NO VERIFICADO contra código real (ver Missing Inputs).

## Acceptance Criteria (EARS)

### (A) CÓDIGO/ARTEFACTOS — implementables y testeables por el equipo (Scope IN de F3)
- AC-1: WHEN `POST /api/payout/prepare` se invoca con `resolveActiveVm() === "solana"` y el upstream
  del agente devuelve un `depositAddress` base58 válido, the system SHALL responder `200` con el
  shape `{beneficiary, authority, attestation, payoutId, provenance}` (base58), donde `authority` es
  el resultado de `resolveSolanaReleaseAuthorityPubkey()`.
- AC-2: IF `resolveSolanaReleaseAuthorityPubkey()` lanza (env `SOLANA_ESCROW_RELEASE_AUTHORITY_
  PUBKEY` ausente o malformada), THEN the system SHALL responder un error 5xx opaco (enum estable,
  sin CD-5/CD-12 — nunca 200 parcial, nunca ecoa el env crudo).
- AC-3: IF el `depositAddress`/`beneficiary` devuelto por el agente no es un base58 válido (falla
  `canonicalizeAddress(x, "solana")`) o es `null`, THEN the system SHALL responder el mismo error
  opaco que hoy usa la rama EVM (`prepare_no_deposit_address`), sin distinguir el motivo exacto en el
  body (CD-12 no-oráculo).
- AC-4: WHILE `resolveActiveVm() === "evm"`, the system SHALL mantener el guard-order y el shape de
  respuesta de `/api/payout/prepare` (PR1-PR11) byte-idénticos a los actuales — 0 regresión en los
  tests EVM existentes.
- AC-5: the system SHALL proveer un smoke script (`scripts/smoke-solana-e2e.*`) parametrizable
  100% por variables de entorno (URLs de los 3 servicios, keys/tokens, sin ningún valor hardcodeado)
  que ejercite, con checkpoints explícitos y logueados, la secuencia KYC → prepare → deposit →
  sponsor/broadcast → verify vault → release → orden TransFi → link de explorer.
- AC-6: IF el smoke script corre sin el flag explícito de opt-in (p. ej. una env `SMOKE_ALLOW_REAL`
  ausente/`false`), THEN el script SHALL abortar ANTES de ejecutar cualquier request de dinero real,
  con un mensaje explícito de por qué se abortó.
- AC-7: the system SHALL documentar en `.env.example` de `chaski-v3` TODAS las variables Solana ya
  consumidas por código pero no documentadas hoy (`SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY`,
  `NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY`, y cualquier otra que el Architect confirme en F2 vía grep
  de `process.env` sobre `src/`), con el mismo formato de comentario explicativo que el resto del
  archivo (qué hace, quién la lee, qué pasa si falta).

### (B) FOUNDER-GATED / RUNBOOK — NO ejecutable por el equipo, solo esqueleto documental
- El equipo entrega un **esqueleto de runbook** (`doc/sdd/030-hu-sol-11-e2e-m5/runbook-skeleton.md`,
  a escribir en F2/F2.5 por el Architect) que enumera, en orden, los pasos que el founder debe
  ejecutar manualmente para cerrar M5:
  1. Merge + deploy `wasiai-facilitator` (orden `026→027→13bc`, HELD hoy) a Railway.
  2. Migraciones: `004` (facilitator, escrow release dedup) + `20260721` (chaski, referida en
     HU-SOL-13 pero no confirmada en este F0 — el Architect debe verificar el nombre exacto en F2).
  3. Generar + fondear keypairs devnet: fee-payer (facilitator) y release-authority (facilitator,
     el pubkey correspondiente va en `SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY` de chaski).
  4. Confirmar IDs del sandbox TransFi para el corredor Solana (`TRANSFI_USDC_NETWORK=solana` en
     remit-agents, más cualquier ID de orden que el sandbox exija).
  5. Deploy de `chaski-v3` y `remit-agents` a Vercel con las envs de la sección (A)/AC-7 seteadas.
  6. Flip de flags (`NEXT_PUBLIC_VM=solana`, `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED`, y cualquier otro
     que HU-SOL-13/14 hayan dejado OFF) — SOLO en el entorno del smoke, nunca en un entorno
     compartido con tráfico real.
  7. Correr el smoke script de (A)/AC-5 contra los servicios deployados.
  8. Capturar el link de Solana Explorer de la tx real y adjuntarlo como evidencia de cierre de M5.
  - Este esqueleto NO es código, NO se ejecuta en esta HU, y NO forma parte de los Quality Gates de
    F3/AR/CR — es un entregable de documentación que el founder consume después.

## Scope IN
- `app/api/payout/prepare/route.ts` (rama Solana en PR7-PR11, reusando `resolveActiveVm()` ya
  presente en PR6)
- `.env.example` (raíz `chaski-v3`) — variables Solana faltantes
- `scripts/smoke-solana-e2e.*` (nuevo)
- Tests unitarios/integración del branch nuevo de `prepare/route.ts` (mock env + mock agente)
- `doc/sdd/030-hu-sol-11-e2e-m5/runbook-skeleton.md` (documento, no código)

## Scope OUT
- Deploy real de los 3 servicios (Vercel/Railway)
- Generación/fondeo de keypairs devnet reales (fee-payer, release-authority)
- IDs reales del sandbox TransFi Solana
- Aplicar migraciones en prod (`004` facilitator, la de chaski referida en HU-SOL-13)
- Flip de cualquier flag en un entorno compartido
- Ejecutar el smoke script contra servicios deployados / capturar la tx real de explorer
- Cualquier cambio de código en `wasiai-facilitator` o `wasiai-remittance-agents` (repos no
  accesibles en este workspace — fuera de scope por definición, no solo por decisión)
- El companion Zod NC-2 del facilitator (`AcceptedSchema` rechaza `asset`/`payTo` base58) — ya
  identificado como hallazgo cross-repo de HU-SOL-9, no se resuelve acá
- NC-1 (beneficiary REAL de TransFi Solana) — sigue founder-gated; esta HU consume el mismo campo
  que ya devuelve el agente (`depositAddress`, potencialmente `null` en modo mock), no lo crea

## Decisiones técnicas (DT-N)
- DT-1: El campo `beneficiary` de la respuesta Solana se resuelve del MISMO campo upstream que hoy
  usa la rama EVM (`okResult.depositAddress`, el agente no cambia su contrato HTTP) — solo cambia
  la validación (`canonicalizeAddress(x, "solana")` en vez de `isAddress`) y el nombre de la clave
  en el JSON de salida. Minimiza el diff, no depende de que el agente exponga un campo nuevo.
- DT-2: `resolveSolanaReleaseAuthorityPubkey()` se invoca DESPUÉS de validar el `beneficiary` (mismo
  orden que el resto del guard-order: primero se confirma que hay algo que atestar, después se arma
  el shape completo) — evita filtrar el estado de la env de authority antes de tener una orden válida.
- DT-3: Falta de authority pubkey usa un código de error NUEVO y opaco (nombre exacto a decidir en
  F2 por el Architect, ej. `prepare_solana_authority_unavailable`), NUNCA reutiliza
  `payout_authority_unavailable` (ese código ya significa "Didit no disponible", CD-12 no-oráculo —
  colisionarlo sería un bug de semántica, no solo de estilo).
- DT-4: El smoke script se escribe en TypeScript (`tsx`/`ts-node`, a decidir en F2) para reusar los
  tipos y validadores de shape ya existentes en el repo (`isValidSolanaPrepareShape`, etc.) en vez de
  reimplementar parsing en bash — reduce el riesgo de que el smoke mienta sobre un shape inválido.
- DT-5: La documentación de envs de `wasiai-facilitator`/`wasiai-remittance-agents` (2 de los 3 repos
  de la HU original) se entrega como checklist referenciado en el runbook-skeleton, citando
  explícitamente las fuentes (`report.md` de HU-SOL-13/14), marcado "no verificado contra código
  real" — NO se inventan nombres de variables sin fuente documentada.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar el guard-order existente (PR1-PR11) de `prepare/route.ts` salvo el punto
  de extensión puntual del shape de salida (PR7-PR11) — PoP (PR6), autoridad (PR5), rate-limit (PR3)
  y formato (PR4) quedan intactos.
- CD-2: OBLIGATORIO que el path `vm==="evm"` quede byte-idéntico (mismos tests, mismos códigos de
  error, mismo shape 200) — CERO regresión.
- CD-3: OBLIGATORIO fail-loud/fail-closed: cualquier env Solana faltante o malformada (authority
  pubkey, secretos del smoke) SHALL producir un error opaco, NUNCA un 200 parcial ni un fallback
  silencioso.
- CD-4: PROHIBIDO hardcodear secretos (release-authority secret key, fee-payer key, attestation
  secret, tokens) en el smoke script o en cualquier archivo versionado — todo desde env, documentado
  en `.env.example`, nunca impreso en stdout/logs.
- CD-5: OBLIGATORIO flags OFF por default en todo ambiente compartido — esta HU CONSTRUYE, NO
  ENCIENDE (mismo patrón que WKH-186/WKH-211/HU-SOL-13).
- CD-6: OBLIGATORIO cero plata real — el smoke script SOLO apunta a Solana devnet; PROHIBIDO
  cualquier default o fallback que apunte a mainnet-beta.
- CD-7: PROHIBIDO tocar `submit/route.ts`, `confirm-and-send.ts`, `settle/principal/route.ts` o
  cualquier archivo del guard-order EVM/Solana ya cerrado en HU-SOL-13a — el scope de código de esta
  HU es `prepare/route.ts` + `.env.example` + el smoke script nuevo, nada más.
- CD-8: PROHIBIDO escribir o modificar código en `wasiai-facilitator`/`wasiai-remittance-agents` —
  repos externos, fuera de este workspace, fuera de scope por definición.

## Missing Inputs
- [NEEDS CLARIFICATION][no bloqueante] Nombre exacto del código de error nuevo para el 503 de
  authority Solana ausente (DT-3) — el Architect lo fija en F2 siguiendo el patrón de enums opacos ya
  establecido.
- [NEEDS CLARIFICATION][no bloqueante] Runtime exacto del smoke script (`tsx` vs `ts-node` vs
  compilado) y su ubicación exacta de invocación (`npm run smoke:solana` vs invocación directa) — el
  Architect decide en F2.
- [NEEDS CLARIFICATION][no bloqueante, informativo] Los repos `wasiai-facilitator` y
  `wasiai-remittance-agents` NO están accesibles en este workspace. La sección de envs/runbook de
  esos 2 repos se basa exclusivamente en citas ya documentadas (`doc/sdd/029-hu-sol-13-escrow-
  integration/report.md`). Si el Architect necesita verificar nombres exactos de variables o rutas
  de archivo en esos repos para F2, requiere que el orquestador monte esos repos en una sesión futura
  — no bloquea el F2 de la porción `chaski-v3` (Scope IN de esta HU), pero sí limita la precisión del
  runbook-skeleton para las partes B.1-B.4 (facilitator/remit-agents).

## Análisis de paralelismo
- Depende de: HU-SOL-4, HU-SOL-5, HU-SOL-6, HU-SOL-7, HU-SOL-8, HU-SOL-9, HU-SOL-13, HU-SOL-14
  (todas DONE per `_INDEX.md`, confirmado en este F0 vía report de HU-SOL-13).
- Bloquea: el cierre formal de M5 del programa Solana LATAM Labs (el runbook founder-gated no puede
  ejecutarse sin AC-1/AC-2/AC-3 mergeados — sin ellos el prepare Solana real siempre falla).
- Riesgo de colisión: `app/api/payout/prepare/route.ts` fue tocado por HU-SOL-9 y HU-SOL-13a
  recientemente — NO debería correr en paralelo con ninguna otra HU que toque el mismo archivo sin
  coordinación explícita de orden de merge. Ninguna otra HU activa lo toca hoy (única HU sobre
  `chaski-v3` en este momento, confirmado en F0).
- Puede correr en paralelo con cualquier trabajo puramente founder-gated (deploy, keypairs, IDs
  TransFi) — esas acciones son Scope OUT de esta HU y no comparten archivos.
