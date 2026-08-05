// Server-side: broadcast del `deposit` Solana no-custodial (HU-SOL-13/AC-1, CD-6). Reenvía la tx
// partial-firmada por la wallet al facilitator (POST {FACILITATOR_BASE_URL}/solana/sponsor de
// HU-SOL-14), que la cofirma con el feePayer y la broadcastea. El browser NUNCA llama al
// facilitator directo: el Authorization Bearer se añade ACÁ, server-side (CD-6).
//
// ⚠️ ACÁ DECÍA "(gasless)", Y NO LO ES PARA QUIEN ENVÍA. El patrocinio cubre UNA de las dos cosas que
// se pagan: la COMISIÓN DE RED, porque el facilitator es el feePayer. El ALQUILER (rent) de las
// cuentas que crea la ix `deposit` lo paga el SENDER, que es el `payer` de sus `init`
// (`solana-programs/programs/escrow/src/lib.rs`). Medido en devnet sobre las 3 transacciones
// patrocinadas que existen: feePayer -10.000 lamports, remitente -4.002.000. Una billetera con USDC
// y sin SOL no puede depositar, y la palabra "gasless" a secas hacía pensar lo contrario. El número
// que hace falta y su derivación viven en `src/application/solana-escrow-rent.ts`.
//
// TODO en guards fail-closed: nunca 500 crudo, nunca se ecoa el motivo del facilitador (CD-12
// no-oracle), nunca se expone la API key / base URL al cliente (CD-6). Guard-order: flag → config →
// body → formato → DESTINO → forward → map.
import { NextResponse } from "next/server";
import { canonicalizeAddress } from "../../../../src/infrastructure/address";
import { readDepositBeneficiary } from "../../../../src/infrastructure/settlement/solana-deposit-beneficiary";
import { getSettlementLedger } from "../../../../src/infrastructure/persistence/supabase-settlement-ledger";
import { logLedgerWriteFailure } from "../../../../src/infrastructure/persistence/ledger-write-failure";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// base58 (alfabeto Solana): sin 0, O, I, l. sender/reference son pubkeys base58 (32 bytes ⇒ 43-44 chars).
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
// base64 estándar (partialSignedTx serializada).
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// SDD 037 — el popSignature es base58 de EXACTAMENTE 64 bytes, que en base58 caen siempre en 86-88
// caracteres. Rango cerrado y no el BASE58 genérico de arriba: acá se conoce el largo exacto del dato,
// y aceptar 32 caracteres dejaría pasar un pubkey donde va una firma.
const BASE58_SIGNATURE_64 = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

export async function POST(req: Request): Promise<Response> {
  // S1 — PRIMER guard. CD-5: la HU construye, NO enciende. Flag OFF ⇒ 501 (ningún forward).
  if (process.env.NEXT_PUBLIC_SOLANA_SETTLE_ENABLED !== "true") {
    return NextResponse.json({ error: "solana_settle_not_enabled" }, { status: 501 });
  }
  // S2 — sin backend del facilitador no hay a quién reenviar. Las creds viven SOLO acá (CD-6),
  // leídas en runtime; nunca se ecoan.
  const BASE = process.env.FACILITATOR_BASE_URL;
  const KEY = process.env.FACILITATOR_API_KEY;
  if (!BASE || !KEY) {
    return NextResponse.json({ error: "solana_settle_not_configured" }, { status: 501 });
  }

  // S3 — body null-safe (req.json() RESUELVE `null` con el body literal `null` → el .catch NO dispara).
  const parsed: unknown = await req.json().catch(() => null);
  if (!isRecord(parsed)) {
    return NextResponse.json({ error: "solana_settle_invalid_request" }, { status: 400 });
  }
  const { partialSignedTx, reference, sender, remittanceId, popSignature } = parsed;
  if (
    typeof partialSignedTx !== "string" ||
    !BASE64.test(partialSignedTx) ||
    typeof reference !== "string" ||
    !BASE58.test(reference) ||
    typeof sender !== "string" ||
    !BASE58.test(sender) ||
    typeof remittanceId !== "string" ||
    !remittanceId.trim() ||
    // SDD 037 — obligatorio y con forma verificada acá. No es "validar por validar": un
    // `popSignature` ausente o deforme se corta en este server, sin gastar el forward ni el Bearer.
    typeof popSignature !== "string" ||
    !BASE58_SIGNATURE_64.test(popSignature)
  ) {
    return NextResponse.json({ error: "solana_settle_invalid_request" }, { status: 400 });
  }
  // SDD 037 — `popSignature` va SIEMPRE (ya no condicional): reemplazó a la prueba HMAC anterior, que era
  // opcional porque dependía de un secreto compartido que ya no existe.
  const forwardBody: Record<string, unknown> = {
    partialSignedTx,
    reference,
    sender,
    remittanceId,
    popSignature,
  };

  // ── S3.5 · EL DESTINO: contra lo que el SERVIDOR registró al preparar ────────────────────────────
  //
  // QUÉ ATAJA, Y POR QUÉ ACÁ. Todo lo que protege el destino antes de este punto (la atestación HMAC
  // de /api/payout/prepare y su verificación en /api/payout/attestation) se decide en el navegador y
  // viaja por el mismo canal: un intermediario que reescribe las DOS respuestas pone su dirección en
  // las dos y la comparación del cliente compara dos valores suyos (está clavado, con su resultado
  // real, en http-solana-prepare-gateway.test.ts, "LÍMITE CONOCIDO"). Acá no participa ni el
  // navegador ni el canal: los DOS lados de la comparación salen del server.
  //   · Lado A: el beneficiary que está DENTRO de los bytes de la tx que la wallet firmó. Nadie puede
  //     cambiarlo sin invalidar la firma del sender, y es exactamente lo que la cadena va a ejecutar.
  //     NO se lee de ninguna clave del body: un campo del request lo elige quien manda el request, y
  //     un guard alimentado por el request se compara consigo mismo.
  //   · Lado B: la deposit-address que ESTE servidor persistió cuando preparó la remesa
  //     (remittance_settlements.receiver_address, escrita en /api/payout/prepare).
  //
  // QUÉ NO ATAJA: que la dirección registrada sea legítima. Si el AGENTE de payout dio la dirección
  // de otro, el servidor la registró y la tx la lleva: coinciden y esto pasa. Ese riesgo se acota por
  // QUÉ agente atiende el leg (piso de reputación), no acá. Tampoco compara la release-authority: el
  // ledger no la persiste, así que no hay contra qué compararla sin inventar una fuente. Una authority
  // adulterada no permite quedarse con la plata (el release sigue yendo al beneficiary verificado),
  // pero sí puede trabar el vault; cerrarlo pide persistirla en el prepare y es trabajo aparte.
  //
  // CON EL LEDGER APAGADO ESTE CHEQUEO NO EXISTE. `getSettlementLedger()` devuelve null con
  // SETTLEMENT_LEDGER_ENABLED != "true" o sin envs de Supabase, y ahí no hay lado B contra el cual
  // comparar. Es la MISMA condición que gobierna el persist de abajo, y se dice de frente en vez de
  // dejarlo implícito: apagar el ledger apaga este control.
  const ledger = getSettlementLedger();
  if (ledger) {
    // Se decodifica ANTES de tocar la DB: es local y barato, y evita gastar una consulta en una tx
    // que ni siquiera es un depósito nuestro.
    const inTx = await readDepositBeneficiary(partialSignedTx);
    if (inTx.state !== "read") {
      // De esta tx no se puede afirmar NINGÚN destino (base64 roto, tx versionada, sin la ix del
      // escrow). No es "no coincide": es "no se puede juzgar", y por eso tiene su propio enum.
      return NextResponse.json({ error: "solana_settle_deposit_unreadable" }, { status: 400 });
    }
    let owner: string;
    try {
      owner = canonicalizeAddress(sender); // base58 de 32 bytes; la regex de arriba no lo garantiza
    } catch {
      return NextResponse.json({ error: "solana_settle_invalid_request" }, { status: 400 });
    }
    // TRES desenlaces posibles de la consulta, y son tres a propósito (WKH-308: "no pude preguntar"
    // NO es "no"). Ninguno de los tres consume nada: no hubo forward, no hay token de rate-limit
    // gastado en el facilitador, no se escribió una sola fila. Reintentar es inocuo.
    let registered: string[];
    try {
      registered = await ledger.listPreparedDepositAddresses({ remittanceId, senderAddress: owner });
    } catch (e) {
      // (1) NO SE PUDO LEER. La DB no contestó: no sabemos si coincide ni si está registrada. 503
      // reintentable con enum propio, NUNCA colapsado con el rechazo: tratar esto como "no coincide"
      // convertiría un hipo de infra en una acusación, que es el error que este repo ya cometió antes.
      logLedgerWriteFailure("listPreparedDepositAddresses", e);
      return NextResponse.json({ error: "solana_settle_ledger_unavailable" }, { status: 503 });
    }
    if (registered.length === 0) {
      // (2) LA CONSULTA CORRIÓ Y NO HAY NINGUNA REGISTRADA para esta remesa y este sender. Tampoco es
      // "no coincide": no hay con qué comparar. Se corta igual (sin lado B el control no existe) pero
      // con su propio enum, porque el diagnóstico es distinto: el prepare no dejó fila (su escritura
      // es best-effort y pudo fallar), o la remesa/sender no son los que se prepararon.
      return NextResponse.json({ error: "solana_settle_beneficiary_unregistered" }, { status: 409 });
    }
    if (!registered.includes(inTx.beneficiary)) {
      // (3) COINCIDENCIA NEGATIVA: la tx paga a una dirección que este servidor NO emitió para esta
      // remesa. Es el ataque que esta capa existe para ver. Se corta ANTES del forward: la tx no se
      // broadcastea, así que la plata no sale. Comparación base58 case-sensitive contra el valor
      // canonicalizado que guardó el ledger (minusculizar reabriría el aliasing).
      console.error("[settle][ALERT] solana_settle_beneficiary_mismatch", { remittanceId });
      return NextResponse.json({ error: "solana_settle_beneficiary_mismatch" }, { status: 409 });
    }
  }

  // S4 — FORWARD. El Bearer se añade ACÁ (CD-6). try/catch: timeout/DNS/parse ⇒ 502 opaco, NUNCA 500
  // crudo, NUNCA ecoa BASE/KEY ni el motivo del facilitador.
  let res: Response;
  try {
    res = await fetch(`${BASE}/solana/sponsor`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(forwardBody),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json({ error: "solana_settle_unavailable" }, { status: 503 });
  }

  if (!res.ok) {
    // Map fail-closed sin ecoar el cuerpo del facilitador (CD-12 no-oracle).
    const status =
      res.status === 422
        ? 422 // SPONSOR_REJECTED (CR-1 del deposit)
        : // SDD 037 — el facilitator no reconoció la firma como autorización de esta tx. Se propaga
          // como 403 y NO como 503: un rechazo no es una indisponibilidad, y confundirlos manda a la
          // persona a reintentar algo que va a fallar igual todas las veces.
          res.status === 403
          ? 403
          : res.status === 429
            ? 429
            : res.status === 409 || res.status === 502
              ? 502 // blockhash expirado / broadcast falló
              : 503; // 5xx/otro ⇒ unavailable
    const error =
      status === 422
        ? "solana_settle_rejected"
        : status === 403
          ? "solana_settle_sender_proof_invalid"
          : status === 429
            ? "solana_settle_rate_limited"
            : status === 502
              ? "solana_settle_broadcast_failed"
              : "solana_settle_unavailable";
    return NextResponse.json({ error }, { status });
  }

  // S5 — 200: extrae SÓLO la signature base58 (hecho público). NUNCA la key/base URL/tx cruda.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return NextResponse.json({ error: "solana_settle_broadcast_failed" }, { status: 502 });
  }
  const signature = isRecord(body) && typeof body.signature === "string" ? body.signature : "";
  if (!BASE58.test(signature)) {
    return NextResponse.json({ error: "solana_settle_broadcast_failed" }, { status: 502 });
  }

  // ── WKH-213/R3: persistencia server-side ADITIVA (best-effort), espeja settle/principal:252-288. ──
  // Sin esto el settle NUNCA escribía al ledger: la remesa nacía 'prepared' en /api/payout/prepare y
  // moría 'prepared' (ninguna otra escritura la tocaba), así que la signature verificada on-chain no
  // llegaba a ninguna superficie.
  // Flag-gated: getSettlementLedger() es null con el flag OFF/envs ausentes ⇒ SKIP TOTAL ⇒ respuesta
  // byte-idéntica. En su PROPIO try/catch: la DB NUNCA rompe el money-path (CD-17). Va DESPUÉS de
  // validar la signature: sólo se persiste evidencia que ya pasó el shape-check (CD-13).
  // Reusa el `ledger` resuelto en S3.5 (una sola resolución por request: si dos llamadas devolvieran
  // cosas distintas, el chequeo del destino y el persist estarían hablando de ledgers distintos).
  if (ledger) {
    try {
      await ledger.recordSolanaPrincipalIn({ remittanceId, senderAddress: sender, signature });
    } catch (e) {
      // best-effort, NUNCA rompe (CD-17) — control de flujo INTACTO, sólo cambia la señal.
      logLedgerWriteFailure("recordSolanaPrincipalIn", e);
    }
  } else {
    // WKH-325 — el ledger apagado apaga DOS cosas a la vez, y hasta acá eso sólo estaba dicho en el
    // comentario de S3.5. Este depósito se broadcasteó SIN el chequeo de destino y SIN registro
    // durable: el remittanceId, que es el único argumento con el que se pide el refund on-chain, queda
    // sólo en el localStorage del navegador. Va en el `else` y después de validar la signature, así
    // que sale exactamente una vez por 200 y cero veces en cualquier otra respuesta.
    // HUECO DECLARADO: el camino de arriba que responde 502 solana_settle_broadcast_failed (el
    // facilitator contestó ok pero su body no trae una signature legible) NO emite esta alerta, aunque
    // la tx pudo haberse broadcasteado. Sin signature no se puede afirmar que hubo depósito, y una
    // alerta que afirma un depósito no verificado sería peor que el silencio.
    // El prefijo [settle][ALERT] queda con dos ocurrencias literales en este archivo, a propósito:
    // factorizarlo obligaría a editar la de S3.5, que es un guard de seguridad que este cambio no
    // toca. Se declara, no se disimula. CD-7: sólo el remittanceId.
    console.error("[settle][ALERT] solana_settle_unrecorded_deposit", { remittanceId });
  }

  return NextResponse.json({ signature }, { status: 200 });
}
