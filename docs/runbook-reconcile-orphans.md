# Runbook — el cron de reconciliación de huérfanas del ledger

> Escrito el 2026-08-19. Existe porque `POST /api/admin/reconcile-orphans` ya tenía sus tests y ya
> estaba configurado en producción, **y no lo invocaba nadie**: no había `vercel.json`, el único
> workflow del repo no tenía `schedule:`, ningún script de `package.json` mencionaba la ruta y no hay
> UI de administración. Ahora hay un `.github/workflows/reconcile-orphans.yml` que queda declarado
> para invocarla cada hora, y este documento dice qué hacer con cada rojo de ese workflow. ⛔ Este
> encabezado decía, hasta el 2026-08-27, que «ese workflow todavía no corrió ni una vez» y que había
> dos pre-requisitos pendientes: las dos cosas dejaron de ser ciertas el mismo 2026-08-19, unas horas
> después, y la sección de abajo ya lo había corregido mientras este párrafo seguía viejo. El estado
> se lee corriendo los comandos de esa sección, nunca acá.

## ✅ Estado al 2026-08-19 12:30 UTC: el cron CORRE, y su primera corrida encontró hallazgos reales

> ⚠️ **Esta sección decía, hasta las 11:46 UTC de hoy, «este cron TODAVÍA NO CORRIÓ NI UNA VEZ».**
> Era cierto cuando se escribió y dejó de serlo sin que nadie editara el archivo. Se deja anotado
> porque es exactamente el modo de falla que este repo persigue: **una medición correcta que envejece
> sola.**

Los cuatro pre-requisitos, **medidos hoy**, y las dos ramas del job **observadas en producción**:

| Pre-requisito | Estado medido al 2026-08-19 12:30 UTC | Con qué se midió |
|---|---|---|
| El workflow registrado en GitHub | ✅ **SÍ**, `state: active` | `gh api repos/ferrosasfp/chaski-v3/actions/workflows` |
| Una corrida con **`event: schedule`** — el único nivel que prueba el registro | ✅ **SÍ**: `2026-08-19T11:46:15Z` | `gh api …/workflows/reconcile-orphans.yml/runs` |
| El secreto en los Secrets de Actions | ✅ **SÍ**, cargado 11:51:35 UTC | `gh api …/actions/secrets` ⇒ `total_count=1` |
| El backlog real de `prepared` huérfanas | ✅ **MEDIDO**: `preparedOrphans.total=6`, `failed=0`, `manualReview=19` | la corrida de las 11:51 |

### Las dos ramas, observadas con 5 minutos de diferencia

**La corrida programada de las 11:46, ANTES de que existiera el secreto** — el fail-fast, en producción:

```
2. el endpoint responde 200 (transporte)  =>  FAILURE
3. sin hallazgos que revisar              =>  SKIPPED
   ::error secreto ausente (L1)
```

Cortó en el primer paso, **se saltó el resto y nunca tocó la red**, y la anotación trae el comando
exacto. Es el comportamiento que los tests medían tres veces; acá quedó observado sin que nadie lo
provocara.

**La corrida de las 11:51, con el secreto puesto** — la señal real:

```
2. el endpoint responde 200 (transporte)  =>  SUCCESS
3. sin hallazgos que revisar              =>  FAILURE
   preparedOrphans.total=6  failed=0  manualReview=19
```

⚠️ **A partir de acá el job va a estar ROJO cada hora hasta que alguien actúe sobre esas filas.** Es la
señal **pegajosa**, y es deliberado — ver más abajo por qué la decisión NO es bajarle el volumen.

**El primero se resuelve con el push**: en cuanto el `.yml` entre a `main`, GitHub registra el
`schedule:` y el workflow empieza a correr cada hora. Esa es la mitad fácil.

🔴 **El segundo no, y es lo único que hay que entender antes de seguir leyendo: hasta que exista el
secreto, el job falla en su primer paso sin llamar a la ruta.** El paso L1 arranca chequeando que
`RECONCILE_ADMIN_SECRET` no esté vacío, y con cero secrets cargados ese chequeo corta con `exit 1` y la
anotación `secreto ausente (L1)` **antes del `curl`** (medido: ese paso corrido con el secreto vacío
sale 1 sin tocar la red). O sea que durante esa ventana hay una corrida por hora, **todas rojas, y cero
reconciliación**. La reconciliación no empieza a existir hasta que se ejecute:

```bash
gh secret set RECONCILE_ADMIN_SECRET --repo ferrosasfp/chaski-v3   # EL MISMO VALOR que la env de Vercel
```

Y después, la única verificación que prueba el registro (una corrida cuyo evento sea `schedule`; ni el
`.yml` commiteado ni un `workflow_dispatch` verde cuentan):

```bash
gh run list --workflow=reconcile-orphans.yml --limit 5 --json event,conclusion,createdAt
```

⚠️ **Mientras alguna fila de esta tabla diga NO, cualquier frase en presente del resto del documento
—"corre", "llama", "se pone rojo"— describe lo que el workflow VA A HACER, no lo que está pasando.**
Si actualizás el estado, actualizá la fecha de este título.

## Antes que nada: acá sí hay un productor DECLARADO, pero su ausencia es invisible

A diferencia del runbook de alertas del ledger —donde nadie te avisa nada y el documento se ejecuta
cuando alguien decide mirar—, acá **sí queda declarado algo automático**: un workflow programado que,
con el schedule registrado y el secreto cargado, corre solo y se pone **rojo** cuando encuentra algo.
Esa es la parte buena. Lo que todavía no es cierto es el presente: **al 2026-08-19 no corrió ninguna
vez**, y con cero secrets cargados la primera corrida después del push va a morir en el chequeo de
secreto vacío, antes del `curl`. Los dos pre-requisitos están arriba, medidos.

⚠️ **La parte que no hay que leer de más:** lo que se pone rojo es **una corrida que ocurrió**. Si la
corrida **no ocurre**, no hay nada rojo que mirar. GitHub documenta que puede **retrasar o saltear**
un tick programado bajo carga, y que deshabilita un workflow programado tras 60 días sin actividad en
el repo. En los dos casos **no hay corrida, así que no hay señal**, y la pantalla de Actions se ve
igual que un día tranquilo.

**Esta HU no entrega heartbeat ni dead-man's-switch.** Está declarado, no disimulado. La única forma
de saber que el cron sigue vivo es mirar que haya corridas recientes:

```bash
gh run list --workflow=reconcile-orphans.yml --limit 10 --json event,conclusion,createdAt
```

Con la cadencia de hoy tendría que haber una corrida por hora. Si la última es de hace mucho más que
eso, el problema es el productor, no el ledger.

⚠️ Y si ese comando devuelve **HTTP 404** o una lista vacía, no es que el productor se cayó: es que
**todavía no se registró**, que es el estado medido al 2026-08-19. Eso se resuelve en la sección de
pre-requisitos, no acá.

## La cadencia

El `cron:` del workflow es **`23 * * * *`**: una vez por hora, en el minuto 23.

**Por qué horaria y no cada 15 minutos:** nada se degrada con la latencia. Lo que la mitad `prepared`
reporta ya es irreversible cuando entra al conjunto, y la mitad `stale` sólo pone una etiqueta para
que una persona mire fuera de banda; detectarlo a los 10 minutos o a los 60 no cambia ninguna acción
disponible. Y hay un costo real en ir más rápido: la señal L2 es **pegajosa** (ver abajo), así que
`*/15` produciría 96 rojos por día por el mismo hallazgo.

**Por qué el minuto 23 y no el 0:** el arranque de cada hora es un pico de carga en GitHub y es
cuando más se retrasan los `schedule`. Un minuto no redondo es la mitigación barata.

⚠️ Si cambiás el `cron:` del workflow, esta línea tiene que cambiar con él: hay un test que compara
las dos y se pone rojo si se despegan.

### 🔴 El `schedule` se retrasa, y hay que saber cuánto antes de diagnosticar nada

**Medido el 2026-08-19**: programado **11:23**, corrió **11:46:15** ⇒ **23 minutos de retraso**.

**Por qué esto va en el runbook y no en un comentario del `.yml`**: sin este dato, quien mire a los 5
minutos del horario ve **cero corridas** y concluye que el cron no está registrado. Ya pasó hoy: a las
11:30 la API devolvía `total_count=0` y **no había forma de distinguir «demora» de «registro roto»**
sin esperar. Es una hora de diagnóstico buscando un bug que no existe.

⚠️ **Y el dato incómodo**: la sección de arriba explica que se eligió el minuto 23 en vez del 0
*porque* el arranque de hora es el pico donde más se retrasan los `schedule`. **Se retrasó 23 minutos
igual.** La mitigación reduce el riesgo, **no lo elimina** — no la cuentes como garantía.

**Cómo diagnosticar bien**, en este orden:

1. **¿Está registrado?** `gh api repos/ferrosasfp/chaski-v3/actions/workflows` — si el `.yml` no
   aparece, no es demora: no está registrado, y lo que falta es el push a `main`.
2. **¿Hay alguna corrida?** `gh api …/workflows/reconcile-orphans.yml/runs`.
   ⚠️ **`gh run list` devuelve `HTTP 404` con exit code 0 si le llega un pipe** — leé el texto, no el
   código de salida.
3. **Recién si está registrado y no hay corridas después de ~40 minutos del horario**, tratalo como
   problema. Antes de eso, es demora.

## Las dos señales

| Capa | Nombre del paso | Qué la enciende | Qué prueba |
|---|---|---|---|
| **L1** | *el endpoint responde 200 (transporte)* | HTTP ≠ 200, un `curl` que no completa, el secreto vacío, o un destino que no es el host fijado | Que el endpoint es **alcanzable y autenticado** |
| **L2** | *sin hallazgos que revisar* | 200 con `preparedOrphans.total > 0`, `failed > 0` o `manualReview > 0` | Que hay algo que **una persona** tiene que mirar |

Son dos pasos con nombre propio y distinto justamente para que el rojo se lea de un vistazo: un rojo
de L1 es un problema de **plomería**; un rojo de L2 es un problema de **negocio**.

## Rojo de L1, código por código

### `secreto ausente` (falla antes del `curl`)

El secreto `RECONCILE_ADMIN_SECRET` no está cargado en los secrets de Actions de este repo. Es el
mensaje propio de ese caso, y existe para que el síntoma no sea un 401 confuso que mande a investigar
Vercel cuando el problema está en GitHub.

```bash
gh secret set RECONCILE_ADMIN_SECRET --repo ferrosasfp/chaski-v3   # con EL MISMO VALOR que Vercel
gh api repos/ferrosasfp/chaski-v3/actions/secrets --jq '.secrets[].name'   # devuelve el nombre, nunca el valor
```

### `destino no permitido` (falla antes del `curl`, y el secreto NO sale)

El paso arma la URL en una variable y compara **el esquema y el host** contra una lista blanca escrita
en el propio workflow **antes** de mandar el `curl`. Si no coinciden, corta con esta anotación y el
header `authorization: Bearer <el secreto de administración>` **no se envía a ningún lado**.

Que aparezca este rojo significa una de dos cosas:

- alguien **editó la URL** del workflow (un renglón) sin actualizar el `HOST_PERMITIDO` de al lado, o
- el **alias de producción cambió de verdad**.

Si es lo segundo, el cambio son **tres** ediciones coordinadas y a propósito: los dos renglones del
workflow (`HOST_PERMITIDO` y `RECONCILE_URL`) y **este runbook**, porque el candado de la suite cruza
el host del workflow contra el que aparece acá y se pone rojo si se despegan. El host de producción
vigente es `chaski-v2.vercel.app` (el proyecto de Vercel se llama `chaski-v2` y sirve el código de
chaski-v3; no es un typo).

⚠️ Este control es del `.yml`, **no del test**: no depende de que nadie corra la suite. Existe porque
mandar una credencial de administración a un dominio arbitrario es una edición de un solo renglón en un
repo público, y antes de esto la suite la aprobaba.

### `401`

🔴 **Mirá esto primero: el secreto de GitHub y el de Vercel no coinciden.** El valor vive en **dos**
stores, y rotar uno solo rompe el cron. Es la causa número uno de un 401 acá, y el 401 no lo dice:
dice "401". La otra causa posible es que el paso de cargar el secreto nunca se hizo.

Es un rojo, no un silencio — que es exactamente por qué la contrapartida de tener el valor duplicado
se aceptó.

### `501`

Dos causas, y hay que distinguirlas:

- la env `RECONCILE_ADMIN_SECRET` **desapareció de Vercel** (el endpoint es fail-closed: sin secreto
  configurado no es operable), o
- **el ledger está apagado**: `getSettlementLedger()` devolvió `null` porque falta el flag o las envs
  de Supabase.

El cuerpo distingue: `reconcile_not_configured` es la primera, `reconcile_not_enabled` es la segunda.

### `503`

La lectura de la DB falló. Lo importante para decidir: **el endpoint no mutó nada**. El barrido de
`prepared` es una lectura pura y va primero a propósito, así que si se cae se corta antes de escribir.
Reintentar el endpoint entero es seguro.

### `404`

La ruta desapareció del deploy de producción. Ojo con la conclusión: el cron pega al **alias de
producción**, no a `main` (ver "lo que este cron no mide", ítem 4).

### timeout

La función no contestó en 60 segundos. El paso tiene su propio `--max-time 60` y el job entero tiene
un `timeout-minutes: 5`.

El `--max-time 60` no es sólo una afirmación de este documento: el candado de la suite corre una **lista
blanca sobre los argumentos del `curl`**, así que borrarlo pone la suite roja (y agregarle una bandera
que no esté enumerada, también — `--trace-ascii` volcaba el cuerpo entero al log público).

Y desde el CR de WKH-328·B el **número** también está atado, no sólo la bandera: el candado **deriva el
valor del `.yml`** y exige que **este párrafo declare el mismo**, así que subir el techo sin tocar esta
línea pone la suite roja. Antes no era así, y se midió: cambiar el número pasaba en verde con esta frase
intacta, o sea que el documento quedaba desactualizado en silencio.

## Rojo de L2: qué significa cada contador

| Campo | Qué es | Qué hacer |
|---|---|---|
| `preparedOrphans.total` | Conteo **exacto** de filas `prepared` más viejas que el vencimiento de la atestación de depósito. No es el largo de la página | Es observabilidad pura: el endpoint **no las muta**. Hay que mirarlas a mano |
| `preparedOrphans.truncated` | **Booleano.** `true` = hay más filas de las que entran en la página, o sea que estás viendo un corte | Si es `true`, el `total` sigue siendo exacto; lo que está capado es el detalle |
| `manualReview` | Filas varadas que **esta corrida** acaba de etiquetar para revisión humana | Alguien tiene que resolverlas fuera de banda |
| `failed` | Filas cuyo etiquetado **tiró** al escribir | Un error transitorio de DB en una fila no aborta el batch. Si persiste entre corridas, es infra |
| `scanned` | Cuántas varadas miró la corrida | Contexto, no alarma por sí solo |

## Un rojo sin anotación: cómo se reconoce y qué hacer

⚠️ **Este job puede fallar sin decir por qué. Está medido y se declara acá porque no está cubierto.**

Cada corte que las dos capas **deciden** escribe primero su anotación `::error`, y hay un candado en la
suite que verifica esa dirección: toda anotación va seguida de un corte. **La dirección contraria no
está verificada por nada**: puede haber un corte sin ninguna anotación.

El caso concreto, medido: `jq -r` sobre un cuerpo que **no es JSON** —una página de error HTML de un
CDN devuelta con `200`, por ejemplo— sale con **código 5**. Con `set -euo pipefail`, ese 5 mata el paso
L2 en la primera de las cinco lecturas, **antes** de que la validación de forma llegue a correr, así
que el paso queda rojo **sin una sola línea `::error`** y ese rojo no aparece en ninguna tabla de este
runbook.

**Cómo se reconoce**: L1 en verde, L2 en rojo, en el log **ninguna línea `::error`** — y la corrida
**sin tabla de resumen**.

Esa última es la señal más rápida de las cuatro, y la única que se ve **antes** de abrir los logs: el
bloque que escribe la tabla de agregados en el resumen del job está **después** de las cinco lecturas del
cuerpo, así que un cuerpo que no es JSON mata el paso en la primera y el resumen **no llega a
escribirse**. Un rojo de L2 **con** tabla de resumen es otra cosa —hallazgos de verdad, o forma
inesperada— y ésos sí traen su línea `::error`. O sea: mirá primero si hay tabla; si no hay, es este
caso y no hace falta leer nada más.

**Qué hacer**: pegarle al endpoint a mano (ver "Cómo obtener los IDs a mano", abajo) y mirar el cuerpo.
Si no es JSON, el problema está entre el CDN y la función, no en el ledger, y no hay ninguna fila que
mirar todavía.

**Por qué queda declarado en vez de arreglado**: cerrarlo bien pide un `trap … ERR` en el workflow, y
esa línea contiene `::error` sin un corte detrás, así que choca de frente con el candado que verifica la
otra dirección. Arreglar las dos cosas a la vez es más que un renglón y quedó fuera de esta HU: la
decisión fue **escribirlo** —con la consecuencia operativa, que es este párrafo— en vez de improvisarlo.

### Cómo obtener los IDs a mano

🔴 **Los IDs de correlación no salen del log del workflow, y eso es a propósito.** Este repo es
**público**, y por lo tanto los logs de sus Actions también lo son. El endpoint devuelve
`remittanceId`, `quoteId` y `payoutId` de **remesas reales**; el comentario del código que justifica
devolverlos fue escrito para los logs de Vercel, que son **privados**. El workflow imprime sólo los
agregados.

Para ver el detalle, pegale al endpoint a mano desde una terminal privada:

```bash
export RECONCILE_ADMIN_SECRET='<el valor de la env de Vercel>'
curl -sS -X POST https://chaski-v2.vercel.app/api/admin/reconcile-orphans \
  -H "authorization: Bearer $RECONCILE_ADMIN_SECRET" | jq '.preparedOrphans'
```

⚠️ **Esa corrida MUTA**: las filas varadas pasan a revisión manual. Es idempotente respecto de las
corridas siguientes, porque una fila ya etiquetada deja de pertenecer al conjunto que el barrido
elige.

⚠️ El proyecto de Vercel se llama `chaski-v2` y sirve el código de chaski-v3. No es un typo.

## La primera corrida puede nacer roja, y eso es esperable

Si al momento de encender el cron hay backlog acumulado, `preparedOrphans.total` va a ser mayor que
cero y **la corrida número uno va a ser roja**. Eso **no es una alarma nueva**: es el estado que ya
existía, visible por primera vez.

🔴 **Y va a seguir roja hasta que una persona actúe sobre las filas.** La señal L2 es **pegajosa**:
una fila `prepared` no sale de `prepared` sola, porque nada en el endpoint la muta — es sólo
visibilidad, cero mutación. Una vez encendida, se queda encendida.

Es lo correcto (un hallazgo no se auto-cura en silencio) y es **el mayor riesgo operativo de este
cron**: un job crónicamente rojo entrena a ignorarlo, y ahí **L1 deja de verse**. Si el rojo de L2 se
vuelve permanente, la decisión no es bajarle el volumen: es limpiar el backlog o dejar escrito acá
por qué se convive con él, con fecha.

## Lo que este cron **NO** mide — los 7 ítems

1. 🔴 **La ausencia de corridas es invisible.** Si GitHub retrasa o **saltea** un tick programado
   (comportamiento documentado bajo carga), o deshabilita el workflow por 60 días sin actividad en el
   repo, **nada se pone rojo**: no hay corrida, no hay señal. **Esta HU no entrega heartbeat ni
   dead-man's-switch.** Mitigante parcial y medido: el repo tiene pushes diarios, así que el reloj de
   los 60 días nunca se acerca, y GitHub avisa por mail antes de deshabilitar. **El salteo bajo carga
   no está cubierto por nada.**
2. **Un verde no dice que el ledger esté sano.** Dice que **dos `SELECT` contestaron**. No dice nada
   de las **escrituras**, ni del webhook de TransFi, ni del proveedor.
3. **`total: 0` no dice que no se perdió plata.** `prepared` significa *"no hay depósito
   REGISTRADO"*, no *"no hubo depósito"*. Y no certifica **nada** sobre las filas en los otros cinco
   estados.
4. **No mide el código de `main`.** El cron pega al alias de producción, y el webhook GitHub→Vercel
   está muerto ⇒ producción es lo último desplegado **a mano**, que puede estar detrás de `main`.
   **Un verde del cron no es un verde de `main`.**
5. **No cierra el circuito de `manual_review`.** El endpoint etiqueta filas para que una persona las
   mire; **nada verifica que alguien las mire**.
6. **No cancela nada del lado de TransFi.** Explícitamente fuera del endpoint y de esta HU.
7. **El candado de la suite verifica el TEXTO del `.yml`, no que GitHub lo haya inscrito.** Que el
   archivo exista y esté commiteado es la **intención**; que el schedule quede **registrado** es otra
   cosa.

## Cómo se verifica que el cron quedó registrado — tres niveles, y sólo uno prueba

⚠️ Se confunden todo el tiempo. **Ni el archivo commiteado ni una corrida manual verde prueban que el
schedule esté registrado.**

| Nivel | Qué prueba | Instrumento | Qué **NO** prueba |
|---|---|---|---|
| **N1 — intención** | El archivo existe y está versionado | `ls -l .github/workflows/reconcile-orphans.yml` | **Nada** sobre GitHub. Un `.yml` en disco es un texto |
| **N2 — inscripción** | GitHub parseó el archivo y registró el workflow | `gh api repos/ferrosasfp/chaski-v3/actions/workflows --jq '.workflows[] \| "\(.path) \| \(.state)"'` ⇒ `state: active` | Que el **schedule** vaya a disparar: un workflow con sólo `workflow_dispatch` también sale `active` |
| **N3 — el schedule disparó** | Existe una corrida cuyo **evento es `schedule`** | `gh run list --workflow=reconcile-orphans.yml --limit 10 --json event,conclusion,createdAt` | Nada más. **Es el único nivel que prueba el registro** |

Lo que **no** cuenta: que el `.yml` esté pusheado (eso es N1); que `gh workflow run` dé verde (eso
prueba el **cuerpo del job**, y la corrida queda con `"event":"workflow_dispatch"`); que el endpoint
devuelva 200 (eso prueba el endpoint, no el productor).

**Ventana:** el primer tick cae dentro de la hora siguiente al push, más el retraso de GitHub. **Si a
las 2 horas no hay ninguna corrida con `event: schedule`, el registro falló** y hay que investigar —
no dar por bueno el N2.

## Lo que este runbook no cubre

- **No cubre qué hacer con cada fila** una vez identificada. Eso depende del estado en cadena y del
  proveedor, y el procedimiento de inspección on-chain vive en `docs/runbook-alertas-ledger.md`.
- **No hay automatización de la resolución.** El cron **detecta y etiqueta**; resolver lo hace una
  persona.
- **No cubre el caso del depósito sin fila.** Un depósito que nunca dejó fila en el ledger es un
  problema distinto, y este barrido no puede verlo: sólo mira filas que existen.
