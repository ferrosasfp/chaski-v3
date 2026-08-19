// Tests — POST /api/kyc/verdict (WKH-333/AC-5, AC-6, AC-8, AC-11, AC-12, AC-13). El PoP corre REAL:
// challenge HMAC emitido con el mismo `issueSolanaPopChallenge` de la ruta /challenge y firma ed25519
// de verdad (tweetnacl con un Keypair). Cero red a Didit salvo donde se espía a propósito, cero DB.
//
// ⚠️ El doble del store FILTRA DE VERDAD por `senderAddress` (mini-store con DOS dueños, CD-17). Con
// un `vi.fn().mockResolvedValue(fila)` los tests de aislamiento pasarían igual con el guard borrado:
// aprobarían desde arriba sin mirar los argumentos.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import type { KycVerdictRecord } from "../../../../src/application/ports";
import {
  buildSolanaPopMessage,
  issueSolanaPopChallenge,
} from "../../../../src/infrastructure/auth/pop-challenge";

// Rate-limit: los tests no fijan env de Upstash (fail-closed → 503). Mock a { ok:true } por default.
const { checkRouteRateLimitMock } = vi.hoisted(() => ({ checkRouteRateLimitMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/rate-limit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/infrastructure/rate-limit")>();
  return { ...actual, checkRouteRateLimit: checkRouteRateLimitMock };
});

// Store: null por default (flag OFF ⇒ 501); los tests lo apuntan al mini-store honesto.
const { getStoreMock } = vi.hoisted(() => ({ getStoreMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/persistence/supabase-kyc-verdicts", () => ({
  getKycVerdictStore: getStoreMock,
}));

// Autoridad de KYC: es la que el backfill consulta. Espiada para poder afirmar que NO se llama.
const { authorityMock } = vi.hoisted(() => ({ authorityMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/payout/authority", () => ({
  resolvePayoutAuthority: authorityMock,
}));

import { POST } from "./route";

// Seeds FIJAS (no Keypair.generate): las addresses son reproducibles corrida a corrida.
const KP_A = Keypair.fromSeed(new Uint8Array(32).fill(11));
const KP_B = Keypair.fromSeed(new Uint8Array(32).fill(22));
const SENDER_A = KP_A.publicKey.toBase58();
const SENDER_B = KP_B.publicKey.toBase58();
const SECRET = "test-pop-secret";

const NOW = Date.parse("2026-08-07T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW - n * DAY_MS).toISOString();

/** El `verification_id` sembrado. Ninguna respuesta puede contenerlo (T-EP-15). */
const SEEDED_VID = "did-secreto-de-A-0123456789";

function verdict(over: Partial<KycVerdictRecord> = {}): KycVerdictRecord {
  return {
    senderAddress: SENDER_A,
    verificationId: SEEDED_VID,
    approved: true,
    riskLevel: "low",
    provenance: "didit",
    verifiedAt: daysAgo(10),
    ...over,
  };
}

/** Mini-store HONESTO: filtra por senderAddress como lo hace el `.eq(...)` de Postgres. Si el
 *  handler pasara `body.sender` (o una address fija), la respuesta traería la fila del otro dueño. */
function honestStore(rows: KycVerdictRecord[], opts: { readThrows?: boolean } = {}) {
  const put = vi.fn(async (r: KycVerdictRecord) => {
    const i = rows.findIndex((x) => x.senderAddress === r.senderAddress);
    if (i >= 0) {
      rows[i] = r;
      return "replaced" as const;
    }
    rows.push(r);
    return "inserted" as const;
  });
  const get = vi.fn(async (sender: string) => {
    if (opts.readThrows) throw new Error("kyc_verdict_read_failed:42P01");
    return rows.find((r) => r.senderAddress === sender) ?? null;
  });
  return { get, put, rows };
}

/** Challenge REAL + firma ed25519 REAL. `challengeFor` permite emitir el challenge de una wallet y
 *  presentarlo como si fuera de otra. */
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
  return new Request("http://localhost/api/kyc/verdict", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("POST /api/kyc/verdict (WKH-333)", () => {
  beforeEach(() => {
    vi.stubEnv("PAYOUT_POP_SECRET", SECRET);
    delete process.env.KYC_VERDICT_TTL_DAYS;
    checkRouteRateLimitMock.mockReset();
    checkRouteRateLimitMock.mockResolvedValue({ ok: true });
    getStoreMock.mockReset();
    getStoreMock.mockReturnValue(null); // default: flag OFF
    authorityMock.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete process.env.KYC_VERDICT_TTL_DAYS;
  });

  // ── T-EP-1 ───────────────────────────────────────────────────────────────────────────────────
  it("T-EP-1: sin PAYOUT_POP_SECRET ⇒ 503, sin tocar el rate-limit ni construir el store", async () => {
    const proof = realPop(KP_A);
    vi.stubEnv("PAYOUT_POP_SECRET", "");
    getStoreMock.mockReturnValue(honestStore([verdict()]));
    const res = await POST(req({ sender: SENDER_A, ...proof }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "kyc_verdict_unavailable" });
    expect(
      checkRouteRateLimitMock,
      "se gastó presupuesto del limiter en un endpoint que no puede verificar nada",
    ).not.toHaveBeenCalled();
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  // ── T-EP-2 ───────────────────────────────────────────────────────────────────────────────────
  it("T-EP-2: rate-limit excedido ⇒ 429 con Retry-After, ANTES de parsear el body", async () => {
    checkRouteRateLimitMock.mockResolvedValue({ ok: false, retryAfter: 42 });
    getStoreMock.mockReturnValue(honestStore([verdict()]));
    // Body deliberadamente ilegible: si el parseo corriera antes, esto sería 400, no 429.
    const res = await POST(
      new Request("http://localhost/api/kyc/verdict", { method: "POST", body: "{no-json" }),
    );
    expect(
      res.status,
      "el limiter corre después de parsear/verificar: el HMAC + ed25519 de abajo es CPU, y sin " +
        "límite eso es un DoS que cuesta un `curl`",
    ).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  it("T-EP-2b: limiter `unavailable` ⇒ 503 fail-closed (nunca fail-open)", async () => {
    checkRouteRateLimitMock.mockResolvedValue({ unavailable: true });
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(res.status).toBe(503);
  });

  // ── T-EP-3 — AC-5: los CINCO fallos del PoP son indistinguibles entre sí ─────────────────────
  it("T-EP-3: los 5 fallos del PoP dan el MISMO status y el MISMO cuerpo, comparados entre sí (M-4)", async () => {
    getStoreMock.mockReturnValue(honestStore([verdict()]));
    const good = realPop(KP_A);
    const chOfB = realPop(KP_B); // challenge y firma de OTRA wallet

    const inputs: Array<[string, unknown]> = [
      ["P1 · sin popChallenge/popSignature", { sender: SENDER_A }],
      ["P2 · challenge con HMAC roto", { sender: SENDER_A, popChallenge: "no-es-un-token", popSignature: good.popSignature }],
      ["P3 · challenge de OTRA wallet", { sender: SENDER_A, popChallenge: chOfB.popChallenge, popSignature: chOfB.popSignature }],
      ["P4 · network-id que no es el del server", { sender: SENDER_A, popChallenge: issueSolanaPopChallenge({ address: SENDER_A, networkId: "solana:mainnet", nonce: "0123456789abcdef0123456789abcdef", exp: Math.floor(Date.now() / 1000) + 300 }), popSignature: good.popSignature }],
      ["P5 · firma que no verifica", { sender: SENDER_A, popChallenge: good.popChallenge, popSignature: bs58.encode(new Uint8Array(64).fill(7)) }],
    ];

    const seen: Array<{ label: string; status: number; body: string }> = [];
    for (const [label, payload] of inputs) {
      const res = await POST(req(payload));
      seen.push({ label, status: res.status, body: await res.text() });
    }
    const first = seen[0];
    if (!first) throw new Error("no se ejercitó ningún fallo del PoP");
    for (const s of seen) {
      expect(
        { status: s.status, body: s.body },
        `el fallo "${s.label}" del PoP se distingue de "${first.label}": cada diferencia le dice a ` +
          "un desconocido en qué paso falló, y eso es un mapa para forjar la prueba de posesión",
      ).toEqual({ status: first.status, body: first.body });
    }
    expect(first.status).toBe(403);
    expect(JSON.parse(first.body)).toEqual({ error: "kyc_verdict_unverified" });
  });

  // ── T-EP-4 — CD-6: el flag NO puede ser un sensor para un anónimo ───────────────────────────
  it("T-EP-4: flag OFF + caller SIN PoP ⇒ 403, nunca 501 (M-3)", async () => {
    getStoreMock.mockReturnValue(null); // flag OFF
    const res = await POST(req({ sender: SENDER_A }));
    expect(
      res.status,
      "el chequeo del store corre antes del PoP: un anónimo distingue 'la tabla está apagada' de " +
        "'está encendida y no sos vos', que es medio oráculo gratis",
    ).toBe(403);
    expect(await res.json()).toEqual({ error: "kyc_verdict_unverified" });
  });

  it("T-EP-4b: flag OFF + PoP VÁLIDO ⇒ 501 (AC-12: con el flag apagado no hay veredicto server-side)", async () => {
    getStoreMock.mockReturnValue(null);
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "kyc_verdict_not_enabled" });
  });

  // ── T-EP-5 — body ilegible ──────────────────────────────────────────────────────────────────
  it("T-EP-5: `sender` no canonicalizable ⇒ 400, sin tocar el store", async () => {
    getStoreMock.mockReturnValue(honestStore([verdict()]));
    const res = await POST(req({ sender: "no-es-base58-de-32-bytes", ...realPop(KP_A) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "kyc_verdict_invalid_request" });
    expect(getStoreMock).not.toHaveBeenCalled();
  });

  // ── T-EP-6 — CD-18: la base se consulta con ch.address, NUNCA con body.sender ────────────────
  it("T-EP-6: PoP de A presentado con `sender` = B ⇒ 403 y la base NO se toca (M-1, M-2)", async () => {
    const store = honestStore([verdict({ senderAddress: SENDER_A }), verdict({ senderAddress: SENDER_B, verificationId: "did-de-B" })]);
    getStoreMock.mockReturnValue(store);
    const res = await POST(req({ sender: SENDER_B, ...realPop(KP_A) }));
    expect(res.status).toBe(403);
    expect(
      store.get,
      "se leyó la base con una dirección que el caller no probó poseer: eso es exactamente el IDOR " +
        "que el PoP existe para cerrar",
    ).not.toHaveBeenCalled();
  });

  it("T-EP-6b: con PoP de A, la lectura se hace con la address de A (no con body.sender)", async () => {
    // `sender` en el body es el MISMO que el del challenge (si no, P3 corta). Lo que se afirma acá es
    // el VALOR con el que se consultó, que es lo que un guard que se compara consigo mismo perdería.
    const store = honestStore([verdict({ senderAddress: SENDER_B, verificationId: "did-de-B" })]);
    getStoreMock.mockReturnValue(store);
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(store.get).toHaveBeenCalledWith(SENDER_A);
    expect(
      await res.json(),
      "el veredicto de A salió de la fila de B: el filtro por dueño no aisló nada",
    ).toEqual({ verdict: null, reason: "absent" });
  });

  // ── T-EP-7 — camino feliz ───────────────────────────────────────────────────────────────────
  it("T-EP-7: fila vigente, aprobada y real ⇒ 200 con riskLevel/provenance/verifiedAt", async () => {
    getStoreMock.mockReturnValue(honestStore([verdict()]));
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      verdict: { riskLevel: "low", provenance: "didit", verifiedAt: daysAgo(10) },
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // ── T-EP-8 — AC-2: vigencia AL LEER ─────────────────────────────────────────────────────────
  it("T-EP-8: fila de hace 366 días ⇒ verdict null, reason 'expired' (M-5)", async () => {
    getStoreMock.mockReturnValue(honestStore([verdict({ verifiedAt: daysAgo(366) })]));
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(
      await res.json(),
      "un veredicto de hace más de un año se devolvió como utilizable: la persona pagaría hoy con " +
        "una verificación de identidad que ya nadie revisó",
    ).toEqual({ verdict: null, reason: "expired" });
  });

  // ── T-EP-9 — 🔴 REESCRITO POR WKH-233, Y LA CONSECUENCIA VA DICHA ────────────────────────────────
  //
  // ⚠️ ESTOS DOS `it` AFIRMABAN `reason: "simulated"`, Y ESE MOTIVO YA NO EXISTE. Desde WKH-233 la
  // fila se escribe SÓLO cuando el agente devuelve `payoutAllowed === true`, y ese booleano ya exige
  // que la proveniencia esté en SU allow-list de verificaciones reales ⇒ **una fila que existe es,
  // por invariante, real**, y ningún código puede producir ya ese motivo.
  //
  // LO QUE SE PIERDE, y no se disimula: una verificación simulada deja de producir fila, así que este
  // endpoint responde `absent` donde antes respondía `simulated`. Se pierde poder decir "preguntamos
  // y era una demo". Se conserva la distinción que sostiene el tipo (`usable`/`absent`/`not_asked`),
  // que es la que impide usar `usable` como default de "no pude preguntar".
  //
  // LO QUE MIDEN AHORA: que la proveniencia CRUDA viaja tal cual y que este endpoint NO la juzga.
  // Juzgarla acá volvería a poner el criterio del proveedor dentro de Chaski, que es lo que se borró.
  it("T-EP-9: una proveniencia simulada viaja CRUDA — este endpoint ya no la juzga (WKH-233/D-3)", async () => {
    getStoreMock.mockReturnValue(honestStore([verdict({ provenance: "didit-mock" })]));
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    const body = (await res.json()) as { verdict: { provenance: string } };
    expect(
      body.verdict.provenance,
      "el endpoint reescribió o filtró la proveniencia: el consumidor necesita el valor CRUDO para " +
        "poder decir de dónde salió, y juzgarlo acá reintroduce la allow-list local que se borró",
    ).toBe("didit-mock");
  });

  it("T-EP-9b: una proveniencia DESCONOCIDA también viaja cruda (no se normaliza ni se descarta)", async () => {
    getStoreMock.mockReturnValue(honestStore([verdict({ provenance: "proveedor-nuevo-2027" })]));
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    const body = (await res.json()) as { verdict: { provenance: string } };
    expect(body.verdict.provenance).toBe("proveedor-nuevo-2027");
  });


  // ── T-EP-10 ─────────────────────────────────────────────────────────────────────────────────
  it("T-EP-10: approved:false ⇒ reason 'not_approved' (M-6)", async () => {
    getStoreMock.mockReturnValue(honestStore([verdict({ approved: false })]));
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(
      await res.json(),
      "una verificación RECHAZADA se devolvió como utilizable: la columna `approved` no la lee nadie",
    ).toEqual({ verdict: null, reason: "not_approved" });
  });

  // ── T-EP-11/12/13 — el backfill (AC-8, CD-24) ───────────────────────────────────────────────
  it("T-EP-11: autoridad NEGATIVA ⇒ NO escribe (M-9)", async () => {
    const store = honestStore([]);
    getStoreMock.mockReturnValue(store);
    authorityMock.mockResolvedValue({ authorized: false, reason: "kyc_not_approved", httpStatus: 200 });
    const res = await POST(
      req({ sender: SENDER_A, ...realPop(KP_A), candidateVerificationId: "did-del-navegador" }),
    );
    expect(
      store.put,
      "se persistió un veredicto sin que la autoridad lo confirmara: el booleano del localStorage " +
        "es atacante-controlable, así que cualquiera se escribiría una verificación aprobada",
    ).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ verdict: null, reason: "absent" });
  });

  it("T-EP-12: autoridad POSITIVA ⇒ escribe con la dirección PoP-verificada y devuelve 200", async () => {
    const store = honestStore([]);
    getStoreMock.mockReturnValue(store);
    authorityMock.mockResolvedValue({
      authorized: true,
      httpStatus: 200,
      provenance: "didit",
      riskLevel: "medium",
    });
    const res = await POST(
      req({ sender: SENDER_A, ...realPop(KP_A), candidateVerificationId: "did-del-navegador" }),
    );
    expect(authorityMock).toHaveBeenCalledWith({
      verificationId: "did-del-navegador",
      address: SENDER_A, // ← la PoP-verificada, nunca un valor del body
    });
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.rows[0]?.senderAddress).toBe(SENDER_A);
    expect(store.rows[0]?.verificationId).toBe("did-del-navegador");
    const body = await res.json();
    expect(body.verdict.riskLevel).toBe("medium");
    expect(body.verdict.provenance).toBe("didit");
  });

  it("T-EP-13: autoridad `simulated_dev` ⇒ NO escribe (M-8)", async () => {
    const store = honestStore([]);
    getStoreMock.mockReturnValue(store);
    authorityMock.mockResolvedValue({
      authorized: true,
      reason: "simulated_dev",
      httpStatus: 200,
      provenance: "didit-mock",
      riskLevel: "low",
    });
    const res = await POST(
      req({ sender: SENDER_A, ...realPop(KP_A), candidateVerificationId: "did-cualquiera" }),
    );
    expect(
      store.put,
      "la rama que autoriza SIN consultar a Didit dejó una fila escrita: con el flag encendido esa " +
        "fila es la fuente de autoridad de un pago real",
    ).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ verdict: null, reason: "absent" });
  });

  it("T-EP-13b: autoriza pero SIN provenance declarada ⇒ NO escribe (CD-24)", async () => {
    const store = honestStore([]);
    getStoreMock.mockReturnValue(store);
    authorityMock.mockResolvedValue({ authorized: true, httpStatus: 200 });
    await POST(req({ sender: SENDER_A, ...realPop(KP_A), candidateVerificationId: "did-x" }));
    expect(store.put).not.toHaveBeenCalled();
  });

  it("T-EP-14: SIN candidateVerificationId no se consulta a la autoridad (no se gasta cupo)", async () => {
    const store = honestStore([]);
    getStoreMock.mockReturnValue(store);
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(authorityMock).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ verdict: null, reason: "absent" });
  });

  it("T-EP-14b: con fila EXISTENTE no se consulta a la autoridad (el backfill es sólo para el hueco)", async () => {
    getStoreMock.mockReturnValue(honestStore([verdict()]));
    await POST(req({ sender: SENDER_A, ...realPop(KP_A), candidateVerificationId: "did-x" }));
    expect(authorityMock).not.toHaveBeenCalled();
  });

  // ── T-EP-15 — AC-6: el identificador NO SALE NUNCA ──────────────────────────────────────────
  it("T-EP-15: NINGÚN cuerpo, en NINGUNA rama, contiene el verification_id (M-22)", async () => {
    const bodies: string[] = [];
    const good = realPop(KP_A);

    // 200 con fila utilizable
    getStoreMock.mockReturnValue(honestStore([verdict()]));
    bodies.push(await (await POST(req({ sender: SENDER_A, ...good }))).text());
    // 200 vencida
    getStoreMock.mockReturnValue(honestStore([verdict({ verifiedAt: daysAgo(400) })]));
    bodies.push(await (await POST(req({ sender: SENDER_A, ...good }))).text());
    // 200 simulada
    getStoreMock.mockReturnValue(honestStore([verdict({ provenance: "didit-mock" })]));
    bodies.push(await (await POST(req({ sender: SENDER_A, ...good }))).text());
    // 200 no aprobada
    getStoreMock.mockReturnValue(honestStore([verdict({ approved: false })]));
    bodies.push(await (await POST(req({ sender: SENDER_A, ...good }))).text());
    // 403 sin PoP
    bodies.push(await (await POST(req({ sender: SENDER_A }))).text());
    // 502 lectura rota
    getStoreMock.mockReturnValue(honestStore([verdict()], { readThrows: true }));
    bodies.push(await (await POST(req({ sender: SENDER_A, ...good }))).text());
    // 501 flag OFF
    getStoreMock.mockReturnValue(null);
    bodies.push(await (await POST(req({ sender: SENDER_A, ...good }))).text());
    // 200 recién backfilleada
    const store = honestStore([]);
    getStoreMock.mockReturnValue(store);
    authorityMock.mockResolvedValue({ authorized: true, httpStatus: 200, provenance: "didit", riskLevel: "low" });
    bodies.push(
      await (await POST(req({ sender: SENDER_A, ...good, candidateVerificationId: SEEDED_VID }))).text(),
    );

    expect(bodies.length).toBe(8);
    for (const b of bodies) {
      expect(
        b,
        "el `verification_id` salió en una respuesta HTTP: es la credencial con la que el backend " +
          "autoriza un desembolso, y devolverla la vuelve otra vez un token al portador — que es " +
          "exactamente lo que esta HU vino a sacar de la red",
      ).not.toContain(SEEDED_VID);
    }
  });

  // ── T-EP-16 — AC-4 tras el PoP ──────────────────────────────────────────────────────────────
  it("T-EP-16: TTL malformado ⇒ 503 misconfigured, y DESPUÉS del PoP", async () => {
    process.env.KYC_VERDICT_TTL_DAYS = "365 días";
    getStoreMock.mockReturnValue(honestStore([verdict()]));
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "kyc_verdict_misconfigured" });
    // Sin PoP el mismo request da 403, no 503: la misconfiguración no es un sensor para un anónimo.
    const anon = await POST(req({ sender: SENDER_A }));
    expect(anon.status).toBe(403);
  });

  // ── T-EP-17 — la lectura rota no es un 500 crudo ────────────────────────────────────────────
  it("T-EP-17: Postgres falla ⇒ 502 con enum opaco, sin ecoar el SQLSTATE al cliente", async () => {
    getStoreMock.mockReturnValue(honestStore([verdict()], { readThrows: true }));
    const res = await POST(req({ sender: SENDER_A, ...realPop(KP_A) }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "kyc_verdict_unavailable" });
    expect(text, "se ecoó el SQLSTATE de Postgres al cliente").not.toContain("42P01");
  });
});
