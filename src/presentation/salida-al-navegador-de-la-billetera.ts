// WKH-372 / W1 — La salida al navegador de la billetera, como cálculo puro.
//
// 🔴 QUÉ PROBLEMA RESUELVE, EN UNA FRASE: en el navegador común de un celular cada firma es una
// navegación fuera del sitio; adentro del navegador de la billetera el provider está INYECTADO y ese
// salto no ocurre. Este módulo arma el enlace que lleva ahí, y reconoce la vuelta.
//
// ⛔ ES PURO A PROPÓSITO: sin React, sin `window`, sin `localStorage`, sin `fetch`. Todo lo que sabe
// se lo pasan por parámetro. Eso es lo que permite medirlo entero sin montar nada.
//
// ⚠️ POR QUÉ UN ARCHIVO NUEVO Y NO UN APÉNDICE A `./wallet-availability.ts`, que es donde vive
// `phantomBrowseUrl`: ese archivo se define a sí mismo como "no importa `@solana/wallet-adapter-*`,
// lee el singleton React-free" (su encabezado), y meterle `deeplink/conexion` y `splash-puerta` lo
// acoplaría a dos módulos que hoy no toca. Un archivo nuevo, además, no corre ninguna cita anclada de
// ningún otro archivo.
//
// ⛔ LO QUE ESTE MÓDULO **NO** SABE, y no puede afirmar: si el `localStorage` sobrevive al salto. El
// navegador de la billetera es OTRA PARTICIÓN DE ALMACENAMIENTO —no es "volver al mismo origen": es
// el mismo origen en otro navegador— y nadie lo midió todavía en un teléfono. Por eso este módulo no
// contesta esa pregunta: la deja PLANTEADA con una marca en la URL, para que la pantalla la conteste
// mirando el disco cuando aterriza. Ver `vinoDeUnaSalidaConBorrador`, abajo.
import { hrefSinRastroDeVuelta } from "../infrastructure/solana/deeplink/conexion";
import { PARAM_KYC } from "./splash-puerta";
import { phantomBrowseUrl } from "./wallet-availability";

/**
 * A dónde se manda a alguien que quiere instalar la billetera.
 *
 * MEDIDO el 2026-08-31 con `curl`: `https://phantom.com/download` contesta **200**, y
 * `https://phantom.app/download` contesta **301** hacia ésta. Se escribe el destino final y no el que
 * redirige, para no gastar un salto de red en un teléfono.
 *
 * ⛔ ES LA APP NO CUSTODIAL, y esa es la única clase de billetera que este recorrido ofrece: acá no se
 * ofrece ninguna billetera custodial ni embebida, o sea nada donde la clave la guarde otro.
 *
 * ⚠️ QUÉ NO ESTÁ VERIFICADO, dicho para que nadie lo lea como cerrado: circula que el universal link
 * `browse` cae solo en la página de descarga cuando la app no está instalada. **La documentación de
 * Phantom no lo dice**, y este repo no lo midió. Por eso el recorrido ofrece DOS enlaces y no uno: el
 * de instalación no depende de esa incógnita.
 */
export const URL_INSTALAR_PHANTOM = "https://phantom.com/download";

/**
 * El parámetro con el que la salida se anuncia a sí misma en el destino. Un solo sitio de escritura
 * para el que lo pone y el que lo lee, que son las dos funciones de abajo.
 *
 * ⛔ NO SE AGREGA A (`motivoParaNoMostrar`, `./splash-puerta.ts:84`), y eso es una decisión, no un
 * olvido: esa puerta mira `kyc` y `dl`, o sea aterrizajes que RETOMAN algo en curso. Éste no retoma
 * nada: es una primera visita en un navegador nuevo, y ahí el splash corresponde.
 */
export const PARAM_SALIDA = "wb";

/**
 * El valor exacto. Va aparte del nombre porque `vinoDeUnaSalidaConBorrador` compara **los dos**.
 *
 * OPT-IN ESTRICTO, mismo patrón y por la misma razón que (`mwaEnabled`, `./wallet-availability.ts:98`)
 * y (`deeplinkEnabled`, `./wallet-availability.ts:156`): sólo este literal cuenta. Ausente, vacío,
 * `"true"` o `"1 "` con espacio ⇒ no. No hay ningún valor que lo prenda por accidente, y eso importa
 * acá porque lo que enciende es un aviso que le habla a la persona de datos suyos.
 */
export const VALOR_SALIDA = "1";

/**
 * La URL que abre esta misma app DENTRO del navegador de la billetera.
 *
 * 🔴 LAS TRES DECISIONES DEL CONTRATO, con su razón:
 *
 * 1. **`hayBorrador` ENTRA POR PARÁMETRO y no se lee del disco acá.** Quien sabe si hay algo cargado
 *    es la pantalla; este módulo se queda puro y se puede medir sin `localStorage`. Un módulo que
 *    leyera el disco por su cuenta necesitaría un doble para cada `it`.
 * 2. **La limpieza borra TRES cosas y no dos**: lo que borra (`hrefSinRastroDeVuelta`,
 *    `../infrastructure/solana/deeplink/conexion.ts:362`) —los parámetros de respuesta de la billetera
 *    y la marca `dl`— **más** (`PARAM_KYC`, `./splash-puerta.ts:45`), que esa función **no** borra y
 *    dice explícitamente que no borra. Los tres son rastros del navegador de ORIGEN y no significan
 *    nada en el de destino.
 * 3. **Un `href` que no parsea devuelve `phantomBrowseUrl(href, origin)`, o sea lo mismo que hoy.**
 *    ⛔ No se inventa una URL: no se puede limpiar lo que no se puede leer, y fabricar un destino
 *    sería mandar a la persona a un lugar que nadie pidió. Es el mismo criterio que
 *    `hrefSinRastroDeVuelta` ya aplica para su propio caso.
 *
 * 🔴 POR QUÉ SE BORRA `kyc`, Y ES UN DEFECTO QUE HOY YA ESTÁ EN PRODUCCIÓN. El enlace de hoy toma
 * `window.location.href` **crudo**. Si la persona está parada en `/?kyc=return` —el aterrizaje del
 * verificador, que arma (`urlDeVueltaDeKyc`, `./splash-puerta.ts:54`)— ese parámetro **viaja tal cual**
 * al navegador de la billetera, donde la puerta del splash lo lee como una vuelta de verificación y
 * arranca a retomar un trámite que en **ese** almacenamiento no existe. Se arregla acá porque W1
 * reescribe exactamente esa expresión, y dejarlo sería empeorar el camino que la ola promueve.
 *
 * ⚠️ EL `origin` VA SIN TOCAR: es el `?ref=` del universal link, no el destino. Limpiarlo no
 * arreglaría nada y cambiaría lo que la billetera reporta como referente.
 */
export function urlDeSalidaAlNavegadorDeLaBilletera(p: {
  /** El `window.location.href` del navegador de ORIGEN, tal como está. */
  href: string;
  /** El `window.location.origin` del navegador de ORIGEN. Viaja como `?ref=`. */
  origin: string;
  /** ¿Hay algo cargado que la persona podría perder al cruzar? Lo sabe la pantalla, no este módulo. */
  hayBorrador: boolean;
}): string {
  let u: URL;
  try {
    u = new URL(hrefSinRastroDeVuelta(p.href));
  } catch {
    // El href no se deja leer ⇒ se entrega el mismo enlace que este repo entrega hoy. Es la opción
    // que no empeora nada: sin limpieza y sin marca, pero con un destino que existe.
    return phantomBrowseUrl(p.href, p.origin);
  }
  u.searchParams.delete(PARAM_KYC);
  if (p.hayBorrador) u.searchParams.set(PARAM_SALIDA, VALOR_SALIDA);
  // `URL.toString()` deja un `?` colgando cuando no queda ningún parámetro, y eso se ve en la barra
  // del navegador de destino. Misma normalización, y por el mismo motivo, que `hrefSinRastroDeVuelta`.
  const limpio = u.searchParams.size === 0 ? `${u.origin}${u.pathname}${u.hash}` : u.toString();
  return phantomBrowseUrl(limpio, p.origin);
}

/**
 * WKH-372/W1 (CR/`BLQ-MEDIO-1`) — CONSUMIR LA MARCA: el mismo href sin `wb`, o `null` si no había
 * nada que consumir.
 *
 * 🔴 QUÉ DEFECTO CIERRA, MEDIDO POR EL CR. Nadie borraba `wb` de la barra, y el instrumento de campo
 * de esta ola —el aviso de (`flow.tsx:757`) y el hito que publica el bloque de diagnóstico— se daba
 * vuelta con una recarga de pestaña: se aterriza con `?wb=1` y el disco vacío ⇒ aviso puesto e hito
 * `con-marca-sin-borrador` (*no cruzó*); la persona re-tipea, `createRemittance` persiste; se recarga
 * con `?wb=1` TODAVÍA en la barra ⇒ aviso ausente e hito `con-marca-y-borrador`, o sea los dos
 * instrumentos publicando *«el almacenamiento cruzó»* sobre un borrador que la persona cargó a mano.
 * Un pull-to-refresh en el teléfono invertía la medición sin que nada se pusiera rojo.
 *
 * ♻️ ESTO ES LO QUE EL REPO YA HACE CON `dl`: la marca de vuelta del enlace profundo se limpia de la
 * barra apenas se lee, y por la misma razón (`hrefSinRastroDeVuelta`,
 * `../infrastructure/solana/deeplink/conexion.ts:362`). `wb` es una marca de UN aterrizaje, no un
 * estado de la pestaña.
 *
 * ⛔ `has` Y NO `get(...) === VALOR_SALIDA`, y es deliberado: el que LEE la marca es opt-in estricto
 * (`vinoDeUnaSalidaConBorrador`, abajo), pero el que la CONSUME tiene que sacar el parámetro sea cual
 * sea su valor. `wb` es un nombre de ESTE repo y no se lo pisa a nadie (CD-W1-12: no aparece en ningún
 * otro `searchParams.get(`), así que dejar un `wb=loquesea` en la barra sería dejar viva justo la
 * condición que este helper existe para eliminar. Mismo criterio, y por lo mismo, que el `has(MARCA)`
 * de (`motivoParaNoMostrar`, `./splash-puerta.ts:84`), en su línea 97.
 *
 * ⛔ DEVUELVE `null` Y NO EL MISMO HREF cuando no hay nada que hacer, para que quien llama no tenga
 * que comparar strings para saber si toca la barra: sin marca no se llama a `replaceState`, y así
 * este helper no le agrega una escritura de historial a las miles de cargas que no vienen de una
 * salida. `null` también ante un href que no parsea: no se reescribe la barra a partir de algo que no
 * se puede leer, que es el mismo criterio de la rama de arriba.
 */
export function hrefSinLaMarcaDeSalida(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (!u.searchParams.has(PARAM_SALIDA)) return null;
  u.searchParams.delete(PARAM_SALIDA);
  // Misma normalización, y por el mismo motivo, que arriba: `URL.toString()` deja un `?` colgando
  // cuando no queda ningún parámetro, y eso se ve en la barra de la persona.
  return u.searchParams.size === 0 ? `${u.origin}${u.pathname}${u.hash}` : u.toString();
}

/**
 * ¿Este aterrizaje viene de una salida que traía algo cargado?
 *
 * 🔴 QUÉ PREGUNTA CONTESTA Y CUÁL NO. Contesta *"al salir había un borrador"*. ⛔ **NO** contesta
 * *"el borrador llegó"*: eso lo mira la pantalla en el disco, y la comparación de las dos respuestas
 * es lo único que puede decir si el almacenamiento cruzó el salto. Colapsarlas en una sola sería
 * afirmar el resultado de una medición que todavía no se hizo.
 *
 * ⇒ HAY TRES DESENLACES OBSERVABLES, NO DOS:
 *   · marca **y** borrador en el disco ⇒ cruzó, y no hay nada que avisar.
 *   · marca **sin** borrador en el disco ⇒ no cruzó, y ahí sí corresponde decirlo.
 *   · **sin** marca ⇒ es una primera visita, y no se le puede hablar a alguien de datos que nunca
 *     cargó. Éste es el caso que un `has()` perdería.
 *
 * COMPARA EL VALOR EXACTO, ⛔ no `searchParams.has(...)`. Opt-in estricto, mismo patrón que
 * (`diagnosticoPedido`, `./diagnostico-de-vuelta.tsx:164`) y por la misma razón: ningún valor puede
 * encenderlo por accidente en la URL de alguien que no lo pidió.
 *
 * `false` ante un href que no parsea: no se puede afirmar que traiga una marca algo que no se puede
 * leer, y el desenlace seguro es no mostrar el aviso.
 */
export function vinoDeUnaSalidaConBorrador(href: string): boolean {
  try {
    return new URL(href).searchParams.get(PARAM_SALIDA) === VALOR_SALIDA;
  } catch {
    return false;
  }
}
