// Presentation — la marca Chaski, en UN solo lugar.
//
// 🔴 POR QUÉ EXISTE ESTE ARCHIVO (HU-066). Antes de esta HU la marca estaba repartida en literales
// sueltos: el lema `"tu plata a Perú, sin vueltas"` vivía escrito a mano en el header de `flow.tsx`,
// el nombre `"Chaski"` en tres `aria-label`/`alt` distintos, y el dibujo era un `<svg>` inline en
// `ui.tsx`. Con el splash de esta HU cada uno de esos pasaba a tener DOS sitios de escritura, y dos
// literales idénticos sin nada que los ate es exactamente cómo uno se corrige y el otro no.
//
// ⛔ ACÁ NO HAY COMPONENTES NI JSX A PROPÓSITO: es un módulo de datos, así que lo pueden importar
// tanto `ui.tsx` (que dibuja la marca) como `flow.tsx` (que escribe el lema) como `splash.tsx` (que
// usa los tres) sin que ninguno dependa de otro.

import { resolveSolanaNetworkConfig } from "../infrastructure/chain";

/** El nombre de la app. Es el nombre accesible de la marca dibujada y el `<h1>` del header. */
export const NOMBRE = "Chaski";

/**
 * El lema. Se escribía a mano en el header de `flow.tsx` y el splash de HU-066 lo repite; desde acá
 * los dos leen el MISMO string, así que no pueden divergir.
 *
 * ⛔ SIN GUION LARGO: el candado de estilo de copy de `honest-copy.test.tsx` recorre las pantallas
 * del flujo y exige que ningún texto renderizado contenga `—`.
 */
export const LEMA = "tu plata a Perú, sin vueltas";

/**
 * El mensajero SOLO, sin la palabra. Es lo que va al lado de un texto (el header, la tarjeta de
 * seguimiento), donde el nombre ya lo dice el `<h1>` de al lado y repetirlo sería decirlo dos veces.
 *
 * ⚠️ Es 1154x765, o sea **1,51:1**, y NO es cuadrado como el `<svg>` de 40x40 que reemplazó. Por eso
 * `ChaskiMark` lo pinta con `object-contain`: el `className` del sitio de llamada sigue fijando la
 * CAJA (hoy `size-icono-lg`, 32x32) y la tinta entra adentro sin deformarse.
 */
export const MARCA_SRC = "/marca-chaski.png";

/** El lockup completo (mensajero + la palabra CHASKI). Va donde la marca es el contenido y no un
 *  acompañante: hoy, el splash. Ahí no hay ningún `<h1>` que diga el nombre, así que lo dice el logo. */
export const LOGO_SRC = "/logo-chaski.png";

/**
 * La píldora de red del splash: `SOLANA DEVNET`.
 *
 * 🔴 SE DERIVA, NO SE ESCRIBE. El literal `"SOLANA DEVNET"` en el JSX se vería idéntico hoy y sería
 * falso el día del cutover a mainnet, sin que nada se ponga rojo. Sale del MISMO resolver que ya usan
 * la bienvenida (`resolveSolanaNetworkConfig`, `./bienvenida.tsx:268`) y el paso `connect`, así que la
 * primera pantalla y la de firmar no pueden nombrar redes distintas.
 *
 * ⚠️ LO QUE ESTO **NO** GARANTIZA, y ya está medido y escrito en el docblock de `Bienvenida`: el
 * cluster es un LITERAL de `chain.ts` y el endpoint contra el que se firma sale de
 * `NEXT_PUBLIC_SOLANA_RPC_URL` sin ninguna validación cruzada. Que el env apunte a otra red y la
 * píldora siga diciendo `DEVNET` es posible hoy y sin desplegar código. Lo que esta función cierra es
 * la divergencia entre DOS PANTALLAS, no la divergencia entre la pantalla y la red.
 */
export function pildoraDeRed(): string {
  const { vm, cluster } = resolveSolanaNetworkConfig();
  return `${vm} ${cluster}`.toUpperCase();
}
