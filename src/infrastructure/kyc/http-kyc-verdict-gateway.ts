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
// poder decir por qué se la mandó a escanear otra vez —⚠️ acá decía "por qué se gastó un cupo del tier gratuito", y CREAR la sesión no gasta: sólo COMPLETAR (`app/api/kyc/session/route.ts`)—. Y el día que alguien use el desenlace como
// entrada de una decisión, "no pude preguntar" leído como "ya está verificada" deja a la persona sin
// verificación y sin poder pagar. El input que lo distingue: apagar `PAYOUT_POP_SECRET` — con los
// cuatro colapsados, el sistema no puede diferenciar eso de "esta billetera nunca se verificó".
import type {
  KycVerdictEnsureResult,
  KycVerdictGateway,
  KycVerdictLookup,
  PopSigner,
  WalletPossessionProof,
} from "../../application/ports";

interface VerdictResponse {
  verdict?: {
    riskLevel?: unknown;
    provenance?: unknown;
    verifiedAt?: unknown;
  } | null;
  reason?: unknown;
}

const ABSENT_REASONS = ["absent", "expired", "not_approved"] as const; // EN ESTA LÍNEA: `solana-wallet.ts:2374` cita `:60` de este archivo por número. WKH-233 — `"simulated"` se fue de `KycVerdictAbsentReason` y por eso se va de acá: la fila del veredicto se escribe SÓLO con `payoutAllowed === true` del agente de KYC, así que una fila que existe es real por invariante y ningún servidor puede emitir ya ese motivo. Un servidor viejo que lo emitiera cae en la rama de `readAbsentReason` y cuenta como `absent`, que es el fail-safe correcto: la respuesta existe, pero este cliente no puede afirmar de qué motivo habla
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

  // 🔴 WKH-359/AC-3 — EL 3er ARGUMENTO ES LA PRUEBA YA CONSEGUIDA, y es el eslabón entero de esta HU.
  // Sin él, en el camino por enlace `this.pop.prove()` tira `wallet_sign_not_available` (no hay
  // bridge en un móvil), el `catch` de abajo lo convierte —correctamente— en
  // `not_asked/pop_declined` **EN SILENCIO**, y a partir de ahí:
  //   · `ConnectWallet` devuelve `kycProof: undefined`;
  //   · `/api/kyc/session` crea la sesión de Didit **SIN ATAR** (el `vendor_data` no viaja);
  //   · `persistKycVerdict` corta y NO ESCRIBE FILA — su gate es `d.payoutAllowed !== true`;
  //   · y `prepare` contesta 403 `prepare_kyc_verdict_missing`, sin ningún respaldo: esa route
  //     declara que no hay `?? body.kycVerificationId` ni env que lo habilite.
  // ⚠️ Y LO PELIGROSO ES QUE NO SE VE: una billetera que YA tiene fila del veredicto cierra igual, así
  // que el bug no aparece en la corrida de quien ya se verificó y le pasa a cada persona nueva.
  // ⛔ EL `catch` DE ABAJO NO SE ESTRECHA (CD-17): sigue tragándose todo lo que salga de `prove()`,
  // porque un fallo del PoP no puede impedir verificarse. Lo que cambia es que cuando la prueba YA
  // está, no se le pide nada a nadie y no hay excepción que tragar.
  async ensure(
    address: string,
    candidateVerificationId?: string,
    yaConseguida?: WalletPossessionProof,
  ): Promise<KycVerdictEnsureResult> {
    let proof: Awaited<ReturnType<PopSigner["prove"]>>;
    if (yaConseguida) {
      proof = yaConseguida;
    } else {
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
