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
import type {
  Clock,
  EscrowRefundConfirmation,
  RemittanceRepository,
  SolanaEscrowRefundGateway,
} from "../ports";

/** Razón estable (enum, NUNCA PII) del payout_failed que precede al refund iniciado por el sender.
 *  La UI la usa para no titular "no se pudo entregar" una recuperación exitosa. */
export const ESCROW_REFUNDED_BY_SENDER = "escrow_refunded_by_sender";

/** Estados desde los que el escrow puede tener fondos y la FSM permite llegar a `refunded`.
 *  `settled`/`refunded` no están: son terminales y no hay transición de salida (remittance.ts:129/131).
 *
 *  ⚠️ `confirmed` FALTABA, y era la ventana más cara de las cuatro. Es el estado en el que la persona
 *  YA firmó la autorización del depósito y nadie llegó a registrar el desenlace: dura los hasta 15 s
 *  del timeout del settle más el broadcast, y quien cierre el navegador ahí puede tener sus USDC en el
 *  vault. `escrowFundsKnowledge` ya lo clasificaba como `unverified` (`escrowFundsKnowledge`, `flow-vm.ts:194`), o sea que el
 *  historial lo listaba, lo declaraba abrible y lo mandaba al seguimiento, y ahí no había ninguna
 *  acción: la pantalla decía "no comprobamos si tus USDC siguen en el escrow" y no ofrecía preguntarlo.
 *
 *  La FSM lo permite sin tocar nada: `confirmed → payout_failed` (remittance.ts:126) y
 *  `payout_failed → refunded` (remittance.ts:130), que son exactamente las dos transiciones que este
 *  use-case hace más abajo. */
const RECOVERABLE: readonly RemittanceStatus[] = [
  "confirmed",
  "principal_in",
  "payout_submitted",
  "payout_failed",
];

/** Lo que sabe el caller cuando esto vuelve. `remittance` sólo está en `refunded` (terminal) cuando
 *  `confirmation === "confirmed"`; en los otros dos casos vuelve INTACTA y sigue siendo recuperable,
 *  porque nadie probó que la plata haya vuelto. La signature viaja igual: la persona tiene derecho a
 *  ver qué se envió aunque todavía no se sepa si entró. */
export interface RecoverEscrowFundsResult {
  confirmation: EscrowRefundConfirmation;
  refundTx: string;
  remittance: Remittance;
}

export class RecoverEscrowFunds {
  constructor(
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
    private readonly escrow: SolanaEscrowRefundGateway,
  ) {}

  async execute(input: { remittanceId: string; sender: string }): Promise<RecoverEscrowFundsResult> {
    const r = await this.repo.get(input.remittanceId);
    if (!r) throw new Error("remittance_not_found");
    // Guard ANTES de tocar la cadena: si la FSM no puede registrar el resultado, no se dispara una
    // operación cuyo resultado no vamos a poder escribir (que es exactamente el bug de arriba).
    if (!RECOVERABLE.includes(r.status)) throw new Error("refund_not_available");

    // La plata PRIMERO, el estado DESPUÉS. Al revés escribiríamos "refunded" sin saber si volvió.
    // Si esto lanza, el estado queda intacto y el error sube al caller (la UI muestra su copy).
    const { refundTx, confirmation } = await this.escrow.refund({
      remittanceId: input.remittanceId,
      sender: input.sender,
    });

    // ⚠️ ACÁ decía "El refund YA ocurrió on-chain" y era FALSO: lo que había ocurrido es que un RPC
    // aceptó la transacción. Sobre esa afirmación se escribía `refunded`, que es TERMINAL: si la tx
    // se caía (blockhash vencido mientras la persona firmaba), la pantalla decía "recuperaste tus
    // fondos", la plata seguía en el vault y el botón no volvía nunca más — ni recargando, porque
    // `refunded` no tiene transición de salida y el guard de arriba corta con refund_not_available.
    // Sin confirmación NO se escribe nada: la remesa queda como estaba, o sea recuperable.
    // Esto NO es tragarse un error. Es distinguir "no volvió" de "todavía no sabemos": el caller
    // recibe cuál de los dos es y lo dice con esas palabras.
    if (confirmation !== "confirmed") return { confirmation, refundTx, remittance: r };

    // Confirmado contra la cadena. Recién ahora el estado terminal, y de acá en adelante NADA puede
    // volver a reportar fallo: sería repetir la mentira que este use-case vino a matar.
    const now = this.clock.nowIso();
    // payout_failed es el único paso previo a `refunded` en la FSM. Desde payout_failed ya estamos.
    if (r.status !== "payout_failed") r.markPayoutFailed(ESCROW_REFUNDED_BY_SENDER, now);
    r.markRefunded(refundTx, now);
    try {
      await this.repo.save(r);
    } catch {
      // Persistir falló (localStorage lleno / CAS perdido contra otra pestaña). El agregado EN
      // MEMORIA ya dice `refunded` con su signature, así que el caller devuelve la verdad; lo que se
      // pierde es la durabilidad, no el hecho. Propagar el error acá haría que la pantalla dijera
      // "no pudimos recuperar" sobre plata que ya volvió.
      // ⚠️ Cuánto dura esa verdad depende del caller: mientras alguien re-lea el estado PERSISTIDO y
      // pise el de memoria, vuelve el viejo. El poll de la pantalla hacía exactamente eso 1,5 s
      // después (`onOpenFromHistory`, `flow.tsx:367`) — por eso ahora NO arranca sobre un estado que ya no avanza solo.
    }
    return { confirmation, refundTx, remittance: r };
  }
}
