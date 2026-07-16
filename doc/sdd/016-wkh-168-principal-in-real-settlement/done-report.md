# Report — HU [WKH-168] GATE Fase A / G3 — Principal-in real

## Resumen ejecutivo

WKH-168 cierra el bug de fondo del gate G3 de la Fase A: `principal_in` dejó de significar "el usuario firmó" y pasó a significar **"hay un receipt on-chain verificado contra el log `Transfer` del USDC, con monto y receiver correctos"**. Implementó **24 archivos (11 nuevos + 13 modificaciones), 9 waves, 362/362 tests verdes** tras 2 fix-packs post-AR/CR + 1 fix-pack post-re-AR. **Status final: APROBADO PARA DONE (F4 validada 2026-07-15).**

**⚠️ G3 CERRADO pero NO habilita Fase A**: faltan G5/WKH-206 (posesión criptográfica), Mitad B/TransFi (payout real), y partners/legal. Los flags siguen OFF por default. **Esta HU construye, no enciende.**

---

## Pipeline ejecutado

| Fase | Estado | Veredicto | Evidencia |
|------|--------|-----------|-----------|
| **F0** | ✅ DONE | Project-context leído; bug de fondo confirmado | `work-item.md` grounding completo, issue de `waitForTransactionReceipt` = 0 ocurrencias verificadas |
| **F1** | ✅ DONE | Work-item APROBADO con 9 ACs EARS | `HU_APPROVED` (2026-07-15, orquestador) — `work-item.md:1-320` |
| **F2** | ✅ DONE | SDD APROBADO (tamaño escalado a XL, W6 incluido) | `SPEC_APPROVED` (2026-07-15, orquestador) — `sdd.md:1-498`, sin `[NEEDS CLARIFICATION]` bloqueantes de diseño |
| **F2.5** | ✅ DONE | Story File documentado, Acceptance Criteria refinados, Waves y Tests enumerados | `story-WKH-168.md:1-1295`, CD-13 endureció los conteos (solo autoridad = runner, no `grep -c`) |
| **F3** | ✅ DONE | 9 Waves implementadas, 287 → **362 tests** (+75 nuevos), 0 failing, tsc clean | Branch `feat/016-wkh-168-principal-in-real-settlement`, HEAD `bda96ba` (sin commitear — decisión humana) |
| **AR** | ✅ DONE | 0 BLQ, 4 MNR, 17 mutantes ejecutados | Veredicto: **APROBADO** — 7 ataques e2e corridos (sin atestación/monto inflado/pagador ajeno/replay/Upstash caído/HMAC forjado → todos 403/503, nunca forward) |
| **CR** | ✅ DONE | 0 BLQ, 5 MNR encontrados | Veredicto: **APROBADO** — eco del facilitador (C4/C5), landing page error, type laundering, imports relativos |
| **Fix-pack** | ✅ DONE | 3 items del AR | **`quoteId` verificación (A7′)** — payout bajo quote tasa distinta; **comentario C4** — eco vs. guard; **`receiver` acoplado** — import application→infra evitado |
| **re-AR** | ✅ DONE | 0 BLQ, 2 MNR, 11 mutantes ejecutados | Veredicto: **APROBADO** — `att.chainId` y los ataques de secreto compartido entre entornos (Fuji vs mainnet) |
| **Fix-pack #2** | ✅ DONE | 1 item del re-AR + mutante fail-open | **`att.chainId` guard + assert hostil** — 4 mutantes muertos (ausente, body-sourced, invertido, post-claim leak) |
| **F4** | ✅ DONE | 11/11 ACs PASS (evidencia archivo:línea), 362/362 tests, flags OFF, CD-1 sostenido | `validation.md:1-51`, todos los CDs verificados ejecutando (greps, env checks, scope) |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia | Nota |
|----|--------|-----------|------|
| AC-1 | PASS | `confirm-and-send.test.ts:359` | Settle invocado con authorization completa, no solo firma |
| AC-2 | PASS | `onchain-verifier.test.ts` (V1-V9); `confirm-and-send.test.ts:494,515` (C4/C5 mismatch) | Verificación on-chain independiente del echo del facilitador |
| AC-3 | PASS | `confirm-and-send.test.ts:440` | Todo error del settlement → `payout_failed`, `principalTx` null, nunca `principal_in` |
| AC-4 | PASS | `confirm-and-send.test.ts:380` | `principalTx` = hash verificado on-chain, NUNCA firma cruda |
| AC-5 | PASS | `wallet.test.ts` (asserts intactos), `container.test.ts:81` | Flag OFF preserva comportamiento byte-idéntico por construcción |
| AC-6 | PASS | `confirm-and-send.ts:62`, test L537,560,561,579,580 | Marca `principal_settled_refund_manual` cuando el principal está realmente adentro |
| AC-7 | PASS | `app/api/settle/principal/route.test.ts:118,137` | Ruta server-side, Bearer auth, credenciales nunca en respuesta al cliente |
| AC-8 | PASS | `container.ts:57-68` (byte-idéntico), `container.test.ts` (8 tests confirmados runner) | Guard fail-loud no debilitado |
| AC-9 | PASS | `ports.ts:115-119`, `confirm-and-send.ts:55-60` | Orfandad residual documentada (no suavizada) → WKH-207 |
| AC-10 | PASS | `app/api/a2a/payout/submit/route.test.ts:334,353,369,380,393,421,437,517` | Atestación exigida, HMAC vigente, monto atado, pagador atado |
| AC-11 | PASS | `route.test.ts:489,502` | Single-use (409 replay), Upstash caído (503 fail-closed, nunca forward) |

---

## Hallazgos finales

### BLOQUEANTEs

**Cero bloqueantes abiertos.** Todos los hallazgos del AR/CR fueron resueltos en fix-packs y verificados en re-AR/F4.

### MENORs (Documentados como deuda, no bloquean DONE)

| Severidad | Item | Resolución | Backlog |
|-----------|------|-----------|---------|
| CR/MNR-3 | S19 ambiguo (504 vs 503 del spec) | Documentado que un timeout de settle puede representar una tx minada → fail-closed a `payout_failed` | Tracking fuera de scope |
| CR/MNR-4 | Type laundering en `verifyStatus` + `reason: string` sin exhaustividad | Refactor deuda técnica | No bloquea G3 |
| AR/MNR-3 | `valueMinor <= 0` sin test en V8 | Cubierto implícitamente (Money.of rechaza ≤0) | No bloquea G3 |

### Residual honestamente documentado (NO suavizado)

**Esta HU NO cierra la Fase A. Faltan:**

1. **G5/WKH-206** — Posesión criptográfica (SIWE). Hoy nada prueba que el caller controla la wallet que firma.
2. **Mitad B / TransFi** — USDC→PEN→Yape. Bloqueada por sandbox del partner.
3. **Partners / Legal** — Res. SBS 02648-2024, análisis PSAV abierto (ver § Pregunta Legal abajo).
4. **WKH-207** — Remesas huérfanas (pestaña cerrada entre `principal_in` y terminal con dinero realmente adentro). Esta HU **empeora la consecuencia** (antes no había plata, ahora sí) sin cerrar el gap. Single-use de atestación agrega un caso nuevo (atestación quemada + forward fallido = varado con principal adentro).
5. **DT-8 (clawback real)** — Imposible revertir un `transferWithAuthorization` ya settleado; requiere clave del receiver. Refund es **manual** (marca `principal_settled_refund_manual`).

---

## Auto-Blindaje consolidado

### Lecciones del pipeline (sesión WKH-168)

#### 1. La tautología del echo — TRES niveles (F0/F2.5/CR)

**Patrón**: Usar el output de una función como verificación de su input.

- **F0/Grounding**: `base-adapter.ts:811` ecoa nuestro input → un chequeo `response.to === receiver` compara nuestro input contra nuestro input.
- **F2.5/SDD**: El test de AC-2 describía un caso imposible (fake devolviendo `to:"0xOTRO"`) que el facilitador nunca puede producir.
- **CR/Fix-pack**: El comentario de C4 declaraba un "guard" que era un canario de drift cliente↔server — comparar `res.valueMinor` contra `quote.send.minor` cuando `res.valueMinor = quote.send.minor` (el server devuelve exactamente lo que recibió).
- **Aplicar en**: Antes de comentar un check como "guard", **tracear de dónde sale cada operando**. Si los dos lados vienen de la misma fuente, es un canario, no seguridad — decirlo explícitamente.

#### 2. Grep es ambiguo cuando hay `it.each` — CD-13 endurecido

**Patrón**: Contar tests con `grep -c "^\s*it("` cuenta un `it.each` de 4 casos como **1**. El runner cuenta **4**.

- **Evidencia ejecutada hoy**: `app/api/a2a/payout/submit/route.test.ts` → grep dice 16, runner dice **19** (gap = 3 casos de `it.each` en WKH-202/BLQ-BAJO-1).
- **Aplicar en**: La **única** autoridad de conteo es el output del runner (`npx vitest run <archivo>` → `PASS (N)`). PROHIBIDO usar `grep` como evidencia de artefactos. Todo número de tests en SDDs/reports viene del runner.

#### 3. `git diff` sobre untracked da vacío POR CONSTRUCCIÓN (Fix-pack #2)

**Patrón**: Un archivo nuevo (`onchain-verifier.ts`, creado en esta HU, untracked) → `git diff` lo ignora → output vacío.

- **Consecuencia**: Un chequeo `git diff` vacío no prueba que el archivo está intacto; probablemente prove que el archivo **nunca fue cacheado por git**.
- **Patrón fallido dos veces**: Afirmar sin reproducir — "correr un comando cuyo output parece confirmar mi creencia, sin preguntarme qué otra cosa produce ese mismo output".
- **Aplicar en**: Para probar byte-identidad de un untracked → `md5sum` ANTES de tocar (`md5sum archivo > /tmp/before`) → después (`md5sum -c /tmp/before` → output `OK` o `FAILED`). O simplemente commitear primero para que `git diff` empiece a significar algo.

#### 4. Mutation testing por el DEV antes de entregar (lección de F3)

**Patrón**: El dev corrió mutantes en `onchain-verifier.test.ts` + `attestation-store.test.ts` antes de enviar a AR.

- **Impacto**: Descubrió que el primer test de `att.chainId` (guardia contra secreto compartido entre entornos Fuji/mainnet) tenía un mutante sobreviviente — el test solo validaba el caso feliz, no el hostil (atacante manda `chainId` distinto en el body, se identifica como "de otra red").
- **Fix-pack #2**: Assert hostil agregado (mandar `chainId: [43114, 43113, "43114", null]` mientras la atestación es de otra cadena → 403 igual) → 4/4 mutantes muertos.
- **Aplicar en**: No solo pasá el test por el verde; **mata el mutante obvio** (borrar el guard → debería fallar) + **mata el mutante fail-open** (el guard tomando del caller/environ incorrecto). Si el test pasa con el mutante aplicado, no estás testeando lo que creés.

#### 5. Probes de adversary en copia aislada (CR/auto-blindaje)

**Patrón**: Un CR dejó `src/adv.test.ts` (debug file) en el árbol → contaminó las corridas de test (agregó 1 test extra), solo detectado por el F4 counting.

- **Aplicar en**: Después del CR, verificar que **solo los archivos de Scope IN fueron tocados** (git status + expansión de untracked). Archivos de debug (*adv, *debug, *test-manual) que no estén en la tabla del Story File → PARAR y escalar (CD-22).

#### 6. Imports de deep module vs. atajo env en route

**Patrón**: Wave 7, se intentó que `app/api/settle/principal/route.ts` leyera `process.env.FACILITATOR_BASE_URL` directamente → violaba CD-20 ("`facilitator-client.ts` es el ÚNICO dueño de esas envs").

- **Fix**: Exportar `isBroadcasterConfigured()` desde `facilitator-client.ts`; la route pregunta al módulo en vez de leer sus envs (CD-20 sostenido, broadcaster reemplazable tocando 1 archivo).
- **Patrón general**: Cuando una rama del Story File nombra una env que un CD declara privada de otro módulo → **exponer un helper desde el dueño**, nunca leerla desde afuera.

---

## Tabla de GATE de Fase A (5 huecos de seguridad)

| Hueco | Descripción | HU | Status | Veredicto |
|-------|-------------|----|----|----------|
| **G1** | `/api/a2a/payout/submit` era proxy público sin auth | WKH-202 ✅ | DONE (2026-07-15, `3bae588`) | Auth + ownership server-side instalado |
| **G2** | `kycPayoutAllowed` del caller sin verificación server-side | WKH-203 ✅ | DONE (2026-07-15, `37728c0`, otro repo) | KYC re-validado en `/api/a2a/payout/validate` |
| **G3** | Nadie verificaba que el sender pagó el principal en USDC | **WKH-168 ✅** | **DONE (2026-07-15)** | **Settle real verificado on-chain, atestación HMAC ata el payout** |
| **G4** | KYC no estaba atado a la identidad de quien pide payout | WKH-204 ✅ | DONE (2026-07-15, `eca36cf`) | Address del KYC ata al address del payout (A7) |
| **G5** | SIWE / Prueba criptográfica de posesión | WKH-206 | **REGISTRADA** (no arrancada) | **BLOQUEANTE para Fase A real** |

**Conclusión**: G3 cerrado. G1/G2/G4 ya cerrados. **G5 sigue abierto** → Fase A NO está habilitada, pese a G3 estar listo.

---

## ⚠️ CHECKLIST CRÍTICO — antes de encender `EIP3009_ENABLED`

**Nota**: Esta HU construye la infraestructura; no enciende los flags. El orquestador/humano deberá resolver ANTES de que alguien deje `NEXT_PUBLIC_EIP3009_ENABLED=true` en un environment real.

### 1. **SECRETOS DISTINTOS POR DEPLOYMENT** — Hallazgo del re-AR

**Problema**: Si un preview en Fuji y prod en mainnet **comparten** `SETTLE_ATTESTATION_SECRET`, una atestación de Fuji (USDC de faucet, gratis) se replaya contra el submit de mainnet → **payout real de $400 por $0**.

**Checklist**:
- [ ] `SETTLE_ATTESTATION_SECRET` configurada DIFERENTE en cada entorno (Fuji: valor X, mainnet: valor Y, nunca iguales).
- [ ] Replicar la migración de `DIDIT_API_KEY` (ya hace esto — env vars por proyecto Vercel).
- [ ] Vercel preview ≠ Vercel prod ≠ local dev (si alguien testea EIP3009 local, secret local nuevo).
- [ ] **Mitigante implementado (fix-pack #2)**: check `att.chainId` + `resolveChainId()` server-side → un ataque de Fuji puede firmar `chainId: 43113` pero el submit de mainnet tiene `resolveChainId() = 43114` → A7″ rechaza la atestación (403).

**Gatillo real**: El dev lo encuadró como *"el día que haya dos redes"*, pero es falso — **ocurre con UNA SOLA cadena**; es un problema de **ops**, no roadmap.

### 2. **DoS económico** — `/api/settle/principal` sin auth

**Problema**: `/api/settle/principal` **no tiene rate-limit ni auth** (ruta pública). Un atacante firma un `transferWithAuthorization` **legítimo de 1 unidad** ($0.000001) y **nos hace broadcastear**: él paga polvo, **nuestro relayer paga el gas** → desagota `OPERATOR_FUNDING_LOW` o el cap diario del facilitador → DoS del money-path.

**Checklist**:
- [ ] Rate-limit en `/api/settle/principal` (¿por IP? ¿por address? ¿por atestación?).
- [ ] O autenticación (requiere un `PayoutSubmit` con atestación vigente — transforma el flujo a que la atestación se emita ANTES del settle, no después).
- [ ] `src/infrastructure/rate-limit.ts` ya existe y está cableado a Upstash.

**Estado actual**: No está dentro de esta HU (CD-22 silencioso). Es un **hallazgo descopado**; aparece en AR/MNR pero no hay fix.

### 3. **Gas del relayer en Fuji** — Precedente real

**Problema**: El wallet `0xf432` (relayer) paga gas en Avalanche Fuji; faucets tienen límites diarios y son gateados por captcha.

**Checklist**:
- [ ] ¿El deploy de `wasiai-facilitator` tiene `AVALANCHE_FUJI_RPC_URL` configurada?
- [ ] ¿El wallet del relayer tiene fondos suficientes en Fuji (>0.1 AVAX)?
- [ ] Test e2e con un settle real en Fuji testnet (no solo fakes).

**Estado actual**: `[NEEDS CLARIFICATION]` NO bloqueante de F2 (ver work-item L143-145). Los tests con fakes/mocks no dependen de esto.

### 4. **`FACILITATOR_PAYTO_ALLOWLIST`** — Operador del facilitador

**Problema**: `wasiai-facilitator` tiene un allowlist de addresses a los que se puede enviar USDC (`settle.ts:131`, `isPayToAllowed`). Si `resolveReceiverAddress()` no está en esa lista → todo settle da **403**.

**Checklist**:
- [ ] Pedir al operador del facilitador que agregue `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS` (la address del receiver) al allowlist.
- [ ] O verificar que ya está agregada (hacer un settle de prueba en Fuji testnet).
- [ ] Documentar en el runbook: si un settle da 403 `FORBIDDEN`, verificar que el receiver está en el allowlist.

**Estado actual**: `[NEEDS CLARIFICATION]` NO bloqueante de F2 (ver sdd.md L448). Requiere coordinación con operador.

---

## ⚠️ PREGUNTA LEGAL ABIERTA (No bloquea DONE, sí bloquea "encender")

### Contexto — Res. SBS 02648-2024 (Perú, PSAV)

La norma define PSAV **por la actividad** — *"transferencia de activos virtuales **para o en nombre de otra persona**"* — **no por la autodenominación**. El análisis legal del proyecto dice:

> *"Si el orquestador toca el USDC o dispara la transferencia en nombre del sender, la autodenominación 'capa tech' no protege."*

**Nuestro caso ambiguo**: El facilitador (`wasiai-facilitator`) hace `writeContract` que ejecuta el `transferWithAuthorization` del usuario. ¿Es el facilitador quien "toca el USDC" o es el usuario?

### Directiva de Arquitectura (vinculante, CD-20/CD-21)

Para que **un veredicto legal adverso mate lo menos posible**, el diseño hizo broadcast y verificación **SEPARABLES**:

| Pieza | Rol | Riesgo | Destino si veredicto adverso |
|-------|-----|--------|------------------------------|
| `onchain-verifier.ts` (W3) | **Leer** receipt + log | **Ninguno** — leer una cadena no es transferir | **Sobrevive intacto** |
| `attestation.ts` + `attestation-store.ts` (W0/W6) | Firmar/verificar hecho | **Ninguno** — firma HMAC del hecho | **Sobrevive intacto** |
| `facilitator-client.ts` (W2) | **Transmitir** (rol de relayer) | **Es el único expuesto** | **Se reemplaza quién transmite** |

**Regla CD-20**: `onchain-verifier.ts` **NO importa** `facilitator-client.ts`, **no lee ninguna env `FACILITATOR_*`**, no sabe quién broadcasteó. Input: un `txHash` de cualquier origen.

**Regla CD-21**: `facilitator-client.ts` **NO verifica nada**, es el único archivo que conoce `FACILITATOR_BASE_URL` / `FACILITATOR_API_KEY`.

**La composición vive en un único lugar**: `app/api/settle/principal/route.ts`.

### Primera pregunta a resolver

**¿Dónde está constituida la entidad de chaski-v2?**

La Res. SBS 02648-2024 **Art. 1** limita el ámbito a proveedores **domiciliados o constituidos en Perú** (o con sucursal inscrita). Si chaski-v2:
- **Está constituida fuera de Perú** → la norma **no la alcanza** (es por qué Binance y Coinbase están fuera).
- **Está constituida en Perú** → el análisis de PSAV es pertinente y requiere confirmación legal de si el patrón "no-custodial" (usuario firma, nosotros solo broadcasteamos) califica para un carve-out.

**Segunda pregunta** (si está constituida en Perú): ¿Es suficiente que nosotros NO toquemos el USDC, solo lo verifiquemos?

El análisis dice: *"si el diseño es genuinamente no-custodial, el carve-out podría aplicar — pero si el orquestador toca el USDC o dispara la transferencia en nombre del sender, la autodenominación 'capa tech' no protege"*. Nuestro diseño deja el broadcast en un módulo separable; si el veredicto es "no, ustedes tocaron el USDC", la solución es reemplazar ese módulo sin matar el resto.

---

## Decisiones diferidas a backlog

| Ticket | Descripción | Backlog | Bloqueador |
|--------|-------------|---------|-----------|
| **WKH-207** | Remesas huérfanas + reconciliación (persistencia server-side) | Post-Fase A | AC-9 residual — no bloquea G3 pero sí usabilidad post-"encendido" |
| **WKH-206** | G5 — Posesión criptográfica (SIWE) | Post-WKH-168 | **BLOQUEANTE para Fase A real** |
| **Mitad B** | USDC→PEN→Yape (TransFi) | Post-partner | **BLOQUEANTE para Fase A real** |
| CR/MNR-3 | S19 ambiguo (504 vs 503) | Deuda chore | Documentado, no afecta seguridad |
| CR/MNR-4 | Type laundering en verificador | Deuda chore | Documentado, no afecta seguridad |
| AR/MNR-3 | `valueMinor <= 0` sin test | Deuda chore | Mitigado implícitamente (Money.of) |
| **DOS económico** | Rate-limit en `/api/settle/principal` | Post-WKH-168 | Hallazgo durante AR, no resuelto |

---

## Archivos modificados

**Total: 24 archivos (11 nuevos + 13 modificaciones).** Verificado ejecutando.

| Acción | Archivos |
|--------|----------|
| **CREAR (11)** | `attestation.ts`, `attestation.test.ts`, `facilitator-client.ts`, `onchain-verifier.ts`, `onchain-verifier.test.ts`, `http-settlement-gateway.ts`, `http-settlement-gateway.test.ts`, `attestation-store.ts`, `attestation-store.test.ts`, `settle/principal/route.ts`, `settle/principal/route.test.ts` |
| **MODIFICAR (13)** | `ports.ts`, `wallet.ts`, `wallet.test.ts`, `container.ts`, `container.test.ts`, `confirm-and-send.ts`, `confirm-and-send.test.ts`, `fakes.ts`, `test-container.ts`, `gateways.ts`, `payout/submit/route.ts`, `payout/submit/route.test.ts`, `.env.example` |
| **NO TOCAR (verificado)** | `remittance.ts`, `money.ts`, `chain.ts`, `kyc-auth.ts`, `rate-limit.ts`, `ledger-refund-gateway.ts`, `flow.tsx`, `presentation/**`, `domain/**` |

**Baseline**: `npx vitest run` → `PASS (287)` → **PASS (362)** (+75 tests nuevos, 0 failing).

---

## Lecciones para próximas HUs

### 1. **Verify, don't trust** — La tautología del eco

Antes de usar algo como verificación, preguntá: *"¿Qué output daría si la hipótesis fuera falsa? Si es el mismo, no prueba nada."*

- Un `response.to === receiver` donde `response.to` es nuestro input → tautología.
- Un fake de test que describe un caso imposible que el sistema real nunca puede producir → test falso verde.
- Un comentario que dice "guard" pero el guard compara `x` contra `x` → falsa sensación de seguridad.

**Aplicá**: Tracear el origen de cada operando en un chequeo. Si ambos lados vienen de la misma fuente, es un canario de drift, no defensa. Decilo así.

### 2. **La autoridad del runner, nunca del grep**

El desarrollo en Chaski v2 usó `grep -c "it("` para contar tests. **Ambiguo: cuenta un `it.each` de 4 como 1; el runner cuenta 4.**

**Regla endurecida (CD-13)**: La **única** autoridad es `npx vitest run <archivo>` → `PASS (N)`. Todo número de tests en artefactos viene del runner, sin excepciones.

### 3. **Antes de afirmar, reproduzco**

La auto-replicación del patrón "afirmar sin reproducir" apareció **tres veces en esta HU**:

1. **F1**: Work-item decía "los 6 tests de `container.test.ts`" — **son 8** (verificado ejecutando).
2. **Fix-pack #2**: Declaré `onchain-verifier.ts` byte-idéntico evidenciando `git diff` vacío — **pero el archivo es untracked**, `git diff` lo ignora por construcción → no prueba nada.
3. **CR/comentario**: Presenté C4 como "guard" — pero `res.valueMinor === quote.send.minor` por contrato → ningún input de producción lo hace fallar.

**Aplicá**: Ante cualquier declaración (`"esto es así", "este archivo no cambió", "este check lo protege"`) — preguntá: **¿Qué comando/test lo verifica?** Si no ejecutaste ese comando/test, no lo escribas como fundamento.

### 4. **Mutation testing, no solo cobertura**

El dev de esta HU corrió mutantes en `:test.ts` ANTES de enviar a AR. Descubrió:

- Un test que pasaba el caso feliz pero tenía un mutante sobreviviente (atacante manda `chainId: otro` en el body, el test no lo cubría porque asumía que el input honesto nunca trae ese campo).
- Fix: assert hostil en el MISMO test (mandar valores maliciosos en campos opacos) → mata el mutante.

**Aplicá**: No solo "¿el test pasa?". También: "¿si borro el guard, el test falla?" (mutante obvio) + "¿si el guard toma del caller en vez de la env, el test falla?" (mutante fail-open). Si pasa con el mutante, no estás testeando.

### 5. **Acoplamiento deliberado en el money-path**

El fix-pack de CR intentó inyectar `receiver` para evitar un import `application → infrastructure`. **Falso trade-off** — la env ya se resolvía en el container fail-loud, el receiver es único (no es un opcional), y el código quedó más puro pero menos obvio.

**Patrón corregido**: `settlement?: { gateway; receiver }` **acoplado**. `settlement !== undefined` ⇔ modo real ⇔ el guard del container ya validó ambos. Acopla lo que sólo existe junto; evita los opcionales que se saltean solo.

**Aplicá**: En el money-path, preguntá: ¿esto puede ser `undefined`? Si la respuesta es "en modo demo sí, en modo real no", acoplo con otro parámetro que también es "en modo demo undefined, en modo real {objeto}". Evito los `?` que se saltean en silencio.

---

## Runbook para Fase A (post-WKH-168)

### ANTES de setear `NEXT_PUBLIC_EIP3009_ENABLED=true`:

1. **Coordina con el operador del facilitador**:
   - [ ] Verifica que `AVALANCHE_FUJI_RPC_URL` está configurada en `wasiai-facilitator`.
   - [ ] Verifica que el relayer wallet tiene AVAX Fuji para pagar gas.
   - [ ] Pide que agregue el `PAYOUT_RECEIVER_ADDRESS` al allowlist.
   - [ ] Si Fuji: obtén una `FACILITATOR_API_KEY` propia (no compartida con otros servicios).

2. **Secretos únicos por deployment**:
   - [ ] Vercel preview (Fuji testnet): `SETTLE_ATTESTATION_SECRET` = valor A, `FACILITATOR_API_KEY` = key A.
   - [ ] Vercel prod (mainnet): `SETTLE_ATTESTATION_SECRET` = valor B (**distinto**), `FACILITATOR_API_KEY` = key B.
   - [ ] Local dev: `SETTLE_ATTESTATION_SECRET` = valor C (nunca igual a A/B).

3. **Test e2e en testnet**:
   - [ ] Mint USDC de faucet en Fuji (el receiver debe tener una address válida).
   - [ ] Corre un settle real: firma, espera receipt, verifica on-chain.
   - [ ] Confirma que `principal_in` está seteado.
   - [ ] Confirma que la atestación se generó y se verificó en `/api/a2a/payout/submit`.

4. **Aún sin encender el payout real**:
   - [ ] Sigue con `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=fallback` (mock).
   - [ ] Solo activa `NEXT_PUBLIC_EIP3009_ENABLED=true`.
   - [ ] Verifica que los 11 ACs se cumplen con dinero ficticio (fakes en test/demo local, USDC real en testnet).

5. **Después: espera G5/WKH-206 + Mitad B + legal**:
   - [ ] WKH-206: posesión criptográfica (SIWE).
   - [ ] Mitad B: payout real TransFi (USDC→PEN→Yape).
   - [ ] Legal: veredicto de PSAV (¿constitución de chaski-v2?, ¿carve-out no-custodial válido?).
   - Recién entonces: setear flags y habilitar la Fase A de verdad.

---

## Status final

**DONE (2026-07-15).** Todos los artefactos de la HU están consolidados y verificados:

- ✅ `work-item.md` — 9 ACs EARS, 8 CDs, DT-1…9.
- ✅ `sdd.md` — 498 líneas de diseño, 4 hallazgos de grounding, 11 CDs, 9 waves, enumeración exhaustiva de ramas.
- ✅ `story-WKH-168.md` — 1295 líneas, 3 ideas clave, 11 ACs, CD-13 endurecido, regla de conteo (solo runner).
- ✅ `auto-blindaje.md` — 7 lecciones registradas (echo, `grep -c`, `git diff` untracked, mutation testing, probes, imports, afirmar sin reproducir).
- ✅ `validation.md` — 11/11 ACs PASS, 362/362 tests, 0 fails, todos los CDs verificados ejecutando.
- ✅ `done-report.md` — Este archivo.

**La HU es completamente independiente**, puede mergearse y deploiarse ahora mismo (los flags están OFF). No bloquea a ninguna otra HU.

