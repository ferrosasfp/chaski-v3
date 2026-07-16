# Auto-Blindaje — WKH-168 (F3 / Dev)

Errores cometidos durante la implementación y su fix. Se documentan para que no se repitan.

---

### [2026-07-15 17:52] Wave 1/3 — Los comentarios que explican un CD rompen el grep que lo verifica

- **Error**: 3 de los 4 greps verificables de CDs dieron > 0 con el código correcto.
  `grep "getRandomValues" wallet.ts` → 1, `grep "writeContract" src app` → 2,
  `grep "facilitator" onchain-verifier.ts` → 1. Ninguno era código: eran **comentarios míos** que
  nombraban la palabra prohibida para explicar por qué NO la usamos
  (ej. `// El nonce ERA random (toHex(crypto.getRandomValues(...)))`).
- **Causa raíz**: los CDs 18/19/20/21 se definen como un `grep` literal que debe dar **0**. Un
  comentario didáctico que cita el antipatrón es indistinguible del antipatrón para `grep`. Escribí
  la documentación pensando en un lector humano, no en el verificador automático que el AR va a correr.
- **Fix**: reformular los comentarios sin el token literal, conservando el significado
  ("32 bytes de CSPRNG" en vez de `getRandomValues`; "cero escrituras on-chain" en vez de
  `writeContract`; "el cliente de broadcast" en vez de `facilitator-client.ts`).
- **Aplicar en**: cualquier CD definido como "grep X → 0". **Antes de cerrar la wave, correr el grep
  del CD, no solo leer el código.** Si un comentario necesita citar el antipatrón, parafrasearlo.

---

### [2026-07-15 17:57] Wave 2 — Un `Response` reutilizado en un mock da FALSO VERDE

- **Error**: `fetchMock.mockResolvedValue(new Response(...))` en un test que hace 4 POSTs. El body de
  un `Response` se consume en la **primera** lectura → del 2º POST en adelante `res.json()` tira → la
  ruta caía en `settle_unverified` (502). Tres asserts de ese test **pasaban por la razón
  equivocada** (esperaban 502 por otro motivo y coincidía el status). El 4º esperaba 503 y explotó,
  que fue lo único que delató el problema.
- **Causa raíz**: `mockResolvedValue` devuelve **la misma instancia** en cada llamada. Un `Response`
  no es reusable (su body es un stream de una sola lectura). El test no probaba lo que decía probar.
- **Fix**: `mockImplementation(async () => new Response(...))` → instancia nueva por llamada.
- **Aplicar en**: **todo** mock de `fetch` que responda a más de una llamada
  (`settle/principal/route.test.ts`, `http-settlement-gateway.test.ts`, y cualquier test futuro de
  route). Regla: **si el mock devuelve un `Response`/`Request`/stream, usar `mockImplementation`,
  nunca `mockResolvedValue`.** Síntoma típico: asserts que pasan con el status correcto pero por un
  camino distinto al que el test nombra.

---

### [2026-07-15 18:02] Wave 6 — `npm run build` habría ocultado 2 errores de tsc (CD-23 en vivo)

- **Error**: `vi.hoisted(() => ({ claimMock: vi.fn(async () => ({ ok: true })) }))` infiere
  `{ok: boolean}` desde el valor default → los `mockResolvedValue({ok:false, alreadyUsed:true})` no
  compilaban (TS2353 ×2). Los **tests pasaban en verde**; solo `tsc --noEmit` lo detectó.
- **Causa raíz**: vitest ejecuta los tests sin typecheckearlos. `npm run build` excluye los
  `*.test.ts`. Es **exactamente** el precedente WKH-196 (un CR aprobó con el tsc roto porque validó
  con `build`).
- **Fix**: tipar el mock explícitamente:
  `vi.fn<(txHash: string) => Promise<Claim>>(async () => ({ ok: true }))`.
- **Aplicar en**: **el gate de toda wave es `npm run qa`** (`tsc --noEmit` + `vitest run`), nunca
  `npm run build` ni `vitest` a secas. Todo `vi.fn` cuyo retorno sea una unión discriminada necesita
  parámetro de tipo explícito, o TS infiere el shape del default y rechaza las otras ramas.

---

### [2026-07-15 18:00] Wave 5/6 — Contar mal las llamadas al reloj / ignorar el orden de guards previo

Dos errores del mismo tipo (asumir en vez de verificar), agrupados:

- **Error A** (`ScriptedClock`): pasé `[T0, T0, T0, T0, T0, "18:20"]` para simular "el quote vence
  durante el settle". La 4ª llamada a `nowIso()` es el re-check 3.5, así que la secuencia dejaba el
  quote **válido** y el test no ejercitaba C7.
- **Error B** (guard-order): mi test de A2 stubeaba `VERCEL_ENV=production` con `DIDIT_API_KEY=""` →
  disparaba **antes** el guard `simulated_dev` de WKH-202 (503 `payout_authority_unavailable`). El
  status coincidía (503) pero por el guard equivocado: A2 nunca se ejecutaba.
- **Causa raíz**: en ambos casos asumí el comportamiento en vez de derivarlo del código. El orden
  exacto (confirm → re-check 2.5 → markPrincipalIn → re-check 3.5) y la precedencia de guards
  (CD-11) son observables leyendo el archivo.
- **Fix**: A → `[T0, T0, T0, "18:20"]` (4ª llamada vencida). B → autoridad REAL
  (`DIDIT_API_KEY="test-key"` + Didit `Approved` + ownership ok) para atravesar los guards previos y
  llegar a A2.
- **Aplicar en**: todo test sobre un flujo con guards ordenados o un reloj scripteado. **Verificar
  que el test llega a la rama que dice probar** (no solo que el status coincide): un status correcto
  por el guard equivocado es un falso verde. Sirve `expect(...).not.toHaveBeenCalled()` sobre la
  dependencia intermedia, o mutar la rama y ver si el test cae.

---

### [2026-07-15 18:04] Wave 7 — CD-20 violado de verdad: la route leía las envs del broadcaster

- **Error**: la rama S2 hacía `if (!process.env.FACILITATOR_BASE_URL || !process.env.FACILITATOR_API_KEY)`
  **dentro de `app/api/settle/principal/route.ts`** → `grep -rln "FACILITATOR_" src app` daba 4
  archivos en vez de 1. A diferencia de los otros greps (comentarios), **esta era una violación real**.
- **Causa raíz**: leí S2 del Story File ("`!FACILITATOR_BASE_URL` o `!FACILITATOR_API_KEY` → 501") de
  forma literal, sin cruzarlo con CD-20 ("`facilitator-client.ts` es el ÚNICO archivo que puede leer
  esas envs"). Las dos reglas son satisfacibles a la vez, pero hay que **componerlas**.
- **Fix**: exportar `isBroadcasterConfigured()` desde `facilitator-client.ts`; la route pregunta al
  módulo del broadcaster en vez de leer sus envs. S2 se cumple y el broadcaster sigue siendo
  reemplazable tocando **1 archivo** (que es el punto legal/PSAV de CD-20).
- **Aplicar en**: cuando una rama del Story File nombra una env que un CD declara privada de otro
  módulo → **exponer un helper desde el dueño de la env**, nunca leerla desde afuera. Vale para
  `REMIT_AGENTS_BASE_URL`, `DIDIT_API_KEY`, `UPSTASH_*` y cualquier credencial con dueño único.

---

### [2026-07-15 18:30] Fix-pack (post AR+CR) — Implementar la lista de checks del AC en vez del INVARIANTE

- **Error** (AR/MNR-1): la atestación **firma** `quoteId` (`attestation.ts:21`) y la route nunca lo
  comparaba contra `body.quoteId`. Atestación de `"cfx-1"` + payout bajo `"cfx-OTRO-RATE"` → **200 y
  forward**: pagar el principal bajo un quote y cobrar bajo otro con mejor tasa = sobre-entrega. Se
  cerró con A7′ (403 opaco) + test (2 mutantes muertos: borrar la comparación y normalizar el casing).
- **Causa raíz**: el AC-10 enumeraba **3** checks (HMAC, monto, pagador) y los implementé los 3, al
  pie de la letra. Pero el invariante real es *"el payout se paga bajo LAS MISMAS CONDICIONES bajo las
  que entró el principal"*, y el `quoteId` —donde vive la **tasa**— estaba **en el payload firmado**.
  Firmar un campo y no verificarlo es peor que no firmarlo: aparenta un binding que no existe.
- **Fix**: `att.quoteId !== body.quoteId` → 403 opaco, antes del claim single-use.
- **Aplicar en**: **todo campo de un token firmado (HMAC/JWT) debe verificarse o no debe viajar.**
  Al implementar un AC que enumera checks, listar los campos del payload firmado y cruzarlos 1:1
  contra los checks: si sobra un campo firmado sin verificar, es un gap del **spec** — escalarlo, no
  implementar la lista y cerrar los ojos. Vale para `chainId` y `to` (hoy no verificados: el `to` lo
  cubre V6 server-side y el `chainId` es de una sola red — si mañana hay 2 redes, `chainId` pasa a
  ser un check obligatorio acá).

---

### [2026-07-15 18:31] Fix-pack (post CR) — Vender un ECO como un guard en el comentario

- **Error** (CR/MNR-1): el comentario de C4 decía *"AC-2: sin monto Y receiver correctos NO se
  transiciona a principal_in"* — presentándolo como un guard. C4 es `res.valueMinor !== quote.send.minor`
  donde `res.valueMinor` **es** `quote.send.minor`: el server devuelve `input.expectedValueMinor`
  (`onchain-verifier.ts:136`) que es lo mismo que el cliente le mandó (`confirm-and-send.ts:128`).
  Es `x !== x`: **ningún input de producción lo hace fallar**. Su test pasa sólo porque el fake
  inyecta un `valueMinor` que el server no puede emitir. Tercera reincidencia de la asimetría
  claim↔realidad (precedente WKH-203/WKH-204).
- **Causa raíz**: escribí el comentario describiendo la **intención** del check, no lo que el check
  puede observar. Nunca tracé el origen del valor que comparaba. El AC-2 real lo cumple **V8**
  server-side, contra el log `Transfer` de la cadena.
- **Fix**: comentario corregido — C4/C5 son **detectores de drift cliente↔server, NO guards del
  AC-2**, con la asimetría explícita: **C5 SÍ puede dispararse** (`res.to` es un hecho de la cadena
  vs. el receiver de la env del cliente → drift de config), **C4 no** (eco). El código NO se tocó:
  devolver el entero JS ya aseverado en vez de `Number(t.args.value)` es **deliberado** (precisión
  uint256 > 2^53 — lección **WKH-196**).
- **Verificado por mutación** (no por lectura): mutar `onchain-verifier.ts:136` mata un test **del
  server** (`onchain-verifier.test.ts:64`) y **no toca** ningún test de C4 → el eco está pinneado por
  el contrato del server, y C4 no observa nada de la cadena.
- **Aplicar en**: antes de comentar un check como "guard", **tracear de dónde sale cada operando**.
  Si los dos lados vienen de la misma fuente, es un canario de drift, no seguridad — y hay que
  decirlo, porque un revisor/AR futuro va a contar ese check como defensa que no existe. Regla:
  **si no podés construir el input de producción que lo hace fallar, no es un guard.**

---

### [2026-07-15 18:32] Fix-pack (post AR+CR) — Justificar una decisión con un fundamento no reproducido

- **Error** (AR/MNR-4 + CR/MNR-2): `confirm-and-send.ts` importaba `resolveReceiverAddress` de
  `infrastructure/chain` — el **primer** import de producción `application → infrastructure` del repo,
  contra el invariante de `application/errors.ts:1-3`. Lo escalé (bien) pero lo justifiqué con
  *"inyectarlo debilitaría un guard del money-path"*. **Falso, y no lo reproduje**: el container ya
  resolvía y validaba el receiver fail-loud (`container.ts:67`) dentro del **mismo** `if` que decide
  instanciar el settlement → inyectarlo usa la misma env, el mismo composition root y el mismo guard.
  Y C5 **ni siquiera es** el guard del money-path (ese es `settle/principal/route.ts:179`, server-side).
  Costo ya materializado: 3 `stubEnv` en tests unitarios de use-case que en HEAD eran env-free.
- **Causa raíz**: elegí la opción cómoda (no tocar la firma del constructor) y construí el argumento
  de seguridad **después**, sin verificarlo. El trade-off real era "pureza vs un parámetro más", no
  "seguridad vs pureza".
- **Fix**: el receiver viaja **acoplado** al gateway en el 7º param
  (`settlement?: { gateway; receiver }`). Un `receiver?` **opcional** habría recreado el fail-open que
  el Story File prohíbe para `remittanceId` (CD-19): si llega `undefined`, C5 se saltea **en silencio**.
  Acoplado: `settlement !== undefined` ⇔ modo real ⇔ el guard del container ya validó el receiver.
  Sin opcional, sin fail-open, sin import de infra, y los 3 `stubEnv` eliminados.
- **Verificado por mutación**: neutralizar C5 (`toOk = true`) mata el test de C5 → **la fuerza del
  guard no cambió**; cablear un receiver falso en el container mata el test nuevo → el composition
  root es la única fuente. Guard `container.ts:60-68` **byte-idéntico**.
- **Aplicar en**: **cuando escalás un trade-off, reproducí el costo que declarás.** "Esto debilitaría
  X" es una hipótesis verificable: si no la ejecutaste, no la escribas como fundamento — escribí
  "no verifiqué si Y es equivalente". Y ante un opcional en el money-path, aplicar CD-19: **acoplar
  los datos que sólo existen juntos en un solo parámetro** en vez de agregar un `?` que se saltea solo.

---

### [2026-07-15 18:52] Fix-pack #2 (post re-AR) — `git diff` sobre un archivo **untracked** da vacío POR CONSTRUCCIÓN

- **Error**: declaré `onchain-verifier.ts` **"byte-idéntico"** y ofrecí como evidencia un `git diff`
  vacío. El archivo es **untracked** (creado en esta HU, nunca commiteado) ⇒ `git diff` lo ignora y
  sale vacío **pase lo que pase**: con el archivo intacto, reescrito entero o vaciado a 0 bytes. La
  conclusión era **cierta** (el re-AR lo verificó por otra vía y dio bien), pero **la evidencia no
  sostenía nada**. Verificado ahora ejecutando: `git ls-files --error-unmatch
  src/infrastructure/settlement/onchain-verifier.ts` → `did not match any file(s) known to git`.
- **Causa raíz**: mi patrón declarado otra vez — **afirmar sin reproducir**. Corrí un comando cuyo
  output *parecía* confirmar lo que yo ya creía (vacío = sin cambios) y no me pregunté **qué otra cosa
  produce ese mismo output**. Un método que devuelve "OK" para todos los estados posibles del mundo no
  discrimina nada: no es una verificación, es un ritual.
- **Fix**: para probar byte-identidad de un **untracked**: `md5sum` de los archivos protegidos ANTES
  de tocar nada → `md5sum -c` al cerrar (o `diff` contra una copia previa, o commitear primero para
  que `git diff` empiece a significar algo). En este fix-pack se hizo así: los 7 protegidos
  (`onchain-verifier`, `facilitator-client`, `attestation`, `attestation-store`, `chain`,
  `settle/principal/route`, `container`) → `md5sum -c` → **7 OK**.
- **Aplicar en**: **antes de usar un comando como evidencia, preguntá qué output daría si tu hipótesis
  fuera FALSA.** Si es el mismo output → el comando no prueba nada. Aplica a `git diff`/`git status`
  sobre untracked, a `grep` de un patrón mal escrito (0 hits "confirma" ausencia **y** typo por igual),
  y a un test que pasa contra el código mutado.

### [2026-07-15 18:55] Fix-pack #2 — Un mutante SOBREVIVIENTE probó que mi test nuevo no cubría el fail-open

- **Error**: el test de A7″ (`att.chainId` vs cadena del deployment) pasaba y mataba el mutante obvio
  (borrar el guard → `expected 200 to be 403`). Pero al mutar el guard a su forma **fail-open** —
  `att.chainId !== (typeof body.chainId === "number" ? body.chainId : resolveChainId())`, es decir el
  chainId tomado del **caller** — el mutante **SOBREVIVIÓ**: 31/31 verde. Mi test nunca mandaba
  `chainId` en el body ⇒ la forma body-sourced caía en el fallback a la env y era **indistinguible**
  de la correcta. Un atacante bajo ese mutante manda `body.chainId: 43113` + atestación de Fuji contra
  mainnet → 200 y payout real.
- **Causa raíz**: escribí el test contra **la implementación que ya había elegido** (comparar con la
  env) en vez de contra **el contrato** ("el chainId JAMÁS sale del caller" — CD-9). Un test que sólo
  ejercita el input honesto no distingue entre "toma la env" y "toma el body y casualmente hoy no
  viene". Cubrir el caso feliz + el mutante obvio da una **falsa sensación de cobertura**.
- **Fix**: assert hostil dentro del MISMO test — el body jura `chainId: [43114, 43113, "43114", null]`
  y la atestación es de otra cadena ⇒ **403 igual**. Mata el mutante body-sourced. Batería final:
  **4 mutantes, 4 muertos** (borrado → 200≠403; body-sourced → 200≠403; `===` invertido → 5 tests;
  guard DESPUÉS del claim → `claimMock` llamado 6 veces ⇒ pinnea que un 403 **no quema** la atestación).
- **Aplicar en**: **todo guard que compara un valor firmado contra una fuente de verdad**: no alcanza
  con "distinto ⇒ 403". Hay que pinnear **DE DÓNDE sale el operando de referencia** mandando un campo
  homónimo hostil en el body. Si el test pasa igual con el operando tomado del caller, el guard es
  decorativo. Regla: **por cada guard, escribí el mutante fail-open (no sólo el mutante ausente) y
  exigí que muera.**
