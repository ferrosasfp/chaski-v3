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
 *   · Se crea una por viaje (las dos documentaciones lo recomiendan) y se BORRA al terminar.
 *   · Quien pudiera leerla necesitaría ejecutar código en nuestro origen, y con eso ya podría hacer
 *     cosas mucho peores que leer esto. No agrega superficie de ataque sobre el dinero.
 *
 * ⚠️ Lo que este párrafo decía y era FALSO: "perderla no pierde nada". Una revisión lo midió: para
 * fabricar una respuesta que este módulo aceptara NO hacía falta la clave SECRETA, alcanzaba con la
 * PÚBLICA de la app, que es un dato que viaja en la URL saliente y queda en el historial. El agujero
 * está cerrado para los pasos 2 y 3 fijando `claveBilletera` (ver `interpretarVuelta`), y en el paso
 * 1 sigue abierto por construcción del protocolo: en el primer contacto no hay nada contra qué
 * comparar. Perder el par obliga a reconectar, sí; pero perder la PÚBLICA le da a un tercero el paso
 * 1 entero, y eso hay que decirlo donde se lea la decisión, no en otro documento.
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
   * ninguna billetera firmó (medido en el AR de esta HU). Se fija acá en el paso 1 y se compara en
   * los pasos 2 y 3.
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
  | { tipo: "hay"; viaje: Viaje }
  | { tipo: "no-hay" }
  | { tipo: "vencido" };

export function guardarViaje(a: Almacen, v: Viaje): void {
  a.escribir(CLAVE, JSON.stringify(v));
}

export function terminarViaje(a: Almacen): void {
  a.borrar(CLAVE);
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

export function leerViaje(a: Almacen, ahora: number): LecturaDelViaje {
  const crudo = a.leer(CLAVE);
  if (!crudo) return { tipo: "no-hay" };
  let v: Viaje;
  try {
    v = JSON.parse(crudo) as Viaje;
  } catch {
    // Un JSON roto es basura, no un viaje vencido. Se limpia y se contesta "no hay": decirle
    // "venció" a alguien sería afirmar que existió algo que no sabemos si existió.
    a.borrar(CLAVE);
    return { tipo: "no-hay" };
  }
  // Se valida la forma mínima. Sin `secreta` no se puede abrir ningún sobre, así que ese viaje no
  // sirve para nada aunque esté fresco.
  //
  // 🔴 `Number.isFinite` y no `typeof === "number"` a secas: `JSON.parse('{"desde":1e999}')` produce
  // `Infinity`, cuyo `typeof` es `"number"`, y `ahora - Infinity > MAX_EDAD_MS` es `false` PARA
  // SIEMPRE. Medido: con eso el viaje contestaba `hay` diez años después. La ventana no es un
  // control de seguridad (DT-7), pero un viaje que no vence nunca no es una ventana.
  if (typeof v?.secreta !== "string" || !Number.isFinite(v?.desde)) {
    a.borrar(CLAVE);
    return { tipo: "no-hay" };
  }
  // 🔴 Y que `secreta` DECODIFIQUE, no sólo que sea un `string`. Este bloque decía "se valida la
  // forma mínima" y se quedaba a mitad: un `"!!!no-base58!!!"` pasaba el `typeof` y reventaba una
  // capa más arriba, en el `bs58.decode` de `interpretarVuelta`, con una excepción no capturada que
  // además NO caía en ninguna rama que limpiara — o sea que se repetía en CADA carga de la página.
  // Se trata como lo que es: basura en el disco. Se limpia y se contesta "no hay", igual que un JSON
  // roto. NO se agrega un cuarto valor a `LecturaDelViaje`: ese trío es CD-4.
  if (decodificarSecreta(v.secreta) === null) {
    a.borrar(CLAVE);
    return { tipo: "no-hay" };
  }
  if (ahora - v.desde > MAX_EDAD_MS) {
    a.borrar(CLAVE);
    return { tipo: "vencido" };
  }
  return { tipo: "hay", viaje: v };
}

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
   *   · "no-coincide" la URL trae una clave y no es la que fijó el connect.
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
  | { tipo: "conectado"; direccion: string; session: string }
  | { tipo: "tx-firmada"; transaccionBase58: string }
  | { tipo: "patrocinio-firmado"; firma: string }
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
 * conozca la pública de la app puede hacerse pasar por la billetera en el connect. Lo que sí hace
 * este código es que esa vuelta forjada CONSUMA el paso, de manera que la respuesta real que llegue
 * después salga como `ya-consumida` en vez de pisar en silencio lo que la app cree. Es un ruido, no
 * un arreglo. Cerrarlo de verdad pide que el connect se verifique contra algo que el atacante no
 * tenga, y eso no está en este módulo.
 *
 * ⚠️ Y NO CONVIERTE UN `rechazo` EN UN HECHO. El `errorCode` viaja SIN cifrar (así lo definen las dos
 * billeteras), así que un tercero puede provocar un `rechazo` con el código y el mensaje que quiera.
 * Por eso un `rechazo` NO consume el paso: si lo consumiera, alcanzaría una URL fabricada para
 * quemar un paso antes de que llegue la respuesta buena.
 *
 * `remesaEnCurso` es obligatorio y admite `null`, que significa "quien llama no tiene ninguna remesa
 * en contexto". No es opcional a propósito: un `?` acá haría que olvidarlo se vea igual que
 * decidirlo, y el cruce entre remesas es la primera línea de ataque de esta HU.
 */
export function interpretarVuelta(
  a: Almacen,
  params: URLSearchParams,
  lectura: LecturaDelViaje,
  remesaEnCurso: string | null,
): Vuelta {
  const marca = params.get(MARCA);
  if (marca !== "conectar" && marca !== "firmar-tx" && marca !== "firmar-patrocinio") {
    return { tipo: "no-volvimos" };
  }
  const paso: PasoDelViaje = marca;
  if (lectura.tipo === "vencido") return { tipo: "vencida", paso };
  if (lectura.tipo === "no-hay") return { tipo: "huerfana", paso };

  const { viaje } = lectura;
  const secreta = decodificarSecreta(viaje.secreta);
  // `leerViaje` ya lo garantiza; esto es por si alguien arma una `LecturaDelViaje` a mano. Se limpia
  // para que un disco inservible no repita el mismo camino en cada carga.
  if (secreta === null) {
    terminarViaje(a);
    return { tipo: "huerfana", paso };
  }

  if (remesaEnCurso !== null && viaje.remittanceId !== remesaEnCurso) {
    return {
      tipo: "otra-remesa",
      paso,
      delViaje: viaje.remittanceId ?? null,
      enCurso: remesaEnCurso,
    };
  }

  if (viaje.pasosConsumidos?.includes(paso)) return { tipo: "ya-consumida", paso };

  const claveEnLaUrl = clavePublicaEnRespuesta(viaje.billetera, params);
  if (paso !== "conectar" && claveEnLaUrl !== null && claveEnLaUrl !== viaje.claveBilletera) {
    return {
      tipo: "otra-clave",
      paso,
      motivo: viaje.claveBilletera === undefined ? "sin-fijar" : "no-coincide",
    };
  }

  /** Escribe el resultado del paso y lo marca consumido. Sólo se llama cuando el sobre ABRIÓ. */
  const consumir = (conseguido: Partial<Viaje>): void => {
    guardarViaje(a, {
      ...viaje,
      ...conseguido,
      pasosConsumidos: [...(viaje.pasosConsumidos ?? []), paso],
    });
  };

  if (paso === "conectar") {
    const d = leerRespuesta(viaje.billetera, params, secreta, soloTextos("public_key", "session"));
    return traducir(d, paso, (x) => {
      consumir({
        claveBilletera: claveEnLaUrl ?? undefined,
        direccion: x.public_key,
        session: x.session,
      });
      return { tipo: "conectado" as const, direccion: x.public_key, session: x.session };
    });
  }
  if (paso === "firmar-tx") {
    const d = leerRespuesta(viaje.billetera, params, secreta, soloTextos("transaction"));
    return traducir(d, paso, (x) => {
      consumir({ transaccionFirmada: x.transaction });
      return { tipo: "tx-firmada" as const, transaccionBase58: x.transaction };
    });
  }
  const d = leerRespuesta(viaje.billetera, params, secreta, soloTextos("signature"));
  return traducir(d, paso, (x) => {
    consumir({ firmaDePatrocinio: x.signature });
    return { tipo: "patrocinio-firmado" as const, firma: x.signature };
  });
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
