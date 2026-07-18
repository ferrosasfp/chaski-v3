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
import { isAddress, isAddressEqual, keccak256, toBytes } from "viem";
import { resolveChainId, resolveReceiverAddress, resolveUsdcAddress } from "../../../../src/infrastructure/chain";
import { getSettlementLedger } from "../../../../src/infrastructure/persistence/supabase-settlement-ledger";
import {
  ATTESTATION_TTL_SECONDS,
  issueSettlementAttestation,
} from "../../../../src/infrastructure/settlement/attestation";
import { verifyDepositAttestation } from "../../../../src/infrastructure/settlement/deposit-attestation";
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
  // S12 / B1-B6 — el `to` FIRMADO se compara contra el valor SERVER-CONTROLADO (CD-9: jamás el body).
  // Doble-modo flag-gated por la PRESENCIA de DEPOSIT_ATTESTATION_SECRET (leído en runtime, CD-14):
  //  · Modo estático (secreto AUSENTE): el valor es el receiver de ENV — path WKH-168/209 BYTE-IDÉNTICO.
  //  · Modo deposit-flow (secreto PRESENTE): el valor es el depositAddress ATESTADO por HMAC (WKH-211).
  //    El `to` deja de ser un env global reusable y se ata a ESTA remesa (remittanceId+quoteId+chainId+
  //    exp). MÁS fuerte, no más débil (DT-3): V1-V9 on-chain queda INTACTA; sólo cambia el VALOR de
  //    expectedTo. El body NUNCA es la fuente de expectedTo (sigue siendo un HMAC server-firmado).
  const DEPOSIT_SECRET = process.env.DEPOSIT_ATTESTATION_SECRET; // CD-14: dentro del handler
  let expectedTo: `0x${string}` = receiver; // modo estático por default
  if (DEPOSIT_SECRET) {
    // B1 — atestación MANDATORIA en este modo (sin ella no hay `to` legítimo).
    const token = parsed.depositAttestation;
    if (typeof token !== "string" || !token.trim()) {
      return NextResponse.json({ error: "settle_binding_missing" }, { status: 400 });
    }
    // B2 — formato/HMAC/exp/tipos colapsan en null → 400 opaco (no-oracle).
    const att = verifyDepositAttestation(token, Date.now());
    if (!att) {
      return NextResponse.json({ error: "settle_binding_invalid" }, { status: 400 });
    }
    // B3 — ata el binding a ESTA remesa. En este modo el remittanceId del body es MANDATORIO no-vacío.
    const bodyRemittanceId = typeof parsed.remittanceId === "string" ? parsed.remittanceId : "";
    if (!bodyRemittanceId.trim() || att.remittanceId !== bodyRemittanceId) {
      return NextResponse.json({ error: "settle_binding_invalid" }, { status: 400 });
    }
    // B4 — mata el reciclado cross-quote. quoteId ya validado no-vacío (S línea 133). Igualdad EXACTA
    // (ID opaco del partner, sin normalizar — espíritu A7′).
    if (att.quoteId !== quoteId) {
      return NextResponse.json({ error: "settle_binding_invalid" }, { status: 400 });
    }
    // B5 — mata replay cross-entorno (espíritu A7″). chainId de la ENV server-side (CD-9), NUNCA del body.
    if (att.chainId !== chainId) {
      return NextResponse.json({ error: "settle_binding_invalid" }, { status: 400 });
    }
    // B6 — el `to` firmado DEBE ser el depositAddress atestado. Rechazo PRE-broadcast (AC-3): NUNCA se
    // llama broadcastSettle ni verifySettlementOnChain con un `to` no atestado.
    if (!isAddressEqual(to, att.depositAddress as `0x${string}`)) {
      return NextResponse.json({ error: "settle_receiver_mismatch" }, { status: 400 });
    }
    expectedTo = att.depositAddress as `0x${string}`;
  } else {
    // S12 — modo estático (byte-idéntico WKH-168/209): el payTo sale de ENV, jamás del body.
    if (!isAddressEqual(to, receiver)) {
      return NextResponse.json({ error: "settle_receiver_mismatch" }, { status: 400 });
    }
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
    payTo: expectedTo, // CD-9: server-controlado (receiver de ENV en estático; depositAddress atestado en deposit-flow)
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
    expectedTo, // CD-9: server-controlado (env estático / depositAddress atestado), NO el `to` del body
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

  // ── WKH-207: persistencia server-side ADITIVA (post-V9, best-effort). ────────────────────────────
  // Flag-gated: getSettlementLedger() es null con el flag OFF/envs ausentes ⇒ SKIP TOTAL ⇒ el settle
  // responde byte-idéntico (AC-2/AC-10). NUNCA toca S1-V9 (CD-4). En su PROPIO try/catch: si la DB
  // cae, se loguea un enum sin PII y el money-path responde IGUAL (CD-17). CD-13: se escriben los
  // valores VERIFICADOS on-chain (verified.*), NUNCA un eco del body del cliente.
  const ledger = getSettlementLedger();
  if (ledger) {
    try {
      const remittanceId = parsed.remittanceId;
      if (typeof remittanceId === "string" && remittanceId.trim()) {
        // Binding nonce OPCIONAL (defensa en profundidad, DT-3): el nonce EIP-3009 es determinístico
        // = keccak256(`${remittanceId}:${quoteId}`) (wallet.ts:37-39). Si el remittanceId declarado
        // NO reproduce el nonce firmado, NO persistimos esa fila (log) — el settle YA respondió OK.
        const expectedNonce = keccak256(toBytes(`${remittanceId}:${quoteId}`));
        if (expectedNonce.toLowerCase() !== nonce.toLowerCase()) {
          console.error("[ledger] recordPrincipalIn_nonce_mismatch");
        } else {
          await ledger.recordPrincipalIn({
            remittanceId,
            quoteId,
            idempotencyKey: `${remittanceId}:${quoteId}`,
            txHash: verified.txHash,
            chainId,
            senderAddress: verified.from, // CD-13: valores VERIFICADOS, no el body
            receiverAddress: verified.to,
            valueMinor: verified.valueMinor,
          });
        }
      }
    } catch (e) {
      console.error("[ledger] recordPrincipalIn_failed", e); // best-effort, NUNCA rompe (CD-17/DT-5)
    }
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
