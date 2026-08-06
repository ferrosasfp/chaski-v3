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

  // ══ WKH-330 · AC-3 — la elevación es POR `op`, y el guard tiene que estar anclado en ops REALES ══
  //
  // El test de acá arriba usa el `op` "recordPrincipalIn". Medido: NINGÚN código de producción pasa
  // nunca ese string. Refutación: `command grep -rn 'logLedgerWriteFailure(' src/ app/ scripts/ |
  // command grep -v '\.test\.'` devuelve exactamente tres call-sites, y sus ops son
  // "listPreparedDepositAddresses", "recordSolanaPrincipalIn" y "recordOrderPrepared". O sea que ese
  // test vigila un literal que nadie emite, no la política. Prueba de que no alcanza: agregar
  // "recordOrderPrepared" a ALWAYS_ALERT_OPS deja la suite ENTERA verde sin los dos tests de abajo.
  //
  // Los dos que siguen se anclan en 2 de los 3 ops reales — los que NO deben elevarse. El tercero
  // (recordSolanaPrincipalIn, el que SÍ se eleva) está cubierto en
  // app/api/settle/solana-sponsor/route.test.ts, donde además se ve el request completo.

  it("T-330-3a (AC-3): 'recordOrderPrepared' NO está elevado — su 08006 sigue en warn", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logLedgerWriteFailure("recordOrderPrepared", ledgerErr("08006"));
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("[ALERT]");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ code: "08006", severity: "transient" });
    // El mismo op con un 23514 SÍ grita (el contador de `error` no es un cero de un spy sordo):
    error.mockClear();
    warn.mockClear();
    logLedgerWriteFailure("recordOrderPrepared", ledgerErr("23514"));
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it("T-330-3b (AC-3): 'listPreparedDepositAddresses' NO está elevado — su 08006 sigue en warn", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logLedgerWriteFailure("listPreparedDepositAddresses", ledgerErr("08006"));
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("[ALERT]");
    error.mockClear();
    warn.mockClear();
    logLedgerWriteFailure("listPreparedDepositAddresses", ledgerErr("23514"));
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it("T-330-3c (AC-3): la rama warn NO recibe la correlación — su payload queda como antes de WKH-330", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logLedgerWriteFailure("recordOrderPrepared", ledgerErr("08006"), {
      remittanceId: "rem-x",
      signature: "sig-x",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    // Igualdad EXACTA a propósito: acá sí se puede, porque la rama warn no agrega claves. Es lo que
    // impide que AC-3 se rompa de costado filtrando correlación por un canal que no la pidió.
    expect(warn.mock.calls[0]?.[1]).toEqual({
      code: "08006",
      kind: "infra_transient",
      severity: "transient",
      message: "ledger_record_order_prepared_failed:08006",
    });
    warn.mockRestore();
  });

  it("T-330-3d (AC-2/M6): la correlación NO puede pisar el diagnóstico", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // Un call-site que mandara `code` en la correlación no debe poder mentir sobre el código real:
    // por eso `...correlation` se expande PRIMERO en el objeto. Refutación: invertir el orden a
    // `{ code, kind, severity, message, ...correlation }` y ver este test en rojo.
    logLedgerWriteFailure("recordSolanaPrincipalIn", ledgerErr("08006"), {
      code: "mentira",
      severity: "trivial",
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ code: "08006", severity: "transient" });
    error.mockRestore();
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
