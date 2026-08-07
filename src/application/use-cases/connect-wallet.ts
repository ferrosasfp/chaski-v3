import type { KycVerification } from "../../domain/remittance";
import type {
  KycStore,
  KycVerdictGateway,
  KycVerdictLookup,
  WalletPossessionProof,
  WalletPort,
} from "../ports";

/**
 * Conecta la wallet (el "login" de la DApp) y devuelve la address + el KYC recordado (si lo hay),
 * para que el flujo sepa si saltear la verificación (KYC-once).
 *
 * 🔴 ACÁ VA EL VEREDICTO SERVER-SIDE, Y NO EN `StartKyc` (WKH-333/AC-20). El input que lo decide está
 * medido en `start-kyc.ts`: cuando el store local tiene un veredicto aprobado, ese use-case SALE
 * ANTES, sin consultar ni backfillear nada. Esa es exactamente la población que HOY ya está
 * verificada en ese navegador ⇒ con el `ensure()` allá, nunca correría para ellos ⇒ llegarían a
 * `prepare` sin fila ⇒ con el corte sin respaldo de AC-17, la app se rompe para los usuarios
 * actuales. Y `flow.tsx` salta de `connect` directo a `confirm` en ese caso: la pantalla de
 * verificación ni se muestra. Conectar es el único momento que corre en TODOS los caminos.
 *
 * COSTO DE UX, DICHO: una firma de billetera al conectar. Hoy conectar no pide ninguna. Se elige ese
 * momento porque para cuando la persona llega a pagar, la fila ya existe. Si RECHAZA la firma, el
 * desenlace es `not_asked/pop_declined` y todo sigue como hoy (AC-13/CD-15).
 */
export class ConnectWallet {
  constructor(
    private readonly wallet: WalletPort,
    private readonly store: KycStore,
    /** Opcional: sin gateway cableado el use-case se comporta EXACTAMENTE como antes de WKH-333
     *  (`serverVerdict` ausente ⇒ el flujo cae al camino de hoy). Es lo que mantiene byte-idéntico
     *  al demo y a cualquier composición que no lo inyecte. */
    private readonly verdictGateway?: KycVerdictGateway,
  ) {}

  async execute(): Promise<{
    address: string;
    rememberedKyc: KycVerification | null;
    serverVerdict?: KycVerdictLookup;
    /** La prueba de posesión que se usó para consultar el veredicto. Viaja hasta la creación de la
     *  sesión de Didit, que también la exige (R-1), para que haya UNA sola firma por sesión. */
    kycProof?: WalletPossessionProof;
  }> {
    const address = await this.wallet.connect();
    const rememberedKyc = await this.store.get(address);
    if (!this.verdictGateway) return { address, rememberedKyc };

    // La PISTA para el backfill sale de `peek()` y NO de `get()`: `get()` devuelve null pasados los
    // 180 días del caché de dispositivo, y esa entry vencida es justamente la población que el
    // backfill existe para salvar. No autoriza nada — el servidor la re-consulta contra la autoridad.
    let candidate: string | undefined;
    try {
      candidate = (await this.store.peek(address))?.verification.verificationId || undefined;
    } catch {
      candidate = undefined; // un localStorage roto no puede impedir conectar
    }

    let serverVerdict: KycVerdictLookup | undefined;
    let kycProof: WalletPossessionProof | undefined;
    try {
      const ensured = await this.verdictGateway.ensure(address, candidate);
      serverVerdict = ensured.lookup;
      kycProof = ensured.proof;
    } catch {
      // 🔴 UN FALLO ACÁ NO PUEDE ROMPER EL CONNECT (CD-15, M-20). Conectar la billetera es la puerta
      // de entrada a TODO: si una excepción de este gateway se propagara, una caída de nuestra propia
      // API dejaría a la persona sin poder ni empezar. `undefined` ⇒ el flujo sigue el camino de hoy
      // (se crea la sesión de Didit), que es el desenlace correcto y ya probado.
      serverVerdict = undefined;
    }
    return { address, rememberedKyc, serverVerdict, kycProof };
  }
}
