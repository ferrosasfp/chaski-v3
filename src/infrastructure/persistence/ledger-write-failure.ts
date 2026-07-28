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

/** Loguea el fallo de un write best-effort del ledger con la severidad de su CLASE de error.
 *  NO cambia el control de flujo: el caller sigue tragando la excepción (CD-17). */
export function logLedgerWriteFailure(op: string, err: unknown): void {
  const { code, kind, severity } = classifyLedgerWriteFailure(err);
  const message = err instanceof Error ? err.message.slice(0, MAX_MESSAGE_CHARS) : "";
  if (severity === "high") {
    // Bug nuestro o código sin mapear: la escritura durable NO ocurrió (evidencia perdida).
    console.error(`[ledger][ALERT] ${op}_failed`, { code, kind, severity, message });
    return;
  }
  console.warn(`[ledger] ${op}_failed`, { code, kind, severity, message });
}
