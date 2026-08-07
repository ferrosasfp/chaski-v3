// Tests — resolvedor server-only del TTL del veredicto (WKH-333/AC-3', AC-4, AC-15; CD-8, CD-22).
//
// Lo que estos tests custodian es UNA regla: la configuración del vencimiento no degrada NUNCA. Ni a
// otro número, ni a "sin vencimiento". Un `?? 365` en el catch (M-16) convierte un typo del operador
// (`KYC_VERDICT_TTL_DAYS=365 días`) en una política distinta de la que el operador cree tener, y
// nadie se entera hasta que alguien paga con una verificación de hace dos años.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { KYC_VERDICT_DEFAULT_TTL_DAYS } from "./kyc-verdict-ttl";
import { __resetKycVerdictTtlLog, resolveKycVerdictTtlDays } from "./kyc-verdict-ttl-env";

describe("resolveKycVerdictTtlDays (WKH-333)", () => {
  beforeEach(() => {
    __resetKycVerdictTtlLog();
    delete process.env.KYC_VERDICT_TTL_DAYS;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.KYC_VERDICT_TTL_DAYS;
  });

  // ── T-TTL-5 — env ausente ─────────────────────────────────────────────────────────────────────
  it("T-TTL-5: env ausente ⇒ 365 de constante de código (AC-3')", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(resolveKycVerdictTtlDays() as number).toBe(KYC_VERDICT_DEFAULT_TTL_DAYS);
  });

  // ── T-TTL-4 — AC-3': se declara UNA vez por proceso ───────────────────────────────────────────
  it("T-TTL-4: dos resoluciones ⇒ UNA sola línea declarando el TTL vigente", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    resolveKycVerdictTtlDays();
    resolveKycVerdictTtlDays();
    resolveKycVerdictTtlDays();
    expect(
      info.mock.calls.length,
      "el TTL se declara una vez por resolución y no una por proceso: en una ruta que se llama en " +
        "cada pago, esa línea inunda el log y deja de leerse justo cuando importa",
    ).toBe(1);
    // La línea nombra el número vigente: sin eso, "se declaró" no es verificable.
    expect(String(info.mock.calls[0]?.[0] ?? "") + JSON.stringify(info.mock.calls[0]?.[1] ?? "")).toContain(
      "365",
    );
  });

  it("T-TTL-4b: la declaración también sale cuando el TTL viene de la env, con el número de la env", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.KYC_VERDICT_TTL_DAYS = "200";
    expect(resolveKycVerdictTtlDays() as number).toBe(200);
    expect(info.mock.calls.length).toBe(1);
    expect(
      String(info.mock.calls[0]?.[0] ?? "") + JSON.stringify(info.mock.calls[0]?.[1] ?? ""),
      "el log declara un número distinto del que el sistema va a usar: la única forma que tiene el " +
        "operador de saber qué política está corriendo diría otra cosa",
    ).toContain("200");
  });

  // ── T-TTL-6 — CD-22: validar ANTES de parsear ────────────────────────────────────────────────
  it("T-TTL-6: '365abc', '365.0' y '1e3' NO arrancan (parseInt los aceptaría a los tres) (M-15)", () => {
    for (const raw of ["365abc", "365.0", "1e3", " 365 abc"]) {
      process.env.KYC_VERDICT_TTL_DAYS = raw;
      __resetKycVerdictTtlLog();
      expect(
        () => resolveKycVerdictTtlDays(),
        `el TTL "${raw}" se aceptó: Number.parseInt lo recorta en silencio y el sistema corre con ` +
          "una política de vencimiento que el operador no escribió",
      ).toThrow();
    }
  });

  // ── T-TTL-7 — AC-4: presente-pero-inválida NO degrada ────────────────────────────────────────
  it("T-TTL-7: '' , '-5' y '0' NO arrancan, y en particular NO caen al default (M-16)", () => {
    for (const raw of ["", "-5", "0", "   "]) {
      process.env.KYC_VERDICT_TTL_DAYS = raw;
      __resetKycVerdictTtlLog();
      expect(
        () => resolveKycVerdictTtlDays(),
        `el TTL "${raw}" degradó a un default en vez de fallar: el operador cree tener una ` +
          "política y el sistema corre con otra, y nada lo dice",
      ).toThrow();
    }
  });

  // ── T-TTL-8 — AC-15 (piso) y techo ───────────────────────────────────────────────────────────
  it("T-TTL-8: '179' NO arranca — un TTL server menor que el caché del cliente (180 d) es incoherente (M-17)", () => {
    process.env.KYC_VERDICT_TTL_DAYS = "179";
    expect(
      () => resolveKycVerdictTtlDays(),
      "se aceptó un TTL server menor que el del caché del navegador: el cliente saltearía la " +
        "verificación con una entry que el servidor ya considera vencida, y la persona llegaría a " +
        "pagar sin fila utilizable",
    ).toThrow();
  });

  it("T-TTL-8b: '731' NO arranca — PROHIBIDO un TTL sin techo (CD-8)", () => {
    process.env.KYC_VERDICT_TTL_DAYS = "731";
    expect(
      () => resolveKycVerdictTtlDays(),
      "se aceptó un TTL por encima del techo: un '99999' es 'sin vencimiento' escrito con dígitos",
    ).toThrow();
  });

  it("T-TTL-8c: los bordes '180' y '730' SÍ arrancan", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    process.env.KYC_VERDICT_TTL_DAYS = "180";
    expect(resolveKycVerdictTtlDays() as number).toBe(180);
    __resetKycVerdictTtlLog();
    process.env.KYC_VERDICT_TTL_DAYS = "730";
    expect(resolveKycVerdictTtlDays() as number).toBe(730);
  });

  // ── T-TTL-9 — CD-23: la clave va COMENTADA en .env.example ───────────────────────────────────
  it("T-TTL-9: .env.example declara KYC_VERDICT_TTL_DAYS COMENTADA, nunca como `KEY=`", () => {
    const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    // El estilo del archivo es `KEY=` con el comentario al lado (ver SETTLEMENT_LEDGER_ENABLED).
    // Para ESTA clave ese estilo es un bug: copiar el archivo produce `KYC_VERDICT_TTL_DAYS=""`, y
    // `""` NO ARRANCA (AC-4, T-TTL-7) ⇒ el deployment no levanta por copiar el ejemplo.
    const uncommented = example
      .split("\n")
      .filter((l) => /^\s*KYC_VERDICT_TTL_DAYS\s*=/.test(l));
    expect(
      uncommented,
      "KYC_VERDICT_TTL_DAYS quedó sin comentar en .env.example: quien copie el archivo arranca con " +
        'la env presente y vacía, que por AC-4 NO ARRANCA — el ejemplo rompe el deployment',
    ).toEqual([]);
    expect(
      example.includes("# KYC_VERDICT_TTL_DAYS=365"),
      "la clave no está documentada en .env.example: el operador no tiene de dónde saber que existe",
    ).toBe(true);
  });
});
