import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WKH-168: se mockea el store (Upstash) — no el verificador de la atestación, que corre REAL para
// probar el HMAC de verdad. El mock default es "primer uso OK" ⇒ los 19 tests existentes, que caen
// en A1 (skip), ni se enteran.
// Tipado explícito (tsc strict, cero `any`): sin él, vi.fn infiere `{ok: boolean}` desde el default
// y los mockResolvedValue con alreadyUsed/unavailable no compilan (WKH-196: el gate es `npm run qa`,
// no `npm run build` — el build excluye los tests y esto pasaría en silencio).
type Claim = { ok: true } | { ok: false; alreadyUsed: true } | { ok: false; unavailable: true };
const { claimMock } = vi.hoisted(() => ({
  claimMock: vi.fn<(txHash: string) => Promise<Claim>>(async () => ({ ok: true })),
}));
vi.mock("../../../../../src/infrastructure/settlement/attestation-store", () => ({
  claimAttestationOnce: claimMock,
}));

// WKH-206: se mockea el nonce-store (Upstash) — NO el verificador del challenge, que corre REAL para
// probar el HMAC de verdad. El type param es OBLIGATORIO (CD-16): sin él vi.fn infiere `{ok:boolean}`
// desde el default y las ramas alreadyUsed/unavailable no compilan (el gate es `npm run qa`).
type PopNonceClaim = { ok: true } | { ok: false; alreadyUsed: true } | { ok: false; unavailable: true };
const { popClaimMock } = vi.hoisted(() => ({
  popClaimMock: vi.fn<(nonce: string) => Promise<PopNonceClaim>>(async () => ({ ok: true })),
}));
vi.mock("../../../../../src/infrastructure/auth/pop-nonce-store", () => ({
  claimPopNonceOnce: popClaimMock,
}));

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildPopMessage,
  issuePopChallenge,
} from "../../../../../src/infrastructure/auth/pop-challenge";
import { issueSettlementAttestation } from "../../../../../src/infrastructure/settlement/attestation";
import { POST } from "./route";

const BASE = "https://agents.example.com";

function req(payload: unknown): Request {
  return new Request("http://localhost/api/a2a/payout/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const validPayload = {
  quoteId: "cfx-1",
  amountUsd: 400,
  kycVerificationId: "v-1",
  address: "0xSender", // WKH-202: el guard lo exige. SETUP del fixture, no un assert (AC-6 intacto).
  kycPayoutAllowed: true,
  beneficiary: { name: "Mamá", country: "PE", method: "yape", destination: "999888777" },
  idempotencyKey: "r-1:cfx-1",
};

const validResult = {
  status: "submitted",
  payoutId: "po-1",
  deliveredLocal: null,
  txRef: null,
  reason: null,
  provenance: "remit-cashout-payout",
};

// WKH-202 §4.7: los tests de WKH-186 no stubean DIDIT_API_KEY/VERCEL_ENV. Con el guard nuevo su
// resultado pasaría a depender del shell ambiente (vitest no carga .env.local, pero un DIDIT_API_KEY
// exportado en la shell/CI haría fetchear Didit → rojo intermitente). Esto es SETUP, no asserts:
// los 7 de WKH-186 caen en simulated_dev + VERCEL_ENV="" → autorizado → el único fetch que ven sus
// mocks sigue siendo el del agente.
// WKH-168 W6.4: mismo razonamiento para SETTLE_ATTESTATION_SECRET. Sin este stub, un secreto
// exportado en la shell/CI mandaría los 19 tests existentes a la rama A3 → 403 → rojo intermitente.
// Con "" caen en A1 (skip, fuera de Vercel) → byte-idénticos. Los tests que quieren el secreto lo
// re-stubean adentro (gana el stub más reciente).
beforeEach(() => {
  vi.stubEnv("DIDIT_API_KEY", ""); // → rama simulated_dev, sin fetch a Didit
  vi.stubEnv("VERCEL_ENV", ""); // → no-prod y no-Vercel: la simulación se acepta (DT-5 no dispara)
  vi.stubEnv("SETTLE_ATTESTATION_SECRET", ""); // → rama A1 (skip): los 19 existentes intactos
  vi.stubEnv("PAYOUT_POP_SECRET", ""); // WKH-206: guard 7 SKIP total (los tests que quieren PoP lo re-stubean)
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs(); // restoreAllMocks NO deshace stubEnv
});

// Despacha por URL y registra las llamadas AL AGENTE por separado, para que
// expect(agentCalls).toHaveLength(0) pruebe literalmente "el agente NUNCA fue invocado" (AC-1/2/5).
function fetchRouter(opts: { didit?: () => unknown; diditThrows?: boolean }) {
  const agentCalls: string[] = [];
  const fn = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/v3/session/")) {
      if (opts.diditThrows) throw new Error("The operation was aborted due to timeout");
      return { ok: true, json: async () => opts.didit?.() ?? {} };
    }
    agentCalls.push(url);
    return { ok: true, json: async () => ({ result: validResult }) };
  });
  return { fn, agentCalls };
}

describe("POST /api/a2a/payout/submit — proxy server-only a remit-cashout-payout (WKH-186)", () => {
  it("sin REMIT_AGENTS_BASE_URL → 501 a2a_not_configured, fetch NOT called (CD-9)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req(validPayload));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "a2a_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("con base + agente ok → 200 { result }; idempotencyKey forwardeado tal cual (CD-10); NO ecoa base/PII", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${BASE}/api/agents/remit-cashout-payout/invoke`);
      const fwd = JSON.parse((init as RequestInit).body as string);
      expect(fwd.idempotencyKey).toBe("r-1:cfx-1"); // CD-10 intacto
      return { ok: true, json: async () => ({ result: validResult }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req(validPayload));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain(BASE);
    // CD-5: la respuesta al cliente sólo lleva el result del agente (no ecoa el beneficiary del request).
    expect(raw).not.toContain("999888777");
    expect(JSON.parse(raw)).toEqual({ result: validResult });
  });

  it("agente !ok → 502 a2a_upstream_error (nunca 500)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_upstream_error" });
  });

  it("shape inválido del agente → 502 a2a_bad_shape", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ result: { status: "weird" } }) })));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_bad_shape" });
  });

  it("MNR-C: result { status:'settled', payoutId:null } → 502 a2a_bad_shape (alineado con el gateway)", async () => {
    // Antes la route lo aceptaba (validador divergente del gateway isValidPayoutShape). payoutId null
    // SOLO válido en failed/blocked: un settled/submitted sin payoutId no es trackeable → bad shape.
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { status: "settled", payoutId: null, deliveredLocal: 1478.15, txRef: "0x", reason: null, provenance: "p" } }),
    })));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_bad_shape" });
  });

  it("MNR-C: result { status:'submitted', payoutId:null } → 502 a2a_bad_shape (submitted también requiere payoutId)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { status: "submitted", payoutId: null, deliveredLocal: null, txRef: null, reason: null, provenance: "p" } }),
    })));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "a2a_bad_shape" });
  });

  it("MNR-C: result { status:'failed', payoutId:null } → 200 (payoutId null SÍ válido en failed)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const failedResult = { status: "failed", payoutId: null, deliveredLocal: null, txRef: null, reason: "partner_down", provenance: "p" };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ result: failedResult }) })));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: failedResult });
  });

  it("fetch throw (timeout/DNS) → 502 a2a_unavailable, NO 500 crudo, no ecoa el beneficiary", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("aborted"); }));
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    const raw = await res.text();
    expect(raw).not.toContain("999888777");
    expect(JSON.parse(raw)).toEqual({ error: "a2a_unavailable" });
  });
});

describe("POST /api/a2a/payout/submit — enforcement server-side del payout (WKH-202)", () => {
  it("sin address → 400 payout_invalid_request; NINGÚN fetch (AC-1)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ ...validPayload, address: undefined }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "payout_invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled(); // ni Didit ni el agente
  });

  it("sin kycVerificationId → 400 payout_invalid_request; NINGÚN fetch (AC-1)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ ...validPayload, kycVerificationId: undefined }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "payout_invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled(); // ni Didit ni el agente
  });

  // BLQ-BAJO-1 (AR): `req.json()` RESUELVE con `null` ante el body literal `null` (no rechaza) → el
  // .catch() no disparaba y el acceso al campo tiraba un TypeError FUERA del try → 500 crudo. Los
  // otros no-record ([], 123, "str") ya daban 400 (acceso a campo sobre ellos = undefined); se
  // incluyen igual para fijar el contrato: NINGÚN body no-record llega al fetch.
  it.each([
    ["null", null],
    ["array", []],
    ["number", 123],
    ["string", "str"],
  ])("body no-record (%s) → 400 payout_invalid_request; NINGÚN fetch (AC-1)", async (_label, payload) => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req(payload));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "payout_invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled(); // ni Didit ni el agente
  });

  // MNR-4 (CR): los 8 tests de WKH-186 que llegan al forward pasan por simulated_dev, rama que DT-5
  // rechaza en todo scope de Vercel → la composición "autorizar → forwardear" sólo estaba cubierta
  // por el camino que NUNCA corre en prod. Este test cubre el que SÍ corre: key real + Approved +
  // vendor_data == address → forward.
  it("forward path REAL (key + Approved + ownership ok) → 200 + agente invocado 1 vez (AC-4)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const { fn, agentCalls } = fetchRouter({
      didit: () => ({ status: "Approved", session_id: "v-1", vendor_data: "0xSender" }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(validPayload)); // address: "0xSender"
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: validResult });
    expect(agentCalls).toHaveLength(1); // el agente SÍ se invoca cuando la autoridad REAL autoriza
  });

  it("Didit Declined → 403 payout_not_authorized; agente NO invocado (AC-2)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const { fn, agentCalls } = fetchRouter({ didit: () => ({ status: "Declined", session_id: "v-1" }) });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(validPayload));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_not_authorized" });
    expect(agentCalls).toHaveLength(0);
  });

  it("ownership mismatch (vendor_data ≠ address) → 403; agente NO invocado (AC-2)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const { fn, agentCalls } = fetchRouter({
      didit: () => ({ status: "Approved", session_id: "v-1", vendor_data: "0xOtherWallet" }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(validPayload)); // address: "0xSender"
    expect(res.status).toBe(403);
    // CD-12 (no-oracle): MISMO code que Declined — el endpoint no revela POR QUÉ rechazó.
    expect(await res.json()).toEqual({ error: "payout_not_authorized" });
    expect(agentCalls).toHaveLength(0);
  });

  it("fetch a Didit throws (timeout) → 502 payout_authority_unavailable; agente NO invocado (AC-5)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const { fn, agentCalls } = fetchRouter({ diditThrows: true });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(validPayload));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "payout_authority_unavailable" });
    expect(agentCalls).toHaveLength(0);
  });

  it("DT-5: VERCEL_ENV=preview + sin DIDIT_API_KEY → 503; agente NO invocado (AC-5)", async () => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    vi.stubEnv("DIDIT_API_KEY", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(validPayload));
    // La simulación NO autoriza un payout en ningún scope de Vercel (fail-open real, CD-4).
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "payout_authority_unavailable" });
    expect(agentCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WKH-168 W6.4 — GATE G3: la atestación de settlement (AC-10/AC-11).
//
// Sin esto, un atacante con SU PROPIO KYC aprobado y SU PROPIA address pasa todos los guards de
// arriba (G1/G2/G4) y pide un payout por un monto ARBITRARIO sin haber pagado un solo USDC. El AR de
// WKH-202 lo probó EJECUTANDO. Estos 9 tests son el gate.
// `agentCalls` = 0 prueba literalmente "el agente NUNCA fue invocado".
// ─────────────────────────────────────────────────────────────────────────────

const SECRET = "test-settle-secret";
const SENDER = "0x1111111111111111111111111111111111111111";
const ATT_TX = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
const RECEIVER_ADDR = "0x2222222222222222222222222222222222222222";

/** Atestación VÁLIDA por default (el camino honesto): 400 USDC pagados por SENDER. */
function attFor(over: Partial<Parameters<typeof issueSettlementAttestation>[0]> = {}): string {
  return issueSettlementAttestation({
    txHash: ATT_TX,
    chainId: 43113,
    valueMinor: 400_000_000, // == Money.of(400,"USDC").minor
    from: SENDER,
    to: RECEIVER_ADDR,
    quoteId: "cfx-1",
    exp: Math.floor(Date.now() / 1000) + 900,
    ...over,
  });
}

/** El payload del camino honesto: address == att.from y amountUsd == att.valueMinor. */
function attestedPayload(over: Record<string, unknown> = {}) {
  return { ...validPayload, address: SENDER, settlementAttestation: attFor(), ...over };
}

describe("POST /api/a2a/payout/submit — GATE G3: atestación de settlement (WKH-168)", () => {
  beforeEach(() => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    // A7″: el deployment corre en la MISMA cadena que firma attFor() (43113). SETUP, no assert: sin
    // este stub, resolveChainId() cae en su default 43114 (chain.ts:12) y el camino honesto daría 403.
    // Los tests que quieren OTRA cadena la re-stubean adentro (gana el stub más reciente).
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "43113");
    claimMock.mockReset();
    claimMock.mockResolvedValue({ ok: true });
  });

  it("A10: atestación válida + monto y sender que atan ⇒ forward al agente (camino honesto, 200)", async () => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET);
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(attestedPayload()));
    expect(res.status).toBe(200);
    expect(agentCalls).toHaveLength(1);
    // La atestación se quemó (single-use) con el txHash verificado.
    expect(claimMock).toHaveBeenCalledWith(ATT_TX);
  });

  it("A3/AC-10: SIN atestación (el bypass del atacante) ⇒ 403 y el agente NUNCA se invoca", async () => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET);
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    // Exactamente el request del AR de WKH-202: KYC propio aprobado, address propia, sin pagar nada.
    for (const p of [
      validPayload,
      { ...validPayload, settlementAttestation: "" },
      { ...validPayload, settlementAttestation: 123 },
      { ...validPayload, settlementAttestation: null },
    ]) {
      const res = await POST(req(p));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "payout_principal_unverified" });
    }
    expect(agentCalls).toHaveLength(0);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("A4/AC-10: HMAC forjado o firmado con OTRO secreto ⇒ 403, agente NUNCA invocado", async () => {
    // El atacante fabrica una atestación con su propio secreto y monto inflado.
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", "el-secreto-del-atacante");
    const forged = attFor({ valueMinor: 999_000_000 });
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET); // el server usa el REAL
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);

    for (const token of [forged, "basura", "a.b", `${attFor()}x`]) {
      const res = await POST(req({ ...validPayload, address: SENDER, settlementAttestation: token }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "payout_principal_unverified" });
    }
    expect(agentCalls).toHaveLength(0);
  });

  it("A5/AC-10: atestación VENCIDA ⇒ 403 (mismo enum opaco que el HMAC malo — CD-12 no-oracle)", async () => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET);
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const expired = attFor({ exp: Math.floor(Date.now() / 1000) - 1 });
    const res = await POST(req(attestedPayload({ settlementAttestation: expired })));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_principal_unverified" });
    expect(agentCalls).toHaveLength(0);
  });

  it("A6/AC-10: MONTO ARBITRARIO — amountUsd ≠ el USDC realmente recibido ⇒ 403, agente NUNCA invocado", async () => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET);
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    // Pagó 400 (att.valueMinor = 400_000000) y pide cobrar 5000: el corazón del ataque.
    const res = await POST(req(attestedPayload({ amountUsd: 5000 })));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_principal_unverified" });
    // Ni un centavo de más: 400.01 también rebota.
    expect((await POST(req(attestedPayload({ amountUsd: 400.01 })))).status).toBe(403);
    expect(agentCalls).toHaveLength(0);
  });

  it("A6′/AC-10: amountUsd HOSTIL (string, NaN, ±Infinity, 0, negativo, enorme) ⇒ 403 opaco, NUNCA 500 crudo", async () => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET);
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    // Money.of() TIRA con NaN/negativo/>MAX_SAFE_INTEGER y este bloque corre FUERA del try/catch del
    // forward ⇒ sin el guard A6′ esto era un 500 crudo (WKH-202/BLQ-BAJO-1 repetido).
    const hostile: unknown[] = [
      "400",
      "abc",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      0,
      -400,
      1e300,
      null,
      undefined,
      {},
      [],
    ];
    for (const amountUsd of hostile) {
      const res = await POST(req(attestedPayload({ amountUsd })));
      expect(res.status).toBe(403); // nunca 500
      expect(await res.json()).toEqual({ error: "payout_principal_unverified" });
    }
    expect(agentCalls).toHaveLength(0);
  });

  it("A7/AC-10: el principal lo pagó OTRO (att.from ≠ address del body) ⇒ 403, agente NUNCA invocado", async () => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET);
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    // El atacante reusa la atestación de un pago ajeno y pone SU address (que pasó su propio KYC).
    const res = await POST(
      req({ ...validPayload, address: "0x9999999999999999999999999999999999999999", settlementAttestation: attFor() }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_principal_unverified" });
    expect(agentCalls).toHaveLength(0);
    // Case-insensitive: la MISMA address en otro casing SÍ pasa (no es un mismatch real).
    const ok = await POST(req(attestedPayload({ address: SENDER.toUpperCase().replace("0X", "0x") })));
    expect(ok.status).toBe(200);
  });

  it("A7′/AC-10: el quoteId del body ≠ el quoteId FIRMADO en la atestación (swap de TASA) ⇒ 403, agente NUNCA invocado", async () => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET);
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    // Repro exacto del AR (ATTACK-4): el principal se pagó bajo "cfx-1" (att.quoteId) pero el payout
    // se pide bajo OTRO quote — el mismo USD a una tasa mejor ⇒ sobre-entrega. Antes: 200 + forward.
    const res = await POST(req(attestedPayload({ quoteId: "cfx-OTRO-RATE" })));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_principal_unverified" });
    // Ausente / no-string / vacío ⇒ tampoco matchea (fail-closed, sin guard de presencia aparte).
    for (const quoteId of [undefined, "", 1, null, {}, "CFX-1"]) {
      expect((await POST(req(attestedPayload({ quoteId })))).status).toBe(403);
    }
    expect(agentCalls).toHaveLength(0);
    expect(claimMock).not.toHaveBeenCalled(); // ni se quema la atestación: el guard va ANTES de A8
  });

  it("A7″: atestación de OTRA CADENA (replay cross-entorno con USDC de FAUCET) ⇒ 403, agente NUNCA invocado", async () => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET);
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    // El gatillo NO es "el día que haya dos redes": es REUSAR SETTLE_ATTESTATION_SECRET entre
    // entornos. Preview en Fuji + prod en mainnet con el mismo secreto ⇒ la atestación emitida en
    // Fuji (USDC de faucet, GRATIS) valida el HMAC en mainnet y ata monto (A6), pagador (A7) y quote
    // (A7′) sin objeción ⇒ payout REAL de $400 por $0. Con UNA sola cadena en la app.
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "43114"); // el deployment es MAINNET
    const fromFuji = await POST(req(attestedPayload({ settlementAttestation: attFor({ chainId: 43113 }) })));
    expect(fromFuji.status).toBe(403);
    expect(await fromFuji.json()).toEqual({ error: "payout_principal_unverified" }); // CD-12: mismo enum opaco

    // Simétrico: el deployment es Fuji y la atestación dice mainnet.
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "43113");
    const fromMainnet = await POST(req(attestedPayload({ settlementAttestation: attFor({ chainId: 43114 }) })));
    expect(fromMainnet.status).toBe(403);
    expect(await fromMainnet.json()).toEqual({ error: "payout_principal_unverified" });

    // CD-9: el chainId sale de la ENV, JAMÁS del body. Un `chainId` del caller sería el binding
    // FALSO que este guard mata: el atacante declararía la cadena de SU atestación y auto-validaría.
    // Sin este assert, la forma body-sourced (fail-open) pasa los asserts de arriba sin objeción
    // (verificado MUTANDO: sobrevive). El deployment sigue en Fuji ⇒ la atestación de mainnet rebota
    // aunque el body jure 43114.
    for (const chainId of [43114, 43113, "43114", null]) {
      const spoofed = await POST(
        req(attestedPayload({ settlementAttestation: attFor({ chainId: 43114 }), chainId })),
      );
      expect(spoofed.status).toBe(403);
    }

    expect(agentCalls).toHaveLength(0);
    expect(claimMock).not.toHaveBeenCalled(); // ni se quema la atestación: el guard va ANTES de A8
  });

  it("A8/AC-11: REPLAY — 2ª presentación de la misma atestación ⇒ 409, agente NUNCA invocado", async () => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET);
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    claimMock.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, alreadyUsed: true });

    expect((await POST(req(attestedPayload()))).status).toBe(200);
    const second = await POST(req(attestedPayload()));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "payout_already_settled" });
    expect(agentCalls).toHaveLength(1); // el 2º NO llegó al agente
  });

  it("A9/A2/AC-11: Upstash caído ⇒ 503 sin forwardear; y sin secreto EN VERCEL ⇒ 503 (nunca fail-open)", async () => {
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET);
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);

    // A9 — fail-CLOSED: si Upstash está caído no podemos garantizar el single-use ⇒ bloquear. Con
    // fail-open, el atacante tiraría Upstash y cobraría N payouts sobre un solo principal.
    claimMock.mockResolvedValue({ ok: false, unavailable: true });
    const down = await POST(req(attestedPayload()));
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "payout_settlement_unavailable" });

    expect(agentCalls).toHaveLength(0);
  });

  it("A2/AC-10: deploy de Vercel SIN SETTLE_ATTESTATION_SECRET ⇒ 503, agente NUNCA invocado (jamás skip)", async () => {
    // La autoridad debe AUTORIZAR de verdad (key + Approved + ownership): con simulated_dev, el guard
    // de WKH-202 cortaría antes en Vercel y este test no probaría A2 (CD-11: el orden importa).
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", "");
    const { fn, agentCalls } = fetchRouter({
      didit: () => ({ status: "Approved", session_id: "v-1", vendor_data: "0xSender" }),
    });
    vi.stubGlobal("fetch", fn);

    for (const scope of ["production", "preview"]) {
      vi.stubEnv("VERCEL_ENV", scope); // un preview con agentes reales tampoco desembolsa sin verificar
      const res = await POST(req(validPayload));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "payout_settlement_unavailable" });
    }
    expect(agentCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WKH-206 — GUARD 7: proof-of-possession (AC-1/AC-2/AC-3/AC-4/AC-6).
//
// El caller firma con la PRIVATE KEY de `address` un challenge server-emitido; el guard recupera
// criptográficamente al firmante y exige == address ANTES de forwardear. El verificador del challenge
// corre REAL (HMAC de verdad); las firmas son REALES (privateKeyToAccount). Solo el nonce-store se
// mockea (popClaimMock). `agentCalls`=0 prueba literalmente "el agente NUNCA fue invocado".
// ─────────────────────────────────────────────────────────────────────────────

const POP_SECRET = "test-pop-secret";

/** Emite un challenge REAL (HMAC) y lo firma con `account` (firma REAL). address del challenge =
 *  account.address lowercased por default (P3 pasa). Overrideá para los ataques. */
async function signedPop(opts: {
  account: ReturnType<typeof privateKeyToAccount>;
  chainId?: number;
  address?: string; // address DENTRO del challenge (default: la del account)
  exp?: number;
  nonce?: string;
}): Promise<{ popChallenge: string; popSignature: string }> {
  const chainId = opts.chainId ?? 43113;
  const addr = (opts.address ?? opts.account.address).toLowerCase();
  const nonce = opts.nonce ?? "abcdef0123456789abcdef0123456789";
  const exp = opts.exp ?? Math.floor(Date.now() / 1000) + 300;
  const ch = { address: addr, chainId, nonce, exp };
  const popChallenge = issuePopChallenge(ch);
  const popSignature = await opts.account.signMessage({ message: buildPopMessage(ch) });
  return { popChallenge, popSignature };
}

describe("POST /api/a2a/payout/submit — GUARD 7: proof-of-possession (WKH-206)", () => {
  beforeEach(() => {
    vi.stubEnv("REMIT_AGENTS_BASE_URL", BASE);
    // El deployment corre en la MISMA cadena que firma signedPop() por default (43113). SETUP.
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "43113");
    popClaimMock.mockReset();
    popClaimMock.mockResolvedValue({ ok: true });
  });

  it("AC-1: PAYOUT_POP_SECRET ausente ⇒ SKIP total, forward byte-idéntico; popClaimMock NUNCA llamado", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", ""); // apagado (default)
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    // Sin popChallenge/popSignature en el body y sin secreto: pasa igual (el demo no cambia).
    const res = await POST(req(validPayload));
    expect(res.status).toBe(200);
    expect(agentCalls).toHaveLength(1);
    expect(popClaimMock).not.toHaveBeenCalled();
  });

  it("AC-1/DT-4: secreto ausente EN VERCEL (VERCEL_ENV=preview) ⇒ SKIP igual (NO 503, a diferencia de la atestación)", async () => {
    // Para AISLAR el guard 7 en Vercel hay que pasar los guards 4-6 (autoridad REAL) y 8 (atestación
    // válida): con la atestación apagada, su guard A2 daría 503 en Vercel y no probaríamos el PoP.
    vi.stubEnv("PAYOUT_POP_SECRET", ""); // ← lo que se prueba: PoP apagado
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("DIDIT_API_KEY", "test-key"); // autoridad REAL (simulated_dev daría 503 en Vercel)
    vi.stubEnv("SETTLE_ATTESTATION_SECRET", SECRET); // atestación ON + payload válido ⇒ guard 8 pasa
    claimMock.mockResolvedValue({ ok: true }); // store de la atestación
    const { fn, agentCalls } = fetchRouter({
      didit: () => ({ status: "Approved", session_id: "v-1", vendor_data: SENDER }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req(attestedPayload())); // sin PoP en el body
    expect(res.status).toBe(200); // guard 7 NO dispara 503 cuando el secreto está ausente (DT-4)
    expect(agentCalls).toHaveLength(1);
    expect(popClaimMock).not.toHaveBeenCalled(); // el guard 7 ni corrió
  });

  it("AC-3: happy — challenge válido + firma REAL que recupera a `address` ⇒ forward, nonce quemado", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
    const account = privateKeyToAccount(generatePrivateKey());
    const pop = await signedPop({ account });
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ ...validPayload, address: account.address, ...pop }));
    expect(res.status).toBe(200);
    expect(agentCalls).toHaveLength(1);
    expect(popClaimMock).toHaveBeenCalledWith("abcdef0123456789abcdef0123456789"); // el nonce del challenge
  });

  it("AC-3/suplantación: firma de OTRA key (recupera a address distinta) ⇒ 403 opaco, agente NUNCA", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
    const victim = privateKeyToAccount(generatePrivateKey());
    const attacker = privateKeyToAccount(generatePrivateKey());
    // El challenge se emite para la address de la VÍCTIMA, pero lo firma el ATACANTE.
    const chainId = 43113;
    const nonce = "abcdef0123456789abcdef0123456789";
    const exp = Math.floor(Date.now() / 1000) + 300;
    const ch = { address: victim.address.toLowerCase(), chainId, nonce, exp };
    const popChallenge = issuePopChallenge(ch);
    const popSignature = await attacker.signMessage({ message: buildPopMessage(ch) }); // firma HOSTIL
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const res = await POST(
      req({ ...validPayload, address: victim.address, popChallenge, popSignature }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_pop_unverified" });
    expect(agentCalls).toHaveLength(0);
    expect(popClaimMock).not.toHaveBeenCalled(); // rechazo P5 stateless: NUNCA quema el nonce
  });

  it("AC-3/P1: popChallenge/popSignature ausentes o no-string ⇒ 403, agente NUNCA", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
    const account = privateKeyToAccount(generatePrivateKey());
    const pop = await signedPop({ account });
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const bad: Record<string, unknown>[] = [
      {}, // ambos ausentes
      { popChallenge: pop.popChallenge }, // falta firma
      { popSignature: pop.popSignature }, // falta challenge
      { popChallenge: "", popSignature: pop.popSignature },
      { popChallenge: pop.popChallenge, popSignature: "" },
      { popChallenge: 123, popSignature: pop.popSignature },
      { popChallenge: pop.popChallenge, popSignature: null },
    ];
    for (const over of bad) {
      const res = await POST(req({ ...validPayload, address: account.address, ...over }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "payout_pop_unverified" });
    }
    expect(agentCalls).toHaveLength(0);
    expect(popClaimMock).not.toHaveBeenCalled();
  });

  it("AC-3/P3: challenge emitido para address distinta a body.address ⇒ 403", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
    const account = privateKeyToAccount(generatePrivateKey());
    // Challenge + firma coherentes entre sí (para la address del account), pero el body declara OTRA.
    const pop = await signedPop({ account });
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const res = await POST(
      req({ ...validPayload, address: "0x9999999999999999999999999999999999999999", ...pop }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_pop_unverified" });
    expect(agentCalls).toHaveLength(0);
    expect(popClaimMock).not.toHaveBeenCalled();
  });

  it("AC-4/replay: 2ª presentación (popClaimMock {alreadyUsed}) ⇒ 409, agente NUNCA", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
    const account = privateKeyToAccount(generatePrivateKey());
    const pop = await signedPop({ account });
    popClaimMock.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, alreadyUsed: true });
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const payload = { ...validPayload, address: account.address, ...pop };
    expect((await POST(req(payload))).status).toBe(200);
    const second = await POST(req(payload));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "payout_pop_replayed" });
    expect(agentCalls).toHaveLength(1); // el 2º NO llegó al agente
  });

  it("AC-4: challenge EXPIRADO ⇒ 403 (mismo enum opaco que HMAC malo — CD-4 no-oracle)", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
    const account = privateKeyToAccount(generatePrivateKey());
    const pop = await signedPop({ account, exp: Math.floor(Date.now() / 1000) - 1 });
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ ...validPayload, address: account.address, ...pop }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_pop_unverified" });
    expect(agentCalls).toHaveLength(0);
    expect(popClaimMock).not.toHaveBeenCalled();
  });

  it("AC-4/fail-closed: nonce-store caído ({unavailable}) ⇒ 503, agente NUNCA (NUNCA forward)", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
    const account = privateKeyToAccount(generatePrivateKey());
    const pop = await signedPop({ account });
    popClaimMock.mockResolvedValue({ ok: false, unavailable: true });
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ ...validPayload, address: account.address, ...pop }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "payout_pop_unavailable" });
    expect(agentCalls).toHaveLength(0);
  });

  it("AC-6/P4: challenge de OTRA cadena (ch.chainId ≠ resolveChainId) ⇒ 403", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "43113"); // deployment Fuji
    const account = privateKeyToAccount(generatePrivateKey());
    // Firma coherente para chainId 43114 (mainnet) — replay cross-entorno con el mismo secreto.
    const pop = await signedPop({ account, chainId: 43114 });
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ ...validPayload, address: account.address, ...pop }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_pop_unverified" });
    expect(agentCalls).toHaveLength(0);
    expect(popClaimMock).not.toHaveBeenCalled();
  });

  it("AC-6/mutante fail-open chainId: body jura chainId, pero P4 lo saca de la ENV ⇒ 403 igual (CD-9)", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "43113"); // deployment Fuji
    const account = privateKeyToAccount(generatePrivateKey());
    const pop = await signedPop({ account, chainId: 43114 }); // challenge de mainnet
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    // Un mutante body-sourced (`ch.chainId !== body.chainId`) ACEPTARÍA cuando body.chainId==43114.
    // Con el guard correcto (contra resolveChainId()==43113) rebota SIEMPRE, aunque el body mienta.
    for (const chainId of [43114, "43114", 43113, null]) {
      const res = await POST(req({ ...validPayload, address: account.address, chainId, ...pop }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "payout_pop_unverified" });
    }
    expect(agentCalls).toHaveLength(0);
    expect(popClaimMock).not.toHaveBeenCalled();
  });

  it("CD-4 no-oracle: P2 (HMAC malo) / P3 (address) / P4 (chainId) / P5 (firma) ⇒ MISMO 403 + body", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
    vi.stubEnv("NEXT_PUBLIC_CHAIN_ID", "43113");
    const account = privateKeyToAccount(generatePrivateKey());
    const good = await signedPop({ account });
    const attacker = privateKeyToAccount(generatePrivateKey());
    // P2: HMAC forjado (challenge basura). P3: address distinta. P4: otra cadena. P5: firma hostil.
    const p5 = await signedPop({ account: attacker, address: account.address.toLowerCase() });
    const p4 = await signedPop({ account, chainId: 43114 });
    const cases: { label: string; address: string; over: Record<string, unknown> }[] = [
      { label: "P2", address: account.address, over: { popChallenge: "basura.mac", popSignature: good.popSignature } },
      { label: "P3", address: "0x9999999999999999999999999999999999999999", over: { ...good } },
      { label: "P4", address: account.address, over: { ...p4 } },
      { label: "P5", address: account.address, over: { popChallenge: good.popChallenge, popSignature: p5.popSignature } },
    ];
    const { fn, agentCalls } = fetchRouter({});
    vi.stubGlobal("fetch", fn);
    for (const c of cases) {
      const res = await POST(req({ ...validPayload, address: c.address, ...c.over }));
      expect(res.status, c.label).toBe(403);
      expect(await res.json(), c.label).toEqual({ error: "payout_pop_unverified" });
    }
    expect(agentCalls).toHaveLength(0);
    expect(popClaimMock).not.toHaveBeenCalled(); // ningún rechazo P2-P5 quema el nonce (burn-position)
  });

  it("AC-5/no-regresión WKH-202: ownership mismatch ⇒ 403 payout_not_authorized ANTES del guard 7 (guards 4-6 intactos)", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET); // PoP encendido
    vi.stubEnv("DIDIT_API_KEY", "test-key");
    const account = privateKeyToAccount(generatePrivateKey());
    const pop = await signedPop({ account });
    // La autoridad RECHAZA (vendor_data ≠ address): debe cortar con el enum de WKH-202, NO el de PoP.
    const { fn, agentCalls } = fetchRouter({
      didit: () => ({ status: "Approved", session_id: "v-1", vendor_data: "0xOtherWallet" }),
    });
    vi.stubGlobal("fetch", fn);
    const res = await POST(req({ ...validPayload, address: account.address, ...pop }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_not_authorized" }); // guard 6, NO payout_pop_unverified
    expect(agentCalls).toHaveLength(0);
    expect(popClaimMock).not.toHaveBeenCalled(); // el guard 7 ni siquiera corrió
  });
});
