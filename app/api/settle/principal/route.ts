// Server-side: settle del PRINCIPAL (WKH-168, AC-1/AC-7). Es el ÚNICO lugar que compone las tres
// piezas: BROADCAST (facilitator-client) → VERIFY (onchain-verifier) → ATTEST (attestation).
//
// ⚠️ Por qué la composición vive acá y no adentro de una pieza (CD-20/CD-21, directiva legal/PSAV):
// broadcast y verificación son SEPARABLES por construcción. El broadcaster es la única pieza con
// exposición regulatoria; el verificador es agnóstico de quién transmitió. Un veredicto adverso ⇒ se
// reemplaza el broadcaster acá, y nada más.
//
// ⚠️ CD-10: el 200 del broadcaster NO es verificación — su `to`/`from`/`amount` son un ECO de nuestro
// input (base-adapter.ts:811). Por eso NUNCA se pasa de S21 a la atestación sin la rama V: leemos la
// cadena nosotros mismos. Un receipt sin verificar JAMÁS alcanza para atestiguar (CD-7).
//
// TODO en guards fail-closed: nunca 500 crudo, nunca se ecoa el motivo del facilitador (CD-12
// no-oracle), nunca se expone una credencial/URL/RPC al cliente (CD-4/CD-17).
// Guard-order OBLIGATORIO (espeja submit/route.ts): flag → config → env → body → formato → binding
// (monto/receiver/sender) → broadcast → verify → attest.
import { NextResponse } from "next/server";
import { isAddress, isAddressEqual } from "viem";
import { resolveChainId, resolveReceiverAddress, resolveUsdcAddress } from "../../../../src/infrastructure/chain";
import {
  ATTESTATION_TTL_SECONDS,
  issueSettlementAttestation,
} from "../../../../src/infrastructure/settlement/attestation";
import {
  broadcastSettle,
  isBroadcasterConfigured,
} from "../../../../src/infrastructure/settlement/facilitator-client";
import { verifySettlementOnChain } from "../../../../src/infrastructure/settlement/onchain-verifier";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const UINT256_DECIMAL = /^(0|[1-9]\d*)$/; // canónico: rechaza "01", "-1", "1e2", "", " 1 " (SIN trim)
const HEX_SIG = /^0x[0-9a-fA-F]+$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** Mapa verify → status HTTP. Fail-closed: todo lo no-ok bloquea (CD-12). */
function verifyStatus(reason: string): number {
  if (reason === "settle_unverified") return 503; // V1/V2/V4/V5 — no pudimos verificar ⇒ 503
  return 502; // V3/V6/V7/V8 — la cadena dice que NO es lo que pedimos
}

export async function POST(req: Request): Promise<Response> {
  // S1 — PRIMER guard. CD-1: la HU construye, NO enciende. Ningún fetch, ninguna lectura de cadena.
  if (process.env.NEXT_PUBLIC_EIP3009_ENABLED !== "true") {
    return NextResponse.json({ error: "settle_not_enabled" }, { status: 501 });
  }
  // S2 — sin backend de broadcast no hay nada que settlear. Ningún fetch. La config se consulta al
  // módulo del broadcaster: esta route NO lee sus envs (CD-20 — así el broadcaster se reemplaza sin
  // tocar nada más).
  if (!isBroadcasterConfigured()) {
    return NextResponse.json({ error: "settle_not_configured" }, { status: 501 });
  }

  // S3 — la ruta es un proceso server distinto del container: los resolvers fail-loud pueden tirar
  // acá aunque el guard del container haya pasado en el cliente. Capturado ⇒ nunca 500 crudo.
  let receiver: `0x${string}`;
  let usdc: `0x${string}`;
  let chainId: number;
  try {
    receiver = resolveReceiverAddress();
    usdc = resolveUsdcAddress();
    chainId = resolveChainId();
  } catch {
    return NextResponse.json({ error: "settle_misconfigured" }, { status: 500 });
  }

  // S4 — CD-15: req.json() RESUELVE con null ante el body literal `null` → el .catch NO dispara
  // (WKH-202/BLQ-BAJO-1). isRecord cubre null y los no-objeto por igual.
  const parsed: unknown = await req.json().catch(() => null);
  if (!isRecord(parsed)) {
    return NextResponse.json({ error: "settle_invalid_request" }, { status: 400 });
  }

  // S5 — authorization: record con los 6 campos, TODOS string. PROHIBIDO String(x) (String(123)
  // === "123" colaría un number — WKH-204).
  const auth = parsed.authorization;
  if (!isRecord(auth)) {
    return NextResponse.json({ error: "settle_invalid_request" }, { status: 400 });
  }
  const { from, to, value, validAfter, validBefore, nonce } = auth;
  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    typeof value !== "string" ||
    typeof validAfter !== "string" ||
    typeof validBefore !== "string" ||
    typeof nonce !== "string"
  ) {
    return NextResponse.json({ error: "settle_invalid_request" }, { status: 400 });
  }

  // S6 — signature.
  const signature = parsed.signature;
  if (typeof signature !== "string" || !HEX_SIG.test(signature)) {
    return NextResponse.json({ error: "settle_invalid_request" }, { status: 400 });
  }
  // S7 — nonce bytes32 exacto.
  if (!BYTES32.test(nonce)) {
    return NextResponse.json({ error: "settle_invalid_request" }, { status: 400 });
  }
  // S8 — uint256 decimales canónicos (el Zod del facilitador los rechazaría igual; fallamos antes).
  if (
    !UINT256_DECIMAL.test(value) ||
    !UINT256_DECIMAL.test(validAfter) ||
    !UINT256_DECIMAL.test(validBefore)
  ) {
    return NextResponse.json({ error: "settle_invalid_request" }, { status: 400 });
  }
  // S5 (cont.) — from/to deben ser addresses EVM bien formadas (isAddressEqual TIRA si no).
  if (!isAddress(from) || !isAddress(to)) {
    return NextResponse.json({ error: "settle_invalid_request" }, { status: 400 });
  }

  // S9 — address del caller declarado.
  const address = parsed.address;
  if (typeof address !== "string" || !address.trim() || !isAddress(address)) {
    return NextResponse.json({ error: "settle_invalid_request" }, { status: 400 });
  }

  // S10 — expectedValueMinor entero >= 1. PROHIBIDO Number(x) (Number("") === 0 — WKH-198).
  const expectedValueMinor = parsed.expectedValueMinor;
  if (
    typeof expectedValueMinor !== "number" ||
    !Number.isInteger(expectedValueMinor) ||
    expectedValueMinor < 1
  ) {
    return NextResponse.json({ error: "settle_invalid_request" }, { status: 400 });
  }

  const quoteId = parsed.quoteId;
  if (typeof quoteId !== "string" || !quoteId.trim()) {
    return NextResponse.json({ error: "settle_invalid_request" }, { status: 400 });
  }

  // S11 — igualdad EXACTA. El facilitador acepta value >= amount (base-adapter.ts:609) y reporta
  // accepted.amount ⇒ un settle honesto puede mover MÁS de lo que reporta. Somos MÁS ESTRICTOS a
  // propósito. NO relajar a >=. Ningún fetch.
  if (value !== String(expectedValueMinor)) {
    return NextResponse.json({ error: "settle_amount_mismatch" }, { status: 400 });
  }
  // S12 — CD-9: el payTo sale de ENV, jamás del body. Acá solo validamos que lo firmado coincida.
  if (!isAddressEqual(to, receiver)) {
    return NextResponse.json({ error: "settle_receiver_mismatch" }, { status: 400 });
  }
  // S13 — ata la firma al caller declarado. Ningún fetch.
  if (!isAddressEqual(from, address as `0x${string}`)) {
    return NextResponse.json({ error: "settle_sender_mismatch" }, { status: 400 });
  }

  // S14-S21 — BROADCAST. El cliente devuelve un txHash o un enum opaco; nunca el motivo del
  // facilitador (CD-12).
  const sent = await broadcastSettle({
    authorization: { from, to, value, validAfter, validBefore, nonce },
    signature,
    payTo: receiver, // CD-9: env
    asset: usdc, // CD-9: env
    chainId, // CD-9: env
    amountMinor: String(expectedValueMinor), // pinneado igual a authorization.value por S11
    resourceUrl: new URL(req.url).origin + "/api/settle/principal",
  });
  if (!sent.ok) {
    const status =
      sent.reason === "settle_in_flight"
        ? 409 // S16 — el cliente NO debe re-firmar (DT-6)
        : sent.reason === "settle_unavailable"
          ? 503 // S17/S19
          : 502; // S14/S15/S18/S20
    return NextResponse.json({ error: sent.reason }, { status });
  }

  // V1-V9 — VERIFICACIÓN INDEPENDIENTE. Acá es donde `principal_in` deja de ser una mentira: leemos
  // el receipt y el log Transfer EMITIDO POR EL USDC con nuestro propio RPC. El txHash entra como un
  // hash de cualquier origen (CD-21) — el verificador no sabe que lo broadcasteamos nosotros.
  const verified = await verifySettlementOnChain({
    txHash: sent.txHash,
    expectedFrom: from,
    expectedTo: receiver, // CD-9: env, NO el `to` del body (aunque S12 ya los pinneó iguales)
    expectedValueMinor,
  });
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: verifyStatus(verified.reason) });
  }

  // V9 — recién ACÁ existe evidencia on-chain verificada por nosotros ⇒ se emite la atestación
  // (DT-7). Es lo que el submit exige (AC-10) y lo que el atacante no puede forjar.
  let attestation: string;
  try {
    attestation = issueSettlementAttestation({
      txHash: verified.txHash,
      chainId,
      valueMinor: verified.valueMinor,
      from: verified.from,
      to: verified.to,
      quoteId,
      exp: Math.floor(Date.now() / 1000) + ATTESTATION_TTL_SECONDS,
    });
  } catch {
    // Sin SETTLE_ATTESTATION_SECRET no podemos atestiguar. El principal YA está adentro (varado →
    // WKH-207), pero NO inventamos una atestación: fail-closed (CD-12).
    return NextResponse.json({ error: "settle_misconfigured" }, { status: 500 });
  }

  // Solo hechos públicos (CD-17): txHash y montos. NUNCA la signature, la API key, la base URL ni el RPC.
  return NextResponse.json(
    {
      txHash: verified.txHash,
      valueMinor: verified.valueMinor,
      from: verified.from,
      to: verified.to,
      attestation,
    },
    { status: 200 },
  );
}
