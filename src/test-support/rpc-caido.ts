// Test-support — el mensaje que un RPC de Solana caído produce DE VERDAD (WKH-327, fix-pack
// AR/BLQ-MED-1).
//
// 🔴 POR QUÉ ESTA CONSTANTE EXISTE Y POR QUÉ NO ES UN FIXTURE ELEGIDO A MANO. El bloqueante que este
// archivo ayuda a cerrar se escapó porque el test del caso negativo eligió como mensaje uno de los
// dos códigos que el guard del copy SÍ reconocía (`escrow_recovery_unavailable`). El adapter probaba
// que propaga, la UI probaba que traduce, y la junta entre los dos no la probaba nadie: el mensaje
// REAL no contiene ninguno de esos códigos y caía en la frase que afirma haber mirado.
//
// Así que este string NO se escribe a ojo: lo MIDE `escrow-rent-discovery-junta.test.ts`, corriendo el
// `SolanaWalletAdapter` real con el RPC apuntado a un puerto muerto, y ese test se pone rojo si
// @solana/web3.js cambia lo que dice. Los tests de UI parten de acá porque en jsdom el adapter no se
// puede correr entero: la derivación de la PDA se cae ANTES de llegar a la red. Medido en los dos
// niveles: `findProgramAddressSync` (lo que el código llama) propaga "Unable to find a viable program
// address nonce", y la causa de adentro —medida aparte sobre `createProgramAddressSync`, que el loop
// de la otra se traga— es "Uint8Array expected" (el `Buffer` de Node no es `instanceof Uint8Array` en
// el realm de jsdom y @noble/hashes lo rechaza).
//
// 🔴 EL NOMBRE DICE "NODE" Y NO ES UN DETALLE (AR/MNR-6). `"fetch failed"` es el string de **undici**,
// o sea el de Node. Producción es un navegador, y qué dice un navegador real cuando el `fetch` al RPC
// falla NO SE PUDO VERIFICAR acá (requiere un navegador de verdad): Chrome y Firefox emiten otros
// textos. O sea que este candado NO pinnea el mensaje de producción, y no hace falta que lo haga: el
// copy no depende de esta constante ni de ninguna lista de códigos. `escrowRentDiscoveryError` tiene
// el desenlace honesto como DEFAULT, y eso está asertado como propiedad sobre entradas arbitrarias
// (`escrow-rent-discovery-junta.test.ts`, el barrido de 8 entradas). Esta constante sirve para una
// sola cosa: que los tests de UI partan de un string que alguien midió, en vez de uno elegido a mano.
export const MENSAJE_RPC_CAIDO_NODE_MEDIDO = "fetch failed";

/** El mensaje con el que la wallet reporta que la persona cerró el popup de la firma de posesión.
 *  ⚠️ Este NO está medido contra una wallet real y no puede estarlo acá (requiere una extensión en un
 *  navegador). Es el string documentado de Phantom/Solflare y el copy no depende de que matchee: si no
 *  matchea, cae al default de `escrowRentDiscoveryError`, que TAMBIÉN dice "no llegamos a preguntar". */
export const MENSAJE_FIRMA_RECHAZADA_SIN_MEDIR = "User rejected the request.";
