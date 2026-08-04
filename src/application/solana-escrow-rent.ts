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
// DERIVACIÓN DEL UMBRAL — cada sumando tiene una fuente, ninguno sale de una estimación:
//
//   EscrowState (154 bytes) ......... 1.962.720 lamports  ← solana-programs/README.md, "Rent
//                                                            exemption, measured by the test suite
//                                                            against the in-process bank"
//   vault (ATA del mint, 165 bytes) . 2.039.280 lamports  ← el README lo da como "standard SPL" sin
//                                                            número. Sale de la resta de la medición
//                                                            en cadena: 4.002.000 - 1.962.720 =
//                                                            2.039.280, que es exactamente el
//                                                            rent-exempt canónico de una token
//                                                            account SPL. Los dos caminos coinciden.
//   EscrowIndex (558 bytes) ......... 4.774.560 lamports  ← mismo README. Se crea UNA vez por sender:
//                                                            por eso las 3 txs medidas costaron
//                                                            4.002.000 y no 8.776.560 (ya existía).
//                                                            El PRIMER depósito de una wallet nueva
//                                                            sí lo paga, y es el peor caso.
//   ────────────────────────────────────────────────────
//   peor caso ....................... 8.776.560 lamports  (0,00877656 SOL)
//
// EL MARGEN, DICHO COMO LO QUE ES. El umbral se redondea a 9.000.000 lamports (0,009 SOL). Los
// 223.440 lamports de diferencia son REDONDEO (2,5%), no una reserva calculada: no hay ninguna
// medición que diga cuánto margen hace falta, así que no se inventa una y se deja el número redondo.
//
// LO QUE ESTE UMBRAL NO CUBRE, y se declara en vez de disfrazarse:
//   · La comisión de red de un refund futuro. En `refundEscrow` el feePayer es el SENDER, así que ahí
//     sí paga fee. No se suma acá porque exigirlo en el depósito bloquearía depósitos que hoy entran
//     perfectamente, y porque el número que lo fijaría no está medido: el README del programa dice
//     "approximately 0.005 SOL per transaction" pero la medición en cadena del feePayer dio 10.000
//     lamports (0,00001 SOL) para dos firmas. Con dos fuentes que difieren en tres órdenes de
//     magnitud, sumar cualquiera de las dos sería elegir a dedo.
//   · Prioridad (priority fee). Va dentro de la comisión de red, que paga el facilitator.
//
// NO TOCAR ESTE NÚMERO sin cambiar los tamaños de las cuentas del programa o sin una medición nueva:
// es la única cosa que lo determina.
export const SENDER_MIN_LAMPORTS_FOR_DEPOSIT = 9_000_000;

/** Lamports por SOL. Constante del protocolo (1 SOL = 10^9 lamports). */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Lamports → SOL en texto, para el copy de la UI. Se formatea DESDE la constante para que el número
 *  que lee la persona no pueda divergir del que compara el guard (una sola fuente, dos usos). */
export function formatLamportsAsSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(3).replace(".", ",");
}
