import type { RemittanceState } from "../../domain/remittance";
import type {
  Clock,
  KycGateway,
  KycPendingStore,
  KycStore,
  KycVerdictLookup,
  RemittanceRepository,
  WalletPossessionProof,
} from "../ports";

/**
 * Inicia la verificación de identidad.
 * - KYC-once: si la wallet ya tiene un KYC aprobado recordado → lo reusa (done, sin redirect).
 * - Simulación (server sin key) → resuelve directo (done).
 * - Didit real → devuelve un redirect; persiste el pendiente para retomar al volver.
 */
export type StartKycResult =
  | { kind: "done"; snapshot: Readonly<RemittanceState> }
  | { kind: "redirect"; url: string };

export class StartKyc {
  constructor(
    private readonly kyc: KycGateway,
    private readonly kycStore: KycStore,
    private readonly pending: KycPendingStore,
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: {
    remittanceId: string;
    address: string;
    callbackUrl?: string;
    purpose?: string;
    /**
     * WKH-333/AC-7' — el veredicto server-side que `ConnectWallet` ya consultó. Entra por argumento y
     * NO se pide acá para que haya UNA sola firma de billetera por sesión y UN solo lugar que
     * consulta. Ausente ⇒ camino de hoy.
     *
     * POR QUÉ ESTO NO VIOLA CD-18 (nada de confiar en un valor que viene del cliente): **no es un
     * guard de seguridad**. Lo único que decide es si se gasta un cupo del tier gratuito de Didit. El
     * guard del dinero es `prepare`, server-side y PoP-bound, y no lee nada de esto. Input que lo
     * refuta: forjar `serverVerdict = {outcome:"usable"}` en el cliente — el resultado es que la
     * persona NO obtiene sesión de KYC y NO puede pagar (`prepare` corta por falta de fila). Es
     * denegación del propio servicio, no escalación.
     *
     * 🔴 SÓLO `usable` saltea. `not_asked` (las cuatro razones) y `absent` (las cuatro) siguen al
     * camino de hoy: "no pude preguntar" NO es "ya está verificada" (CD-16, M-19).
     */
    serverVerdict?: KycVerdictLookup;
    /** WKH-333/R-1 — la prueba de posesión que `ConnectWallet` ya obtuvo. Viaja hasta
     *  `/api/kyc/session`, que la exige para atar la sesión a una dirección PROBADA en vez de a un
     *  valor del body. Ausente ⇒ la ruta responde 403 (con key) o cae al demo (sin key). */
    kycProof?: WalletPossessionProof;
  }): Promise<StartKycResult> {
    const r = await this.repo.get(input.remittanceId);
    if (!r) throw new Error("remittance_not_found");
    const s = r.snapshot;

    r.startKyc(this.clock.nowIso(), input.address);

    // KYC-once: reusar la verificación recordada para esta wallet si ya pasó.
    const remembered = await this.kycStore.get(input.address);
    if (remembered && remembered.approved && remembered.payoutAllowed) {
      r.applyKyc(remembered, this.clock.nowIso());
      await this.repo.save(r);
      return { kind: "done", snapshot: r.snapshot };
    }

    // WKH-333/AC-7' — KYC-once ENTRE DISPOSITIVOS. Si el servidor dice que esta billetera ya tiene un
    // veredicto utilizable, no se crea una sesión nueva de Didit: es el cupo del tier gratuito que la
    // misma persona gastaba dos veces por entrar desde el teléfono y desde la computadora.
    //
    // 🔴 SÓLO `usable`. `not_asked` y `absent` caen acá abajo, al camino de hoy. Colapsarlos en
    // "ya está verificada" (M-19) dejaría a la persona sin sesión de KYC y sin poder pagar, y el
    // desenlace más probable de los tres es justamente `not_asked` (lo dispara una BANDERA o un
    // rechazo de firma, no una caída).
    //
    // `verificationId: null` es literal, no un placeholder: este navegador NO tiene el identificador
    // y no puede tenerlo (AC-6). Fabricarlo sería inventar evidencia.
    const sv = input.serverVerdict;
    if (sv?.outcome === "usable") {
      const fromServer = {
        verificationId: null,
        approved: true,
        payoutAllowed: true,
        riskLevel: sv.verdict.riskLevel,
        provenance: sv.verdict.provenance,
        identity: null, // el servidor no persiste PII y este cliente no la recibe (CD-2)
      };
      r.applyKyc(fromServer, this.clock.nowIso());
      await this.repo.save(r);
      // NO se escribe el caché de dispositivo: la fuente de verdad es la fila del servidor, y una
      // copia local con `verificationId: null` sólo agregaría una segunda verdad que envejece sola.
      return { kind: "done", snapshot: r.snapshot };
    }

    const res = await this.kyc.start({
      amountUsd: s.sendUsd.major,
      beneficiary: s.beneficiary,
      purpose: input.purpose ?? "family support",
      callbackUrl: input.callbackUrl,
      senderAddress: input.address, // rate-limit por address (WKH-179)
      // WKH-333/R-1: la MISMA prueba de la lectura del veredicto. Sin esto, la ruta de sesión
      // volvería a atar la verificación a una dirección que nadie probó poseer.
      popChallenge: input.kycProof?.challenge,
      popSignature: input.kycProof?.signature,
    });

    if (res.kind === "completed") {
      const v = res.verification;
      r.applyKyc(v, this.clock.nowIso());
      await this.repo.save(r);
      if (v.approved && v.payoutAllowed) await this.kycStore.save(input.address, v);
      return { kind: "done", snapshot: r.snapshot };
    }

    // redirect: guardar PRIMERO el pendiente; solo si eso funciona, persistir la remesa en kyc_pending.
    // Si pending.save() lanza (quota / private-browsing), repo.save(r) NO corre → la remesa sigue
    // persistida en "quoted" (WKH-187: cotiza antes del KYC, ese es su último estado guardado) → el
    // retry hace quoted→kyc_pending (válido).
    await this.pending.save({
      remittanceId: input.remittanceId,
      sessionId: res.sessionId,
      address: input.address,
      sessionToken: res.authToken, // token HMAC para autorizar el GET /decision al volver (WKH-179)
    });
    await this.repo.save(r); // ← si pending.save lanzó, ESTO no corre → remesa sigue en "quoted"
    return { kind: "redirect", url: res.url };
  }
}
