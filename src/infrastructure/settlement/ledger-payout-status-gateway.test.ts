// Tests — LedgerPayoutStatusGateway (WKH-337). El candado de la GARANTÍA de la HU: ninguna rama de
// error puede producir un desenlace terminal.
//
// 🔴 POR QUÉ ESTO ES UN CANDADO DE DINERO Y NO UN TEST DE ROBUSTEZ. `settled` no está en `RECOVERABLE`
// (`RECOVERABLE`, `../../application/use-cases/recover-escrow-funds.ts:40`) y no tiene transición de
// salida: el guard corta con `refund_not_available`. Antes de esta HU un `settled` de más era cosmético
// —ninguna remesa llegaba a `settled` por polling— y DESPUÉS de esta HU es una pérdida irreversible: le
// quita al remitente su único camino a sus USDC. Así que "el gateway no fabrica terminales" no es una
// propiedad deseable: es la condición para que la capacidad nueva se pueda encender.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock, PopProof, PopProofReader } from "../../application/ports";
import { LedgerPayoutStatusGateway } from "./ledger-payout-status-gateway";

const ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAYOUT = "transfi-1";
const PROOF: PopProof = { challenge: "ch-1", signature: "sig-1" };

class RelojFijo implements Clock {
  constructor(private ms = Date.parse("2026-08-08T12:00:00.000Z")) {}
  nowIso(): string {
    return new Date(this.ms).toISOString();
  }
  avanzar(ms: number): void {
    this.ms += ms;
  }
}
/** Lector de pruebas. NO tiene `prove` — es el tipo el que impide que el gateway pida una firma. */
const lector = (proof: PopProof | null): PopProofReader => ({ peek: () => proof });
const wallet = (address: string | null) => ({ getAddress: async () => address });

function gateway(opts: {
  proof?: PopProof | null;
  address?: string | null;
  reloj?: RelojFijo;
}): LedgerPayoutStatusGateway {
  return new LedgerPayoutStatusGateway(
    wallet(opts.address === undefined ? ADDR : opts.address),
    lector(opts.proof === undefined ? PROOF : opts.proof),
    opts.reloj ?? new RelojFijo(),
  );
}
function stubFetch(fn: (url: string, init?: RequestInit) => Promise<Response>) {
  const mock = vi.fn(fn);
  vi.stubGlobal("fetch", mock);
  return mock;
}
const ok = (body: unknown) => Response.json(body, { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── El camino que la HU construye ────────────────────────────────────────────────────────────────────
describe("LedgerPayoutStatusGateway — el único camino a un terminal (AC-1)", () => {
  it("known/settled ⇒ settled, con deliveredPen y txRef en null y la provenance DE LA FILA", async () => {
    stubFetch(async () => ok({ payout: { outcome: "known", status: "settled", provenance: "transfi" } }));
    const rec = await gateway({}).status(PAYOUT);
    expect(rec).toEqual({
      payoutId: PAYOUT,
      status: "settled",
      deliveredPen: null,
      txRef: null,
      failureReason: null,
      provenance: "transfi",
    });
  });

  it("AC-4: known/failed ⇒ failed con razón estable (el use-case la usa para el refund-on-failure)", async () => {
    stubFetch(async () => ok({ payout: { outcome: "known", status: "failed", provenance: "transfi" } }));
    const rec = await gateway({}).status(PAYOUT);
    expect(rec.status).toBe("failed");
    expect(rec.failureReason).toBe("payout_failed_provider");
    expect(rec.deliveredPen).toBeNull();
  });

  it("manda el payoutId Y la prueba OBSERVADA (no una que haya pedido: el lector no tiene `prove`)", async () => {
    const f = stubFetch(async () => ok({ payout: { outcome: "unknown", reason: "no_row" } }));
    await gateway({}).status(PAYOUT);
    const llamada = f.mock.calls[0];
    expect(llamada, "el gateway no llamó a la ruta: sin request no hay nada que afirmar").toBeDefined();
    expect(String(llamada?.[0])).toBe("/api/payout/status");
    expect(JSON.parse(String((llamada?.[1] as RequestInit | undefined)?.body))).toEqual({
      sender: ADDR,
      payoutId: PAYOUT,
      popChallenge: PROOF.challenge,
      popSignature: PROOF.signature,
    });
  });
});

// ── 🔴 T-337.2 (AC-2) · los OCHO desenlaces degradados. En ninguno hay un terminal ──────────────────
describe("T-337.2 (AC-2): toda degradación cae al NO-TERMINAL, jamás a settled/failed", () => {
  const CASOS: Array<[string, () => void, { proof?: PopProof | null }]> = [
    ["`fetch` que RECHAZA (la red se cayó)", () => stubFetch(async () => { throw new Error("network"); }), {}],
    ["429 rate-limited", () => stubFetch(async () => Response.json({ error: "x" }, { status: 429 })), {}],
    ["501 el ledger está apagado", () => stubFetch(async () => Response.json({ error: "x" }, { status: 501 })), {}],
    ["403 la prueba no verificó", () => stubFetch(async () => Response.json({ error: "x" }, { status: 403 })), {}],
    ["502 el ledger tiró", () => stubFetch(async () => Response.json({ error: "x" }, { status: 502 })), {}],
    ["200 con JSON ilegible", () => stubFetch(async () => new Response("no soy json", { status: 200 })), {}],
    ["200 con outcome:'unknown'", () => stubFetch(async () => ok({ payout: { outcome: "unknown", reason: "not_terminal" } })), {}],
    ["SIN prueba grabada (no se pide ninguna)", () => stubFetch(async () => ok({ payout: { outcome: "known", status: "settled", provenance: "transfi" } })), { proof: null }],
  ];

  it.each(CASOS)("%s ⇒ submitted, deliveredPen null, txRef null, y NUNCA settled/failed", async (_n, arm, opts) => {
    arm();
    const rec = await gateway(opts).status(PAYOUT);
    expect(rec.status).toBe("submitted");
    expect(rec.status).not.toBe("settled");
    expect(rec.status).not.toBe("failed");
    expect(rec.deliveredPen).toBeNull();
    expect(rec.txRef).toBeNull();
    // 🔴 Y la provenance NO puede ser `""`: `isPayoutDemo("")` es `true`, así que un `""` que llegara al
    // agregado prendería "Modo demo" sobre una remesa real (DT-6).
    expect(rec.provenance).not.toBe("");
  });

  it("y NUNCA lanza: el use-case no puede recibir una promesa rechazada (money-path fail-safe uniforme)", async () => {
    for (const [, arm, opts] of CASOS) {
      arm();
      await expect(gateway(opts).status(PAYOUT)).resolves.toBeDefined();
      vi.unstubAllGlobals();
    }
  });

  it("el caso SIN prueba no toca la red: si no hay qué presentar, no se pide nada (R-1)", async () => {
    const f = stubFetch(async () => ok({ payout: { outcome: "known", status: "settled", provenance: "transfi" } }));
    const rec = await gateway({ proof: null }).status(PAYOUT);
    expect(f).not.toHaveBeenCalled();
    expect(rec.failureReason).toBe("payout_status_no_proof");
    expect(rec.status).toBe("submitted");
  });

  it("sin billetera conectada ⇒ no-terminal, y tampoco toca la red", async () => {
    const f = stubFetch(async () => ok({ payout: { outcome: "known", status: "settled", provenance: "transfi" } }));
    const rec = await gateway({ address: null }).status(PAYOUT);
    expect(f).not.toHaveBeenCalled();
    expect(rec.failureReason).toBe("payout_status_no_wallet");
    expect(rec.status).toBe("submitted");
  });

  // M6 · un contrato que cambia no puede convertirse en un settled fabricado.
  it("M6: un body 200 SIN la clave `payout`, o con un `outcome` desconocido, es no-terminal", async () => {
    for (const body of [{}, { payout: null }, { payout: { outcome: "quizas" } }, { payout: { outcome: "known" } }, { payout: { outcome: "known", status: "en_camino", provenance: "transfi" } }]) {
      stubFetch(async () => ok(body));
      const rec = await gateway({}).status(PAYOUT);
      expect(rec.status, `body=${JSON.stringify(body)}`).toBe("submitted");
      vi.unstubAllGlobals();
    }
  });
});

// ── 🔴 T-337.3 (AC-3) · las proveniencias que NO habilitan un terminal ───────────────────────────────
// El server ya filtra por la allowlist, así que la ruta devuelve `unknown/provenance_not_real` para
// todas éstas. Lo que este test custodia es que el CLIENTE no las re-interprete: los cinco valores van
// con `status:'settled'` en la fila, o sea con la remesa ya terminal en el ledger, y aun así el
// desenlace tiene que ser no-terminal.
//
// `null` es el caso MEDIDO en `bdwv`: toda remesa vieja lo trae, y NO es "simulada" ni "real" — el dato
// no se guardó y la migración dice que no se puede backfillear. `"TransFi"` con mayúscula es el caso que
// la comparación EXACTA rechaza a propósito (`REAL_PAYOUT_PROVENANCES`, `../../presentation/flow-vm.ts:25`).
describe("T-337.3 (AC-3): una proveniencia que no está en la allowlist no puede liquidar nada", () => {
  it.each([[null], ["local-fallback"], ["devnet-stub"], ["TransFi"], [""]])(
    "payout_provenance=%s (con la fila en 'settled') ⇒ el gateway devuelve no-terminal",
    async (prov) => {
      // Lo que el server contesta para cada uno de estos valores, por la membresía POSITIVA.
      stubFetch(async () => ok({ payout: { outcome: "unknown", reason: "provenance_not_real" } }));
      const rec = await gateway({}).status(PAYOUT);
      expect(rec.status).toBe("submitted");
      expect(rec.provenance).not.toBe(prov ?? ""); // no se propaga la proveniencia no-real
      expect(rec.provenance).not.toBe("");
    },
  );

  it("y si el server AFIRMARA `known` con una proveniencia de demo, el gateway la propaga TAL CUAL sin inventar", async () => {
    // Este caso no lo puede producir la ruta (filtra antes), y se mide igual: lo que NO puede pasar es
    // que el cliente rellene un default. Si algún día el server cambia, el valor que viaja es el suyo.
    stubFetch(async () => ok({ payout: { outcome: "known", status: "settled", provenance: "local-fallback" } }));
    const rec = await gateway({}).status(PAYOUT);
    expect(rec.provenance).toBe("local-fallback");
  });
});

// ── 🔴 T-337.10 · el throttle, con su aritmética ────────────────────────────────────────────────────
describe("T-337.10: el throttle de 20 s (el poll tiene tick de 1,5 s)", () => {
  it("10 llamadas en 15 s ⇒ UNA sola request; avanzando a 20 s ⇒ DOS", async () => {
    const reloj = new RelojFijo();
    const f = stubFetch(async () => ok({ payout: { outcome: "unknown", reason: "not_terminal" } }));
    const gw = gateway({ reloj });
    // 10 ticks de 1,5 s = 13,5 s: el patrón real del `setInterval` de la pantalla.
    for (let i = 0; i < 10; i++) {
      await gw.status(PAYOUT);
      reloj.avanzar(1500);
    }
    expect(f, "sin throttle serían 10 requests en 15 s, o 400 en una sesión de 10 min").toHaveBeenCalledTimes(1);
    // A los 15 s ya pasaron; hay que llegar a 20 desde la ÚNICA lectura real (t=0).
    reloj.avanzar(20_000 - 15_000);
    await gw.status(PAYOUT);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("dentro de la ventana devuelve EL MISMO record, no uno nuevo cada vez", async () => {
    const reloj = new RelojFijo();
    stubFetch(async () => ok({ payout: { outcome: "known", status: "settled", provenance: "transfi" } }));
    const gw = gateway({ reloj });
    const a = await gw.status(PAYOUT);
    reloj.avanzar(1500);
    const b = await gw.status(PAYOUT);
    expect(b).toEqual(a);
  });

  it("los NO-terminales también se cachean: un ledger caído no puede producir un reintento cada 1,5 s", async () => {
    const reloj = new RelojFijo();
    const f = stubFetch(async () => Response.json({ error: "x" }, { status: 502 }));
    const gw = gateway({ reloj });
    for (let i = 0; i < 5; i++) {
      await gw.status(PAYOUT);
      reloj.avanzar(1500);
    }
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("las ramas que no tocan la red NO arman el caché: en cuanto aparece una prueba, se lee", async () => {
    // Sin prueba no hay request y tampoco hay nada que cachear; si esa rama memoizara, el primer gesto
    // de la persona quedaría sin efecto hasta 20 s después.
    const reloj = new RelojFijo();
    const f = stubFetch(async () => ok({ payout: { outcome: "known", status: "settled", provenance: "transfi" } }));
    let proof: PopProof | null = null;
    const gw = new LedgerPayoutStatusGateway(wallet(ADDR), { peek: () => proof }, reloj);
    expect((await gw.status(PAYOUT)).status).toBe("submitted");
    expect(f).not.toHaveBeenCalled();
    proof = PROOF; // el gesto
    reloj.avanzar(1500); // MENOS que el throttle
    expect((await gw.status(PAYOUT)).status).toBe("settled");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("submit() — el puerto lo declara, la producción no lo llama (R-3)", () => {
  it("tira un enum estable y PII-free: no hay ruta de submit desde el cliente (WKH-320 la borró)", async () => {
    await expect(
      gateway({}).submit({} as unknown as Parameters<LedgerPayoutStatusGateway["submit"]>[0]),
    ).rejects.toThrow("ledger_payout_status_gateway_is_read_only");
  });
});
