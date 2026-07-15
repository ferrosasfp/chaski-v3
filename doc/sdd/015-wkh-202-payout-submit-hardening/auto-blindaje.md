# Auto-Blindaje — WKH-202

### [2026-07-15] F2/F2.5 — AC-6 dice "7 tests existentes"; el archivo tiene 8 (desviación de artefacto)
- **Error**: `work-item.md:109` y `story-WKH-202.md:44,360` afirman que `app/api/a2a/payout/submit/route.test.ts`
  tiene **7** tests preexistentes (los de WKH-186) y que AC-6 se valida sobre esos 7. El archivo real
  tiene **8**: `it()` en L63, 73, 91, 99, 107, 120, 131, 140. El desvío existía sólo como un mensaje
  de chat mío durante F3; AR y CR lo confirmaron de forma independiente, pero seguía sin quedar
  escrito en ningún artefacto → F4/QA iba a leer AC-6 literal ("los 7 tests") contra un archivo con
  8 y marcarlo como falla, sin poder distinguir "el Dev rompió/agregó un test" de "el artefacto
  contó mal".
- **Causa raíz**: F2 contó los tests del archivo a ojo (probablemente omitiendo uno de los tres
  `MNR-C:` de L107/120/131, que son variaciones del mismo caso y se leen como un bloque) y F2.5
  propagó el número a AC-6 sin re-contar contra el archivo. El número "7" nunca fue verificado con
  `grep -c "it("` ni contra el output de vitest.
- **Fix**: NO se tocó el test-file para "hacer que cierre 7" — eso habría violado CD-6 (asserts
  byte-idénticos). Se documenta la desviación acá:
  - **Artefacto dice**: 7 preexistentes.
  - **Realidad**: 8 preexistentes, los 8 con asserts **byte-idénticos** al pre-HU (verificado por AR
    y CR). Lo único que se les tocó es SETUP (el `beforeEach` con `stubEnv`, y `address: "0xSender"`
    en el fixture `validPayload`), permitido explícitamente por CD-6.
  - **Los totales cierran igual**: el error es de conteo del artefacto, no de la implementación.
    - Archivo: 8 preexistentes + 6 nuevos de WKH-202 = **14** (coincide con el reporte de vitest:
      `app/api/a2a/payout/submit/route.test.ts (14 tests)`).
    - Suite: 275 pre-HU + 6 nuevos + 1 del fix de WKH-198 = **282** (baseline verde de F3/AR/CR).
  - **Post fix-pack**: 282 + 4 (`it.each` de BLQ-BAJO-1, 1 caso por body no-record) + 1 (MNR-4
    forward real) = **287**; en el archivo 14 + 5 = **19**.
- **Aplicar en**: cualquier AC que cuantifique artefactos existentes ("los N tests", "las N rutas").
  El número se verifica con un comando (`grep -c`, el output del runner) ANTES de escribirlo en el
  work-item, y se re-verifica en F2.5. Si en F3 el conteo real difiere del artefacto: documentar acá
  en el momento, NO en el chat — el chat no lo lee F4.

### [2026-07-15] Wave 1 — Body JSON literal `null` → 500 crudo (BLQ-BAJO-1 del AR)
- **Error**: en `app/api/a2a/payout/submit/route.ts` escribí el parseo del body como
  `const body = (await req.json().catch(() => ({}))) as {...}`, asumiendo que el `.catch()` cubría
  todo body no-usable. Con `curl -d 'null'` la route respondía **500 crudo** con un `TypeError:
  Cannot read properties of null (reading 'kycVerificationId')`, violando AC-1 ("SHALL responder con
  un código de error (4xx)") y el contrato de la cabecera del propio archivo ("TODO en try/catch:
  nunca 500 crudo").
- **Causa raíz**: `req.json()` sobre el body `null` **resuelve** con el valor `null` — es JSON
  perfectamente válido, NO un parse error → el `.catch()` nunca dispara. El cast `as {...}` es
  puramente de tipos: le mintió a `tsc` diciendo que `body` era un objeto y desactivó la única
  señal que hubiera cazado esto en compile-time. Y el acceso al campo estaba **fuera** del `try`
  (que abría recién en el forward, `route.ts:94`) → excepción no capturada → Next devuelve 500.
  Fail-closed (ni Didit ni el agente se invocan, verificado por el AR), pero cualquiera lo dispara
  con un curl → ruido de excepciones no capturadas en los logs del money-path.
  El helper `isRecord()` ya existía en el archivo (`route.ts:21-23`) y lo estaba usando para validar
  el result del AGENTE, pero no para el body del CALLER — validé el borde de confianza de salida y
  no el de entrada.
- **Fix**: `const parsed: unknown = await req.json().catch(() => null);` +
  `const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};`. Tipar el parseo como
  `unknown` (en vez del cast mentiroso) obliga a estrechar antes de leer; `isRecord()` cubre `null`
  y los no-objeto por igual → todos caen en el guard de formato existente → 400
  `payout_invalid_request`. La normalización a `{}` NUNCA altera el forward (CD-10, body forwardeado
  tal cual): un body no-record no tiene `kycVerificationId`/`address` → 400 antes de cualquier fetch.
  Cubierto con un `it.each` de los 4 body no-record (`null`, `[]`, `123`, `"str"`) → 400 + `fetch`
  nunca invocado.
- **Aplicar en**:
  - **`app/api/payout/validate/route.ts:12-17` tiene el MISMO bug** (`req.json().catch(() => ({}))`,
    heredado de WKH-180) y está **LIVE en prod**. NO se tocó en esta HU: CD-10 prohíbe cambiar el
    comportamiento observable de una ruta live. Registrado como follow-up aparte.
  - Regla general para todo `app/api/**/route.ts`: `await req.json()` devuelve `unknown`, no un
    objeto. `.catch(() => ({}))` NO cubre `null` (ni `[]`/`123`/`"str"`). Parsear a `unknown` +
    estrechar con `isRecord()` antes de leer campos, y hacerlo **dentro** del `try` o antes de
    cualquier acceso.
  - Olor a buscar en CR: un `as {...}` sobre el retorno de `req.json()`. El cast apaga a `tsc`
    justo donde el input es hostil; si hay un `isRecord()`/type-guard en el archivo, tiene que
    aplicarse al body del caller, no sólo a las respuestas upstream.

### [2026-07-15] F3 — Trampa del `git stash` sobre una HU unstaged (cambios sin commit)
- **Error**: en un repo con cambios unstaged (sin ningún commit de la HU), dos agentes usaron `git stash` para revertir un cambio específico. El resultado: `git stash` **revierte al HEAD** de la rama, no a "la versión pre-HU". En un repo donde TODO es unstaged (changeset pre-commit), no hay "intermedio" — o todo, o nada. El dev intentó after-the-fact reproducir "el estado antes del fix" para verificar que el fix era necesario; con `git stash` obtuvo la versión pre-HU, no la versión del dev antes del fix.
- **Causa raíz**: `git stash` es una maquinaria de commits ocultos bajo el capó. Si no hay commits visibles, tira del HEAD. La alternativa correcta: revertir **sólo las líneas** que cambiaron (manual, o aislar la semántica en un test/script standalone que no toque el file).
- **Aplicar en**: cuando estés en F3/fix-pack sobre una HU unstaged (TODO cambios bajo HEAD), NUNCA uses `git stash` para reproducir un estado intermedio. Usa `git show HEAD:ruta/al/archivo` para extraer la versión de `HEAD`, o refactoriza la lógica en un helper que puedas togglear con flags.

### [2026-07-15] F3/F4 — `git diff` de un archivo modificado (unstaged) vs. untracked retorna vacío
- **Error**: al verificar que `/api/payout/validate/route.ts` estaba **byte-idéntico** (CD-10 exige que una extracción no cambie comportamiento observable), un agente hizo `git diff app/api/payout/validate/route.ts` — resultado: vacío. El archivo **no estaba en el stage**, pero tampoco era **untracked** — los cambios estaban ahí, pero `git diff` **sin argumentos ni contexto** no los capturó porque el diff de un archivo modificado (en working tree) requiere estar staged o se le pasa explícitamente el path. Verés que el error fue silencioso: sin `?? ` de untracked, sin `M ` de staged, el arquivo parecía "sin cambios".
- **Solución aplicada por re-AR**: diff **solo las líneas ejecutables** contra `git show HEAD:app/api/payout/validate/route.ts` (la referencia real del pre-HU). `git diff <ref>:file` tira el archivo en el momento del commit, sin depender de si está staged o no.
- **Regla**: para verificar que un archivo criticidad está intacto: `git diff HEAD -- archivo` (staged + unstaged), o mejor aún, `git diff HEAD:archivo archivo` (diff literal del HEAD contra el working file). Never confiar en el estado staging/untracked para auditoría de cambios críticos.

### [2026-07-15] Patrón recurrente: contar artefactos leyendo vs. ejecutando (lección trans-HU)
- **Observación**: WKH-202 replicó la desviación de WKH-198 y WKH-201 en que los artefactos (work-item, sdd, story-file) contaron **incorrectamente** números de elementos preexistentes:
  - WKH-198: "5 niveles de import" vs. la realidad de 4 (F2 extrapoló sin contar explícitamente)
  - WKH-201: "7 tests" vs. la realidad de 8 (F2 contó a ojo, omitiendo uno de tres MNR-C casi idénticos)
  - WKH-202: misma trampa, mismo error metodológico
- **Patrón**: Los agentes que **verificaron ejecutando** (`npm run test`, `grep -c '^\s*it('`, `git diff -U0 | grep expect`) acertaron siempre. Los que contaron **leyendo manualmente** (chat, salida truncada, ojos), fallaron.
- **Regla para futuras HUs**: números en ACs = comandos verificables, nunca manual. Ejemplos:
  - "preservar los N tests preexistentes" → `grep -c "^  it(" ruta/archivo`
  - "los M archivos modificados" → `git diff --name-only | wc -l`
  - "L líneas agregadas" → `git diff --stat | tail -1` (o `+N,-M`)
- **Aplicar en F2**: cuando escribas AC-6 o AC-7 con números, deja un comentario inline con el comando que los verifica, para que F3/F4 puedan re-ejecutar sin ambigüedad.
