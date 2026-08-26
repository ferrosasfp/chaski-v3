// scripts/smoke-kyc-helpers.ts
// Piezas PURAS del smoke del KYC por Coordinador (`scripts/smoke-kyc-via-gateway.ts`), WKH-366/W4.
// Cero red, cero `process.env`, cero side-effects: todo esto se puede testear y se testea
// (`smoke-kyc-helpers.test.ts`). **Un script sin tests de sus piezas puras no es una sonda: es una
// opinión.**
//
// Exemplar de ESTRUCTURA: `scripts/smoke-helpers.ts` + su `.test.ts` (el mismo reparto).
// Exemplar de CONTENIDO: `wasiai-a2a/scripts/probe-money-path.mjs` — la derivación desde el schema
// publicado en ESA corrida, la escalera pura, y el default que NO es PASS.
//
// 🔴 LA REGLA CENTRAL NO ES "SONDEAR": es que **cuando no puede derivar un valor, la sonda falla
// ruidosamente en vez de inventarlo**. El cuerpo se deriva del `inputSchema` que el catálogo publica
// en la misma corrida; ningún campo se copia de memoria. Falsable: si alguien lo hardcodeara,
// `deriveInput` dejaría de leer su argumento y el caso `enum → primer valor` de la suite se pone rojo.
//
// ⚠️ EL PASO DE LA DECISIÓN NO SE DERIVA CIEGAMENTE, y es la diferencia con la sonda del dinero: su
// input es una CREDENCIAL emitida en el paso anterior. Derivar `decisionToken: "x-decisionToken"`
// sólo probaría que el 401 funciona. Lo que se deriva del catálogo es el CONJUNTO DE CLAVES
// (`requiredSubset`); los VALORES vienen de la corrida.
//
// ⛔ Nada de acá imprime nunca una credencial, ni truncada.

import { createHash } from "node:crypto";
// La MISMA función que usa el transporte de producción (`src/infrastructure/kyc/gateway-kyc-client.ts`).
// 🔴 Compartirla NO es reuso por comodidad: si la sonda tuviera su propia copia de la comparación, el
// día que una de las dos se relaje la otra seguiría verde y la sonda dejaría de medir el guard que
// dice medir. Es PURA (cero env, cero red), así que importarla no le trae configuración a este módulo.
import { sameOrigin } from "../src/infrastructure/kyc/agent-origin";

// ── Clasificación ─────────────────────────────────────────────────────────────

/**
 * Las SIETE clases, y su código de salida. El código solo ya atribuye la causa: un `2` manda a mirar
 * producción, un `3` manda a mirar la configuración de la sonda, y confundirlos es exactamente el
 * daño que una sonda sin clases produce.
 *
 * `1` no está acá a propósito: queda reservado para una excepción NO MANEJADA, o sea un defecto de la
 * sonda, que no es ninguna de estas clases y no puede confundirse con ellas.
 */
export const EXIT = {
  PASS: 0,
  DOWN: 2,
  CONFIG: 3,
  DRIFT: 4,
  SELF_TEST: 5,
  IMPERSONATION: 6,
} as const;

export type Klass = "PASS" | "DOWN" | "CONFIG" | "DRIFT" | "SELF-TEST" | "IMPERSONATION" | "SKIP";

export interface Verdict {
  klass: Klass;
  exit: number;
  message: string;
}

function verdict(klass: Klass, exit: number, message: string): Verdict {
  return { klass, exit, message };
}

// ── Derivación del cuerpo ─────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type Derived = { ok: true; value: unknown } | { ok: false; detail: string };

/**
 * Un valor conforme al spec PUBLICADO, o el motivo por el que no se puede derivar sin inventarlo.
 *
 * ⛔ Un `string` libre (sin `enum`) NO es derivable, y eso es deliberado: cualquier cadena que la
 * sonda invente sería una afirmación sobre qué acepta el agente que el catálogo no respalda.
 */
function deriveValue(spec: unknown): Derived {
  if (!isRecord(spec)) return { ok: false, detail: "spec-no-es-objeto" };
  if ("enum" in spec) {
    const e = spec.enum;
    if (!Array.isArray(e) || e.length === 0) return { ok: false, detail: "enum-vacio-o-no-array" };
    return { ok: true, value: e[0] };
  }
  if (spec.type === "boolean") return { ok: true, value: false };
  if (spec.type === "number" || spec.type === "integer") {
    // Sólo las cotas PUBLICADAS son candidatas: no hay ningún número por defecto que no sea inventado.
    const cands: number[] = [];
    if (typeof spec.minimum === "number") cands.push(spec.minimum);
    if (typeof spec.maximum === "number") cands.push(spec.maximum);
    if (spec.type === "integer" && typeof spec.exclusiveMinimum === "number") {
      cands.push(spec.exclusiveMinimum + 1);
    }
    for (const c of cands) {
      if (typeof spec.minimum === "number" && !(c >= spec.minimum)) continue;
      if (typeof spec.maximum === "number" && !(c <= spec.maximum)) continue;
      if (spec.type === "integer" && !Number.isInteger(c)) continue;
      return { ok: true, value: c };
    }
    return { ok: false, detail: "cotas-insatisfacibles" };
  }
  if (spec.type === "string") return { ok: false, detail: "string-libre-sin-enum" };
  return { ok: false, detail: `tipo-no-derivable:${String(spec.type)}` };
}

export type DeriveResult =
  | { input: Record<string, unknown>; omitted: string[] }
  | { omitted: string[]; reason: string; field: string; detail: string };

/**
 * Deriva el cuerpo del `inputSchema` recibido EN ESTA CORRIDA. Puro.
 *
 * Lo no derivable y OPCIONAL se omite (omitir un opcional es conforme al schema); lo no derivable y
 * REQUERIDO devuelve `{reason:'required-not-derivable', field}` SIN `input`, que es la señal de
 * contrato cambiado. ⛔ Nunca un valor inventado.
 *
 * Con el schema de HOY del paso de sesión eso produce exactamente una omisión: `identityRef`, un
 * `string` libre que NO está en `required`. ⚠️ No es una excepción escrita acá —el nombre no aparece
 * en este código— sino el resultado de aplicar la regla: el día que ese campo entre a `required`, la
 * MISMA regla lo convierte en DRIFT ruidoso en vez de inventarle un valor.
 */
export function deriveInput(inputSchema: unknown): DeriveResult {
  const schema = isRecord(inputSchema) ? inputSchema : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const input: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const [name, spec] of Object.entries(properties)) {
    const d = deriveValue(spec);
    if (d.ok) input[name] = d.value;
    else if (required.includes(name)) {
      return { omitted, reason: "required-not-derivable", field: name, detail: d.detail };
    } else omitted.push(name);
  }
  for (const name of required) {
    if (!(name in input)) {
      return { omitted, reason: "required-not-derivable", field: name, detail: "no-esta-en-properties" };
    }
  }
  return { input, omitted };
}

/** Huella del schema, para que un DRIFT conteste "¿cambió el schema hoy?" sin arqueología. */
export function schemaFingerprint(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex").slice(0, 12);
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isRecord(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// ── Lo que se afirma de un 2xx ────────────────────────────────────────────────

export type Check = { ok: true } | { ok: false; reason: string };

/** El registry del que TIENEN que salir los dos agentes de KYC. Mismo valor que el transporte. */
export const EXPECTED_REGISTRY = "self-published";

/**
 * Techo de caracteres que la sonda ecoa de un string que NO controla ella.
 *
 * 64 no tiene teoría atrás: es holgado para los dos valores que hoy se ecoan de verdad
 * (`remit-kyc-session` mide 17 y `self-published` 14) y corto para que una fila squatteada no se
 * lleve la pantalla del operador. Lo que lo hace verificable es el test, no el número.
 */
export const ECHO_MAX = 64;

/**
 * Lo ÚNICO por lo que un string ajeno sale al stdout del operador.
 *
 * 🔴 POR QUÉ EXISTE (WKH-366, MNR-4 del AR ronda 2). El comentario de `assertExecutor` declaraba que
 * el `reason` no ecoa la `invokeUrl` «porque ese string lo controla el publicador», y dos ramas más
 * arriba ecoaba `slug` y `registry` CRUDOS — igual de controlados y por la MISMA vía (`POST /agents`
 * del Coordinador es auth-only, y el slug de `a2a_agents` es PK global primero-que-llega). La regla
 * se enunciaba y no se aplicaba. Acá se aplica, y por eso el comentario pasa a ser cierto.
 *
 * ⛔ NO ES «escapar HTML» NI «sacar comillas»: el destino es una TERMINAL. Un `ESC` (0x1B) de más en
 * ese stdout no es ruido — mueve el cursor, repinta y puede tapar justo las líneas que el operador
 * vino a leer. Por eso el criterio es una LISTA BLANCA de ASCII imprimible (0x20–0x7E) y no una lista
 * negra: una lista negra se olvida del carácter que todavía no vio.
 *
 * ⚠️ Y LO NO-ASCII CAE TAMBIÉN, A PROPÓSITO, aunque sea inofensivo de imprimir. Un slug con una `а`
 * cirílica sale IDÉNTICO al nuestro en la pantalla: ecoarlo tal cual no informa, ENGAÑA. Salir como
 * `?` le dice al operador «esto no es lo que parece», que es el dato que necesita.
 *
 * ⚠️ PRECONDICIÓN: `v` viene de un `JSON.parse` de la respuesta del Coordinador, así que `String(v)`
 * no puede tirar. Un `Symbol` —el único valor cuyo `String()` lanza— no atraviesa JSON.
 */
export function safeEcho(v: unknown): string {
  const raw = typeof v === "string" ? v : String(v);
  let out = "";
  for (const ch of raw.slice(0, ECHO_MAX)) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp >= 0x20 && cp <= 0x7e ? ch : "?";
  }
  return raw.length > ECHO_MAX ? `${out}[+${raw.length - ECHO_MAX}]` : out;
}

/**
 * N3 de AC-6, en la sonda: quién ejecutó de verdad.
 *
 * 🔴 EL EXIT 6 DE ESTA SONDA NO PODÍA DISPARARSE ANTE EL ATAQUE REAL, Y ÉSE ERA EL DEFECTO
 * (fix-pack AR/BLQ-ALTO-1). Afirmaba "el ejecutor es el par `(slug, self-published)`", y ese par lo
 * publica **cualquier caller autenticado** del Coordinador: `POST /agents` es auth-only y el slug de
 * `a2a_agents` es PK global primero-que-llega, y una fila self-published nace con su `registry`
 * hardcodeado. Un impostor que se apropiara del slug pasaba las dos comparaciones y la sonda salía
 * **PASS (0)** — o sea que el número reservado para SUPLANTACIÓN sólo alcanzaba a un impostor torpe.
 *
 * ⇒ Se agrega la comparación que un publicador NO puede ganar: el **origen** de `invokeUrl` contra
 * `expectedOrigin`, que la sonda toma de su propio entorno (`KYC_AGENT_BASE_URL`) y no del catálogo
 * que está midiendo. Es la MISMA `sameOrigin` que corre en el transporte de producción.
 *
 * ⛔ El default es fallo, y el criterio —no el conteo— es: **cualquier cosa que no sea "el catálogo
 * dijo que ejecutó NUESTRO agente, en NUESTRO host"**. Los rechazos que hoy escribe la función son
 * `agent` ilegible, slug ajeno, registry ajeno o ausente, y `invokeUrl` que no comparte origen con
 * `expectedOrigin` (ausente e ilegible caen ahí mismo: `sameOrigin` no las distingue a propósito).
 *
 * ⚠️ ACÁ DECÍA «SON CINCO FORMAS» Y EL NÚMERO NO ERA COMPROBABLE (fix-pack CR/MNR-4): el MISMO
 * conjunto está cortado en CUATRO ramas en `invocarPineado` (`src/infrastructure/kyc/
 * gateway-kyc-client.ts`, bloques 2 y 2b) y se enumeraba como TRES en el `describe` de
 * `src/infrastructure/payout/authority.gateway.test.ts`. Tres sitios, tres números, la misma
 * superficie: **el que se pudre solo es el número, no el criterio.**
 *
 * ⚠️ `expectedOrigin` entra por PARÁMETRO y no se lee acá: este módulo es puro por contrato. Quien lo
 * llame con `null` obtiene un rechazo, no un salteo — "no pude verificar" nunca es "verificado".
 */
export function assertExecutor(
  agent: unknown,
  expectedSlug: string,
  expectedOrigin: string | null,
): Check {
  if (!isRecord(agent)) return { ok: false, reason: "el step no trae un `agent` legible" };
  if (agent.slug !== expectedSlug) {
    return { ok: false, reason: `ejecutó «${safeEcho(agent.slug)}» y no «${expectedSlug}»` };
  }
  if (agent.registry !== EXPECTED_REGISTRY) {
    return {
      ok: false,
      reason: `el registry es «${safeEcho(agent.registry)}» y no «${EXPECTED_REGISTRY}»`,
    };
  }
  if (!sameOrigin(agent.invokeUrl, expectedOrigin)) {
    // ⛔ El `reason` NO ecoa la `invokeUrl` observada: se nombra el origen ESPERADO, que sale de
    // NUESTRO entorno, y nada más. Los otros dos strings de este mismo `assertExecutor` sí se ecoan
    // —sin ellos el operador no sabe QUIÉN ejecutó— pero pasan por `safeEcho`, que es lo que hace
    // que la frase de arriba sea una regla del archivo y no una excepción de esta rama.
    return {
      ok: false,
      reason: `el Coordinador invocó un origen que NO es «${String(expectedOrigin)}»`,
    };
  }
  return { ok: true };
}

/**
 * CD-2: un pipeline de UN step no puede haber pasado por un bridge. Se mide PRESENCIA, no valor, por
 * el mismo motivo que en el transporte: el vocabulario del campo lo controla el Coordinador.
 */
export function assertNoBridge(step: unknown): Check {
  if (isRecord(step) && "bridgeType" in step && step.bridgeType !== undefined) {
    return { ok: false, reason: "el step reporta un bridge, y un pipeline de un step no tiene bridge" };
  }
  return { ok: true };
}

export type ShapeCheck = { ok: true } | { ok: false; drift: boolean; reason: string };

/**
 * Las claves del contrato, CRUZADAS contra el `outputSchema` publicado en la misma corrida: si el
 * catálogo ya no declara un campo, eso es DRIFT y no una caída. Afirmar lo contrario convertiría un
 * cambio de contrato en una acusación contra producción.
 */
export function assertOutputKeys(
  output: unknown,
  expected: readonly string[],
  outputSchema: unknown,
): ShapeCheck {
  const declared = isRecord(outputSchema) && isRecord(outputSchema.properties)
    ? outputSchema.properties
    : {};
  if (!isRecord(output)) return { ok: false, drift: false, reason: "el output no es un objeto" };
  for (const field of expected) {
    if (!(field in declared)) {
      return { ok: false, drift: true, reason: `el outputSchema ya no declara «${field}»` };
    }
    if (typeof output[field] !== "string" || output[field] === "") {
      return { ok: false, drift: false, reason: `«${field}» no es un string no vacío` };
    }
  }
  const extra = Object.keys(output).filter((k) => !expected.includes(k));
  if (extra.length > 0) {
    // Las claves las pone el agente que contestó, así que son tan ajenas como el `slug`: mismo
    // `safeEcho`. El `join` va ADENTRO para que el techo acote el total y no cada clave por
    // separado — mil claves de un carácter también son mil caracteres en la pantalla.
    return {
      ok: false,
      drift: true,
      reason: `el output trae claves de más: ${safeEcho(extra.join(","))}`,
    };
  }
  return { ok: true };
}

/**
 * DRIFT del paso de decisión: sus `required` tienen que ser un SUBCONJUNTO de lo que la sonda sabe
 * llenar con datos de la corrida. Si el catálogo pide una clave que la sonda no sabe de dónde sacar,
 * el desenlace es DRIFT y NO un verde — inventarle un valor sólo probaría que el rechazo funciona.
 */
export function requiredSubset(
  inputSchema: unknown,
  llenables: readonly string[],
): { ok: true } | { ok: false; faltan: string[] } {
  const schema = isRecord(inputSchema) ? inputSchema : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string")
    : [];
  const faltan = required.filter((r) => !llenables.includes(r));
  return faltan.length === 0 ? { ok: true } : { ok: false, faltan };
}

// ── La escalera ───────────────────────────────────────────────────────────────

export interface HttpObs {
  networkError?: string;
  status?: number;
  body?: unknown;
}

export interface Observacion {
  credentialPresent: boolean;
  gatewayConfigured?: boolean;
  /**
   * ¿La sonda sabe contra QUÉ origen comparar al ejecutor? (`KYC_AGENT_BASE_URL` en su entorno.)
   *
   * `false` es CONFIG, no SUPLANTACIÓN, y la distinción es el punto: sin este campo, una env nuestra
   * que falta haría que `assertExecutor` rechazara y la escalera acusara a producción de suplantación
   * — un hallazgo FABRICADO, exactamente el modo de falla que el interruptor de self-test ya tiene
   * cubierto con `selfTestFieldPresent`.
   */
  agentOriginKnown?: boolean;
  /** El campo REQUERIDO que la corrida pidió romper, o `null`. Opt-in. */
  selfTestField?: string | null;
  /** ¿Ese campo estaba en el cuerpo que se iba a mandar? `false` ⇒ borrarlo fue un no-op. */
  selfTestFieldPresent?: boolean;
  discoverSession?: HttpObs & { inputSchema?: unknown };
  derive?: { reason?: string; field?: string; detail?: string };
  composeSession?: HttpObs;
  sessionExecutor?: Check;
  sessionBridge?: Check;
  sessionShape?: ShapeCheck;
  discoverDecision?: HttpObs & { inputSchema?: unknown };
  decisionRequired?: { ok: boolean; faltan?: string[] };
  composeDecision?: HttpObs;
  decisionExecutor?: Check;
  decisionBridge?: Check;
  decisionShape?: ShapeCheck;
}

/** Códigos del gateway que hablan de la CREDENCIAL o del SCOPE de la sonda, no de producción. */
const CONFIG_CODES = new Set([
  "INSUFFICIENT_BUDGET",
  "PAYMENT_REQUIRED",
  "INVALID_AGENT_KEY",
  "AGENT_KEY_REVOKED",
  "SCOPE_DENIED",
]);

/**
 * Primera fila que matchea, gana. PURA.
 *
 * 🔴 SU FILA POR DEFECTO NO ES PASS, Y ESO ES EL PUNTO. El precedente está escrito en este
 * ecosistema: "el DEFAULT de una escalera de monitoreo era PASS". La única clase que jamás debe
 * alcanzarse por omisión no puede ser la que dice que todo anda. PASS es INALCANZABLE salvo tras
 * haber observado, positivamente, las dos mitades del recorrido.
 */
export function classify(obs: Observacion): Verdict {
  const v = ladder(obs);
  if (!obs.selfTestField) return v;
  // El interruptor de self-test NO puede terminar en 0 jamás, y tampoco puede afirmar algo que no se
  // midió. Hay DOS formas de no haberlo medido, y las dos son config:
  //   (a) nunca se envió el cuerpo roto (la corrida cortó antes);
  //   (b) el campo que se pidió romper NO estaba en el cuerpo, así que borrarlo fue un no-op: el
  //       cuerpo salió entero, conforme, y el gateway lo aceptó CON RAZÓN. Sin (b), un typo en el
  //       interruptor compra un hallazgo FABRICADO.
  if (obs.selfTestFieldPresent === false) {
    return verdict(
      "CONFIG",
      EXIT.CONFIG,
      "CONFIG: se pidió romper un campo que el cuerpo NO tenía — habría salido entero, así que no se envió nada",
    );
  }
  if (v.klass === "PASS") {
    return verdict(
      "SELF-TEST",
      EXIT.SELF_TEST,
      "SELF-TEST: se ACEPTÓ un cuerpo que viola el schema publicado",
    );
  }
  if (v.exit === EXIT.PASS) {
    return verdict("CONFIG", EXIT.CONFIG, "CONFIG: self-test pedido y no llegó a enviarse ningún cuerpo");
  }
  return v;
}

function claseDeHttp(o: HttpObs, quien: string): Verdict | null {
  if (o.networkError) return verdict("DOWN", EXIT.DOWN, `DOWN: ${quien} inalcanzable (${o.networkError})`);
  const body = isRecord(o.body) ? o.body : {};
  const code =
    typeof body.error_code === "string"
      ? body.error_code
      : typeof body.code === "string"
        ? body.code
        : null;
  if (o.status === 402 || (o.status === 403 && code !== null && CONFIG_CODES.has(code))) {
    return verdict(
      "CONFIG",
      EXIT.CONFIG,
      // `code` sale del cuerpo de la respuesta. Que hoy lo escriba el Coordinador y no un agente es
      // una suposición sobre las tripas de OTRO servicio, y esta línea va a una terminal: `safeEcho`.
      `CONFIG: la credencial de la sonda (${o.status}${code ? `/${safeEcho(code)}` : ""}) — producción no está implicada`,
    );
  }
  const is2xx = typeof o.status === "number" && o.status >= 200 && o.status < 300;
  if (!is2xx) {
    if (body.agentFailure === "INPUT_REJECTED") {
      return verdict("DRIFT", EXIT.DRIFT, `DRIFT: ${quien} rechazó el input DERIVADO del schema publicado`);
    }
    if (body.agentFailure === "AGENT_ERROR") {
      return verdict("DOWN", EXIT.DOWN, `DOWN: ${quien} — el agente contestó un error que no es sobre el pedido`);
    }
    return verdict(
      "DOWN",
      EXIT.DOWN,
      `DOWN: ${quien} no contestó 2xx (${typeof o.status === "number" ? o.status : "sin status"})`,
    );
  }
  if (body.success !== true) {
    return verdict("DOWN", EXIT.DOWN, `DOWN: ${quien} contestó 200 con success !== true`);
  }
  return null;
}

function ladder(obs: Observacion): Verdict {
  if (!obs.credentialPresent || obs.gatewayConfigured === false) {
    return verdict(
      "CONFIG",
      EXIT.CONFIG,
      "CONFIG: falta WASIAI_A2A_GATEWAY_URL o WASIAI_A2A_AGENT_KEY — esto NO dice nada sobre producción",
    );
  }

  // 🔴 VA ANTES DE TODO LO DEMÁS, Y ES EL MISMO PRINCIPIO QUE `selfTestFieldPresent`: lo que no se
  // pudo medir no se declara, ni a favor ni EN CONTRA. Sin el origen esperado, `assertExecutor`
  // rechaza siempre, y sin esta fila la escalera saldría SUPLANTACIÓN (6) — o sea, acusaría a
  // producción por una env que falta de este lado.
  if (obs.agentOriginKnown === false) {
    return verdict(
      "CONFIG",
      EXIT.CONFIG,
      "CONFIG: falta KYC_AGENT_BASE_URL — la sonda no sabe contra qué origen verificar al ejecutor, y NO lo va a dar por bueno",
    );
  }

  // ── el catálogo del paso de sesión
  const ds = obs.discoverSession;
  if (!ds) return verdict("DOWN", EXIT.DOWN, "DOWN: no se llegó a consultar el catálogo");
  if (ds.networkError || (typeof ds.status === "number" && ds.status >= 500)) {
    return verdict("DOWN", EXIT.DOWN, `DOWN: /discover inalcanzable (${ds.networkError ?? ds.status})`);
  }
  if (ds.status === 404 || (ds.status === 200 && !ds.inputSchema)) {
    return verdict("DRIFT", EXIT.DRIFT, "DRIFT: el catálogo ya no publica el inputSchema del paso de sesión");
  }
  if (ds.status !== 200) {
    return verdict(
      "DOWN",
      EXIT.DOWN,
      `DOWN: /discover no contestó 200 (${typeof ds.status === "number" ? ds.status : "sin status"})`,
    );
  }
  if (obs.derive?.reason) {
    // `field` y `detail` salen de los NOMBRES de propiedad del `inputSchema` publicado, o sea del
    // mismo dueño que el `slug`: `safeEcho` (ver su docblock).
    return verdict(
      "DRIFT",
      EXIT.DRIFT,
      `DRIFT: campo requerido no derivable: ${safeEcho(obs.derive.field)} (${safeEcho(obs.derive.detail)}) — la sonda NO inventa valores`,
    );
  }

  // ── el paso de sesión
  const cs = obs.composeSession;
  if (!cs) return verdict("DOWN", EXIT.DOWN, "DOWN: no se llegó a componer el paso de sesión");
  const vs = claseDeHttp(cs, "el paso de sesión");
  if (vs) return vs;
  if (obs.sessionExecutor && !obs.sessionExecutor.ok) {
    return verdict("IMPERSONATION", EXIT.IMPERSONATION, `SUPLANTACIÓN: sesión — ${obs.sessionExecutor.reason}`);
  }
  if (obs.sessionBridge && !obs.sessionBridge.ok) {
    return verdict("DRIFT", EXIT.DRIFT, `DRIFT: sesión — ${obs.sessionBridge.reason}`);
  }
  if (obs.sessionShape && !obs.sessionShape.ok) {
    return obs.sessionShape.drift
      ? verdict("DRIFT", EXIT.DRIFT, `DRIFT: sesión — ${obs.sessionShape.reason}`)
      : verdict("DOWN", EXIT.DOWN, `DOWN: sesión — ${obs.sessionShape.reason}`);
  }

  // ── el catálogo del paso de decisión
  const dd = obs.discoverDecision;
  if (!dd) return verdict("DOWN", EXIT.DOWN, "DOWN: no se llegó a consultar el catálogo de la decisión");
  if (dd.networkError || (typeof dd.status === "number" && dd.status >= 500)) {
    return verdict("DOWN", EXIT.DOWN, `DOWN: /discover (decisión) inalcanzable (${dd.networkError ?? dd.status})`);
  }
  if (dd.status === 404 || (dd.status === 200 && !dd.inputSchema)) {
    return verdict("DRIFT", EXIT.DRIFT, "DRIFT: el catálogo ya no publica el inputSchema del paso de decisión");
  }
  if (dd.status !== 200) {
    return verdict(
      "DOWN",
      EXIT.DOWN,
      `DOWN: /discover (decisión) no contestó 200 (${typeof dd.status === "number" ? dd.status : "sin status"})`,
    );
  }
  if (obs.decisionRequired && !obs.decisionRequired.ok) {
    return verdict(
      "DRIFT",
      EXIT.DRIFT,
      // Ídem: las claves son del `required` publicado. El `join` va adentro del filtro para que el
      // techo acote el TOTAL y no cada clave por separado.
      `DRIFT: el paso de decisión exige claves que la sonda no sabe llenar (${safeEcho((obs.decisionRequired.faltan ?? []).join(","))})`,
    );
  }

  // ── el paso de decisión
  const cd = obs.composeDecision;
  if (!cd) return verdict("DOWN", EXIT.DOWN, "DOWN: no se llegó a componer el paso de decisión");
  const vd = claseDeHttp(cd, "el paso de decisión");
  if (vd) return vd;
  if (obs.decisionExecutor && !obs.decisionExecutor.ok) {
    return verdict("IMPERSONATION", EXIT.IMPERSONATION, `SUPLANTACIÓN: decisión — ${obs.decisionExecutor.reason}`);
  }
  if (obs.decisionBridge && !obs.decisionBridge.ok) {
    return verdict("DRIFT", EXIT.DRIFT, `DRIFT: decisión — ${obs.decisionBridge.reason}`);
  }
  if (obs.decisionShape && !obs.decisionShape.ok) {
    return obs.decisionShape.drift
      ? verdict("DRIFT", EXIT.DRIFT, `DRIFT: decisión — ${obs.decisionShape.reason}`)
      : verdict("DOWN", EXIT.DOWN, `DOWN: decisión — ${obs.decisionShape.reason}`);
  }

  // PASS es INALCANZABLE salvo tras haber observado las DOS mitades positivamente.
  if (
    obs.sessionExecutor?.ok === true &&
    obs.sessionShape?.ok === true &&
    obs.decisionExecutor?.ok === true &&
    obs.decisionShape?.ok === true
  ) {
    return verdict("PASS", EXIT.PASS, "PASS: el KYC por Coordinador recorre los dos pasos, y los ejecuta el agente propio");
  }

  // 🔴 EL DEFAULT, Y NO ES PASS: un camino que nadie previó sale ruidoso.
  return verdict(
    "DOWN",
    EXIT.DOWN,
    "DOWN: la sonda no llegó a observar los dos pasos con su ejecutor y su forma verificados",
  );
}
