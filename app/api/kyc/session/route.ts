// Server-side: crea una sesión de verificación en Didit. El API key vive SOLO acá (env),
// nunca llega al browser. POST /v3/session/ con header x-api-key. Env-gated (501 si no hay key).
// WKH-179: rate-limit por IP + address ANTES de llamar a Didit (financial-DoS, A2); callback
// reconstruido server-side (ignora body.callback, M6); emite el token HMAC de sesión (B1).
// Guard-order: 501 → 500 → rate-limit → PoP (sólo si se presentó una prueba; ver S5) → callback
// server-side → Didit → issue token (CD-2).
//
// 🔴 WKH-333/R-1 — `vendor_data` YA NO SALE DEL BODY. Salía, y eso permitía crear una sesión de
// verificación atada a la dirección de OTRA persona y aprobarla con el documento propio: Didit ecoa
// esa dirección y `app/api/kyc/decision/route.ts` escribía la fila del veredicto A NOMBRE DE LA
// VÍCTIMA. Mientras el pago usaba el identificador del localStorage de cada uno, esa fila ajena era
// inerte. Con el veredicto server-side, esa fila ES la fuente de autoridad del pago —y el paso 1 del
// CAS la REEMPLAZA si ya había una legítima—, así que la víctima pasaría a pagar bajo la identidad de
// otro sin forma de notarlo. Por eso R-1 entra en esta HU y no queda como sucesora.
//
// Residual que esto NO cierra, y es idéntico a hoy: quien controla la dirección puede escanear el
// documento de otra persona. Eso es un problema del verificador de identidad, no de este binding.
import { NextResponse } from "next/server";
import {
  buildSolanaPopMessage,
  verifySolanaPopChallenge,
} from "../../../../src/infrastructure/auth/pop-challenge";
import { verifySolanaPop } from "../../../../src/infrastructure/auth/pop-verify-solana";
import { resolveSolanaNetworkId } from "../../../../src/infrastructure/chain";
import { canonicalizeAddress } from "../../../../src/infrastructure/address";
import { resolveDiditBaseUrl } from "../../../../src/infrastructure/didit/didit-env";
import { issueSessionToken } from "../../../../src/infrastructure/kyc-auth";
import { checkKycRateLimit } from "../../../../src/infrastructure/rate-limit";

// MNR-1: la key del rate-limit por IP debe venir de una fuente que el cliente NO pueda forjar.
// En Vercel, `x-vercel-forwarded-for` y `x-real-ip` los INYECTA/SOBRESCRIBE la edge de Vercel con la
// IP real del cliente (equivalen a `ipAddress()` de @vercel/functions, que lee `x-real-ip`) → fuente
// primaria confiable. El `x-forwarded-for` crudo es una cadena parcialmente controlada por el cliente:
// su entry MÁS A LA IZQUIERDA es spoofeable, y tomarlo (como antes) permitía evadir el límite por IP
// rotando el header. Por eso XFF es SOLO último recurso y, de usarlo, tomamos el valor MÁS A LA
// DERECHA (el que agrega el proxy de confianza más cercano), nunca el leftmost.
function clientIp(req: Request): string {
  const trusted =
    req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip")?.trim();
  if (trusted) return trusted;

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1]!;
  }
  return "unknown";
}

export async function POST(req: Request): Promise<Response> {
  const apiKey = process.env.DIDIT_API_KEY;
  const workflowId = process.env.DIDIT_WORKFLOW_ID;
  if (!apiKey || !workflowId) {
    return NextResponse.json({ error: "didit_not_configured" }, { status: 501 });
  }

  if (!process.env.KYC_SESSION_SECRET) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  // Ambiente de Didit: fail-closed y LAZY. Va junto al resto de los guards de MISCONFIG (500) y
  // ANTES del rate-limit, para no gastar presupuesto del limiter en un request que no puede andar.
  // No viola CD-2 (resolver una URL no es un fetch: a Didit se le sigue hablando recién más abajo).
  let base: string;
  try {
    base = resolveDiditBaseUrl();
  } catch {
    return NextResponse.json({ error: "didit_env_misconfigured" }, { status: 500 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    vendorData?: string;
    callback?: string;
    popChallenge?: unknown;
    popSignature?: unknown;
  };

  // Rate-limit ANTES de cualquier fetch a Didit (CD-2). Fail-closed si Upstash no está (503).
  const rl = await checkKycRateLimit({ ip: clientIp(req), address: body.vendorData });
  if (rl.unavailable) {
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  }
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
    );
  }

  // ── S5 — PRUEBA DE POSESIÓN DE LA BILLETERA (WKH-333/AC-19, CD-29) ──────────────────────────────
  //
  // POSICIÓN, y ninguna de las dos cosas es cosmética:
  //   · DESPUÉS del rate-limit. Este bloque hace HMAC + ed25519, o sea CPU. Ponerlo antes del limiter
  //     abriría una ventana de CPU-DoS. Es el mismo orden que ya resolvieron
  //     `app/api/a2a/payout/challenge/route.ts` y `app/api/solana/escrow/remittance-ids/route.ts`.
  //   · DESPUÉS del 501 de `DIDIT_API_KEY`. Sin key la ruta ya salió arriba con 501 y
  //     `DiditKycGateway.start` cae a la simulación ⇒ EL DEMO QUEDA BYTE-IDÉNTICO (AC-12). Si este
  //     bloque estuviera antes, el demo empezaría a exigir una firma de billetera que hoy no pide.
  //
  // 🔴 LA PRUEBA ATA, PERO NO ES REQUISITO PARA VERIFICARSE (AR/BLQ-ALTO-2, CD-15/AC-13). Acá el PoP
  // era OBLIGATORIO: sin prueba, 403. Medido, eso rompía CD-15 textualmente — `ConnectWallet` vuelve
  // SIN prueba por cuatro caminos que no son exóticos (la persona rechaza la firma, el emisor del
  // challenge está apagado, el limiter IP-only devuelve 429 en una oficina o un CGNAT, la red se
  // cae), `StartKyc` llamaba igual a `kyc.start`, esta ruta contestaba 403 y `DiditKycGateway.start`
  // lo convertía en `throw didit_session_failed`. Resultado: **la persona no podía ni empezar el
  // KYC**, y el disparador era el prompt de firma que esta misma HU agregó.
  //
  // Lo que se hace en cambio: SIN prueba se crea la sesión **SIN ATAR** —`vendor_data` no viaja—, que
  // es estrictamente mejor que lo de antes de la HU (antes viajaba el valor del body, que es el
  // ataque de R-1). CON prueba se ata a la dirección probada. Nunca se ata a algo no probado.
  //
  // ⚠️ CONSECUENCIA, DICHA: una sesión sin atar NO produce fila del veredicto — `decision/route.ts`
  // corta con `if (!mapped.vendorData) return`. O sea que quien rechaza la firma se verifica igual
  // (esto), pero para PAGAR va a necesitar una prueba de todos modos, porque `prepare` exige PoP
  // desde WKH-206 y la fila sale de ahí. Y la salida NO es la misma para todos — la distinción
  // importa y se derivó del guard de ownership de `authority.ts`:
  //   · quien YA tenía una verificación ATADA (todas las de antes de esta HU: `kyc-gateway.ts`
  //     mandaba siempre `vendorData`) ⇒ le alcanza con RECONECTAR Y FIRMAR: el backfill de
  //     `ConnectWallet` re-consulta a la autoridad con la pista del navegador, el `vendor_data` que
  //     Didit ecoa coincide, y la fila se escribe sin gastar otra verificación.
  //   · quien SÓLO tiene esta sesión sin atar ⇒ el backfill NO puede rescatarlo: la autoridad
  //     devuelve `kyc_ownership_mismatch` para un `vendor_data` vacío (fail-closed, y así debe ser).
  //     Tiene que verificarse de nuevo, esta vez firmando. Es un cupo del proveedor gastado.
  // Ninguna de las dos es un callejón, y el copy de `prepare_kyc_verdict_missing` nombra las dos en
  // ese orden. Lo que este bloque garantiza es lo que CD-15 pide: que la puerta de entrada no se
  // cierre. Que además sea barata depende de si hubo firma, y eso es de la persona, no nuestro.
  //
  // El limiter de arriba sigue usando `body.vendorData` como hint, igual que antes: moverlo a la
  // dirección probada lo pondría después del cripto. No se debilita nada —ese valor ya era forjable
  // antes de esta HU— y se declara acá para que no parezca un descuido.
  //
  // CUALQUIERA de los cinco fallos de una prueba PRESENTADA colapsa en el MISMO 403 con el MISMO
  // cuerpo (no-oracle). Presentar una prueba rota NO es lo mismo que no presentar ninguna: lo primero
  // es un intento fallido (o un ataque) y se rechaza; lo segundo es el camino de hoy.
  const popChallenge = body.popChallenge;
  const popSignature = body.popSignature;
  const popPresentado =
    (typeof popChallenge === "string" && popChallenge.trim() !== "") ||
    (typeof popSignature === "string" && popSignature.trim() !== "");

  // `undefined` ⇒ sesión SIN atar. `JSON.stringify` omite la clave y Didit acepta la sesión sin
  // `vendor_data` (medido en producción el 2026-08-04 y documentado en `payout/authority.ts`: un
  // `POST /api/kyc/session {}` devolvía 200 con `&vendor=` vacío).
  let provedAddress: string | undefined;

  if (popPresentado) {
    const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler
    if (!POP_SECRET) {
      // Se presentó una prueba y no la podemos verificar ⇒ fail-closed. NO es opcional dejarlo: sin
      // este guard, `verifySolanaPopChallenge` tira "PAYOUT_POP_SECRET missing" y sale un 500 crudo.
      return NextResponse.json({ error: "kyc_session_unavailable" }, { status: 503 });
    }
    // P1 — presencia + tipo. Acá adentro ya sabemos que al menos uno vino: si falta el otro, la
    // prueba está incompleta y eso es un intento fallido, no una ausencia.
    if (
      typeof popChallenge !== "string" ||
      !popChallenge.trim() ||
      typeof popSignature !== "string" ||
      !popSignature.trim()
    ) {
      return NextResponse.json({ error: "kyc_session_unverified" }, { status: 403 });
    }
    // P2 — HMAC + exp + tipos colapsan en null.
    const ch = verifySolanaPopChallenge(popChallenge, Date.now());
    if (!ch) {
      return NextResponse.json({ error: "kyc_session_unverified" }, { status: 403 });
    }
    // P3 — la dirección del challenge tiene que ser base58 canonicalizable. NO se la compara contra
    // `body.vendorData`: comparar el valor probado contra un valor que el caller escribió no agrega
    // nada, y confundir ambos es exactamente el guard-que-se-mira-al-espejo que CD-18 prohíbe. Lo que
    // vale es `ch.address`, y es la única que se usa de acá en adelante.
    try {
      provedAddress = canonicalizeAddress(ch.address);
    } catch {
      return NextResponse.json({ error: "kyc_session_unverified" }, { status: 403 });
    }
    // P4 — binding CAIP-2: el network-id del token vs el resuelto server-side, NUNCA del body.
    if (ch.networkId !== resolveSolanaNetworkId()) {
      return NextResponse.json({ error: "kyc_session_unverified" }, { status: 403 });
    }
    // P5 — ed25519 sobre el mensaje reconstruido con la MISMA buildSolanaPopMessage.
    if (
      !verifySolanaPop({
        addressBase58: ch.address,
        message: buildSolanaPopMessage(ch),
        signatureBase58: popSignature,
      })
    ) {
      return NextResponse.json({ error: "kyc_session_unverified" }, { status: 403 });
    }
  }

  // Callback server-side: se IGNORA body.callback por completo (M6). Sin base URL → sin callback
  // (Didit muestra su pantalla default; el resume anda por localStorage).
  const callbackBase = process.env.KYC_CALLBACK_BASE_URL;
  const callback = callbackBase ? `${callbackBase}/kyc/callback` : undefined;

  const res = await fetch(`${base}/v3/session/`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      workflow_id: workflowId,
      // 🔴 LA DIRECCIÓN PROBADA, NUNCA `body.vendorData` (AC-19/CD-29). Este valor es el que Didit
      // ecoa en la decisión y con el que se escribe la fila del veredicto: si saliera del body,
      // cualquiera podría hacer que la fila de otra persona quede a su nombre (o al revés).
      // `undefined` (sin prueba) ⇒ la clave NO viaja ⇒ sesión sin atar ⇒ ninguna fila se escribirá.
      // Ese es el único valor posible además de la dirección probada: no hay tercer origen.
      vendor_data: provedAddress,
      callback,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    return NextResponse.json({ error: "didit_session_failed", upstream: res.status }, { status: 502 });
  }

  const d = (await res.json()) as { session_id: string; url: string; session_token?: string };
  // sessionToken = de Didit (NO tocar). authToken = NUESTRO HMAC (nuevo, CD-10).
  const authToken = issueSessionToken(d.session_id);
  return NextResponse.json({
    sessionId: d.session_id,
    url: d.url,
    sessionToken: d.session_token,
    authToken,
  });
}
