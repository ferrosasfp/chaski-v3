// Tests — POST /api/solana/escrow/remittance-ids (HU-SOL-20/AC-2, CD-16). El PoP corre REAL: challenge
// HMAC emitido con el mismo `issueSolanaPopChallenge` de la ruta /challenge y firma ed25519 de verdad
// (tweetnacl con un Keypair). Cero red, cero DB.
//
// ⚠️ El doble del ledger FILTRA DE VERDAD por `senderAddress` (mini-store con DOS senders). Con un
// `vi.fn().mockResolvedValue([...])` los tests de aislamiento (T-R0-5/6) pasarían igual con el guard
// borrado: aprobarían desde arriba sin mirar los argumentos.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  buildSolanaPopMessage,
  issueSolanaPopChallenge,
} from "../../../../../src/infrastructure/auth/pop-challenge";

// Rate-limit: los tests no fijan env de Upstash (fail-closed → 503). Mock a { ok:true } por default;
// clientIp/ESCROW_RECOVERY_RL quedan reales.
const { checkRouteRateLimitMock } = vi.hoisted(() => ({ checkRouteRateLimitMock: vi.fn() }));
vi.mock("../../../../../src/infrastructure/rate-limit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../src/infrastructure/rate-limit")>();
  return { ...actual, checkRouteRateLimit: checkRouteRateLimitMock };
});

// Ledger: getSettlementLedger devuelve null por default (flag OFF ⇒ 501); los tests lo apuntan al
// mini-store honesto.
const { getLedgerMock, listMock } = vi.hoisted(() => ({
  getLedgerMock: vi.fn(),
  listMock: vi.fn(),
}));
vi.mock("../../../../../src/infrastructure/persistence/supabase-settlement-ledger", () => ({
  getSettlementLedger: getLedgerMock,
}));

import { POST } from "./route";

// Seeds FIJAS (no Keypair.generate): las addresses son reproducibles corrida a corrida, así una
// mutación que hardcodee un sender se puede escribir y verificar sin adivinar.
const KP_A = Keypair.fromSeed(new Uint8Array(32).fill(11));
const KP_B = Keypair.fromSeed(new Uint8Array(32).fill(22));
const SENDER_A = KP_A.publicKey.toBase58();
const SENDER_B = KP_B.publicKey.toBase58();
const SECRET = "test-pop-secret";

// Mini-store HONESTO: filtra por sender_address como lo hace el `.eq(...)` de Postgres. Si el handler
// pasara un sender fijo (o `ch.address` mal atado), la respuesta traería filas del otro dueño → rojo.
const ROWS = [
  { sender: SENDER_A, remittanceId: "rem-A1", status: "prepared", createdAt: "2026-07-27T00:00:00.000Z" },
  { sender: SENDER_A, remittanceId: "rem-A2", status: "settled", createdAt: "2026-07-26T00:00:00.000Z" },
  { sender: SENDER_B, remittanceId: "rem-B1", status: "prepared", createdAt: "2026-07-25T00:00:00.000Z" },
];
function honestLedger() {
  listMock.mockImplementation(async ({ senderAddress }: { senderAddress: string }) =>
    ROWS.filter((r) => r.sender === senderAddress).map(({ remittanceId, status, createdAt }) => ({
      remittanceId,
      status,
      createdAt,
    })),
  );
  return { listRemittanceIdsBySender: listMock };
}

/** Challenge REAL + firma ed25519 REAL de la keypair dada. `challengeFor` permite emitir el challenge
 *  de una wallet y presentarlo como si fuera de otra (T-R0-5). */
function realPop(signer: Keypair, challengeFor: Keypair = signer) {
  const ch = {
    address: challengeFor.publicKey.toBase58(),
    networkId: "solana:devnet",
    nonce: "0123456789abcdef0123456789abcdef",
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const popChallenge = issueSolanaPopChallenge(ch);
  const msg = new TextEncoder().encode(buildSolanaPopMessage(ch));
  const popSignature = bs58.encode(nacl.sign.detached(msg, signer.secretKey));
  return { popChallenge, popSignature };
}

function req(payload: unknown): Request {
  return new Request("http://localhost/api/solana/escrow/remittance-ids", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/solana/escrow/remittance-ids (HU-SOL-20/AC-2)", () => {
  beforeEach(() => {
    vi.stubEnv("PAYOUT_POP_SECRET", SECRET);
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
    getLedgerMock.mockReset();
    getLedgerMock.mockReturnValue(null); // default: flag OFF
    listMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── T-R0-7 · fail-closed sin secreto (PRIMER guard) ───────────────────────────────────────────────
  it("T-R0-7: sin PAYOUT_POP_SECRET ⇒ 503, sin tocar el rate-limit, el body ni el ledger", async () => {
    const proof = realPop(KP_A); // se emite CON secreto (el emisor lo necesita), se presenta SIN él
    vi.stubEnv("PAYOUT_POP_SECRET", "");
    getLedgerMock.mockReturnValue(honestLedger());
    const res = await POST(req({ sender: SENDER_A, ...proof }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "escrow_recovery_unavailable" });
    expect(checkRouteRateLimitMock).not.toHaveBeenCalled();
    expect(getLedgerMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
  });

  // ── T-R0-4 · PoP ausente ⇒ 403 y el ledger NUNCA se consulta ──────────────────────────────────────
  it("T-R0-4 (CD-16): sin popChallenge/popSignature ⇒ 403 y el ledger NUNCA se llama", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    for (const payload of [
      { sender: SENDER_A },
      { sender: SENDER_A, popChallenge: "x" },
      { sender: SENDER_A, popSignature: "y" },
      { sender: SENDER_A, popChallenge: "", popSignature: "" },
      { sender: SENDER_A, popChallenge: 1, popSignature: 2 },
    ]) {
      const res = await POST(req(payload));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "escrow_recovery_unverified" });
    }
    expect(listMock).not.toHaveBeenCalled(); // ni un solo id salió sin probar posesión
    expect(getLedgerMock).not.toHaveBeenCalled();
  });

  it("T-R0-4: challenge con HMAC forjado / expirado ⇒ 403, ledger no llamado", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    const good = realPop(KP_A);
    // HMAC roto (última parte alterada).
    const forged = `${good.popChallenge.split(".")[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const r1 = await POST(req({ sender: SENDER_A, popChallenge: forged, popSignature: good.popSignature }));
    expect(r1.status).toBe(403);
    // Expirado (exp en el pasado, HMAC válido).
    const expiredCh = {
      address: SENDER_A,
      networkId: "solana:devnet",
      nonce: "0123456789abcdef0123456789abcdef",
      exp: Math.floor(Date.now() / 1000) - 10,
    };
    const expired = issueSolanaPopChallenge(expiredCh);
    const sig = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(buildSolanaPopMessage(expiredCh)), KP_A.secretKey),
    );
    const r2 = await POST(req({ sender: SENDER_A, popChallenge: expired, popSignature: sig }));
    expect(r2.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("T-R0-4: firma ed25519 de OTRA key sobre un challenge propio ⇒ 403 (P5), ledger no llamado", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    // challenge de A, firmado por B ⇒ el ed25519 no verifica contra A.
    const { popChallenge } = realPop(KP_A);
    const msgA = buildSolanaPopMessage({
      address: SENDER_A,
      networkId: "solana:devnet",
      nonce: "0123456789abcdef0123456789abcdef",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    const sigB = bs58.encode(nacl.sign.detached(new TextEncoder().encode(msgA), KP_B.secretKey));
    const res = await POST(req({ sender: SENDER_A, popChallenge, popSignature: sigB }));
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("T-R0-4: challenge con HMAC VÁLIDO pero address no-base58 ⇒ 403 (P3 try/catch), ledger no llamado", async () => {
    // verifySolanaPopChallenge NO valida base58 (solo string no vacío), así que un token bien firmado
    // puede traer basura en `address` y hacer throwear a canonicalizeAddress. Sin el try/catch de P3
    // eso sería un 500 crudo.
    getLedgerMock.mockReturnValue(honestLedger());
    const ch = {
      address: "0OIl-no-es-base58",
      networkId: "solana:devnet",
      nonce: "0123456789abcdef0123456789abcdef",
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const popChallenge = issueSolanaPopChallenge(ch);
    const popSignature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(buildSolanaPopMessage(ch)), KP_A.secretKey),
    );
    const res = await POST(req({ sender: SENDER_A, popChallenge, popSignature }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "escrow_recovery_unverified" });
    expect(listMock).not.toHaveBeenCalled();
  });

  // ── T-R0-5 · IDOR: PoP de OTRA wallet ────────────────────────────────────────────────────────────
  it("T-R0-5 (CD-16/IDOR): PoP válido de la wallet A presentado con sender=B ⇒ 403 y el ledger NO se llama", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    // Firma REAL de A sobre un challenge REAL de A — el token es impecable; lo único que falla es que
    // el caller pide los ids de B. Sin el match de P3, esto devolvería rem-B1 al dueño de A.
    const proofA = realPop(KP_A);
    const res = await POST(req({ sender: SENDER_B, ...proofA }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "escrow_recovery_unverified" });
    expect(listMock).not.toHaveBeenCalled();
    // Simétrico: challenge emitido para B pero firmado por A y pedido como A.
    const mixed = realPop(KP_A, KP_B); // firma A, challenge dice B
    const res2 = await POST(req({ sender: SENDER_A, ...mixed }));
    expect(res2.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("T-R0-5: networkId de otro cluster (mainnet) ⇒ 403 (P4 binding CAIP-2), ledger no llamado", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    const ch = {
      address: SENDER_A,
      networkId: "solana:mainnet", // ≠ resolveSolanaNetworkId() (devnet)
      nonce: "0123456789abcdef0123456789abcdef",
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const popChallenge = issueSolanaPopChallenge(ch);
    const popSignature = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(buildSolanaPopMessage(ch)), KP_A.secretKey),
    );
    const res = await POST(req({ sender: SENDER_A, popChallenge, popSignature }));
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  // ── T-R0-6 · happy path owner-scoped ─────────────────────────────────────────────────────────────
  it("T-R0-6 (AC-2/IDOR): PoP válido ⇒ 200 con SOLO los ids del firmante (rem-B1 jamás aparece)", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      remittanceIds: Array<{ remittanceId: string; status: string; createdAt: string }>;
    };
    expect(body.remittanceIds.map((r) => r.remittanceId)).toEqual(["rem-A1", "rem-A2"]);
    expect(JSON.stringify(body)).not.toContain("rem-B1"); // el otro dueño NO se filtra
    // El ledger se consultó con la address PoP-VERIFICADA y con el tope duro de 20.
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock.mock.calls[0]?.[0]).toEqual({
      senderAddress: SENDER_A,
      vm: "solana",
      limit: 20,
    });
    // Sin PII, sin montos, sin address (CD-7).
    expect(JSON.stringify(body)).not.toContain("value");
    expect(JSON.stringify(body)).not.toContain(SENDER_A);
  });

  it("T-R0-6: el sender B firmando lo suyo obtiene SOLO rem-B1", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    const res = await POST(req({ sender: SENDER_B, ...realPop(KP_B) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { remittanceIds: Array<{ remittanceId: string }> };
    expect(body.remittanceIds.map((r) => r.remittanceId)).toEqual(["rem-B1"]);
    expect(JSON.stringify(body)).not.toContain("rem-A1");
  });

  // ── T-R0-8 · no-oracle: el 501 vive DESPUÉS del PoP ──────────────────────────────────────────────
  it("T-R0-8 (no-oracle): ledger null ⇒ 501, pero SOLO tras un PoP OK; sin PoP el mismo caso es 403", async () => {
    getLedgerMock.mockReturnValue(null);
    const conPop = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(conPop.status).toBe(501);
    expect(await conPop.json()).toEqual({ error: "escrow_recovery_not_enabled" });
    // Un anónimo NO puede usar el 501 como sensor del estado del flag: recibe 403.
    const sinPop = await POST(req({ sender: SENDER_A }));
    expect(sinPop.status).toBe(403);
    expect(await sinPop.json()).toEqual({ error: "escrow_recovery_unverified" });
  });

  // ── Robustez: 400 / 429 / 502, nunca un 500 crudo ni eco del motivo ──────────────────────────────
  it("400 escrow_recovery_invalid_request: body no-record o sender no base58, sin tocar el ledger", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    for (const payload of [null, [], 123, "str", {}, { sender: "" }, { sender: "0OIl-nope" }, { sender: 42 }, { sender: "0x1111111111111111111111111111111111111111" }]) {
      const res = await POST(req(payload));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "escrow_recovery_invalid_request" });
    }
    expect(listMock).not.toHaveBeenCalled();
  });

  it("429 escrow_recovery_rate_limited con Retry-After; 503 si Upstash no está (fail-closed)", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    checkRouteRateLimitMock.mockResolvedValue({ ok: false, retryAfter: 45 });
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "escrow_recovery_rate_limited" });
    expect(res.headers.get("Retry-After")).toBe("45");

    checkRouteRateLimitMock.mockResolvedValue({ ok: false, unavailable: true });
    const res2 = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(res2.status).toBe(503);
    expect(await res2.json()).toEqual({ error: "escrow_recovery_unavailable" });
    expect(listMock).not.toHaveBeenCalled();
  });

  // ══ WKH-330 · AC-5 ═══════════════════════════════════════════════════════════════════════════════
  // Esta ruta es la superficie por la que una persona recupera su remittanceId probando posesión de su
  // wallet. Si filtrara las 'prepared', el caso de esta HU quedaría sin salida: el settle Solana
  // broadcasteó, la signature está verificada on-chain, el write 'prepared' → 'principal_in' falló por
  // infra, y la fila quedó en 'prepared'. Ese remittanceId es el ÚNICO argumento del refund trustless.
  //
  // ⚠️ FIXTURE LOCAL, NO el ROWS compartido de arriba. Medido sobre el commit base: cambiando los
  // literales "prepared" de ROWS y del fixture del ledger, y borrando este camino al mismo tiempo, la
  // suite ENTERA quedaba verde — el candado existía sólo porque dos strings de fixture decían
  // "prepared", no porque alguien lo afirmara.
  // Refutación de que sirva: poner `refs.filter((r) => r.status !== "prepared")` en el 200 de
  // app/api/solana/escrow/remittance-ids/route.ts y ver este test rojo con ESTE mensaje. Sin él, los
  // únicos rojos de ese mutante se llaman "IDOR", y quien los lea aprende que rompió el aislamiento
  // entre senders, no que dejó irrecuperable un depósito real.
  it("T-330-5b (AC-5): la ruta devuelve la 'prepared' de un depósito REAL cuyo write falló — sin ese id la persona no puede pedir el refund", async () => {
    const DEPOSITO_REAL_SIN_REGISTRAR = "rem-330-write-fallido";
    // Fixture LOCAL: sólo estas dos filas, ambas del mismo sender PoP-verificado.
    const filasLocales = [
      {
        remittanceId: DEPOSITO_REAL_SIN_REGISTRAR,
        status: "prepared",
        createdAt: "2026-08-06T10:00:00.000Z",
      },
      { remittanceId: "rem-330-ok", status: "settled", createdAt: "2026-08-06T09:00:00.000Z" },
    ];
    listMock.mockResolvedValue(filasLocales);
    getLedgerMock.mockReturnValue({ listRemittanceIdsBySender: listMock });

    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { remittanceIds: Array<{ remittanceId: string }> };
    const ids = json.remittanceIds.map((r) => r.remittanceId);
    expect(
      ids,
      "la ruta dejó de devolver la fila 'prepared': el remittanceId de un depósito real cuyo write falló se volvió irrecuperable y la persona no puede pedir el refund trustless de su escrow",
    ).toContain(DEPOSITO_REAL_SIN_REGISTRAR);
    // El status llega al cliente sin recortar: quien consume decide, la ruta no decide por él.
    expect(json.remittanceIds).toEqual(filasLocales);
  });

  it("la query que lanza ⇒ 502 opaco, NUNCA 500 crudo ni eco del error.code de Postgres", async () => {
    listMock.mockRejectedValue(new Error("ledger_list_by_sender_failed:PGRST301"));
    getLedgerMock.mockReturnValue({ listRemittanceIdsBySender: listMock });
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(res.status).toBe(502);
    const raw = JSON.stringify(await res.json());
    expect(raw).toBe(JSON.stringify({ error: "escrow_recovery_unavailable" }));
    expect(raw).not.toContain("PGRST301");
  });
});
