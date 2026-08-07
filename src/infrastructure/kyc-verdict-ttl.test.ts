// Tests — vigencia del veredicto de KYC calculada AL LEER (WKH-333/AC-2, CD-7).
//
// El punto de estos tests no es "la resta funciona": es que NO EXISTE una columna de vencimiento.
// El vencimiento se deriva de `verified_at` (el hecho) y del TTL configurado en el momento de la
// lectura. Un mutante que devuelva `false` siempre (M-5) hace que un veredicto de hace tres años
// autorice un desembolso hoy.
import { describe, expect, it } from "vitest";
import {
  KYC_CLIENT_HINT_TTL_DAYS,
  KYC_VERDICT_DEFAULT_TTL_DAYS,
  KYC_VERDICT_MAX_TTL_DAYS,
  isVerdictExpired,
} from "./kyc-verdict-ttl";
import { __resetKycVerdictTtlLog, resolveKycVerdictTtlDays } from "./kyc-verdict-ttl-env";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Única fábrica del tipo branded (CD-23): los tests tampoco pueden fabricar un TTL a mano.
 *  `delete` y no `= undefined`: asignar undefined a process.env guarda la CADENA "undefined". */
function ttl(days: number) {
  __resetKycVerdictTtlLog();
  process.env.KYC_VERDICT_TTL_DAYS = String(days);
  const v = resolveKycVerdictTtlDays();
  delete process.env.KYC_VERDICT_TTL_DAYS;
  return v;
}

describe("vigencia del veredicto (WKH-333/AC-2)", () => {
  // ── T-TTL-1 ───────────────────────────────────────────────────────────────────────────────────
  it("T-TTL-1: un veredicto de hace 364 días con TTL 365 sigue vigente", () => {
    const now = Date.parse("2026-08-07T00:00:00.000Z");
    const verifiedAt = new Date(now - 364 * DAY_MS).toISOString();
    expect(
      isVerdictExpired(verifiedAt, ttl(365), now),
      "un veredicto de 364 días con TTL 365 se declaró vencido: la persona tiene que volver a " +
        "escanear su documento un año antes de lo que corresponde",
    ).toBe(false);
  });

  // ── T-TTL-2 ───────────────────────────────────────────────────────────────────────────────────
  it("T-TTL-2: un veredicto de hace 366 días con TTL 365 está vencido", () => {
    const now = Date.parse("2026-08-07T00:00:00.000Z");
    const verifiedAt = new Date(now - 366 * DAY_MS).toISOString();
    expect(
      isVerdictExpired(verifiedAt, ttl(365), now),
      "un veredicto de hace más de un año se aceptó como vigente: alguien puede pagar hoy con una " +
        "verificación de identidad que ya nadie revisó",
    ).toBe(true);
  });

  // ── T-TTL-3 ───────────────────────────────────────────────────────────────────────────────────
  it("T-TTL-3: cambiar el TTL cambia el veredicto sobre la MISMA fila, sin tocar la fila", () => {
    const now = Date.parse("2026-08-07T00:00:00.000Z");
    const verifiedAt = new Date(now - 200 * DAY_MS).toISOString();
    // La misma `verifiedAt` sin modificar: lo único que cambia es la configuración leída.
    expect(isVerdictExpired(verifiedAt, ttl(365), now)).toBe(false);
    expect(
      isVerdictExpired(verifiedAt, ttl(180), now),
      "bajar el TTL no venció una fila vieja: si el vencimiento estuviera persistido, bajar la " +
        "política exigiría un backfill y hasta entonces habría dos verdades sobre la misma fila",
    ).toBe(true);
  });

  // ── T-TTL-3b — fail-safe ──────────────────────────────────────────────────────────────────────
  it("T-TTL-3b: una `verified_at` ilegible cuenta como VENCIDA, nunca como vigente", () => {
    const now = Date.parse("2026-08-07T00:00:00.000Z");
    expect(
      isVerdictExpired("no-es-una-fecha", ttl(365), now),
      "una fecha ilegible se trató como vigente: un dato corrupto en la fila autorizaría un " +
        "desembolso para siempre",
    ).toBe(true);
  });

  // ── Constantes: fuente única (CD-23) ──────────────────────────────────────────────────────────
  it("las tres constantes del TTL viven acá y sólo acá", () => {
    expect(KYC_VERDICT_DEFAULT_TTL_DAYS).toBe(365);
    expect(KYC_VERDICT_MAX_TTL_DAYS).toBe(730);
    expect(KYC_CLIENT_HINT_TTL_DAYS).toBe(180);
  });
});
