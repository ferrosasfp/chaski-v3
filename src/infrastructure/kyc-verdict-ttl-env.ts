// Infrastructure — resolvedor SERVER-ONLY del TTL del veredicto de KYC (WKH-333/AC-3', AC-4, AC-15).
//
// ⚠️ SERVER-ONLY. PROHIBIDO importarlo desde `src/presentation/**`, desde `kyc-store.ts` o desde
// cualquier módulo que llegue al bundle del browser: ahí `process.env.KYC_VERDICT_TTL_DAYS` se
// inlinea como `undefined` y esto devolvería 365 en silencio mientras el servidor usa otro número.
// El motivo largo está en la cabecera de `kyc-verdict-ttl.ts`.
//
// Exemplar: `src/infrastructure/didit/didit-env.ts:40-87`, ⛔ QUE YA NO EXISTE — lo borró WKH-233 con
// el proveedor entero (`ls src/infrastructure/didit` da error). El exemplar VIVO equivalente es
// (`resolveKycAgentBaseUrl`, `./kyc/agent-env.ts:51`): mismo molde (resolvedor fail-loud + tipo
// branded + mensaje que nombra el daño). Igual que ahí: PROHIBIDO el `??`. El operador DECLARA la
// política; el código no la adivina.
import {
  KYC_CLIENT_HINT_TTL_DAYS,
  KYC_VERDICT_DEFAULT_TTL_DAYS,
  KYC_VERDICT_MAX_TTL_DAYS,
  type KycVerdictTtlDays,
} from "./kyc-verdict-ttl";

// AC-3': el TTL vigente se declara UNA vez por proceso, en la PRIMERA resolución. No hay hook de
// arranque en este repo (`ls instrumentation* app/instrumentation*` no devuelve nada), así que
// "declararlo al arrancar" no tiene dónde vivir: la primera resolución es el evento más temprano que
// existe. Sin esta memoización la línea saldría en cada pago e inundaría el log.
let declared = false;

/** Sólo para tests: permite volver a observar la primera declaración. */
export function __resetKycVerdictTtlLog(): void {
  declared = false;
}

// Sólo dígitos. Se valida ANTES de convertir (CD-22) porque `Number.parseInt` RECORTA: "365abc" da
// 365, "365.0" da 365, "1e3" da 1. Convertir primero y validar después acepta en silencio tres
// escrituras que el operador no quiso.
const DIGITS_ONLY = /^[0-9]+$/;

function fail(raw: string, why: string): never {
  // Se ecoa el VALOR porque es config de un conjunto acotado, nunca un secreto ni PII, y sin él el
  // operador no puede corregir el typo. Nunca se ecoa nada de la fila del veredicto (CD-13).
  throw new Error(
    `kyc_verdict_ttl_invalid:${JSON.stringify(raw)} — ${why}. ` +
      `Valores válidos: un entero entre ${KYC_CLIENT_HINT_TTL_DAYS} y ${KYC_VERDICT_MAX_TTL_DAYS} ` +
      `(días), o la variable AUSENTE para usar ${KYC_VERDICT_DEFAULT_TTL_DAYS}. ` +
      "Se corta a propósito: degradar a otro número dejaría al operador creyendo que tiene una " +
      "política de vencimiento distinta de la que el sistema aplica, y eso no se ve hasta que " +
      "alguien paga con una verificación de identidad que ya venció.",
  );
}

/**
 * Resuelve el TTL del veredicto, en días. FAIL-LOUD: presente-pero-inválida LANZA.
 *
 * 🔴 PROHIBIDO agregar acá un `?? KYC_VERDICT_DEFAULT_TTL_DAYS`, un `catch` que devuelva el default,
 * o cualquier rama que resulte en "sin vencimiento" (CD-8). Ausente es una DECISIÓN del operador
 * ("usá el default"); presente-y-mal es un ERROR del operador, y son cosas distintas.
 *
 * Tabla completa (AC-4, y cada fila tiene su input en `kyc-verdict-ttl-env.test.ts`):
 *   ausente                                   → 365 + una línea de log por proceso
 *   entera, 180 ≤ n ≤ 730                     → n   + una línea de log por proceso
 *   "" / "   "                                → LANZA
 *   "365.0" / "365abc" / "1e3" / "-5" / "0"   → LANZA
 *   n < 180 (piso, AC-15) / n > 730 (techo)   → LANZA
 */
export function resolveKycVerdictTtlDays(): KycVerdictTtlDays {
  const raw = process.env.KYC_VERDICT_TTL_DAYS;
  let days: number;
  if (raw === undefined) {
    days = KYC_VERDICT_DEFAULT_TTL_DAYS;
  } else {
    const trimmed = raw.trim();
    if (!DIGITS_ONLY.test(trimmed)) {
      fail(raw, "no es un entero de sólo dígitos");
    }
    days = Number(trimmed);
    if (days < KYC_CLIENT_HINT_TTL_DAYS) {
      // AC-15: por debajo del TTL del caché del navegador el sistema queda incoherente consigo mismo.
      fail(
        raw,
        `está por debajo del piso de ${KYC_CLIENT_HINT_TTL_DAYS} días, que es el TTL del caché del ` +
          "navegador: el cliente saltearía la verificación con una entry que el servidor ya " +
          "considera vencida",
      );
    }
    if (days > KYC_VERDICT_MAX_TTL_DAYS) {
      fail(raw, `supera el techo de ${KYC_VERDICT_MAX_TTL_DAYS} días`);
    }
  }
  if (!declared) {
    declared = true;
    // Value-free respecto de la fila (CD-13): sólo el número de la política y de dónde salió.
    console.info("[kyc-verdict] ttl_days_resolved", {
      days: String(days),
      source: raw === undefined ? "default" : "env",
    });
  }
  return days as KycVerdictTtlDays;
}
