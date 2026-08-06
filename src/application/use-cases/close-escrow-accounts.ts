// Use-case — WKH-327: cerrar las dos cuentas que el `deposit` dejó abiertas, para que el alquiler que
// el remitente inmovilizó vuelva a su billetera.
//
// POR QUÉ SE LLAMA `CloseEscrowAccounts` Y NO `RecoverEscrowRent`: este use-case CIERRA CUENTAS. Que
// vuelva alquiler es la consecuencia, y la parte de esa consecuencia que se puede afirmar desde acá es
// más chica que el nombre — no conocemos la comisión final de la tx ni la propina que inyecta la
// billetera, así que "recuperar" no tiene un neto que prometer. Nombrar el beneficio en la capa que
// sólo hace el acto es el primer paso para que un test termine asertando el beneficio sin medirlo. El
// beneficio se nombra en el copy, que es donde se puede decir con sus condiciones.
import { canonicalizeAddress } from "../../infrastructure/address";
import type {
  ConnectedWalletProbe,
  SolanaEscrowCloseGateway,
  SolanaEscrowCloseResult,
} from "../ports";

export class CloseEscrowAccounts {
  constructor(
    private readonly escrow: SolanaEscrowCloseGateway,
    // 🔴 La dirección conectada entra POR ACÁ y no por el argumento de `execute`, y ésa es la
    // corrección entera de AR/BLQ-BAJO-1. Cuando entraba por argumento, el único call-site de
    // producción pasaba `connectedAddress: sender` — la MISMA variable — y la comparación de abajo
    // era `x === x`: una rama falsa que no existía en producción y cuatro tests que la ejercitaban
    // construyendo el input a mano.
    //
    // ⚠️ QUÉ CIERRA ESTE CAMBIO Y QUÉ NO, con precisión (AR/MNR-5). Cierra la forma tautológica DESDE
    // EL LLAMADOR: `flow.tsx` recibe el use-case ya construido y no puede elegir qué le entra por acá.
    // NO cierra el CABLEADO: `ConnectedWalletProbe` es una interfaz de un método, así que el composition
    // root puede pasarle `{ getConnectedAddress: () => wallet.getAddress() }` —el cache de `connect()`—
    // y reintroducir el bug entero sin que nada deje de compilar. Eso se midió (la suite completa daba
    // verde con esa línea puesta) y por eso hay un test sobre la línea del container, no sobre este
    // argumento. El riesgo se mudó de lugar; no desapareció.
    private readonly connected: ConnectedWalletProbe,
  ) {}

  /**
   * NO persiste nada y NO toca el repositorio, a diferencia de `RecoverEscrowFunds`. No hay estado que
   * escribir: AC-10 dice que "estas cuentas ya están cerradas" se lee de la AUSENCIA de `escrow_state`
   * en cadena, no de la FSM. Agregarle un estado a `remittance.ts` sería inventar una fuente de verdad
   * paralela a la única que manda acá.
   */
  async execute(input: {
    remittanceId: string;
    sender: string;
  }): Promise<SolanaEscrowCloseResult> {
    // ── AC-7 · guard ANTES de tocar el gateway ──────────────────────────────────────────────────
    // El alquiler vuelve a la billetera que lo PAGÓ (`close = sender` en el programa), así que pedirle
    // el cierre a otra billetera no es sólo inútil: hace firmar una tx que la cadena va a rechazar.
    //
    // Se le pregunta a la billetera VIVA en este instante, no a una copia. El `sender` que llega por
    // argumento es la billetera que PAGÓ el alquiler de ese envío, y en la puerta de descubrimiento
    // (`flow.tsx`, `EscrowRentRecovery`) queda congelado desde que se apretó "Buscar": cambiar de
    // cuenta en Phantom sin recargar no lo mueve. Los dos datos son distintos por naturaleza y ésa es
    // la razón de que este guard exista.
    //
    // `null` ⇒ no hay ninguna billetera conectada. Fail-closed con `wallet_not_connected`, que tiene
    // su propio copy ("Reconectá o desbloqueá tu wallet"), y NO `close_not_sender`: decirle a alguien
    // que su envío es de otra billetera cuando lo que pasa es que no hay ninguna conectada lo manda a
    // buscar un problema que no tiene.
    const connectedAddress = await this.connected.getConnectedAddress();
    if (connectedAddress == null) throw new Error("wallet_not_connected");
    //
    // 🚫 La comparación NUNCA es con `.toLowerCase()` (CD-13). base58 es CASE-SENSITIVE: dos
    // capitalizaciones distintas son dos addresses distintas, y bajarlas a minúsculas fabrica
    // colisiones — es la colisión IDOR que `canonicalizeAddress` existe para cerrar
    // (`infrastructure/address.ts:5-7`). El comentario de `persistence.ts:138` dice "case-insensitive"
    // y el código no lo es: si copiás la premisa de ese comentario, escribís un bug.
    //
    // Qué pasa con una address BASURA, decidido explícitamente y no dejado al azar:
    // `canonicalizeAddress` TIRA ante algo que no parsea (`address.ts:14-18`). Se traduce a
    // `close_not_sender` en vez de dejar salir `address_canonicalization_failed`, porque una address
    // que no podemos parsear es una address que no podemos probar que sea el remitente — el mismo
    // desenlace, fail-closed, y con un copy que la persona ya entiende. Lo que NO se hace es dejarla
    // pasar.
    let sameOwner: boolean;
    try {
      sameOwner = canonicalizeAddress(input.sender) === canonicalizeAddress(connectedAddress);
    } catch {
      sameOwner = false;
    }
    if (!sameOwner) throw new Error("close_not_sender");

    // Propaga el desenlace TAL CUAL, con sus tres valores. Defaultearlo a "confirmed" acá tiraría a la
    // basura la única lectura que prueba algo (la ausencia de `escrow_state`).
    return this.escrow.close({ remittanceId: input.remittanceId, sender: input.sender });
  }
}
