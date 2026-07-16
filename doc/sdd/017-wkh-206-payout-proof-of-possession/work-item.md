# Work Item — [WKH-206] G5 del gate de Fase A: proof-of-possession (SIWE) para el payout

## Resumen
`/api/a2a/payout/submit` (`app/api/a2a/payout/submit/route.ts`) recibe `address` como un **string**
del body del caller. WKH-202 (G1) confirma que ese string coincide con el `vendor_data` de un KYC
`Approved`, pero `vendor_data` es, a su vez, un string que el CLIENTE declaró libremente al crear la
sesión de Didit (`app/api/kyc/session/route.ts:44/68`, `body.vendorData` sin verificación) — es decir,
**en ningún punto del sistema, hoy, alguien prueba que el caller controla la private key de
`address`** fuera del acto de efectivamente mover dinero real (ver Hallazgo Central abajo). Esta HU
construye (NO habilita) un mecanismo de proof-of-possession tipo SIWE/EIP-4361: el caller firma un
challenge (nonce server-side, single-use, con expiración) con la private key de `address`; el server
recupera la firma y exige que coincida EXACTAMENTE con `address` antes de continuar.

## Hallazgo Central de F0 (léase ANTES de F2 — cambia el análisis de riesgo)

El grounding de esta fase encontró que **WKH-168 (G3, ya con código presente en
`submit/route.ts` L113-201 y `confirm-and-send.ts` L115-189) ya cierra la mayor parte del gap
explotable para el ÚNICO camino que hoy mueve dinero real**:

- Cuando `NEXT_PUBLIC_EIP3009_ENABLED=true`, `authorizePrincipal()` (`src/infrastructure/wallet.ts`
  L79-132/L213-264) firma un **EIP-712 `transferWithAuthorization`** con `account: this.address`. El
  contrato USDC (no este código) recupera el firmante de esa firma on-chain y EXIGE que coincida con
  el `from` de la autorización antes de mover un solo micro-USDC.
- `/api/settle/principal/route.ts` (S13, L148-150) ata `from === address` del caller, transmite,
  espera el receipt, y lee el `from` REAL del log `Transfer` emitido por el contrato
  (`onchain-verifier.ts`, no leído en detalle en esta fase pero referenciado en el comment L173-181).
  Ese `from` verificado se firma en la atestación HMAC (`attestation.ts`).
- `submit/route.ts` A7 (L156-160) exige `att.from.toLowerCase() === address.toLowerCase()`.

**Conclusión honesta**: para el camino real (`EIP3009_ENABLED=true` + `SETTLE_ATTESTATION_SECRET`
configurado), un atacante NO puede lograr que `att.from` sea la address de la víctima sin controlar
su private key — porque el contrato USDC mismo rechaza una `transferWithAuthorization` cuya firma no
recupere al `from` declarado. Esto es una prueba de posesión CRIPTOGRÁFICA, más fuerte incluso que un
SIWE aislado (está atada al movimiento real de fondos, no solo a un mensaje firmado).

**El gap SIGUE siendo real y explotable en 3 configuraciones concretas** (ver Missing Inputs /
Análisis de riesgo):
1. **`/api/payout/validate`** (`app/api/payout/validate/route.ts`) — endpoint advisory que usa
   `resolvePayoutAuthority` (el ownership check de WKH-202) EN SOLITARIO, sin atestación ninguna. Hoy
   solo devuelve `{authorized, reason}` (sin PII, sin mover plata) pero es un oráculo de "¿esta
   address+verificationId pasan el check de ownership?" para cualquier caller no autenticado — sigue
   siendo útil para un atacante que quiere confirmar que conoce una combinación válida antes de
   intentar el submit.
2. **`submit/route.ts` guard 4-6 (autoridad, L80-111) corre ANTES de la atestación (guard 8)** — si en
   el futuro se agrega un money-rail que NO reusa la composición exacta settle→verify→attest de
   WKH-168 (ej. TransFi/Mitad B, WKH-172), el ownership check de WKH-202 vuelve a ser la ÚNICA defensa,
   y esa defensa NO prueba posesión de key.
3. **Local/CI (`SETTLE_ATTESTATION_SECRET` no configurado, `VERCEL_ENV` vacío, rama A1 L123)** — el
   gate de atestación entero se saltea por diseño (para que el demo local funcione). Bajo riesgo real
   (no es un entorno desplegado) pero documentado para que el Architect decida si aplica ahí también.

Esta HU sigue siendo válida y pedida explícitamente por el founder como defensa en profundidad
INDEPENDIENTE de la implementación específica del settlement (no acoplar una invariante de seguridad
a los detalles de un rail de pago concreto). Pero el Architect (F2) debe decidir con esta información:
¿vale la pena construirla YA (antes de que exista un 2º money-rail), o se prioriza otra HU primero?
Esa decisión de priorización NO es de este analyst — se documenta como pregunta abierta.

## Sizing
- **SDD_MODE**: full
- **Metodología**: QUALITY (superficie de seguridad money-path — identidad/auth/cripto, ninguna
  excepción posible según CLAUDE.md del repo: "WasiAI A2A / Chaski v2 es siempre modo QUALITY")
- **Estimación**: L (nuevo módulo de verificación de firma + nonce-store nuevo + posible endpoint
  nuevo + wiring de cliente que firma + matriz de tests de replay/expiración/mismatch — comparable en
  tamaño a WKH-168)
- **Branch sugerido**: `feat/017-wkh-206-payout-proof-of-possession`
- **Waves sugeridas (para F3, no vinculante)**:
  1. Módulo puro de verificación (`recoverMessageAddress`/`verifyMessage` de viem, ya presente en el
     repo, CD-1) + nonce-store (mismo patrón `attestation-store.ts`, `SET NX EX` sobre Upstash) — sin
     tocar ninguna route, 100% unit-testable.
  2. Endpoint(s) — challenge (si aplica DT-1a) y/o guard nuevo en `submit/route.ts` — con matriz de
     tests byte-idéntico-cuando-off (mismo patrón A1/A2 de WKH-168).
  3. Wiring del cliente que firma (candidato: `wallet.ts`, cerca de `authorizePrincipal`, o un paso
     nuevo en el flujo de `flow.tsx`/`confirm-and-send.ts`) — sin habilitar el flag por default.
  4. Tests de integración (happy path + replay + expirado + mismatch + nonce-store caído) + AR/CR.

## Acceptance Criteria (EARS)

- **AC-1** (state-driven): WHILE el mecanismo de proof-of-possession NO está configurado (flag/secreto
  ausente, patrón A1/A2 de WKH-168), the system SHALL procesar `/api/a2a/payout/submit` de forma
  byte-idéntica al comportamiento pre-WKH-206 (ningún fetch nuevo, ningún guard nuevo evaluado, mismos
  códigos de respuesta en los mismos casos).

- **AC-2** (event-driven): WHEN un caller solicita un challenge de proof-of-possession para una
  `address` dada, the system SHALL emitir un nonce single-use con expiración explícita, persistido
  server-side (nonce-store, mismo patrón atómico `SET NX EX` que `claimAttestationOnce`), SOLO WHERE
  el mecanismo está configurado.

- **AC-3** (event-driven): WHEN el caller presenta una firma (mensaje SIWE/EIP-4361 o personal_sign
  estructurado, según decida DT-3) sobre el nonce vigente, the system SHALL recuperar
  criptográficamente la address firmante a partir de la firma y SHALL rechazar la solicitud de payout
  con el mismo código de error opaco que ya usa el resto de `submit/route.ts` (no-oracle, CD-4) IF la
  address recuperada no coincide EXACTAMENTE (case-insensitive) con la `address` declarada en el body
  del payout.

- **AC-4** (unwanted/IF-THEN): IF el nonce presentado ya fue reclamado (replay), O está expirado, O el
  nonce-store no está disponible, THEN the system SHALL rechazar la solicitud con un error opaco
  fail-closed (SIN forwardear al agente de payout downstream), replicando el patrón fail-closed A8/A9
  de `claimAttestationOnce` (unavailable ⇒ SIEMPRE bloquea, nunca autoriza).

- **AC-5** (state-driven): WHILE el proof-of-possession está habilitado, the system SHALL ejecutar
  este guard nuevo SIN debilitar, saltear, ni volver condicional-por-flag ninguno de los guards
  preexistentes de WKH-202 (ownership KYC, `resolvePayoutAuthority`) o WKH-168 (atestación de
  settlement single-use, A1-A9) — el guard se agrega a la cadena existente, no la reemplaza.

- **AC-6** (event-driven): WHEN se construye el mensaje/challenge a firmar, the system SHALL incluir
  el `chainId` resuelto (`resolveChainId()`) y una expiración explícita en el payload firmado, de modo
  que un challenge válido en un entorno/cadena (ej. Fuji) no pueda reutilizarse en otro (ej. mainnet)
  si el mismo secreto de firma se reusa entre entornos (mismo criterio que A7″ de WKH-168).

- **AC-7** (ubiquitous): the system SHALL usar exclusivamente la librería `viem` (ya presente en el
  repo, `verifyMessage`/`recoverMessageAddress` o equivalente) para la verificación criptográfica de
  la firma — ninguna dependencia npm nueva (`siwe`, `ethers`, etc.) sin justificación explícita
  aprobada en F2.

## Scope IN
- Módulo nuevo de verificación de firma — candidato `src/infrastructure/auth/proof-of-possession.ts`
  (Architect confirma naming en F2).
- Nonce-store nuevo — candidato `src/infrastructure/auth/pop-nonce-store.ts`, mismo patrón que
  `src/infrastructure/settlement/attestation-store.ts` (SET NX EX sobre `@upstash/redis`, ya
  dependency del repo).
- `app/api/a2a/payout/submit/route.ts` — nuevo guard (posición exacta a decidir en F2, ver DT-1),
  detrás de flag/secreto OFF por default.
- Posible endpoint nuevo `app/api/a2a/payout/challenge/route.ts` (candidato (a) de DT-1) — solo si el
  Architect confirma esa arquitectura en F2.
- Wiring del lado cliente que firma — candidato `src/infrastructure/wallet.ts` (cerca de
  `authorizePrincipal`, L79-132/L213-264) y/o `src/application/use-cases/confirm-and-send.ts` — detrás
  del mismo flag, sin habilitar por default.
- Tests: extensión de `app/api/a2a/payout/submit/route.test.ts` (ya existe, se EXTIENDE — mismo
  patrón que WKH-202/WKH-168), tests unitarios del módulo de verificación y del nonce-store, tests del
  endpoint nuevo si aplica.

## Scope OUT
- **NO** habilitar `NEXT_PUBLIC_EIP3009_ENABLED` — esta HU construye, no enciende (misma regla que
  WKH-168/WKH-186).
- **NO** reimplementar el ownership check de WKH-202 (`src/infrastructure/payout/authority.ts`) ni la
  atestación single-use de WKH-168 (`attestation.ts`/`attestation-store.ts`) — se reusan/consumen tal
  cual.
- **NO** tocar el flujo de Didit KYC (`app/api/kyc/session/route.ts`, `app/api/kyc/decision/route.ts`,
  `src/infrastructure/didit/*`) — `vendor_data` sigue siendo lo que es hoy (un claim del cliente, no
  verificado en esta HU).
- **NO** tocar TransFi/Mitad B del payout (WKH-172 en `wasiai-remittance-agents`, repo hermano) ni
  ningún código de `wasiai-a2a`/`wasiai-v2` (regla PROHIBIDO del `project-context.md`).
- **NO** tocar `app/api/payout/validate/route.ts` en el sentido de cambiar su contrato — SI el
  Architect decide en F2 que ese endpoint también debe pasar por proof-of-possession, es una decisión
  explícita a documentar en el SDD, no un cambio implícito de esta HU.
- **NO** modificar el demo live (`chaski-ai.vercel.app`, `yarvis`/`agentshop-*`) — Chaski v2 es
  standalone (regla ya establecida en `project-context.md`).
- **NO** cerrar la pregunta de persistencia/reconciliación server-side (eso es WKH-207, ya
  referenciado como follow-up de WKH-168).

## Decisiones técnicas (DT-N)

- **DT-1 (ABIERTA — requiere decisión del Architect/humano en F2, ver pregunta arquitectónica del
  input)**: ¿dónde vive el proof-of-possession?
  - **(a) Endpoint nuevo `/api/a2a/payout/challenge`** (nonce) + verificación inline en `submit`.
    PRO: funciona INDEPENDIENTEMENTE de si `EIP3009_ENABLED` está on — cierra el gap en
    `/api/payout/validate` (si se decide extenderlo) y en cualquier money-rail futuro que no reuse la
    composición exacta settle→verify→attest de WKH-168 (ej. Mitad B TransFi). CON: nueva
    infraestructura (endpoint + nonce-store) a mantener; un round-trip extra en la UX (fetch nonce →
    firmar → submit).
  - **(b) Atarlo a `/api/settle/principal`** (reusar S13 + A7). PRO: cero endpoint nuevo, reusa infra
    ya viva. CON: **el Hallazgo Central de F0 (arriba) muestra que esto YA está mayormente cubierto**
    cuando `EIP3009_ENABLED=true` — construir (b) sería en gran parte redundante con lo que WKH-168 ya
    garantiza vía el contrato USDC. Deja sin cubrir el gap de `/api/payout/validate` y de un 2º
    money-rail futuro.
  - **Recomendación no vinculante de este analyst**: (a), precisamente PORQUE es la única opción que
    aporta algo nuevo dado el Hallazgo Central — un mecanismo de identidad explícito e independiente
    del mecanismo de settlement, tal como lo pide el ticket original. Pero el Architect debe presentar
    esta disyuntiva al humano en el gate `SPEC_APPROVED`: la HU puede achicarse a "solo proteger
    `/api/payout/validate` + el guard-4-6 pre-atestación" si se acepta el argumento de que el money
    real ya está protegido.

- **DT-2 (ABIERTA — resoluble por el Architect sin input humano, usando convención del repo)**:
  patrón de flag — ¿presencia de un secreto server-only (`PAYOUT_POP_SECRET`, mismo patrón "presencia
  = habilitado" que `SETTLE_ATTESTATION_SECRET`) o un boolean explícito (mismo patrón
  `NEXT_PUBLIC_EIP3009_ENABLED`)? Dado que la verificación es 100% server-side (nunca debe llegar al
  bundle del cliente, CD-9/CD-17 ya establecidos en el repo), se recomienda el patrón
  "presencia-de-secreto", consistente con `attestation.ts`.

- **DT-3 (ABIERTA — resoluble en F2)**: ¿EIP-4361 completo (domain/uri/statement, para que wallets
  como MetaMask rendericen un prompt de SIWE nativo) o un `personal_sign` estructurado simple (mismo
  patrón que el mensaje demo ya existente en `wallet.ts` L127-130, `"Chaski · autorizo enviar..."`)?
  Afecta tanto la librería exacta de verificación (`viem` soporta ambos vía `verifyMessage`) como la
  UX del prompt de firma.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO agregar la dependencia npm `siwe`, `ethers`, u otra librería de firma nueva —
  usar `viem` (`verifyMessage`/`recoverMessageAddress`), ya presente en el repo (`wallet.ts`,
  `attestation.ts` importan de `viem`).
- **CD-2**: OBLIGATORIO — el guard nuevo en `submit/route.ts` (y el endpoint de challenge, si aplica)
  debe ser byte-idéntico al comportamiento actual cuando el flag/secreto de proof-of-possession NO
  está configurado (mismo patrón A1 de WKH-168: "la HU construye, NO enciende").
- **CD-3**: OBLIGATORIO — el nonce es single-use (anti-replay) y su claim es ATÓMICO (`SET NX EX`
  sobre Redis/Upstash, mismo patrón `claimAttestationOnce`), y el guard debe fail-CLOSED si el
  nonce-store no está disponible — PROHIBIDO fail-open en este money-path (mismo criterio explícito de
  `attestation-store.ts`: "NO es rate-limit.ts").
- **CD-4**: PROHIBIDO usar el resultado de esta verificación como oráculo — cualquier fallo (firma
  inválida, nonce expirado, nonce reusado, address mismatch, store caído) debe colapsar al MISMO
  código de error opaco que ya usa `submit/route.ts` para sus guards existentes (no-oracle, ya
  establecido en CD-12 de WKH-202/WKH-168).
- **CD-5**: PROHIBIDO debilitar, saltear, o volver condicional-por-flag los guards existentes de
  WKH-202 (ownership KYC) o WKH-168 (atestación single-use A1-A9) — regla ya establecida en el
  `project-context.md` del repo ("NUNCA remover o condicionar `authority.authorize()`"), extendida
  explícitamente a esta HU.
- **CD-6**: PROHIBIDO loguear, ecoar, o incluir en cualquier respuesta de error la firma cruda, el
  nonce, o el `address` del caller (mismo criterio no-PII/no-oracle ya establecido en el repo).
- **CD-7**: OBLIGATORIO — el mensaje firmado debe atar `chainId` (`resolveChainId()`) y una expiración
  explícita (mismo criterio A7″ de WKH-168: previene replay cross-entorno si `SETTLE_ATTESTATION_SECRET`-equivalente se reusa entre Fuji/mainnet).

## Categorías de riesgo de seguridad (money-path — documentación obligatoria QUALITY)

| Categoría | Riesgo | Mitigación esperada |
|-----------|--------|---------------------|
| Suplantación de identidad (IDOR de wallet) | Caller conoce `address` KYC-aprobada ajena (pública on-chain) + `kycVerificationId` → pasa WKH-202 sin poseer la key | Este mecanismo (SIWE/proof-of-possession) — AC-3 |
| Replay del challenge | Firma capturada/interceptada se reusa en otra solicitud | Nonce single-use, AC-4/CD-3 |
| Replay cross-entorno | Challenge firmado en Fuji válido en mainnet si se reusa el secreto | Binding de `chainId` en el mensaje firmado, AC-6/CD-7 |
| Fail-open del nonce-store | Upstash caído → ¿autoriza igual? | Fail-CLOSED explícito, AC-4/CD-3 |
| Oráculo de estado | Códigos de error distintos revelan por qué falló (firma vs nonce vs KYC) | Mismo error opaco para todo, AC-3/CD-4 |
| Regresión de guards existentes | El guard nuevo se inserta MAL y rompe/saltea WKH-202 o WKH-168 | AC-5/CD-5, tests de no-regresión en F3/AR |
| Redundancia arquitectónica | Construir sobre un camino (settle/principal) ya cubierto por WKH-168 A7, dejando sin cubrir el resto | DT-1, decisión explícita en F2 |

## Missing Inputs

- **[NEEDS CLARIFICATION] BLOQUEANTE para F2**: DT-1 — arquitectura del endpoint (challenge nuevo vs.
  atar a `/api/settle/principal` vs. ambos con scope reducido). El Architect debe presentar el
  Hallazgo Central de este work-item al humano en el gate `SPEC_APPROVED` antes de cerrar el SDD.
- **[NEEDS CLARIFICATION] BLOQUEANTE para F2 (decisión de producto/priorización, no técnica)**: dado
  que el camino real de money-path (`EIP3009_ENABLED=true`) YA tiene proof-of-possession transitivo
  vía WKH-168 A7, ¿se prioriza esta HU AHORA (defensa en profundidad + cierre explícito de
  `/api/payout/validate` y de money-rails futuros) o se DIFIERE hasta que exista un 2º money-rail real
  (ej. TransFi Mitad B) que efectivamente no reuse la composición settle→verify→attest? Es una decisión
  de negocio/roadmap, no resoluble por este analyst.
- **[NEEDS CLARIFICATION] NO bloqueante**: DT-3 — SIWE/EIP-4361 completo vs. `personal_sign`
  estructurado simple. Resoluble en F2 con o sin input humano (impacto principalmente en UX/librería).
- **[TBD] NO bloqueante**: DT-2 — nombre exacto y patrón del flag/secreto de configuración. Resoluble
  por el Architect en F2 sin input humano (convención ya establecida en el repo).
- **[HALLAZGO DE COORDINACIÓN, no bloqueante pero IMPORTANTE]**: el código de WKH-168 (atestación
  single-use, A1-A9) YA está presente en `submit/route.ts` y `confirm-and-send.ts` en el estado actual
  del working tree, aunque `doc/sdd/_INDEX.md` (L263-294, L357) todavía lista a WKH-168 como
  **"F1 (en curso)"**, no DONE. Antes de que WKH-206 llegue a F3, el orquestador/humano debe confirmar
  si WKH-168 ya está mergeado a `main` (o en qué branch vive) — si WKH-206 desarrolla sobre un working
  tree con WKH-168 sin mergear, hay riesgo de conflicto de merge sobre `submit/route.ts` y
  `confirm-and-send.ts` (los mismos archivos que esta HU también toca).

## Análisis de paralelismo
- **Bloqueada por (posible)**: WKH-168 debe estar efectivamente mergeado (o su estado de branch
  clarificado) antes de que WKH-206 modifique `submit/route.ts`/`confirm-and-send.ts` — ver Missing
  Inputs. Si WKH-168 sigue en desarrollo activo en el mismo working tree, coordinar orden de merge
  antes de F3 (mismo patrón de coordinación ya usado en `_INDEX.md` para WKH-178/179, WKH-198/199/200/201).
- **No bloquea a ninguna otra HU conocida**: no hay otras HUs abiertas en `chaski-v2` en este momento
  fuera de WKH-168 (F1) y esta (WKH-206, recién F1).
- **Puede correr en paralelo** con cualquier trabajo NO relacionado a `submit/route.ts`,
  `confirm-and-send.ts`, `wallet.ts`, o el infra de settlement/atestación (ej. cambios de UI en
  `flow.tsx` que no toquen el paso de firma).
- Archivos con mayor probabilidad de colisión de merge: `app/api/a2a/payout/submit/route.ts`,
  `app/api/a2a/payout/submit/route.test.ts`, `src/infrastructure/wallet.ts`,
  `src/application/use-cases/confirm-and-send.ts` — todos ya tocados por WKH-168/WKH-202/WKH-186.
