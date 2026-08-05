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
    beforeEach(() => {
      errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });
    /** Alertas del settle emitidas hasta acá. LA MISMA función cuenta los casos de 1 y los de 0
     *  (CD-13): un `toBe(0)` sobre un spy vacío mediría cero y pasaría sin decir nada. */
    const settleAlertCount = (): number =>
      errSpy.mock.calls.filter((c) => String(c[0]).includes("[settle][ALERT]")).length;

    // T-10a — los DOS casos en el MISMO `it`, con el MISMO spy y el MISMO contador.
    it("T-10a (CD-13): ledger apagado + 200 ⇒ 1 alerta; ledger encendido + 200 ⇒ 0", async () => {
      getLedgerMock.mockReturnValue(null);
      facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
      expect((await POST(req(body()))).status).toBe(200);
      expect(settleAlertCount()).toBe(1);

      errSpy.mockClear();
      getLedgerMock.mockReturnValue(await ledgerWithPreparedSolana());
      facilitatorResponds(200, { signature: FAKE_SOLANA_SIGNATURE });
      expect((await POST(req(body()))).status).toBe(200);
      expect(settleAlertCount()).toBe(0);
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
        expect(settleAlertCount()).toBe(0);
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
      expect(settleAlertCount()).toBe(0);
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
  });
});
