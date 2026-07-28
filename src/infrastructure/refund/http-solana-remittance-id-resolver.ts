// Infrastructure — SolanaRemittanceIdResolver sobre HTTP (HU-SOL-20/AC-2). Recupera los remittanceId
// del sender desde el store durable server-side cuando el cliente los perdió (localStorage borrado,
// otro dispositivo, incógnito): sin el remittanceId no se puede derivar la PDA del escrow y los fondos
// quedan inalcanzables aunque el `refund` trustless funcione perfecto on-chain.
//
// Exemplar: auth/http-pop-signer.ts (mismo patrón challenge → firma → POST). El endpoint exige el PoP,
// así que acá se firma ANTES de pedir: sin prueba de posesión el server responde 403 (CD-16).
//
// Contrato de degradación (NUNCA lanza por "no hay nada"):
//   · pop.prove() → null (mecanismo PoP apagado server-side) ⇒ [] — sin PoP no hay recuperación.
//   · 501 (ledger apagado / envs Supabase ausentes) o 403 (no verificado) ⇒ [] — sin candidatos.
//   · cualquier otro !ok (429/502/red) ⇒ LANZA: es un fallo real y el caller debe verlo fail-loud.
import type { PopSigner, SolanaRemittanceIdResolver } from "../../application/ports";

export class HttpSolanaRemittanceIdResolver implements SolanaRemittanceIdResolver {
  constructor(private readonly pop: PopSigner) {}

  async listBySender(sender: string): Promise<string[]> {
    const proof = await this.pop.prove(sender); // null ⇒ mecanismo PoP apagado server-side
    if (!proof) return []; // sin PoP no hay recuperación posible: lista vacía
    const res = await fetch("/api/solana/escrow/remittance-ids", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender, popChallenge: proof.challenge, popSignature: proof.signature }),
    });
    if (res.status === 501 || res.status === 403) return []; // apagado / no verificado ⇒ sin candidatos
    if (!res.ok) throw new Error("escrow_recovery_unavailable");
    const body = (await res.json()) as { remittanceIds?: Array<{ remittanceId?: unknown }> };
    return (body.remittanceIds ?? [])
      .map((r) => (typeof r.remittanceId === "string" ? r.remittanceId : ""))
      .filter((s) => s.length > 0);
  }
}
