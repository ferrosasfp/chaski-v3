import type { KycVerification } from "../../domain/remittance";
import type {
  KycStore,
  KycVerdictGateway,
  KycVerdictLookup,
  WalletPossessionProof,
  PruebaDePosesionPorEnlace,
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
 * momento porque para cuando la persona llega a pagar, la fila ya existe.
 *
 * 🔴 QUÉ PASA SI RECHAZA LA FIRMA — corregido tras medirlo (AR/BLQ-ALTO-2). Acá decía "el desenlace
 * es `not_asked/pop_declined` y todo sigue como hoy". La primera mitad es cierta; la segunda era
 * FALSA: `/api/kyc/session` exigía la misma prueba, devolvía 403 y `DiditKycGateway.start` lo
 * convertía en un throw, así que rechazar la firma dejaba a la persona sin poder ni empezar el KYC.
 * Hoy sí es cierta, y el candado es `connect-wallet.kyc-session.test.ts`, que arranca acá con un
 * `prove()` que rechaza y termina midiendo que la sesión de Didit SE CREA.
 *
 * Lo que NO se arregla, y se dice: esa sesión se crea **sin atar** a ninguna dirección, así que no
 * produce fila del veredicto. Para PAGAR va a hacer falta una firma igual (`prepare` exige PoP desde
 * WKH-206). Y la salida depende de si esta billetera tuvo alguna vez una verificación ATADA: si la
 * tuvo, reconectar y aceptar la firma alcanza —este mismo `ensure()` rellena la fila desde la pista
 * del navegador, sin gastar otra verificación—; si su única verificación es la que se hizo sin
 * firmar, el backfill NO la rescata (la autoridad rechaza un `vendor_data` vacío) y hay que
 * verificarse de nuevo. El razonamiento completo está en `app/api/kyc/session/route.ts`, bloque S5.
 */
export class ConnectWallet {
  constructor(
    private readonly wallet: WalletPort,
    private readonly store: KycStore,
    /** Opcional: sin gateway cableado el use-case se comporta EXACTAMENTE como antes de WKH-333
     *  (`serverVerdict` ausente ⇒ el flujo cae al camino de hoy). Es lo que mantiene byte-idéntico
     *  al demo y a cualquier composición que no lo inyecte. */
    private readonly verdictGateway?: KycVerdictGateway,
    /** WKH-359/AC-3 — cómo se consigue la prueba de posesión cuando NO hay extensión de billetera.
     *  ⚠️ OPCIONAL por la MISMA razón que `verdictGateway`: sin él este use-case se comporta
     *  EXACTAMENTE como antes de esta HU. ⛔ Y esa opcionalidad NO es la que CD-2 prohíbe: no vuelve
     *  el PoP opcional (el servidor lo sigue exigiendo), sino que describe una composición que no lo
     *  cableó. El que sí es requerido, y donde el fail-open importaría, es el del money-path
     *  (`pop`, `./confirm-and-send.ts:174`). Quien lo cablea de verdad es
     *  (`connectWallet`, `../../composition/container.ts:185`), y eso tiene test propio. */
    private readonly pop?: PruebaDePosesionPorEnlace,
  ) {}

  /**
   * WKH-359/AC-3 — DOS DESENLACES, y la suspensión SUBE POR EL TIPO (DT-4/CD-17).
   *
   * 🔴 POR QUÉ NO UN CAMPO OPCIONAL `irA?`, que es lo que parece más barato: colapsaría el segundo
   * desenlace en la AUSENCIA de algo, y una ausencia no lleva carga. Es el MISMO argumento, con las
   * mismas palabras, que este repo ya escribió para (`AutorizacionDelPrincipal`, `../ports.ts:1185`)
   * y para (`RemittanceIdLookup`, `../ports.ts:467`): quien la reciba tiene que quedar OBLIGADO por
   * el compilador a mirar el `irA`.
   *
   * ⚠️ `address` VIAJA EN LAS DOS VARIANTES, y no es una comodidad: cuando esto suspende,
   * `wallet.connect()` YA corrió y la dirección ya se conoce. Ponerla sólo en `listo` obligaría a los
   * call-sites que únicamente necesitan la dirección —`resolveSender` de "Mis envíos"— a manejar una
   * suspensión que a ellos no les cambia nada.
   */
  async execute(): Promise<
    | {
        estado: "listo";
        address: string;
        rememberedKyc: KycVerification | null;
        serverVerdict?: KycVerdictLookup;
        /** La prueba de posesión que se usó para consultar el veredicto. Viaja hasta la creación de la
         *  sesión de Didit, que también la exige (R-1), para que haya UNA sola firma por sesión. */
        kycProof?: WalletPossessionProof;
      }
    | { estado: "hay-que-salir"; address: string; irA: string; esperando: "firma-pop-kyc" }
  > {
    const address = await this.wallet.connect();
    const rememberedKyc = await this.store.get(address);
    if (!this.verdictGateway) return { estado: "listo", address, rememberedKyc };

    // 🔴 EL PASO DE LA PRUEBA, Y ⛔ FUERA DEL `try` DE ABAJO (es el mutante de `T-067-5`). Si viviera
    // adentro, el `catch` —que se traga TODO lo que salga del gateway, correctamente— se comería
    // también la suspensión, `serverVerdict` y `kycProof` quedarían `undefined`, y estaríamos
    // exactamente en el bug que esta wave vino a cerrar: sesión de Didit sin atar, sin fila, y 403 en
    // `prepare` para toda billetera nueva.
    let yaConseguida: WalletPossessionProof | undefined;
    if (this.pop) {
      const permiso = await this.pop.pedir({ proposito: "pop-kyc", direccion: address });
      // `no-corresponde` (camino inyectado) y `no-se-puede` (emisor apagado / sin disco) siguen por el
      // camino de hoy, y eso NO es degradar el PoP: el gateway de abajo lo va a pedir por su cuenta en
      // el camino inyectado, y en el por enlace la falta de veredicto la corta el SERVIDOR con 403.
      // ⛔ Lo que no se puede es impedir conectar, que es la puerta de entrada a todo (CD-15).
      if (permiso.estado === "hay-que-salir") {
        return { estado: "hay-que-salir", address, irA: permiso.irA, esperando: "firma-pop-kyc" };
      }
      if (permiso.estado === "listo") yaConseguida = permiso.proof;
    }

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
      const ensured = await this.verdictGateway.ensure(address, candidate, yaConseguida);
      serverVerdict = ensured.lookup;
      kycProof = ensured.proof;
    } catch {
      // 🔴 UN FALLO ACÁ NO PUEDE ROMPER EL CONNECT (CD-15, M-20). Conectar la billetera es la puerta
      // de entrada a TODO: si una excepción de este gateway se propagara, una caída de nuestra propia
      // API dejaría a la persona sin poder ni empezar. `undefined` ⇒ el flujo sigue el camino de hoy
      // (se crea la sesión de Didit), que es el desenlace correcto y ya probado.
      serverVerdict = undefined;
    }
    return { estado: "listo", address, rememberedKyc, serverVerdict, kycProof };
  }
}
