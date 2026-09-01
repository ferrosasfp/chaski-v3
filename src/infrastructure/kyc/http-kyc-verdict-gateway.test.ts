// Tests — HttpKycVerdictGateway (WKH-333/AC-13, CD-15, CD-16).
//
// Lo que custodian: las CUATRO causas de "no llegamos a preguntar" son distinguibles entre sí, y
// ninguna se confunde con "no hay veredicto". Colapsarlas (M-18) no rompe el camino feliz —las cuatro
// terminan creando la sesión de Didit igual— y por eso es tan fácil que se cuele: lo que se pierde es
// la capacidad de decir POR QUÉ se gastó un cupo del proveedor, y el día que alguien ramifique sobre
// el desenlace, "no pude preguntar" leído como "ya está verificada" deja a una persona sin poder pagar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PopSigner } from "../../application/ports";
import { HttpKycVerdictGateway } from "./http-kyc-verdict-gateway";

const ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PROOF = { challenge: "ch-1", signature: "sig-1" };

function popSigner(mode: "ok" | "null" | "throw"): PopSigner {
  return {
    async prove() {
      if (mode === "throw") throw new Error("user_rejected");
      return mode === "null" ? null : PROOF;
    },
  };
}

// Los parámetros declarados NO son decorativos: sin ellos `mock.calls` se tipa como `[]` y
// `calls[0][1]` no compila con strict (TS2493), que es el mismo gotcha ya anotado en otros tests.
/** El body del request `n`. Concentra el acceso indexado: el `!` es lo único que TypeScript acepta
 *  ahí, y un `?.` encadenado dispara `noUnsafeOptionalChaining`, que en este repo es ERROR de lint. */
function sentBody(m: { mock: { calls: unknown[][] } }, n = 0): Record<string, unknown> {
  const call = m.mock.calls[n];
  if (!call) throw new Error("no hubo request");
  const init = call[1] as RequestInit | undefined;
  if (!init?.body) throw new Error("el request no llevó body");
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function fetchReturning(status: number, body: unknown) {
  const m = vi.fn(async (_url: string, _init?: RequestInit) => {
    void _url;
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal("fetch", m);
  return m;
}

describe("HttpKycVerdictGateway — cuatro desenlaces distinguibles (WKH-333)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  // ── T-GW-1 ─────────────────────────────────────────────────────────────────────────────────────
  it("T-GW-1: `prove()` → null (mecanismo apagado server-side) ⇒ pop_disabled, y NO se pide nada", async () => {
    const f = fetchReturning(200, {});
    const out = await new HttpKycVerdictGateway(popSigner("null")).ensure(ADDR);
    expect(out.lookup).toEqual({ outcome: "not_asked", reason: "pop_disabled" });
    expect(f, "se gastó un request con una prueba que no existe").not.toHaveBeenCalled();
    expect(out.proof).toBeUndefined();
  });

  // ── T-GW-2 ─────────────────────────────────────────────────────────────────────────────────────
  it("T-GW-2: 501 (la tabla está apagada) ⇒ store_disabled, NO 'no hay veredicto'", async () => {
    fetchReturning(501, { error: "kyc_verdict_not_enabled" });
    const out = await new HttpKycVerdictGateway(popSigner("ok")).ensure(ADDR);
    expect(
      out.lookup,
      "'la tabla está apagada' se leyó como 'esta persona no tiene veredicto': son cosas distintas " +
        "y la primera le pasa a TODO el mundo a la vez",
    ).toEqual({ outcome: "not_asked", reason: "store_disabled" });
  });

  // ── T-GW-3 ─────────────────────────────────────────────────────────────────────────────────────
  it("T-GW-3: 403 (la prueba no verificó) ⇒ pop_rejected", async () => {
    fetchReturning(403, { error: "kyc_verdict_unverified" });
    const out = await new HttpKycVerdictGateway(popSigner("ok")).ensure(ADDR);
    expect(out.lookup).toEqual({ outcome: "not_asked", reason: "pop_rejected" });
  });

  // ── T-GW-4 ─────────────────────────────────────────────────────────────────────────────────────
  it("T-GW-4: `prove()` LANZA (la persona rechazó la firma) ⇒ pop_declined, y NO se pide nada", async () => {
    const f = fetchReturning(200, {});
    const out = await new HttpKycVerdictGateway(popSigner("throw")).ensure(ADDR);
    expect(out.lookup).toEqual({ outcome: "not_asked", reason: "pop_declined" });
    expect(f).not.toHaveBeenCalled();
  });

  // ── M-18: los cuatro son DISTINTOS entre sí ────────────────────────────────────────────────────
  it("los cuatro `not_asked` tienen razones DISTINTAS entre sí (M-18)", async () => {
    const razones: string[] = [];
    fetchReturning(200, {});
    razones.push(((await new HttpKycVerdictGateway(popSigner("null")).ensure(ADDR)).lookup as { reason: string }).reason);
    razones.push(((await new HttpKycVerdictGateway(popSigner("throw")).ensure(ADDR)).lookup as { reason: string }).reason);
    fetchReturning(501, {});
    razones.push(((await new HttpKycVerdictGateway(popSigner("ok")).ensure(ADDR)).lookup as { reason: string }).reason);
    fetchReturning(403, {});
    razones.push(((await new HttpKycVerdictGateway(popSigner("ok")).ensure(ADDR)).lookup as { reason: string }).reason);
    expect(
      new Set(razones).size,
      "dos o más causas de 'no pude preguntar' colapsaron en la misma razón: apagar el mecanismo de " +
        "firma deja de ser distinguible de que la persona lo haya rechazado, y las dos se arreglan " +
        "distinto",
    ).toBe(4);
  });

  // ── 200 ────────────────────────────────────────────────────────────────────────────────────────
  it("200 con verdict ⇒ usable, y la prueba usada VIAJA de vuelta (R-1)", async () => {
    fetchReturning(200, {
      verdict: { riskLevel: "medium", provenance: "didit", verifiedAt: "2026-08-01T00:00:00.000Z" },
    });
    const out = await new HttpKycVerdictGateway(popSigner("ok")).ensure(ADDR, "did-pista");
    expect(out.lookup).toEqual({
      outcome: "usable",
      verdict: { riskLevel: "medium", provenance: "didit", verifiedAt: "2026-08-01T00:00:00.000Z" },
    });
    expect(
      out.proof,
      "la prueba no volvió: la creación de la sesión de Didit también la exige, así que la persona " +
        "vería un SEGUNDO prompt de billetera por el mismo motivo",
    ).toEqual(PROOF);
  });

  it("200 sin verdict ⇒ absent CON el motivo que declaró el servidor (venció ≠ no hay)", async () => {
    for (const reason of ["absent", "expired", "not_approved"]) { // WKH-233: `"simulated"` se fue de `KycVerdictAbsentReason` (una fila que existe es real por invariante)
      fetchReturning(200, { verdict: null, reason });
      const out = await new HttpKycVerdictGateway(popSigner("ok")).ensure(ADDR);
      expect(out.lookup).toEqual({ outcome: "absent", reason });
    }
  });

  it("un `reason` desconocido cae a 'absent' y NO se inventa uno de los otros tres", async () => {
    fetchReturning(200, { verdict: null, reason: "motivo-del-futuro" });
    const out = await new HttpKycVerdictGateway(popSigner("ok")).ensure(ADDR);
    expect(out.lookup).toEqual({ outcome: "absent", reason: "absent" });
  });

  it("la pista viaja SÓLO si existe, y el `verificationId` nunca vuelve en la respuesta (AC-6)", async () => {
    const f = fetchReturning(200, { verdict: null, reason: "absent" });
    await new HttpKycVerdictGateway(popSigner("ok")).ensure(ADDR, "did-pista");
    const sent = sentBody(f);
    expect(sent.candidateVerificationId).toBe("did-pista");
    expect(sent.sender).toBe(ADDR);
    expect(sent.popChallenge).toBe(PROOF.challenge);

    f.mockClear();
    await new HttpKycVerdictGateway(popSigner("ok")).ensure(ADDR);
    const sent2 = sentBody(f);
    expect(sent2).not.toHaveProperty("candidateVerificationId");
  });

  it("otro !ok (502) LANZA: es un fallo real y el caller tiene que verlo", async () => {
    fetchReturning(502, { error: "kyc_verdict_unavailable" });
    await expect(new HttpKycVerdictGateway(popSigner("ok")).ensure(ADDR)).rejects.toThrow();
  });
});

// ── 🔴 WKH-372/W3.4 · EL GATEWAY GRABA LA SESIÓN QUE EL SERVIDOR LE DIO ──────────────────────────
//
// Qué custodian estos dos `it`: que la escritura cubre los CINCO `return … 200` de
// `/api/kyc/verdict` con una sola línea, y que la ausencia del campo no es un error.
//
// ⛔ FALSO KILLED A EVITAR: un `it` que sólo mirara el 200 con veredicto daría verde con una escritura
// metida adentro de la rama `usable`, y ahí la ola se rompe justo para quien MÁS la necesita: la
// persona que todavía no se verificó es la que después va a firmar de más.
describe("HttpKycVerdictGateway — la sesión de posesión (WKH-372/W3.4)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  /** Doble de sólo escritura: anota qué se grabó y para quién. */
  function recorder() {
    const escrituras: { address: string; token: string }[] = [];
    return { escrituras, record: (address: string, token: string) => void escrituras.push({ address, token }) };
  }

  // MUTANTE QUE LO MATA: mover el `record` adentro de la rama del veredicto usable (o sea, debajo del
  // `if (!v)`) ⇒ las cuatro filas `absent` de abajo quedan sin sesión y esto se pone rojo.
  it("T-372-W3-18: la sesión se graba en los CINCO 200, incluidos los `absent`", async () => {
    const casos: { cuerpo: unknown; que: string }[] = [
      { que: "200 con veredicto", cuerpo: { verdict: { riskLevel: "low", provenance: "didit", verifiedAt: "2026-08-01T00:00:00.000Z" }, sesion: "tok.1" } },
      { que: "200 absent", cuerpo: { verdict: null, reason: "absent", sesion: "tok.1" } },
      { que: "200 not_approved", cuerpo: { verdict: null, reason: "not_approved", sesion: "tok.1" } },
      { que: "200 expired", cuerpo: { verdict: null, reason: "expired", sesion: "tok.1" } },
    ];
    for (const { cuerpo, que } of casos) {
      fetchReturning(200, cuerpo);
      const r = recorder();
      await new HttpKycVerdictGateway(popSigner("ok"), r).ensure(ADDR);
      expect(r.escrituras, `no se grabó la sesión en el caso: ${que}`).toEqual([
        { address: ADDR, token: "tok.1" },
      ]);
    }
  });

  // MUTANTE QUE LO MATA: quitar el guard `typeof body.sesion === "string" && body.sesion` ⇒ se graba
  // `undefined`/`null`/`123` como si fuera un token, y el gateway del depósito lo presentaría a la
  // route, que contestaría 403 a un caller que tenía un PoP perfectamente bueno.
  it("T-372-W3-19: un `sesion` ausente, vacío o de tipo raro NO se graba, y NO es un error", async () => {
    // (a) LA MITAD POSITIVA, primero: si esto no grabara, todo lo de abajo sería decorativo.
    fetchReturning(200, { verdict: null, reason: "absent", sesion: "tok.ok" });
    const bueno = recorder();
    const okOut = await new HttpKycVerdictGateway(popSigner("ok"), bueno).ensure(ADDR);
    expect(bueno.escrituras.length, "el instrumento no sabe grabar: no mide nada").toBe(1);
    expect(okOut.lookup).toEqual({ outcome: "absent", reason: "absent" });

    // (b) Las cuatro formas de que no haya sesión utilizable. En las cuatro el desenlace del gateway
    //     es EXACTAMENTE el de siempre: sin sesión se le pide la firma a la persona, como hoy.
    for (const sesion of [undefined, null, "", 123]) {
      fetchReturning(200, { verdict: null, reason: "absent", ...(sesion === undefined ? {} : { sesion }) });
      const r = recorder();
      const out = await new HttpKycVerdictGateway(popSigner("ok"), r).ensure(ADDR);
      expect(r.escrituras, `se grabó una sesión que no es un token: ${JSON.stringify(sesion)}`).toEqual([]);
      expect(out.lookup, "un `sesion` raro cambió el desenlace del veredicto").toEqual({
        outcome: "absent",
        reason: "absent",
      });
    }

    // (c) Y en los cortes tempranos NO se llega ni a leer el cuerpo: 501 y 403 no graban nada.
    for (const status of [501, 403]) {
      fetchReturning(status, { sesion: "tok.robado" });
      const r = recorder();
      await new HttpKycVerdictGateway(popSigner("ok"), r).ensure(ADDR);
      expect(r.escrituras, `se grabó una sesión venida de un ${status}`).toEqual([]);
    }
  });

  // ⛔ Y SIN ALMACÉN CABLEADO, EL GATEWAY CORRE BYTE-IDÉNTICO A COMO CORRÍA ANTES DE W3. Es la mitad
  // que hace que el 2º argumento pueda ser opcional sin cambiarle el comportamiento a nadie.
  it("T-372-W3-20: sin almacén cableado, un 200 con `sesion` no cambia nada ni rompe", async () => {
    fetchReturning(200, { verdict: null, reason: "absent", sesion: "tok.1" });
    const out = await new HttpKycVerdictGateway(popSigner("ok")).ensure(ADDR);
    expect(out.lookup).toEqual({ outcome: "absent", reason: "absent" });
  });
});
