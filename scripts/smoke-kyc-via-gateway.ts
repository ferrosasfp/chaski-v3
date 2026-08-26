// scripts/smoke-kyc-via-gateway.ts
//
// Smoke e2e del KYC POR EL COORDINADOR (WKH-366 / W4 · AC-13). Corre contra los servicios
// DESPLEGADOS, con el agente en su modo simulado de verificación. Es la mitad que los tests con
// `vi.stubGlobal("fetch")` NO pueden probar: el CABLEADO real (CD-7).
//
// 🔴 VA COMO `.ts` Y NO COMO `.mjs`, Y NO ES ESTILO (DT-14): `tsconfig.scripts.json` incluye
// `["scripts/**/*.ts"]`, así que un `.mjs` NO LO TYPECHEQUEA NADIE y el gate del repo pasaría verde
// sobre un script roto. El work-item decía `.mjs`; se desvía a propósito.
//
// ── LOS SEIS PASOS ────────────────────────────────────────────────────────────────────────────────
//   1. GET  {gateway}/discover/<slug de sesión>   → inputSchema (+ huella)
//   2. deriveInput(inputSchema)  ← DEL SCHEMA DE ESA CORRIDA. ⛔ Nunca hardcodeado.
//   3. POST {gateway}/compose  { steps:[{ agent:<slug de sesión>, input:<derivado> }] }
//      y se afirma: success, UN step, el ejecutor es NUESTRO agente, SIN bridgeType, y el output son
//      EXACTAMENTE las cuatro claves del contrato, cruzadas contra el outputSchema.
//      🔴 «EL EJECUTOR ES NUESTRO AGENTE» YA NO ES EL PAR `(slug, self-published)`, Y ESE ERA EL
//      DEFECTO (fix-pack AR/BLQ-ALTO-1): ese par lo publica cualquier caller autenticado del
//      Coordinador, así que el exit 6 de abajo NO PODÍA DISPARARSE ANTE EL ATAQUE REAL. Hoy se cruza
//      además el ORIGEN de `invokeUrl` contra `KYC_AGENT_BASE_URL`, que sale del ENTORNO DE LA SONDA
//      y no del catálogo que se está midiendo.
//   4. GET  {gateway}/discover/<slug de decisión> → assert de DRIFT sobre sus `required`.
//      ⚠️ ESTE PASO NO SE DERIVA CIEGAMENTE: su input es una CREDENCIAL emitida en el paso 3.
//         Derivar `decisionToken: "x-decisionToken"` sólo probaría que el 401 funciona. Lo que se
//         deriva del catálogo es el CONJUNTO DE CLAVES; los VALORES vienen del paso 3.
//   5. POST {gateway}/compose  { steps:[{ agent:<slug de decisión>, input:{…} }] } y los mismos
//      asserts de ejecutor/bridge/forma.
//   6. self-test OPT-IN: repetir el paso 5 SIN una clave requerida ⇒ tiene que ser RECHAZADO.
//
// ── EXIT CODES — cada uno atribuye la causa ───────────────────────────────────────────────────────
//   0 PASS · 1 excepción no manejada (DEFECTO DE LA SONDA) · 2 caída candidata de producción
//   3 config de la sonda (envs, credencial, saldo) · 4 drift de contrato
//   5 se ACEPTÓ un cuerpo inválido · 6 SUPLANTACIÓN (el ejecutor no fue el agente propio)
//
// ⛔ NUNCA IMPRIME UNA CREDENCIAL, NI TRUNCADA: ni el `decisionToken`, ni la Agent Key, ni la URL de
// verificación (que lleva el identificador de la sesión), ni el `sessionId`.
//
// ⛔ EL ÚNICO MÉTODO NO-GET SON LOS `POST /compose`, Y NINGUNO SE REINTENTA ANTE TIMEOUT: un POST que
// expiró pudo haberse ejecutado del otro lado, y repetirlo paga dos veces (cada step se cobra).
//
// ── QUÉ HACE FALTA PARA QUE ESTO PUEDA SALIR 0 (al 2026-08-26 NO ESTÁ) ───────────────────────────
//   · Los dos endpoints del agente DESPLEGADOS (W1), lo que a su vez necesita dos variables de
//     entorno sembradas por el founder ANTES del deploy; sin ellas su `/manifest` da 503.
//   · Las DOS filas del catálogo del Coordinador REGISTRADAS (W2). Sin ellas, `/discover/<slug>` da
//     404 y esta sonda sale 4 (DRIFT), que es el desenlace correcto y NO un verde.
//   · `WASIAI_A2A_GATEWAY_URL` + `WASIAI_A2A_AGENT_KEY` en el entorno donde se corra, con SALDO en la
//     red de `WASIAI_A2A_PAYMENT_CHAIN` (el saldo de una Agent Key es POR RED). Sin saldo: exit 3.
//   · `KYC_AGENT_BASE_URL` en el entorno donde se corra. Sin ella la sonda sale **3 (CONFIG) sin
//     mandar un solo POST**: no puede verificar quién ejecutó, y una medición que no se puede
//     verificar no se paga ni se declara.
//   Hasta entonces esta sonda NO se puede correr en verde, y eso está bien: lo que no se midió no se
//   declara. Sus piezas puras sí están testeadas (`smoke-kyc-helpers.test.ts`).
import {
  EXIT,
  type HttpObs,
  type Observacion,
  assertExecutor,
  assertNoBridge,
  assertOutputKeys,
  classify,
  deriveInput,
  requiredSubset,
  safeEcho,
  schemaFingerprint,
} from "./smoke-kyc-helpers";
// El MISMO parser que usan el transporte y `assertExecutor`. Ver el comentario de `agentOrigin`.
import { originOf } from "../src/infrastructure/kyc/agent-origin";

const SESSION_SLUG = "remit-kyc-session";
const DECISION_SLUG = "remit-kyc-decision";

/** Las CUATRO claves del contrato del paso de sesión. */
const SESSION_KEYS = ["sessionId", "url", "decisionToken", "provenance"] as const;
/** Las del paso de decisión que la sonda afirma como strings no vacíos. */
const DECISION_KEYS = ["status", "verificationId", "provenance"] as const;
/** Lo que la sonda SABE llenar con datos de la corrida. Todo lo demás en `required` es DRIFT. */
const LLENABLES = ["sessionId", "identityClaim", "decisionToken"] as const;

const DISCOVER_TIMEOUT_MS = 15_000;
const COMPOSE_TIMEOUT_MS = 60_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Un viaje. `retryOnTimeout` es SIEMPRE `false` para los POST: ver la cabecera.
 * ⛔ Nunca devuelve el cuerpo crudo hacia el log: sólo lo que la escalera necesita para clasificar.
 */
async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retryOnTimeout: boolean,
): Promise<HttpObs> {
  for (let intento = 0; ; intento += 1) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const body: unknown = await res.json().catch(() => null);
      return { status: res.status, body };
    } catch (err) {
      const name = err instanceof Error ? err.name : "error-de-red";
      const esTimeout = name === "TimeoutError" || name === "AbortError";
      if (intento === 0 && esTimeout && retryOnTimeout) continue;
      // El `name` de un rechazo a nivel conexión es siempre `TypeError` (fetch lo envuelve), que no
      // dice nada. El código real vive en `cause.code` — `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`—
      // y es lo único que distingue "no hay DNS" de "el puerto rechaza" de "se cortó a mitad. Mismo
      // criterio que la sonda del camino del dinero.
      const cause: unknown = err instanceof Error ? err.cause : undefined;
      const code =
        isRecord(cause) && typeof cause.code === "string" ? cause.code : name;
      return { networkError: code };
    }
  }
}

function primerStep(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !Array.isArray(body.steps)) return null;
  const s: unknown = body.steps[0];
  return isRecord(s) ? s : null;
}

function schemasDe(discover: HttpObs): { input: unknown; output: unknown } {
  const card = isRecord(discover.body) ? discover.body : {};
  const meta = isRecord(card.metadata) ? card.metadata : {};
  return { input: meta.inputSchema ?? null, output: meta.outputSchema ?? null };
}

interface Config {
  gateway: string;
  key: string;
  /**
   * 🔴 EL ORIGEN DEL AGENTE PROPIO, y de dónde sale importa: de `KYC_AGENT_BASE_URL`, o sea del
   * ENTORNO de la sonda — **nunca del catálogo que la sonda está midiendo**. Un valor derivado de la
   * respuesta que se quiere verificar convertiría el exit 6 en un control que se lee a sí mismo.
   *
   * `null` = la sonda no puede afirmar contra qué comparar. Eso NO deja pasar nada: `assertExecutor`
   * rechaza, y la escalera lo clasifica como CONFIG (3), que es lo honesto — es un defecto del
   * entorno de la sonda, no una acusación contra producción.
   */
  agentOrigin: string | null;
  paymentChain?: string;
  identityClaim?: string;
  selfTestField: string | null;
}

function leerConfig(env: NodeJS.ProcessEnv): Config | null {
  const gateway = env.WASIAI_A2A_GATEWAY_URL?.trim();
  const key = env.WASIAI_A2A_AGENT_KEY?.trim();
  if (!gateway || !key) return null;
  const paymentChain = env.WASIAI_A2A_PAYMENT_CHAIN?.trim();
  const identityClaim = env.SMOKE_KYC_IDENTITY?.trim();
  return {
    gateway: gateway.replace(/\/+$/, ""),
    key,
    // ⛔ Se normaliza con el MISMO parser que el transporte (`originOf`), no con un `.replace` a
    // mano: dos normalizadores distintos para la misma comparación es cómo se desincronizan.
    agentOrigin: originOf(env.KYC_AGENT_BASE_URL?.trim()),
    ...(paymentChain ? { paymentChain } : {}),
    ...(identityClaim ? { identityClaim } : {}),
    selfTestField: env.SMOKE_KYC_SELF_TEST_OMIT_REQUIRED?.trim() || null,
  };
}

function cabecerasCompose(cfg: Config): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-a2a-key": cfg.key,
    ...(cfg.paymentChain ? { "x-payment-chain": cfg.paymentChain } : {}),
  };
}

async function componer(
  cfg: Config,
  slug: string,
  input: Record<string, unknown>,
): Promise<HttpObs> {
  return request(
    `${cfg.gateway}/compose`,
    {
      method: "POST",
      headers: cabecerasCompose(cfg),
      body: JSON.stringify({ steps: [{ agent: slug, input }] }),
    },
    COMPOSE_TIMEOUT_MS,
    false,
  );
}

interface Hechos {
  sessionSchemaSha: string;
  decisionSchemaSha: string;
  omitted: string[];
  sessionStatus: string | number;
  decisionStatus: string | number;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const t0 = Date.now();
  const hechos: Hechos = {
    sessionSchemaSha: "-",
    decisionSchemaSha: "-",
    omitted: [],
    sessionStatus: "-",
    decisionStatus: "-",
  };
  const cfg = leerConfig(env);
  const obs: Observacion = {
    credentialPresent: cfg !== null,
    gatewayConfigured: cfg !== null,
    selfTestField: cfg?.selfTestField ?? null,
  };
  if (!cfg) return emitir(classify(obs), hechos, t0);

  // 0 — 🔴 ¿CONTRA QUÉ VAMOS A COMPARAR AL EJECUTOR? Si la sonda no sabe cuál es el origen del
  //     agente propio, no puede afirmar quién ejecutó, y el corte va ACÁ —antes del primer viaje—
  //     por dos motivos: (a) cada `POST /compose` se COBRA, y pagar por una medición que no se va a
  //     poder verificar es tirar saldo; (b) si se dejara correr, `assertExecutor` rechazaría y la
  //     escalera diría SUPLANTACIÓN, o sea una acusación contra producción fabricada por una env
  //     nuestra que falta. La clase correcta es CONFIG (3), y así sale.
  obs.agentOriginKnown = cfg.agentOrigin !== null;
  if (!obs.agentOriginKnown) return emitir(classify(obs), hechos, t0);

  // 1 — el catálogo del paso de sesión
  obs.discoverSession = await request(
    `${cfg.gateway}/discover/${SESSION_SLUG}`,
    { method: "GET" },
    DISCOVER_TIMEOUT_MS,
    true,
  );
  const sesSchemas = schemasDe(obs.discoverSession);
  obs.discoverSession.inputSchema = sesSchemas.input;
  if (!sesSchemas.input) return emitir(classify(obs), hechos, t0);
  hechos.sessionSchemaSha = schemaFingerprint(sesSchemas.input);

  // 2 — el cuerpo, derivado del schema DE ESTA CORRIDA
  const derivado = deriveInput(sesSchemas.input);
  hechos.omitted = derivado.omitted;
  if (!("input" in derivado)) {
    obs.derive = { reason: derivado.reason, field: derivado.field, detail: derivado.detail };
    return emitir(classify(obs), hechos, t0);
  }

  // 3 — el paso de sesión
  obs.composeSession = await componer(cfg, SESSION_SLUG, derivado.input);
  hechos.sessionStatus = obs.composeSession.status ?? "-";
  const stepSesion = primerStep(obs.composeSession.body);
  obs.sessionExecutor = assertExecutor(stepSesion?.agent, SESSION_SLUG, cfg.agentOrigin);
  obs.sessionBridge = assertNoBridge(stepSesion);
  obs.sessionShape = assertOutputKeys(stepSesion?.output, SESSION_KEYS, sesSchemas.output);
  const salida = isRecord(stepSesion?.output) ? stepSesion.output : {};
  const sessionId = typeof salida.sessionId === "string" ? salida.sessionId : null;
  const decisionToken = typeof salida.decisionToken === "string" ? salida.decisionToken : null;
  if (!obs.sessionExecutor.ok || !obs.sessionBridge.ok || !obs.sessionShape.ok) {
    return emitir(classify(obs), hechos, t0);
  }
  if (sessionId === null || decisionToken === null) return emitir(classify(obs), hechos, t0);

  // 4 — el catálogo del paso de decisión. Su input NO se deriva: se deriva el CONJUNTO DE CLAVES.
  obs.discoverDecision = await request(
    `${cfg.gateway}/discover/${DECISION_SLUG}`,
    { method: "GET" },
    DISCOVER_TIMEOUT_MS,
    true,
  );
  const decSchemas = schemasDe(obs.discoverDecision);
  obs.discoverDecision.inputSchema = decSchemas.input;
  if (!decSchemas.input) return emitir(classify(obs), hechos, t0);
  hechos.decisionSchemaSha = schemaFingerprint(decSchemas.input);
  const subset = requiredSubset(decSchemas.input, LLENABLES);
  obs.decisionRequired = subset.ok ? { ok: true } : { ok: false, faltan: subset.faltan };
  if (!subset.ok) return emitir(classify(obs), hechos, t0);

  // 5 — el paso de decisión, con los VALORES de la corrida
  const inputDecision: Record<string, unknown> = { sessionId, decisionToken };
  if (cfg.identityClaim !== undefined) inputDecision.identityClaim = cfg.identityClaim;

  // 6 — el self-test, OPT-IN. Se decide ANTES de mandar: borrar un campo que el cuerpo no tiene es
  //     un no-op SILENCIOSO, y sin este chequeo un typo compra un hallazgo FABRICADO.
  if (cfg.selfTestField) {
    obs.selfTestFieldPresent = cfg.selfTestField in inputDecision;
    if (!obs.selfTestFieldPresent) return emitir(classify(obs), hechos, t0);
    process.stdout.write("SELF-TEST: corrida DELIBERADAMENTE rota — NO mide producción\n");
    delete inputDecision[cfg.selfTestField];
  }

  obs.composeDecision = await componer(cfg, DECISION_SLUG, inputDecision);
  hechos.decisionStatus = obs.composeDecision.status ?? "-";
  const stepDecision = primerStep(obs.composeDecision.body);
  obs.decisionExecutor = assertExecutor(stepDecision?.agent, DECISION_SLUG, cfg.agentOrigin);
  obs.decisionBridge = assertNoBridge(stepDecision);
  obs.decisionShape = assertOutputKeys(stepDecision?.output, DECISION_KEYS, decSchemas.output);

  return emitir(classify(obs), hechos, t0);
}

/**
 * UNA línea de clase a stdout. ⛔ Sin credenciales, sin sessionId, sin la URL de verificación.
 *
 * ⚠️ TD-366-EMITIR-SIN-TESTIGO — **esta función NO TIENE TEST, y el `safeEcho` de acá tampoco.**
 * `emitir` no se exporta (este módulo exporta `main` y `EXIT`, nada más) y **ningún test importa
 * este archivo**: `scripts/smoke-kyc-helpers.test.ts` cubre `safeEcho` como función pura, o sea la
 * herramienta, NO su uso en esta línea. Un mutante que saque el `safeEcho` de acá —o que lo mueva
 * afuera del `join`, que es donde el techo deja de acotar el total— **no pone rojo nada**. El
 * arreglo barato, si alguien vuelve: exportar `emitir`, o mejor extraer el armado del string a
 * `smoke-kyc-helpers.ts`, que ya tiene suite.
 *
 * 🔴 ESTA DEUDA VIVE ACÁ A PROPÓSITO (fix-pack CR/MNR-6), siguiendo el precedente de
 * `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/decision/route.ts`. Estaba
 * declarada SÓLO en el `auto-blindaje.md` de la HU, que vive **en otro repo** (`wasiai-a2a`) y en un
 * documento que nadie relee. **La fuente autoritativa es este comentario**; cualquier copia en un
 * reporte es de conveniencia y envejece sola.
 */
function emitir(v: { message: string; exit: number }, h: Hechos, t0: number): number {
  process.stdout.write(
    `${v.message} | sessionSchemaSha=${h.sessionSchemaSha} decisionSchemaSha=${h.decisionSchemaSha}` +
      // `omitted` son NOMBRES DE PROPIEDAD del `inputSchema` publicado: los pone el publicador, igual
      // que el `slug`, y esta línea es literalmente el stdout del operador. `safeEcho` (WKH-366,
      // MNR-4): el `join` va adentro para que el techo acote el total.
      ` omitted=[${safeEcho(h.omitted.join(","))}] sessionStatus=${h.sessionStatus}` +
      ` decisionStatus=${h.decisionStatus} durationMs=${Date.now() - t0}\n`,
  );
  return v.exit;
}

// Sólo se auto-ejecuta invocado directamente (no cuando lo importa un test).
const invocadoDirecto = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invocadoDirecto) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      // El exit 1 queda RESERVADO para esto: un defecto de la sonda, que no es ninguna de las seis
      // clases y por eso no se confunde con ellas.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[smoke-kyc] excepción no manejada: ${msg}\n`);
      process.exit(1);
    });
}

export { EXIT };
