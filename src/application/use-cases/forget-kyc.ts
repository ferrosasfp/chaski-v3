import type { KycStore, KycPendingStore, RemittanceRepository } from "../ports";

/** Reset explícito del KYC-once (WKH-184, Opción D): olvida la verificación recordada para esta
 *  address Y limpia cualquier pending en curso, para forzar re-verificación completa.
 *  WKH-201: además purga la PII persistida del beneficiario (repo) best-effort al desconectar.
 *
 *  🔴 QUÉ **NO** OLVIDA, DESDE WKH-333 (R-2). Lo de arriba decía "forzar re-verificación completa", y
 *  desde que el veredicto vive en una fila server-side eso dejó de ser cierto: este use-case borra
 *  SÓLO lo del navegador (`localStorage`). La fila de `kyc_verdicts` de esa dirección **sigue
 *  existiendo**, y con el flag encendido sigue siendo la que autoriza el pago. Input que lo muestra:
 *  apretar "¿No sos vos?" y volver a conectar la MISMA billetera — el flujo saltea la verificación
 *  igual, porque `ConnectWallet` consulta al servidor y el servidor todavía tiene la fila.
 *
 *  El código NO se toca acá a propósito. Borrar la fila server-side desde el cliente exigiría un
 *  endpoint de borrado tras PoP, que es superficie nueva del money-path (quien pueda borrarla puede
 *  dejar a alguien sin poder pagar). Queda declarado como residual, no arreglado a medias. */
export class ForgetKyc {
  constructor(
    private readonly kycStore: KycStore,
    private readonly pending: KycPendingStore,
    private readonly repo: RemittanceRepository,
  ) {}

  async execute(input: { address: string }): Promise<void> {
    try {
      await this.kycStore.clear(input.address); // AC-1/2 — best-effort (CD-8)
    } catch {
      /* storage roto: no rompe el reset (AC-5/CD-8) */
    }
    try {
      await this.pending.clear(); // AC-3 — limpia el pending
    } catch {
      /* storage roto: execute() NUNCA rechaza por storage (CD-8) */
    }
    try {
      await this.repo.clearByOwner(input.address); // WKH-201/AC-1 — best-effort (CD-2)
    } catch {
      /* AC-4: storage roto no rompe el reset (CD-2) */
    }
  }
}
