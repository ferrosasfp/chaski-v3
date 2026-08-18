// Tests — ConnectWallet + el veredicto de KYC server-side (WKH-333/AC-20, CD-15).
//
// 🔴 LO QUE ESTE ARCHIVO CUSTODIA, Y POR QUÉ ES EL RIESGO MÁS CARO DE LA HU. El relleno de la fila
// del veredicto tiene que correr AL CONECTAR, no al iniciar el KYC. Está medido en `start-kyc.ts`:
// cuando el store local tiene un veredicto aprobado, ese use-case SALE ANTES sin consultar nada. Esa
// es exactamente la población que HOY ya está verificada en su navegador. Con el relleno allá, esa
// gente nunca lo ejecutaría, llegaría a `prepare` sin fila, y con el corte sin respaldo de AC-17 la
// app se rompe para los usuarios actuales. Además `flow.tsx` los manda de `connect` directo a
// `confirm`: la pantalla de verificación ni se muestra.
import { describe, expect, it, vi } from "vitest";
import type { KycVerdictEnsureResult, KycVerdictGateway, PruebaPorEnlace, WalletPossessionProof } from "../ports";
import { FAKE_WALLET_ADDRESS, FakeKycStore, FakeWallet } from "../../test-support/fakes";
import { toPersistedIdentity } from "../../domain/remittance";
import { ConnectWallet } from "./connect-wallet";
import { esperarConectado } from "../../test-support/desenlaces"; // WKH-359: ConnectWallet.execute() ahora tiene DOS desenlaces. Este helper TIRA si suspendió donde el test no lo espera, en vez de dejar un `undefined` viajando por media suite.

// La MISMA constante que devuelve el doble de billetera: escribirla a mano acá haría que
// `peek(ADDR)` mirara una llave distinta de la que `save()` escribió, y el test pasaría a
// medir el andamiaje en vez del use-case.
const ADDR = FAKE_WALLET_ADDRESS;

function kyc(verificationId: string | null = "did-del-navegador") {
  return {
    verificationId,
    approved: true,
    payoutAllowed: true,
    riskLevel: "low" as const,
    provenance: "didit",
    identity: toPersistedIdentity({
      firstName: "Test",
      lastNamePaternal: "Quispe",
      lastNameMaternal: "Mamani",
      documentType: "DNI",
      documentNumber: "12345678",
      dateOfBirth: "1990-01-01",
      nationality: "PE",
    }),
  };
}

/** Gateway espía: registra CADA llamada con sus argumentos, para poder afirmar el VALOR de la pista
 *  y no sólo que se llamó. */
function spyGateway(result: KycVerdictEnsureResult, opts: { throws?: boolean } = {}) {
  // WKH-359: la prueba YA CONSEGUIDA se registra también. Sin esto, un `ensure` que la ignorara daría
  // verde: el espía no tendría dónde mostrarla, que es el mismo agujero que el fixture positivo del
  // paso del nonce tenía con la firma.
  const calls: Array<{ address: string; candidate?: string; yaConseguida?: WalletPossessionProof }> = [];
  const gw: KycVerdictGateway = {
    async ensure(address, candidate, yaConseguida) {
      calls.push({ address, candidate, yaConseguida });
      if (opts.throws) throw new Error("kyc_verdict_unavailable");
      return result;
    },
  };
  return { gw, calls };
}

const USABLE: KycVerdictEnsureResult = {
  lookup: {
    outcome: "usable",
    verdict: { riskLevel: "low", provenance: "didit", verifiedAt: "2026-08-01T00:00:00.000Z" },
  },
  proof: { challenge: "ch-1", signature: "sig-1" },
};

describe("ConnectWallet — el veredicto se asegura AL CONECTAR (WKH-333/AC-20)", () => {
  // ── T-CW-1 — M-34 ──────────────────────────────────────────────────────────────────────────────
  it("T-CW-1: al conectar se llama `ensure` EXACTAMENTE una vez, con la pista de `peek` (M-34)", async () => {
    const wallet = new FakeWallet();
    const store = new FakeKycStore();
    await store.save(ADDR, kyc("did-viejo-de-este-navegador"));
    const { gw, calls } = spyGateway(USABLE);

    const out = esperarConectado(await new ConnectWallet(wallet, store, gw).execute());

    expect(
      calls.length,
      "el relleno del veredicto NO corrió al conectar: si vive en StartKyc, toda persona ya " +
        "verificada en este navegador lo saltea (StartKyc sale antes) y llega a pagar sin fila — o " +
        "sea que la app se rompe justo para los usuarios actuales",
    ).toBe(1);
    expect(calls[0]?.address).toBe(ADDR);
    expect(
      calls[0]?.candidate,
      "la pista salió de `get()` en vez de `peek()`: `get()` devuelve null a los 181 días, así que " +
        "el relleno nunca alcanzaría a quien se verificó hace más de 180 días — que es justamente " +
        "la población que existe para salvar",
    ).toBe("did-viejo-de-este-navegador");
    expect(out.serverVerdict?.outcome).toBe("usable");
    // La prueba de posesión viaja para que la sesión de Didit no pida una SEGUNDA firma (R-1).
    expect(out.kycProof).toEqual({ challenge: "ch-1", signature: "sig-1" });
  });

  it("T-CW-1b: sin entry local, `ensure` se llama igual y sin pista", async () => {
    const { gw, calls } = spyGateway({ lookup: { outcome: "absent", reason: "absent" } });
    const out = esperarConectado(await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw).execute());
    expect(calls).toEqual([{ address: ADDR, candidate: undefined }]);
    expect(out.serverVerdict).toEqual({ outcome: "absent", reason: "absent" });
  });

  // ── T-CW-2 — M-20 ──────────────────────────────────────────────────────────────────────────────
  it("T-CW-2: si `ensure` TIRA, conectar devuelve igual y el flujo sigue (M-20)", async () => {
    const { gw } = spyGateway({ lookup: { outcome: "absent", reason: "absent" } }, { throws: true });
    const out = esperarConectado(await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw).execute());
    expect(
      out.address,
      "una caída de NUESTRA API de veredictos rompió el connect: conectar la billetera es la puerta " +
        "de entrada a todo, así que la persona no podría ni empezar un envío",
    ).toBe(ADDR);
    expect(out.serverVerdict).toBeUndefined(); // ⇒ camino de hoy (se crea la sesión de Didit)
    expect(out.kycProof).toBeUndefined();
  });

  it("T-CW-2b: si `peek` TIRA (localStorage roto), conectar sigue y `ensure` corre sin pista", async () => {
    const store = new FakeKycStore();
    vi.spyOn(store, "peek").mockRejectedValue(new Error("storage_broken"));
    const { gw, calls } = spyGateway({ lookup: { outcome: "absent", reason: "absent" } });
    const out = esperarConectado(await new ConnectWallet(new FakeWallet(), store, gw).execute());
    expect(out.address).toBe(ADDR);
    expect(calls).toEqual([{ address: ADDR, candidate: undefined }]);
  });

  // ── Sin gateway: byte-idéntico a antes de la HU ────────────────────────────────────────────────
  it("sin gateway cableado, `execute` se comporta EXACTAMENTE como antes (AC-12)", async () => {
    const store = new FakeKycStore();
    await store.save(ADDR, kyc());
    const out = esperarConectado(await new ConnectWallet(new FakeWallet(), store).execute());
    expect(out.address).toBe(ADDR);
    expect(out.rememberedKyc?.approved).toBe(true);
    expect(out.serverVerdict).toBeUndefined();
  });
});

// ═══ WKH-354 · AC-4 — regresión: W2.1 no rompió la resolución POR DIRECCIÓN ══════════════════════
//
// 🔴 POR QUÉ ESTE TEST EXISTE. WKH-354 hizo que `resolveSender` (pantalla) le pregunte a la billetera
// VIVA en vez de servir un `useState` cacheado. Lo que NO cambió, y este candado lo fija, es que
// `ConnectWallet` resuelve TODO —el KYC recordado y el veredicto del servidor— por la dirección que
// `wallet.connect()` devuelve, y por ninguna otra. En producción esa dirección sale del bridge, así
// que "adoptar la cuenta que la billetera tiene activa" (el gesto de AC-6, que reusa este mismo
// use-case) reconoce sola a una cuenta que ya estaba verificada. Si alguien hiciera que este
// use-case cachee la primera dirección, el gesto adoptaría la cuenta nueva con el KYC de la vieja:
// exactamente lo que CD-1 prohíbe.
describe("ConnectWallet — WKH-354/AC-4: el veredicto se resuelve POR la dirección conectada", () => {
  const B = "CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8";

  /** El molde del adapter real: `connect()` contesta la cuenta ACTIVA, que puede cambiar sin que la
   *  app haga nada. `FakeWallet` contesta siempre la misma, que es justo lo que acá no sirve. */
  class WalletQueCambiaDeCuenta extends FakeWallet {
    constructor(public actual: string) {
      super();
    }
    override async connect(): Promise<string> {
      return this.actual;
    }
    override async getAddress(): Promise<string | null> {
      return this.actual;
    }
  }

  it("T-354-4c: cambiada la cuenta activa, el KYC recordado y el `ensure` salen con la cuenta NUEVA", async () => {
    const wallet = new WalletQueCambiaDeCuenta(ADDR);
    const store = new FakeKycStore();
    await store.save(ADDR, kyc("did-de-A")); // A verificada
    await store.save(B, kyc("did-de-B")); // B TAMBIÉN verificada, con otro identificador
    const { gw, calls } = spyGateway(USABLE);
    // 🔴 UNA SOLA INSTANCIA, y es lo que hace al test capaz de matar el mutante que dice matar
    // (CR/MNR-2). Con dos `new ConnectWallet(...)` —una por paso— el candado medía dos objetos
    // recién nacidos, y producción construye UNO solo (`connectWallet`, `../../composition/container.ts:185`).
    // MEDIDO: con `private cached: string | null = null` y `const address = (this.cached ??= await
    // this.wallet.connect())` en el use-case, la versión de dos instancias daba 7 passed; ésta da
    // rojo en (3).
    const uc = new ConnectWallet(wallet, store, gw);

    // (1) con la cuenta de siempre: sale A.
    const primero = esperarConectado(await uc.execute());
    expect(primero.address).toBe(ADDR);
    expect(primero.rememberedKyc?.verificationId).toBe("did-de-A");
    expect(calls.at(-1)?.address).toBe(ADDR);

    // (2) la persona cambia de cuenta en Phantom, sin recargar.
    wallet.actual = B;

    // (3) TODO sale con B: la dirección, el KYC recordado y la consulta del veredicto. Un cache de la
    //     primera dirección haría que el KYC de A viaje bajo la sesión de B.
    const segundo = esperarConectado(await uc.execute());
    expect(segundo.address).toBe(B);
    expect(segundo.rememberedKyc?.verificationId).toBe("did-de-B");
    expect(segundo.rememberedKyc?.verificationId).not.toBe("did-de-A");
    expect(calls.at(-1)?.address).toBe(B);
    expect(calls.at(-1)?.candidate).toBe("did-de-B");
  });

  it("T-354-4c(control): con B SIN verificar, el KYC recordado es null y el `ensure` igual sale con B", async () => {
    // Sin este control, el de arriba podría estar verde por un store que devuelve cualquier cosa.
    const wallet = new WalletQueCambiaDeCuenta(B);
    const store = new FakeKycStore();
    await store.save(ADDR, kyc("did-de-A")); // sólo A está verificada
    const { gw, calls } = spyGateway(USABLE);

    const out = esperarConectado(await new ConnectWallet(wallet, store, gw).execute());

    expect(out.address).toBe(B);
    expect(out.rememberedKyc).toBeNull(); // el KYC de A NO se hereda
    expect(calls.at(-1)?.address).toBe(B);
    expect(calls.at(-1)?.candidate).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-359 · T-067-5 (AC-3) — EL PERMISO DEL VEREDICTO SE CONSIGUE EN EL `connect`
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 POR QUÉ ESTA WAVE NO SE PUEDE SALTEAR, dicho entero. Sin ella, en un teléfono sin extensión
// `pop.prove()` tira, `HttpKycVerdictGateway` contesta `not_asked/pop_declined` EN SILENCIO,
// `ConnectWallet` devuelve `kycProof: undefined`, `/api/kyc/session` crea la sesión de Didit SIN ATAR,
// `app/api/kyc/decision/route.ts:100` hace `if (!mapped.vendorData) return;` y NO ESCRIBE FILA, y
// `prepare` contesta 403 `prepare_kyc_verdict_missing` sin ningún respaldo.
// ⚠️ Y NO SE VE: una billetera que YA tiene fila del veredicto cierra igual, así que el bug le pasa a
// cada persona nueva y no aparece en la corrida de quien ya se verificó.
describe("WKH-359 · T-067-5 (AC-3): la prueba de posesión del veredicto, por enlace", () => {
  /** El puerto, con la respuesta que el test necesita. Registra cada pedido con su propósito. */
  function popFalso(respuesta: PruebaPorEnlace) {
    const llamadas: Array<{ proposito: string; direccion: string }> = [];
    return {
      llamadas,
      pop: {
        pedir(input: { proposito: "pop-payout" | "pop-kyc"; direccion: string }) {
          llamadas.push(input);
          return Promise.resolve(respuesta);
        },
      },
    };
  }

  // 🔴 MUTANTE QUE MATA (el del Story File): envolver el paso nuevo en el `try` que rodea a `ensure()`.
  // Ese `catch` se traga TODO lo que salga del gateway —a propósito, y ⛔ NO se estrecha (CD-17)—, así
  // que la suspensión moriría ahí y `execute()` devolvería `{estado:"listo"}` con `serverVerdict` y
  // `kycProof` en `undefined`: exactamente el bug de arriba, y en silencio.
  it("T-067-5: invocación 1 ⇒ suspensión que ATRAVIESA el `catch`, y `ensure` NO se llamó", async () => {
    const { gw, calls } = spyGateway(USABLE);
    const { pop, llamadas } = popFalso({ estado: "hay-que-salir", irA: "https://phantom.app/ul/v1/signMessage?y=2" });

    const r = await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw, pop).execute();

    expect(r).toEqual({
      estado: "hay-que-salir",
      address: ADDR,
      irA: "https://phantom.app/ul/v1/signMessage?y=2",
      esperando: "firma-pop-kyc",
    });
    expect(calls, "se consultó el veredicto sin permiso: eso vuelve `not_asked` y deja la sesión sin atar").toHaveLength(0);
    expect(llamadas[0]?.proposito, "un permiso del payout no autoriza el veredicto (CD-15)").toBe("pop-kyc");
    expect(llamadas[0]?.direccion, "se pidió el permiso para otra cuenta que la que conectó").toBe(ADDR);
  });

  // 🔴 LA INVOCACIÓN 2, que es la que cierra el eslabón: la prueba conseguida llega a `ensure` y de ahí
  // sale `kycProof`, que es lo que ata la sesión de Didit.
  // MUTANTE QUE MATA: no propagar `yaConseguida` al `ensure()` ⇒ el gateway le pediría otra al bridge,
  // que en un móvil está vacío, y volvería `not_asked/pop_declined`.
  it("T-067-5b: invocación 2 ⇒ la prueba llega a `ensure` y `kycProof` sale presente", async () => {
    const { gw, calls } = spyGateway(USABLE);
    const proof = { challenge: "ch-del-enlace", signature: "sig-del-enlace" };
    const { pop } = popFalso({ estado: "listo", proof });

    const r = esperarConectado(await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw, pop).execute());

    expect(calls).toHaveLength(1);
    expect(
      calls[0]?.yaConseguida,
      "la prueba no llegó al gateway: va a pedirle otra al bridge, que en un móvil está vacío",
    ).toEqual(proof);
    expect(r.serverVerdict?.outcome).toBe("usable");
    expect(r.kycProof, "sin esto la sesión de Didit se crea SIN ATAR y no se escribe fila").toEqual({
      challenge: "ch-1",
      signature: "sig-1",
    });
  });

  // ⛔ AC-8 — con el puerto contestando `no-corresponde` (camino inyectado) esto corre exactamente como
  // antes de la HU. MUTANTE QUE MATA: tratar `no-corresponde` como una suspensión o como un corte.
  it("T-067-5c (AC-8): `no-corresponde` ⇒ el camino de siempre, sin una línea nueva", async () => {
    const { gw, calls } = spyGateway(USABLE);
    const { pop } = popFalso({ estado: "no-corresponde" });

    const r = esperarConectado(await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw, pop).execute());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.yaConseguida, "se inventó una prueba en el camino inyectado").toBeUndefined();
    expect(r.serverVerdict?.outcome).toBe("usable");
    expect(r.kycProof).toEqual({ challenge: "ch-1", signature: "sig-1" });
  });

  // ⛔ Y el fail del emisor NO puede impedir conectar (es la CD-15 que este use-case ya tenía escrita):
  // `no-se-puede` sigue por el camino de hoy. Quien corta de verdad es el SERVIDOR, con 403.
  it("`no-se-puede` (emisor 501) NO impide conectar: sigue por el camino de hoy", async () => {
    const { gw, calls } = spyGateway(USABLE);
    const { pop } = popFalso({ estado: "no-se-puede", causa: "payout_pop_unavailable" });

    const r = esperarConectado(await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw, pop).execute());

    expect(r.address, "un emisor apagado dejó a la persona sin poder ni conectar").toBe(ADDR);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.yaConseguida).toBeUndefined();
  });

  // 🔴 T-067-23 (fix-pack · AR/BLQ-BAJO-3) — SI `ensure()` TIRA, LA PRUEBA RECIÉN FIRMADA NO SE TIRA
  // A LA BASURA. La prueba del PoP por enlace es de UN SOLO USO: (`leerPruebaPop`,
  // `../../infrastructure/solana/deeplink/pop-por-enlace.ts:398`) borra el ancla ANTES de devolver
  // (CD-15). O sea que cuando el `fetch` de `/api/kyc/verdict` revienta, la persona YA hizo el viaje
  // redondo y YA firmó, y esa firma no se puede recuperar de ningún lado. Asignando `kycProof` dentro
  // del `try` quedaba `undefined` ⇒ sesión de Didit SIN ATAR ⇒ sin fila del veredicto ⇒ 403
  // `prepare_kyc_verdict_missing`: la misma cadena que esta HU cierra, entrando por otra puerta.
  //
  // MUTANTE QUE MATA: borrar el `kycProof = yaConseguida;` del `catch` de `connect-wallet.ts`.
  it("T-067-23: `ensure()` que TIRA no se lleva puesta la prueba que la persona ya firmó", async () => {
    const { gw, calls } = spyGateway(USABLE, { throws: true });
    const proof = { challenge: "ch-del-enlace", signature: "sig-del-enlace" };
    const { pop } = popFalso({ estado: "listo", proof });

    const r = esperarConectado(await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw, pop).execute());

    // CD-18 — el fixture fabricó el caso: el gateway se llamó, recibió la prueba, y TIRÓ.
    expect(calls, "el gateway ni se llamó: este `it` no está midiendo el `catch`").toHaveLength(1);
    expect(calls[0]?.yaConseguida).toEqual(proof);
    // ⛔ El veredicto SÍ se pierde, y está bien: el gateway falló, no sabemos nada de él.
    expect(r.serverVerdict, "se inventó un veredicto que el gateway nunca contestó").toBeUndefined();
    // 🔴 Y la prueba NO: es lo único que ya teníamos antes de llamarlo.
    expect(
      r.kycProof,
      "la firma de la persona se descartó en silencio: el ancla ya se borró, no se recupera, y la " +
        "sesión de Didit se va a crear SIN ATAR",
    ).toEqual(proof);
    expect(r.address, "un gateway caído dejó a la persona sin poder ni conectar (CD-15)").toBe(ADDR);
  });

  // ⛔ LA CALIBRACIÓN, en la dirección contraria: sin prueba conseguida, un `ensure()` que tira sigue
  // dejando `kycProof` en `undefined`. El `catch` conserva lo que YA había, no fabrica nada.
  it("CALIBRACIÓN: sin permiso conseguido, el `catch` no inventa ninguna prueba", async () => {
    const { gw, calls } = spyGateway(USABLE, { throws: true });
    const { pop } = popFalso({ estado: "no-corresponde" });

    const r = esperarConectado(await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw, pop).execute());

    expect(calls).toHaveLength(1);
    expect(r.kycProof, "el `catch` fabricó una prueba que nadie firmó").toBeUndefined();
    expect(r.serverVerdict).toBeUndefined();
  });

  // Refutación del conjunto: SIN el puerto cableado, el use-case se comporta como antes de esta HU.
  it("sin el puerto inyectado, el comportamiento es el de antes de la HU", async () => {
    const { gw, calls } = spyGateway(USABLE);
    const r = esperarConectado(await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw).execute());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.yaConseguida).toBeUndefined();
    expect(r.kycProof).toEqual({ challenge: "ch-1", signature: "sig-1" });
  });
});
