// La mitad del recorrido por enlace que NECESITA LA CADENA Y EL RELOJ (WKH-358 / ola 4).
//
// 🔴 POR QUÉ ES UN ARCHIVO APARTE Y NO DOS LÍNEAS EN OTRO LADO. Son dos exclusiones que se cruzan:
//   · en `deeplink/conexion.ts` no puede vivir, porque ese módulo es PURO y SÍNCRONO por contrato
//     (DT-7): no lee `window`, ni `Date`, ni `fetch`. Acá hay `Connection`, `sendRawTransaction` y
//     lecturas de cuenta.
//   · en `solana-wallet.ts` tampoco, y por un motivo MEDIDO y no estético: ese archivo tiene 2247
//     líneas y recibe 85 citas ancladas, así que insertar en el medio (`:1233`) rompe 34 de ellas.
// Queda un módulo propio, que además es la costura que la pantalla puede doblar en los tests sin tocar
// el adaptador.
//
// ⛔ ESTO NO ENTREGA EL DEPÓSITO POR ENLACE. Ver el encabezado de `deeplink/conexion.ts`: `prepare()`
// exige un PoP del bridge y en un móvil sin extensión el bridge está vacío, así que el depósito muere en
// `payout_pop_unavailable` antes de la rama de enlace. Es WKH-359. Lo que este módulo entrega es el
// recorrido COMPLETO de la creación de la cuenta de nonce.
import type { BilleteraDeeplink } from "./deeplink/protocol";
import type { CausaDeEnlace } from "./deeplink/firma-por-enlace";
import type { Almacen } from "./deeplink/sesion";
import { almacenDeNavegador, terminarViaje } from "./deeplink/sesion";
import { guardarEleccion, iniciarConexion, leerEleccion, olvidarEleccion } from "./deeplink/conexion";
import { resolveSolanaNetworkConfig } from "../chain";

/**
 * ¿Tiene el remitente su cuenta de nonce durable?
 *
 * 🔴 **TRES VALORES, NUNCA DOS**, y el tercero es el que siempre se pierde. Es el mismo tri-estado que
 * ya devuelve (`leerNonce`, `./nonce-duradero.ts:149`) y por la misma razón: colapsar
 * `no-pudimos-preguntar` en `falta` es convertir *"no pude preguntar"* en *"no pasó"*, que es la clase
 * de error que este repo tiene medida y escrita. Con `no-pudimos-preguntar` NO se le dice a la persona
 * nada sobre su cuenta, y **no se limpia nada del disco**.
 */
export type EstadoDeLaCuentaDeNonce = "existe" | "falta" | "no-pudimos-preguntar";

/**
 * En qué quedó un salto del recorrido por enlace.
 *
 * ⚠️ `nonce-listo` es el ÚNICO que afirma que la cuenta existe, y **sólo se emite después de releer la
 * cadena** (§4.4). ⛔ PROHIBIDO emitirlo con el resultado del `sendRawTransaction`: "el RPC aceptó la
 * tx" no es "la cuenta existe". Para eso está `nonce-en-vuelo`, que no afirma ninguna de las dos cosas.
 */
export type ResultadoDePreparacion =
  /** En esta URL no había ninguna marca nuestra. No se tocó el disco. */
  | { estado: "nada" }
  | { estado: "conectado"; direccion: string }
  /** La cadena confirmó que la cuenta EXISTE. `firma` es la del broadcast, para la traza. */
  | { estado: "nonce-listo"; firma: string }
  /** Se transmitió y la cadena todavía no la confirma. ⛔ Ni "ya está" ni "falló". */
  | { estado: "nonce-en-vuelo" }
  /** No pudimos preguntarle a la cadena. NO es una respuesta sobre la cuenta. */
  | { estado: "nonce-no-sabemos" }
  | { estado: "corte"; causa: CausaDeEnlace };

/**
 * LA MITAD DE LA ELECCIÓN — lo que la pantalla `connect` necesita para ofrecer el selector y saltar.
 *
 * 🔴 POR QUÉ ESTÁ PARTIDA EN DOS INTERFACES Y NO ES UNA SOLA. Estas tres operaciones son las únicas que
 * viven ENTERAS del lado de acá del salto: leer la elección, persistirla y abrir el viaje. Las otras
 * tres (`completar`, `estadoDeLaCuentaDeNonce`, `crearCuentaDeNonce`) necesitan la VUELTA y la CADENA.
 * Separarlas deja que el composition root cablee la mitad que existe sin que el compilador tenga que
 * aceptar métodos a medio escribir, que es como se cuela un default que degrada en silencio.
 *
 * ⛔ Y NO ES UNA INTERFAZ "por si acaso": tiene un consumidor propio y distinto —el selector de la
 * pantalla `connect`—, que no puede ni debe alcanzar el broadcast ni la lectura de la cadena.
 */
export interface EleccionDeEnlace {
  /**
   * Qué billetera eligió la persona, o `null`. Lectura **PURA** del almacén de la elección: no toca la
   * red, no pide ninguna firma y no escribe nada.
   */
  eleccion(): BilleteraDeeplink | null;
  /**
   * La persona eligió en el selector. Persiste la elección y devuelve la URL del connect.
   *
   * ⚠️ TIRA si el disco no acepta el viaje, igual que (`guardarViaje`, `./deeplink/sesion.ts:222`) y por
   * la misma razón escrita ahí: saltar sin poder recordar el viaje es mandar a firmar a ciegas.
   */
  elegir(i: { billetera: BilleteraDeeplink; remittanceId: string }): { irA: string };
  /** Borra la elección y el rastro. Ver su implementación para quién la llama hoy. */
  olvidar(): void;
}

/**
 * La costura COMPLETA del recorrido por enlace, tal como la ve la pantalla.
 *
 * ⚠️ EL REPARTO DE RESPONSABILIDADES, que es lo que hace que esto no sea un puerto más: las funciones
 * PURAS (abrir el viaje, leer la vuelta, limpiar la barra) viven en `deeplink/conexion.ts`; acá viven
 * las que necesitan la cadena o el reloj. Este objeto las compone, y es el único que la pantalla toca.
 */
export interface PreparacionPorEnlace extends EleccionDeEnlace {
  /**
   * Se volvió de un salto.
   *
   * ⛔ UN SOLO LLAMADOR, y gateado por un ref de montaje: consume el paso de forma irreversible y
   * `reactStrictMode: true` invoca los efectos dos veces (CD-11).
   *
   * 🔴 CD-26 — **cero `await` ANTES de la llamada a `completarVuelta`**. Toda la interacción con el
   * disco y la URL vive en el primer segmento SÍNCRONO; los `await` (broadcast, lectura de la cadena)
   * van después. Un `await` antes reintroduce exactamente la ventana que el fix-pack 2 de la ola 1
   * cerró. Lo mide `T-065-SYNC`.
   */
  completar(i: { remittanceId: string }): Promise<ResultadoDePreparacion>;
  /** ¿Tiene el remitente su cuenta de nonce? TRES valores, nunca dos. */
  estadoDeLaCuentaDeNonce(direccion: string): Promise<EstadoDeLaCuentaDeNonce>;
  /**
   * Arma la transacción de creación, la cifra en un sobre y devuelve el salto.
   *
   * ⛔ La transacción se arma DE CERO en cada intento y **PROHIBIDO reusar la guardada**: su blockhash
   * dura de 60 a 90 s (`nonce-duradero.ts:11-17`) contra un salto humano, así que un reintento con la
   * vieja falla siempre. No cuesta plata: no hay escrow, no hay USDC y no hay orden de payout.
   */
  crearCuentaDeNonce(i: { direccion: string; remittanceId: string }): Promise<{ irA: string }>;
}

/**
 * La mitad de la elección, cableada contra el navegador de verdad.
 *
 * ⚠️ ES ACÁ, Y NO EN `deeplink/conexion.ts`, DONDE VIVEN `window` Y `Date`. Ése es el módulo puro
 * (DT-7); éste es el que le pasa el mundo por parámetro. Toda la lógica de qué se escribe en el disco y
 * qué URL sale está allá y se puede probar sin un navegador.
 *
 * 🔴 IMPLEMENTA `EleccionDeEnlace` Y NO `PreparacionPorEnlace`, y eso es una afirmación y no una
 * omisión: esta clase entrega LA IDA (elegir y saltar). La VUELTA —`completar`, y con ella el broadcast
 * y la lectura de la cadena— es de la wave siguiente. Declarar la interfaz completa hoy obligaría a
 * escribir tres métodos que no hacen lo que su nombre dice, que es exactamente la forma en que un
 * default que degrada en silencio entra al money-path.
 */
export class EleccionDeEnlaceReal implements EleccionDeEnlace {
  /** El `localStorage` y la URL de este navegador, o `null` si este entorno no los tiene.
   *
   *  Mismo `try` y misma razón que (`entornoDeEnlace`, `../solana-wallet.ts:1177`): en el modo privado
   *  de algunos navegadores el que lanza es el GETTER de la propiedad, antes de que ninguna costura
   *  exista. */
  private entorno(): { almacen: Almacen; href: string; origin: string } | null {
    try {
      const g = globalThis as { localStorage?: Storage; location?: { href: string; origin: string } };
      const disco = g.localStorage;
      const url = g.location;
      if (!disco || !url) return null;
      return { almacen: almacenDeNavegador(disco), href: url.href, origin: url.origin };
    } catch {
      return null;
    }
  }

  eleccion(): BilleteraDeeplink | null {
    const e = this.entorno();
    return e === null ? null : leerEleccion(e.almacen);
  }

  /**
   * ⚠️ EL ORDEN DE LAS DOS ESCRITURAS IMPORTA Y NO ES ESTÉTICO: primero la elección, después el viaje.
   * `iniciarConexion` **TIRA** si el disco no acepta el viaje, y si la elección se escribiera después
   * nunca llegaría a escribirse — la persona volvería del salto (o no saltaría) sin que el gate
   * `caminoPorEnlace()` supiera que este recorrido es por enlace, y caería al camino inyectado en
   * silencio. Con este orden, un disco que no acepta el viaje deja la elección puesta y el corte llega
   * como excepción a quien la pidió, que es lo que corresponde.
   */
  elegir(i: { billetera: BilleteraDeeplink; remittanceId: string }): { irA: string } {
    const e = this.entorno();
    // Sin disco no se puede ni recordar la elección ni reconocer la vuelta: saltar sería mandar a la
    // persona a autorizar algo que este navegador no va a saber leer. Misma causa que ya existe.
    if (e === null) throw new Error("deeplink_sin_memoria");
    guardarEleccion(e.almacen, i.billetera);
    return iniciarConexion({
      almacen: e.almacen,
      ahora: Date.now(),
      hrefActual: e.href, // el href COMPLETO: `enlaceDeVuelta` TIRA con una URL relativa
      appUrl: e.origin,
      remittanceId: i.remittanceId,
      cluster: resolveSolanaNetworkConfig().cluster,
      billetera: i.billetera,
    });
  }

  /**
   * ⚠️ BORRA LA ELECCIÓN **Y** EL VIAJE, y las dos mitades hacen falta. Sin borrar el viaje, la persona
   * que "cambia de billetera" se quedaría con un viaje abierto de la billetera anterior, y su ancla
   * `claveBilletera` es de una sola escritura: la billetera nueva volvería como `otra-clave` en cada
   * intento, o sea que cambiar de billetera dejaría el recorrido roto hasta que venza la ventana.
   *
   * 🔴 QUIÉN LA LLAMA HOY: **un solo llamador de producción**, el corte del recorrido de la pantalla
   * `connect`. Los controles «Cambiar de billetera» y «No soy yo» que el SDD nombra como llamadores
   * previstos **todavía no existen**, y no se inventaron acá para que este docblock no quedara
   * describiendo una superficie que nadie escribió.
   */
  olvidar(): void {
    const e = this.entorno();
    if (e === null) return; // sin disco no hay nada que limpiar, y avisarlo no le sirve a nadie
    olvidarEleccion(e.almacen);
    terminarViaje(e.almacen);
  }
}
