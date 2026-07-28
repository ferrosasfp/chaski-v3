// Tests — clasificación de la señal de un write fallido del ledger (best-effort, CD-17).
// Lo que se prueba NO es una lista de códigos, es la POLÍTICA:
//   · clase 23 (integridad) ⇒ alto + [ALERT] (bug nuestro: la fila NO se escribió)
//   · clases de infra (08/40/53/57/58, errno POSIX) ⇒ warn (se recupera solo)
//   · CUALQUIER código sin clase mapeada ⇒ alto (que grite, nunca que se pierda en un warn)
// Y que el control de flujo NO cambia: la función loguea y vuelve, nunca lanza.
import { describe, expect, it, vi } from "vitest";
import {
  classifyLedgerWriteFailure,
  logLedgerWriteFailure,
} from "./ledger-write-failure";

/** Error tal como lo propaga el ledger: `ledger_<op>_failed:<code>`. */
const ledgerErr = (code: string) => new Error(`ledger_record_order_prepared_failed:${code}`);

describe("classifyLedgerWriteFailure — por CLASE de código, default alto", () => {
  it("SQLSTATE clase 23 (integridad) ⇒ alto: es un bug nuestro, la escritura durable no ocurrió", () => {
    for (const code of ["23514", "23502", "23503", "23505", "23P01"]) {
      const out = classifyLedgerWriteFailure(ledgerErr(code));
      expect(out).toEqual({ code, kind: "integrity_violation", severity: "high" });
    }
  });

  it("23514 es EXACTAMENTE el CHECK vm/chain_id/network_id ⇒ nunca puede degradarse a transitorio", () => {
    // Este es el código que devolvería Postgres si las dos mitades del fix se desacoplaran.
    expect(classifyLedgerWriteFailure(ledgerErr("23514")).severity).toBe("high");
  });

  it("clases de infra (08/40/53/57/58) ⇒ transitorio (warn): la DB se cae y se recupera sola", () => {
    for (const code of ["08006", "08003", "40001", "40P01", "53300", "57P01", "58030"]) {
      const out = classifyLedgerWriteFailure(ledgerErr(code));
      expect(out.kind).toBe("infra_transient");
      expect(out.severity).toBe("transient");
    }
  });

  it("errno POSIX de red (ECONNRESET/ETIMEDOUT/EAI_AGAIN/…) y ABORT_ERR ⇒ transitorio", () => {
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED", "ABORT_ERR"]) {
      expect(classifyLedgerWriteFailure(ledgerErr(code)).severity).toBe("transient");
    }
  });

  it("DEFAULT ALTO: un código sin clase mapeada NO se degrada a transitorio", () => {
    // PGRST* (PostgREST), clases SQLSTATE nuestras (42 privilegios/columna inexistente, 22 dato
    // inválido), un enum interno, o el "unknown" que pone el ledger cuando Supabase no manda código.
    for (const code of ["PGRST116", "PGRST301", "42703", "42501", "22003", "unknown", "XX000"]) {
      const out = classifyLedgerWriteFailure(ledgerErr(code));
      expect(out.severity).toBe("high");
    }
  });

  it("un throw que no es del ledger (sin código) ⇒ alto, y NUNCA lanza al clasificar", () => {
    expect(classifyLedgerWriteFailure(new Error("boom")).severity).toBe("high");
    expect(classifyLedgerWriteFailure(new Error("boom")).code).toBe("unknown");
    expect(classifyLedgerWriteFailure("string pelado").severity).toBe("high");
    expect(classifyLedgerWriteFailure(undefined).severity).toBe("high");
    expect(classifyLedgerWriteFailure(null).code).toBe("unknown");
  });

  it("un objeto con `code` propio (errno crudo del runtime) también se clasifica", () => {
    expect(classifyLedgerWriteFailure({ code: "ETIMEDOUT" }).severity).toBe("transient");
    expect(classifyLedgerWriteFailure({ code: "23505" }).severity).toBe("high");
  });
});

describe("logLedgerWriteFailure — canal por severidad, sin cambiar el control de flujo", () => {
  it("integridad ⇒ console.error con [ALERT] y el código; NADA en console.warn", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logLedgerWriteFailure("recordOrderPrepared", ledgerErr("23514"));
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("[ALERT]");
    expect(String(error.mock.calls[0]?.[0])).toContain("recordOrderPrepared_failed");
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      code: "23514",
      kind: "integrity_violation",
      severity: "high",
    });
    error.mockRestore();
    warn.mockRestore();
  });

  it("transitorio ⇒ console.warn (no ensucia el canal de alerta); NADA en console.error", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logLedgerWriteFailure("recordPrincipalIn", ledgerErr("08006"));
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("[ALERT]");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ code: "08006", severity: "transient" });
    error.mockRestore();
    warn.mockRestore();
  });

  it("desconocido ⇒ grita por console.error (default alto)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logLedgerWriteFailure("recordPayoutOutcome", new Error("vaya a saber"));
    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    warn.mockRestore();
  });

  it("NUNCA lanza (el caller la usa dentro de un catch que se traga la excepción, CD-17)", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => logLedgerWriteFailure("op", undefined)).not.toThrow();
    expect(() => logLedgerWriteFailure("op", { weird: true })).not.toThrow();
    error.mockRestore();
  });

  it("el mensaje logueado se trunca y no ecoa payload arbitrario sin cota", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logLedgerWriteFailure("op", new Error("x".repeat(5000)));
    const meta = error.mock.calls[0]?.[1] as { message: string };
    expect(meta.message.length).toBeLessThanOrEqual(200);
    error.mockRestore();
  });
});
