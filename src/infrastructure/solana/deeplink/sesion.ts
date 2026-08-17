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
import type { BilleteraDeeplink, Desenlace } from "./protocol";
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

const CLAVE = "chaski.billetera.viaje.v1";

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
 * LEER EL VIAJE TIENE TRES DESENLACES, y el tercero es el que siempre se pierde.
 *   · "hay"      hay un viaje vigente.
 *   · "no-hay"   nunca hubo, o ya se terminó y se limpió.
 *   · "vencido"  hubo uno, pero es viejo. NO es lo mismo que no haber: acá sí hay que decirle algo a
 *                la persona, porque probablemente esté esperando que su firma sirva para algo.
 */
export type LecturaDelViaje =
  /**
   * `secretaBytes` es la `secreta` YA decodificada. Va acá y no se recalcula más arriba para que no
   * exista ningún camino en el que un «hay» traiga una `secreta` que no sirve: antes esa garantía
   * era una frase en un comentario y `interpretarVuelta` tenía que volver a decodificar y a manejar
   * un `null` que `leerViaje` ya había descartado. La rama imposible se borró en vez de dejarla sin
   * test (era el mutante M7 del re-AR, vivo justo porque nadie podía llegar).
   */
  | { tipo: "hay"; viaje: Viaje; secretaBytes: Uint8Array }
  | { tipo: "no-hay" }
  | { tipo: "vencido" };

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
  // 🔴 `Number.isFinite` y no `typeof === "number"` a secas: `JSON.parse('{"desde":1e999}')` produce
  // `Infinity`, cuyo `typeof` es `"number"`, y `ahora - Infinity > MAX_EDAD_MS` es `false` PARA
  // SIEMPRE. Medido: con eso el viaje contestaba `hay` diez años después. La ventana no es un
  // control de seguridad (DT-7), pero un viaje que no vence nunca no es una ventana.
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
  // Se trata como lo que es: basura en el disco. Se limpia y se contesta "no hay", igual que un JSON
  // roto. NO se agrega un cuarto valor a `LecturaDelViaje`: ese trío es CD-4.
  const secretaBytes = decodificarSecreta(v.secreta);
  if (secretaBytes === null) {
    terminarViaje(a);
    return { tipo: "no-hay" };
  }
  // 🔴 UN VIAJE QUE EMPEZÓ EN EL FUTURO ES BASURA, NO UN VIAJE JOVEN. `ahora - desde` es negativo,
  // así que nunca supera `MAX_EDAD_MS`: un `desde` adelantado en X días hace que el viaje —y con él
  // `secreta`, `claveBilletera`, `direccion`, `session` y la ventana en la que el paso 1 se puede
  // forjar— viva X días más 20 minutos. Medido en el re-AR: `desde` +10 días contestaba «hay» diez
  // días después.
  //
  // El fix-pack anterior argumentó que no hacía falta porque "la ventana no es un control de
  // seguridad" (DT-7). Ese argumento dejó de valer cuando el paso 1 quedó declarado como residual:
  // hoy la ventana es la ÚNICA contención que le queda a esa forja en esta capa, así que una ventana
  // de duración arbitraria es un agujero. Con esta línea DT-7 vuelve a ser cierto.
  //
  // Lo que esta línea rompe, dicho: un reloj que se corrige HACIA ATRÁS mientras el viaje está en
  // curso mata ese viaje (`no-hay`, hay que volver a pedir). Se prefiere eso a sostener una ventana
  // cuya duración la elige quien haya movido el reloj.
  if (v.desde > ahora) {
    terminarViaje(a);
    return { tipo: "no-hay" };
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
   * La URL dice que volvimos de la billetera, pero en el disco no hay viaje.
   * Pasa de verdad: otro dispositivo, modo incógnito, alguien que compartió el enlace, o un viaje
   * que ya se cerró. Es lo único honesto que se puede decir, y NO es "cancelaste".
   */
  | { tipo: "huerfana"; paso: PasoDelViaje }
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
  | { tipo: "rechazo"; paso: PasoDelViaje; codigo: string; mensaje: string };

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
export function enlaceDeVuelta(origen: string, paso: PasoDelViaje): string {
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
  if (lectura.tipo === "no-hay") return { tipo: "huerfana", paso };
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
  if (d.tipo === "rechazo") return { tipo: "rechazo", paso, codigo: d.codigo, mensaje: d.mensaje };
  // "ninguno" con la marca puesta significa que la billetera nos mandó de vuelta SIN los parámetros
  // de respuesta. No es un rechazo declarado, pero tampoco es "no volvimos": volvimos con las manos
  // vacías. Se reporta como huérfana, que es lo único que se puede afirmar.
  if (d.tipo === "ninguno") return { tipo: "huerfana", paso };
  return ok(d.datos);
}
