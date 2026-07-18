// Tests — transfi-hmac (WKH-210): verificación HMAC hex sobre el body crudo + mapeo/parseo defensivo.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  extractEventId,
  extractPayoutId,
  mapTransfiStatus,
  verifyTransfiHmac,
} from "./transfi-hmac";

const SECRET = "whsec_test_123";
const RAW = '{"orderId":"ord-1","status":"fund_settled"}';
function hmacHex(raw: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(raw).digest("hex");
}

describe("verifyTransfiHmac (WKH-210)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("firma buena (hex sobre el raw exacto) ⇒ true", () => {
    vi.stubEnv("TRANSFI_WEBHOOK_SECRET", SECRET);
    expect(verifyTransfiHmac(RAW, hmacHex(RAW))).toBe(true);
  });

  it("firma mala ⇒ false", () => {
    vi.stubEnv("TRANSFI_WEBHOOK_SECRET", SECRET);
    expect(verifyTransfiHmac(RAW, hmacHex("otro-body"))).toBe(false);
  });

  it("firma null ⇒ false (no tira)", () => {
    vi.stubEnv("TRANSFI_WEBHOOK_SECRET", SECRET);
    expect(verifyTransfiHmac(RAW, null)).toBe(false);
  });

  it("sin secreto configurado ⇒ false (fail-closed)", () => {
    vi.stubEnv("TRANSFI_WEBHOOK_SECRET", "");
    expect(verifyTransfiHmac(RAW, hmacHex(RAW))).toBe(false);
  });

  it("firma válida para el raw exacto pero NO para el mismo objeto re-serializado (body crudo, DT-4)", () => {
    vi.stubEnv("TRANSFI_WEBHOOK_SECRET", SECRET);
    // Firma computada sobre el RAW exacto; un string que parsea al MISMO objeto pero con otro spacing
    // NO valida con esa firma ⇒ prueba que se firma el body crudo, no un re-serializado (DT-4).
    const sigOnRaw = hmacHex(RAW);
    const rawWithSpaces = '{ "orderId": "ord-1", "status": "fund_settled" }';
    expect(verifyTransfiHmac(RAW, sigOnRaw)).toBe(true);
    expect(verifyTransfiHmac(rawWithSpaces, sigOnRaw)).toBe(false);
  });
});

describe("mapTransfiStatus (WKH-210 AC-4/5/6/7)", () => {
  it("los 3 conocidos ⇒ estados", () => {
    expect(mapTransfiStatus("asset_deposited")).toBe("submitted");
    expect(mapTransfiStatus("fund_settled")).toBe("settled");
    expect(mapTransfiStatus("fund_failed")).toBe("failed");
  });
  it("desconocidos ⇒ null (NUNCA infiere terminal)", () => {
    expect(mapTransfiStatus("initiated")).toBeNull();
    expect(mapTransfiStatus("expired")).toBeNull();
    expect(mapTransfiStatus("basura")).toBeNull();
    expect(mapTransfiStatus("")).toBeNull();
  });
});

describe("extractPayoutId (WKH-210 DT-5)", () => {
  it("cada candidato en orden gana", () => {
    expect(extractPayoutId({ orderId: "a", id: "b" })).toBe("a");
    expect(extractPayoutId({ id: "b", transactionId: "c" })).toBe("b");
    expect(extractPayoutId({ transactionId: "c", orderNumber: "d" })).toBe("c");
    expect(extractPayoutId({ orderNumber: "d" })).toBe("d");
  });
  it("sin candidatos (o vacíos) ⇒ null", () => {
    expect(extractPayoutId({})).toBeNull();
    expect(extractPayoutId({ orderId: "", id: 123 })).toBeNull();
  });
});

describe("extractEventId (WKH-210 DT-6)", () => {
  it("usa el eventId nativo si está", () => {
    expect(extractEventId({ eventId: "evt-1" }, "ord-1", "fund_settled")).toBe("evt-1");
    expect(extractEventId({ webhookId: "wh-1" }, "ord-1", "fund_settled")).toBe("wh-1");
    expect(extractEventId({ deliveryId: "dl-1" }, "ord-1", "fund_settled")).toBe("dl-1");
  });
  it("sin ninguno ⇒ fallback composite ${payoutId}:${status}", () => {
    expect(extractEventId({}, "ord-1", "fund_settled")).toBe("ord-1:fund_settled");
  });
  it("dos status distintos NO colisionan en el fallback", () => {
    const a = extractEventId({}, "ord-1", "asset_deposited");
    const b = extractEventId({}, "ord-1", "fund_settled");
    expect(a).not.toBe(b);
  });
});
