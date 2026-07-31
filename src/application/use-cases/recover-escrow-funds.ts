// Application — recuperación de los fondos del escrow por el propio sender, CON persistencia.
//
// Por qué existe este use-case y no una llamada suelta al gateway desde la UI: antes el refund
// on-chain se ejecutaba de verdad y su resultado moría en un useState. La secuencia que le arruinaba
// el día a una persona era:
//   1. aprieta "Recuperar fondos" y el refund on-chain FUNCIONA
//   2. recarga la página
//   3. la remesa sigue en payout_submitted, como si nada hubiera pasado
//   4. aprieta de nuevo
//   5. el escrow ya está en Refunded y el programa Anchor rechaza
//   6. la pantalla le dice "No pudimos recuperar los fondos"
// O sea: le reportaba como fallada una operación que había funcionado, y le escondía que su plata
// ya había vuelto. Escribir el estado no es prolijidad: es la diferencia entre saber y no saber
// dónde está la plata.
import type { Remittance, RemittanceStatus } from "../../domain/remittance";
import type { Clock, RemittanceRepository, SolanaEscrowRefundGateway } from "../ports";

/** Razón estable (enum, NUNCA PII) del payout_failed que precede al refund iniciado por el sender.
 *  La UI la usa para no titular "no se pudo entregar" una recuperación exitosa. */
export const ESCROW_REFUNDED_BY_SENDER = "escrow_refunded_by_sender";

/** Estados desde los que el escrow puede tener fondos y la FSM permite llegar a `refunded`.
 *  `settled`/`refunded` no están: son terminales y no hay transición de salida (remittance.ts:94-96). */
const RECOVERABLE: readonly RemittanceStatus[] = ["principal_in", "payout_submitted", "payout_failed"];

export class RecoverEscrowFunds {
  constructor(
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
    private readonly escrow: SolanaEscrowRefundGateway,
  ) {}

  async execute(input: { remittanceId: string; sender: string }): Promise<Remittance> {
    const r = await this.repo.get(input.remittanceId);
    if (!r) throw new Error("remittance_not_found");
    // Guard ANTES de tocar la cadena: si la FSM no puede registrar el resultado, no se dispara una
    // operación cuyo resultado no vamos a poder escribir (que es exactamente el bug de arriba).
    if (!RECOVERABLE.includes(r.status)) throw new Error("refund_not_available");

    // La plata PRIMERO, el estado DESPUÉS. Al revés escribiríamos "refunded" sin saber si volvió.
    // Si esto lanza, el estado queda intacto y el error sube al caller (la UI muestra su copy).
    const { refundTx } = await this.escrow.refund({
      remittanceId: input.remittanceId,
      sender: input.sender,
    });

    // El refund YA ocurrió on-chain. De acá en adelante NADA puede volver a reportar fallo: sería
    // repetir la mentira que este use-case vino a matar.
    const now = this.clock.nowIso();
    // payout_failed es el único paso previo a `refunded` en la FSM. Desde payout_failed ya estamos.
    if (r.status !== "payout_failed") r.markPayoutFailed(ESCROW_REFUNDED_BY_SENDER, now);
    r.markRefunded(refundTx, now);
    try {
      await this.repo.save(r);
    } catch {
      // Persistir falló (localStorage lleno / CAS perdido contra otra pestaña). El agregado EN
      // MEMORIA ya dice `refunded` con su signature, así que el caller devuelve la verdad en esta
      // sesión; lo que se pierde es la durabilidad, no el hecho. Propagar el error acá haría que la
      // pantalla dijera "no pudimos recuperar" sobre plata que ya volvió.
    }
    return r;
  }
}
