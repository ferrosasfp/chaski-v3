// Tests — POST /api/settle/solana-sponsor (HU-SOL-13/AC-1, MNR-1). Cubre la lógica security-relevant
// del route server-only: flag OFF/config faltante → 501; body inválido (no base58/base64) → 400; y el
// contrato del forward al facilitador (el `Authorization: Bearer` se inyecta SERVER-SIDE y el secreto
// NUNCA se ecoa al cliente). Espeja el patrón del test EVM app/api/settle/principal/route.test.ts:
// fetch stubeado, cero HTTP real, cero red, cero cadena.
import type { Idl } from "@coral-xyz/anchor";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// WKH-213/R3: el route ahora persiste la signature en el ledger (best-effort). getLedgerMock devuelve
// null por default ⇒ TODOS los tests previos quedan byte-idénticos (flag OFF = skip total).
const { getLedgerMock } = vi.hoisted(() => ({ getLedgerMock: vi.fn(() => null as unknown) }));
vi.mock("../../../../src/infrastructure/persistence/supabase-settlement-ledger", () => ({
  getSettlementLedger: getLedgerMock,
}));
import {
  FakeSettlementLedger,
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_POP_SIGNATURE,
  FAKE_SOLANA_REFERENCE,
  FAKE_SOLANA_SIGNATURE,
} from "../../../../src/test-support/fakes";
import { POST } from "./route";

const SENDER = FAKE_SOLANA_BENEFICIARY; // base58 devnet (44 chars)
const REFERENCE = FAKE_SOLANA_REFERENCE; // base58 (43 chars)
const POP_SIGNATURE = FAKE_SOLANA_POP_SIGNATURE; // base58 de 64 bytes (SDD 037)
const API_KEY = "sol-secret-key-123";
const BASE = "https://facilitator.test";

// ── Txs REALES (S3.5) ─────────────────────────────────────────────────────────────────────────────
// El settle ahora LEE el destino de los bytes de la tx, así que un placeholder tipo "AQIDBAUGBwg="
// dejó de ser un input válido: no es una tx y no afirma ningún beneficiary. Se arman con el MISMO
// coder del MISMO IDL pinneado que usa la wallet de producción. Que el escritor real y el lector real
// coincidan está probado aparte, sobre la salida de authorizePrincipal, en
// src/infrastructure/settlement/solana-deposit-beneficiary.test.ts.
/** Tx `deposit` legacy, partial-firmada, hacia `beneficiary`. */
async function depositTx(beneficiary: string): Promise<string> {
  const { Keypair, PublicKey, Transaction, TransactionInstruction } = await import(
    "@solana/web3.js"
  );
  const anchor = await import("@coral-xyz/anchor");
  const { escrowIdl } = await import("../../../../src/infrastructure/solana/escrow-idl");
  const coder = new anchor.BorshInstructionCoder(escrowIdl as unknown as Idl);
  const data = coder.encode("deposit", {
    remittanceId: Array.from(new Uint8Array(16)),
    beneficiary: new PublicKey(beneficiary),
    authority: Keypair.generate().publicKey,
    amount: new anchor.BN("400000000"),
    deadline: new anchor.BN("4070908800"),
  });
  const ix = new TransactionInstruction({
    programId: new PublicKey((escrowIdl as { address: string }).address),
    keys: [{ pubkey: new PublicKey(SENDER), isSigner: true, isWritable: true }],
    data,
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = Keypair.generate().publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

/**
 * WKH-347 — Tx con las DOS ix de negocio, en el orden que producción emite:
 * `[deposit, register_escrow]`. Mismo coder, mismo IDL pinneado que `depositTx`.
 *
 * `invertida: true` la arma AL REVÉS (`[register_escrow, deposit]`), que es el input de T-347-20: con ese
 * orden el lector server-side devuelve `unreadable` y la route corta con 400.
 */
async function depositConRegisterTx(
  beneficiary: string,
  invertida = false,
): Promise<string> {
  const { Keypair, PublicKey, Transaction, TransactionInstruction } = await import(
    "@solana/web3.js"
  );
  const anchor = await import("@coral-xyz/anchor");
  const { escrowIdl } = await import("../../../../src/infrastructure/solana/escrow-idl");
  const coder = new anchor.BorshInstructionCoder(escrowIdl as unknown as Idl);
  const programId = new PublicKey((escrowIdl as { address: string }).address);
  const remittanceId = Array.from(new Uint8Array(16));
  const depositData = coder.encode("deposit", {
    remittanceId,
    beneficiary: new PublicKey(beneficiary),
    authority: Keypair.generate().publicKey,
    amount: new anchor.BN("400000000"),
    deadline: new anchor.BN("4070908800"),
  });
  // El MISMO `remittanceId` que el `deposit`: el binding entre las dos ix no es opcional.
  const registerData = coder.encode("register_escrow", { remittanceId });
  const keys = [{ pubkey: new PublicKey(SENDER), isSigner: true, isWritable: true }];
  const depositIx = new TransactionInstruction({ programId, keys, data: depositData });
  const registerIx = new TransactionInstruction({ programId, keys, data: registerData });
  const tx = new Transaction();
  if (invertida) tx.add(registerIx, depositIx);
  else tx.add(depositIx, registerIx);
  tx.feePayer = Keypair.generate().publicKey;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

/** Depósito hacia la deposit-address que el servidor registró al preparar (el camino feliz). */
let PARTIAL_TX = "";
/** Depósito hacia una dirección que este servidor NUNCA emitió (la respuesta de prepare adulterada). */
let TX_A_OTRO = "";
/** La dirección del atacante, para poder afirmar que NO es la registrada. */
let OTRO_DESTINO = "";

function body(over: Record<string, unknown> = {}) {
  return {
    partialSignedTx: PARTIAL_TX,
    reference: REFERENCE,
    sender: SENDER,
    remittanceId: "rem-sol-1",
    popSignature: POP_SIGNATURE,
    ...over,
  };
}
function req(payload: unknown): Request {
  return new Request("https://chaski.test/api/settle/solana-sponsor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
/** Body crudo (para el literal `null`, que JSON.stringify no distingue de "sin body"). */
function rawReq(raw: string): Request {
  return new Request("https://chaski.test/api/settle/solana-sponsor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** mockImplementation (NO mockResolvedValue): el body de un Response se consume en la primera lectura;
 *  cada llamada → Response nueva (mismo criterio que el test EVM). */
function facilitatorResponds(status: number, payload: unknown = {}): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("POST /api/settle/solana-sponsor (HU-SOL-13)", () => {
  beforeAll(async () => {
    const { Keypair } = await import("@solana/web3.js");
    OTRO_DESTINO = Keypair.generate().publicKey.toBase58();
    PARTIAL_TX = await depositTx(FAKE_SOLANA_REFERENCE); // = el depositAddress que registra el prepare
    TX_A_OTRO = await depositTx(OTRO_DESTINO);
  });

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", "true");
    vi.stubEnv("FACILITATOR_BASE_URL", BASE);
    vi.stubEnv("FACILITATOR_API_KEY", API_KEY);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    getLedgerMock.mockReset();
    getLedgerMock.mockReturnValue(null); // sin ledger: comportamiento previo, byte-idéntico
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // ── (a) flag OFF ────────────────────────────────────────────────────────────
  it("S1: flag OFF (default) ⇒ 501 solana_settle_not_enabled y NINGÚN fetch (CD-5: construye, no enciende)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SOLANA_SETTLE_ENABLED", "");
    const res = await POST(req(body()));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "solana_settle_not_enabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── (b) config faltante ──────────────────────────────────────────────────────
  it("S2: sin FACILITATOR_BASE_URL/API_KEY ⇒ 501 solana_settle_not_configured, NINGÚN fetch (CD-6)", async () => {
    vi.stubEnv("FACILITATOR_BASE_URL", "");
    expect((await POST(req(body()))).status).toBe(501);
    vi.stubEnv("FACILITATOR_BASE_URL", BASE);
    vi.stubEnv("FACILITATOR_API_KEY", "");
    const res = await POST(req(body()));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "solana_settle_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── (c) body inválido (no base58/base64) ─────────────────────────────────────
  it("S3: body no-record (null literal, array, número, string, no-json) ⇒ 400, NINGÚN fetch", async () => {
    for (const raw of ["null", "[]", "123", '"s"', "not-json"]) {
      const res = await POST(rawReq(raw));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "solana_settle_invalid_request" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S3: partialSignedTx no-base64, reference/sender no-base58, remittanceId vacío ⇒ 400, NINGÚN fetch", async () => {
    const cases: Record<string, unknown>[] = [
      { partialSignedTx: "no base64 !!" }, // espacio + '!' fuera del alfabeto base64
      { partialSignedTx: 123 }, // no-string
      { reference: "0OIl_not_base58" }, // 0,O,I,l no están en el alfabeto base58
      { reference: "abc" }, // muy corto (< 32)
      { sender: "0xNOTb58" }, // '0' no base58 + longitud
      { sender: null },
      { remittanceId: "" },
      { remittanceId: "   " },
      { remittanceId: 42 },
      // SDD 037 — el popSignature es obligatorio y con forma verificada: sin él, o con un largo que
      // no es el de una firma ed25519, se corta acá sin gastar el forward ni el Bearer.
      { popSignature: undefined },
      { popSignature: null },
      { popSignature: 42 },
      { popSignature: "" },
      { popSignature: "0OIl-no-base58-0OIl-0OIl-0OIl-0OIl-0OIl-0OIl-0OIl-0OIl-0OIl-0OIl-0OIl-0OIl-0OIl-0OIl-0OI" },
      { popSignature: SENDER }, // un pubkey base58 valido, pero de 43-44 chars: NO es una firma
    ];
    for (const over of cases) {
      const res = await POST(req(body(over)));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "solana_settle_invalid_request" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── (d) el Bearer se inyecta SERVER-SIDE; el secreto NUNCA se expone al cliente ──
  it("AC-1/CD-6: el forward al facilitador lleva Authorization Bearer (server-side) al endpoint /solana/sponsor", async () => {
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
    await POST(req(body()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/solana/sponsor`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    const sent = JSON.parse(init.body as string);
    expect(sent.partialSignedTx).toBe(PARTIAL_TX);
    expect(sent.reference).toBe(REFERENCE);
    expect(sent.sender).toBe(SENDER);
    expect(sent.remittanceId).toBe("rem-sol-1");
    expect(sent.popSignature).toBe(POP_SIGNATURE);
  });

  it("CD-6/CD-12: 200 OK ⇒ devuelve SOLO la signature; la API key y la base URL NUNCA se ecoan al cliente", async () => {
    facilitatorResponds(200, {
      signature: FAKE_SOLANA_SIGNATURE,
      secret: API_KEY, // el facilitador podría filtrar de más — el route NO lo reenvía
    });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ signature: FAKE_SOLANA_SIGNATURE });
    const raw = JSON.stringify(json);
    expect(raw).not.toContain(API_KEY);
    expect(raw).not.toContain("facilitator.test");
  });

  it("CD-12 no-oracle: error del facilitador (422/429/409/5xx) ⇒ map opaco sin ecoar su motivo", async () => {
    const map: Array<[number, number, string]> = [
      [422, 422, "solana_settle_rejected"],
      [429, 429, "solana_settle_rate_limited"],
      [409, 502, "solana_settle_broadcast_failed"],
      [502, 502, "solana_settle_broadcast_failed"],
      [500, 503, "solana_settle_unavailable"],
      // SDD 037 — el 403 del facilitator se propaga como 403 con enum PROPIO. Antes caía en el
      // `else` de abajo y salía como 503 `unavailable`, que le decía a la persona "el servicio no
      // está" cuando lo que pasó es que su firma no autoriza esa transacción.
      [403, 403, "solana_settle_sender_proof_invalid"],
    ];
    for (const [upstream, expected, error] of map) {
      facilitatorResponds(upstream, { message: "internal facilitator detail LEAK" });
      const res = await POST(req(body()));
      expect(res.status).toBe(expected);
      const json = await res.json();
      expect(json).toEqual({ error });
      expect(JSON.stringify(json)).not.toContain("LEAK");
    }
  });

  it("★ SDD 037: el 403 del facilitador NO se confunde con una indisponibilidad", async () => {
    facilitatorResponds(403, {
      error: { code: "SPONSOR_SENDER_PROOF_INVALID", message: "sender signature does not authorize this transaction" },
    });
    const res = await POST(req(body()));
    // El enum PRIMERO: si esto muriera en "expected 503 to be 403", quien rompa el mapeo no ve qué rompió.
    expect(await res.json()).toEqual({ error: "solana_settle_sender_proof_invalid" });
    expect(res.status).toBe(403);
  });

  it("fail-closed: fetch throw/timeout ⇒ 503 solana_settle_unavailable (nunca un 500 crudo)", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    const res = await POST(req(body()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "solana_settle_unavailable" });
  });

  it("S5: 200 con signature ausente/no-base58 ⇒ 502 solana_settle_broadcast_failed (el 200 NO basta)", async () => {
    for (const sig of [undefined, "", "0OIl", 123]) {
      facilitatorResponds(200, { signature: sig });
      const res = await POST(req(body()));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "solana_settle_broadcast_failed" });
    }
  });

  // ── WKH-213/R3 · la remesa YA NO muere 'prepared' ────────────────────────────────────────────────
  // Antes de esto, el settle no escribía NADA al ledger: la fila nacía 'prepared' en
  // /api/payout/prepare y se quedaba ahí para siempre, así que ninguna superficie podía decir nada de
  // la remesa. Se mide el ESTADO FINAL de la fila, no que se llamó a una función.
  async function ledgerWithPreparedSolana(): Promise<FakeSettlementLedger> {
    const ledger = new FakeSettlementLedger("2026-07-28T00:00:00.000Z");
    await ledger.recordOrderPrepared({
      remittanceId: "rem-sol-1", // el MISMO remittanceId que manda el body()
      quoteId: "q-sol",
      idempotencyKey: "rem-sol-1:q-sol",
      depositAddress: FAKE_SOLANA_REFERENCE,
      chainId: 43113,
      senderAddress: SENDER,
      payoutId: "transfi-po-sol",
      payoutProvenance: "transfi",
      vm: "solana",
    });
    return ledger;
  }

  it("R3: 200 del sponsor ⇒ la fila 'prepared' de esa remesa queda en principal_in con la signature", async () => {
    const ledger = await ledgerWithPreparedSolana();
    getLedgerMock.mockReturnValue(ledger);
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signature: FAKE_SOLANA_SIGNATURE });
    const row = [...ledger.store.values()][0]!;
    expect(row.status).toBe("principal_in"); // ← antes: 'prepared', siempre
    expect(row.txHash).toBe(FAKE_SOLANA_SIGNATURE); // la firma verificada on-chain, en el ledger
    expect(row.payoutId).toBe("transfi-po-sol"); // intacto
  });

  it("R3: una respuesta NO-ok del sponsor no escribe nada (la fila sigue 'prepared')", async () => {
    const ledger = await ledgerWithPreparedSolana();
    getLedgerMock.mockReturnValue(ledger);
    facilitatorResponds(422, { error: "SPONSOR_REJECTED" });
    const res = await POST(req(body()));
    expect(res.status).toBe(422);
    expect([...ledger.store.values()][0]!.status).toBe("prepared"); // sin broadcast no hay evidencia
  });

  it("CD-17: si el ledger TIRA, el money-path responde IGUAL (200 con la signature)", async () => {
    const ledger = await ledgerWithPreparedSolana();
    vi.spyOn(ledger, "recordSolanaPrincipalIn").mockRejectedValue(new Error("db down"));
    getLedgerMock.mockReturnValue(ledger);
    vi.spyOn(console, "error").mockImplementation(() => {});
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signature: FAKE_SOLANA_SIGNATURE });
  });

  // ── S3.5 · el destino de la tx contra lo que el SERVIDOR registró al preparar ────────────────────
  //
  // Esta es la única defensa del destino en la que no participan ni el navegador ni el canal: los dos
  // lados salen del server (los bytes firmados y la fila del ledger). La capa de atestación NO cubre
  // al intermediario que reescribe las dos rutas, y eso está clavado con su resultado real en
  // src/infrastructure/settlement/http-solana-prepare-gateway.test.ts ("LÍMITE CONOCIDO").
  //
  // EL asesino del mutante: si alguien borra el `!registered.includes(...)`, o lo invierte, o lo
  // alimenta con el beneficiary del body en vez de con el de la tx, este test se pone rojo.
  it("S3.5: la tx paga a una dirección que el servidor NO registró ⇒ 409 mismatch y NINGÚN forward", async () => {
    const ledger = await ledgerWithPreparedSolana(); // registró FAKE_SOLANA_REFERENCE
    getLedgerMock.mockReturnValue(ledger);
    const alerta = vi.spyOn(console, "error").mockImplementation(() => {});
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });

    const res = await POST(req(body({ partialSignedTx: TX_A_OTRO })));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "solana_settle_beneficiary_mismatch" });
    expect(fetchMock).not.toHaveBeenCalled(); // la tx NO se broadcastea: la plata no sale
    // El rechazo no consume nada: la fila sigue como estaba y el reintento es posible.
    expect([...ledger.store.values()][0]!.status).toBe("prepared");
    expect([...ledger.store.values()][0]!.txHash).toBe("prepared:rem-sol-1:q-sol");
    expect(alerta).toHaveBeenCalled(); // el mismatch grita [ALERT]
    expect(OTRO_DESTINO).not.toBe(FAKE_SOLANA_REFERENCE); // el caso no es vacuo
  });

  it("S3.5: la MISMA tx buena, con la dirección registrada, pasa (el guard no bloquea el camino feliz)", async () => {
    const ledger = await ledgerWithPreparedSolana();
    getLedgerMock.mockReturnValue(ledger);
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });

    const res = await POST(req(body()));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("S3.5: la dirección está registrada pero para OTRO sender ⇒ 409 unregistered (owner-scoped)", async () => {
    const ledger = await ledgerWithPreparedSolana();
    getLedgerMock.mockReturnValue(ledger);
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
    const { Keypair } = await import("@solana/web3.js");
    const ajeno = Keypair.generate().publicKey.toBase58();

    const res = await POST(req(body({ sender: ajeno })));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "solana_settle_beneficiary_unregistered" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("S3.5: sin fila registrada para esa remesa ⇒ 409 unregistered, y NO se confunde con mismatch", async () => {
    getLedgerMock.mockReturnValue(new FakeSettlementLedger("2026-07-28T00:00:00.000Z")); // ledger vacío
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });

    const res = await POST(req(body()));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "solana_settle_beneficiary_unregistered" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // "No pude preguntar" NO es "no coincide": tercer desenlace, enum propio, 503 reintentable.
  it("S3.5: la lectura del ledger TIRA ⇒ 503 ledger_unavailable (NUNCA mismatch), NINGÚN forward", async () => {
    const ledger = await ledgerWithPreparedSolana();
    vi.spyOn(ledger, "listPreparedDepositAddresses").mockRejectedValue(new Error("db down"));
    getLedgerMock.mockReturnValue(ledger);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });

    const res = await POST(req(body()));

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json).toEqual({ error: "solana_settle_ledger_unavailable" });
    expect(JSON.stringify(json)).not.toContain("mismatch"); // no acusa de lo que no pudo comprobar
    expect(fetchMock).not.toHaveBeenCalled(); // nada consumido ⇒ el reintento sirve
  });

  it("S3.5: una tx de la que no se puede leer ningún destino ⇒ 400 deposit_unreadable, NINGÚN forward", async () => {
    const ledger = await ledgerWithPreparedSolana();
    getLedgerMock.mockReturnValue(ledger);
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });

    // base64 válido para la regex de S3, pero no es una tx: antes de S3.5 esto llegaba al facilitador.
    const res = await POST(req(body({ partialSignedTx: "AQIDBAUGBwg=" })));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "solana_settle_deposit_unreadable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flag OFF (ledger null) ⇒ respuesta byte-idéntica, sin tocar la DB", async () => {
    getLedgerMock.mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
    const res = await POST(req(body()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signature: FAKE_SOLANA_SIGNATURE });
  });

  // ── WKH-325 · AC-10 · el ledger apagado apaga DOS cosas, y hasta acá eso sólo estaba en un comentario
  // Con el ledger apagado este depósito se broadcastea SIN el chequeo de destino de S3.5 y SIN registro
  // durable: el remittanceId, único argumento del refund on-chain, queda sólo en el navegador.
  describe("AC-10 — alerta de depósito sin registro (WKH-325)", () => {
    let errSpy: ReturnType<typeof vi.spyOn>;
    // warnSpy: lo agrega WKH-330. Hasta acá este describe no espiaba console.warn, y sin espiarlo no
    // se puede afirmar que un fallo NO salió por ese canal. Silenciarlo no cambia ningún assert
    // previo: ningún test de este describe mira console.warn (refutación: `command grep -n
    // 'console, "warn"' app/api/settle/solana-sponsor/route.test.ts` — el único otro está afuera).
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    /** Alertas del settle emitidas hasta acá, POR ENUM. LA MISMA función cuenta los casos de 1 y los de
     *  0 (CD-13): un `toBe(0)` sobre un spy vacío mediría cero y pasaría sin decir nada.
     *
     *  🔴 WKH-347 — SE REFINÓ POR ENUM, Y NO ES COSMÉTICO. Antes contaba TODAS las líneas
     *  `[settle][ALERT]` sin distinguir cuál, y desde WKH-347 este handler puede emitir CUATRO enums
     *  distintos. El fixture `depositTx()` arma una tx con UNA sola ix de negocio, así que dispara
     *  siempre la constancia del índice: con el contador viejo, `T-10a` y `T-10c` medían la alerta
     *  equivocada y se ponían rojos por una razón que no tenía nada que ver con lo que vigilan.
     *
     *  ⚠️ LA PROPIEDAD QUE NO SE PERDIÓ: sigue siendo UNA sola función, y sigue contando los casos de 1
     *  y los de 0. El `enum` es un ARGUMENTO, no dos funciones distintas: si fueran dos, un `toBe(0)`
     *  podría estar mirando un canal que nunca se llena. */
    const settleAlertCount = (enumEsperado: string): number =>
      errSpy.mock.calls.filter(
        (c) => String(c[0]).includes("[settle][ALERT]") && String(c[0]).includes(enumEsperado),
      ).length;
    /** El enum de WKH-325, el que este describe vigila. */
    const SIN_REGISTRO = "solana_settle_unrecorded_deposit";

    // T-10a — los DOS casos en el MISMO `it`, con el MISMO spy y el MISMO contador.
    it("T-10a (CD-13): ledger apagado + 200 ⇒ 1 alerta; ledger encendido + 200 ⇒ 0", async () => {
      getLedgerMock.mockReturnValue(null);
      facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
      expect((await POST(req(body()))).status).toBe(200);
      expect(settleAlertCount(SIN_REGISTRO)).toBe(1);

      errSpy.mockClear();
      getLedgerMock.mockReturnValue(await ledgerWithPreparedSolana());
      facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
      expect((await POST(req(body()))).status).toBe(200);
      expect(settleAlertCount(SIN_REGISTRO)).toBe(0);
    });

    it("T-10b (CD-7): el argumento de la alerta es EXACTAMENTE {remittanceId}", async () => {
      getLedgerMock.mockReturnValue(null);
      facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
      await POST(req(body()));
      const call = errSpy.mock.calls.find((c) => String(c[0]).includes("[settle][ALERT]"));
      expect(String(call?.[0])).toContain("solana_settle_unrecorded_deposit");
      // Ni la signature, ni el sender, ni el monto: sólo el identificador de correlación.
      expect(call?.[1]).toEqual({ remittanceId: "rem-sol-1" });
    });

    it.each([422, 403, 429, 502, 503])(
      "T-10c: ledger apagado + facilitator %i ⇒ 0 alertas (SÓLO el 200 alerta)",
      async (upstream) => {
        getLedgerMock.mockReturnValue(null);
        facilitatorResponds(upstream, { error: "nope" });
        await POST(req(body()));
        expect(settleAlertCount(SIN_REGISTRO)).toBe(0);
        // Presencia en el mismo canal: con un 200 el mismo contador SÍ da 1 (T-10a), así que este 0
        // no puede venir de un spy que no captura nada.
      },
    );

    // T-10d — HUECO DECLARADO, no un caso cubierto. Este camino responde 502 porque el body del
    // facilitator no trae una signature legible, PERO la tx pudo haberse broadcasteado igual. NO emite
    // la alerta a propósito: sin signature no se puede afirmar que hubo depósito, y una alerta que
    // afirma un depósito no verificado es peor que el silencio. Que nadie lea este 0 como "cubierto".
    it("T-10d (hueco declarado): ledger apagado + 200 SIN signature legible ⇒ 502 y 0 alertas", async () => {
      getLedgerMock.mockReturnValue(null);
      facilitatorResponds(200, { noSignature: true });
      const res = await POST(req(body()));
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "solana_settle_broadcast_failed" });
      expect(settleAlertCount(SIN_REGISTRO)).toBe(0);
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // WKH-347/AC-10 — LA CONSTANCIA DE SI EL DEPÓSITO REGISTRÓ EL ESCROW EN EL ÍNDICE
    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // ⚠️ EL NOMBRE LLEVA LA HU A PROPÓSITO: más arriba hay un describe llamado "AC-10 — alerta de
    // depósito sin registro (WKH-325)", y son ACs DISTINTOS de HUs DISTINTAS. Uno cuenta que el ledger
    // estaba apagado; éste cuenta que la transacción no registró el escrow en el índice on-chain.
    //
    // NC-8 se resolvió con la opción (c): el decode se izó fuera del `if (ledger)`, así que la
    // constancia sale con el ledger encendido Y apagado. Estos tests miden las dos configuraciones.
    describe("WKH-347/AC-10 — constancia del registro en el índice", () => {
      const SIN_INDICE = "solana_deposit_unindexed";
      const INDICE_ILEGIBLE = "solana_deposit_index_unreadable";

      // 🔴 T-347-18 — LOS DOS CASOS EN EL MISMO `it`, CON EL MISMO SPY Y EL MISMO CONTADOR (CD-13). Un
      // `toBe(0)` solo no probaría nada: podría estar mirando un canal que nunca se llena.
      it("T-347-18 (AC-10): tx de UNA ix ⇒ exactamente 1 constancia; tx de DOS ix ⇒ 0", async () => {
        // (1) UNA sola ix de negocio: el escrow quedó fuera del índice. Es el caso que se cuenta.
        getLedgerMock.mockReturnValue(null);
        facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
        expect((await POST(req(body()))).status).toBe(200);
        expect(settleAlertCount(SIN_INDICE)).toBe(1);
        // Y NO se emite el otro enum: "no quedó registrado" no puede salir como "no pude leer".
        expect(settleAlertCount(INDICE_ILEGIBLE)).toBe(0);
        // CD-7: sólo el remittanceId. Ni la signature, ni el sender, ni el monto.
        const call = errSpy.mock.calls.find((c) => String(c[0]).includes(SIN_INDICE));
        expect(call?.[1]).toEqual({ remittanceId: "rem-sol-1" });

        // (2) LAS DOS ix, en el orden de producción: la tx registró, así que NO hay nada que contar.
        errSpy.mockClear();
        facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
        const dos = await depositConRegisterTx(FAKE_SOLANA_REFERENCE);
        expect((await POST(req(body({ partialSignedTx: dos })))).status).toBe(200);
        expect(settleAlertCount(SIN_INDICE)).toBe(0);
        expect(settleAlertCount(INDICE_ILEGIBLE)).toBe(0);
      });

      // 🔴 LA MITAD QUE LA OPCIÓN (c) COMPRÓ: la constancia sale IGUAL con el ledger ENCENDIDO. Con la
      // opción (a) este caso habría dado 0 y el "exactamente una vez por 200" del AC sería falso en una
      // de las dos configuraciones.
      it("T-347-18 (NC-8/c): la constancia sale con el ledger ENCENDIDO igual que apagado", async () => {
        getLedgerMock.mockReturnValue(await ledgerWithPreparedSolana());
        facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
        expect((await POST(req(body()))).status).toBe(200);
        expect(settleAlertCount(SIN_INDICE)).toBe(1);
      });

      // 🔴 T-347-19 — EL GUARD NO SE PUEDE COMPARAR CONSIGO MISMO. El dato sale de los BYTES de la tx
      // firmada, nunca de un campo del body. Se manda un body que AFIRMA que se registró, con bytes de
      // UNA sola ix: la constancia tiene que salir igual. Si alguien alimentara este guard desde el
      // request, quien controla el request lo apagaría poniendo un campo.
      it("T-347-19 (AC-10/DT-8): un campo del body que dice 'registrado' NO apaga la constancia", async () => {
        getLedgerMock.mockReturnValue(null);
        facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
        const res = await POST(
          req(
            body({
              escrowIndexRegistered: true,
              registered: true,
              escrowIndexRegistration: "registered",
            }),
          ),
        );
        expect(res.status).toBe(200);
        expect(settleAlertCount(SIN_INDICE)).toBe(1); // los bytes mandan, no el body
      });

      // 🔴 LOS DOS DESENLACES SON DISTINGUIBLES, que es la condición que impide repetir el defecto de
      // colapsar "no pude preguntar" con "no". Acá la tx NO se puede deserializar, así que no se puede
      // afirmar que no registró: sale el OTRO enum.
      it("T-347-18 (AC-10): una tx ilegible NO se cuenta como 'no registró', sale su propio enum", async () => {
        getLedgerMock.mockReturnValue(null); // con el ledger apagado no hay 400: la route responde 200
        facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
        const res = await POST(req(body({ partialSignedTx: "AQIDBAUGBwg=" })));
        expect(res.status).toBe(200);
        expect(settleAlertCount(INDICE_ILEGIBLE)).toBe(1);
        // 🔴 Y ACÁ ESTÁ LA DISTINCIÓN, escrita como assert: NO sale el enum del hecho.
        expect(settleAlertCount(SIN_INDICE)).toBe(0);
      });

      // 🔴 NC-8, LA MITAD NEUTRAL: con el ledger APAGADO una tx ilegible sigue respondiendo 200, igual
      // que antes de esta HU. El `unreadable ⇒ 400` se quedó ADENTRO del `if (ledger)` a propósito, así
      // que izar el decode NO introdujo un 400 nuevo en el camino del flag apagado. Este test es lo que
      // mantiene cierta esa afirmación.
      it("NC-8: ledger APAGADO + tx ilegible ⇒ sigue siendo 200, NO un 400 nuevo", async () => {
        getLedgerMock.mockReturnValue(null);
        facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
        const res = await POST(req(body({ partialSignedTx: "AQIDBAUGBwg=" })));
        expect(res.status).toBe(200);
      });

      // 🔴 T-347-20 (R-2/CD-13) — EL ORDEN INVERTIDO, AL NIVEL DE LA ROUTE. Con `register_escrow` en la
      // posición 0, el lector server-side devuelve `unreadable` y la route corta con 400 ANTES del
      // forward: TODO depósito patrocinado falla en NUESTRO propio servidor, antes de que el facilitator
      // vea nada. Es el test que fija por qué la posición del `deposit` no se toca.
      // Corre con el ledger ENCENDIDO, porque el 400 vive adentro de ese `if`.
      it("T-347-20 (R-2/CD-13): `register_escrow` en la posición 0 ⇒ 400 solana_settle_deposit_unreadable", async () => {
        getLedgerMock.mockReturnValue(await ledgerWithPreparedSolana());
        facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
        const invertida = await depositConRegisterTx(FAKE_SOLANA_REFERENCE, true);
        const res = await POST(req(body({ partialSignedTx: invertida })));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "solana_settle_deposit_unreadable" });
        // Y no se forwardeó: la tx no se broadcasteó, así que la plata no salió.
        expect(fetchMock).not.toHaveBeenCalled();
        // CONTROL, sin el cual el 400 de arriba podría venir de cualquier cosa: la MISMA tx con el orden
        // CORRECTO responde 200 por el mismo camino.
        const correcta = await depositConRegisterTx(FAKE_SOLANA_REFERENCE);
        expect((await POST(req(body({ partialSignedTx: correcta })))).status).toBe(200);
      });
    });

    it("T-11b (AC-11/CD-1): el ledger devuelve un error de integridad ⇒ el sponsor responde 200 igual", async () => {
      const ledger = await ledgerWithPreparedSolana();
      vi.spyOn(ledger, "recordSolanaPrincipalIn").mockRejectedValue(
        new Error("ledger_record_solana_principal_in_failed:23514"),
      );
      getLedgerMock.mockReturnValue(ledger);
      facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
      const res = await POST(req(body()));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ signature: FAKE_SOLANA_SIGNATURE });
      // La excepción NO se silencia: se degrada a señal (el best-effort la traga y la grita).
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[ledger][ALERT]"))).toBe(true);
    });

    // ══ WKH-330 ══════════════════════════════════════════════════════════════════════════════════
    // Un 08006 (SQLSTATE clase 08 = connection exception) es, por CLASE, infra transitoria, y hasta
    // acá salía por console.warn. Pero cuando el que falla es recordSolanaPrincipalIn, el write que
    // no ocurrió viene DESPUÉS de un depósito real con signature verificada: la fila queda en
    // 'prepared', igual que una donde nunca entró nada.
    //
    // ⚠️ Lo que estos dos tests verifican es el CANAL y el CONTENIDO de una línea de log. NO
    // verifican que alguien se entere: no hay ninguna herramienta de observabilidad en este repo ni
    // ninguna regla sobre este prefijo. La línea queda encontrable con un grep, nada más.

    /** Llamadas a console.error con el prefijo del ledger Y el `op` pedido. Se filtra POR OP a
     *  propósito: contar todos los [ledger][ALERT] mezclaría ops distintos del mismo request. */
    const ledgerAlertCount = (op: string): number =>
      errSpy.mock.calls.filter(
        (c) => String(c[0]).includes("[ledger][ALERT]") && String(c[0]).includes(`${op}_failed`),
      ).length;
    /** Ídem sobre console.warn. NO se usa `expect(warnSpy).not.toHaveBeenCalled()`: eso es más fuerte
     *  que el AC y se rompería con cualquier warn ajeno del request. */
    const ledgerWarnCount = (op: string): number =>
      warnSpy.mock.calls.filter((c) => String(c[0]).includes(`${op}_failed`)).length;

    // T-330-1 (AC-1) — los DOS ops en el MISMO `it`, con los MISMOS dos contadores (CD-13). Así
    // ninguno de los cuatro números es un cero medido sobre un spy que no captura nada: cada contador
    // da 1 en una fase y 0 en la otra.
    it("T-330-1 (AC-1): 08006 en recordSolanaPrincipalIn ⇒ canal ERROR; el MISMO 08006 en listPreparedDepositAddresses sigue en WARN", async () => {
      // ── Fase A · control positivo del contador de warn (y de que la elevación NO es global) ──
      // listPreparedDepositAddresses NO está en ALWAYS_ALERT_OPS: su 08006 sigue siendo un warn.
      const ledgerA = await ledgerWithPreparedSolana();
      vi.spyOn(ledgerA, "listPreparedDepositAddresses").mockRejectedValue(
        new Error("ledger_list_prepared_deposit_addresses_failed:08006"),
      );
      getLedgerMock.mockReturnValue(ledgerA);
      facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
      expect((await POST(req(body()))).status).toBe(503);
      expect(ledgerWarnCount("listPreparedDepositAddresses")).toBe(1);
      expect(ledgerAlertCount("listPreparedDepositAddresses")).toBe(0);

      // ── Fase B · el caso de la HU ──
      errSpy.mockClear();
      warnSpy.mockClear();
      const ledgerB = await ledgerWithPreparedSolana();
      vi.spyOn(ledgerB, "recordSolanaPrincipalIn").mockRejectedValue(
        new Error("ledger_record_solana_principal_in_failed:08006"),
      );
      getLedgerMock.mockReturnValue(ledgerB);
      facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
      const res = await POST(req(body()));

      // AC-6/CD-2: el persist es best-effort. Sin este assert el test no distingue "gritó" de
      // "gritó y rompió el money-path".
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ signature: FAKE_SOLANA_SIGNATURE });

      expect(ledgerAlertCount("recordSolanaPrincipalIn")).toBe(1);
      expect(ledgerWarnCount("recordSolanaPrincipalIn")).toBe(0);
    });

    // T-330-2 (AC-2) — DESVÍO DECLARADO respecto de la letra del AC.
    // El AC pedía `toEqual({ remittanceId, signature })`. `toEqual` es igualdad EXACTA: para pasar,
    // el payload no podría tener ninguna otra clave, o sea que habría que BORRAR code/kind/severity/
    // message — que son el diagnóstico entero (sin `code` no se distingue un 08006, la red, de un
    // 23514, un bug nuestro). Sería una regresión de diagnóstico dentro de una HU de diagnóstico.
    // Se usa `toMatchObject` MÁS un `toEqual` sobre las CLAVES del payload, porque `toMatchObject`
    // deja de vigilar lo que NO está y `toEqual` lo vigilaba gratis: sin esa segunda mitad el desvío
    // debilitaría el AC en vez de corregirlo. La lista blanca es el reemplazo de lo que se perdió; la
    // lista negra de nombres, más abajo, es diagnóstico y no la sustituye (AR/BLQ-BAJO-2).
    // Refutación del desvío: escribir el `toEqual({ remittanceId, signature })` literal y ver que
    // sólo pasa si el payload pierde las cuatro claves de diagnóstico.
    // ⚠️ Lo que este `it` verifica es UNA corrida con UN error (`08006`): que en ESE payload el juego
    // de claves sea exactamente el previsto y que ningún valor sea la address del sender. NO es una
    // prueba de que `logLedgerWriteFailure` no pueda filtrar PII por otro call-site o con otro error.
    it("T-330-2 (AC-2): el payload de la alerta trae la signature y el remittanceId, conserva el diagnóstico, y sus claves son exactamente las seis previstas", async () => {
      const ledger = await ledgerWithPreparedSolana();
      vi.spyOn(ledger, "recordSolanaPrincipalIn").mockRejectedValue(
        new Error("ledger_record_solana_principal_in_failed:08006"),
      );
      getLedgerMock.mockReturnValue(ledger);
      facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
      expect((await POST(req(body()))).status).toBe(200);

      const call = errSpy.mock.calls.find(
        (c) =>
          String(c[0]).includes("[ledger][ALERT]") &&
          String(c[0]).includes("recordSolanaPrincipalIn_failed"),
      );
      expect(call).toBeDefined(); // sin esto, un `payload` undefined haría vacuos los asserts de abajo
      const payload = call?.[1] as Record<string, unknown>;

      // El espíritu de AC-2: la signature tiene que estar, porque es lo único que prueba el hecho
      // on-chain, y el remittanceId, que es el argumento del refund.
      expect(payload).toMatchObject({
        remittanceId: "rem-sol-1",
        signature: FAKE_SOLANA_SIGNATURE,
      });
      // El diagnóstico NO se perdió (esto es lo que el `toEqual` de la letra habría borrado).
      expect(payload).toMatchObject({ code: "08006", severity: "transient" });

      // CD-6 · ausencia de PII. 🔴 3er fix-pack (AR/BLQ-BAJO-2): la LISTA BLANCA es la mitad que
      // faltaba. §2.2 aprobó cambiar el `toEqual({remittanceId, signature})` de la letra de AC-2 por
      // `toMatchObject` CON LA CONDICIÓN de que un assert explícito devolviera lo que `toEqual`
      // vigilaba gratis: que ninguna clave IMPREVISTA entre al payload. Lo que se escribió primero fue
      // sólo una lista NEGRA de 7 nombres, y una lista negra no vigila lo que nadie enumeró.
      // 🟩 MEDIDO por el AR sobre `b0be6fd`: agregando `montoUsd: "1234.56", beneficiaryDoc: "12345678"`
      // a la correlación de solana-sponsor/route.ts:221, la suite quedaba `1391 passed`, EXIT=0 —
      // VERDE. El monto y el documento del beneficiario viajaban al log y nada se ponía rojo, contra
      // CD-6, que dice NUNCA montos ni beneficiary.
      // El payload que emite ledger-write-failure.ts:133 es `{ ...correlation, code, kind, severity,
      // message }`, así que ESTAS SEIS son todas las claves legítimas. Una clave nueva obliga a pasar
      // por acá, que es el punto: el assert no adivina si es PII, obliga a que alguien lo decida.
      expect(
        Object.keys(payload).sort(),
        "el payload de la alerta ganó o perdió una clave: si es nueva, nadie verificó que no sea PII (CD-6 prohíbe sender, montos y beneficiary), y este assert existe para que esa decisión no sea implícita",
      ).toEqual(["code", "kind", "message", "remittanceId", "severity", "signature"].sort());

      // Diagnóstico (NO reemplaza a la lista blanca de arriba): por CLAVE y por VALOR, nombra los
      // sospechosos concretos para que el rojo diga QUÉ se filtró y no sólo que algo cambió. El de
      // VALOR caza lo que ninguna lista de nombres puede: un `{ x: SENDER }` bajo cualquier clave.
      for (const k of [
        "senderAddress",
        "sender_address",
        "sender",
        "valueMinor",
        "value_minor",
        "beneficiary",
        "receiver_address",
      ]) {
        expect(Object.keys(payload)).not.toContain(k);
      }
      expect(JSON.stringify(payload)).not.toContain(SENDER);
      expect(String(call?.[0])).not.toContain(SENDER);
      // CD-6: la signature NO es PII — ya viaja al browser en la respuesta 200 de este mismo route.
      expect(SENDER).not.toBe(FAKE_SOLANA_SIGNATURE); // el assert de valor no es vacuo
    });
  });
});
