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

  // 🔴 AR/MNR-1 — el `provenance` se valida IGUAL que el `outcome` y el `status`. Defender dos de los
  // tres campos y no el tercero es la asimetría que abre la puerta, y la puerta da al mismo lugar que
  // DT-6: `isPayoutDemo(123)` es `true` (`123 != null` ✓ y `!has(123)` ✓), así que un `provenance`
  // numérico propagado al agregado prendería "Modo demo" sobre una remesa REAL y liquidada.
  it("AR/MNR-1 + CR/MNR-4: un `provenance` que no está en la ALLOWLIST ⇒ no-terminal, y NO se propaga", async () => {
    // CR/MNR-4: se agregan los que pasan el filtro de TIPO y NO están en la allowlist. "TransFi" con
    // mayúscula es el caso que la comparación exacta rechaza a propósito, y el que medía el CR.
    for (const provenance of [123, null, undefined, "", true, {}, ["transfi"], "TransFi", "transfi ", "local-fallback", "TRANSFI"]) {
      stubFetch(async () => ok({ payout: { outcome: "known", status: "settled", provenance } }));
      const rec = await gateway({}).status(PAYOUT);
      expect(rec.status, `provenance=${JSON.stringify(provenance)}`).toBe("submitted");
      expect(typeof rec.provenance, "el record siempre lleva una proveniencia STRING").toBe("string");
      expect(rec.provenance).not.toBe("");
      // Y lo que importa de verdad: lo que llegue al agregado no puede encender el banner de demo por
      // ser de un tipo que nadie validó.
      expect(rec.provenance).not.toBe(provenance);
      vi.unstubAllGlobals();
    }
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
// la comparación EXACTA rechaza a propósito (`REAL_PAYOUT_PROVENANCES`, `../../domain/payout-provenance.ts:20`).
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

  // 🔴 CR/MNR-4 — ESTE `it` CAMBIÓ DE PREGUNTA, Y HACIA EL LADO SEGURO. Antes decía: "si el server
  // AFIRMARA `known` con una proveniencia de demo, el gateway la propaga TAL CUAL sin inventar", y
  // asertaba `rec.provenance === "local-fallback"`. Con la validación contra la allowlist ese caso ya no
  // llega a `known`: se RECHAZA.
  //
  // CD-11 · «¿qué mutante dejaría de morir si lo cambio así?» El mutante que el assert viejo mataba era
  // *"el cliente rellena un default en vez de usar el valor del server"* (p. ej. hardcodear `"transfi"`).
  // **Sigue muriendo, y con MÁS fuerza**: ahora se assertea que el record NO trae la proveniencia ajena
  // (no la propaga) **Y** que NO trae una de la allowlist (no la inventa) **Y** que el desenlace es
  // no-terminal. El `it` quedó igual de fuerte o más, no más corto — que es la señal de que el cambio es
  // el correcto.
  it("una proveniencia de demo en un `known` del server se RECHAZA: ni se propaga ni se inventa otra", async () => {
    stubFetch(async () => ok({ payout: { outcome: "known", status: "settled", provenance: "local-fallback" } }));
    const rec = await gateway({}).status(PAYOUT);
    expect(rec.status, "un desembolso que no podemos afirmar real no puede liquidar la remesa").toBe("submitted");
    expect(rec.provenance, "no se propaga la proveniencia ajena").not.toBe("local-fallback");
    expect(rec.provenance, "y NO se rellena un default de la allowlist: eso sería inventar").not.toBe("transfi");
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

// ── 🔴 AR/BLQ-ALTO-1 · LO MEMOIZADO PERTENECE A LO QUE SE PIDIÓ ─────────────────────────────────────
//
// LA PROPIEDAD QUE NO ESTABA ASERTADA EN NINGUNA PARTE, y por eso el bug pasó los cuatro tests de
// T-337.10: todos usaban UN SOLO `payoutId`. Con un memo de un casillero sin clave, el throttle devolvía
// el record de la remesa anterior a la siguiente que preguntara dentro de los 20 s.
//
// El daño MEDIDO, al nivel del use-case y con UNA instancia (como la cablea `container.ts:127`):
//   R1 → known/settled ⇒ R1 `settled`; un tick de 1500 ms; R2 → unknown/not_terminal ⇒ **R2 `settled`**,
//   `fetches=1`, y `RecoverEscrowFunds({R2})` ⇒ `refund_not_available`. O sea el remitente de R2 se
//   quedaba sin camino a sus USDC PARA SIEMPRE, con la pantalla diciendo "Entregado".
//
// ⛔ Estos dos `it` son el candado de esa propiedad. El mutante que saca cualquiera de los dos
// componentes de la clave (`payoutId` o `address` en `claveDe`) tiene que ponerlos ROJOS.
describe("AR/BLQ-ALTO-1: el memo del throttle está indexado por (address, payoutId)", () => {
  it("dos payoutId DISTINTOS contra UNA instancia: el segundo NO hereda el desenlace del primero", async () => {
    const reloj = new RelojFijo();
    // El doble contesta SEGÚN el payoutId que se le pide: si el gateway no discrimina, el segundo
    // `status()` devuelve el record del primero sin que el doble se entere.
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      const { payoutId } = JSON.parse(String((init as RequestInit).body)) as { payoutId: string };
      return payoutId === "payout-A"
        ? ok({ payout: { outcome: "known", status: "settled", provenance: "transfi" } })
        : ok({ payout: { outcome: "unknown", reason: "not_terminal" } });
    });
    vi.stubGlobal("fetch", f);
    const gw = gateway({ reloj });

    expect((await gw.status("payout-A")).status).toBe("settled");
    reloj.avanzar(1500); // UN tick del `setInterval` de la pantalla, MUY por debajo del throttle
    const b = await gw.status("payout-B");

    expect(
      b.status,
      "el segundo payout HEREDÓ el desenlace del primero: el memo no está indexado, y un `settled` " +
        "heredado es irreversible (no está en RECOVERABLE)",
    ).toBe("submitted");
    expect(b.payoutId).toBe("payout-B"); // y el record habla del payout que se pidió
    expect(f, "cada payout distinto tiene que producir su propia lectura").toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("dos ADDRESSES distintas contra UNA instancia: cambiar de billetera no devuelve el record de la anterior", async () => {
    // La segunda cara del defecto: el chequeo de billetera estaba DESPUÉS del throttle, así que el
    // record de la wallet A se devolvía a la wallet B. Hoy la address es parte de la clave, y por eso
    // hay que resolverla ANTES de consultar el memo.
    const reloj = new RelojFijo();
    const OTRA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      const { sender } = JSON.parse(String((init as RequestInit).body)) as { sender: string };
      return sender === ADDR
        ? ok({ payout: { outcome: "known", status: "settled", provenance: "transfi" } })
        : ok({ payout: { outcome: "unknown", reason: "no_row" } });
    });
    vi.stubGlobal("fetch", f);
    let quien = ADDR;
    const gw = new LedgerPayoutStatusGateway(
      { getAddress: async () => quien },
      lector(PROOF),
      reloj,
    );

    expect((await gw.status(PAYOUT)).status).toBe("settled");
    quien = OTRA; // la persona cambió de billetera en Phantom, sin recargar
    reloj.avanzar(1500);

    expect(
      (await gw.status(PAYOUT)).status,
      "la billetera nueva recibió el desenlace de la anterior: el memo ignora de quién era",
    ).toBe("submitted");
    expect(f).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("y el throttle SIGUE funcionando por clave: el MISMO par (address, payoutId) no re-lee", async () => {
    // El control que impide "arreglarlo" borrando el memo: si esto se pone rojo, volvieron los 400
    // requests por sesión.
    const reloj = new RelojFijo();
    const f = stubFetch(async () => ok({ payout: { outcome: "unknown", reason: "not_terminal" } }));
    const gw = gateway({ reloj });
    for (let i = 0; i < 10; i++) {
      await gw.status(PAYOUT);
      reloj.avanzar(1500);
    }
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

// ── 🔴 T-337.8 (estático, AC-6) · los docblocks del payout, y el barrido por ARGUMENTO ──────────────
//
// QUÉ CUSTODIA, EN UNA LÍNEA: que ningún comentario del camino de payout siga afirmando que la lectura
// del desenlace está PENDIENTE, y que los tres sigan conteniendo la cláusula fail-safe que esta HU
// hereda en vez de superar.
//
// 🔴 EL UNIVERSO SE DERIVA, NO SE ESCRIBE A MANO (CD-10). Escribir acá los tres nombres de archivo sería
// exactamente el punto ciego que esta familia de HUs ya pagó tres veces: la lista no cubre el adapter que
// alguien agregue mañana. El criterio es "toda implementación de `PayoutGateway` del árbol, más el
// composition root", y eso se calcula leyendo el árbol.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

describe("T-337.8 (estático, AC-6): ningún docblock del payout deja la lectura como pendiente", () => {
  const RAIZ = process.cwd();
  const leer = (rel: string) => readFileSync(path.resolve(RAIZ, rel), "utf8");
  function tsDe(dir: string, acc: string[] = []): string[] {
    for (const e of readdirSync(path.resolve(RAIZ, dir))) {
      const rel = `${dir}/${e}`;
      if (statSync(path.resolve(RAIZ, rel)).isDirectory()) {
        if (e !== "node_modules") tsDe(rel, acc);
      } else if (e.endsWith(".ts") && !e.endsWith(".test.ts")) acc.push(rel);
    }
    return acc;
  }
  // ⚠️ EL CRITERIO SE AJUSTÓ PORQUE EL BARRIDO ENCONTRÓ UN CASO QUE NO IMAGINÉ, y eso es la prueba de
  // que derivar era lo correcto: la primera versión devolvía CUATRO archivos, y el cuarto era
  // `src/test-support/fakes.ts` (`FakePayoutGateway`). Un doble de test no tiene que documentar el
  // razonamiento fail-safe de producción — no lo aplica, lo simula para un test. El criterio queda
  // "implementaciones de PRODUCCIÓN", que sigue siendo un criterio y no una lista: excluye el directorio
  // de dobles, no tres nombres de archivo.
  const IMPLEMENTACIONES = tsDe("src")
    .filter((f) => leer(f).includes("implements PayoutGateway"))
    .filter((f) => !f.startsWith("src/test-support/"));
  const UNIVERSO = [...IMPLEMENTACIONES, "src/composition/container.ts"];

  it("el universo derivado no se vació: 3 implementaciones de producción + el composition root", () => {
    // Sin este piso, un rename de la interfaz dejaría `IMPLEMENTACIONES` en [] y los `it.each` de abajo
    // no correrían NINGÚN caso — verde aplaudiendo el vacío, que es la forma en que un barrido deja de
    // existir sin ponerse rojo.
    expect(IMPLEMENTACIONES.length, `derivadas: ${IMPLEMENTACIONES.join(", ")}`).toBe(3);
    expect(IMPLEMENTACIONES).toContain("src/infrastructure/settlement/ledger-payout-status-gateway.ts");
  });

  // El criterio, no una frase: `Fase A` es como este repo nombra "esto lo hace otra fase, todavía no
  // está". Después de WKH-337 la lectura del desenlace SÍ está, así que ninguna de estas superficies
  // puede seguir remitiendo a una fase futura para explicarla.
  it.each(UNIVERSO)("%s no remite a una fase futura para la lectura del desenlace", (rel) => {
    const lineas = leer(rel).split("\n");
    const culpables = lineas
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /\bFase\s+A\b/.test(l));
    expect(
      culpables.map(([n, l]) => `${rel}:${n} «${l.trim().slice(0, 90)}»`),
      "esta superficie sigue diciendo que la lectura del payout la trae una fase posterior, y ya no es " +
        "cierto: la construyó WKH-337",
    ).toEqual([]);
  });

  // ⚠️ Y NO ALCANZA CON QUITAR LA FRASE VIEJA: quitarla deja el docblock describiendo un mundo donde la
  // lectura no existe, sin decir dónde está. Los adapters SUPERSEDIDOS (toda implementación de
  // producción que NO sea la del ledger — derivado, no una lista) tienen que NOMBRAR la que sí se cablea,
  // porque son el lugar donde va a aterrizar quien busque por qué el seguimiento no settlea.
  it.each(IMPLEMENTACIONES.filter((f) => !f.endsWith("ledger-payout-status-gateway.ts")))(
    "%s nombra la lectura que SÍ se cablea (un docblock sin la frase vieja pero sin destino no ayuda)",
    (rel) => {
      expect(
        leer(rel),
        `${rel} ya no dice que esté pendiente, pero tampoco dice quién lo hace: quien llegue acá ` +
          "buscando por qué el seguimiento no settlea se queda sin el próximo paso",
      ).toContain("LedgerPayoutStatusGateway");
    },
  );

  // La otra mitad, y es la que impide que "actualizar el comentario" se convierta en BORRARLO. El
  // razonamiento fail-safe no es una limitación superada: es la garantía que protege el principal, y
  // protege MÁS ahora que `settled` es alcanzable e irreversible.
  it.each(IMPLEMENTACIONES)("%s CONSERVA la cláusula fail-safe (no saber ≠ falló, ≠ entregó)", (rel) => {
    const texto = leer(rel);
    // Se pide la forma del ARGUMENTO —"no saber no es evidencia" + "no-terminal"— no una frase exacta,
    // para que reescribir la prosa esté permitido y borrar el razonamiento no lo esté.
    expect(
      /no\s+saber[^.]{0,120}(NO\s+es\s+evidencia|no\s+es\s+evidencia)/i.test(texto) ||
        /NO\s+es\s+evidencia[^.]{0,120}(entrega|fall)/i.test(texto),
      `${rel} perdió la cláusula "no saber NO es evidencia": sin ella, la próxima persona que toque ` +
        "este archivo no tiene cómo saber por qué está prohibido fabricar un terminal",
    ).toBe(true);
    expect(
      /no[-\s]terminal/i.test(texto),
      `${rel} ya no nombra el estado NO-TERMINAL, que es la dirección segura de todo este camino`,
    ).toBe(true);
  });
});
