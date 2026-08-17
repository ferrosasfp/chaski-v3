/**
 * OLA 2 · EL VIAJE A LA BILLETERA, QUE TIENE QUE SOBREVIVIR A QUE LA PÁGINA SE MUERA.
 *
 * 🔴 EL PROBLEMA, EN UNA FRASE: firmar por enlace profundo significa que el navegador **se va de esta
 * página**. No es un `await` largo: el proceso de la pestaña deja de existir. Todo lo que viva en
 * memoria —una promesa a medio resolver, un `useState`, un closure— se pierde. Lo único que vuelve es
 * lo que se escribió en disco y lo que viaja en la URL.
 *
 * ✅ Y POR QUÉ ESO ACÁ SÍ FUNCIONA: el `redirect_link` apunta a NUESTRO propio origen. Aunque la
 * billetera abra una pestaña nueva —en web móvil lo hace—, esa pestaña es del mismo origen y ve el
 * mismo `localStorage`. Es la diferencia de fondo con mandar a la persona al navegador INTERNO de
 * Phantom, que es otro origen y otro disco: de ahí no vuelve nada, y por eso hoy hay que cargar la
 * remesa de nuevo.
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
 *   · Perderla no pierde nada: obliga a volver a conectar.
 *   · Se crea una por viaje (las dos documentaciones lo recomiendan) y se BORRA al terminar.
 *   · Quien pudiera leerla necesitaría ejecutar código en nuestro origen, y con eso ya podría hacer
 *     cosas mucho peores que leer esto. No agrega superficie de ataque sobre el dinero.
 */
import bs58 from "bs58";
import type { BilleteraDeeplink, Desenlace } from "./protocol";
import { leerRespuesta } from "./protocol";

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
  /** Opaco, lo devuelve la billetera al conectar. Ausente hasta que el connect vuelve. */
  session?: string;
  /** La cuenta que la persona eligió en su billetera. Ausente hasta que el connect vuelve. */
  direccion?: string;
  /** Qué se fue a pedir en el salto que está en curso. */
  paso: PasoDelViaje;
  /** Qué remesa. Sin esto, una vuelta podría aplicarse sobre otra. */
  remittanceId?: string;
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
  if (typeof v?.secreta !== "string" || typeof v?.desde !== "number") {
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
  | { tipo: "conectado"; direccion: string; session: string }
  | { tipo: "tx-firmada"; transaccionBase58: string }
  | { tipo: "patrocinio-firmado"; firma: string }
  | { tipo: "rechazo"; paso: PasoDelViaje; codigo: string; mensaje: string };

/** El parámetro con el que marcamos nuestras propias vueltas. */
export const MARCA = "dl";

/** Arma el `redirect_link` de un paso. La marca es NUESTRA, no de la billetera. */
export function enlaceDeVuelta(origen: string, paso: PasoDelViaje): string {
  const u = new URL(origen);
  u.searchParams.set(MARCA, paso);
  return u.toString();
}

/**
 * ⚠️ POR QUÉ SE PUEDE CONFIAR EN LA MARCA DE LA URL AUNQUE CUALQUIERA PUEDA ESCRIBIRLA. No se
 * confía. La marca sólo dice QUÉ MIRAR; lo que decide es si el sobre abre, y el sobre sólo abre con
 * la clave secreta que quedó en ESTE disco. Una URL fabricada a mano cae en `sobre_ilegible`. Lo
 * único que alguien puede lograr escribiendo la marca es que le contestemos "huerfana".
 */
export function interpretarVuelta(
  params: URLSearchParams,
  lectura: LecturaDelViaje,
): Vuelta {
  const marca = params.get(MARCA);
  if (marca !== "conectar" && marca !== "firmar-tx" && marca !== "firmar-patrocinio") {
    return { tipo: "no-volvimos" };
  }
  const paso: PasoDelViaje = marca;
  if (lectura.tipo === "vencido") return { tipo: "vencida", paso };
  if (lectura.tipo === "no-hay") return { tipo: "huerfana", paso };

  const { viaje } = lectura;
  const secreta = bs58.decode(viaje.secreta);

  if (paso === "conectar") {
    const d = leerRespuesta<{ public_key: string; session: string }>(viaje.billetera, params, secreta);
    return traducir(d, paso, (x) => ({
      tipo: "conectado" as const,
      direccion: x.public_key,
      session: x.session,
    }));
  }
  if (paso === "firmar-tx") {
    const d = leerRespuesta<{ transaction: string }>(viaje.billetera, params, secreta);
    return traducir(d, paso, (x) => ({ tipo: "tx-firmada" as const, transaccionBase58: x.transaction }));
  }
  const d = leerRespuesta<{ signature: string }>(viaje.billetera, params, secreta);
  return traducir(d, paso, (x) => ({ tipo: "patrocinio-firmado" as const, firma: x.signature }));
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
