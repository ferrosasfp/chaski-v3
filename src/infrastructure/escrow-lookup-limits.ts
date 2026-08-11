// Techo de cuántos `remittanceId` de un remitente entran en UNA consulta de recuperación.
//
// ⚠️ ESTE ARCHIVO NO IMPORTA NADA, Y ES A PROPÓSITO. Lo consumen los dos lados: la route
// (`app/api/solana/escrow/remittance-ids/route.ts`, que corre en el servidor) y el cliente
// (`src/infrastructure/solana-wallet.ts`, que corre en el navegador). Cualquier import acá arrastra
// dependencias al bundle del que menos las quiera. Si esto necesita importar algo, la constante está
// en el lugar equivocado.
//
// ── POR QUÉ EXISTE, que es un defecto medido y no una preferencia de estilo ──────────────────────
//
// Antes había DOS números en DOS repositorios de decisión distintos que tenían que estar de acuerdo y
// nada los ataba: la route cortaba en 20 y el cliente del camino de recuperación del PRINCIPAL pedía
// 10. Consecuencia medida el 2026-08-10: el servidor mandaba hasta 20 filas y el cliente **tiraba
// hasta 10 de ellas**, en el camino que devuelve la plata del remitente, sin ganar nada — el sondeo
// on-chain es UNA sola llamada (`getMultipleAccounts`) tanto para 10 como para 20. Y el camino MENOS
// valioso, el del alquiler, era el que miraba más lejos. Estaba al revés.
//
// La forma del arreglo no fue "poner 20 en los dos lados". Dos literales iguales se desincronizan en
// cuanto alguien toca uno; es la misma clase de defecto que un hash pineado a mano. Acá hay UN valor y
// los dos lados lo derivan, y `escrow-lookup-limits.test.ts` falla si alguno vuelve a escribir el
// suyo.
//
// ── QUÉ PASA CON QUIEN TENGA MÁS DE ESTE TECHO ──────────────────────────────────────────────────
//
// Límite REAL y declarado: un remitente con más filas que este techo no alcanza las más viejas por
// ninguno de los dos caminos. Subirlo no es gratis — la respuesta crece y la sonda on-chain también —
// así que es una decisión de producto, no un número para ajustar al pasar. Lo que este archivo
// garantiza es que si se sube, se sube UNA vez y los dos lados se enteran.
export const ESCROW_ID_LOOKUP_CEILING = 20;
