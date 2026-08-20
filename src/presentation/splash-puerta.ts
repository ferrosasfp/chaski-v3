// Presentation — la puerta del splash (HU-066). **PURA**: no toca `window`, no lee el disco, no
// depende de React. Le pasan el href y un lector, y contesta.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 ESTE ES EL ARCHIVO QUE IMPORTA DE LA HU, Y NO ES EL DIBUJO.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// Chaski tiene DOS recorridos que salen de la app y vuelven a ella con una RECARGA DE PÁGINA
// COMPLETA, y los dos aterrizan en una pantalla concreta al montar:
//
//   1. El KYC de Didit. Se va con `window.location.href = res.url` y vuelve al origen; el resume
//      corre en el efecto de montaje de `RemittanceFlow` y aterriza en `confirm` o en `verify`
//      (`aterrizar`, `./flow.tsx:208`).
//   2. El recorrido por enlace de billetera (deeplinks). Vuelve con nuestra marca en la barra y lo
//      atiende `useVueltaPorEnlace`, también en el montaje.
//
// Un splash que se pinte encima de cualquiera de esos dos es lo peor que esta HU puede hacer: tapa
// una pantalla que la persona necesita ver, y si además se comiera el toque, la deja mirando una
// marca mientras su remesa espera. Por eso la regla no es "el splash se cierra rápido": es **el
// splash NO SE MUESTRA cuando hay algo que atender**.
//
// ── LO QUE SE MIDE ES LA PRECONDICIÓN, NO LA CONSECUENCIA ────────────────────────────────────────
//
// ⚠️ LA URL NO ALCANZA, y esa era la trampa fácil. Los DOS disparadores reales viven en el DISCO, no
// en la barra de direcciones:
//   · el resume del KYC arranca con (`pending`, `../application/use-cases/resume-kyc.ts:24`), o sea la clave
//     `chaski.kyc.pending.v1`. El `?kyc=return` es sólo el callback que Didit usa cuando vuelve por
//     redirect: si la persona vuelve con el botón «atrás», o recarga, o el enlace de vuelta se perdió,
//     la URL viene LIMPIA y el resume corre igual.
//   · la vuelta por enlace arranca con `remesaEnCurso()`, o sea `chaski.billetera.viaje.v1`. La marca
//     `dl` en la URL no es la condición: `useVueltaPorEnlace` sale temprano si no hay viaje guardado.
// Así que se miran los CUATRO: dos claves de disco y dos señales de URL. Las de URL no son redundantes
// —son la señal que llega ANTES de que el disco se lea, y son gratis— pero solas dejarían el agujero.
//
// ⛔ Y NO SE COPIA NINGUNA CLAVE NI NINGÚN NOMBRE DE PARÁMETRO: se importan de donde se escriben. Un
// literal repetido acá se vería idéntico y se volvería falso el día que el productor cambie de clave,
// en silencio y del lado malo (el splash tapando el resume). El candado que lo mide es
// `splash-puerta.test.ts`, que compara contra los MISMOS símbolos importados.

import { CLAVE_KYC_PENDIENTE } from "../infrastructure/kyc-pending-store";
import { CLAVE as CLAVE_DEL_VIAJE, MARCA } from "../infrastructure/solana/deeplink/sesion";

/** El parámetro con el que Didit vuelve al origen. Lo ESCRIBE `flow.tsx` al armar el callback
 *  (`urlDeVueltaDeKyc`, abajo) y lo LEE esta puerta: un solo sitio de escritura para los dos. */
export const PARAM_KYC = "kyc";
/** El valor de ese parámetro. Separado del nombre porque la puerta compara los dos. */
export const VALOR_VUELTA_KYC = "return";

/**
 * El callback que se le pasa a Didit. Vivía como literal (`` `${origin}/?kyc=return` ``) dentro de
 * `flow.tsx`, y la puerta de acá abajo necesitaba leer el MISMO parámetro: eran dos escrituras del
 * mismo string en dos archivos, sin nada que las atara.
 */
export function urlDeVueltaDeKyc(origin: string): string {
  return `${origin}/?${PARAM_KYC}=${VALOR_VUELTA_KYC}`;
}

/**
 * Por qué NO se muestra el splash. `null` = no hay motivo, se puede mostrar.
 *
 * 🔴 ES UN MOTIVO Y NO UN BOOLEANO, Y NO ES CEREMONIA. Este repo ya tiene escrito que un `boolean`
 * pierde el tercer valor ("no pude preguntar" ≠ "no"): `disco-ilegible` es exactamente ese tercero, y
 * con un `boolean` habría quedado indistinguible de "no hay nada pendiente" — que es la respuesta que
 * MUESTRA el splash. Además, el motivo es lo que se puede leer desde afuera: el atributo
 * `data-splash-motivo` del árbol es lo que hace medible en un navegador que la puerta cerró, y por
 * cuál de los cinco caminos.
 */
export type MotivoParaNoMostrar =
  | "vuelta-de-kyc-en-la-url"
  | "vuelta-por-enlace-en-la-url"
  | "kyc-pendiente-en-el-disco"
  | "viaje-de-billetera-en-el-disco"
  | "disco-ilegible";

/** Lo único que la puerta necesita del almacén: leer una clave. `null` = no está. */
export type LeerDelDisco = (clave: string) => string | null;

/**
 * ⛔ FALLA CERRADO. Si el disco no se deja leer (modo privado, cuota, un getter que tira), la puerta
 * contesta `"disco-ilegible"` y el splash NO se muestra. La pregunta que no se pudo hacer no se
 * responde que no: el costo de equivocarse en una dirección es una pantalla de marca que no se ve, y
 * en la otra es tapar el aterrizaje de un KYC ya pagado.
 */
export function motivoParaNoMostrar(p: { href: string; leer: LeerDelDisco }): MotivoParaNoMostrar | null {
  let params: URLSearchParams;
  try {
    params = new URL(p.href).searchParams;
  } catch {
    // Un href que no parsea no trae ninguna señal nuestra, pero tampoco se puede afirmar que no la
    // traiga. Misma dirección que todo lo demás de acá: no se muestra.
    return "disco-ilegible";
  }
  if (params.get(PARAM_KYC) === VALOR_VUELTA_KYC) return "vuelta-de-kyc-en-la-url";
  // `has` y no `get(...) !== null` con un valor esperado: la marca de vuelta lleva CUÁL paso volvió
  // (`conectar`, `firmar-tx`, `crear-nonce`, …) y hasta una que este repo no escribió. Cualquiera de
  // ellas significa "volvimos de un salto", que es lo único que la puerta necesita saber.
  if (params.has(MARCA)) return "vuelta-por-enlace-en-la-url";
  let kycPendiente: string | null;
  let viaje: string | null;
  try {
    kycPendiente = p.leer(CLAVE_KYC_PENDIENTE);
    viaje = p.leer(CLAVE_DEL_VIAJE);
  } catch {
    return "disco-ilegible";
  }
  if (kycPendiente !== null) return "kyc-pendiente-en-el-disco";
  if (viaje !== null) return "viaje-de-billetera-en-el-disco";
  return null;
}

/**
 * HU 073 / AC-5 — ¿esta persona llegó por la vuelta del verificador?
 *
 * 🔴 TRES VALORES, NO DOS, y por eso el nombre dice «volvió POR la vuelta» y no «volvió». `true` es
 * *«la URL trae la marca que NOSOTROS escribimos»* (`urlDeVueltaDeKyc`, `:54`). `false` es
 * *«la URL no la trae»*, que ⛔ **NO es «la persona no volvió del verificador»**: el parámetro se puede
 * perder en un redirect intermedio, en un cliente de correo que reescribe enlaces, o simplemente porque
 * la persona abrió la app de nuevo a mano. La lección está escrita al lado, en el docblock de
 * (`MotivoParaNoMostrar`, `:68`): «no pude preguntar» ≠ «no».
 *
 * ⛔ POR ESO SU AUSENCIA NO HABILITA NINGUNA FRASE (CD-5). En la Ola A este predicado **no tiene
 * consumidor de copy**: existe para que la pantalla trate igual los dos casos y para que eso sea
 * medible. Una frase del tipo «parece que no completaste la verificación» derivada de este `false`
 * sería exactamente la clase de afirmación sin medición que esta HU vino a eliminar.
 *
 * ⛔ El literal `"kyc"`/`"return"` NO se vuelve a escribir: se reusan las dos constantes de arriba, que
 * son las mismas que usa el único productor de esa URL.
 */
export function volvioPorLaVueltaDeKyc(href: string): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(href).searchParams;
  } catch {
    // Un href que no parsea no trae la marca, y tampoco permite afirmar que la persona no volvió. Acá
    // el `false` significa «no hay marca», nunca «no volvió»: ver el docblock de arriba.
    return false;
  }
  return params.get(PARAM_KYC) === VALOR_VUELTA_KYC;
}
