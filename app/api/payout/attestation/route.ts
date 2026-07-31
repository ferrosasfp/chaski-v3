// Server-side: VERIFICA la SolanaDepositAttestation que emitió /api/payout/prepare y devuelve el
// beneficiary+authority que están DENTRO del payload firmado.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// QUÉ PROTEGE ESTA ATESTACIÓN, Y QUÉ NO. Leer las dos mitades: la segunda es la que evita que
// alguien lea la primera y deje de buscar.
//
// SÍ PROTEGE: que el `beneficiary` no se ALTERE entre nuestro servidor y el navegador. La firma la
//   pone `issueSolanaDepositAttestation` con DEPOSIT_ATTESTATION_SECRET, que nunca sale del server,
//   así que una respuesta de /api/payout/prepare adulterada en el camino (proxy, red hostil, un
//   intermediario que reescribe el JSON) no puede traer una atestación que valide para OTRA
//   dirección. También ata la atestación a ESTA remesa (remittanceId + quoteId): una atestación
//   legítima de otra remesa (por ejemplo, una que el atacante generó para su propia dirección)
//   no se puede pegar acá.
//
// NO PROTEGE: que el `beneficiary` sea LEGÍTIMO. Nuestro servidor firma la dirección que le dio el
//   AGENTE de payout, sin poder comprobarla contra nada. Si el agente devuelve la dirección de
//   otro, la atestación la certifica igual y esta ruta la valida igual. La firma dice
//   "este valor salió de nuestro servidor", NO "este valor es correcto". Contra el agente esta
//   capa no defiende NADA; lo que acota ese riesgo es de qué agente se trata (piso de reputación,
//   carril de estreno, catálogo) y eso vive en otro lado.
//
// TAMPOCO PROTEGE contra un adversario que ya corre DENTRO del navegador (una extensión, un XSS):
//   quien controla `fetch` puede falsificar la respuesta de ESTA ruta igual que la de prepare. La
//   verificación es un segundo canal, no un enclave.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Errores: enums opacos, cero PII, cero eco del beneficiary recibido. Fail-closed en cada paso.
import { NextResponse } from "next/server";
import { verifySolanaDepositAttestation } from "../../../../src/infrastructure/settlement/deposit-attestation";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(req: Request): Promise<Response> {
  // A1. Sin el secreto NO se puede verificar nada. 503 fail-closed, MISMO criterio que PR2 de
  // prepare: una ruta de verificación que responde "ok" sin poder verificar es peor que no tenerla.
  // (`verifySolanaDepositAttestation` ya devuelve null sin secreto; el 503 explícito distingue
  // "no puedo" de "no valida", que son cosas distintas para quien opera.)
  if (!process.env.DEPOSIT_ATTESTATION_SECRET) {
    return NextResponse.json({ error: "attestation_unavailable" }, { status: 503 });
  }

  // A2. Body null-safe (req.json() RESUELVE `null` con el body literal `null`: el .catch NO dispara).
  const parsed: unknown = await req.json().catch(() => null);
  const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  const attestation = typeof body.attestation === "string" ? body.attestation : "";
  const remittanceId = typeof body.remittanceId === "string" ? body.remittanceId : "";
  const quoteId = typeof body.quoteId === "string" ? body.quoteId : "";

  // A3. HMAC + exp + cluster + tipos, todo dentro de verifySolanaDepositAttestation (fail-closed,
  // devuelve null ante CUALQUIER problema y nunca es un oráculo de cuál).
  const attested = attestation ? verifySolanaDepositAttestation(attestation, Date.now()) : null;
  if (!attested) {
    return NextResponse.json({ error: "attestation_unverified" }, { status: 403 });
  }

  // A4. Binding a ESTA remesa. Sin esto, una atestación VÁLIDA de otra remesa pasa: el atacante
  // arranca una remesa propia, se queda con su atestación legítima (que certifica SU dirección de
  // depósito) y la pega entera en la respuesta de la víctima. La firma verificaría perfecto.
  // Comparación exacta: los dos ids los generamos nosotros, no hay normalización que aplicar.
  if (attested.remittanceId !== remittanceId || attested.quoteId !== quoteId) {
    return NextResponse.json({ error: "attestation_unverified" }, { status: 403 });
  }

  // A5. Se devuelve lo que está DENTRO del payload firmado, no lo que el caller mandó. Así el
  // consumidor puede usar el valor atestado en vez de compararlo y quedarse con el suyo.
  return NextResponse.json(
    { beneficiary: attested.beneficiary, authority: attested.authority },
    { status: 200 },
  );
}
