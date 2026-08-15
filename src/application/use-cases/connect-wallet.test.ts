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
import type { KycVerdictEnsureResult, KycVerdictGateway } from "../ports";
import { FAKE_WALLET_ADDRESS, FakeKycStore, FakeWallet } from "../../test-support/fakes";
import { toPersistedIdentity } from "../../domain/remittance";
import { ConnectWallet } from "./connect-wallet";

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
  const calls: Array<{ address: string; candidate?: string }> = [];
  const gw: KycVerdictGateway = {
    async ensure(address, candidate) {
      calls.push({ address, candidate });
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

    const out = await new ConnectWallet(wallet, store, gw).execute();

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
    const out = await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw).execute();
    expect(calls).toEqual([{ address: ADDR, candidate: undefined }]);
    expect(out.serverVerdict).toEqual({ outcome: "absent", reason: "absent" });
  });

  // ── T-CW-2 — M-20 ──────────────────────────────────────────────────────────────────────────────
  it("T-CW-2: si `ensure` TIRA, conectar devuelve igual y el flujo sigue (M-20)", async () => {
    const { gw } = spyGateway({ lookup: { outcome: "absent", reason: "absent" } }, { throws: true });
    const out = await new ConnectWallet(new FakeWallet(), new FakeKycStore(), gw).execute();
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
    const out = await new ConnectWallet(new FakeWallet(), store, gw).execute();
    expect(out.address).toBe(ADDR);
    expect(calls).toEqual([{ address: ADDR, candidate: undefined }]);
  });

  // ── Sin gateway: byte-idéntico a antes de la HU ────────────────────────────────────────────────
  it("sin gateway cableado, `execute` se comporta EXACTAMENTE como antes (AC-12)", async () => {
    const store = new FakeKycStore();
    await store.save(ADDR, kyc());
    const out = await new ConnectWallet(new FakeWallet(), store).execute();
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

    // (1) con la cuenta de siempre: sale A.
    const primero = await new ConnectWallet(wallet, store, gw).execute();
    expect(primero.address).toBe(ADDR);
    expect(primero.rememberedKyc?.verificationId).toBe("did-de-A");
    expect(calls.at(-1)?.address).toBe(ADDR);

    // (2) la persona cambia de cuenta en Phantom, sin recargar.
    wallet.actual = B;

    // (3) TODO sale con B: la dirección, el KYC recordado y la consulta del veredicto. Un cache de la
    //     primera dirección haría que el KYC de A viaje bajo la sesión de B.
    const segundo = await new ConnectWallet(wallet, store, gw).execute();
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

    const out = await new ConnectWallet(wallet, store, gw).execute();

    expect(out.address).toBe(B);
    expect(out.rememberedKyc).toBeNull(); // el KYC de A NO se hereda
    expect(calls.at(-1)?.address).toBe(B);
    expect(calls.at(-1)?.candidate).toBeUndefined();
  });
});
