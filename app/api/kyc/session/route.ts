// Server-side: crea una sesión de verificación de identidad EN EL AGENTE DE KYC — su nombre vive UNA
// sola vez, en `agent-env.ts` (WKH-233/CD-2). Este repo YA NO le habla al proveedor de KYC por ningún
// camino: la credencial del proveedor vive en el agente. Env-gated (501 si no hay host del agente).
//
// ⛔ ESTA ROUTE NO ES UN PROXY, Y NO PUEDE SERLO (CD-1). Lo que se reemplazó es UN `fetch`. Todo lo
// demás se queda, y cada cosa por su motivo:
//   · `clientIp()` + `checkKycRateLimit` (P-1/P-2) — 🔴 EL AGENTE NO TIENE RATE LIMIT. Si el límite
//     sale de acá, NO LO CUBRE NADIE. ⚠️ ACÁ DECÍA "y cada sesión creada consume cuota del proveedor",
//     Y ES FALSO: crear es gratis. El motivo corregido, en el bloque «CUÁNDO SE CONSUME LA CUOTA».
//   · el bloque S5 completo (P-3/P-4) — la prueba de posesión que decide si la sesión nace ATADA.
//   · `issueSessionToken` (P-5) — el HMAC NUESTRO que después autoriza el GET /decision de Chaski.
//     ⛔ NO es el `decisionToken` del agente: son secretos de repos distintos.
//
// 🔴 WKH-333/R-1 — `vendor_data` NO SALE DEL BODY, y eso no cambió: el binding sale de la dirección
// del challenge PoP-verificado. Salía del body, y eso permitía crear una sesión de verificación atada
// a la dirección de OTRA persona y aprobarla con el documento propio. Con el veredicto server-side
// esa fila ES la fuente de autoridad del pago, así que la víctima pasaría a pagar bajo la identidad
// de otro sin forma de notarlo.
//
// 🔴 WKH-233/CD-20 — LA RESPUESTA YA NO DEVUELVE NINGUNA CREDENCIAL DEL BORDE. Ni el `decisionToken`
// del agente (se persiste server-side y nunca sale) ni el `session_token` del proveedor (que ya no
// existe acá y que, medido, no lo leía nadie). La respuesta es `{sessionId, url, authToken}`.
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
import type { KycAgentSessionOutput } from "../../../../src/infrastructure/kyc/agent-contract";
import type { AgentKycCall } from "../../../../src/infrastructure/kyc/kyc-transport";
import { createAgentKycSession, KycAgentConfigError, UPSTREAM_INVOKE_SECRET_UNSET } from "../../../../src/infrastructure/kyc/kyc-transport";
import { resolveKycAgentBaseUrl } from "../../../../src/infrastructure/kyc/agent-env";
import { getKycSessionTokenStore } from "../../../../src/infrastructure/persistence/supabase-kyc-session-tokens";
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
  // Host del agente: fail-closed y LAZY. Va PRIMERO y ANTES del rate-limit, para no gastar
  // presupuesto del limiter en un request que no puede andar. Resolver una URL no es un fetch: al
  // agente se le habla recién más abajo (P-7 intacto).
  //
  // 🔴 501 Y NO 500, Y ES DELIBERADO. Es el status del que depende `AgentKycGateway.start` para caer
  // al fallback, o sea el que hace que sin `KYC_AGENT_BASE_URL` el demo quede BYTE-IDÉNTICO a como
  // estaba antes de esta HU. Es también el interruptor de rollback de WKH-233 (D-1): quitar esa env
  // apaga el camino nuevo sin re-desplegar. ⛔ PROHIBIDO agregar una segunda perilla.
  try {
    resolveKycAgentBaseUrl();
  } catch {
    return NextResponse.json({ error: "kyc_agent_not_configured" }, { status: 501 });
  }

  if (!process.env.KYC_SESSION_SECRET) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }

  // 🔴 AR/BLQ-BAJO-2 — LA RESOLUCIÓN DEL STORE SUBIÓ ACÁ, Y NO ES ORDEN COSMÉTICO. Estaba DESPUÉS de
  // `createAgentKycSession`, o sea después de crear una sesión REAL en el agente. Con las envs de
  // Supabase ausentes eso deja una sesión colgada en el proveedor por request y después contesta 503.
  // ⚠️ ACÁ DECÍA "QUEMA UNA VERIFICACIÓN DEL PROVEEDOR por request" y "cada IP quema 5 cupos por
  // ventana, indefinidamente y SIN QUE NADIE SE VERIFIQUE", y esa última cláusula se refutaba sola:
  // sin que nadie se verifique NO se consume nada (bloque «CUÁNDO SE CONSUME LA CUOTA», más abajo).
  // El orden se mantiene igual, por lo que sí es cierto: 503 sin basura > 503 con basura. Resolver el
  // store NO es un fetch, así que subirlo no toca P-7: al agente se le habla después de los guards.
  //
  // ⛔ LO QUE **NO** SUBIÓ ES LA ESCRITURA. `put` necesita el `sessionId`, que no existe antes del
  // agente, y sigue donde estaba —fuera de este bloque— con su propio 503 y su propio log.
  //
  // El log pierde `atada`: acá todavía no se corrió el bloque S5, así que esa señal NO EXISTE en este
  // punto. Rellenarla con `false` afirmaría que la sesión iba sin atar, que es un dato inventado.
  const tokenStore = getKycSessionTokenStore();
  if (!tokenStore) {
    console.warn("[kyc-session] kyc_session_token_store_unavailable", {});
    return NextResponse.json({ error: "kyc_session_unavailable" }, { status: 503 });
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
  //   · DESPUÉS DEL 501 DE ARRIBA. ⚠️ ACÁ DECÍA *"después del 501 de `DIDIT_API_KEY` … y
  //     `DiditKycGateway.start` cae a la simulación"*, Y NI LA ENV NI LA CLASE EXISTEN: `DIDIT_API_KEY`
  //     no aparece en ninguna línea de código del repo (sólo en comentarios) y `DiditKycGateway` la
  //     borró esta misma HU. El 501 REAL de esta ruta es el de
  //     (`resolveKycAgentBaseUrl`, `:73`) (el guard de la env `KYC_AGENT_BASE_URL`, en `:72-76`), y quien cae al
  //     fallback es `AgentKycGateway.start`, que es lo que hace que sin esa env el demo quede
  //     BYTE-IDÉNTICO (AC-12). Si este bloque estuviera antes, el demo empezaría a exigir una firma
  //     de billetera que hoy no pide.
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
  // corta con `d.payoutAllowed !== true`. O sea que quien rechaza la firma se verifica igual
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

  // `undefined` ⇒ sesión SIN ATAR: la CLAVE `identityRef` SE OMITE del body (ver
  // `createAgentKycSession`). Es la misma forma de onda que salía antes de WKH-233; lo que cambia es
  // a quién se le manda.
  //
  // 🔴 DE DÓNDE SALE QUE EL AGENTE ACEPTE ESO, y esta vez está MEDIDO EN CÓDIGO, no en una doc de un
  // tercero: su `KycSessionInputSchema` declara `identityRef: z.string().trim().min(1).max(128)
  // .optional()` dentro de un `.strict()`. O sea: omitir la clave es válido; mandarla `null` o vacía
  // NO lo es (sería un 400 y la persona no podría ni empezar el KYC). Por eso se OMITE y no se
  // rellena. ⚠️ Lo que sigue SIN medirse contra el proveedor vivo es lo de aguas arriba —si el
  // proveedor acepta una sesión sin binding— y eso ahora es problema del AGENTE, no de este repo.
  //
  // 🔴 COSTO REAL DEL CAMINO SIN ATAR, que se conserva escrito porque no lo arregla esta HU: sin
  // binding, el proveedor no puede deduplicar entre sesiones ⇒ quien rechaza la firma varias veces
  // genera verificaciones que NO se colapsan. ⚠️ DECÍA "y cada una consume cuota", y consume sólo la
  // que se COMPLETA (bloque «CUÁNDO SE CONSUME LA CUOTA»). ⛔ NO se inventa un centinela: cualquier
  // valor que no sea la dirección PROBADA reabre R-1, un bloqueante. Un no-adivinable, a HU aparte.
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

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 🔴 CUÁNDO SE CONSUME LA CUOTA DEL PROVEEDOR — LA ÚNICA COPIA DE ESTE HECHO EN EL REPO
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // MEDIDO CONTRA EL PROVEEDOR, NO INFERIDO. Didit, consultado el 2026-08-21 (panel de la cuenta +
  // su agente de soporte). Textual, las tres cosas:
  //   · Plan: «500 GRATIS/MES · LUEGO $0.15» ⇒ LA CUOTA ES **MENSUAL**, no diaria. Esto CIERRA el
  //     conflicto "500/día vs 500/mes" que los expedientes de las HUs 016 y 073 declaraban ABIERTO:
  //     la diferencia de 30× no existe. Todo renglón de este repo que diga "/día" está viejo.
  //   · «La cuota se consume al COMPLETAR exitosamente una verificación (cuando la sesión alcanza un
  //     estado final como `Approved` o `Declined` tras haber procesado los datos)».
  //   · «Las sesiones `Not Started` o `Abandoned` NO consumen cuota. Si creás una sesión y la persona
  //     nunca la abre, o la abandona a mitad de camino, esa sesión no se contabiliza».
  //
  // ⇒ **CREAR ES GRATIS. COMPLETAR CUESTA.** Este `POST` no gasta cuota por sí solo: lo que cuesta es
  // que una persona TERMINE el recorrido hospedado, y eso ocurre lejos de acá y puede no ocurrir.
  //
  // ⛔ LO QUE **NO** SE SIGUE DE ESTO, y hay que leerlo antes de aflojar un guard de este archivo:
  //   1. NO se sigue que crear sesiones sea inocuo. Cada una es una que alguien PUEDE completar, y la
  //      que nadie usa queda COLGADA en el proveedor. El rate limit sigue siendo la única defensa que
  //      existe (el agente no tiene ninguna): cambia el ARGUMENTO —abuso y basura, ya no "cada request
  //      quema una verificación"—, ⛔ no el guard.
  //   2. NO se sigue que el pre-vuelo de abajo sobre. Sigue, con su motivo corregido ahí mismo.
  //   3. NO está medido qué pasa con una sesión que queda a mitad y el proveedor cierra por timeout,
  //      ni si el AGENTE intermedio agrega algún consumo propio. Nadie lo preguntó. ⛔ No lo afirmes.
  //
  // ⚠️ ESTE BLOQUE ES PROSA SOBRE UN TERCERO Y NINGÚN TEST PUEDE VERIFICARLO: envejece si el proveedor
  // cambia de plan, y nada se va a poner rojo. Lo único que lo protege es que sea LA ÚNICA copia —
  // el resto del repo apunta acá en vez de repetir la cifra— y la fecha de arriba.
  //
  // ── PRE-VUELO — LO QUE PUEDE FALLAR POR CULPA NUESTRA VA **ANTES** DE CREAR LA SESIÓN ───────────
  // (hotfix 2026-08-20 · F-2 — el POR QUÉ se corrigió el 2026-08-21; el guard NO se tocó)
  //
  // 🔴 EL INCIDENTE QUE LO PIDE, MEDIDO. 2026-08-20, 14:09:58 UTC: el agente contestó **200** —la
  // sesión se creó en el proveedor— y recién después falló la escritura del token de más abajo. La
  // route devolvió 503 y la persona NO recibió la URL.
  //
  // ⚠️ ACÁ DECÍA "y la cuota SE GASTÓ" Y "Pagamos una verificación y no entregamos nada": LAS DOS SON
  // FALSAS. Esa sesión nunca se abrió ⇒ quedó `Not Started` ⇒ el proveedor no la contabiliza (bloque
  // de arriba). Lo que el incidente costó DE VERDAD, que ya alcanza y no hace falta inflarlo: la
  // persona no pudo verificarse, y quedó una sesión colgada que nadie va a poder consultar nunca
  // (el `decisionToken` no se persistió y el agente NO lo re-emite, CD-21).
  // ⛔ EL PRE-VUELO NO SE AFLOJA POR ESTO: lo que lo justifica es el desenlace de la PERSONA, no el
  // precio, y ése no cambió ni un poco.
  //
  // La doctrina que esto aplica ya estaba escrita en el otro repo
  // (`wasiai-remittance-agents`, `src/app/api/agents/remit-kyc-validator/session/route.ts`, bloque
  // "POR QUÉ EL SECRETO Y EL WORKFLOW SE RESUELVEN ANTES DE CREAR LA SESIÓN"): *"si se resolvieran
  // DESPUÉS, una misconfiguración NUESTRA dejaría una sesión creada en el partner que nadie va a
  // poder consultar: CUOTA GASTADA y un BINDING COLGADO"*. ⚠️ Es CITA TEXTUAL y no se reescribe, pero
  // su primera mitad ("CUOTA GASTADA") es exactamente la afirmación que se midió falsa; la segunda es
  // la que pasó. La doctrina se sostiene entera con la segunda mitad sola.
  //
  // ⛔ NO DICE, NI VA A DECIR, "YA NO PUEDE PASAR". Lo que cambia es CUÁNDO ocurre cada clase:
  //   · ANTES de crear la sesión (acá): la dirección que no canonicaliza, y todo lo que hace que la
  //     tabla no sea alcanzable/legible — falta la migración, la credencial de Supabase no sirve, el
  //     proyecto no responde, no hay permiso de SELECT.
  //   · DESPUÉS de crearla (sigue igual, y se declara): todo lo que sólo dispara al ESCRIBIR —
  //     una restricción de columna, una columna que falta en el insert, un GRANT que da SELECT y
  //     niega INSERT— y la base que se cae en la ventana entre este pre-vuelo y el `put`. Esa 503 se
  //     distingue por su etiqueta: `..._write_failed`, no `..._probe_failed`.
  //     ⚠️ ACÁ DECÍA "`session_id` duplicado" Y EL HOTFIX F-3 LO SACÓ: un `session_id` repetido ya no
  //     es un fallo —`put` ATA esa fila— salvo que la sesión sea de OTRA dirección, y ése es el modo
  //     de falla NUEVO de esta lista: `kyc_session_owner_conflict`, que también cae después de crear
  //     la sesión, que este pre-vuelo tampoco puede ver, y que sale con SU PROPIA etiqueta más abajo.
  //
  // Candado: el doble de `fetch` recibe **CERO llamadas** cuando la persistencia está rota. Es un
  // test sobre el CONTADOR de llamadas, no sobre el status —el 503 ya salía antes—, igual que
  // T-TOK-6b y que el molde del otro repo.

  // (1) LO PURO PRIMERO. `canonicalizeAddress` no toca la red: no hay ninguna excusa para correrlo
  // después del viaje. Hoy corre además en P3 (`:222`) sobre `ch.address`, así que el valor que llega
  // acá YA es canónico y esta línea es idempotente — se deja igual, y la razón es que el orden deje
  // de ser un accidente: sin ella, la única garantía de que la canonicalización precede al fetch es
  // que nadie mueva P3, y `put` volvería a ser el primero en canonicalizar un valor nuestro.
  // ⚠️ HONESTIDAD SOBRE SU ALCANCE: por eso mismo, HOY esta rama NO es alcanzable desde ningún input
  // de esta route, y no hay test que la ponga en rojo. Lo que aporta es estructura, no cobertura.
  let ownerParaPersistir: string | null;
  try {
    ownerParaPersistir = provedAddress === undefined ? null : canonicalizeAddress(provedAddress);
  } catch (err) {
    // 🔴 ETIQUETA PROPIA, y ése es medio hotfix: `kyc_session_token_write_failed` cubría TAMBIÉN este
    // caso —`canonicalizeAddress` corría dentro del `try` del `put`, vía el propio `put`— así que el
    // log decía "no se pudo escribir" cuando la causa real era "la dirección no era válida". Dos
    // causas que se arreglan distinto no pueden compartir etiqueta.
    console.warn("[kyc-session] kyc_session_owner_not_canonical", {
      atada: provedAddress !== undefined,
      ...causaDe(err),
    });
    return NextResponse.json({ error: "kyc_session_unavailable" }, { status: 503 });
  }

  // (2) LA PERSISTENCIA, HASTA DONDE SE PUEDE VERIFICAR SIN ESCRIBIR BASURA. Ver el docblock de
  // (`probeReachable`, `../../../../src/infrastructure/persistence/supabase-kyc-session-tokens.ts:185`):
  // mide alcance + credencial + existencia de la tabla + permiso de LECTURA, y NO mide que el insert
  // vaya a andar. La alternativa —un insert de prueba que después se borra— se descartó ahí mismo,
  // con su motivo: deja residuo en una tabla del money-path.
  try {
    await tokenStore.probeReachable();
  } catch (err) {
    console.warn("[kyc-session] kyc_session_token_probe_failed", {
      atada: provedAddress !== undefined,
      ...causaDe(err),
    });
    return NextResponse.json({ error: "kyc_session_unavailable" }, { status: 503 });
  }

  // ⛔ EL `callback` SE FUE (DT-11). Ya no se construye ni se manda: el agente valida el
  // `callbackUrl` contra una allowlist de orígenes que nace VACÍA (fail-closed), así que mandarlo sin
  // esa env sería un 400 garantizado; y el retomar del flujo de Chaski no depende del callback sino
  // del pendiente en `localStorage`. Con él se fue `KYC_CALLBACK_BASE_URL`.
  //
  // 🔴 AR/BLQ-BAJO-1 — EL `try/catch` ES DE ESTA RUTA, Y NO DEL CLIENTE. `createAgentKycSession`
  // RECHAZA en cinco sitios (transporte caído, JSON roto, raíz no-objeto, y cada clave faltante o con
  // el tipo equivocado: `kyc_agent_bad_response:session:<clave>`). Hace bien en tirar —ahí no hay
  // ningún status upstream que reportar—, pero sin este `catch` el rechazo escapaba de la route y
  // Next contestaba un **500 genérico**: ni el 502 que el contrato de abajo declara, ni el
  // `console.warn` que lo hace diagnosticable. Medido con tres sondas del AR, no deducido.
  //
  // `upstream: 0` = "no hubo status upstream". Es el MISMO valor que ya usa `decision/route.ts` para
  // su rama sin fila.
  //
  // 🔴 SALVO UNA CAUSA, Y SEPARARLA ES EL PUNTO (re-AR it2 · BLQ-MED-2). Sin
  // `KYC_AGENT_INVOKE_SECRET` el fallo NO es "el agente no contestó": es que NOSOTROS no podemos
  // acreditarnos, y no salió ningún viaje. Colapsarla en el `0` del transporte es el mismo daño que
  // costó los ocho días —un diagnóstico que no distingue causas que se arreglan distinto—, sólo que
  // ahora del lado del fail-closed. ⇒ va con su propio `upstream` y el cliente ya emitió
  // `session_config_missing` con el NOMBRE de la env.
  // ⚠️ Y ESTO **SÍ** CAMBIA EL CONJUNTO OBSERVABLE, dicho en voz alta: en un entorno sin la env, el
  // body pasa de `{error:"kyc_session_failed", upstream:401}` (el 401 del agente, camino fail-open)
  // a `{..., upstream:-1}`. El STATUS sigue siendo 502 en los dos.
  let r: AgentKycCall<KycAgentSessionOutput>;
  try {
    r = await createAgentKycSession({ identityRef: provedAddress });
  } catch (err) {
    // ⛔ Value-free: del `err` NO se lee ni el `message` ni nada más que su TIPO. El `message` puede
    // traer la clave que faltó y, por el camino del transporte, la URL del agente. El cliente ya
    // emitió su propio log de rama.
    r = {
      ok: false,
      upstream: err instanceof KycAgentConfigError ? UPSTREAM_INVOKE_SECRET_UNSET : 0,
    };
  }

  if (!r.ok) {
    // 🔴 ESTE 502 COLAPSA TODO FALLO DEL AGENTE, y por eso lleva log. Son CINCO causas, no cuatro, y
    // la quinta es la que este 502 no veía hasta el fix-pack del AR:
    //   · una caída del agente / DNS / timeout ⇒ el `fetch` RECHAZA ⇒ entra por el `catch` de arriba
    //     con `upstream: 0`. ⚠️ Antes ESTA RAMA NO SE ALCANZABA: la route rechazaba y Next devolvía
    //     un 500 genérico, y este `console.warn` no se emitía nunca. La frase que decía "una caída
    //     del agente" era FALSA para el caso más común de todos.
    //   · sus credenciales del proveedor ausentes (nace INERTE ⇒ 502) ⇒ `!res.ok` ⇒ `upstream: 502`.
    //   · un 401 de su guard de invoke ⇒ `!res.ok` ⇒ `upstream: 401`.
    //   · el camino sin atar rechazado por el agente ⇒ `!res.ok` ⇒ `upstream: 400`.
    //   · 🔴 NUEVO DE ESTA HU: un agente que contesta **200 sin `decisionToken`** (o con cualquier
    //     clave del contrato faltante o del tipo equivocado). El cliente estrecha y tira
    //     `kyc_agent_bad_response:session:decisionToken` ⇒ `catch` ⇒ `upstream: 0`. Es exactamente el
    //     caso que la cabecera del cliente dice manejar, y sin este `catch` salía por 500.
    // Desde afuera las cinco se ven idénticas ("suben los 502").
    //
    // VALUE-FREE, y las dos palabras cuentan (P-14/CD-15): `atada` es un BOOLEANO DERIVADO de si hubo
    // dirección probada — NUNCA la dirección. No viaja el `identityRef`, ni el body, ni el challenge,
    // ni la firma. `upstream` es el status del agente, que además ya sale en la respuesta.
    //
    // ⚠️ LO QUE ESTE LOG NO MIDE: sólo se emite en el camino de FALLO. NO cuenta cuántas sesiones sin
    // atar se crean con ÉXITO, así que NO sirve para dimensionar la deduplicación perdida que se
    // documenta más arriba. Eso necesitaría una señal en el camino feliz, y no está. ⚠️ Y AUNQUE LA
    // TUVIERA, contar sesiones CREADAS no dimensionaría el consumo de cupo: lo que consume es la que
    // se COMPLETA, y ese dato no lo tiene este repo por ningún camino (bloque «CUÁNDO SE CONSUME»).
    console.warn("[kyc-session] kyc_session_failed", {
      atada: provedAddress !== undefined,
      upstream: r.upstream,
    });
    return NextResponse.json({ error: "kyc_session_failed", upstream: r.upstream }, { status: 502 });
  }

  // 🔴 LA ESCRITURA DEL TOKEN **NO ES BEST-EFFORT**, Y ES LO CONTRARIO DE LA ESCRITURA DEL VEREDICTO
  // (que sí lo es, en `decision/route.ts`). ⛔ No las unifiques.
  //
  // POR QUÉ. El `decisionToken` es la ÚNICA credencial que después autoriza a leer la decisión de
  // esta sesión, por CUALQUIER camino: ni la pantalla ni el pago pueden hacerlo sin ella, y el agente
  // NO tiene forma de re-emitirla (CD-21). Si no se persiste y devolviéramos la URL igual, la persona
  // escanearía su documento para un veredicto que NADIE va a poder consultar nunca.
  // ⇒ Fallar acá cuesta UN reintento. No fallar cuesta UNA VERIFICACIÓN ENTERA — y ese renglón SIGUE
  // SIENDO CIERTO con el hecho nuevo, porque el costo lo pone la persona al COMPLETAR el escaneo para
  // un veredicto que nadie va a poder leer. Es el único sitio de este archivo donde el "cuesta" estaba
  // del lado correcto.
  //
  // ⚠️ CONSECUENCIA DECLARADA: la sesión YA se creó en el agente y no hay forma de deshacerlo desde
  // acá (no existe un `DELETE /session`) ⇒ queda una fila colgada en el proveedor. ⚠️ ACÁ DECÍA "así
  // que la CUOTA YA SE GASTÓ" y es FALSO: si se falla acá, la persona nunca abre esa sesión y queda
  // `Not Started`, que no se contabiliza (bloque «CUÁNDO SE CONSUME LA CUOTA»). El costo aceptado es
  // basura en el proveedor, no cuota, y sigue siendo estrictamente menor que el otro.
  //
  // ⛔ `ownerAddress` SALE DE `provedAddress` —la dirección PoP-PROBADA— Y DE NINGÚN OTRO LADO. Nunca
  // de `body.vendorData`, nunca de otro campo del body, nunca de un header. Es P-3/P-11 extendido a
  // la credencial nueva, y es exactamente por qué se eligió persistir el token server-side en vez de
  // devolvérselo al navegador. `undefined` (sin prueba) ⇒ `null`: la sesión queda SIN ATAR y —por
  // construcción de la query owner-scoped, no por un chequeo que alguien tenga que recordar— jamás
  // va a poder autorizar un desembolso.
  //
  // El código de error es `kyc_session_unavailable`/503, que esta route YA DEVUELVE HOY (la rama de
  // `PAYOUT_POP_SECRET` ausente): el conjunto observable de errores no cambia.
  //
  // ⚠️ ACÁ ESTABA `getKycSessionTokenStore()` con su guard de `null`, y SUBIÓ al bloque de guards del
  // principio (AR/BLQ-BAJO-2): preguntarlo recién acá creaba una sesión en el proveedor antes de un
  // chequeo gratis (⚠️ decía "gastaba una verificación", y crear no gasta: ver el bloque «CUÁNDO SE
  // CONSUME LA CUOTA»; lo que dejaba era una sesión colgada, y el orden sigue siendo el correcto).
  // Lo que queda —la ESCRITURA— no puede subir: necesita el `sessionId`, que sólo existe después.
  try {
    await tokenStore.put({
      sessionId: r.output.sessionId,
      decisionToken: r.output.decisionToken,
      ownerAddress: ownerParaPersistir,
    });
  } catch (err) {
    // Value-free: la etiqueta de la rama + el CÓDIGO de la causa. ⛔ NUNCA el token, ni el sessionId,
    // ni la dirección, ni el `message` crudo del driver.
    //
    // 🔴 ACÁ SE TIRABA EL ERROR ENTERO (`} catch {`), y eso es lo que dejó el incidente del
    // 2026-08-20 sin causa: el store SÍ traía el SQLSTATE —tira
    // `kyc_session_token_write_failed:<code>`, (`put`, `../../../../src/infrastructure/persistence/supabase-kyc-session-tokens.ts:262`)—
    // y este `catch` lo descartaba. Diagnosticar "42P01 (falta la migración)" y "23505 (sessionId
    // duplicado)" se hacía a ciegas, con hipótesis, cuando el dato estaba a una línea.
    // 🟩 Y SIRVIÓ, MEDIDO: el 2026-08-20 21:43:40 UTC este log emitió `dbCode: '23505'` y ESE dato es
    // el diagnóstico entero del hotfix F-3 de abajo. ⛔ No lo degrades.
    //
    // 🔴 Y DESDE EL HOTFIX F-3 HAY UNA CAUSA MÁS QUE NO ES "NO SE PUDO ESCRIBIR", ASÍ QUE NO
    // COMPARTE ETIQUETA. `put` ya no es un `insert` pelado: sabe ATAR una sesión que el proveedor
    // devolvió repetida, y RECHAZA —fail-closed— la que ya está atada a otra dirección. Ese rechazo
    // no se arregla mirando la base ni la migración: se arregla mirando quién está pidiendo la
    // sesión de quién. Colapsarlo en `..._write_failed` sería repetir exactamente el daño que este
    // bloque existe para cerrar (un log que no distingue causas que se arreglan distinto), sólo que
    // ahora sobre la única que además es un evento de seguridad.
    //
    // ⛔ El literal va escrito acá y NO importado del store: `route.test.ts` mockea ese módulo, así
    // que un import llegaría `undefined` y `causa.errorCode === undefined` matchearía cualquier
    // error sin código — el discriminador se volvería un comodín SIN ponerse rojo. Lo que ata las
    // dos copias es `T-HF3-*`, que corre esta route contra el store REAL.
    const causa = causaDe(err);
    const etiqueta =
      causa.errorCode === "kyc_session_owner_conflict"
        ? "kyc_session_owner_conflict"
        : "kyc_session_token_write_failed";
    console.warn(`[kyc-session] ${etiqueta}`, {
      atada: provedAddress !== undefined,
      ...causa,
    });
    // El STATUS y el BODY no cambian —503 `kyc_session_unavailable`, el mismo que esta route ya
    // devuelve—, y es a propósito: desde afuera no se le dice a quien pide si esa sesión existe y de
    // quién es. La distinción vive en el log, que es de adentro.
    return NextResponse.json({ error: "kyc_session_unavailable" }, { status: 503 });
  }

  // `authToken` = el HMAC NUESTRO (WKH-179) que autoriza el GET /decision de ESTA route.
  // ⛔ CD-20: NO se devuelve el `decisionToken` del agente. No va en el body, no va en una cabecera,
  // no va a un log. Vive server-side y se lee owner-scoped.
  const authToken = issueSessionToken(r.output.sessionId);
  return NextResponse.json({ sessionId: r.output.sessionId, url: r.output.url, authToken });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
//  🔴 LA CAUSA, SIN EL VALOR (hotfix 2026-08-20 · F-1)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// QUÉ ESTABA MAL. El `catch` de la escritura del token era `} catch {` pelado: descartaba el error
// ENTERO. El único rastro del incidente del 2026-08-20 fue
// `kyc_session_token_write_failed { atada: true }` — una etiqueta que no distingue NINGUNA causa de
// las que se arreglan distinto, y que además MENTÍA sobre una de ellas (`canonicalizeAddress` corría
// dentro de ese mismo `try`, vía `put`, así que "no se pudo escribir" podía ser en realidad "la
// dirección no era válida"). Es el mismo daño que el otro repo ya pagó y ya documentó: cuatro guards
// que tiran `new Error(...)` reportan todos `name: 'Error'`, "el log distinguía cero causas de
// cuatro, y desde afuera las cuatro se ven igual".
//
// MOLDE COPIADO, NO INVENTADO: `wasiai-remittance-agents`,
// `src/app/api/agents/remit-kyc-validator/session/route.ts` (bloque del `catch`). De ahí sale el
// `errorName` y el `errorCode` con su regex EXACTA.
//
// ⛔ POR QUÉ ESTO NO PUEDE SER UN SECRETO NI PII — POR SU FORMA, NO POR CONFIANZA:
//   · `errorName`: el `name` de un `Error`. Es un identificador de clase (`Error`, `TypeError`,
//     `KycAgentConfigError`), nunca contenido.
//   · `errorCode`: el prefijo del `message` hasta el primer `:`, y SÓLO si matchea
//     `^[a-z][a-z0-9_]{2,47}` — minúsculas, dígitos y guión bajo, tope 48. Este repo escribe siempre
//     sus códigos así (`kyc_session_token_write_failed`, `address_canonicalization_failed`,
//     `kyc_session_token_probe_failed`). Una API key, un token `k1.…`, una pubkey base58, una URL o
//     un nombre propio NO matchean ese patrón: todos llevan mayúsculas, puntos, guiones o barras. Si
//     el `message` no arranca con un código —un error de runtime, uno de una librería— el match
//     falla y la clave NO se emite.
//   · `dbCode`: la cola DESPUÉS del primer `:`, y sólo si es un SQLSTATE (5 caracteres `[A-Z0-9]`,
//     p. ej. `42P01`, `23505`, `42501`), un código de PostgREST (`PGRST` + 3 dígitos, hasta 8
//     caracteres) o el literal `unknown` que el propio store escribe cuando el driver no trae `code`.
//     El ÚNICO productor de esa cola es `error.code ?? "unknown"` del store, que es un enum del
//     motor. Cualquier otra cosa —incluido cualquier texto con minúsculas o separadores— NO matchea
//     y NO se emite. ⛔ El `message` crudo del driver no se ecoa nunca: puede traer el valor de un
//     filtro.
//
// ⚠️ LO QUE ESTO NO HACE: no clasifica. Emite el código y deja el juicio a quien lea el log. Y para
// un error que no es `Error` (un `throw "texto"`, un rechazo con un objeto) devuelve sólo
// `errorName: "unknown"` — eso es la tercera clase, "otra cosa", y se ve como tal.
function causaDe(err: unknown): { errorName: string; errorCode?: string; dbCode?: string } {
  if (!(err instanceof Error)) return { errorName: "unknown" };
  const errorCode = /^[a-z][a-z0-9_]{2,47}/.exec(err.message)?.[0] ?? null;
  const corte = err.message.indexOf(":");
  const cola = corte === -1 ? "" : err.message.slice(corte + 1);
  const dbCode = /^(?:[A-Z0-9]{5}|PGRST[0-9]{3}|unknown)$/.test(cola) ? cola : null;
  return {
    errorName: err.name,
    ...(errorCode !== null ? { errorCode } : {}),
    ...(dbCode !== null ? { dbCode } : {}),
  };
}
