import type { RemittanceState } from "../../domain/remittance";
import type { Clock, KycGateway, KycPendingStore, KycStore, RemittanceRepository } from "../ports";

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

    const res = await this.kyc.start({
      amountUsd: s.sendUsd.major,
      beneficiary: s.beneficiary,
      purpose: input.purpose ?? "family support",
      callbackUrl: input.callbackUrl,
      senderAddress: input.address, // rate-limit por address (WKH-179)
    });

    if (res.kind === "completed") {
      const v = res.verification;
      if (v.approved && v.payoutAllowed) await this.kycStore.save(input.address, v);
      r.applyKyc(v, this.clock.nowIso());
      await this.repo.save(r);
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
