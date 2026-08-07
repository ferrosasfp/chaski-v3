// Infrastructure — KycVerdictGateway sobre HTTP (WKH-333/AC-13, CD-15, CD-16). Pregunta al servidor
// si esta billetera ya tiene un veredicto de KYC utilizable, y de paso le pasa la PISTA del navegador
// para que el servidor pueda rellenar la fila que falta (backfill, AC-8).
//
// Exemplar: `refund/http-solana-remittance-id-resolver.ts` (mismo patrón firma → POST → desenlaces
// tipados). El endpoint exige la prueba de posesión, así que acá se firma ANTES de pedir.
//
// Contrato de desenlaces — CUATRO causas de "no llegamos a preguntar", y NINGUNA es "no hay":
//   · pop.prove() → null   (mecanismo PoP apagado server-side, 501 del emisor) ⇒ not_asked/pop_disabled
//   · pop.prove() LANZA    (la persona rechazó la firma, o el emisor falló)   ⇒ not_asked/pop_declined
//   · 501                  (la tabla está apagada / sin envs)                 ⇒ not_asked/store_disabled
//   · 403                  (la prueba de posesión no verificó)                ⇒ not_asked/pop_rejected
//   · 200 con verdict      ⇒ usable
//   · 200 sin verdict      ⇒ absent, CON el motivo que el servidor declaró (venció / es simulada /
//                            no fue aprobada / no hay fila). Eso SÍ es una respuesta.
//   · cualquier otro !ok (429/502/red) ⇒ LANZA. Es un fallo real y el caller debe verlo; `ConnectWallet`
//     lo degrada a "seguimos como hoy" sin romper el flujo (T-CW-2).
//
// 🔴 POR QUÉ LAS CUATRO PRIMERAS NO SE COLAPSAN (CD-16, M-18). Las cuatro terminan en el mismo lugar
// —se crea la sesión de Didit, como hoy— así que colapsarlas no rompe nada VISIBLE. Lo que rompe es
// poder decir por qué se gastó un cupo del tier gratuito. Y el día que alguien use el desenlace como
// entrada de una decisión, "no pude preguntar" leído como "ya está verificada" deja a la persona sin
// verificación y sin poder pagar. El input que lo distingue: apagar `PAYOUT_POP_SECRET` — con los
// cuatro colapsados, el sistema no puede diferenciar eso de "esta billetera nunca se verificó".
import type {
  KycVerdictEnsureResult,
  KycVerdictGateway,
  KycVerdictLookup,
  PopSigner,
} from "../../application/ports";

interface VerdictResponse {
  verdict?: {
    riskLevel?: unknown;
    provenance?: unknown;
    verifiedAt?: unknown;
  } | null;
  reason?: unknown;
}

const ABSENT_REASONS = ["absent", "expired", "simulated", "not_approved"] as const;
type AbsentReason = (typeof ABSENT_REASONS)[number];

function readAbsentReason(v: unknown): AbsentReason {
  // Un `reason` que este cliente no conoce cuenta como `absent`: la respuesta existe (el servidor
  // contestó), pero no podemos afirmar de qué motivo habla. No se inventa uno de los otros tres.
  return (ABSENT_REASONS as readonly string[]).includes(v as string) ? (v as AbsentReason) : "absent";
}

function readRiskLevel(v: unknown): "low" | "medium" | "high" {
  return v === "low" || v === "medium" ? v : "high"; // fail-safe, igual que el lector server-side
}

export class HttpKycVerdictGateway implements KycVerdictGateway {
  constructor(private readonly pop: PopSigner) {}

  async ensure(address: string, candidateVerificationId?: string): Promise<KycVerdictEnsureResult> {
    let proof: Awaited<ReturnType<PopSigner["prove"]>>;
    try {
      proof = await this.pop.prove(address);
    } catch {
      // La causa típica y esperable: la persona vio el prompt de la billetera y dijo que no. NO es un
      // error del sistema y NO puede impedir verificarse (CD-15): se sigue por el camino de hoy.
      // ⚠️ ESTA FRASE ERA FALSA CUANDO SE ESCRIBIÓ, y el test que la vuelve verdadera es
      // `connect-wallet.kyc-session.test.ts`: `/api/kyc/session` exigía la prueba, así que este
      // desenlace terminaba en `throw didit_session_failed` y la persona no podía verificarse
      // (AR/BLQ-ALTO-2). Hoy esa ruta crea la sesión sin atar cuando no hay prueba. La frase se
      // conserva porque ahora describe lo que pasa, con un input que lo mide.
      return { lookup: { outcome: "not_asked", reason: "pop_declined" } };
    }
    if (!proof) return { lookup: { outcome: "not_asked", reason: "pop_disabled" } };
    // 🔴 ESTA ES LA ÚNICA FIRMA DE BILLETERA DE TODO EL FLUJO DE KYC. Se devuelve al caller para que
    // la sesión de Didit (`/api/kyc/session`, que también la exige desde WKH-333/R-1) no tenga que
    // pedir una segunda. Si esto dejara de viajar, la persona vería dos prompts seguidos.
    const out = (lookup: KycVerdictLookup): KycVerdictEnsureResult => ({ lookup, proof: proof ?? undefined });

    const res = await fetch("/api/kyc/verdict", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sender: address,
        popChallenge: proof.challenge,
        popSignature: proof.signature,
        // La PISTA, y sólo la pista. El servidor NO le cree: la re-consulta contra la autoridad de
        // KYC y persiste únicamente si vuelve autorizada (AC-8).
        ...(candidateVerificationId ? { candidateVerificationId } : {}),
      }),
    });
    // Separados y no colapsados: son dos causas distintas (una es config nuestra, la otra es la firma).
    if (res.status === 501) return out({ outcome: "not_asked", reason: "store_disabled" });
    if (res.status === 403) return out({ outcome: "not_asked", reason: "pop_rejected" });
    if (!res.ok) throw new Error("kyc_verdict_unavailable");

    const body = (await res.json()) as VerdictResponse;
    const v = body.verdict;
    if (!v || typeof v.verifiedAt !== "string" || typeof v.provenance !== "string") {
      return out({ outcome: "absent", reason: readAbsentReason(body.reason) });
    }
    return out({
      outcome: "usable",
      verdict: {
        riskLevel: readRiskLevel(v.riskLevel),
        provenance: v.provenance,
        verifiedAt: v.verifiedAt,
      },
    });
  }
}
