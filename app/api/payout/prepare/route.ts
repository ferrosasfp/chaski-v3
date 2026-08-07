// Server-side: PREPARE del payout no-custodial (WKH-211 / HU-SOL-11, AC-1/AC-7). Crea la orden TransFi
// (invoca al agente remit-cashout-payout) y emite la SolanaDepositAttestation HMAC que ata el
// beneficiary (deposit-address) y la release-authority a ESTA remesa ANTES de que el cliente firme
// (Opción B, DT-1). La wallet arma la ix `deposit` del escrow contra ese beneficiary atestado.
//
// Compone challenge/route.ts (emisor HMAC del PoP) + los guards de autoridad WKH-202 y PoP WKH-206.
// Guard-order fail-closed (envs leídas en runtime, CD-14): 501-BASE → 503-secreto → rate-limit →
// formato → PoP → fila del veredicto → autoridad → forward → shape+depositAddress → attest →
// ledger → 200.
//
// 🔴 EL PoP Y LA AUTORIDAD INTERCAMBIARON POSICIÓN EN WKH-333, y son los ÚNICOS dos bloques que se
// movieron (más uno nuevo insertado entre ellos). El motivo, y qué cierra, está escrito arriba de
// cada uno. Antes, la autoridad corría primero: un anónimo llegaba a ella con un identificador
// cualquiera y esta ruta le contestaba distinto según ese identificador existiera o no, gastándonos
// un fetch al proveedor de identidad en cada intento.
//
// TODO defensivo: NUNCA 500 crudo; errores = enums opacos, PII-free; NUNCA ecoa BASE ni el beneficiary
// (CD-5). REMIT_AGENTS_BASE_URL vive SOLO acá (server-only, SIN NEXT_PUBLIC_). El depositAddress real
// (no-null) exige el agente con TRANSFI_ADAPTER_READY=true (cross-repo WKH-212); el mock devuelve null
// → PR8 fail-closed (nunca se atesta sin address confirmada).
import { NextResponse } from "next/server";
import {
  LOGGABLE_PREPARE_REJECTIONS,
  PREPARE_NO_AGENT_FOR_CAPABILITY,
  noAgentMeansNobodyFits,
  prepareRejectionEnum,
} from "../../../../src/application/agent-rejections";
import {
  buildSolanaPopMessage,
  verifySolanaPopChallenge,
} from "../../../../src/infrastructure/auth/pop-challenge";
import { verifySolanaPop } from "../../../../src/infrastructure/auth/pop-verify-solana";
import {
  resolveSolanaNetworkId,
  resolveSolanaReleaseAuthorityPubkey,
  resolveSolanaNetworkConfig,
} from "../../../../src/infrastructure/chain";
import { canonicalizeAddress } from "../../../../src/infrastructure/address";
import {
  PAYOUT_CAPABILITY,
  PAYOUT_DIRECT_AGENT_SLUG,
  PAYOUT_MIN_REPUTATION,
  logGatewayFailure,
  runViaGateway,
} from "../../../../src/infrastructure/a2a/gateway-client";
import {
  CHAIN_ID_NOT_APPLICABLE,
  getSettlementLedger,
} from "../../../../src/infrastructure/persistence/supabase-settlement-ledger";
import { logLedgerWriteFailure } from "../../../../src/infrastructure/persistence/ledger-write-failure";
import { getKycVerdictStore } from "../../../../src/infrastructure/persistence/supabase-kyc-verdicts";
import { resolvePayoutAuthority } from "../../../../src/infrastructure/payout/authority";
import {
  DEPOSIT_ATTESTATION_TTL_SECONDS,
  issueSolanaDepositAttestation,
} from "../../../../src/infrastructure/settlement/deposit-attestation";
import {
  DEPOSIT_PREPARE_RL,
  checkRouteRateLimit,
  clientIp,
} from "../../../../src/infrastructure/rate-limit";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v); // excluye arrays
}

// Shape mínimo del result del agente (mirror del isValidPayoutResult de submit/route.ts). El
// depositAddress se valida aparte en PR8 (exige string no-vacío + base58 canónico).
function isValidPayoutResult(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const statusOk =
    v.status === "submitted" || v.status === "settled" || v.status === "failed" || v.status === "blocked";
  if (!statusOk) return false;
  if (!(typeof v.payoutId === "string" || v.payoutId === null)) return false;
  if (!(typeof v.deliveredLocal === "number" || v.deliveredLocal === null)) return false;
  if (!(typeof v.txRef === "string" || v.txRef === null)) return false;
  if (!(typeof v.reason === "string" || v.reason === null)) return false;
  if (v.payoutId === null && v.status !== "failed" && v.status !== "blocked") return false;
  return true;
}

/**
 * ¿El agente RECHAZÓ la orden? `status` failed/blocked es la respuesta del agente diciendo que no
 * la creó, y `reason` es por qué.
 *
 * Acá está el corazón del hallazgo #75 del lado del desembolso: `reason` se validaba de TIPO en
 * `isValidPayoutResult` (línea 62) y su VALOR no lo leía nadie. El resultado era que
 * `kyc_gate_not_passed`, `quote_amount_mismatch`, `quote_unresolvable`,
 * `kyc_identity_claim_missing` y "el provider es mock" salían los cinco por el mismo
 * `prepare_no_deposit_address` — un enum que además describe mal a cuatro de los cinco: el agente
 * no es que no nos dio la dirección, es que decidió no crear la orden.
 *
 * El mock queda AFUERA a propósito y sigue muriendo en PR8: contesta `status:"submitted"` con
 * `depositAddress:null`, que no es un rechazo sino una respuesta incompleta. Ahí
 * `prepare_no_deposit_address` sí describe lo que pasó.
 *
 * Devuelve `null` si no hubo rechazo. Si lo hubo, `{ enum, logged }`: el enum es lo que sale al
 * browser (filtrado por la allow-list de relayables) y `logged` es lo que va al log del server
 * (lista cerrada más amplia; lo desconocido se anota como `unmapped` en vez de ecoarse crudo).
 */
function readPayoutRejection(v: unknown): { enum: string; logged: string } | null {
  if (!isRecord(v)) return null;
  if (v.status !== "failed" && v.status !== "blocked") return null;
  const raw = v.reason;
  return {
    enum: prepareRejectionEnum(raw),
    logged: typeof raw === "string" && LOGGABLE_PREPARE_REJECTIONS.includes(raw) ? raw : "unmapped",
  };
}

export async function POST(req: Request): Promise<Response> {
  // PR1 — sin backend del agente no hay orden que crear. PRIMERO (intacto respecto de submit:66).
  const BASE = process.env.REMIT_AGENTS_BASE_URL; // server-only (CD-9), leído en runtime
  if (!BASE) return NextResponse.json({ error: "prepare_not_configured" }, { status: 501 });

  // PR2 — prepare SOLO existe en el path real: sin el secreto NO puede atestar → 503 fail-closed (NUNCA
  // fail-open). Diferencia DELIBERADA con el submit (que skipea local sin secreto): el demo nunca llama
  // a prepare con los flags OFF (no se cablea) ⇒ AC-5 intacto.
  if (!process.env.DEPOSIT_ATTESTATION_SECRET) {
    return NextResponse.json({ error: "prepare_unavailable" }, { status: 503 });
  }

  // PR3 — rate-limit IP-only, TRAS PR2 y ANTES de parsear/forwardear. Cada prepare crea una orden real
  // → sin esto, spam = órdenes huérfanas masivas (DT-5). IP-only (el body aún no se parsea).
  const rl = await checkRouteRateLimit(DEPOSIT_PREPARE_RL, { ip: clientIp(req) });
  if (rl.unavailable) {
    return NextResponse.json({ error: "prepare_rate_limit_unavailable" }, { status: 503 }); // fail-closed
  }
  if (!rl.ok) {
    return NextResponse.json(
      { error: "prepare_rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
    );
  }

  // PR4 — body null-safe (CD-9: req.json() RESUELVE `null` con el body literal `null` → el .catch NO
  // dispara; isRecord cubre null y los no-objeto). Formato: sin evidencia parseable, NINGÚN fetch.
  const parsed: unknown = await req.json().catch(() => null);
  const body: Record<string, unknown> = isRecord(parsed) ? parsed : {};
  const remittanceId = typeof body.remittanceId === "string" ? body.remittanceId : "";
  const quoteId = typeof body.quoteId === "string" ? body.quoteId : "";
  // 🔴 EL `kycVerificationId` DEL BODY SE LEE PARA DESCARTARLO, Y NADA MÁS (WKH-333/AC-16, CD-26).
  // Se lee explícitamente en vez de ignorarlo en silencio para que este renglón sea el único lugar
  // donde el valor del caller existe, y para que quede escrito que NO se usa: ni para consultar a la
  // autoridad, ni para reenviar al agente. El que viaja sale de la fila del dueño PoP-verificado
  // (PR5.5). PROHIBIDO un `?? idDelBody` acá abajo: si no hay fila, se corta.
  void (typeof body.kycVerificationId === "string" ? body.kycVerificationId : "");
  const address = typeof body.address === "string" ? body.address : "";
  // HU-SOL-9: `address` es base58. canonicalizeAddress throwea con malformado → try/catch → false →
  // el mismo 400 opaco (CD-2).
  let addressOk: boolean;
  try {
    canonicalizeAddress(address);
    addressOk = true;
  } catch {
    addressOk = false;
  }
  // El `kycVerificationId` SALIÓ de esta condición: exigirlo sería exigirle al cliente un dato que
  // ya no le corresponde tener, y rechazar por su ausencia sería un camino de respaldo escondido en
  // un guard de formato.
  if (!remittanceId.trim() || !quoteId.trim() || !addressOk) {
    return NextResponse.json({ error: "prepare_invalid_request" }, { status: 400 });
  }

  // 🔴 ESTE BLOQUE SUBIÓ: era PR6 y ahora es PR5' (WKH-333/AC-18, CD-28). El intercambio con el
  // bloque de autoridad, que bajó a PR6', es lo único que cambió de orden en toda la ruta.
  //
  // POR QUÉ ES POSIBLE — no hay dependencia de datos entre los dos, y está medido:
  //   sed -n '183,226p' app/api/payout/prepare/route.ts | grep "\bd\b\|d\."        # sin salida
  //   sed -n '183,226p' app/api/payout/prepare/route.ts | grep "kycVerificationId"    # sin salida
  //   sed -n '147,167p' app/api/payout/prepare/route.ts | grep "pop\|ch\."           # sin salida
  // (las líneas son las de la versión ANTERIOR a este cambio, sobre 9beb814). El bloque PoP sólo lee
  // `body.popChallenge`, `body.popSignature`, `address` y `resolveSolanaNetworkId()`.
  //
  // POR QUÉ HACE FALTA, y qué cierra: hasta acá, un caller ANÓNIMO que mandara un `kycVerificationId`
  // cualquiera llegaba a la autoridad, provocaba UN FETCH A DIDIT por intento, y las respuestas se
  // distinguían — un id que existe y no autoriza daba 403, uno inventado daba 502. O sea que esta
  // ruta era un oráculo de existencia y estado de verificaciones de identidad ajenas, detrás de nada
  // más que el rate-limit por IP, y encima nos gastaba cupo del proveedor en cada intento. Con el PoP
  // arriba, los tres casos dan el MISMO 403 y NINGUNO toca a Didit. Eso no es un comentario: lo
  // asserta T-PR-4 comparando las dos respuestas byte a byte y contando las llamadas al fetch.
  //
  // ⛔ LO QUE CIERRA ES **ESTA RUTA**, NO EL SISTEMA (AR/MNR-1). El mismo oráculo sigue abierto en
  // `app/api/payout/validate/route.ts`, que es público y no pide PoP: un `verificationId` real
  // devuelve 200 `kyc_not_authorized` y uno inventado devuelve 502, con fetch a Didit en los dos
  // casos. Es PREEXISTENTE y está declarado Out of Scope (R-6). El balance de esta HU es que quedan
  // dos superficies menos una, no cero.
  //
  // NINGÚN GUARD QUEDA MÁS DÉBIL. Lo único observable que cambia además: un deployment con
  // DIDIT_API_KEY y sin PAYOUT_POP_SECRET ahora responde 503 en vez de 400/403 — y ese deployment
  // ya no podía completar un pago igual, porque el PoP lo cortaba dos guards después.
  // PR5' — proof-of-possession (WKH-206/HU-SOL-8). OBLIGATORIO: sin PAYOUT_POP_SECRET → 503 fail-closed
  // (NUNCA skip), nunca opt-in. Stateless a propósito: el nonce NO se quema en este repo.
  //
  // ⚠️ QUÉ SIGNIFICA ESO, sin adornos (corregido por SDD 037). Acá decía que el anti-replay dentro
  // del TTL "es responsabilidad del facilitator, que es quien exige y verifica la prueba". Eso era
  // falso por dos motivos: aquella prueba HMAC del facilitator pertenecía al leg de PATROCINIO, no
  // a este, y además ya no existe (la reemplazó una firma ed25519 sin secreto compartido). El
  // facilitator nunca vio este challenge ni puede quemar este nonce.
  //
  // Lo cierto es que NADIE quema el nonce: dentro de los 10 minutos de TTL (pop-challenge.ts) un
  // par (challenge, firma) capturado se puede reenviar a esta ruta. El input que lo demuestra:
  // repetir el mismo request dos veces dentro de la ventana — las dos pasan. Residual R-3;
  // restituir el single-use acá es una HU aparte.
  // Cualquier fallo cripto → 403 opaco (CD-4, no-oracle).
  const POP_SECRET = process.env.PAYOUT_POP_SECRET; // CD-14: dentro del handler
  // CD-2 / AC-3: OBLIGATORIO. Sin secreto → 503 fail-closed (NUNCA skip).
  if (!POP_SECRET) {
    return NextResponse.json({ error: "payout_pop_unavailable" }, { status: 503 });
  }
  const popChallenge = body.popChallenge;
  const popSignature = body.popSignature;
  // P1 — presencia + tipo → 403 opaco.
  if (
    typeof popChallenge !== "string" ||
    !popChallenge.trim() ||
    typeof popSignature !== "string" ||
    !popSignature.trim()
  ) {
    return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  }
  // P2 — HMAC + exp + tipos colapsan en null → 403 opaco.
  const ch = verifySolanaPopChallenge(popChallenge, Date.now());
  if (!ch) {
    return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  }
  // P3 — address match (CD-8, base58 case-sensitive). canonicalizeAddress throwea → try/catch → 403.
  try {
    if (canonicalizeAddress(ch.address) !== canonicalizeAddress(address)) {
      return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  }
  // P4 — CAIP-2 binding (AC-4/CD-3): network-id del token vs el resuelto server-side, NUNCA del body.
  if (ch.networkId !== resolveSolanaNetworkId()) {
    return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  }
  // P5 — ed25519 (AC-1/AC-2): mensaje reconstruido con la MISMA buildSolanaPopMessage (CD-6). SIN
  // claim-once del nonce: ver la nota de arriba (residual R-3).
  if (
    !verifySolanaPop({
      addressBase58: ch.address,
      message: buildSolanaPopMessage(ch),
      signatureBase58: popSignature,
    })
  ) {
    return NextResponse.json({ error: "payout_pop_unverified" }, { status: 403 });
  }

  // PR5.5 — 🔴 DE DÓNDE SALE EL IDENTIFICADOR DE LA VERIFICACIÓN (WKH-333/AC-16, AC-17, CD-26).
  //
  // Hasta acá lo traía el cliente en el body. Eso lo convertía en un TOKEN AL PORTADOR que atravesaba
  // un control del money-path: quien lo tuviera —de un localStorage ajeno, de un log, de la red—
  // podía presentarlo. Ahora el backend lo saca de SU PROPIA fila, indexada por la dirección que el
  // bloque de arriba probó que es del caller.
  //
  // ⛔ NO HAY CAMINO DE RESPALDO, y no es una omisión: es la restricción. Ni un `?? body.kycVerificationId`,
  // ni una env que lo habilite, ni una rama transitoria. Sin fila utilizable se CORTA con enum propio.
  // Eso no es un oráculo: para llegar hasta acá el caller ya probó posesión de la dirección, así que
  // sólo se entera de su propia situación.
  //
  // 🔴 `KYC_VERDICT_STORE_ENABLED` NO ES UN KILL-SWITCH. ES UN INTERRUPTOR DE UNA SOLA DIRECCIÓN, Y
  // APAGARLO CORTA LOS PAGOS. Acá decía "con el flag apagado esta ruta no cambia de comportamiento",
  // y era FALSO — medido con la autoridad REAL en el lazo (AR/BLQ-ALTO-1): sin store, el `""` que se
  // le pasaba a `resolvePayoutAuthority` cae en su guard de formato (`authority.ts:58-60` y `:65-67`,
  // las dos ramas) ⇒ `invalid_verification_id` ⇒ **400 a TODO pagador legítimo**, sin consultar
  // siquiera a la autoridad. El candado de esa medición es
  // `app/api/payout/prepare/route.flag-off.test.ts`, que NO mockea la autoridad.
  //
  // No se arregla, se DECLARA: la alternativa era aceptar el id del cliente mientras el flag esté
  // apagado, y eso es exactamente lo que CD-26 prohíbe ("ni gateado por env, ni transitorio"). O sea
  // que el flag OFF no puede significar "como antes", porque "como antes" es el agujero.
  //
  // Consecuencias, escritas para que nadie las descubra en producción:
  //   · El orden de despliegue es migración → **flag ON** → deploy del código (§11 del Story File,
  //     corregido). Encender un flag para código que todavía no está desplegado es setear la variable
  //     en el proveedor: NADIE la lee hasta que el deploy la levante, y el deploy la levanta ya
  //     encendida. Al revés (deploy y después flag) hay una ventana de corte total.
  //   · El rollback NO es apagar el flag: es re-desplegar el código anterior. Recién ahí el flag OFF
  //     es inocuo, y recién ahí el `_down` de la migración es ejecutable.
  const verdictStore = getKycVerdictStore();
  if (!verdictStore) {
    // No hay dónde preguntar ⇒ no hay identificador que presentar, y no existe otro lugar de donde
    // sacarlo. 503 y NO 400: el pedido del caller está bien; lo que falta es configuración nuestra, y
    // un 400 le echaría la culpa al que llama. Comparte enum con el fallo de lectura de abajo a
    // propósito: los dos dicen "no pudimos comprobar", que es lo que pasó en los dos.
    return NextResponse.json({ error: "prepare_kyc_verdict_unavailable" }, { status: 503 });
  }
  let row: Awaited<ReturnType<typeof verdictStore.get>>;
  try {
    // OWNER-SCOPED con `ch.address`, la PoP-VERIFICADA — NUNCA `body.address` (CD-18). Son iguales
    // en el camino legítimo porque P3 los comparó, y aun así se usa la del challenge: la del body
    // es un valor que el caller escribió, la del challenge es una que firmó.
    row = await verdictStore.get(canonicalizeAddress(ch.address));
  } catch {
    // NUNCA 500 crudo, NUNCA eco del error.code de Postgres. No poder preguntar NO es "no hay":
    // se corta con el enum de "no pudimos comprobar", no con el de "no estás verificado".
    return NextResponse.json({ error: "prepare_kyc_verdict_unavailable" }, { status: 503 });
  }
  if (!row) {
    // AC-17: sin fila NO se crea ninguna orden, no se atesta nada y no se escribe en el ledger.
    return NextResponse.json({ error: "prepare_kyc_verdict_missing" }, { status: 403 });
  }
  // ⚠️ LO QUE ESTE `if (!row)` **NO** MIRA, y conviene tenerlo escrito (AR/MNR-3): la VIGENCIA. Una
  // fila vencida según `KYC_VERDICT_TTL_DAYS` se usa igual acá. No es un descuido: el que decide si
  // este pago procede es la autoridad, tres líneas más abajo, que re-consulta a Didit en cada pago
  // (CD-12) y tiene su propio estado terminal de vencimiento. ⇒ `KYC_VERDICT_TTL_DAYS` es política
  // de PANTALLA (cuándo `/api/kyc/verdict` deja de decir "usable" y la persona vuelve a verificarse),
  // NO política de pago. Bajarlo a 180 no le corta el pago a nadie; subirlo a 730 no se lo habilita.
  const rowVerificationId = row.verificationId;

  // PR6' — autoridad server-side (WKH-202): re-consulta la decisión REAL de Didit. Nunca confía en
  // los booleanos del caller. Mismo switch fail-closed que submit.
  //
  // 🔴 ESTE BLOQUE BAJÓ: era PR5 y ahora corre DESPUÉS del PoP y de la resolución de la fila. La
  // función es LA MISMA, con los MISMOS dos argumentos y el MISMO ownership check fail-closed contra
  // el `vendor_data` que Didit ecoa. Lo único que cambia es de dónde sale su primer argumento: ya no
  // del body, sino de la fila del dueño PoP-verificado (PR5.5). Lo único que pierde es el privilegio
  // de gastar un fetch a Didit para un caller que iba a morir en el PoP de todos modos.
  //
  // ⚠️ CD-12 INTACTO: que exista una fila NO autoriza nada por sí sola. El momento del dinero sigue
  // re-consultando a la autoridad, acá, en cada pago.
  const d = await resolvePayoutAuthority({ verificationId: rowVerificationId, address });
  if (d.reason === "simulated_dev" && (process.env.VERCEL_ENV ?? "") !== "") {
    return NextResponse.json({ error: "payout_authority_unavailable" }, { status: 503 });
  }
  if (!d.authorized) {
    switch (d.reason) {
      case "invalid_verification_id":
        return NextResponse.json({ error: "prepare_invalid_request" }, { status: 400 });
      case "kyc_not_approved":
      case "kyc_ownership_mismatch":
        // CD-12 no-oracle: MISMO código para ambos (no ser un oráculo del estado KYC ajeno).
        return NextResponse.json({ error: "payout_not_authorized" }, { status: 403 });
      case "kyc_authority_unavailable":
        return NextResponse.json({ error: "payout_authority_unavailable" }, { status: 503 });
      default:
        // fail-closed: reason ausente/desconocido → RECHAZA (nunca forward).
        return NextResponse.json({ error: "payout_authority_unavailable" }, { status: 502 });
    }
  }

  // PR7 — forward al agente (crea la orden TransFi). Transporte según adapter (WKH-304, DT-3/CD-3).
  // El adapter se lee ACÁ y no antes: PR1-PR6 corren SIEMPRE e idénticos con el flag prendido o
  // apagado (CD-3) — el cambio de transporte no puede mover un solo guard de lugar.
  // Este es el ÚNICO leg del money-path que cambia de transporte: el `result` que sale de acá va al
  // MISMO PR8 (validador del depositAddress) y al MISMO PR9 (emisor de la atestación) que ya existían.
  // El transporte NO participa de ninguno de los dos (CD-10): el piso de reputación sube el piso, no
  // reemplaza esas dos capas, que son independientes de QUÉ agente respondió.
  // 🔴 PAYLOAD SANEADO (WKH-333/AC-16). Se arma UNA vez, ANTES del `if`, y lo usan LAS DOS ramas de
  // transporte. El `kycVerificationId` del cliente —si vino— queda PISADO por el de la fila: el
  // spread pone `...body` primero justo para eso. No hay ninguna rama donde el valor del caller
  // sobreviva, y el test lo asserta en las DOS ramas por separado (T-PR-11 / M-30) precisamente para
  // que una futura división en dos sitios no pueda regresar en silencio.
  //
  // `rowVerificationId` acá SIEMPRE viene de una fila que existe: si no había store se cortó con 503
  // y si no había fila se cortó con 403, las dos cosas arriba. No hay ninguna rama que llegue hasta
  // este renglón con un identificador vacío o propuesto por el cliente.
  const forwardBody = { ...body, kycVerificationId: rowVerificationId };
  let result: unknown;
  // QUIÉN dio el depositAddress. `undefined` = no lo sabemos (rama punto-a-punto: ahí el agente lo
  // fija la URL, no lo elige nadie). Viaja al 200 para que la remesa pueda decir de dónde salió la
  // dirección contra la que la persona firmó. NO participa de ningún guard.
  let resolvedAgent: Record<string, unknown> | undefined;
  if (process.env.NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER === "a2a-gateway") {
    const r = await runViaGateway({
      steps: [
        {
          capability: process.env.WASIAI_A2A_PAYOUT_CAPABILITY ?? PAYOUT_CAPABILITY,
          constraints: { min_reputation: PAYOUT_MIN_REPUTATION }, // CD-5: NUNCA omitir
          input: forwardBody, // saneado: el kycVerificationId es el de la fila, no el del cliente
        },
      ],
    });
    if (!r.ok) {
      logGatewayFailure("payout-prepare", r);
      // CD-1: JAMÁS cae al fetch punto-a-punto de abajo. No hay orden, no hay atestación, no hay
      // ledger. Un fallback silencioso acá crearía la orden con OTRO agente y atestaría SU dirección.
      //
      // WKH-332/AC-13 — "ninguna capacidad resolvió" sale con enum PROPIO y 422, no con el 502 de una
      // caída. Reintentar no crea un agente: la misma llamada, un segundo después, vuelve a no
      // encontrar a nadie, y el 502 invitaba justamente a eso. Es el ÚNICO code que se abre: el resto
      // —incluido `payment_required`, que hablaría de nuestro saldo y no del pedido de quien llama—
      // sigue colapsado en `prepare_upstream_error`. Un enum nuestro no es un eco del gateway (CD-5).
      //
      // 🔴 Y NO ALCANZA CON EL `code` (AR/BLQ-MED-1). El 422 colapsa CUATRO motivos, y uno de ellos
      // —`reputation_unavailable`— es "el gateway no pudo leer el historial", o sea "no pude
      // preguntar". Para ese, decir "no hay ningún proveedor" y "reintentar no cambia el resultado"
      // es falso en las dos mitades, y desaconseja lo único que funciona. Sale por el enum de caída,
      // que ya dice lo correcto. El `reason` se USA para ramificar y NUNCA se ecoa (CD-5/CD-8): el
      // body sigue teniendo una sola clave, y esa clave es una palabra nuestra.
      if (r.code === "no_agent_match" && noAgentMeansNobodyFits(r.reason))
        return NextResponse.json(
          { error: PREPARE_NO_AGENT_FOR_CAPABILITY },
          { status: 422 },
        );
      return NextResponse.json(
        { error: r.code === "not_configured" ? "prepare_not_configured" : "prepare_upstream_error" },
        { status: r.code === "not_configured" ? 501 : 502 },
      );
    }
    result = r.outputs[0];
    // El gateway SÍ dice a quién eligió (`steps[i].agent`); hasta acá se descartaba. Si no lo dijo
    // de forma legible queda undefined y la remesa lo va a decir así, sin rellenar.
    const chosen = r.agents[0];
    if (chosen) resolvedAgent = { ...chosen };
  } else {
    // ── rama punto-a-punto EXISTENTE, sin cambios de lógica (CD-15) ──
    // idempotencyKey intacto (CD-10). Todo en try/catch: timeout/DNS/parse → 502 opaco, NUNCA 500
    // crudo, NUNCA ecoa el beneficiary.
    let res: Response;
    try {
      // El slug sale de la MISMA constante que el preview muestra como "quién corre hoy" (ver
      // PAYOUT_DIRECT_AGENT_SLUG): eran dos literales sin relación y la pantalla nombraba otro.
      res = await fetch(`${BASE}/api/agents/${PAYOUT_DIRECT_AGENT_SLUG}/invoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // MISMO objeto saneado que la rama del gateway (CD-10/CD-5). Si acá volviera `body`, el
        // agente recibiría el identificador que mandó el cliente en esta rama y el de la fila en la
        // otra: la misma ruta autorizando distinto según una env de transporte.
        body: JSON.stringify(forwardBody),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return NextResponse.json({ error: "prepare_upstream_error" }, { status: 502 });
    }
    if (!res.ok) {
      return NextResponse.json({ error: "prepare_upstream_error" }, { status: 502 });
    }

    try {
      const json = (await res.json()) as { result?: unknown };
      result = json.result;
    } catch {
      return NextResponse.json({ error: "prepare_upstream_error" }, { status: 502 });
    }
  }

  // PR8 — valida el shape + EXIGE depositAddress string no-vacío + base58 canónico. El mock del agente
  // devuelve depositAddress:null → AQUÍ muere (AC-7 fail-closed): NUNCA se atesta sin address confirmada.
  if (!isValidPayoutResult(result)) {
    return NextResponse.json({ error: "prepare_upstream_error" }, { status: 502 });
  }
  // PR8b — el agente RECHAZÓ la orden. Va ANTES del guard de depositAddress porque si no, un
  // rechazo perfectamente explicado (el agente dijo POR QUÉ) sale disfrazado de "no nos dio
  // dirección". 422 y no 502: el pedido llegó, se entendió y se negó, así que reintentarlo igual no
  // lo arregla. Nada se atestó, nada se escribió en el ledger y NINGUNA firma se pidió: el prepare
  // corre antes de `authorizePrincipal` (confirm-and-send.ts:381-386).
  const rejection = readPayoutRejection(result);
  if (rejection) {
    // Sólo enums (CD-5/CD-9): ni el beneficiary, ni la BASE, ni el body del request. El detalle que
    // NO sale al browser (p. ej. `kyc_gate_not_passed`, colapsado a propósito — ver
    // agent-rejections.ts) sí queda acá, que es donde el operador puede leerlo.
    console.warn("[payout-prepare] agent_rejected", {
      reason: rejection.logged,
      relayed: rejection.enum,
    });
    return NextResponse.json({ error: rejection.enum }, { status: 422 });
  }
  const okResult = result as { payoutId: string | null; provenance?: unknown; depositAddress?: unknown };
  const depositAddress = typeof okResult.depositAddress === "string" ? okResult.depositAddress : "";

  // PR8-PR11 — bloque de respuesta.
  // 1. beneficiary = MISMO depositAddress del agente (DT-1). Vacío → enum opaco.
  if (!depositAddress.trim()) {
    return NextResponse.json({ error: "prepare_no_deposit_address" }, { status: 502 });
  }
  // base58 válido (AC-3, no-oráculo: MISMO enum que el caso vacío, no distinguir motivo).
  try {
    canonicalizeAddress(depositAddress);
  } catch {
    return NextResponse.json({ error: "prepare_no_deposit_address" }, { status: 502 });
  }
  // 2. payoutId presente (fail-closed: no atestar una orden sin id trackeable).
  const payoutIdSol = typeof okResult.payoutId === "string" ? okResult.payoutId : "";
  if (!payoutIdSol.trim()) {
    return NextResponse.json({ error: "prepare_no_deposit_address" }, { status: 502 });
  }
  const provenanceSol = typeof okResult.provenance === "string" ? okResult.provenance : "";
  // 3. authority (DESPUÉS de validar beneficiary, DT-2). Ausente/malformada → 503 enum NUEVO opaco.
  let authoritySol: string;
  try {
    authoritySol = resolveSolanaReleaseAuthorityPubkey();
  } catch {
    return NextResponse.json({ error: "prepare_solana_authority_unavailable" }, { status: 503 });
  }
  // 4. cluster ("devnet").
  const clusterSol = resolveSolanaNetworkConfig().cluster;
  // 5. atestación Solana (beneficiary/authority/cluster; mismo TTL/secret).
  const attestationSol = issueSolanaDepositAttestation({
    remittanceId,
    quoteId,
    beneficiary: depositAddress,
    authority: authoritySol,
    cluster: clusterSol,
    exp: Math.floor(Date.now() / 1000) + DEPOSIT_ATTESTATION_TTL_SECONDS,
  });
  // 6. ledger best-effort (vm:"solana" es el discriminante; el ledger IGNORA el chainId en esta rama y
  //    escribe network_id CAIP-2 + chain_id NULL — ver vmNetworkColumns). NUNCA rompe (CD-17).
  const ledgerSol = getSettlementLedger();
  if (ledgerSol) {
    try {
      await ledgerSol.recordOrderPrepared({
        remittanceId,
        quoteId,
        idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : `${remittanceId}:${quoteId}`,
        depositAddress,
        chainId: CHAIN_ID_NOT_APPLICABLE, // no hay chainId numérico en Solana; vmNetworkColumns lo descarta
        senderAddress: address,
        payoutId: payoutIdSol,
        // La MISMA `provenanceSol` que sale en el 200 (abajo), no una copia ni un recálculo. Este pase
        // faltaba: el valor se leía del agente, se le contaba al browser y NO se guardaba, así que la
        // fila de una orden simulada quedaba idéntica en forma a una real y la evidencia no podía
        // contestar si había movido plata. Es un `string` obligatorio en el port justamente para que
        // borrar esta línea NO compile.
        payoutProvenance: provenanceSol,
        vm: "solana",
      });
    } catch (e) {
      // MISMO control de flujo (se traga la excepción, CD-17); cambia SOLO la señal: una violación de
      // integridad (SQLSTATE 23xxx = bug nuestro, la fila NO se escribió) grita en error+[ALERT], un
      // fallo de infra transitorio va a warn, y lo NO mapeado grita por default.
      logLedgerWriteFailure("recordOrderPrepared", e);
    }
  }
  // 7. 200 — matchea EXACTO isValidSolanaPrepareShape del gateway.
  return NextResponse.json(
    {
      beneficiary: depositAddress,
      authority: authoritySol,
      attestation: attestationSol,
      payoutId: payoutIdSol,
      provenance: provenanceSol,
      // Aditivo y opcional: el cliente lo lee aparte y su ausencia no invalida nada. NO va dentro
      // de la atestación a propósito: la atestación ata el DESTINO, y meterle un campo que no
      // participa del binding sólo agranda lo que hay que firmar sin proteger nada más.
      ...(resolvedAgent ? { agent: resolvedAgent } : {}),
    },
    { status: 200 },
  );
}
