// Server-side: VERIFICA la SolanaDepositAttestation que emitió /api/payout/prepare y devuelve el
// beneficiary+authority que están DENTRO del payload firmado.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ALCANCE. Leer entero antes de confiar en esto para algo: la lista de lo que NO cubre es más
// larga que la de lo que sí, y una versión anterior de este bloque nombraba como cubierto
// justamente al adversario que lo atraviesa.
//
// SÍ DETECTA, y estas tres son reales:
//   1. La adulteración AISLADA del 200 de /api/payout/prepare. Un intermediario que reescribe el
//      `beneficiary` y deja el resto igual queda expuesto: la atestación sigue firmada sobre la
//      dirección vieja y el consumidor compara los dos valores. No puede forjar una atestación
//      nueva porque DEPOSIT_ATTESTATION_SECRET nunca sale del server.
//   2. El REPLAY de una atestación de otra remesa. Es auténtica (la firmamos nosotros) pero es de
//      otro par remittanceId+quoteId, y el binding de A4 la rechaza. Sin eso, el atacante prepara
//      una remesa propia, se guarda su atestación legítima y la pega en la respuesta de la víctima.
//   3. Bugs NUESTROS: un `beneficiary` que no coincide con el que está dentro del payload firmado,
//      una atestación vencida, otra `cluster`, o una inversión de campos aguas arriba.
//
// NO DETECTA al intermediario que reescribe LAS DOS RUTAS, y esto es lo que hay que entender antes
//   de darle peso a esta capa. El consumidor (`verifyAttestation`, http-solana-prepare-gateway.ts)
//   NO verifica ninguna firma: hace un fetch a esta ruta y le CREE la respuesta. El HMAC lo
//   verificamos acá, en el server, porque el secreto vive acá; el navegador no puede recalcularlo.
//   Entonces el que puede reescribir el 200 de prepare puede reescribir también el 200 de esta
//   ruta: es el MISMO origen, la MISMA sesión TLS y el MISMO `fetch`. Pone su dirección en las dos
//   respuestas y la comparación del cliente da IGUAL, porque compara dos valores suyos. Es un
//   segundo pedido, no un segundo canal de confianza.
//
// NO DETECTA que el `beneficiary` sea LEGÍTIMO. Nuestro servidor firma la dirección que le dio el
//   AGENTE de payout, sin poder comprobarla contra nada. Si el agente devuelve la dirección de
//   otro, la atestación la certifica igual y esta ruta la valida igual. La firma dice
//   "este valor salió de nuestro servidor", NO "este valor es correcto". Contra el agente esta
//   capa no defiende NADA; lo que acota ese riesgo es de qué agente se trata (piso de reputación,
//   carril de estreno, catálogo) y eso vive en otro lado.
//
// NO DETECTA a un adversario que ya corre DENTRO del navegador (una extensión, un XSS): quien
//   controla `fetch` falsifica la respuesta de ESTA ruta igual que la de prepare.
//
// DÓNDE VIVE LA DEFENSA QUE SÍ ALCANZA A ESOS TRES: server-side, en el settle
//   (app/api/settle/solana-sponsor/route.ts). Ahí se lee el `beneficiary` de los BYTES de la tx que
//   la wallet firmó y se compara contra la deposit-address que ESTE servidor persistió al preparar
//   (remittance_settlements.receiver_address). El navegador no participa de esa comparación y el
//   canal tampoco: los dos lados salen del server. Esta capa de acá sigue valiendo porque corta
//   ANTES de que la persona firme, pero no es la que decide.
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
