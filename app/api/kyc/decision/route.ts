// Server-side: consulta la decisión de una sesión Didit y la mapea a nuestro modelo.
// GET /v3/session/{id}/decision/ con header x-api-key. Env-gated (501 si no hay key).
// WKH-179: exige token HMAC de sesión (x-kyc-token) → cierra el IDOR/PII-leak (B1). El
// documentNumber se enmascara en la respuesta (defensa en profundidad). Guard-order: 501 → 500
// → 400 → 401 → recién Didit (nunca fetch a Didit sin autorización, CD-2).
import { NextResponse } from "next/server";
import {
  type DiditDecisionResult,
  mapDiditDecision,
  maskDecision,
} from "../../../../src/infrastructure/didit/decision";
import { canonicalizeAddress } from "../../../../src/infrastructure/address";
import { getKycVerdictStore } from "../../../../src/infrastructure/persistence/supabase-kyc-verdicts";
import { logLedgerAlert } from "../../../../src/infrastructure/persistence/ledger-alert";
import {
  resolveDiditBaseUrl,
  resolveDiditEnvironment,
  type DiditEnvironment,
} from "../../../../src/infrastructure/didit/didit-env";
import { verifySessionToken } from "../../../../src/infrastructure/kyc-auth";

export async function GET(req: Request): Promise<Response> {
  const apiKey = process.env.DIDIT_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "didit_not_configured" }, { status: 501 });

  if (!process.env.KYC_SESSION_SECRET) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "missing_session" }, { status: 400 });

  // Auth: mismo cuerpo/status para "sin token" y "token inválido" (anti-enumeración, CD-5).
  // NO se llama a Didit en ninguno de los dos casos (CD-2).
  const token = req.headers.get("x-kyc-token");
  if (!token || !verifySessionToken(sessionId, token)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Ambiente de Didit: fail-closed y LAZY (después de los guards, CD-2 intacto). Sin DIDIT_ENV no
  // se resuelve host → 500 de MISCONFIG (no 502): el problema es nuestro, no de Didit.
  // El MISMO ambiente resuelve el host y etiqueta la decisión. Que salgan de la misma lectura es
  // el punto: si el host es el mock, la etiqueta dice mock, y no hay forma de que uno diga una cosa
  // y la otra diga otra.
  let base: string;
  let environment: DiditEnvironment;
  try {
    environment = resolveDiditEnvironment();
    base = resolveDiditBaseUrl();
  } catch {
    // Etiqueta value-free: el mensaje del throw nombra la env, pero NO se filtra al cliente.
    return NextResponse.json({ error: "didit_env_misconfigured" }, { status: 500 });
  }

  const res = await fetch(`${base}/v3/session/${encodeURIComponent(sessionId)}/decision/`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    return NextResponse.json({ error: "didit_decision_failed", upstream: res.status }, { status: 502 });
  }

  const decision = await res.json();
  const mapped = mapDiditDecision(decision, environment);
  await persistKycVerdict(mapped);
  return NextResponse.json(maskDecision(mapped));
}

/**
 * WKH-333/AC-1 — persiste el veredicto cuando la verificación llega a un desenlace terminal APROBADO.
 *
 * POR QUÉ ACÁ Y NO EN `resume-kyc.ts`. Ese use-case corre en el BROWSER (`container.ts`, "Container
 * compartido (browser)"). Escribir desde ahí sería el navegador diciéndole al servidor "esta
 * dirección está verificada", que es exactamente lo que `ports.ts` prohíbe: los booleanos del
 * localStorage son atacante-controlables. Acá, en cambio, las cinco cosas que la fila necesita
 * —terminal, verificationId, approved, riskLevel, provenance, vendorData— salen de `mapDiditDecision`
 * sobre la respuesta que Didit acaba de dar, server-side.
 *
 * BEST-EFFORT y sin PII (AC-9/CD-2/CD-13):
 *   · La respuesta HTTP es BYTE-IDÉNTICA pase lo que pase con la escritura. Que la evidencia no quede
 *     no puede cambiar el desenlace del KYC de una persona.
 *   · Un fallo emite UNA alerta por el MISMO canal que el ledger de evidencia (`logLedgerAlert`), y
 *     VALUE-FREE: ni el verification_id, ni la dirección, ni ningún campo de la fila. Interpolar el
 *     prefijo a mano en un `console.error` rompería la garantía que ese módulo documenta.
 *   · `vendorData` vacío ⇒ NO se escribe. Es el mismo fail-closed que el ownership check de
 *     `authority.ts`: sin binding declarado no se puede afirmar de QUIÉN es esta verificación, y una
 *     fila a nombre equivocado es peor que ninguna fila (con el flag encendido, esa fila es la fuente
 *     de autoridad de un pago).
 *   · IDEMPOTENTE sin mover `verified_at`: esta route se pollea hasta 8 veces por verificación
 *     (`flow.tsx`, RESUME_MAX_POLLS). El contrato CAS del store devuelve 'already_recorded' y NO
 *     toca la fecha (CD-25); si la moviera, quien deje la pestaña recargando no vencería nunca.
 *
 * `verifiedAt` es el momento en que ESTE servidor observó el desenlace terminal. Es lo único que este
 * código midió: la fecha del escaneo no viaja en la decisión de Didit.
 */
async function persistKycVerdict(mapped: DiditDecisionResult): Promise<void> {
  if (!mapped.terminal || !mapped.approved) return;
  const store = getKycVerdictStore();
  if (!store) return; // flag OFF o envs ausentes ⇒ byte-idéntico a hoy (AC-12)
  if (!mapped.vendorData) return; // fail-closed: sin binding no se escribe
  let owner: string;
  try {
    owner = canonicalizeAddress(mapped.vendorData);
  } catch {
    return; // vendor_data que no es una address ⇒ tampoco hay binding
  }
  try {
    await store.put({
      senderAddress: owner,
      verificationId: mapped.verificationId,
      approved: true,
      riskLevel: mapped.riskLevel,
      provenance: mapped.provenance, // CRUDA (AC-11): el juicio vive en el lector
      verifiedAt: new Date().toISOString(),
    });
  } catch {
    // Value-free por contrato: sólo la etiqueta de la rama. Nada de la fila (CD-13).
    logLedgerAlert("kyc_verdict_write_failed", { stage: "kyc_decision_route" });
  }
}
