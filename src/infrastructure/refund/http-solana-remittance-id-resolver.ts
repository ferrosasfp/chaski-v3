// Infrastructure — SolanaRemittanceIdResolver sobre HTTP (HU-SOL-20/AC-2). Recupera los remittanceId
// del sender desde el store durable server-side cuando el cliente los perdió (localStorage borrado,
// otro dispositivo, incógnito): sin el remittanceId no se puede derivar la PDA del escrow y los fondos
// quedan inalcanzables aunque el `refund` trustless funcione perfecto on-chain.
//
// Exemplar: auth/http-pop-signer.ts (mismo patrón challenge → firma → POST). El endpoint exige el PoP,
// así que acá se firma ANTES de pedir: sin prueba de posesión el server responde 403 (CD-16).
//
// Contrato de desenlaces (`lookupBySender`, la primitiva — WKH-327, 2º fix-pack AR/BLQ-MED-2):
//   · pop.prove() → null (mecanismo PoP apagado server-side) ⇒ not_asked/pop_disabled
//   · 501 (ledger apagado / envs Supabase ausentes)          ⇒ not_asked/registry_disabled
//   · 403 (la prueba de posesión no verificó)                ⇒ not_asked/pop_rejected
//   · cualquier otro !ok (429/502/red) ⇒ LANZA: es un fallo real y el caller debe verlo fail-loud.
//   · 200 ⇒ answered, con la lista (que puede venir vacía, y eso SÍ habla de la billetera).
//
// 🔴 LAS TRES PRIMERAS NO SON "no hay nada": son "no llegamos a preguntar", y colapsarlas en una lista
// vacía hace que la pantalla afirme haber mirado 20 envíos cuando no miró ninguno. Eso se midió
// palabra por palabra y es el bloqueante que este archivo cierra. El método que las colapsaba a `[]`
// para el refund se borró en WKH-331: hoy esta clase expone un solo método, y devuelve el desenlace.
import type {
  PopSigner,
  RemittanceIdLookup,
  SolanaRemittanceIdResolver,
} from "../../application/ports";

export class HttpSolanaRemittanceIdResolver implements SolanaRemittanceIdResolver {
  constructor(private readonly pop: PopSigner) {}

  async lookupBySender(sender: string): Promise<RemittanceIdLookup> {
    const proof = await this.pop.prove(sender); // null ⇒ mecanismo PoP apagado server-side
    if (!proof) return { outcome: "not_asked", reason: "pop_disabled" }; // ni se pidieron los ids
    const res = await fetch("/api/solana/escrow/remittance-ids", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sender, popChallenge: proof.challenge, popSignature: proof.signature }),
    });
    // Separados y no colapsados: son dos causas distintas (una es config nuestra, la otra es la firma).
    if (res.status === 501) return { outcome: "not_asked", reason: "registry_disabled" };
    if (res.status === 403) return { outcome: "not_asked", reason: "pop_rejected" };
    if (!res.ok) throw new Error("escrow_recovery_unavailable");
    const body = (await res.json()) as { remittanceIds?: Array<{ remittanceId?: unknown }> };
    const remittanceIds = (body.remittanceIds ?? [])
      .map((r) => (typeof r.remittanceId === "string" ? r.remittanceId : ""))
      .filter((s) => s.length > 0);
    return { outcome: "answered", remittanceIds }; // el servidor contestó, aunque sea con nada
  }
}
