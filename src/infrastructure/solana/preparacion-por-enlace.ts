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
 * La costura del recorrido por enlace, tal como la ve la pantalla.
 *
 * ⚠️ EL REPARTO DE RESPONSABILIDADES, que es lo que hace que esto no sea un puerto más: las funciones
 * PURAS (abrir el viaje, leer la vuelta, limpiar la barra) viven en `deeplink/conexion.ts`; acá viven
 * las que necesitan la cadena o el reloj. Este objeto las compone, y es el único que la pantalla toca.
 */
export interface PreparacionPorEnlace {
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
  /** Borra la elección y el rastro. Ver su implementación para quién la llama hoy. */
  olvidar(): void;
}
