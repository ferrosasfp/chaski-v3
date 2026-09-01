// WKH-373/diagnóstico — QUÉ SITIO ESCRIBIÓ EL CORTE, Y CONTRA QUÉ BYTES COMPARÓ.
//
// 🔴 QUÉ PROBLEMA RESUELVE, Y POR QUÉ NO ALCANZA CON LA CAUSA.
// `DEEPLINK_TX_ALTERADA` lo escriben MUCHOS sitios distintos, con el MISMO string, y desde la pantalla
// son indistinguibles. Una captura que dice `corte: deeplink_tx_alterada` no separa «la billetera
// devolvió otra transacción» de «lo que volvió no se puede ni parsear» de «la firma no verifica»: son
// tres arreglos distintos, y hasta que este renglón existió había que probar cuatro veces en un
// teléfono para descartarlos.
//
// ⛔ Y ACÁ ESTUVE POR ESCRIBIR «SIETE», QUE ES LO QUE DECÍA EL DIAGNÓSTICO DE ESTA HU. Es FALSO, y lo
// midió el barrido: los sitios que emiten esa causa en `src/` son **TRECE**, no siete —el diagnóstico
// listó los del camino del depósito y del nonce y se dejó afuera seis: el `otra-clave` de
// `completarVuelta`, los tres del motor (`otra-clave` y las dos firmas de disco que son basura) y los
// dos de la transmisión del nonce—. ⛔ POR ESO EL NÚMERO NO SE ESCRIBE ACÁ: una lista a mano envejece
// con la primera rama nueva, exactamente como envejeció la del diagnóstico. Lo que sostiene la
// propiedad es un candado que DERIVA los dos conjuntos del árbol y los cruza —«todo sitio que emite la
// causa anota su código, y todo código de la unión lo escribe exactamente un sitio»—, en
// `./bitacora-del-corte.test.ts`. Si querés el número, corré el candado; no lo copies de este párrafo.
//
// ⛔ NO ES TELEMETRÍA Y NO SALE DEL DISPOSITIVO. No hay `fetch`, no hay `localStorage`, no hay
// `console`. Son dos variables de módulo que viven lo que vive la pestaña, exactamente el mismo
// mecanismo —y por la misma razón— que (`anotarCorteDeVuelta`, `../../../presentation/bitacora-de-vuelta.ts:43`).
//
// ⛔ POR QUÉ VIVE EN `infrastructure` Y NO AL LADO DE LA OTRA BITÁCORA: los siete sitios son de
// infraestructura, y hacer que `conexion.ts` o `solana-wallet.ts` importen de `presentation` invertiría
// la dependencia. La pantalla lee de acá, que es la dirección que este repo ya usa.
//
// ⛔ QUÉ **NO** PUEDE ENTRAR ACÁ, y es la misma regla que la otra bitácora ya declara: ningún valor
// del disco ni de la billetera. Lo que se guarda son (1) una etiqueta de un conjunto CERRADO que
// escribe este repo y (2) una HUELLA de 12 hex, que es un digest truncado y no el contenido. ⛔ Nunca
// el `mensajeBase64`, nunca la transacción, nunca una firma, nunca una clave.
import { sha256 } from "@noble/hashes/sha256";

/**
 * Los emisores de `deeplink_tx_alterada`, con el nombre del archivo que los escribe. ⛔ El conjunto lo
 * cruza contra el árbol `./bitacora-del-corte.test.ts`, en las dos direcciones; agregar un miembro sin
 * sitio, o un sitio sin miembro, lo pone rojo.
 *
 * ⚠️ `E2` ESTÁ PARTIDO EN DOS Y ESO ES LA MITAD DEL VALOR DE ESTE MÓDULO: el `if` de
 * (`mensaje`, `./conexion.ts:568`) es un `||` que funde «la transacción que volvió no se puede leer»
 * con «se puede leer y NO es la que mandamos». Son dos hipótesis con arreglos opuestos —una es de
 * formato de la billetera, la otra es del ciclo de vida del ancla— y la pantalla decía lo mismo para
 * las dos.
 */
export type SitioDelCorte =
  /** `conexion.ts` · vuelta del NONCE: la URL trae una clave de cifrado y no es la anclada. */
  | "E1-nonce-otra-clave"
  /** `conexion.ts` · vuelta del NONCE: lo que volvió no se pudo parsear como `Transaction`. */
  | "E2a-nonce-ilegible"
  /** `conexion.ts` · vuelta del NONCE: se parseó y sus bytes NO son los del ancla. */
  | "E2b-nonce-bytes-distintos"
  /** `firma-por-enlace.ts` · DEPÓSITO: la tx del disco no trae la firma del sender. */
  | "E3-deposito-sin-firma-del-sender"
  /** `solana-wallet.ts` · DEPÓSITO: lo que volvió no decodifica como `Transaction`. */
  | "E4-deposito-ilegible"
  /** `solana-wallet.ts` · DEPÓSITO: se decodificó y sus bytes NO son los del ancla. */
  | "E5-deposito-bytes-distintos"
  /** `solana-wallet.ts` · DEPÓSITO: la firma del sender no verifica ed25519 sobre esos bytes. */
  | "E6-deposito-firma-no-verifica"
  /** `solana-wallet.ts` · DEPÓSITO: la tx devuelta no trae `recentBlockhash`. */
  | "E7-deposito-sin-blockhash"
  /** `conexion.ts` · `completarVuelta`: el sobre abrió con una clave que no es la que fijó el connect. */
  | "E8-viaje-otra-clave"
  /** `firma-por-enlace.ts` · el MOTOR: ídem, del lado del motor del depósito. */
  | "E9-motor-otra-clave"
  /** `firma-por-enlace.ts` · la tx firmada que quedó en el DISCO está presente y es basura. */
  | "E10-tx-firmada-en-disco-basura"
  /** `firma-por-enlace.ts` · ídem para la firma de patrocinio. */
  | "E11-patrocinio-en-disco-basura"
  /** `preparacion-por-enlace.ts` · lo que se va a transmitir del NONCE no decodifica como `Transaction`. */
  | "E12-nonce-transmision-ilegible"
  /** `preparacion-por-enlace.ts` · esa transacción no declara `feePayer`, así que no hay nonce que releer. */
  | "E13-nonce-transmision-sin-feepayer";

/** Lo que quedó marcado como ILEGIBLE en vez de una huella. Un solo sitio de escritura. */
export const HUELLA_ILEGIBLE = "ILEGIBLE";

let sitio: SitioDelCorte | null = null;
let huellaDeLaVuelta: string | null = null;

/**
 * Lo llaman TODOS los emisores de la causa, INMEDIATAMENTE antes de devolver o tirar.
 *
 * ⛔ NO CAMBIA NINGÚN COMPORTAMIENTO OBSERVABLE: es una asignación a una variable de módulo que sólo
 * lee el bloque de `?diag=1`. ⛔ Y NO REEMPLAZA A LA CAUSA: la causa sigue siendo el mismo string,
 * porque es lo que la pantalla traduce a copy y lo que el candado de copy cuenta.
 */
export function anotarSitioDelCorte(s: SitioDelCorte): void {
  sitio = s;
}

/** `null` = ningún sitio escribió un corte en esta carga de la página. */
export function ultimoSitioDelCorte(): SitioDelCorte | null {
  return sitio;
}

/**
 * La huella del mensaje que la billetera devolvió, o `HUELLA_ILEGIBLE` cuando no se pudo leer.
 *
 * 🔴 SE ANOTA EN EL CAMINO FELIZ TAMBIÉN, y no sólo en el corte: puesta al lado de la huella del ancla
 * —que el bloque de diagnóstico saca del disco— es lo que separa de un vistazo «el ancla se pisó» (dos
 * huellas distintas, las dos legibles) de «la billetera devolvió cualquier cosa» (`ILEGIBLE`).
 */
export function anotarHuellaDeLaVuelta(h: string): void {
  huellaDeLaVuelta = h;
}

/** `null` = nadie leyó todavía una vuelta con bytes en esta carga de la página. */
export function ultimaHuellaDeLaVuelta(): string | null {
  return huellaDeLaVuelta;
}

/** Test-only: limpia entre `it`. ⛔ No avisa a nadie (no hay oyentes), mismo contrato que
 *  (`olvidarCorteDeVuelta`, `../../../presentation/bitacora-de-vuelta.ts:64`). */
export function olvidarElSitioDelCorte(): void {
  sitio = null;
  huellaDeLaVuelta = null;
}

/**
 * Doce hexadecimales que identifican un texto, para poder COMPARAR dos valores de un vistazo en la
 * pantalla de un teléfono.
 *
 * 🔴 ES UNA HUELLA Y NO EL CONTENIDO, y eso es lo que la deja entrar al bloque de diagnóstico: su
 * regla es «⛔ ningún secreto», y el `mensajeBase64` de un ancla son los bytes de una transacción que
 * este repo no vuelca a ninguna pantalla. Seis bytes de un digest no reconstruyen nada.
 *
 * ⚠️ SHA-256 SÍNCRONO, Y ESO NO ES UN DETALLE: el bloque de diagnóstico se pinta en un render y
 * `crypto.subtle.digest` devuelve una PROMESA, así que la API del navegador no sirve acá. Se usa el
 * mismo hasher que este repo ya tiene cableado en (`remittanceIdBytes`, `../../solana-wallet.ts:580`).
 * VERIFICADO contra la versión INSTALADA y no contra la memoria: `node_modules/@noble/hashes/package.json:3`
 * dice `1.8.0`, `node_modules/@noble/hashes/sha256.d.ts:15` exporta `sha256`, y su tipo `CHash`
 * (`node_modules/@noble/hashes/utils.d.ts:131` → `createHasher`) declara `(msg: Input): Uint8Array`.
 *
 * ⚠️ QUÉ **NO** ES: no es una defensa. Nadie decide nada con esto —ni acepta una transacción, ni
 * autoriza un pago—; la comparación que sí decide sigue siendo byte contra byte en
 * (`mensajeDevuelto`, `../../solana-wallet.ts:989`) y en (`mensaje`, `./conexion.ts:568`), sobre los
 * bytes ENTEROS. Truncar acá no ablanda ninguna de las dos.
 */
export function huella(texto: string): string {
  const digest = sha256(new TextEncoder().encode(texto));
  let hex = "";
  for (let i = 0; i < 6; i++) hex += (digest[i] as number).toString(16).padStart(2, "0");
  return hex;
}
