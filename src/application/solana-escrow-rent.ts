// De dónde sale el SOL que el remitente necesita para depositar, y por qué el depósito NO es gasless
// para él.
//
// Dos cosas distintas se pagan en una transacción de Solana, y sólo una la paga el facilitator:
//
//   · COMISIÓN DE RED (fee). La paga el `feePayer` de la transacción, y en el depósito el feePayer es
//     el facilitator (`solana-wallet.ts`, `tx.feePayer = resolveSolanaFacilitatorPubkey()`). Medido en
//     devnet sobre las 3 transacciones patrocinadas que existen: el feePayer `4wPhH4dC` quedó en
//     -10.000 lamports. El remitente NO paga esto.
//
//   · ALQUILER (rent) DE LAS CUENTAS QUE SE CREAN. Lo paga el `payer` de cada cuenta `init`, y en el
//     contexto `Deposit` del programa ese payer es el SENDER
//     (`solana-programs/programs/escrow/src/lib.rs`, `#[account(init, payer = sender, ...)]`). Sobre
//     esas mismas 3 transacciones, el remitente `8tJVcM2J` quedó en -4.002.000 lamports.
//
// 🔴 ACÁ VIVÍA UNA CUENTA QUE EL DEPÓSITO NO PAGA. El umbral sumaba el rent de `EscrowIndex`
// (4.774.560 lamports) "para el primer depósito de una wallet nueva", y esa cuenta NO se crea en el
// depósito: la ix `deposit` recibe 8 cuentas y `escrow_index` no es ninguna de las 8 (verificable en
// `src/infrastructure/solana/escrow-idl.ts`, la copia pinneada del IDL). La crea `register_escrow`,
// que Chaski NUNCA emite: un grep de `register` en `src/infrastructure/solana-wallet.ts` da CERO
// resultados. El sumando era 2,2× el costo real y podía voltear una demo en vivo con un "te falta
// SOL" falso sobre una billetera que podía depositar perfectamente.
//
// La medición en cadena ya lo decía y se leyó al revés: las 3 txs costaron 4.002.000 y no 8.776.560
// "porque el índice ya existía". No existía: no lo crea nadie.
//
// DERIVACIÓN DEL UMBRAL — cada sumando tiene una fuente, ninguno sale de una estimación:
//
//   ── lo que el DEPÓSITO le saca a la billetera ──────────────────────────────────────────────────
//   EscrowState (154 bytes) ......... 1.962.720 lamports  ← solana-programs/README.md:345, "Rent
//                                                            exemption, measured by the test suite
//                                                            against the in-process bank"
//   vault (ATA del mint, 165 bytes) . 2.039.280 lamports  ← el README lo da como "standard SPL" sin
//                                                            número. Sale de la resta de la medición
//                                                            en cadena: 4.002.000 - 1.962.720 =
//                                                            2.039.280, que es exactamente el
//                                                            rent-exempt canónico de una token
//                                                            account SPL. Los dos caminos coinciden.
//   subtotal depósito ............... 4.002.000 lamports  ← COINCIDE EXACTO con lo medido en cadena
//                                                            para el primer depósito de una wallet
//                                                            nueva. Es la prueba de que no falta
//                                                            ninguna cuenta en esta lista.
//
//   ── lo que el REFUND le va a sacar después, y el umbral no cubría ──────────────────────────────
//   En `refundEscrow` el feePayer es el SENDER (`solana-wallet.ts`, `tx.feePayer = senderPk`), así
//   que la comisión de esa transacción sale de su billetera. El archivo lo DECLARABA como no cubierto
//   y no lo sumaba, y esa combinación deja a la persona que depositó con lo justo sin con qué firmar
//   su propia recuperación: los USDC quedan en el vault y la única salida trustless no se puede
//   pagar. Se suma, y con los dos términos separados:
//
//   comisión base (1 firma) .........     5.000 lamports  ← 5.000 por firma. No es un número elegido:
//                                                            el depósito tiene 2 firmas (facilitator
//                                                            + sender) y midió 10.000 en cadena. El
//                                                            refund tiene UNA sola (el sender es el
//                                                            único signer, `signed.serialize()` con
//                                                            requireAllSignatures por default).
//   propina de la billetera .........    75.000 lamports  ← la tx de refund NO declara instrucciones
//                                                            de ComputeBudget, así que la billetera
//                                                            inyecta las suyas. Medido sobre el
//                                                            depósito antes de WKH-321, cuando
//                                                            tampoco las declaraba: Phantom metía
//                                                            375.000 µL/CU y 200.000 CU (SDD 038,
//                                                            `doc/sdd/038-.../sdd.md`:18). Eso da
//                                                            375.000 × 200.000 / 1e6 = 75.000
//                                                            lamports, consistente con los "80-85 k
//                                                            lamports" de fee total que el SDD
//                                                            reporta para esa transacción.
//   ────────────────────────────────────────────────────
//   suma .............................. 4.082.000 lamports
//   umbral (redondeo ARRIBA) .......... 4.100.000 lamports  (0,0041 SOL)
//
// EL MARGEN, DICHO COMO LO QUE ES. Los 18.000 lamports de diferencia son REDONDEO (0,44%), no una
// reserva calculada: no hay ninguna medición que diga cuánto margen hace falta, así que no se inventa
// una y se deja el número redondo. Se redondea HACIA ARRIBA a propósito: quedar corto por redondeo
// deja a alguien sin poder firmar su refund, y quedar largo sólo le pide unos lamports de más.
//
// Comparado con el umbral anterior de 9.000.000: pedía 2,25× lo que el depósito cuesta y aun así no
// cubría el refund. Ahora pide 1,02× el depósito y sí lo cubre.
//
// LO QUE ESTE UMBRAL SIGUE SIN CUBRIR, y se declara en vez de disfrazarse:
//   · Una propina de billetera mayor a la medida. 375.000 µL/CU es lo que se midió de Phantom; otra
//     billetera, u otra versión, puede inyectar más. No hay medición de eso y no se inventa una.
//   · El rent de `EscrowIndex`, y ya no por olvido: ninguna transacción que Chaski emite lo paga.
//     Si algún día se emite `register_escrow`, el sumando vuelve acá con su propia línea.
//
// NO TOCAR ESTE NÚMERO sin cambiar los tamaños de las cuentas del programa, sin cambiar qué cuentas
// toca la ix `deposit`, o sin una medición nueva: es lo único que lo determina.
export const SENDER_MIN_LAMPORTS_FOR_DEPOSIT = 4_100_000;

/** Lamports por SOL. Constante del protocolo (1 SOL = 10^9 lamports). */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Decimales con los que se muestra un monto en SOL. Cuatro y no tres porque el umbral vive en el
 *  cuarto decimal (0,0041 SOL): con tres, el copy mostraría "0,004" y estaría pidiendo MENOS de lo
 *  que el guard exige. */
const SOL_DISPLAY_DECIMALS = 4;
const SOL_DISPLAY_FACTOR = 10 ** SOL_DISPLAY_DECIMALS;
/** Cuántos lamports vale el último decimal que se muestra. División exacta entre potencias de 10. */
const LAMPORTS_PER_DISPLAY_UNIT = LAMPORTS_PER_SOL / SOL_DISPLAY_FACTOR;

/**
 * Lamports → SOL en texto, para el copy de la UI. Se formatea DESDE la constante para que el número
 * que lee la persona no pueda divergir del que compara el guard (una sola fuente, dos usos).
 *
 * ⚠️ REDONDEA HACIA ARRIBA, y no es cosmético: este texto le dice a alguien cuánto SOL cargar. Un
 * redondeo hacia abajo le hace cargar menos de lo que el guard exige, o sea que vuelve a chocar con
 * el mismo error después de haber hecho exactamente lo que la pantalla le pidió. El único error
 * gratis es pedir de más.
 *
 * El `ceil` corre sobre ENTEROS (lamports por unidad de display), nunca sobre el flotante en SOL:
 * `Math.ceil(0.0041 * 10000)` puede dar 42 por representación binaria, y el copy diría 0,0042.
 */
export function formatLamportsAsSol(lamports: number): string {
  const units = Math.ceil(lamports / LAMPORTS_PER_DISPLAY_UNIT);
  return (units / SOL_DISPLAY_FACTOR).toFixed(SOL_DISPLAY_DECIMALS).replace(".", ",");
}
