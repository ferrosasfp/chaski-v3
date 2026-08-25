// T-AUTH-1..6 — el guard-order de `resolvePayoutAuthority`, A NIVEL MÓDULO (WKH-233/W3).
//
// Por qué no alcanza con los de `app/api/payout/validate/route.test.ts`: esa ruta COLAPSA los tres
// reasons subject a `kyc_not_authorized`, así que desde ahí es imposible ver CUÁL reason devolvió la
// autoridad. Y el reason importa: `prepare/route.ts` despacha sobre él con un `switch` CERRADO, y un
// reason que no esté en ese switch cae al `default` → 502 "la autoridad se cayó" en vez de 403 "no
// estás autorizado". Estos tests fijan el reason exacto.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// El store del `decisionToken`. HONESTO: aplica el filtro por dueño de verdad (CD-19). Un
// `mockResolvedValue` fijo dejaría sobrevivir la pérdida del `.eq("owner_address", …)`, que es el
// IDOR sobre la credencial del desembolso.
const { getTokenStoreMock } = vi.hoisted(() => ({ getTokenStoreMock: vi.fn() }));
vi.mock("../persistence/supabase-kyc-session-tokens", () => ({
  getKycSessionTokenStore: getTokenStoreMock,
}));

// 🔴 AR/MNR-3 — POR QUÉ SE DOBLA `canonicalizeAddress`, Y NO ES COMODIDAD. La asimetría que este
// fix-pack cierra (canonicalizar para el store y mandarle al agente el valor CRUDO) **no se puede
// observar con la función real**: medido con esta versión de `@solana/web3.js`,
// `new PublicKey(x).toBase58() === x` para TODO `x` que el constructor no rechaza —las formas cortas
// tipo `"1"` ya no se aceptan (tiran `Invalid public key input`)—, así que canonicalizar es la
// identidad y los dos códigos dan el mismo byte. Sin este doble, T-AUTH-7 sería verde con y sin el
// fix, o sea un candado vacuo.
// ⚠️ El doble DELEGA EN LA FUNCIÓN REAL por default (se re-arma en cada `beforeEach`): los ~20 casos
// del resto del archivo —incluido el de la address malformada, que necesita que TIRE— siguen
// corriendo contra el comportamiento real. Sólo T-AUTH-7 le cambia la implementación.
const { canonSpy } = vi.hoisted(() => ({ canonSpy: vi.fn<(a: string) => string>() }));
vi.mock("../address", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../address")>();
  return { ...actual, canonicalizeAddress: (a: string) => canonSpy(a) };
});
const REAL_CANON = (await vi.importActual<typeof import("../address")>("../address"))
  .canonicalizeAddress;

import { resolvePayoutAuthority } from "./authority";
// WKH-233 (fix-pack · H-1) — el traductor de copy, importado desde un test de infraestructura A
// PROPÓSITO: lo que este archivo cierra es la CADENA (reason ⇒ enum de la route ⇒ frase en pantalla),
// y esa cadena no existe en ninguna de las dos capas por separado. `humanError` es una función PURA
// de un string, sin React ni DOM, así que importarla acá no arrastra entorno de pantalla.
import { humanError } from "../../presentation/flow-vm";

const VID = "sess-abc";
const ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const OTHER = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN = "k1.token-del-agente";

/** La salida del agente, aprobada y atada. `payoutAllowed:true` exige, por construcción,
 *  `identityMatches === true` + proveniencia REAL. */
const AGENTE_SI = {
  terminal: true,
  status: "Approved",
  approved: true,
  riskLevel: "low",
  verificationId: VID,
  provenance: "didit",
  payoutAllowed: true,
  reasons: [],
  identityMatches: true,
};

function agente(body: unknown, status = 200) {
  const m = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", m);
  return m;
}

/** Store con UNA fila: `(VID, ADDR)`. El filtro se aplica de verdad. */
function storeConLaFilaDe(sessionId: string, owner: string) {
  const getForOwner = vi.fn(async (s: string, o: string) =>
    s === sessionId && o === owner ? TOKEN : null,
  );
  getTokenStoreMock.mockReturnValue({ getForOwner });
  return getForOwner;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.stubEnv("KYC_AGENT_BASE_URL", "https://agentes.test");
  // WKH-233 (fix-pack · H-3): la credencial de invoke es OBLIGATORIA desde que `invokeAuthHeader`
  // es fail-closed, así que sembrarla es PRE-REQUISITO de cualquier `it` que llegue al agente —
  // igual que el host de la línea de arriba. Sin esto, 45 `it` de tres archivos morían con
  // `kyc_agent_invoke_secret_unset` antes de llegar a lo que miden.
  vi.stubEnv("KYC_AGENT_INVOKE_SECRET", "invoke-secret-de-test");
  vi.stubEnv("VERCEL_ENV", undefined);
  getTokenStoreMock.mockReset();
  storeConLaFilaDe(VID, ADDR);
  canonSpy.mockReset();
  canonSpy.mockImplementation(REAL_CANON); // default: la función REAL, para todo el resto del archivo
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-AUTH-1 · DT-5' — el gate es `payoutAllowed === true`, Y NADA MÁS
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-AUTH-1: el juicio es del AGENTE; Chaski no lo recompone", () => {
  it("🔴 `payoutAllowed:false` con `approved:true` E `identityMatches:true` ⇒ NO autoriza", async () => {
    agente({ ...AGENTE_SI, payoutAllowed: false });
    // 🧬 MUTANTE: quitar `payoutAllowed` del `if` (o recomponerlo con `approved && identityMatches`)
    // ⇒ autorizaría ⇒ ROJO. Y es el mutante que destapa el bug de hoy: así se paga contra un KYC que
    // el agente NO habilita.
    expect(await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).toEqual({
      authorized: false,
      reason: "kyc_not_approved",
      httpStatus: 200,
    });
  });

  it("🔴 Y EL INVERSO, que es la mitad que PRUEBA DT-5': `payoutAllowed:true` con `approved:false` ⇒ AUTORIZA", async () => {
    agente({ ...AGENTE_SI, approved: false, status: "In Review" });
    // El juicio es del agente, no nuestro. Un test que sólo midiera la mitad de arriba pasaría
    // también con `approved && payoutAllowed`, que es re-implementar el juicio de KYC.
    expect(await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).toEqual({
      authorized: true,
      httpStatus: 200,
      provenance: "didit",
      riskLevel: "low",
    });
  });

  it("`payoutAllowed` truthy pero no `true` (el STRING) ⇒ NO autoriza (comparación estricta)", async () => {
    agente({ ...AGENTE_SI, payoutAllowed: "true" });
    // El cliente lo rechaza al estrechar ⇒ throw ⇒ el catch lo convierte en fail-closed. Lo que este
    // test fija es que NINGÚN camino convierte un `"true"` en una autorización.
    const d = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(d.authorized).toBe(false);
  });

  it("`identityMatches` AUSENTE con `payoutAllowed:false` ⇒ NO autoriza (⛔ sin `?? false`)", async () => {
    const { identityMatches: _sin, ...sinClaim } = AGENTE_SI;
    agente({ ...sinClaim, payoutAllowed: false });
    expect((await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).reason).toBe(
      "kyc_not_approved",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-AUTH-2 · CD-11 mecanizado — con KYC SIMULADO NO SE PAGA, en TODO entorno
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-AUTH-2: CD-11 — la proveniencia simulada no abre el desembolso en ningún entorno", () => {
  it.each([["production"], ["preview"], [undefined]])(
    "con VERCEL_ENV=%s: `provenance:'didit-mock'` + `payoutAllowed:false` ⇒ NO autoriza",
    async (scope) => {
      vi.stubEnv("VERCEL_ENV", scope as string | undefined);
      agente({ ...AGENTE_SI, provenance: "didit-mock", payoutAllowed: false });
      // 🧬 MUTANTE: `r.output.payoutAllowed === true || r.output.provenance === "didit-mock"` ⇒ ROJO.
      // 🔴 ES EL MUTANTE QUE EL GUARD ESTÁTICO NO CAZA: G-3 mira nombres, no ramas.
      const d = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
      expect(
        d,
        "se relajó el gate para que la demo pague: eso es exactamente lo que CD-11 prohíbe, y lo que " +
          "hace que hoy se pague contra un KYC simulado",
      ).toEqual({ authorized: false, reason: "kyc_not_approved", httpStatus: 200 });
    },
  );

  it.each([["production"], ["preview"], [undefined]])(
    "✅ calibración inversa, con VERCEL_ENV=%s: proveniencia real + `payoutAllowed:true` ⇒ AUTORIZA",
    async (scope) => {
      vi.stubEnv("VERCEL_ENV", scope as string | undefined);
      agente(AGENTE_SI);
      expect(await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).toEqual({
        authorized: true,
        httpStatus: 200,
        provenance: "didit",
        riskLevel: "low",
      });
    },
  );
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-AUTH-3 · fail-closed ante cualquier fallo del borde
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-AUTH-3: nunca autoriza ante un fallo, y nunca ecoa el body del agente", () => {
  it.each([[400], [401], [502], [503]])("el agente contesta %i ⇒ kyc_reauth_failed / 502", async (st) => {
    agente({ error: "lo-que-sea", secreto: "NO-DEBE-VIAJAR" }, st);
    const d = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    // 🧬 MUTANTE: devolver `authorized:true` en el catch (o dejar pasar el !ok) ⇒ ROJO.
    expect(d).toEqual({ authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 });
    expect(JSON.stringify(d)).not.toContain("NO-DEBE-VIAJAR");
  });

  it("el `fetch` TIRA (timeout/DNS/reset) ⇒ 502 y un log value-free con SÓLO `errorName`", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const e = new Error(`connect ECONNREFUSED https://agentes.test/...?sessionId=${VID}`);
        e.name = "TimeoutError";
        throw e;
      }),
    );
    const d = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(d).toEqual({ authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 });
    const salida = JSON.stringify(warn.mock.calls);
    expect(salida).toContain("TimeoutError");
    for (const secreto of [VID, ADDR, TOKEN]) {
      expect(salida, `el log filtró \`${secreto}\``).not.toContain(secreto);
    }
  });

  it("un JSON roto (clave faltante) ⇒ 502, nunca un `undefined` que siga viaje", async () => {
    agente({ terminal: true, status: "Approved" }); // sin `payoutAllowed`
    expect(await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).toEqual({
      authorized: false,
      reason: "kyc_reauth_failed",
      httpStatus: 502,
    });
  });

  it("✅ calibración inversa: el camino feliz devuelve `{authorized:true}` SIN `reason`", async () => {
    agente(AGENTE_SI);
    const d = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(
      d.reason,
      "apareció un `reason` en la rama que autoriza: los switches cerrados de validate y prepare lo " +
        "mandarían al default",
    ).toBeUndefined();
    expect(d.authorized).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-AUTH-4 · CD-19 en el money-path — sin la fila DEL DUEÑO no hay viaje al agente
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-AUTH-4: la credencial es owner-scoped, y se lee ANTES del borde (P-7)", () => {
  it("🔴 par `(sesión, dirección)` ajeno ⇒ `kyc_ownership_mismatch` y el agente recibe CERO llamadas", async () => {
    const fetchMock = agente(AGENTE_SI);
    storeConLaFilaDe(VID, ADDR); // la fila es de ADDR
    const d = await resolvePayoutAuthority({ verificationId: VID, address: OTHER });
    // 🧬 MUTANTE: llamar al agente igual y dejar que su 401 decida ⇒ el doble recibe 1 llamada ⇒ ROJO.
    // El punto no es sólo el veredicto: un par ajeno NI SIQUIERA OBTIENE EL TOKEN.
    expect(fetchMock, "se gastó una consulta con un par ajeno").toHaveBeenCalledTimes(0);
    expect(d).toEqual({ authorized: false, reason: "kyc_ownership_mismatch", httpStatus: 200 });
  });

  it("sesión que no existe ⇒ el MISMO `kyc_ownership_mismatch` (no distingue, no es un oráculo)", async () => {
    const fetchMock = agente(AGENTE_SI);
    const d = await resolvePayoutAuthority({ verificationId: "sess-inexistente", address: ADDR });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(d.reason).toBe("kyc_ownership_mismatch");
  });

  it("✅ calibración inversa: con la fila DEL DUEÑO, el agente recibe EXACTAMENTE 1 llamada", async () => {
    const fetchMock = agente(AGENTE_SI);
    const getForOwner = storeConLaFilaDe(VID, ADDR);
    await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getForOwner).toHaveBeenCalledWith(VID, ADDR);
  });

  it("sin store (envs de Supabase ausentes) ⇒ `kyc_authority_unavailable`/503: misconfig NUESTRA", async () => {
    const fetchMock = agente(AGENTE_SI);
    getTokenStoreMock.mockReturnValue(null);
    expect(await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).toEqual({
      authorized: false,
      reason: "kyc_authority_unavailable",
      httpStatus: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("la lectura del store TIRA ⇒ `kyc_reauth_failed`/502, y el agente no se consulta", async () => {
    const fetchMock = agente(AGENTE_SI);
    getTokenStoreMock.mockReturnValue({
      getForOwner: vi.fn(async () => {
        throw new Error("kyc_session_token_read_failed:42P01");
      }),
    });
    const d = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(d).toEqual({ authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(JSON.stringify(d)).not.toContain("42P01");
  });

  it("una `address` malformada NUNCA autoriza (y no llega al agente)", async () => {
    const fetchMock = agente(AGENTE_SI);
    const d = await resolvePayoutAuthority({ verificationId: VID, address: "no-es-base58!!" });
    expect(d.authorized).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-AUTH-5 · las CINCO formas de retorno se conservan
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-AUTH-5: las 5 formas de retorno, incluidas las DOS ramas sin host del agente", () => {
  it.each([
    [
      "sin host + prod ⇒ fail-loud",
      () => {
        vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
        vi.stubEnv("VERCEL_ENV", "production");
      },
      { authorized: false, reason: "kyc_authority_unavailable", httpStatus: 503 },
      VID,
    ],
    [
      "sin host + NO prod ⇒ el demo local",
      () => {
        vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
        vi.stubEnv("VERCEL_ENV", undefined);
      },
      { authorized: true, reason: "simulated_dev", httpStatus: 200 },
      VID,
    ],
    [
      "sin host + NO prod + id vacío ⇒ el guard de formato sigue delante",
      () => {
        vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
        vi.stubEnv("VERCEL_ENV", undefined);
      },
      { authorized: false, reason: "invalid_verification_id", httpStatus: 400 },
      "   ",
    ],
    [
      "con host + id vacío ⇒ formato",
      () => {},
      { authorized: false, reason: "invalid_verification_id", httpStatus: 400 },
      "",
    ],
  ])("%s", async (_caso, setup, esperado, vid) => {
    // 🧬 MUTANTE: colapsar las dos ramas del host ausente en una ⇒ ROJO. Las dos se conservan tal
    // cual: `prepare` rechaza `simulated_dev` en todo scope de Vercel, y el demo local depende de él.
    (setup as () => void)();
    const fetchMock = agente(AGENTE_SI);
    expect(await resolvePayoutAuthority({ verificationId: vid as string, address: ADDR })).toEqual(
      esperado,
    );
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("la 5ª forma: autorización real, CON `provenance`/`riskLevel` y SIN `reason`", async () => {
    agente({ ...AGENTE_SI, provenance: "didit", riskLevel: "medium" });
    expect(await resolvePayoutAuthority({ verificationId: VID, address: ADDR })).toEqual({
      authorized: true,
      httpStatus: 200,
      provenance: "didit",
      riskLevel: "medium",
    });
  });

  it("⛔ `provenance`/`riskLevel` NO viajan en ninguna rama que no sea la autorización real", async () => {
    vi.stubEnv("KYC_AGENT_BASE_URL", undefined);
    const sim = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(sim.provenance).toBeUndefined();
    expect(sim.riskLevel).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-AUTH-6 · CD-21 — el camino de fallo del token invalidado, especificado
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-AUTH-6: si el token fue invalidado, el agente contesta 401 y NO se reintenta", () => {
  it("401 del agente ⇒ `kyc_reauth_failed`/502 y EXACTAMENTE UNA llamada (sin reintento)", async () => {
    const fetchMock = agente({ error: "unauthorized" }, 401);
    const d = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    // 🧬 MUTANTE: agregar un reintento, o un fallback con otra credencial ⇒ ROJO por el contador.
    // 🔴 El `decisionToken` NO VENCE y NO HAY DÓNDE RE-EMITIRLO: los únicos dos caminos que lo
    // invalidan (rotar el secreto del agente, o subir su versión) son un CORTE, no un rollback. La
    // persona no pierde plata; pierde el pago hasta que se re-verifique.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(d).toEqual({ authorized: false, reason: "kyc_reauth_failed", httpStatus: 502 });
  });

  it("y ese 502 es el que `prepare` mapea a `payout_authority_unavailable` por su `default`", async () => {
    // El reason se fija acá porque `prepare` despacha sobre él con un `switch` cerrado. Si esto
    // cambiara a un reason nuevo, `prepare` seguiría dando 502 —por el default— pero el conjunto
    // observable de errores dejaría de estar bajo control (CD-16).
    agente({ error: "unauthorized" }, 401);
    const d = await resolvePayoutAuthority({ verificationId: VID, address: ADDR });
    expect(d.reason).toBe("kyc_reauth_failed");
    expect(d.httpStatus).toBe(502);
  });

  // ── WKH-233 (fix-pack · H-1) — Y LO QUE LA PERSONA LEE AL FINAL DE ESA CADENA ─────────────────
  //
  // 🔴 POR QUÉ ESTA ASERCIÓN VIVE ACÁ Y NO SÓLO EN `flow-vm.test.ts`. El defecto no estaba en ninguna
  // de las dos puntas: estaba en que NADA ataba el `reason` que fija el `it` de arriba con el copy que
  // sale del otro lado. La cadena medida es `kyc_reauth_failed`/502 (acá) ⇒ el `default` del `switch`
  // de `app/api/payout/prepare/route.ts:348` ⇒ `payout_authority_unavailable` ⇒ el `case` 1:1 de
  // `../settlement/http-solana-prepare-gateway.ts:59` ⇒ `payout_authority_unavailable` como `failureReason`
  // persistido. Con las dos puntas verdes por separado, ese enum estuvo cayendo en el catch-all
  // `code.includes("payout")` y la persona leía "si tus USDC entraron al escrow, los sacás vos firmando"
  // — sobre un corte que ocurre ANTES del forward al agente y ANTES de `authorizePrincipal`, o sea con
  // CERO USDC en ningún escrow.
  //
  // 🔴 LO QUE ESTE `it` MIDE, EXACTAMENTE: **la FUNCIÓN de copy, no la PANTALLA.** Acá se llama a
  // `humanError()` y se afirma sobre lo que devuelve. ⚠️ ACÁ DECÍA «⇒ `humanError` EN LA PANTALLA», Y ESA
  // ERA LA MITAD FALSA (re-AR it2 · BLQ-ALTO-1): el `it` daba verde mientras `TrackView` no llamaba nunca
  // a `humanError` con este motivo —su `else` estaba hardcodeado a `humanError("payout_failed")`—, así que
  // el copy nuevo era INALCANZABLE y este archivo lo daba por entregado. El último eslabón, el que la
  // persona lee, lo mide RENDERIZANDO la vista: `src/presentation/copy-de-prepare-en-pantalla.test.tsx`
  // (T-PANT-1 para este enum, T-PANT-2 para el conjunto). Si ese archivo desaparece, este `it` vuelve a
  // ser una punta suelta y hay que decirlo en voz alta.
  //
  // ⚠️ LO QUE ESTO **NO** MIDE, declarado: el salto `502 ⇒ payout_authority_unavailable` es lectura a
  // mano del `switch` de `prepare/route.ts` (fuera del Scope IN de este fix-pack: ese archivo tiene
  // que quedar con CERO diff). Acá se fija el reason de un lado y el copy del otro; el eslabón del
  // medio lo cubren `app/api/payout/prepare/route.test.ts:459` y el `case` del gateway.
  it("y el copy que la persona lee al final de esa cadena NO le habla de USDC en el escrow", () => {
    const msg = humanError("payout_authority_unavailable");
    // 🧪 CONTROL POSITIVO EN LA MISMA CORRIDA: el catch-all de `payout` SIGUE EXISTIENDO y sigue
    // tragándose lo que le corresponde. Sin este par, las dos aserciones de abajo pasarían igual si
    // alguien borrara el catch-all entero: estarían comparando contra un texto que ya no produce
    // nadie, o sea un barrido que no puede encontrar nada.
    const catchAll = humanError("payout_un_codigo_que_nadie_mapeó");
    expect(catchAll).toContain("entraron al escrow");
    // Y ahora sí: el enum de ESTA cadena no es ese.
    expect(
      msg,
      "`payout_authority_unavailable` cayó en el catch-all de `payout`: manda a sacar del escrow " +
        "unos USDC que nunca salieron de la billetera de la persona",
    ).not.toBe(catchAll);
    expect(msg).not.toContain("escrow");
    expect(msg).toContain("No se movió ningún USDC");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// T-AUTH-7 · AR/MNR-3 — las DOS mitades de la decisión usan EL MISMO valor de la dirección
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ ASIMETRÍA CIERRA. La decisión del desembolso se parte en dos preguntas sobre la MISMA
// dirección: (1) ¿de quién es la credencial? — al store, con la dirección CANONICALIZADA; (2) ¿la
// identidad coincide? — al agente, que acá recibía la dirección **CRUDA**. Dos valores para una sola
// decisión, en la línea que autoriza plata.
//
// ⚠️ HOY NO ES EXPLOTABLE, Y ESO ESTÁ MEDIDO, NO SUPUESTO: con esta versión de `@solana/web3.js` la
// canonicalización es la identidad sobre todo input aceptado, así que los dos valores coinciden
// siempre y —si algún día dejaran de coincidir— el agente contestaría `identityMatches:false` y el
// gate fallaría CERRADO. Se cierra igual porque es gratis y porque el próximo que lea esas dos
// líneas no tiene por qué re-derivar todo esto.
//
// ⛔ POR ESO ESTE `it` NO PUEDE MEDIRSE CON LA FUNCIÓN REAL, y por eso el doble: ver la nota del
// `vi.mock("../address")` arriba. Un test que usara la real sería verde con y sin el fix.
describe("T-AUTH-7: al agente le llega la dirección CANONICALIZADA, la misma que buscó al dueño", () => {
  const CANON = "CanonICALiZADAxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; // el valor que devuelve el doble
  const CRUDA = "cruda-tal-como-vino-de-prepare";

  it("el `identityClaim` del query es el valor CANONICALIZADO, nunca el crudo", async () => {
    canonSpy.mockImplementation(() => CANON);
    storeConLaFilaDe(VID, CANON); // la fila es del dueño CANONICALIZADO
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(u);
        return { ok: true, status: 200, json: async () => AGENTE_SI };
      }),
    );

    const d = await resolvePayoutAuthority({ verificationId: VID, address: CRUDA });

    // ✅ Control positivo: el caso llegó de verdad hasta el agente. Sin esto, un corte temprano
    // (sin fila, sin store) dejaría el assert de abajo verde por vacío.
    expect(urls, "el caso no llegó a consultar al agente: el assert de abajo sería vacuo").toHaveLength(1);
    expect(d.authorized).toBe(true);

    const primera = urls[0];
    if (primera === undefined) throw new Error("no hubo llamada al agente");
    const claim = new URL(primera).searchParams.get("identityClaim");
    // 🧬 MUTANTE: volver a `identityClaim: address` (la dirección cruda) ⇒ ROJO por las dos.
    expect(claim, "al agente le llegó una dirección distinta de la que identificó al dueño").toBe(CANON);
    expect(claim).not.toBe(CRUDA);
  });
});
