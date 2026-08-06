// Clasificación de la señal de un write FALLIDO del settlement ledger. SERVER-ONLY.
//
// Por qué existe: los writes del ledger son best-effort (CD-17) — la ruta los envuelve en try/catch y
// NUNCA rompe el money-path. Esa decisión es correcta, pero deja un agujero de OBSERVABILIDAD: un bug
// nuestro (p.ej. violar el CHECK vm/chain_id/network_id) se ve EXACTAMENTE igual que un hipo de red —
// un `console.error` suelto — y la escritura durable simplemente no ocurre. El síntoma aparece semanas
// después, cuando alguien pide un refund y no hay con qué reconstruir la remesa.
//
// Este módulo NO cambia el control de flujo (el catch sigue tragando la excepción): sólo separa la
// SEÑAL en dos clases.
//   · "high"      ⇒ console.error con marca [ALERT]: bug nuestro / algo que hay que mirar HOY.
//   · "transient" ⇒ console.warn: infra que se cae y se recupera sola (red, conexión, shutdown).
//
// Se clasifica por CLASE de código, NO por una lista de códigos concretos: una lista siempre queda
// vieja y el código nuevo cae en el default. Y el DEFAULT es "high" a propósito: si nadie mapeó el
// código, es más seguro que grite que que se pierda en un warn.
//   · SQLSTATE clase 23 (integrity_constraint_violation: 23502 not-null, 23503 FK, 23505 unique,
//     23514 check) ⇒ high. Es SIEMPRE un bug nuestro: el dato que mandamos no cierra con el esquema.
//   · SQLSTATE clases 08 (connection exception), 40 (transaction rollback / serialización),
//     53 (insufficient resources), 57 (operator intervention), 58 (system error externo) ⇒ transient.
//   · errno POSIX (ECONNRESET, ETIMEDOUT, EAI_AGAIN, …) y el ABORT_ERR de fetch ⇒ transient.
//   · cualquier otra cosa (PGRST*, SQLSTATE 42/22/…, sin código, no-Error) ⇒ high.
//
// NUNCA loguea PII (CD-7): esta tabla no persiste beneficiary/documento, y el mensaje que propaga el
// ledger es un enum estable `ledger_<op>_failed:<code>`. El `message` se trunca por prolijidad.

import { LEDGER_ALERT_PREFIX } from "./ledger-alert";

/** Alta = mirar hoy (bug nuestro o código sin mapear). Transitoria = infra que se recupera sola. */
export type LedgerWriteFailureSeverity = "high" | "transient";

export type LedgerWriteFailureKind =
  | "integrity_violation" // SQLSTATE 23xxx — el dato no cierra con el esquema: bug nuestro
  | "infra_transient" // SQLSTATE 08/40/53/57/58 o errno de red
  | "unmapped"; // sin clase conocida ⇒ default ALTO (que grite)

export interface LedgerWriteFailure {
  code: string; // código extraído (SQLSTATE / errno / "unknown")
  kind: LedgerWriteFailureKind;
  severity: LedgerWriteFailureSeverity;
}

// SQLSTATE = 5 caracteres [0-9A-Z] (ej. 23514, 57P01). La CLASE son los 2 primeros.
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
// errno POSIX que emite el runtime ante fallos de red/DNS (ECONNRESET, ETIMEDOUT, EAI_AGAIN, …).
const POSIX_ERRNO_RE = /^E[A-Z0-9_]{2,}$/;

const SQLSTATE_CLASS_INTEGRITY = "23";
const SQLSTATE_CLASSES_TRANSIENT: readonly string[] = ["08", "40", "53", "57", "58"];
const ABORT_CODE = "ABORT_ERR"; // fetch abortado por timeout (no matchea el errno POSIX)

const MAX_MESSAGE_CHARS = 200;

// Ops cuyo write fallido sale por el canal de ERROR aunque su CLASE de código diga "transient".
//
// Por qué existe: la clasificación por clase es correcta para la INFRA (un 08006 es, en efecto, un
// hipo de red que se recupera solo) pero no dice nada del COSTO de ese write. Para
// recordSolanaPrincipalIn el costo es asimétrico: cuando falla, ya hubo un depósito REAL con firma
// on-chain verificada, y la fila queda en 'prepared' — indistinguible de una donde nunca entró nada.
// Un warn transitorio la deja mezclada con el ruido de red normal (WKH-330).
//
// ⚠️ Lo que esto hace y lo que NO hace. HACE: mueve la línea al canal de error y le pone el prefijo
// LEDGER_ALERT_PREFIX, que es un string grepeable. NO HACE: alertar a nadie. MEDIDO al 2026-08-06:
// las 35 dependencias de package.json no incluyen NINGUNA herramienta de observabilidad (cero de
// sentry/datadog/dd-trace/opentelemetry/pino/winston/bunyan/rollbar/bugsnag/newrelic/logtail/…), y
// dentro del repo no hay ninguna regla sobre este prefijo: su única aparición fuera de src/ y app/
// es un COMENTARIO en supabase/migrations/20260804T000000_add_payout_provenance_to_remittance_settlements.sql:20.
// ⬜ Si existiera una regla en el panel de algún proveedor de hosting, NO se pudo verificar desde
// acá. La línea queda MÁS ENCONTRABLE; que esté vigilada es una afirmación que nadie puede hacer hoy.
//
// Refutación de que esta lista haga algo: sacar "recordSolanaPrincipalIn" del Set y correr T-330-1
// (`app/api/settle/solana-sponsor/route.test.ts`) — el fallo 08006 vuelve a salir por console.warn.
//
// ⚠️ Es una LISTA ENUMERADA y por eso envejece en silencio (CD-N7): un op nuevo igual de crítico no
// entra solo. Hoy tiene un solo miembro a propósito — es el único de los 3 call-sites de producción
// que corre DESPUÉS de un hecho on-chain irreversible. Refutación de esa afirmación: buscar
// `logLedgerWriteFailure(` fuera de los tests; si aparece un cuarto call-site posterior a una firma
// verificada, este Set quedó viejo.
const ALWAYS_ALERT_OPS: ReadonlySet<string> = new Set(["recordSolanaPrincipalIn"]);

/** Extrae el código del error. El ledger propaga `ledger_<op>_failed:<code>` (ver
 *  supabase-settlement-ledger.ts), y un throw inesperado puede traer `code` propio (errno). */
function extractCode(err: unknown): string {
  if (err instanceof Error) {
    const tail = /:([0-9A-Za-z_]+)$/.exec(err.message);
    if (tail?.[1]) return tail[1];
  }
  if (typeof err === "object" && err !== null) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "unknown";
}

/** Clasifica por CLASE de código (nunca por lista de códigos concretos). Default: "high". */
export function classifyLedgerWriteFailure(err: unknown): LedgerWriteFailure {
  const code = extractCode(err);
  if (SQLSTATE_RE.test(code)) {
    const cls = code.slice(0, 2);
    if (cls === SQLSTATE_CLASS_INTEGRITY) {
      return { code, kind: "integrity_violation", severity: "high" };
    }
    if (SQLSTATE_CLASSES_TRANSIENT.includes(cls)) {
      return { code, kind: "infra_transient", severity: "transient" };
    }
    return { code, kind: "unmapped", severity: "high" }; // SQLSTATE sin clase mapeada ⇒ grita
  }
  if (code === ABORT_CODE || POSIX_ERRNO_RE.test(code)) {
    return { code, kind: "infra_transient", severity: "transient" };
  }
  return { code, kind: "unmapped", severity: "high" }; // default ALTO (PGRST*, sin código, no-Error)
}

/** Loguea el fallo de un write best-effort del ledger con la severidad de su CLASE de error, o por
 *  el canal de error incondicionalmente si el `op` está en ALWAYS_ALERT_OPS.
 *  NO cambia el control de flujo: el caller sigue tragando la excepción (CD-17).
 *
 *  `correlation`: identificadores para volver a encontrar el hecho (remittanceId, signature). NUNCA
 *  PII (CD-6/CD-7) — nada de sender/beneficiary/monto. Se expande PRIMERO a propósito, para que un
 *  call-site no pueda pisar code/kind/severity/message; refutación: pasar `{ code: "mentira" }` y
 *  verificar que el log sigue diciendo el código real. Y sólo viaja en la rama de error: el payload
 *  del warn queda byte-idéntico al de antes de WKH-330; refutación: llamar con un op no elevado y
 *  una correlación cualquiera, y ver que no aparece en el warn. */
export function logLedgerWriteFailure(
  op: string,
  err: unknown,
  correlation?: Readonly<Record<string, string>>,
): void {
  const { code, kind, severity } = classifyLedgerWriteFailure(err);
  const message = err instanceof Error ? err.message.slice(0, MAX_MESSAGE_CHARS) : "";
  if (severity === "high" || ALWAYS_ALERT_OPS.has(op)) {
    // Bug nuestro, código sin mapear, u op elevado: la escritura durable NO ocurrió (evidencia perdida).
    console.error(`${LEDGER_ALERT_PREFIX} ${op}_failed`, { ...correlation, code, kind, severity, message });
    return;
  }
  console.warn(`[ledger] ${op}_failed`, { code, kind, severity, message });
}
