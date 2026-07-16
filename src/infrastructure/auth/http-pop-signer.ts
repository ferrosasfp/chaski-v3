// Infrastructure — PopSigner sobre HTTP (WKH-206). Pide un challenge server-emitido a
// /api/a2a/payout/challenge para `address`, lo firma con la wallet conectada (personal_sign) y
// devuelve { challenge, signature } para que el use-case lo adjunte al submit del payout.
//
// Contrato 501-vs-otros-errores (DT-2, fix-pack AR-MNR-1):
//   · 501 (`pop_not_configured`, secreto server-only ausente = mecanismo APAGADO) ⇒ devuelve `null`:
//     el use-case lo trata como SKIP y NO adjunta campos ⇒ el submit sigue byte-idéntico al demo.
//   · Cualquier OTRO !ok (400 request malo, 5xx en un deployment genuinamente ON) o un fallo de red
//     (fetch rechaza) ⇒ LANZA: el use-case lo degrada CONTROLADO por su camino de error (failAndRefund),
//     nunca deja la remesa varada. (Antes lanzaba en TODO !ok, incluido el 501 — divergía de DT-2.)
import type { PopSigner, WalletPort } from "../../application/ports";

export class HttpPopSigner implements PopSigner {
  constructor(private readonly wallet: WalletPort) {}

  async prove(address: string): Promise<{ challenge: string; signature: string } | null> {
    const res = await fetch("/api/a2a/payout/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    });
    if (res.status === 501) return null; // DT-2: mecanismo apagado server-side ⇒ SKIP (no adjunta campos)
    if (!res.ok) throw new Error("pop_challenge_unavailable"); // 400/5xx en ON ⇒ fail-closed controlado
    const { popChallenge, popMessage } = (await res.json()) as {
      popChallenge: string;
      popMessage: string;
    };
    // El cliente firma el popMessage VERBATIM (CD-10): NO reconstruye el string.
    const signature = await this.wallet.signMessage(popMessage);
    return { challenge: popChallenge, signature };
  }
}
