import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock del helper de rate-limit → controlamos el veredicto sin Upstash real.
const { rlMock } = vi.hoisted(() => ({ rlMock: vi.fn() }));
vi.mock("../../../../src/infrastructure/rate-limit", () => ({ checkKycRateLimit: rlMock }));

import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import {
  buildSolanaPopMessage,
  issueSolanaPopChallenge,
} from "../../../../src/infrastructure/auth/pop-challenge";
import { POST } from "./route";

const DIDIT_OK = { session_id: "s1", url: "https://verify.didit.me/session/s1", session_token: "didit-tok" };

// WKH-333/R-1 — la ruta pasa a exigir prueba de posesión de la billetera. Seeds FIJAS: las addresses
// son reproducibles corrida a corrida, así una mutación que hardcodee un valor se puede escribir y
// verificar sin adivinar.
const KP_A = Keypair.fromSeed(new Uint8Array(32).fill(11));
const KP_B = Keypair.fromSeed(new Uint8Array(32).fill(22));
const ADDR_A = KP_A.publicKey.toBase58();
const ADDR_B = KP_B.publicKey.toBase58();
const POP_SECRET = "test-pop-secret";

/** Challenge REAL (HMAC de verdad) + firma ed25519 REAL. `challengeFor` permite emitir el challenge
 *  de una billetera y presentarlo como si fuera de otra. */
function realPop(signer: Keypair, challengeFor: Keypair = signer) {
  const ch = {
    address: challengeFor.publicKey.toBase58(),
    networkId: "solana:devnet",
    nonce: "0123456789abcdef0123456789abcdef",
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const popChallenge = issueSolanaPopChallenge(ch);
  const popSignature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(buildSolanaPopMessage(ch)), signer.secretKey),
  );
  return { popChallenge, popSignature };
}

/** Lee el body que se le mandó a Didit en la llamada `n`. Existe para no repetir `calls[0]![1]!` en
 *  cada aserto: el `!` es la única forma que TypeScript acepta ahí (el `?.` encadenado dispara
 *  `noUnsafeOptionalChaining`, que en este repo es ERROR de lint, no warning). Concentrarlo en un
 *  solo lugar deja los casos legibles y el lint quieto. */
function sentToDidit(m: { mock: { calls: unknown[][] } }, n = 0): Record<string, unknown> {
  const call = m.mock.calls[n];
  if (!call) throw new Error("no hubo llamada a Didit");
  const init = call[1] as RequestInit | undefined;
  if (!init?.body) throw new Error("la llamada a Didit no llevó body");
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function req(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/kyc/session", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
    body: JSON.stringify(body),
  });
}

function reqWithHeaders(headers: Record<string, string>, body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/kyc/session", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  rlMock.mockReset();
  rlMock.mockResolvedValue({ ok: true });
  vi.stubEnv("DIDIT_API_KEY", "test-key");
  vi.stubEnv("DIDIT_WORKFLOW_ID", "wf-1");
  vi.stubEnv("KYC_SESSION_SECRET", "test-secret-123");
  vi.stubEnv("KYC_CALLBACK_BASE_URL", "");
  // WKH-333/R-1: la ruta exige PoP. Sin el secreto responde 503 fail-closed, así que los casos que
  // llegan a Didit tienen que presentarlo.
  vi.stubEnv("PAYOUT_POP_SECRET", POP_SECRET);
  // Ambiente de Didit declarado (fail-closed): sin esto la ruta corta en 500 didit_env_misconfigured
  // antes del rate-limit. Además BLINDA contra un DIDIT_ENV=live exportado en la shell/CI: un test
  // jamás debe poder resolver el host REAL de Didit (crea verificaciones con PII).
  vi.stubEnv("DIDIT_ENV", "mock");
  vi.stubEnv("DIDIT_BASE_URL", "http://localhost:9999/didit-mock");
});

describe("POST /api/kyc/session — guard-order + rate-limit + callback + token (WKH-179)", () => {
  it("sin DIDIT_API_KEY → 501, rate-limit NO invocado (AC-4)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req());
    expect(res.status).toBe(501);
    expect(rlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DIDIT_API_KEY sin KYC_SESSION_SECRET → 500 (CD-7)", async () => {
    vi.stubEnv("KYC_SESSION_SECRET", "");
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("rate-limit consultado ANTES del fetch a Didit (AC-5, CD-2)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    await POST(req({ vendorData: "0xabc" }));
    expect(rlMock).toHaveBeenCalledWith({ ip: "9.9.9.9", address: "0xabc" });
  });

  it("IP viene de x-vercel-forwarded-for (fuente confiable de Vercel); XFF malicioso se ignora (MNR-1)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    // Atacante intenta forjar el leftmost del XFF; Vercel inyecta la IP real en x-vercel-forwarded-for.
    await POST(
      reqWithHeaders(
        { "x-vercel-forwarded-for": "5.5.5.5", "x-forwarded-for": "1.1.1.1, 6.6.6.6" },
        { vendorData: "0xabc" },
      ),
    );
    expect(rlMock).toHaveBeenCalledWith({ ip: "5.5.5.5", address: "0xabc" });
  });

  it("IP cae a x-real-ip cuando no hay x-vercel-forwarded-for; XFF forjado no la cambia (MNR-1)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    await POST(reqWithHeaders({ "x-real-ip": "7.7.7.7", "x-forwarded-for": "1.2.3.4" }));
    expect(rlMock).toHaveBeenCalledWith({ ip: "7.7.7.7", address: undefined });
  });

  it("sin headers de Vercel → XFF como último recurso toma el valor MÁS A LA DERECHA, no el leftmost (MNR-1)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    // 1.1.1.1 lo puede forjar el cliente; 8.8.8.8 (rightmost) lo agrega el proxy de confianza.
    await POST(reqWithHeaders({ "x-forwarded-for": "1.1.1.1, 8.8.8.8" }));
    expect(rlMock).toHaveBeenCalledWith({ ip: "8.8.8.8", address: undefined });
  });

  it("limiter ok:false → 429 + Retry-After, fetch NO llamado (AC-6, AC-7)", async () => {
    rlMock.mockResolvedValue({ ok: false, retryAfter: 42 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Upstash ausente (unavailable) → 503 fail-closed, fetch NO llamado (AC-6)", async () => {
    rlMock.mockResolvedValue({ ok: false, unavailable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "rate_limit_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("body.callback IGNORADO; a Didit va el callback server-side (AC-8, AC-9, M6)", async () => {
    vi.stubEnv("KYC_CALLBACK_BASE_URL", "https://chaski.app");
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      void init;
      return { ok: true, json: async () => DIDIT_OK };
    });
    vi.stubGlobal("fetch", fetchMock);
    // ⚠️ CAMBIÓ EN WKH-333: este caso ahora presenta un PoP válido, porque sin él la ruta corta en
    // 403 antes del fetch. Lo que el test mide —que `body.callback` se ignora— no cambió.
    await POST(req({ callback: "http://evil.com", vendorData: "0xabc", ...realPop(KP_A) }));
    const sentBody = sentToDidit(fetchMock);
    expect(sentBody.callback).toBe("https://chaski.app/kyc/callback");
    expect(JSON.stringify(sentBody)).not.toContain("evil");
  });

  it("sin KYC_CALLBACK_BASE_URL → callback undefined (nunca body.callback, AC-9)", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      void init;
      return { ok: true, json: async () => DIDIT_OK };
    });
    vi.stubGlobal("fetch", fetchMock);
    await POST(req({ callback: "http://evil.com", ...realPop(KP_A) }));
    const sentBody = sentToDidit(fetchMock);
    expect(sentBody.callback).toBeUndefined();
    expect(JSON.stringify(sentBody)).not.toContain("evil");
  });

  it("éxito → 200 con authToken (nuestro) + sessionToken (de Didit), distintos (CD-10)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc", ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; sessionToken: string; authToken: string };
    expect(body.sessionId).toBe("s1");
    expect(body.sessionToken).toBe("didit-tok");
    expect(typeof body.authToken).toBe("string");
    expect(body.authToken).not.toBe(body.sessionToken);
  });

  // ── Ambiente de Didit: fail-closed (elimina el default productivo) ──────────
  it("key + workflow válidos + SIN DIDIT_ENV → 500 didit_env_misconfigured y NO se crea sesión en Didit", async () => {
    vi.stubEnv("DIDIT_ENV", undefined);
    vi.stubEnv("DIDIT_BASE_URL", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc" }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "didit_env_misconfigured" });
    // EL assert que importa: esta ruta CREA verificaciones de identidad. Sin ambiente declarado no
    // sale ni un request. Antes de este fix, acá se creaba una sesión REAL en producción de Didit.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("DIDIT_ENV=mock + DIDIT_BASE_URL → el fetch va al MOCK, nunca al host de Didit", async () => {
    // El `_url: string` NO es decorativo: sin parámetro declarado, `mock.calls` se tipa como `[]`
    // y `calls[0][0]` no compila con strict (TS2493).
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => DIDIT_OK }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(req({ vendorData: "0xabc", ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe("http://localhost:9999/didit-mock/v3/session/");
    expect(url).not.toContain("didit.me");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-333/R-1 — la sesión de KYC se ata a una dirección PROBADA (AC-19, CD-29)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// El daño que esto cierra: `vendor_data` salía del body, así que cualquiera podía crear una sesión de
// verificación a nombre de la dirección de OTRA persona y aprobarla con su propio documento. Didit
// ecoa esa dirección y la route de decisión escribe la fila del veredicto con ella. Mientras el pago
// usaba el identificador guardado en el navegador de cada uno, esa fila ajena era inerte; con el
// veredicto server-side, esa fila ES la fuente de autoridad del pago.
describe("POST /api/kyc/session — el vendor_data sale del PoP, no del body (WKH-333/R-1)", () => {
  function fetchOk() {
    const m = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return { ok: true, json: async () => DIDIT_OK };
    });
    vi.stubGlobal("fetch", m);
    return m;
  }

  // ── T-SE-1 — AC-12: el demo queda byte-idéntico ────────────────────────────────────────────────
  it("T-SE-1: sin DIDIT_API_KEY ⇒ 501 ANTES del PoP (el demo no pide una firma nueva) (M-33b)", async () => {
    vi.stubEnv("DIDIT_API_KEY", "");
    const fetchMock = fetchOk();
    const res = await POST(req({ vendorData: ADDR_A })); // SIN PoP, como el demo de hoy
    expect(
      res.status,
      "el bloque de prueba de posesión se movió antes del 501: el demo local, que hoy no pide " +
        "ninguna firma de billetera, empezaría a exigir una",
    ).toBe(501);
    expect(rlMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── T-SE-2 — AC-19 / M-33 ─────────────────────────────────────────────────────────────────────
  it("T-SE-2: con key y SIN PoP ⇒ 403 kyc_session_unverified, y NO se crea sesión en Didit", async () => {
    const fetchMock = fetchOk();
    const res = await POST(req({ vendorData: ADDR_A }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "kyc_session_unverified" });
    expect(
      fetchMock,
      "se creó una verificación de identidad REAL atada a una dirección que nadie probó poseer",
    ).not.toHaveBeenCalled();
  });

  // ── T-SE-3 — AC-19 / M-32: EL CASO DEL ATAQUE ─────────────────────────────────────────────────
  it("T-SE-3: PoP de A + `vendorData` de B ⇒ a Didit va la dirección de A (M-32)", async () => {
    const fetchMock = fetchOk();
    const res = await POST(req({ vendorData: ADDR_B, ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    const sent = sentToDidit(fetchMock) as unknown as { vendor_data: string };
    expect(
      sent.vendor_data,
      "la sesión quedó atada a la dirección que vino en el body: quien la mande puede hacer que la " +
        "fila del veredicto de OTRA persona quede a su nombre, y esa fila es la que autoriza el pago",
    ).toBe(ADDR_A);
    expect(sent.vendor_data).not.toBe(ADDR_B);
  });

  it("T-SE-3b: sin `vendorData` en el body, a Didit va igual la dirección probada", async () => {
    const fetchMock = fetchOk();
    const res = await POST(req({ ...realPop(KP_A) }));
    expect(res.status).toBe(200);
    const sent = sentToDidit(fetchMock) as unknown as { vendor_data: string };
    expect(sent.vendor_data).toBe(ADDR_A);
  });

  it("T-SE-3c: un challenge de A firmado por B ⇒ 403 (la firma es lo que ata, no el token)", async () => {
    const fetchMock = fetchOk();
    // `realPop(KP_B, KP_A)`: el challenge dice A, pero lo firma B.
    const res = await POST(req({ vendorData: ADDR_A, ...realPop(KP_B, KP_A) }));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── T-SE-4 — M-33c: el limiter sigue ANTES del cripto ─────────────────────────────────────────
  it("T-SE-4: el rate-limit corre ANTES del PoP (CPU-DoS) (M-33c)", async () => {
    rlMock.mockResolvedValue({ ok: false, retryAfter: 42 });
    const fetchMock = fetchOk();
    // Body SIN PoP: si el PoP corriera primero, esto sería 403, no 429.
    const res = await POST(req({ vendorData: ADDR_A }));
    expect(
      res.status,
      "el PoP se movió antes del limiter: verificar un HMAC + una firma ed25519 cuesta CPU, y sin " +
        "límite previo eso es un ataque de denegación que cuesta un `curl`",
    ).toBe(429);
    expect(rlMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("T-SE-4b: el limiter sigue usando `body.vendorData` como hint, como antes (declarado)", async () => {
    fetchOk();
    await POST(req({ vendorData: "0xabc", ...realPop(KP_A) }));
    // Se declara en el código: moverlo a la dirección probada lo pondría DESPUÉS del cripto. Ese
    // valor ya era forjable antes de esta HU, así que no se debilita nada — pero queda medido.
    expect(rlMock).toHaveBeenCalledWith({ ip: "9.9.9.9", address: "0xabc" });
  });

  // ── T-SE-5 — M-4b: los cinco fallos son indistinguibles entre sí ──────────────────────────────
  it("T-SE-5: los 5 fallos del PoP dan el MISMO status y el MISMO cuerpo, comparados entre sí (M-4b)", async () => {
    fetchOk();
    const good = realPop(KP_A);
    const inputs: Array<[string, Record<string, unknown>]> = [
      ["P1 · sin challenge/firma", { vendorData: ADDR_A }],
      ["P2 · challenge con HMAC roto", { popChallenge: "no-es-un-token", popSignature: good.popSignature }],
      ["P3 · challenge de A firmado por B", { ...realPop(KP_B, KP_A) }],
      [
        "P4 · network-id que no es el del server",
        {
          popChallenge: issueSolanaPopChallenge({
            address: ADDR_A,
            networkId: "solana:mainnet",
            nonce: "0123456789abcdef0123456789abcdef",
            exp: Math.floor(Date.now() / 1000) + 300,
          }),
          popSignature: good.popSignature,
        },
      ],
      ["P5 · firma que no verifica", { popChallenge: good.popChallenge, popSignature: bs58.encode(new Uint8Array(64).fill(7)) }],
    ];
    const seen: Array<{ label: string; status: number; body: string }> = [];
    for (const [label, payload] of inputs) {
      const res = await POST(req(payload));
      seen.push({ label, status: res.status, body: await res.text() });
    }
    const first = seen[0]!;
    for (const s of seen) {
      expect(
        { status: s.status, body: s.body },
        `el fallo "${s.label}" se distingue de "${first.label}": cada diferencia le dice a un ` +
          "desconocido en qué paso falló, y eso es un mapa para forjar la prueba de posesión",
      ).toEqual({ status: first.status, body: first.body });
    }
    expect(first.status).toBe(403);
    expect(JSON.parse(first.body)).toEqual({ error: "kyc_session_unverified" });
  });

  it("T-SE-6: con key y SIN PAYOUT_POP_SECRET ⇒ 503 fail-closed, nunca un 500 crudo", async () => {
    // Sin el guard explícito, `verifySolanaPopChallenge` tira "PAYOUT_POP_SECRET missing" y sale una
    // excepción sin manejar. Un deployment así no puede atar la sesión a nadie: no crea ninguna.
    const proof = realPop(KP_A); // se emite CON secreto, se presenta SIN él
    vi.stubEnv("PAYOUT_POP_SECRET", "");
    const fetchMock = fetchOk();
    const res = await POST(req({ vendorData: ADDR_A, ...proof }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "kyc_session_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
