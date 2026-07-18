// Tests — verificador on-chain read-only (WKH-168 W3.2, ramas V1-V9).
//
// Se mockea SOLO createPublicClient (para inyectar receipts sintéticos). parseEventLogs /
// isAddressEqual quedan REALES ⇒ V3-V8 se prueban de verdad (decoding real de topics/data),
// determinístico y sin cadena. Exemplar 7.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getReceiptMock } = vi.hoisted(() => ({ getReceiptMock: vi.fn() }));
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: vi.fn(() => ({ getTransactionReceipt: getReceiptMock })) };
});

import { verifySettlementOnChain } from "./onchain-verifier";

const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"; // USDC Base Sepolia canónico
const OTHER_TOKEN = "0x9999999999999999999999999999999999999999";
const SENDER = "0x1111111111111111111111111111111111111111";
const RECEIVER = "0x2222222222222222222222222222222222222222";
const ATTACKER = "0x3333333333333333333333333333333333333333";
const TX = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const VALUE = 400_000_000; // 400 USDC en micro-USDC

const pad = (a: string) => `0x000000000000000000000000${a.slice(2).toLowerCase()}`;

function transferLog(from: string, to: string, valueMinor: bigint, emitter: string = USDC) {
  return {
    address: emitter,
    topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: `0x${valueMinor.toString(16).padStart(64, "0")}`,
  };
}
function receipt(opts: { status?: "success" | "reverted"; logs?: unknown[] } = {}) {
  return { status: opts.status ?? "success", blockNumber: 1n, logs: opts.logs ?? [] };
}

const input = {
  txHash: TX,
  expectedFrom: SENDER,
  expectedTo: RECEIVER,
  expectedValueMinor: VALUE,
};

describe("onchain-verifier (WKH-168) — verificación INDEPENDIENTE del broadcaster", () => {
  beforeEach(() => {
    vi.stubEnv("BASE_SEPOLIA_RPC_URL", "https://rpc.example/base-sepolia");
    vi.stubEnv("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS", USDC);
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "84532");
    getReceiptMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("V9: receipt success + 1 log Transfer del USDC con from/to/value correctos ⇒ ok", async () => {
    getReceiptMock.mockResolvedValue(
      receipt({ logs: [transferLog(SENDER, RECEIVER, BigInt(VALUE))] }),
    );
    const r = await verifySettlementOnChain(input);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.txHash).toBe(TX);
    expect(r.valueMinor).toBe(VALUE);
    expect(r.to.toLowerCase()).toBe(RECEIVER);
  });

  it("V1/AC-11: sin BASE_SEPOLIA_RPC_URL (RPC de Base ausente) ⇒ settle_unverified SIN leer la cadena (fail-closed)", async () => {
    vi.stubEnv("BASE_SEPOLIA_RPC_URL", "");
    const r = await verifySettlementOnChain(input);
    expect(r).toEqual({ ok: false, reason: "settle_unverified" });
    expect(getReceiptMock).not.toHaveBeenCalled();
  });

  it("AC-6 KILLER: AVALANCHE_RPC_URL seteado pero BASE_SEPOLIA_RPC_URL vacío ⇒ settle_unverified SIN leer la cadena (NO lee el env viejo de Avalanche)", async () => {
    // Prueba que resolveRpcUrl() lee el RPC de la red ACTIVA (Base), jamás el env legacy. Si algún
    // mutante devolviera process.env.AVALANCHE_RPC_URL, este test leería la cadena y fallaría.
    vi.stubEnv("AVALANCHE_RPC_URL", "https://rpc.example/legacy-avalanche"); // env VIEJO: NO debe leerse
    vi.stubEnv("BASE_SEPOLIA_RPC_URL", ""); // env NUEVO de la red activa ausente
    const r = await verifySettlementOnChain(input);
    expect(r).toEqual({ ok: false, reason: "settle_unverified" });
    expect(getReceiptMock).not.toHaveBeenCalled();
  });

  it("V2: getTransactionReceipt throw/timeout ⇒ settle_unverified (nunca throw hacia afuera)", async () => {
    getReceiptMock.mockRejectedValue(new Error("rpc timeout"));
    await expect(verifySettlementOnChain(input)).resolves.toEqual({
      ok: false,
      reason: "settle_unverified",
    });
  });

  it("V3: receipt revertido ⇒ settle_reverted (aunque traiga logs)", async () => {
    getReceiptMock.mockResolvedValue(
      receipt({ status: "reverted", logs: [transferLog(SENDER, RECEIVER, BigInt(VALUE))] }),
    );
    const r = await verifySettlementOnChain(input);
    expect(r).toEqual({ ok: false, reason: "settle_reverted" });
  });

  it("V4: 0 logs Transfer del USDC (solo otro token) ⇒ settle_unverified — el filtro es por EMISOR", async () => {
    getReceiptMock.mockResolvedValue(
      receipt({ logs: [transferLog(SENDER, RECEIVER, BigInt(VALUE), OTHER_TOKEN)] }),
    );
    const r = await verifySettlementOnChain(input);
    expect(r).toEqual({ ok: false, reason: "settle_unverified" });
  });

  it("V4: receipt sin logs ⇒ settle_unverified (200 del broadcaster NO basta, CD-10)", async () => {
    getReceiptMock.mockResolvedValue(receipt({ logs: [] }));
    const r = await verifySettlementOnChain(input);
    expect(r).toEqual({ ok: false, reason: "settle_unverified" });
  });

  it("V5: 2 logs Transfer del USDC ⇒ settle_unverified (ambigüedad ⇒ bloquear, NO elegir el primero)", async () => {
    // El primero es el "bueno": si el verificador eligiera transfers[0] esto pasaría → fail-open.
    getReceiptMock.mockResolvedValue(
      receipt({
        logs: [
          transferLog(SENDER, RECEIVER, BigInt(VALUE)),
          transferLog(SENDER, ATTACKER, 1n),
        ],
      }),
    );
    const r = await verifySettlementOnChain(input);
    expect(r).toEqual({ ok: false, reason: "settle_unverified" });
  });

  it("V6: el Transfer va a OTRO receiver ⇒ settle_receiver_mismatch (AC-2 — la rama es ALCANZABLE)", async () => {
    // Esta es la prueba de que el filtro NO incluye `to === receiver`: si lo incluyera, este log se
    // filtraría → V4 (0 logs) y V6 sería inalcanzable → el receiver nunca se verificaría (tautología).
    getReceiptMock.mockResolvedValue(
      receipt({ logs: [transferLog(SENDER, ATTACKER, BigInt(VALUE))] }),
    );
    const r = await verifySettlementOnChain(input);
    expect(r).toEqual({ ok: false, reason: "settle_receiver_mismatch" });
  });

  it("V7/V8: from distinto ⇒ sender_mismatch; value distinto (incl. SOBRE-pago) ⇒ amount_mismatch", async () => {
    // V7 — pagó otro (el receiver y el monto son correctos, pero el sender no es el declarado).
    getReceiptMock.mockResolvedValue(
      receipt({ logs: [transferLog(ATTACKER, RECEIVER, BigInt(VALUE))] }),
    );
    expect(await verifySettlementOnChain(input)).toEqual({
      ok: false,
      reason: "settle_sender_mismatch",
    });

    // V8 — sub-pago.
    getReceiptMock.mockResolvedValue(receipt({ logs: [transferLog(SENDER, RECEIVER, 1n)] }));
    expect(await verifySettlementOnChain(input)).toEqual({
      ok: false,
      reason: "settle_amount_mismatch",
    });

    // V8 — SOBRE-pago: el facilitador lo acepta (>=, base-adapter.ts:609) y sub-reporta el monto.
    // Nosotros exigimos igualdad EXACTA contra el valor real del log.
    getReceiptMock.mockResolvedValue(
      receipt({ logs: [transferLog(SENDER, RECEIVER, BigInt(VALUE) + 1n)] }),
    );
    expect(await verifySettlementOnChain(input)).toEqual({
      ok: false,
      reason: "settle_amount_mismatch",
    });
  });
});
