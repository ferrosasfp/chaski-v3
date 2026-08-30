/**
 * OLA 2 · EL VIAJE A LA BILLETERA, QUE TIENE QUE SOBREVIVIR A QUE LA PÁGINA SE MUERA.
 *
 * 🔴 EL PROBLEMA, EN UNA FRASE: firmar por enlace profundo significa que el navegador **se va de esta
 * página**. No es un `await` largo: el proceso de la pestaña deja de existir. Todo lo que viva en
 * memoria —una promesa a medio resolver, un `useState`, un closure— se pierde. Lo único que vuelve es
 * lo que se escribió en disco y lo que viaja en la URL.
 *
 * 🧭 EL MECANISMO POR EL QUE ESTO PODRÍA SOBREVIVIR **[NO VERIFICADO]**: el `redirect_link` apunta a
 * NUESTRO propio origen, y `localStorage` es por origen. Si la billetera abre una pestaña nueva —lo
 * que se dice de web móvil, y **acá no lo prueba nadie**— esa pestaña sería del mismo origen y vería
 * el mismo disco. Las dos mitades de esa frase son afirmaciones sobre el runtime de un teléfono; el
 * work-item de esta HU (RIESGO-1) documenta además un caso donde NO se cumpliría: en iOS, una PWA
 * instalada puede no capturar el universal link y la vuelta caer en Safari, que es otro contexto.
 * Lo que sí se puede afirmar sin teléfono es el contraste de diseño: el navegador INTERNO de Phantom
 * es de arranque otro origen y otro disco, así que de ahí no vuelve nada y por eso hoy hay que
 * cargar la remesa de nuevo.
 *
 * El precedente de este repo es `KycPendingStore` (`../../../application/ports.ts:77`), que existe por
 * exactamente la misma razón: estado que cruza el redirect de Didit. Se sigue esa forma
 * (`guardar` / `leer` / `terminar`, datos planos) en vez de inventar otra.
 *
 * ⛔ DÓNDE **NO** VIVE ESTO, y es una decisión: no es un puerto de `application/ports.ts`. El viaje es
 * un detalle de implementación del adaptador de enlaces; la capa de aplicación no tiene que saber que
 * existe. Lo que sí va a subir a un puerto, en la ola 3, es la SUSPENSIÓN ("hay que salir"), porque
 * ésa sí es una decisión que el caso de uso tiene que tomar.
 *
 * ══ SOBRE GUARDAR UNA CLAVE SECRETA EN EL DISCO DEL NAVEGADOR ══════════════════════════════════════
 * Sí, `secreta` es una clave privada y sí, va a `localStorage`. Antes de que alguien lo lea como un
 * descuido:
 *   · NO controla fondos. Es una x25519 EFÍMERA que sólo cifra el canal entre esta pestaña y la app de
 *     la billetera. La clave que mueve dinero nunca sale de la billetera y este código no la ve nunca.
 *   · Se crea una por viaje (las dos documentaciones lo recomiendan).
 *   · Quien pudiera leerla necesitaría ejecutar código en nuestro origen, y con eso ya podría hacer
 *     cosas mucho peores que leer esto. No agrega superficie de ataque sobre el dinero.
 *
 * ⚠️ ACÁ DECÍA "y se BORRA al terminar", Y ERA FALSO. Lo midió una revisión: tras completar los tres
 * pasos con la billetera real, `leerViaje` seguía contestando `hay` y la `secreta` seguía en el
 * disco. `terminarViaje` sólo lo llama `leerViaje`, en sus ramas de basura y de vencimiento: NINGÚN
 * camino de éxito limpia nada. Lo que de verdad pasa es que un viaje terminado bien vive hasta que
 * `MAX_EDAD_MS` lo venza, con `secreta`, `claveBilletera`, `direccion`, `session` y los dos
 * resultados adentro. La frase importaba porque era la que sostenía esta decisión entera.
 *
 * Y no se arregló agregando el borrado, por dos razones medibles:
 *   · el disco ES el resultado. Borrar al consumir el paso 3 se llevaría `transaccionFirmada`, que
 *     es la firma del paso 2, y el que llama no la tiene en memoria: la página se murió en el salto,
 *     que es la razón de existir de este módulo. Sería destruir un dato del camino del dinero justo
 *     cuando hace falta.
 *   · este módulo no sabe cuándo terminó el que llama. El orden de DT-3 no lo verifica nadie acá (un
 *     paso 3 sobre un viaje que nunca firmó el paso 2 sale `patrocinio-firmado`), y el docblock de
 *     `otra-clave`/`sin-fijar` ya dice que afirmar ese orden sería inventar. "El tercer paso es el
 *     último" es la misma suposición sobre el flujo ajeno que el módulo se niega a hacer en todo lo
 *     demás.
 * 🔴 ASÍ QUE ES UN REQUISITO EXPLÍCITO DE LA OLA 3 (HU 062): cuando el caso de uso da el viaje por
 * cerrado —salió bien o se abandona— tiene que llamar a `terminarViaje`, que está exportado
 * justamente para eso. Si no lo hace, la clave privada y la sesión viven hasta 20 minutos de más. El
 * `it` `[LÍMITE DECLARADO]` de `sesion.test.ts` congela las dos mitades de este párrafo.
 *
 * ⚠️ Lo que este párrafo decía y era FALSO: "perderla no pierde nada". Una revisión lo midió: para
 * fabricar una respuesta que este módulo aceptara NO hacía falta la clave SECRETA, alcanzaba con la
 * PÚBLICA de la app, que es un dato que viaja en la URL saliente y queda en el historial. El agujero
 * está cerrado para los pasos 2 y 3 fijando `claveBilletera` (ver `interpretarVuelta`), y en el paso
 * 1 sigue abierto por construcción del protocolo: en el primer contacto no hay nada contra qué
 * comparar. Perder el par obliga a reconectar, sí; pero quien tenga la PÚBLICA y llegue antes que la
 * billetera real se queda con **el viaje entero** —su clave pasa a ser el ancla, los tres pasos le
 * pertenecen y la billetera real queda afuera—, y eso hay que decirlo donde se lea la decisión, no
 * en otro documento.
 */
import bs58 from "bs58";
import nacl from "tweetnacl";
import type { BilleteraDeeplink, CodigoNuestro, Desenlace } from "./protocol";
import {
  PARAMS_DE_RESPUESTA,
  clavePublicaEnRespuesta,
  leerRespuesta,
  soloTextos,
} from "./protocol";

/** La costura sobre `localStorage`. Existe para poder probar esto sin un navegador. */
export interface Almacen {
  leer(clave: string): string | null;
  escribir(clave: string, valor: string): void;
  borrar(clave: string): void;
}

/** El almacén real. Se construye con `window.localStorage` en el sitio de composición, no acá. */
export function almacenDeNavegador(storage: Storage): Almacen {
  return {
    leer: (k) => storage.getItem(k),
    escribir: (k, v) => storage.setItem(k, v),
    borrar: (k) => storage.removeItem(k),
  };
}

export const CLAVE = "chaski.billetera.viaje.v1"; // HU-066: SE EXPORTA, y el `export` entra EN ESTA LÍNEA y no con un docblock arriba porque esta línea está citada por número ((`CLAVE`, `conexion.ts:114`)) y un bloque nuevo la correría. POR QUÉ SE EXPORTA: la puerta del splash (`motivoParaNoMostrar`, `../../../presentation/splash-puerta.ts:84`) necesita saber si hay un viaje de billetera guardado —que es la condición REAL de la vuelta por enlace, no la marca en la URL— y copiar el literal allá habría dejado dos sitios de escritura del mismo string. ⛔ SIGUE SIENDO DE ESTE MÓDULO: nadie de afuera escribe en esta clave, sólo se lee para decidir si NO pintar una pantalla.

/**
 * Cuánto vale un viaje guardado. **20 minutos.**
 *
 * El número está acotado por arriba y por abajo, no elegido:
 *   · por ABAJO, tiene que aguantar que la persona salga a la app de la billetera, lea el mensaje de
 *     patrocinio y decida. Eso no son 30 segundos.
 *   · por ARRIBA, un viaje viejo que revive es peor que uno que no está: la cotización que le dio
 *     origen ya venció, y el escrow tiene su propia ventana de custodia. Retomar a las tres horas
 *     sería ofrecerle a alguien continuar algo que el resto del sistema ya dio por muerto.
 *
 * ⚠️ Esto NO es un control de seguridad y no hay que leerlo como tal: la billetera dice que sus
 * sesiones no vencen, y quien manda sobre el dinero son los guards del servidor y el propio programa
 * on-chain. Esto sólo evita que la pantalla retome un viaje que ya no tiene sentido.
 */
export const MAX_EDAD_MS = 20 * 60 * 1000;

/** Los tres momentos de un viaje. El orden importa: el patrocinio firma sobre la tx ya firmada. */
export type PasoDelViaje = "conectar" | "firmar-tx" | "firmar-patrocinio";

/**
 * Los tres nombres, en un solo lugar. Lo usan la marca de la URL (que la escribe cualquiera) y la
 * validación de lo que hay en el disco (que también lo escribe cualquiera con acceso al origen).
 * Comparaciones literales y no un `Set`, para que TypeScript estreche el tipo en el que llama.
 */
function esPaso(x: unknown): x is PasoDelViaje {
  return x === "conectar" || x === "firmar-tx" || x === "firmar-patrocinio";
}

/** Lo que se escribe en disco antes de saltar. */
export interface Viaje {
  billetera: BilleteraDeeplink;
  /** x25519 efímera de ESTA app, base58. Ver la nota de arriba sobre por qué esto está bien. */
  secreta: string;
  publica: string;
  /**
   * 🔴 LA CLAVE DE CIFRADO **DE LA BILLETERA**, base58, tal como la devolvió el connect. Ausente
   * hasta que el connect vuelve.
   *
   * No es cosmética ni informativa: es el único dato que distingue "contestó la billetera con la que
   * me conecté" de "contestó alguien que conoce mi clave pública". Sin ella, `interpretarVuelta`
   * derivaba el secreto compartido de la clave que venía EN LA URL, y una vuelta forjada por
   * cualquiera que hubiera visto la pública de la app devolvía `tx-firmada` con una transacción que
   * ninguna billetera firmó (medido en el AR de esta HU). Se fija en el paso 1 y se compara en los
   * tres.
   *
   * 🔒 ES DE UNA SOLA ESCRITURA. Una vez fijada, NINGÚN camino la cambia: un connect que llega
   * después con otra clave sale `otra-clave`/`no-coincide` y no escribe nada. No es cosmética: el
   * re-AR midió que sin esto un connect forjado TARDÍO revertía el ancla ya puesta y se quedaba con
   * los pasos 2 y 3 aunque la billetera real hubiera conectado primero. Con el ancla write-once,
   * ganar el paso 1 exige llegar ANTES que la billetera real, no en cualquier momento de la ventana.
   */
  claveBilletera?: string;
  /** Opaco, lo devuelve la billetera al conectar. Ausente hasta que el connect vuelve. */
  session?: string;
  /** La cuenta que la persona eligió en su billetera. Ausente hasta que el connect vuelve. */
  direccion?: string;
  /** Qué se fue a pedir en el salto que está en curso. */
  paso: PasoDelViaje;
  /**
   * Qué remesa. **Lo compara `interpretarVuelta` contra la remesa en curso** y una vuelta de otra
   * remesa sale como `otra-remesa`; no es un campo de sólo escritura.
   *
   * (Antes este comentario decía "sin esto, una vuelta podría aplicarse sobre otra" y NADIE lo leía:
   * el campo se guardaba y no se comparaba en ningún lado, así que prometía una protección que no
   * existía. Un `grep` del CR lo midió: 2 apariciones, las dos escrituras.)
   */
  remittanceId?: string;
  /**
   * Qué pasos ya se leyeron de una URL de vuelta y se dieron por buenos.
   *
   * La URL sobrevive al botón atrás, a la recarga y al historial, así que sin esta marca la misma
   * respuesta se anuncia todas las veces que alguien vuelva a esa página: medido, tres lecturas de
   * la misma URL daban tres `tx-firmada`, la tercera con el viaje YA avanzado. Sólo se marca cuando
   * el sobre ABRIÓ (ver `interpretarVuelta`), nunca con un `errorCode`, que no está autenticado y
   * dejaría que un tercero queme el paso antes de que llegue la respuesta real.
   *
   * ⚠️ LA MARCA ES POR NOMBRE DE PASO Y NO POR PEDIDO, y eso es una decisión con consecuencia, no un
   * detalle: **un viaje sirve para UN pedido de cada paso**. Una segunda firma legítima del mismo
   * paso —cotización refrescada, reintento después de un timeout— vuelve como `ya-consumida` y se
   * descarta. Quien necesite re-pedir una firma tiene que abrir un viaje NUEVO; la ola 3 no puede
   * suponer que reusar el viaje le va a funcionar.
   *
   * Se evaluó marcar por `nonce` (que sí distingue pedido de pedido) y NO se hizo, porque el `nonce`
   * sólo viaja en las respuestas que traen sobre: una URL con `errorCode` no tiene ninguno, así que
   * un paso YA completado dejaría de estar protegido contra un `?errorCode=` pegado a mano y se
   * cambiaría una molestia recuperable por un `rechazo` fabricable sobre algo ya firmado. La
   * molestia se prefiere al agujero, y además esta forma tiene techo 3: no crece con el uso.
   */
  pasosConsumidos?: PasoDelViaje[];
  /** Resultados ya conseguidos. Son lo que permite reanudar sin volver a pedir una firma. */
  transaccionFirmada?: string;
  firmaDePatrocinio?: string;
  /** Cuándo empezó. Milisegundos epoch. */
  desde: number;
}

/**
 * LEER EL VIAJE TIENE CUATRO DESENLACES, y los dos últimos son los que siempre se pierden.
 *   · "hay"          hay un viaje vigente.
 *   · "no-hay"       nunca hubo, o ya se terminó y se limpió.
 *   · "vencido"      hubo uno, pero es viejo. NO es lo mismo que no haber: acá sí hay que decirle algo
 *                    a la persona, porque probablemente esté esperando que su firma sirva para algo.
 *   · "no-fechable"  hay uno y su `desde` es POSTERIOR a `ahora`: este dispositivo no lo puede fechar.
 *                    ⛔ NO SE BORRA. Adentro puede estar la `transaccionFirmada` que la persona ya dio.
 */
export type LecturaDelViaje =
  /**
   * `secretaBytes` es la `secreta` YA decodificada. Va acá y no se recalcula más arriba para que no
   * exista ningún camino en el que un «hay» traiga una `secreta` que no sirve: antes esa garantía era
   * una frase en un comentario e `interpretarVuelta` tenía que volver a decodificar y a manejar un
   * `null` que `leerViaje` ya había descartado (era el mutante M7 del re-AR, vivo porque nadie llegaba).
   */
  | { tipo: "hay"; viaje: Viaje; secretaBytes: Uint8Array }
  | { tipo: "no-hay" } | { tipo: "vencido" } | { tipo: "no-fechable"; viaje: Viaje }; // 🔴 LOS TRES EN ESTA LÍNEA (Δ0: este archivo recibe [[CENSO src/infrastructure/solana/deeplink/sesion.ts entrantes-desde-222=30]] citas ANCLADAS de `:222` para abajo (acá decía «33» y este mismo commit lo volvió falso, porque las citas que faltaban las agregó él — AR-fp/BLQ-MED-3; el número lo publica ahora un marcador que `../../../composition/citas-ancladas.test.ts` deriva del árbol en cada `npm test`. ⚠️ Cuenta sólo las ANCLADAS: por el método de todas —`grep -rhoE 'sesion\.ts:[0-9]+'`— hoy son 35, y ESA es la cifra que manda para el Δ0, porque una cita suelta se rompe igual. El marcador vigila el piso, no el total) y una línea nueva las corre a todas). 🔴 EL CUARTO VALOR LLEVA EL `viaje` Y ⛔ NO LLEVA `secretaBytes`, y las dos mitades son deliberadas. Lleva el `viaje` para que `cortar` le pueda aplicar el MISMO `resultadoPreservable` que ya aplica, en vez de inventar una segunda regla de preservación — y preservar A CIEGAS no era opción, porque con un `desde` futuro `ahora - desde` es negativo y la ventana NO LIMPIA NUNCA, o sea que lo preservado a ciegas se quedaría para siempre. No lleva `secretaBytes` porque sin ella no se abre ningún sobre, y ésa es la garantía ESTRUCTURAL de que desde este estado el viaje no se puede usar: es el mismo razonamiento del docblock de «hay» de acá arriba, aplicado al revés. ⛔ Y NO COLAPSA con «no-hay» ni con «vencido»: los tres piden reacciones distintas y colapsarlos es el defecto que 061 midió.

/**
 * ⚠️ ESTA SÍ PUEDE TIRAR, Y ES DELIBERADO. `localStorage.setItem` lanza con la cuota llena y en el
 * modo privado de algunos navegadores. Acá se llama ANTES del salto a la billetera: si el viaje no
 * se pudo guardar, saltar sería mandar a la persona a firmar algo cuya vuelta este dispositivo no
 * va a poder reconocer (`huerfana` garantizada). Que el llamador se entere y no salte es el
 * comportamiento correcto; tragarse el error acá sería fabricar el viaje roto en silencio.
 *
 * Lo contrario vale para la escritura de `interpretarVuelta`, que ocurre DESPUÉS de la firma: ahí sí
 * hay algo que perder y por eso ahí no se tira (ver `Persistencia`).
 */
export function guardarViaje(a: Almacen, v: Viaje): void {
  a.escribir(CLAVE, JSON.stringify(v));
}

/**
 * Borra el viaje. NO tira: es la operación de limpieza, y un almacén que no deja borrar no le deja
 * al que llama ninguna decisión mejor que seguir.
 *
 * QUIÉN LA LLAMA HOY: sólo `leerViaje`, en sus ramas de basura y de vencimiento. **Ningún camino de
 * éxito la llama**, así que un viaje que salió bien queda en el disco hasta que la ventana lo venza.
 * No es un olvido: es la decisión del bloque de arriba sobre `secreta`, con sus dos razones. La
 * contraparte es que limpiar un viaje terminado es trabajo del que llama, y esta función exportada
 * es su herramienta.
 */
export function terminarViaje(a: Almacen): void {
  try {
    a.borrar(CLAVE);
  } catch {
    // Un disco que no deja borrar deja basura; decírselo a la persona no cambia nada de lo que
    // puede hacer, y la alternativa (tirar) rompería la lectura entera por una limpieza.
  }
}

/**
 * La `secreta` del disco pasada a bytes, o `null` si eso no se puede.
 *
 * Devuelve `null` en vez de tirar, que es la razón de existir de esta función: `bs58.decode` lanza
 * `Non-base58 character` con cualquier basura, y este módulo tiene escrito que una respuesta que no
 * se puede abrir es un desenlace del viaje y no un error de programación (`protocol.ts`,
 * `leerRespuesta`). Una x25519 son 32 bytes exactos: con cualquier otro largo no se abre ningún
 * sobre, así que el viaje tampoco sirve.
 */
function decodificarSecreta(secreta: string): Uint8Array | null {
  try {
    const bytes = bs58.decode(secreta);
    return bytes.length === nacl.box.secretKeyLength ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * QUÉ SE VALIDA DEL DISCO, Y POR QUÉ LA LISTA ES ÉSTA Y NO "LA FORMA MÍNIMA".
 *
 * Todo lo que sale de acá viene de `JSON.parse` sobre una cadena que escribe cualquiera que pueda
 * ejecutar en este origen (o que edite el disco a mano), así que el `as Viaje` no verifica nada. Se
 * valida **todo campo que después se use como algo más que un dato opaco**: los que se decodifican,
 * los que se comparan con un número y los que se recorren como estructura. Los campos que sólo se
 * copian o se devuelven (`direccion`, `session`, `remittanceId`, los resultados) no se validan acá a
 * propósito: quien los use es quien sabe qué forma necesita.
 *
 * `pasosConsumidos` está en esta lista porque el re-AR midió la falla exacta que ya había tenido
 * `secreta`: con `pasosConsumidos: 7` el `.includes(...)` tiraba `is not a function` **y el disco no
 * se limpiaba**, así que la excepción se repetía en cada carga de la página. Y con
 * `"firmar-tx-y-mas"` (un string) `.includes` contestaba `true` por SUBCADENA, o sea que un campo
 * basura podía consumir un paso que nadie consumió.
 */
function esListaDePasos(x: unknown): x is PasoDelViaje[] {
  return Array.isArray(x) && x.every(esPaso);
}

export function leerViaje(a: Almacen, ahora: number): LecturaDelViaje {
  let crudo: string | null;
  try {
    crudo = a.leer(CLAVE);
  } catch {
    // Un almacén que ni siquiera deja LEER (cookies bloqueadas, modo privado) no es un viaje
    // vencido: es que acá no hay nada que este dispositivo pueda recordar.
    return { tipo: "no-hay" };
  }
  if (!crudo) return { tipo: "no-hay" };
  let v: Viaje;
  try {
    v = JSON.parse(crudo) as Viaje;
  } catch {
    // Un JSON roto es basura, no un viaje vencido. Se limpia y se contesta "no hay": decirle
    // "venció" a alguien sería afirmar que existió algo que no sabemos si existió.
    terminarViaje(a);
    return { tipo: "no-hay" };
  }
  // Sin `secreta` no se puede abrir ningún sobre, así que ese viaje no sirve para nada aunque esté
  // fresco.
  //
  // 🔴 `Number.isFinite` y no `typeof === "number"` a secas: `JSON.parse` produce `Infinity` con
  // `1e999` y `-Infinity` con `-1e999`, y el `typeof` de los dos es `"number"`.
  //
  // ⚠️ ESTA LÍNEA ESTUVO SIN CANDADO Y HOY SÍ LO TIENE, y es un efecto lateral del arreglo del reloj,
  // no algo que se haya escrito a propósito. Acá decía que con el mutante `typeof v?.desde !== "number"`
  // el `+Infinity` «NO llega a depender de esta línea» porque lo mataba el guard de futuro: eso era
  // cierto cuando ese guard contestaba «no-hay» Y LIMPIABA. Hoy contesta «no-fechable» y ⛔ NO limpia,
  // así que un `+Infinity` sin esta validación sería basura PARA SIEMPRE. Con el mutante puesto, el `it` de `1e999` se pone rojo, y el de `-1e999` también. ⚠️ La medición vieja no era falsa cuando se escribió: envejeció sola al cambiar el guard de abajo, que es justo lo que un «MUTANTE QUE MATA» escrito en prosa no puede avisar.
  //
  // QUÉ SOSTIENE ESTA LÍNEA, DICHO SOBRE EL CÓDIGO DE HOY: `-Infinity` es el único valor que pasa el
  // guard de futuro (`-Infinity > ahora` es `false`) y llega a la resta, donde `ahora - (-Infinity)`
  // es `Infinity` y sale por la rama de la EDAD. O sea que sin esta validación un `desde` que no es
  // ningún instante se contesta **«vencido»** en vez de «no-hay»: se le afirma a la persona que hubo
  // un viaje suyo y que se le pasó el tiempo —que firmó al pedo— a partir de basura del disco. Es el
  // mismo criterio que el JSON roto. El candado es el `it` «un `desde` no finito NEGATIVO es basura».
  //
  // 🔴 `pasosConsumidos`: ver `esListaDePasos`. Un campo que se recorre se valida como estructura.
  if (
    typeof v?.secreta !== "string" ||
    !Number.isFinite(v?.desde) ||
    (v?.pasosConsumidos !== undefined && !esListaDePasos(v.pasosConsumidos))
  ) {
    terminarViaje(a);
    return { tipo: "no-hay" };
  }
  // 🔴 Y que `secreta` DECODIFIQUE, no sólo que sea un `string`. Este bloque decía "se valida la
  // forma mínima" y se quedaba a mitad: un `"!!!no-base58!!!"` pasaba el `typeof` y reventaba una
  // capa más arriba, en el `bs58.decode` de `interpretarVuelta`, con una excepción no capturada que
  // además NO caía en ninguna rama que limpiara — o sea que se repetía en CADA carga de la página.
  // Se trata como lo que es: basura en el disco. Se limpia y se contesta "no hay". ⚠️ ACÁ DECÍA «NO se
  // agrega un cuarto valor a `LecturaDelViaje`: ese trío es CD-4», Y HOY SON CUATRO. La corrección no es cosmética: CD-4 se escribió contra darle un valor propio a la BASURA, y sobre ESTA rama sigue mandando — una `secreta` que no decodifica se limpia y se contesta «no-hay», sin valor propio. El cuarto valor no es basura: es un viaje BUENO que este dispositivo no puede fechar, y por eso, al revés que esta rama, NO se borra.
  const secretaBytes = decodificarSecreta(v.secreta);
  if (secretaBytes === null) {
    terminarViaje(a);
    return { tipo: "no-hay" };
  }
  // 🔴 UN VIAJE QUE EMPEZÓ EN EL FUTURO NO SE PUEDE FECHAR, y por eso NO SALE POR «hay»: `ahora - desde`
  // es negativo y nunca supera `MAX_EDAD_MS`, así que un `desde` adelantado X días haría vivir el viaje
  // —y con él `secreta`, `claveBilletera`, `direccion`, `session` y la ventana en la que el paso 1 se
  // puede forjar— X días más 20 minutos. Medido en el re-AR: +10 días contestaba «hay» diez días después.
  // ⛔ Por eso el desenlace NO lleva `secretaBytes`: sin ella no se abre ningún sobre, o sea que desde
  // este estado el viaje es estructuralmente inusable. 🔴 Y ACÁ DECÍA ADEMÁS «Y LA VENTANA DE FORJA DEL PASO 1 NO SE AGRANDA», QUE ES UNA CONCLUSIÓN FALSA DEBAJO DE UNA DECISIÓN CORRECTA (AR-fp/BLQ-BAJO-2). MEDIDO en este árbol con una sonda secuencial sobre el MISMO almacén, `R = 10 días` y `W = MAX_EDAD_MS = 20 min`, sembrando `desde: AHORA + R` y leyendo con `ahora` creciente: `t = AHORA` ⇒ `no-fechable` con disco=true · `t = AHORA + R` ⇒ `hay` · `t = AHORA + R + W` ⇒ `hay` · `t = AHORA + R + W + 1` ⇒ `vencido` y disco=false. O sea que la residencia del viaje es `R + W`, SIN COTA EN `R`, y `R` lo elige quien mueve el reloj. La MISMA sonda con el comportamiento anterior (devolviéndole el `terminarViaje` a esta rama) da `disco=false` ya en la primera lectura y `no-hay` en las tres siguientes: la ventana posterior a un retroceso era 0 y ahora es `W`, o sea que ESTRICTAMENTE CRECE. Lo que sí sigue en pie es la mitigación, y es la primera mitad de este párrafo: sin `secretaBytes` no se abre ningún sobre, y el ancla `claveBilletera` es write-once (`claveBilletera`, `:148`), así que forjar el paso 1 sigue exigiendo llegar antes que la billetera real. ⚠️ Y §11 del addendum descartó la «marca de agua» EXACTAMENTE por esta propiedad —una residencia elegida por quien mueve el reloj—, y acotarla es algebraicamente la tolerancia que quedó fuera. ⛔ El diseño NO se cambia acá: lo que se corrige es la frase.
  //
  // 🔴 PERO ACÁ SE BORRABA EL DISCO, Y ESO ERA EL DEFECTO — no la clasificación. `Date.now()` es reloj
  // de PARED y PUEDE RETROCEDER (una corrección NTP en un teléfono que recupera señal), y la ventana
  // de daño no es un instante: `desde` nace en `iniciarConexion` y `consumir` lo conserva, así que este
  // `if` cubre el viaje ENTERO —hasta 20 minutos—, justo el rato en que la persona está en la billetera.
  // MEDIDO por el camino de producción `getAddress()`, 5/5 y con control negativo (retroceso 0 ⇒ la
  // cuenta sigue y el viaje sigue en disco): con 1 ms de retroceso el viaje se borraba con la
  // `transaccionFirmada` adentro. ⛔ Y no se arregla con una tolerancia: su tamaño dependería de la
  if (v.desde > ahora) {
    // distribución de saltos NTP, que nadie midió. ⛔ NO SE BORRA, y por eso el desenlace lleva el
    return { tipo: "no-fechable", viaje: v }; // `viaje`: quien decide qué se preserva es `resultadoPreservable`, el MISMO predicado que ya usa `cortar`.
  }
  if (ahora - v.desde > MAX_EDAD_MS) {
    terminarViaje(a);
    return { tipo: "vencido" };
  }
  return { tipo: "hay", viaje: v, secretaBytes };
}

/**
 * QUÉ PASÓ CON EL INTENTO DE RECORDAR EL RESULTADO EN EL DISCO, y por qué viaja pegado al resultado
 * en vez de tragarse.
 *
 * `localStorage.setItem` lanza con la cuota llena y en el modo privado de algunos navegadores. Esa
 * escritura ocurre DESPUÉS de que la persona firmó, así que dejarla tirar convertía una firma BUENA
 * en una excepción no capturada (medido en el re-AR: `THROW: QuotaExceededError` en vez de
 * `tx-firmada`). Tirar está descartado: el resultado ya existe y es lo valioso.
 *
 * Pero tragárselo también miente, y de la peor manera: si la marca de consumido no se escribió, la
 * MISMA URL vuelve a dar el mismo resultado en la próxima lectura, y el que llama no tiene forma de
 * distinguir "acaba de firmar" de "esto ya lo procesé" — que es exactamente el defecto que
 * `pasosConsumidos` vino a cerrar. Así que el desenlace lo dice:
 *   · "guardado"           **el `setItem` del resultado y de la marca no tiró.**
 *   · "no-se-pudo-guardar" el resultado es bueno igual, pero este dispositivo NO lo recuerda: no
 *                          sobrevive a una recarga y la misma URL va a volver a anunciarlo.
 *
 * ⚠️ "GUARDADO" ES EXACTAMENTE ESO Y NADA MÁS, y acá decía de más: decía "el resultado y la marca
 * quedaron en el disco, el anti-repetición vale". Eso el código no lo puede saber. Lo único que
 * observa es que la escritura no lanzó; que el valor SIGA ahí un instante después es otra
 * afirmación, y `localStorage` no da con qué sostenerla porque no tiene compare-and-swap. Medido con
 * dos pestañas intercaladas: una devolvió `"guardado"` y su escritura la pisó la otra —ni el
 * resultado ni la marca quedaron—, y de ese lado el paso volvió a ser re-jugable.
 *
 * Se deja el comportamiento como está (no hay con qué arreglarlo en esta capa) y se corrige la
 * promesa, que es la mitad que sí depende de nosotros: la advertencia de `interpretarVuelta` sobre
 * las dos pestañas y esta definición decían cosas incompatibles, y quien leyera sólo ésta se iba
 * tranquilo. El caso está congelado en el `it` `[LÍMITE DECLARADO]` de `sesion.test.ts`.
 *
 * El NOMBRE se deja: `"guardado"` / `"no-se-pudo-guardar"` es el par correcto para "el disco aceptó
 * la escritura" / "el disco la rechazó", que es la distinción que el llamador necesita tomar. Lo que
 * estaba mal no era la etiqueta sino la consecuencia que esta definición le colgaba.
 */
export type Persistencia = "guardado" | "no-se-pudo-guardar";

/**
 * QUÉ PASÓ CUANDO LA PERSONA VOLVIÓ.
 *
 * Combina dos fuentes que pueden contradecirse: lo que dice la URL y lo que hay en el disco. Cada
 * combinación imposible tiene su propio valor, y ninguno se disfraza de otro.
 */
export type Vuelta =
  /** En esta URL no hay ninguna respuesta. Alguien entró a la página de frente. NO es un rechazo. */
  | { tipo: "no-volvimos" }
  /**
   * Volvimos de la billetera y de acá no sale ningún resultado. Pasa de verdad: otro dispositivo,
   * modo incógnito, alguien que compartió el enlace, un viaje ya cerrado, o una billetera que nos
   * devolvió con las manos vacías. NO es "cancelaste".
   *
   * 🔴 EL `motivo` NO ES INFORMATIVO: ES LA DIFERENCIA ENTRE BORRAR UNA FIRMA Y NO BORRARLA. Acá
   * había UN solo valor y colapsaba dos estados que el módulo distingue perfectamente. Medido en el
   * CR de esta HU:
   *   disco VACÍO                              -> huerfana
   *   disco CON viaje + `transaccionFirmada`   -> huerfana   (idéntica; el llamador no podía separarlas)
   * Y el docblock decía "es lo único honesto que se puede decir", que era falso en el segundo caso:
   * ahí SÍ hay viaje y el módulo lo sabe. La consecuencia no es cosmética: un llamador de la ola 3
   * que reaccione a `huerfana` con "empezá de nuevo" + `terminarViaje` **destruye una transacción
   * que la persona ya firmó**, que es un dato del camino del dinero y que no está en memoria de
   * nadie porque la página se murió en el salto.
   *   · "sin-viaje"    en el disco no hay NADA que se pueda usar (nunca hubo, o era basura y se
   *                    limpió). Empezar de nuevo es la reacción correcta y no se pierde nada.
   *   · "manos-vacias" HAY viaje y de acá no sale ningún resultado: o esta URL no trae respuesta (o le
   *                    faltan parámetros), o el viaje NO SE PUEDE FECHAR (`no-fechable`, el reloj de pared
   *                    retrocedió). Puede tener resultados de pasos anteriores adentro. ⛔ NO limpiar sin leerlos. (Mismo patrón que `otra-clave`/`motivo`, por la misma razón: dos hechos distintos, dos valores.)
   */
  | { tipo: "huerfana"; paso: PasoDelViaje; motivo: "sin-viaje" | "manos-vacias" }
  /** Había viaje, pero ya no vale. La persona firmó al pedo y merece saberlo. */
  | { tipo: "vencida"; paso: PasoDelViaje }
  /**
   * Esta respuesta la cifró una clave que NO es la de la billetera con la que se conectó el viaje.
   *
   * 🔴 NO es `rechazo`: nadie canceló nada. NO es `huerfana`: sí hay viaje. NO es `sobre_ilegible`:
   * el sobre abre perfectamente, y ése es justo el problema. Es el cuarto valor que este módulo no
   * tenía y por eso una vuelta forjada salía como buena.
   *   · "no-coincide" la URL trae una clave y no es la que fijó el connect. **Aplica también al paso
   *                   1**: una vez que el ancla está puesta, ningún connect posterior la pisa (ver
   *                   `claveBilletera`).
   *   · "sin-fijar"   se está leyendo un paso 2 o 3 sobre un viaje que nunca completó el paso 1, así
   *                   que no hay contra qué comparar. Que el orden de DT-3 se respete no lo puede
   *                   afirmar nadie acá, y afirmarlo sería inventar.
   */
  | { tipo: "otra-clave"; paso: PasoDelViaje; motivo: "no-coincide" | "sin-fijar" }
  /**
   * Este paso ya se leyó y se dio por bueno antes. Es la MISMA URL otra vez: botón atrás, recarga,
   * historial, enlace pegado en un chat. No es que la persona haya firmado dos veces.
   */
  | { tipo: "ya-consumida"; paso: PasoDelViaje }
  /** El viaje guardado es de otra remesa que la que el llamador tiene en curso. */
  | { tipo: "otra-remesa"; paso: PasoDelViaje; delViaje: string | null; enCurso: string }
  | { tipo: "conectado"; direccion: string; session: string; persistencia: Persistencia }
  | { tipo: "tx-firmada"; transaccionBase58: string; persistencia: Persistencia }
  | { tipo: "patrocinio-firmado"; firma: string; persistencia: Persistencia }
  /**
   * Algo dijo que NO. El `origen` dice QUIÉN, y está partido en dos porque los dos códigos no salen
   * del mismo mundo (ver el docblock de `Desenlace` en `protocol.ts`, donde está la medición).
   *   · "billetera" el `codigo` salió de la URL, o sea de quien la haya escrito. `string` libre, NO
   *                 autenticado: este mismo archivo tiene escrito, más abajo, que un tercero puede
   *                 provocar un `rechazo` con el código y el mensaje que quiera. Es lo que se le
   *                 puede MOSTRAR a la persona ("cancelaste"), nunca lo que se usa para diagnosticar.
   *   · "nuestro"   lo escribió `leerRespuesta` mirando el sobre. Conjunto cerrado (`CodigoNuestro`).
   *                 Es un fallo de ESTE lado y a la persona no se le dice "cancelaste".
   * Sin esta separación, `?errorCode=sobre_ilegible` pegado a mano en la barra de direcciones y un
   * fallo real de cripto nuestro llegaban al llamador como el MISMO objeto (medido en el CR).
   */
  | { tipo: "rechazo"; paso: PasoDelViaje; origen: "billetera"; codigo: string; mensaje: string }
  | {
      tipo: "rechazo";
      paso: PasoDelViaje;
      origen: "nuestro";
      codigo: CodigoNuestro;
      mensaje: string;
    };

/** El parámetro con el que marcamos nuestras propias vueltas. */
export const MARCA = "dl";

/**
 * Arma el `redirect_link` de un paso. La marca es NUESTRA, no de la billetera.
 *
 * 🔴 Limpia primero los parámetros de respuesta que el origen ya trajera. El origen natural que va a
 * pasarle la ola 3 es `window.location.href`, o sea la URL en la que estamos parados — que después
 * del paso 1 YA CONTIENE una respuesta. Sin la limpieza, el `redirect_link` del paso 2 sale con el
 * `nonce`, el `data` y la clave del paso 1 adentro, y `URLSearchParams.get` devuelve el PRIMERO
 * (medido: `new URLSearchParams("nonce=VIEJO&nonce=NUEVO").get("nonce") === "VIEJO"`). Si la
 * billetera agrega o reemplaza sus parámetros es **[NO VERIFICADO]**, y por eso no se resuelve
 * suponiendo cuál de las dos cosas hace: limpiar es correcto en los dos casos.
 *
 * Lo que NO toca: cualquier otro parámetro del origen (`?kyc=return`, etc.) sigue viajando.
 */
export const MARCAS_DE_VUELTA = ["conectar", "firmar-tx", "firmar-patrocinio", "crear-nonce", "pop-payout", "pop-kyc"] as const; export function enlaceDeVuelta(origen: string, paso: (typeof MARCAS_DE_VUELTA)[number]): string { // WKH-075 — `MARCAS_DE_VUELTA` Y LA FIRMA, LOS DOS EN ESTA LÍNEA (Δ0: `:495` recibe 5 citas y hay 13 sitios más por debajo). El universo de marcas vivía SÓLO en el parámetro de esta función, y un TIPO no se puede recorrer en runtime: un test que las listara las copiaría a mano y sería una lista que envejece sola. Ahora es un VALOR, y eso es lo que permite RECORRERLAS en runtime en vez de copiarlas a mano. 🔴 ACÁ DECÍA «`tsc` ata las dos puntas: el tipo del parámetro se DERIVA de la tupla, así que agregar una marca acá y no darle consumidor es lo que `T-075-5` caza» Y ES FALSO (fix-pack · AR+CR/BLQ-4). EL INPUT QUE LA FALSEA, y está corrido: agregar un 7º elemento a esta tupla, líneo-neutro. RE-MEDIDO sobre el gate COMPLETO del repo (`npm run qa` = lint && typecheck && typecheck:scripts && test) el 2026-08-29, en el árbol del FIX-PACK del addendum del reloj (sobre `98ab4ae`), con `git add -A` antes y el índice igual al árbol: `biome lint` 0 errores / **137 warnings** (mismo baseline), `tsc --noEmit` 0, `tsc -p tsconfig.scripts.json --noEmit` 0, `vitest` 162 archivos / **3332 tests**, exit 0. 🔴 Y ESE VERDE VA CONDICIONADO, PORQUE SIN LA CONDICIÓN ES UNA CORRIDA AFORTUNADA LEÍDA COMO UN CANDADO (AR-fp/BLQ-MED-4): la suite arrastra un flake PREEXISTENTE —vive en `6bbd977`, es de contaminación entre `it` con trabajo en vuelo y está fuera del scope de esta HU— en (`PUERTA 2`, `../../../presentation/vuelta-por-enlace-carrera.test.tsx:279`). MEDIDO acá con 20 corridas AISLADAS del archivo, mismo comando: **3 rojos de 20** —`PUERTA 2` en dos (#8, #17) y `PUERTA 1` en una (#4), o sea que ⛔ NO ES SÓLO `PUERTA 2` y una cuarentena que marque sólo ésa deja el mecanismo vivo en la puerta de al lado—, más **3 corridas del gate COMPLETO, las tres en verde** ⇒ **3 de 23 ≈ 13 %** a nivel archivo y 2 de 23 ≈ 9 % en `PUERTA 2` sola; el AR midió por su lado 3 de 23 ≈ 13 % en `PUERTA 2` y **su corrida del gate salió ROJA**, que es el dato que hace falta para no leer tres verdes seguidos como un candado. ⛔ Por eso una sola corrida verde de este gate NO distingue «verde» de «tuve suerte», y quien lo cite tiene que decir CUÁNTAS corridas hizo. ⚠️ Y lo que NO está establecido, dicho como corresponde: que este árbol «no cerró» el flake está SOSTENIDO (sigue apareciendo); que «no lo empeoró» NO está establecido —2/20 contra 3/20 no tiene poder para decidir nada, y promediar corridas bajo carga con corridas aisladas mezcla dos condiciones con tasas opuestas y da un número que no reproduce—. La cuarentena está PROPUESTA y la decide el founder. ⚠️ ACÁ DECÍA «3305» Y EL ÁRBOL DABA OTRA COSA: 3309 en `6bbd977`, 3323 con los testigos del addendum y **3332** con los tres testigos que agregó este fix-pack. El conteo de `it` es una FOTO y se pudre solo cada vez que alguien agrega un test, así que no se apoya nada en él: lo que el experimento afirma es el EXIT y los tres ceros, que no dependen del número. Si volvés a citarlo, re-corré el gate. Ninguno de los tres puede cazarlo, y por motivos DISTINTOS: `T-075-5` sólo pide `length >= 6`, un `arrayContaining` de las seis, y después FILTRA a las tres del motor; y `tsc` no puede POR CONSTRUCCIÓN, porque agregar un valor ENSANCHA la unión del parámetro de `enlaceDeVuelta`, no la contradice. ⚠️ Y NO SE ESCRIBIÓ EL TEST QUE «SÍ LO CAZARÍA», a propósito: una marca nueva que ninguna rama reclame cae en el fallthrough de `flow.tsx:4070` y dispara `DEEPLINK_MARCA_SIN_CONSUMIDOR`, que es el COMPORTAMIENTO DISEÑADO y no un defecto — o sea que no hay nada que cazar. Lo que sí hay que hacer al agregar una marca es darle rama o aceptar la señal. ⛔ `esPaso` (`:121`) NO se toca, y el porqué está tres renglones más abajo en esta misma línea junto con la medición de que el `never` no es candado de esto. // WKH-358/AC-5 — EN ESTA LÍNEA (Δ0: este archivo recibe 4 citas ancladas). El salto que CREA la cuenta de nonce vuelve con su propia marca, y ⛔ ESA MARCA NO ES UN `PasoDelViaje` A PROPÓSITO: `esPaso` es un conjunto cerrado de tres, así que `interpretarVuelta` contesta `no-volvimos` y el motor no consume ni destruye nada si esta marca queda en la barra. El literal va escrito acá y no importado de `conexion.ts` para no invertir la dependencia (ese módulo importa a éste); quien lo ata es `tsc`, porque `MARCA_CREAR_NONCE` es un `const` de ese mismo literal y pasarlo acá no compilaría si divergieran WKH-359 — LAS DOS MARCAS DEL PoP ENTRAN ACÁ POR EL MISMO MOTIVO: ⛔ NO son `PasoDelViaje` y ⛔ NO se agregan a `esPaso` (`:121`), que sigue siendo un conjunto CERRADO de tres, así que `interpretarVuelta` (`:585`) contesta `no-volvimos` y el motor no consume ni destruye nada si una de estas marcas queda en la barra. 🔴 Y ACÁ VA UNA CORRECCIÓN DE MI PROPIA EVIDENCIA, que vale más que la regla: el Story File de esta HU decía que el candado era el `never` de (`nunca`, `./firma-por-enlace.ts:795`) —«si el cambio compila, la marca se coló»—. **LO CORRÍ Y ES FALSO**: agregué `"pop-payout"` a `PasoDelViaje` (`:114`) Y a `esPaso` (`:122`) y `tsc --noEmit` quedó VERDE, y la suite entera también. El motivo es estructural: ese `never` es exhaustividad sobre `Vuelta.tipo` (`:407`), y `PasoDelViaje` entra a esas variantes como CAMPO, no como discriminante ⇒ agregarle un valor no agrega ninguna variante que el `switch` tenga que ver. ⇒ EL ÚNICO CANDADO REAL ES `T-067-16` en `./sesion.test.ts`, que es de runtime, y por eso se escribió en la misma wave que esta línea y no más tarde. La razón propia de estas dos marcas sigue en pie: la prueba de posesión no mueve USDC ni consume un paso del viaje del depósito, así que un salto suyo que quede en la barra NO puede destruir el viaje en curso.
  const u = new URL(origen);
  for (const p of PARAMS_DE_RESPUESTA) u.searchParams.delete(p);
  u.searchParams.set(MARCA, paso);
  return u.toString();
}

/**
 * ⚠️ QUÉ DECIDE LA MARCA DE LA URL Y QUÉ NO, porque escribirla puede cualquiera. La marca sólo dice
 * QUÉ MIRAR. Quién decide es, en este orden: que el viaje sea de la remesa en curso, que ese paso no
 * se haya leído ya, que la respuesta venga de la clave que fijó el connect, y recién ahí que el
 * sobre abra.
 *
 * ⚠️ ESA FRASE ES UN ORDEN Y EL ORDEN NO LO FIJABA NADIE. Medido: intercambiar los dos primeros
 * guards dejaba la suite entera en verde, porque cada `it` violaba UN guard por vez y con una sola
 * violación cualquier orden da el mismo resultado. Hoy lo congela el `it` «el ORDEN de decisión que
 * el docblock declara es el que corre» (`T-VJ-8`), con un viaje que viola los tres a la vez. Si
 * reordenás estos guards, ese `it` se pone rojo y hay que cambiar ESTE párrafo con él.
 *
 * 🔴 LO QUE ESTE DOCBLOCK DECÍA Y ERA FALSO: *"Una URL fabricada a mano cae en `sobre_ilegible`. Lo
 * único que alguien puede lograr escribiendo la marca es que le contestemos huerfana."* No. El
 * secreto compartido se re-derivaba de la clave pública que venía EN LA URL, así que quien conociera
 * la clave PÚBLICA de la app —que viaja en la URL saliente, queda en el historial y está en el
 * disco— se fabricaba su propio par, derivaba el mismo secreto y cifraba lo que quisiera. Medido en
 * el AR de esta HU: una vuelta forjada devolvió `{ tipo: "tx-firmada", transaccionBase58:
 * "TX-QUE-NINGUNA-BILLETERA-FIRMO" }`. Lo que hace que el sobre abra no era conocer un secreto.
 *
 * ✅ QUÉ CAMBIÓ: en el paso 1 la clave de la billetera se FIJA en el viaje, y en los pasos 2 y 3 se
 * exige que la respuesta venga de esa misma clave (`otra-clave` si no).
 *
 * ⚠️ LO QUE SIGUE ABIERTO, y no se puede cerrar acá: **el paso 1 es falsificable por diseño del
 * protocolo**. Es el primer contacto: no hay ninguna clave previa contra qué comparar, así que quien
 * conozca la pública de la app puede hacerse pasar por la billetera en el connect.
 *
 * 🔴 Y NO ES "UN PASO": QUIEN GANA EL PASO 1 GANA EL VIAJE ENTERO. Su clave queda fijada como ancla,
 * así que los pasos 2 y 3 le pertenecen y la billetera REAL queda expulsada (`otra-clave` en cada
 * intento) hasta que venza la ventana. Una versión anterior de este comentario presentaba el
 * `ya-consumida` de la respuesta real como una mitigación: **es al revés**, es el mecanismo que fija
 * al atacante y bloquea al legítimo. Lo único que se acota acá es el ancla write-once (ver
 * `claveBilletera`), que obliga al atacante a llegar ANTES que la billetera real en vez de en
 * cualquier momento, y la ventana de `MAX_EDAD_MS`, que le pone un techo de 20 minutos.
 *
 * 🔴 EL CORTE TIENE QUE VENIR DE FUERA DEL CANAL DEL DEEPLINK. Todo lo que la app manda en el pedido
 * de connect viaja por la MISMA URL saliente que la clave pública de la app (mismo historial, mismos
 * servidores de la billetera), así que un token de un solo uso no cierra nada. Y verificar la firma
 * del paso 3 contra `viaje.direccion` TAMPOCO alcanza: el que forjó el connect también produce esa
 * firma, y verifica perfecto contra SU dirección. Una firma prueba control de una clave; no prueba
 * que esa clave sea la de la persona. Ver el `it` `[RESIDUAL, NO ARREGLADO]` de `sesion.test.ts`
 * para el escenario que la HU 062 tiene que descartar (sustitución de depositante).
 *
 * ⚠️ Y NO CONVIERTE UN `rechazo` EN UN HECHO. El `errorCode` viaja SIN cifrar (así lo definen las dos
 * billeteras), así que un tercero puede provocar un `rechazo` con el código y el mensaje que quiera.
 * Por eso un `rechazo` NO consume el paso: si lo consumiera, alcanzaría una URL fabricada para
 * quemar un paso antes de que llegue la respuesta buena.
 *
 * `remesaEnCurso` es obligatorio y admite `null`, que significa "quien llama no tiene ninguna remesa
 * en contexto". No es opcional a propósito: un `?` acá haría que olvidarlo se vea igual que
 * decidirlo, y el cruce entre remesas es la primera línea de ataque de esta HU.
 *
 * ══ POR QUÉ ESTA FUNCIÓN LEE EL DISCO Y NO RECIBE UNA `LecturaDelViaje` ═════════════════════════
 * Recibía la lectura, leía de ahí la marca de consumo y después escribía pisando el almacén entero.
 * Read-modify-write sobre un snapshot que elige el llamador, con tres consecuencias MEDIDAS por el
 * re-AR y ninguna que necesite un atacante:
 *   · reusar la misma `LecturaDelViaje` devolvía `tx-firmada` DOS VECES (y `next.config.mjs` tiene
 *     `reactStrictMode: true`, o sea que en desarrollo los efectos se invocan dos veces);
 *   · con dos pestañas, el disco pasaba de tener `transaccionFirmada` a NO tenerla: se perdía una
 *     firma que la persona ya había dado;
 *   · una lectura rancia procesaba un connect forjado y PISABA la `claveBilletera` ya fijada, con lo
 *     que el candado de los pasos 2 y 3 se deshacía.
 * Los 71 tests no lo veían porque todos re-leían el disco justo antes de llamar: la suite codificaba
 * un protocolo de uso que la API no obligaba, no documentaba y no verificaba.
 *
 * Ahora lee ella, en el momento en que actúa, y escribe a partir de eso. La lectura y la escritura
 * pasan en el mismo bloque SÍNCRONO —no hay ningún `await` en el medio— así que no existe ningún
 * punto en el que el llamador pueda tener un snapshot viejo: la clase entera de defecto desaparece
 * en vez de quedar documentada como disciplina.
 *
 * ⚠️ Lo que esto NO resuelve, y hay que decirlo: `localStorage` no tiene compare-and-swap, así que
 * dos PESTAÑAS que corran esto exactamente a la vez siguen sin tener una garantía formal de
 * atomicidad. Lo que se elimina es la ventana larga (la que dura lo que el llamador tarde entre
 * calcular la lectura y usarla), no la física del almacenamiento compartido, que este módulo no
 * controla. **[NO VERIFICADO]** cómo intercalan dos pestañas de un teléfono real.
 */
export function interpretarVuelta(
  a: Almacen,
  params: URLSearchParams,
  ahora: number,
  remesaEnCurso: string | null,
): Vuelta {
  const marca = params.get(MARCA);
  if (!esPaso(marca)) return { tipo: "no-volvimos" };
  const paso: PasoDelViaje = marca;

  // 🔴 SE LEE ACÁ, no se recibe. Ver el bloque del docblock sobre el read-modify-write.
  const lectura = leerViaje(a, ahora);
  if (lectura.tipo === "vencido") return { tipo: "vencida", paso };
  // `"sin-viaje"`: acá el disco NO tiene nada usable —nunca hubo, o había basura y `leerViaje` la
  // limpió—, así que no hay ningún resultado que se pueda perder. Es el único caso en el que
  // "empezá de nuevo" es una reacción sin costo. Ver `Vuelta`.
  if (lectura.tipo === "no-hay") return { tipo: "huerfana", paso, motivo: "sin-viaje" }; if (lectura.tipo === "no-fechable") return { tipo: "huerfana", paso, motivo: "manos-vacias" }; // 🔴 LAS DOS EN ESTA LÍNEA (Δ0). ⛔ EL MOTIVO DEL SEGUNDO NO ES `"sin-viaje"`, y no es un matiz: el docblock de ese motivo dice literalmente «no se pierde nada», y acá SÍ hay viaje en el disco y puede tener adentro la `transaccionFirmada` del paso 2. `"manos-vacias"` es el único motivo que los DOS consumidores tratan sin limpiar (el motor hace `break` y sigue a leer los resultados, `manos-vacias`, `./firma-por-enlace.ts:718`; el connect contesta `nada`, `manos-vacias`, `./conexion.ts:292`), que es exactamente lo que este arreglo necesita. ⚠️ Y ES ALCANZABLE POR EJECUCIÓN, no defensiva: por el motor no —su guard discrimina antes, `lectura`, `./firma-por-enlace.ts:685`— pero por el connect sí, que llama acá directo (`vuelta`, `./conexion.ts:273`).
  const { viaje, secretaBytes } = lectura;

  if (remesaEnCurso !== null && viaje.remittanceId !== remesaEnCurso) {
    return {
      tipo: "otra-remesa",
      paso,
      delViaje: viaje.remittanceId ?? null,
      enCurso: remesaEnCurso,
    };
  }

  if (viaje.pasosConsumidos?.includes(paso)) return { tipo: "ya-consumida", paso };

  // EL ANCLA. Se compara en los TRES pasos, con una sola asimetría: en el paso 1, y sólo si todavía
  // no hay ancla, no hay contra qué comparar y se deja pasar (es el residual declarado arriba). En
  // cuanto el ancla existe, mande la marca lo que mande, la respuesta tiene que venir de esa clave;
  // de ahí sale que sea de UNA SOLA ESCRITURA, porque el único camino que la escribe es el de abajo
  // y a él no se llega con otra clave.
  const claveEnLaUrl = clavePublicaEnRespuesta(viaje.billetera, params);
  if (claveEnLaUrl !== null) {
    if (viaje.claveBilletera !== undefined) {
      if (claveEnLaUrl !== viaje.claveBilletera) {
        return { tipo: "otra-clave", paso, motivo: "no-coincide" };
      }
    } else if (paso !== "conectar") {
      return { tipo: "otra-clave", paso, motivo: "sin-fijar" };
    }
  }

  /**
   * Escribe el resultado del paso y lo marca consumido. Sólo se llama cuando el sobre ABRIÓ.
   *
   * NO TIRA: acá la persona ya firmó. Un `setItem` que lanza (cuota llena, modo privado) no puede
   * convertir una firma buena en una excepción; se devuelve el resultado con `no-se-pudo-guardar`
   * para que el que llama sepa que el anti-repetición de este viaje no está vigente. Ver
   * `Persistencia`.
   */
  const consumir = (conseguido: Partial<Viaje>): Persistencia => {
    try {
      guardarViaje(a, {
        ...viaje,
        ...conseguido,
        pasosConsumidos: [...(viaje.pasosConsumidos ?? []), paso],
      });
      return "guardado";
    } catch {
      return "no-se-pudo-guardar";
    }
  };

  if (paso === "conectar") {
    const d = leerRespuesta(viaje.billetera, params, secretaBytes, soloTextos("public_key", "session"));
    return traducir(d, paso, (x) => ({
      tipo: "conectado" as const,
      direccion: x.public_key,
      session: x.session,
      // `claveEnLaUrl` no puede ser `null` acá: sin clave en la URL `leerRespuesta` habría dado
      // `ninguno`. Y si el ancla ya estaba puesta, el guard de arriba garantiza que es LA MISMA.
      persistencia: consumir({
        claveBilletera: claveEnLaUrl ?? undefined,
        direccion: x.public_key,
        session: x.session,
      }),
    }));
  }
  if (paso === "firmar-tx") {
    const d = leerRespuesta(viaje.billetera, params, secretaBytes, soloTextos("transaction"));
    return traducir(d, paso, (x) => ({
      tipo: "tx-firmada" as const,
      transaccionBase58: x.transaction,
      persistencia: consumir({ transaccionFirmada: x.transaction }),
    }));
  }
  const d = leerRespuesta(viaje.billetera, params, secretaBytes, soloTextos("signature"));
  return traducir(d, paso, (x) => ({
    tipo: "patrocinio-firmado" as const,
    firma: x.signature,
    persistencia: consumir({ firmaDePatrocinio: x.signature }),
  }));
}

/** Pasa un `Desenlace` del protocolo a un `Vuelta`, sin perder ninguno de los tres valores. */
function traducir<T>(d: Desenlace<T>, paso: PasoDelViaje, ok: (datos: T) => Vuelta): Vuelta {
  // El `switch` sobre `origen` y no un copiado suelto de `d.codigo`: los dos campos están
  // correlacionados (`"nuestro"` restringe el código a `CodigoNuestro`) y así es `tsc` el que impide
  // volver a fundir los dos espacios en un `string` único.
  if (d.tipo === "rechazo") {
    return d.origen === "billetera"
      ? { tipo: "rechazo", paso, origen: "billetera", codigo: d.codigo, mensaje: d.mensaje }
      : { tipo: "rechazo", paso, origen: "nuestro", codigo: d.codigo, mensaje: d.mensaje };
  }
  // "ninguno" con la marca puesta significa que la billetera nos mandó de vuelta SIN los parámetros
  // de respuesta. No es un rechazo declarado, pero tampoco es "no volvimos": volvimos con las manos
  // vacías.
  //
  // 🔴 `motivo: "manos-vacias"` Y NO `"sin-viaje"`: acá SÍ hay viaje en el disco —`interpretarVuelta`
  // ya pasó por `leerViaje` y por los tres guards para llegar hasta acá— y puede tener adentro la
  // `transaccionFirmada` del paso 2. Colapsar los dos motivos es exactamente lo que hacía que un
  // llamador razonable pudiera contestar "empezá de nuevo" y borrar esa firma. Ver `Vuelta`.
  if (d.tipo === "ninguno") return { tipo: "huerfana", paso, motivo: "manos-vacias" };
  return ok(d.datos);
}
