// Server-side: crea una sesión de verificación de identidad EN EL AGENTE DE KYC — su nombre vive UNA
// sola vez, en `agent-env.ts` (WKH-233/CD-2). Este repo YA NO le habla al proveedor de KYC por ningún
// camino: la credencial del proveedor vive en el agente. Env-gated (501 si no hay host del agente).
//
// ⛔ ESTA ROUTE NO ES UN PROXY, Y NO PUEDE SERLO (CD-1). Lo que se reemplazó es UN `fetch`. Todo lo
// demás se queda, y cada cosa por su motivo:
//   · `clientIp()` + `checkKycRateLimit` (P-1/P-2) — 🔴 EL AGENTE NO TIENE RATE LIMIT. Si el límite
//     sale de acá, NO LO CUBRE NADIE, y cada sesión creada consume cuota del proveedor. Corre ANTES
//     de cualquier viaje al agente, y su candado cuenta LLAMADAS, no status.
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
import type { AgentKycCall } from "../../../../src/infrastructure/kyc/agent-kyc-client";
import { createAgentKycSession, KycAgentConfigError, UPSTREAM_INVOKE_SECRET_UNSET } from "../../../../src/infrastructure/kyc/agent-kyc-client";
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
  // Supabase ausentes eso QUEMA UNA VERIFICACIÓN DEL PROVEEDOR por request y después contesta 503:
  // cuota gastada por una misconfig NUESTRA, que este mismo archivo ya cuenta como el costo caro
  // ("Fallar acá cuesta UN reintento. No fallar cuesta UNA VERIFICACIÓN ENTERA", más abajo). Con el
  // limiter en 5/10min, cada IP quema 5 cupos por ventana, indefinidamente y sin que nadie se
  // verifique. Resolver el store NO es un fetch (es leer dos envs y construir el cliente), así que
  // subirlo no toca P-7: al agente se le sigue hablando recién después de los guards.
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
  // genera verificaciones que NO se colapsan, y cada una consume cuota. ⛔ NO se inventa un
  // centinela: cualquier valor que no sea la dirección PROBADA reabre R-1, que costó un bloqueante
  // cerrar. Un identificador de sesión no adivinable sería diseño nuevo, y va a HU aparte.
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

  // ── PRE-VUELO — LO QUE PUEDE FALLAR POR CULPA NUESTRA VA **ANTES** DE GASTAR LA CUOTA ──────────
  // (hotfix 2026-08-20 · F-2)
  //
  // 🔴 EL INCIDENTE QUE LO PIDE, MEDIDO. 2026-08-20, 14:09:58 UTC: el agente contestó **200** —la
  // sesión se creó en el proveedor y la cuota SE GASTÓ— y recién después falló la escritura del token
  // de más abajo. La route devolvió 503 y la persona NO recibió la URL. Pagamos una verificación y no
  // entregamos nada. La doctrina que esto aplica ya estaba escrita en el otro repo
  // (`wasiai-remittance-agents`, `src/app/api/agents/remit-kyc-validator/session/route.ts`, bloque
  // "POR QUÉ EL SECRETO Y EL WORKFLOW SE RESUELVEN ANTES DE CREAR LA SESIÓN"): *"si se resolvieran
  // DESPUÉS, una misconfiguración NUESTRA dejaría una sesión creada en el partner que nadie va a
  // poder consultar: CUOTA GASTADA y un BINDING COLGADO"*. Es literalmente lo que pasó.
  //
  // ⛔ NO DICE, NI VA A DECIR, "YA NO PUEDE PASAR". Lo que cambia es CUÁNDO ocurre cada clase:
  //   · ANTES de gastar cuota (acá): la dirección que no canonicaliza, y todo lo que hace que la
  //     tabla no sea alcanzable/legible — falta la migración, la credencial de Supabase no sirve, el
  //     proyecto no responde, no hay permiso de SELECT.
  //   · DESPUÉS de gastar cuota (sigue igual, y se declara): todo lo que sólo dispara al INSERTAR —
  //     `session_id` duplicado, una restricción de columna, una columna que falta en el insert, un
  //     GRANT que da SELECT y niega INSERT— y la base que se cae en la ventana entre este pre-vuelo
  //     y el `put`. Esa 503 se distingue por su etiqueta: `..._write_failed`, no `..._probe_failed`.
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
  // (`probeReachable`, `../../../../src/infrastructure/persistence/supabase-kyc-session-tokens.ts:151`):
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
    // atar se crean con ÉXITO, así que NO sirve para dimensionar el consumo de cupo por deduplicación
    // perdida que se documenta más arriba. Eso necesitaría una señal en el camino feliz, y no está.
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
  // ⇒ Fallar acá cuesta UN reintento. No fallar cuesta UNA VERIFICACIÓN ENTERA.
  //
  // ⚠️ CONSECUENCIA DECLARADA: la sesión YA se creó en el agente, así que la CUOTA YA SE GASTÓ, y no
  // hay forma de deshacerlo desde acá (no existe un `DELETE /session`). Es el costo aceptado, y es
  // estrictamente menor que el otro.
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
  // principio (AR/BLQ-BAJO-2): preguntarlo recién acá gastaba una verificación del proveedor antes de
  // un chequeo gratis. Lo que queda —la ESCRITURA— no puede subir: necesita el `sessionId`, que sólo
  // existe después del agente.
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
    // `kyc_session_token_write_failed:<code>`, (`put`, `../../../../src/infrastructure/persistence/supabase-kyc-session-tokens.ts:164`)—
    // y este `catch` lo descartaba. Diagnosticar "42P01 (falta la migración)" y "23505 (sessionId
    // duplicado)" se hacía a ciegas, con hipótesis, cuando el dato estaba a una línea.
    console.warn("[kyc-session] kyc_session_token_write_failed", {
      atada: provedAddress !== undefined,
      ...causaDe(err),
    });
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
