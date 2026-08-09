// Tests — POST /api/payout/status (WKH-337/AC-1, CD-5/CD-14/CD-15/CD-16). El PoP corre REAL: challenge
// HMAC emitido con el mismo `issueSolanaPopChallenge` de la ruta /challenge y firma ed25519 de verdad
// (tweetnacl con un Keypair). Cero red, cero DB.
//
// ⚠️ El doble del ledger FILTRA DE VERDAD por `senderAddress` (mini-store con DOS senders). Con un
// `vi.fn().mockResolvedValue(...)` el test de aislamiento (T-337.9b) pasaría igual con el guard borrado:
// aprobaría desde arriba sin mirar los argumentos. Es la misma razón que da
// `../../solana/escrow/remittance-ids/route.test.ts:5-7`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  buildSolanaPopMessage,
  issueSolanaPopChallenge,
} from "../../../../src/infrastructure/auth/pop-challenge";

// Rate-limit: los tests no fijan env de Upstash (fail-closed → 503). Mock a { ok:true } por default;
// clientIp/PAYOUT_STATUS_RL quedan reales.
const { checkRouteRateLimitMock } = vi.hoisted(() => ({ checkRouteRateLimitMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/infrastructure/rate-limit")>();
  return { ...actual, checkRouteRateLimit: checkRouteRateLimitMock };
});

// Ledger: getSettlementLedger devuelve null por default (flag OFF ⇒ 501); los tests lo apuntan al
// mini-store honesto.
const { getLedgerMock, lookupMock } = vi.hoisted(() => ({
  getLedgerMock: vi.fn(),
  lookupMock: vi.fn(),
}));
vi.mock("../../../../src/infrastructure/persistence/supabase-settlement-ledger", () => ({
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
const PAYOUT_DE_A = "transfi-de-A";
const PAYOUT_DE_B = "transfi-de-B";

// Mini-store HONESTO: la fila sólo se ve si el payout_id Y el sender coinciden, como el
// `.eq(...).eq(...)` de Postgres. Si el handler pasara un sender fijo (o `body.sender` en vez de
// `ch.address`), la respuesta traería el desenlace del payout del otro dueño → rojo.
const FILAS = [
  { payoutId: PAYOUT_DE_A, sender: SENDER_A, status: "settled" as const },
  { payoutId: PAYOUT_DE_B, sender: SENDER_B, status: "failed" as const },
];
function honestLedger() {
  lookupMock.mockImplementation(
    async ({ payoutId, senderAddress }: { payoutId: string; senderAddress: string }) => {
      const fila = FILAS.find((f) => f.payoutId === payoutId && f.sender === senderAddress);
      if (!fila) return { outcome: "unknown", reason: "no_row" };
      return { outcome: "known", status: fila.status, provenance: "transfi" };
    },
  );
  return { lookupPayoutOutcome: lookupMock };
}

/** Challenge REAL + firma ed25519 REAL de la keypair dada. `challengeFor` permite emitir el challenge
 *  de una wallet y presentarlo como si fuera de otra (T-337.9). */
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
  return new Request("http://localhost/api/payout/status", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/payout/status (WKH-337/AC-1)", () => {
  beforeEach(() => {
    vi.stubEnv("PAYOUT_POP_SECRET", SECRET);
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
    getLedgerMock.mockReset();
    getLedgerMock.mockReturnValue(null); // default: flag OFF
    lookupMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── El camino que la HU construye ─────────────────────────────────────────────────────────────────
  it("AC-1: PoP válido + payout propio ⇒ 200 con el desenlace del ledger", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    const res = await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      payout: { outcome: "known", status: "settled", provenance: "transfi" },
    });
  });

  it("CD-16: el 200 lleva UNA clave y ≤3 campos escalares — ni monto, ni address, ni eco del payoutId", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    const res = await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, ...realPop(KP_A) }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["payout"]);
    expect(Object.keys(body.payout as object).length).toBeLessThanOrEqual(3);
    // El texto ENTERO de la respuesta, para que no se cuele nada por una clave que no enumeré.
    const crudo = JSON.stringify(body);
    for (const prohibido of [PAYOUT_DE_A, SENDER_A, "value_minor", "tx_hash", "last_error", "remittance"]) {
      expect(crudo, `el body no puede contener ${prohibido}`).not.toContain(prohibido);
    }
  });

  // ── 🔴 T-337.9 · el IDOR, de frente ──────────────────────────────────────────────────────────────
  // Es el test que el AR va a buscar primero. Dos mitades, y hacen falta las dos:
  //   (a) prueba de A presentada para pedir el payout de B ⇒ 403 y el ledger NI SE LLAMA (mata P3);
  //   (b) prueba de A VÁLIDA + payoutId de B ⇒ el ledger se llama con la address de A y no encuentra
  //       nada (mata el `.eq('sender_address', …)`: el AISLAMIENTO, no la presencia del filtro).
  it("T-337.9a: challenge+firma de la wallet A + `sender` de la wallet B ⇒ 403 y el ledger NUNCA se llama", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    const res = await POST(
      req({ sender: SENDER_B, payoutId: PAYOUT_DE_B, ...realPop(KP_A) }), // firma A, pide como B
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "payout_status_unverified" });
    expect(lookupMock).not.toHaveBeenCalled();
    expect(getLedgerMock).not.toHaveBeenCalled(); // el 501 tampoco se puede usar como oráculo acá
  });

  it("T-337.9b: PoP VÁLIDO de A + `payoutId` de una remesa de B ⇒ el ledger recibe la address de A y NO hay desenlace", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    const res = await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_B, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    // Sin el guard del ledger esto sería `known/failed`: el desenlace del payout de OTRO.
    expect(await res.json()).toEqual({ payout: { outcome: "unknown", reason: "no_row" } });
    // 🔴 Y el argumento EXACTO: la address VERIFICADA, no lo que vino en el body.
    expect(lookupMock).toHaveBeenCalledWith({ payoutId: PAYOUT_DE_B, senderAddress: SENDER_A });
  });

  it("T-337.9c: el `senderAddress` que entra al ledger es el del CHALLENGE, no el del body (M2)", async () => {
    // P3 garantiza que los dos coinciden, así que el input que distingue no es el valor sino la FUENTE:
    // se afirma que lo que llega al ledger es exactamente la canonicalización de `ch.address`.
    getLedgerMock.mockReturnValue(honestLedger());
    await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, ...realPop(KP_A) }));
    expect(lookupMock.mock.calls[0]?.[0]).toEqual({
      payoutId: PAYOUT_DE_A,
      senderAddress: KP_A.publicKey.toBase58(),
    });
  });

  // ── PoP: las 5 fallas colapsan en UN 403 opaco (CD-15) ───────────────────────────────────────────
  it("P1: sin popChallenge/popSignature ⇒ 403 y el ledger NUNCA se llama", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    for (const payload of [
      { sender: SENDER_A, payoutId: PAYOUT_DE_A },
      { sender: SENDER_A, payoutId: PAYOUT_DE_A, popChallenge: "x" },
      { sender: SENDER_A, payoutId: PAYOUT_DE_A, popSignature: "y" },
      { sender: SENDER_A, payoutId: PAYOUT_DE_A, popChallenge: "", popSignature: "" },
      { sender: SENDER_A, payoutId: PAYOUT_DE_A, popChallenge: 1, popSignature: 2 },
    ]) {
      const res = await POST(req(payload));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "payout_status_unverified" });
    }
    expect(lookupMock).not.toHaveBeenCalled();
    expect(getLedgerMock).not.toHaveBeenCalled();
  });

  it("P2: challenge con HMAC forjado o expirado ⇒ 403, ledger no llamado", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    const good = realPop(KP_A);
    const forjado = `${good.popChallenge.split(".")[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const r1 = await POST(
      req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, popChallenge: forjado, popSignature: good.popSignature }),
    );
    expect(r1.status).toBe(403);
    // Expirado (exp en el pasado, HMAC VÁLIDO): el que caduca es el token, no la firma.
    const chVencido = {
      address: SENDER_A,
      networkId: "solana:devnet",
      nonce: "0123456789abcdef0123456789abcdef",
      exp: Math.floor(Date.now() / 1000) - 1,
    };
    const vencido = issueSolanaPopChallenge(chVencido);
    const firmaVencida = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(buildSolanaPopMessage(chVencido)), KP_A.secretKey),
    );
    const r2 = await POST(
      req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, popChallenge: vencido, popSignature: firmaVencida }),
    );
    expect(r2.status).toBe(403);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("P4: challenge de OTRO cluster (mainnet) ⇒ 403 — anti-replay cross-cluster, el networkId NO sale del body", async () => {
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
    const res = await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, popChallenge, popSignature }));
    expect(res.status).toBe(403);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("P5: challenge legítimo de A pero firmado por B ⇒ 403 (la posesión de la key es lo que se prueba)", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    const ch = {
      address: SENDER_A,
      networkId: "solana:devnet",
      nonce: "0123456789abcdef0123456789abcdef",
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const popChallenge = issueSolanaPopChallenge(ch);
    const firmaDeB = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(buildSolanaPopMessage(ch)), KP_B.secretKey),
    );
    const res = await POST(
      req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, popChallenge, popSignature: firmaDeB }),
    );
    expect(res.status).toBe(403);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  // ── 🔴 M7 · no-oracle: el 501 va DESPUÉS del PoP ─────────────────────────────────────────────────
  it("no-oracle: con el ledger APAGADO y un PoP inválido la respuesta es 403, NO 501", async () => {
    getLedgerMock.mockReturnValue(null); // flag OFF
    const res = await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_A })); // sin prueba
    expect(res.status).toBe(403);
    // Si el 501 saliera antes del PoP, un caller ANÓNIMO usaría esta ruta como sensor del estado del
    // flag `SETTLEMENT_LEDGER_ENABLED`. El orden de los guards ES el control.
    expect(getLedgerMock).not.toHaveBeenCalled();
  });

  it("con el ledger apagado y un PoP VÁLIDO ⇒ 501, y ninguna lectura ocurre", async () => {
    getLedgerMock.mockReturnValue(null);
    const res = await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, ...realPop(KP_A) }));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "payout_status_not_enabled" });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  // ── 🔴 T-337.4c · el ledger TIRA ⇒ 502, y jamás un desenlace ─────────────────────────────────────
  // ⚠️ Escenario DEFENSIVO, no el estado de hoy: la migración 20260804 ya está aplicada en `bdwv`
  // (medido contra la base viva). El test NO se borra por eso — lo que vigila es que un error de query
  // no se pueda volver un desenlace fabricado, y esa propiedad no depende de qué migración esté puesta.
  it("T-337.4c: el ledger TIRA (PGRST204) ⇒ 502 con enum estable, `outcome` nunca `known`, cero eco de Postgres", async () => {
    lookupMock.mockRejectedValue(new Error("ledger_lookup_payout_outcome_failed:PGRST204"));
    getLedgerMock.mockReturnValue({ lookupPayoutOutcome: lookupMock });
    const res = await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, ...realPop(KP_A) }));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "payout_status_unavailable" });
    expect(body).not.toHaveProperty("payout");
    const crudo = JSON.stringify(body);
    expect(crudo).not.toContain("PGRST"); // CD-15: ni el code de Postgres ni el mensaje interno
    expect(crudo).not.toContain("ledger_lookup");
  });

  // ── Los guards de arriba, en orden ────────────────────────────────────────────────────────────────
  it("R1: sin PAYOUT_POP_SECRET ⇒ 503, sin tocar el rate-limit, el body ni el ledger", async () => {
    const proof = realPop(KP_A); // se emite CON secreto (el emisor lo necesita), se presenta SIN él
    vi.stubEnv("PAYOUT_POP_SECRET", "");
    getLedgerMock.mockReturnValue(honestLedger());
    const res = await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, ...proof }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "payout_status_unavailable" });
    expect(checkRouteRateLimitMock).not.toHaveBeenCalled();
    expect(getLedgerMock).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("R2: rate-limit excedido ⇒ 429 con Retry-After, ANTES de parsear el body o verificar el PoP", async () => {
    checkRouteRateLimitMock.mockResolvedValue({ ok: false, retryAfter: 42 });
    getLedgerMock.mockReturnValue(honestLedger());
    const res = await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, ...realPop(KP_A) }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(await res.json()).toEqual({ error: "payout_status_rate_limited" });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("R2: limiter no disponible (sin Upstash) ⇒ 503 fail-closed, nunca fail-open", async () => {
    checkRouteRateLimitMock.mockResolvedValue({ ok: false, unavailable: true });
    getLedgerMock.mockReturnValue(honestLedger());
    const res = await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, ...realPop(KP_A) }));
    expect(res.status).toBe(503);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("R3: body inválido ⇒ 400 (sender malformado, payoutId ausente/vacío/no-string/demasiado largo)", async () => {
    getLedgerMock.mockReturnValue(honestLedger());
    const proof = realPop(KP_A);
    for (const payload of [
      { sender: "no-es-base58", payoutId: PAYOUT_DE_A, ...proof },
      { sender: SENDER_A, ...proof },
      { sender: SENDER_A, payoutId: "   ", ...proof },
      { sender: SENDER_A, payoutId: 7, ...proof },
      { sender: SENDER_A, payoutId: "x".repeat(201), ...proof },
      null,
      "no soy un objeto",
      [SENDER_A],
    ]) {
      const res = await POST(req(payload));
      expect([400, 403], `payload=${JSON.stringify(payload)}`).toContain(res.status);
      expect(lookupMock).not.toHaveBeenCalled();
    }
  });

  it("los cuatro `unknown` viajan CON su motivo (colapsarlos perdería por qué no se sabe)", async () => {
    for (const reason of ["no_row", "not_terminal", "provenance_not_real", "conflicting_rows"]) {
      lookupMock.mockReset();
      lookupMock.mockResolvedValue({ outcome: "unknown", reason });
      getLedgerMock.mockReturnValue({ lookupPayoutOutcome: lookupMock });
      const res = await POST(req({ sender: SENDER_A, payoutId: PAYOUT_DE_A, ...realPop(KP_A) }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ payout: { outcome: "unknown", reason } });
    }
  });
});
