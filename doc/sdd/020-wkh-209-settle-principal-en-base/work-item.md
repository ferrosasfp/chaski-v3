# Work Item — [WKH-209] Mover el settlement del principal de Chaski de Avalanche a Base

## Resumen
Decisión del founder (2026-07-17): el corredor de remesa usa **Base** porque TransFi (partner de
payout) no soporta USDC en Avalanche pero sí en Base. Hoy TODO el settlement real del principal
(WKH-168, EIP-3009: chainId, dirección USDC, RPC de verificación, domain EIP-712) está atado a
Avalanche (Fuji 43113 / mainnet 43114). Esta HU **reconfigura** ese camino para apuntar a Base
(Sepolia 84532 / mainnet 8453), reusando la infraestructura de `wasiai-facilitator` que YA settlea
Base Sepolia en prod. Es un cambio de **config/parametrización**, no de lógica de dominio: el
guard-order, la atestación y el ledger de WKH-168/202/206/207 quedan intactos.

## Sizing
- SDD_MODE: full (money-path, QUALITY obligatorio en este proyecto)
- Estimación: M (5 archivos de código + `.env.example`, sin lógica de dominio nueva, pero con un
  bug latente real a corregir — ver Hallazgo F0 más abajo — y coordinación con un servicio externo)
- Branch sugerido: `feat/020-settle-principal-base`

## Hallazgo crítico de F0 (grounding) — el domain EIP-712 está hardcodeado y es INCORRECTO para Base

`src/infrastructure/wallet.ts:97` y `:242` firman `signTypedData` con
`domain: { name: "USD Coin", version: "2", chainId: resolveChainId(), verifyingContract: usdc }`
**hardcodeado**. Esto es correcto para el USDC de Avalanche (Circle usa `name="USD Coin"` ahí), pero
**wasiai-facilitator/src/chains/base.ts:42-53** documenta —verificado on-chain contra el contrato real,
2026-05-19— que el USDC de **Base Sepolia** usa `eip712Name="USDC"` (el símbolo literal, NO "USD
Coin"); solo el USDC de Base **mainnet** usa `"USD Coin"`. Si esta HU solo cambia el `chainId` y la
dirección del USDC sin tocar el `name` del domain, **la firma EIP-712 resultante no corresponderá al
`DOMAIN_SEPARATOR` real del contrato** → el facilitator rechazaría el settle o (peor, si algún día
valida menos estricto) firmaría un domain que no ata al contrato real. Este es el motivo #1 por el
que esta HU NO puede ser un simple find-replace de "avalanche" → "base": el `name`/`version` del
domain deben quedar **parametrizados por red**, igual que la dirección del USDC.

## Acceptance Criteria (EARS)

- AC-1: WHEN `NEXT_PUBLIC_CHAIN_ID` está configurado con el chainId de Base Sepolia (84532), the
  system SHALL resolver `resolveChainId()`/`resolveChain()` a Base Sepolia (viem `baseSepolia`) en
  vez de Avalanche.
- AC-2: WHEN `NEXT_PUBLIC_CHAIN_ID` está configurado con el chainId de Base mainnet (8453), the
  system SHALL resolver `resolveChainId()`/`resolveChain()` a Base mainnet (viem `base`).
- AC-3: IF `NEXT_PUBLIC_CHAIN_ID` está ausente o es un valor no reconocido, THEN the system SHALL
  aplicar el mismo patrón fail-safe actual (un default explícito y documentado — a decidir en F2 si
  el default pasa a ser Base Sepolia o se mantiene el fail-safe conservador actual; NO debe fallar
  silenciosamente a Avalanche una vez completada la migración).
- AC-4: WHEN se firma `transferWithAuthorization` (EIP-3009, flag ON) contra Base Sepolia, the
  system SHALL usar `domain.name`/`domain.version` que coincidan EXACTAMENTE con el
  `DOMAIN_SEPARATOR` real del contrato USDC de Base Sepolia (`name="USDC"`, `version="2"`, per
  Hallazgo crítico arriba) — NUNCA el literal `"USD Coin"` hardcodeado hoy sin condicionar por red.
- AC-5: WHEN se firma `transferWithAuthorization` contra Base mainnet, the system SHALL usar
  `domain.name="USD Coin"`, `domain.version="2"` (el USDC de Base mainnet SÍ usa "USD Coin").
- AC-6: WHEN `onchain-verifier.ts` verifica un settle en Base, the system SHALL leer el receipt vía
  un RPC de Base (Sepolia o mainnet según la red configurada), NUNCA vía `AVALANCHE_RPC_URL`.
- AC-7: the system SHALL resolver la dirección del contrato USDC (`resolveUsdcAddress()`) al USDC
  canónico de la red Base activa (Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` / mainnet:
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, per `wasiai-facilitator/src/chains/base.ts`),
  manteniendo el patrón actual de `.env.example` (documentado, fail-loud si falta/malformada — CD-14
  del código existente, NO hardcodeado en el bundle del cliente salvo como comentario).
- AC-8: WHILE `NEXT_PUBLIC_EIP3009_ENABLED` permanece OFF (default), the system SHALL comportarse
  byte-idéntico a hoy (firma de mensaje simbólico, demo intacto) — el cambio de red NO debe alterar
  ninguna rama del flujo demo.
- AC-9: WHEN se ejecuta un settle real end-to-end de prueba, the system SHALL hacerlo ÚNICAMENTE
  contra **Base Sepolia (testnet, 84532)** con USDC de prueba sin valor — PROHIBIDO ejecutar o
  validar esta HU contra Base mainnet (8453) o mover fondos reales en ningún momento del pipeline
  F3→F4.
- AC-10: WHERE el `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a` (source.currency `USDCBASE`, WKH-208) está
  activo junto con `NEXT_PUBLIC_EIP3009_ENABLED=true`, the system SHALL settlear el principal en la
  MISMA red (Base) que TransFi liquida — sin mezclar cadenas entre principal-in y payout.
- AC-11: IF alguna de las envs requeridas para Base (chainId, RPC, USDC address) falta o está
  malformada, THEN the system SHALL fallar fail-closed (mismo patrón `resolveUsdcAddress`/
  `resolveReceiverAddress` ya existente: throw en construcción o `503`/`500` en la ruta server, NUNCA
  asumir un default silencioso que firme contra la red equivocada).

## Scope IN

- `src/infrastructure/chain.ts:5,7-13,16-18` — `resolveChainId()`/`resolveChain()` hoy hardcodean
  `avalanche`/`avalancheFuji` (viem) y los literales `43113`/`43114`. Cambiar a `base`/`baseSepolia`
  (viem) + `84532`/`8453` (o generalizar si F2 decide soporte multi-red — ver DT-1).
- `src/infrastructure/wallet.ts:97,242` — domain EIP-712 hardcodeado `name: "USD Coin", version: "2"`
  en `InjectedWallet.authorizePrincipal` y `WalletConnectWallet.authorizePrincipal`. Debe
  parametrizarse por red (Hallazgo crítico F0).
- `src/infrastructure/settlement/onchain-verifier.ts:59` — `process.env.AVALANCHE_RPC_URL` literal.
  Cambiar a la env de RPC de Base (nombre exacto a decidir en F2, ver DT-2).
- `.env.example:51-56` (comentario de `NEXT_PUBLIC_CHAIN_ID`, dice "Solo Avalanche… soportados"),
  `:90-96` (comentario de `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS`, lista direcciones canónicas de
  Avalanche), `:117` (`AVALANCHE_RPC_URL` var name + comentario) — documentación de envs a actualizar
  a Base.
- Tests existentes a actualizar/extender: `src/infrastructure/chain.test.ts`,
  `src/infrastructure/wallet.test.ts`, `src/infrastructure/settlement/onchain-verifier.test.ts`.
- Coordinación operativa (fuera del repo `chaski-v2`, pero prerequisito de deploy): en
  `wasiai-facilitator`, los adapters `baseSepoliaAdapter`/`baseMainnetAdapter`
  (`src/chains/base.ts:161-199`) son **opt-in** — requieren `BASE_SEPOLIA_ENABLED=true` +
  `BASE_SEPOLIA_RPC_URL` seteados en el deploy del facilitator ANTES de que el settle de Base
  funcione. Verificar/activar esto es un paso de ops, no de código de esta HU.

## Scope OUT

- **NO** tocar `app/api/settle/principal/route.ts` más allá de lo que ya deriva automáticamente de
  `resolveChainId()`/`resolveUsdcAddress()`/`resolveReceiverAddress()` — su guard-order (S1-V9) y
  composición broadcast→verify→attest quedan intactos (WKH-168/CD-20/CD-21).
  `src/infrastructure/settlement/facilitator-client.ts` NO se toca — ya es agnóstico de red (envía
  `chainId` recibido, el facilitator resuelve el adapter).
  `src/infrastructure/settlement/attestation.ts` NO se toca.
- **NO** tocar el guard-order de submit/settle (WKH-202/168/206/207) ni la lógica de
  atestación/PoP/ledger — CD explícita del founder.
  `app/api/a2a/payout/submit/route.ts`, `confirm-and-send.ts`, `attestation-store.ts`,
  `pop-nonce-store.ts`, `supabase-settlement-ledger.ts` NO se tocan.
- **NO** encender `NEXT_PUBLIC_EIP3009_ENABLED=true` en ningún entorno compartido/prod como parte de
  esta HU — sigue OFF por default (CD-1 heredado de WKH-186/168). Esta HU **construye la config
  correcta**, no enciende el settle real.
- **NO** tocar el demo live (`chaski-ai`) ni `wasiai-a2a`/`wasiai-v2`.
- **NO** modificar `wasiai-facilitator` (repo externo) — su soporte de Base ya existe y está
  auditado; solo se coordina la activación operativa (env flags), fuera del código de esta HU.
- **NO** ejecutar ni validar contra Base mainnet (8453) ni mover fondos reales — solo Base Sepolia
  testnet, tokens sin valor (AC-9).
- **NO** decidir el partido de si Chaski soporta Avalanche+Base simultáneamente ("multi-red") o hace
  un swap directo eliminando Avalanche — es DT-1, bloqueante para F2 (ver Missing Inputs).

## Decisiones técnicas (DT-N)

- DT-1 (BLOQUEANTE para F2): **¿Multi-red configurable o swap directo a Base?** Dos opciones:
  (a) *Swap directo*: `resolveChainId()`/`resolveChain()` solo soportan Base (Sepolia/mainnet) desde
  ahora; se elimina el soporte de Avalanche del código (43113/43114 dejan de ser válidos). Más simple,
  coherente con "Chaski usa Base" como decisión final del founder.
  (b) *Multi-red*: se generaliza `chain.ts` a un lookup por chainId (Base Y Avalanche soportados,
  Avalanche queda disponible pero no se usa por default) — más flexible si algún día se re-abre un
  corredor sobre Avalanche, pero más superficie/complejidad para una decisión que hoy es binaria.
  Recomendación del Analyst: **(a) swap directo** — la HU dice "mover", no "soportar ambas", y el
  founder ya decidió Base como la red del corredor; menos superficie = menos riesgo money-path. Pero
  requiere confirmación humana explícita porque es irreversible sin otra HU.
- DT-2: Nombre de la env de RPC de verificación. Hoy `AVALANCHE_RPC_URL` (server-only,
  `.env.example:117`). Propuesta: renombrar a `BASE_SEPOLIA_RPC_URL`/`BASE_RPC_URL` — a decidir en F2
  si se mantiene un único nombre por red activa (patrón simple, igual al de hoy) o se introduce
  `_TESTNET`/`_MAINNET` explícito (patrón usado por `wasiai-facilitator` con
  `AVALANCHE_FUJI_RPC_URL`/`AVALANCHE_MAINNET_RPC_URL`/`BASE_SEPOLIA_RPC_URL`/`BASE_MAINNET_RPC_URL`).
- DT-3: El domain EIP-712 (`name`/`version`) NO debe ser una env nueva — debe derivarse del chainId
  igual que el patrón ya usado por `wasiai-facilitator` (constante pública/estable por chainId, NO
  secreta, NO configurable — evita que un typo de operador rompa la firma). Se agrega un lookup
  `{84532: {name:"USDC", version:"2"}, 8453: {name:"USD Coin", version:"2"}}` en `chain.ts` o
  `wallet.ts` (F2 decide la ubicación exacta).
- DT-4: La dirección del USDC (`NEXT_PUBLIC_USDC_CONTRACT_ADDRESS`) sigue siendo env-driven
  (patrón actual, CD-14/CD-16 del código existente) — NO se hardcodea aunque `wasiai-facilitator` sí
  hardcodea la suya. Se mantiene la asimetría porque cambiarla es fuera de scope de esta HU (haría
  imposible testear contra un USDC mock sin redeploy).

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO ejecutar o validar cualquier parte de esta HU contra Base **mainnet** (8453) o
  mover fondos con valor real — únicamente Base Sepolia testnet (AC-9).
- CD-2: PROHIBIDO tocar el guard-order de `/api/settle/principal` (S1-V9),
  `/api/a2a/payout/submit`, ni la lógica de atestación/PoP/ledger de WKH-202/168/206/207 — solo
  config de red.
- CD-3: PROHIBIDO encender `NEXT_PUBLIC_EIP3009_ENABLED=true` en cualquier entorno compartido (prod,
  preview de Vercel) como parte de esta HU. Sigue OFF por default; solo se valida localmente contra
  Base Sepolia con flag manual.
- CD-4: OBLIGATORIO que el domain EIP-712 (`name`/`version`) del `signTypedData` coincida
  EXACTAMENTE con el `DOMAIN_SEPARATOR` on-chain real de la red activa (Hallazgo crítico F0) — NO
  reusar el literal `"USD Coin"` sin condicionarlo por chainId.
- CD-5: PROHIBIDO tocar `wasiai-facilitator` (repo externo, ya auditado) — solo coordinar activación
  operativa de sus flags `BASE_SEPOLIA_ENABLED`/`BASE_SEPOLIA_RPC_URL`.

## Tabla de riesgo (money-path)

| Riesgo | Severidad | Mitigación |
|---|---|---|
| Domain EIP-712 (`name`) incorrecto para Base Sepolia (literal `"USD Coin"` hardcodeado) → firma inválida, facilitator rechaza o (peor) firma un domain que no ata al contrato real | ALTA | AC-4/CD-4 + DT-3 (lookup por chainId, no env editable) — bloqueante de F2 |
| `AVALANCHE_RPC_URL` sigue leyéndose en `onchain-verifier.ts` tras el cambio de red → verificación on-chain lee la cadena EQUIVOCADA (Avalanche) mientras el settle ocurrió en Base → `settle_unverified` en el mejor caso, falso negativo en el peor | ALTA | AC-6, rename explícito de la env + test que falla si queda el nombre viejo |
| `wasiai-facilitator` sin `BASE_SEPOLIA_ENABLED=true` en el deploy → settle en Base responde 400/404 (adapter no registrado), remesa queda huérfana (ya cubierto por WKH-207/reconcile) pero es una sorpresa evitable | MEDIA | Scope IN nota de coordinación ops — checklist explícito antes de F3/validación |
| Confundir chainId de Base Sepolia (84532) con mainnet (8453) en un env mal seteado → firma real contra mainnet sin querer | ALTA | CD-1 + AC-9 + guard fail-closed (AC-11), checklist de deploy manual (no automatizado por esta HU) |
| USDC address de Base Sepolia mal copiada (typo) en `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS` | MEDIA | Ya mitigado por el patrón existente `isAddress()` fail-loud (`resolveUsdcAddress`) — sin cambio necesario, solo actualizar el valor documentado en `.env.example` |

## Missing Inputs

- [BLOQUEANTE F2] DT-1 — swap directo (elimina Avalanche del código) vs soporte multi-red
  (Avalanche queda disponible pero inactivo). Requiere confirmación explícita del founder antes de
  que el Architect cierre el SDD.
- [NEEDS CLARIFICATION, no bloqueante] DT-2 — nombre final de la(s) env(s) de RPC de Base
  (`BASE_SEPOLIA_RPC_URL` simple vs convención testnet/mainnet explícita). Se puede resolver en F2
  sin gate humano, siguiendo el patrón ya usado por `wasiai-facilitator`.
- [NEEDS CLARIFICATION, no bloqueante] AC-3 — ¿el default fail-safe de `resolveChainId()` cuando
  falta/es inválido `NEXT_PUBLIC_CHAIN_ID` pasa a ser Base Sepolia (84532) o se mantiene un default
  "mainnet" conservador (8453) espejando el patrón actual (`43114` hoy)? Recomendación Analyst:
  mantener el mismo patrón conservador (default = mainnet id) por consistencia con el código
  existente, pero el Architect debe decidirlo explícitamente en F2 (fail-safe ≠ fail-open).
- [NEEDS CLARIFICATION, no bloqueante, operativo] Confirmar que el deploy de `wasiai-facilitator`
  usado por `chaski-v2` (vía `FACILITATOR_BASE_URL`) YA tiene `BASE_SEPOLIA_ENABLED=true` +
  `BASE_SEPOLIA_RPC_URL` seteados, o si hay que coordinarlo antes de que F3/F4 puedan validar un
  settle real end-to-end en Base Sepolia.

## Análisis de paralelismo

- No bloquea ni es bloqueada por ninguna HU DONE existente (todas las HUs 178-207 del backlog están
  cerradas). No hay overlap de archivos con trabajo en curso conocido — esta HU es la única activa
  sobre `chaski-v2` en este momento.
- Coherente con WKH-208 (source.currency `USDCBASE` de TransFi, según contexto del founder) — esta
  HU es el complemento del lado on-chain de esa misma decisión de red. Sugerido: si WKH-208 no está
  DONE aún, coordinar que ambas apunten a la MISMA red (Base) antes de activar cualquier flag real
  (AC-10).
- No bloquea trabajo futuro conocido; es prerequisito para cualquier HU futura que dependa de
  "settle real en Fase A" funcionando end-to-end (el flag `NEXT_PUBLIC_EIP3009_ENABLED` sigue OFF
  hasta una decisión explícita posterior del founder, fuera de esta HU).
