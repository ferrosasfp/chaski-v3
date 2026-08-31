// Test-support — el decodificado del universal link de la billetera, en UN solo lugar (WKH-372 / W1).
//
// 🔴 POR QUÉ VIVE ACÁ Y NO ADENTRO DE UNA SUITE. Lo necesitan DOS: la del cálculo puro
// (`salida-al-navegador-de-la-billetera.test.ts`) y la de la PANTALLA (`wallet-availability.test.tsx`,
// el `it` de la oferta). Importar un `*.test.ts` desde otro archivo de tests volvería a registrar sus
// `it` en la suite que importa, así que lo compartido se comparte por acá y no por ahí.
//
// ⛔ NO ESCRIBE EL PREFIJO DEL UNIVERSAL LINK A MANO, y ésa es toda su razón de ser: un guard que
// re-escribe el literal que vigila no puede fallar. Esto DESARMA lo que el productor de producción
// escribió, sin saber ni afirmar cuál es ese prefijo.

/**
 * El href que efectivamente se le pide a la billetera que abra.
 *
 * Sale del último segmento del `path` del universal link, que viaja `encodeURIComponent`-eado, y se
 * DECODIFICA en vez de compararse contra un string escrito a mano.
 */
export function hrefQueLaBilleteraVaAAbrir(urlDeSalida: string): URL {
  const u = new URL(urlDeSalida);
  const encodeado = u.pathname.slice(u.pathname.lastIndexOf("/") + 1);
  return new URL(decodeURIComponent(encodeado));
}
