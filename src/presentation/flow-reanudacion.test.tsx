// @vitest-environment jsdom
// WKH-358 / OLA 4 · LA VUELTA DEL SALTO: REANUDAR SIN PISAR, Y DEJAR LA BARRA LIMPIA (AC-3 + AC-4).
//
// 🔴 QUÉ MIDE ESTE ARCHIVO. El productor de montaje de `flow.tsx` es el único llamador de producción
// de la vuelta por enlace, y hace TRES cosas en un orden que importa: lee la vuelta, limpia la barra y
// —sólo si se volvió de un paso del motor y la remesa está en `confirmed`— re-invoca
// `confirmAndSend.execute()`. Cada uno de esos tres tiene un modo de falla propio y ninguno se ve
// desde los otros.
//
// ⚠️ POR QUÉ ES UN ARCHIVO APARTE Y NO MÁS `it` EN `flow.test.tsx`: acá el `localStorage` y la BARRA
// del navegador son estado compartido que hay que sembrar y limpiar en cada `it`, y meter eso en un
// archivo de 3200 líneas que no lo necesita es la forma más barata de fabricar un flake.
//
// ⛔ Y LO QUE ESTA HU NO ENTREGA: el depósito por enlace NO cierra. `prepare()` exige un PoP firmado
// por el bridge y en un móvil sin extensión el bridge está vacío ⇒ `payout_pop_unavailable` (WKH-359).
// Lo que estos `it` miden es la MÁQUINA de la vuelta, no que un teléfono la recorra.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import bs58 from "bs58";
import { RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { FakeWallet, InMemoryRepo, RecorridoPorEnlaceNulo, T0, TEST_CCI, beneficiary } from "../test-support/fakes"; import type { Container } from "../composition/container"; import { leerHito } from "./bitacora-de-vuelta"; // HU-075/reanudar: `TEST_CCI` EN ESTA MISMA LINEA, no en una nueva — este archivo recibe citas por numero en `:95`, `:527` y `:575`. HU-075/gesto: el `Container` PEGADO ACÁ por lo mismo, y ⛔ no en una línea nueva
import { type KycVerification, Remittance, toPersistedIdentity } from "../domain/remittance";
import { Money } from "../domain/money";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { RecorridoPorEnlaceReal } from "../infrastructure/solana/preparacion-por-enlace";
import { MARCAS_DE_VUELTA, almacenDeNavegador, guardarViaje } from "../infrastructure/solana/deeplink/sesion";
import { guardarEleccion } from "../infrastructure/solana/deeplink/conexion"; import { TECHO_DISPONIBILIDAD_MS } from "../infrastructure/solana/disponibilidad-decidible"; import { deeplinkEnabled } from "./wallet-availability"; // WKH-075 · fix-pack 1 — LOS DOS PEGADOS A ESTA LÍNEA (Δ0) y ⛔ NO en una nueva: `sembrarVuelta` (`:95`) y `completarPop` (`:575`) reciben citas ancladas desde `../infrastructure/solana/preparacion-por-enlace.test.ts` y `./vuelta-por-enlace-carrera.test.tsx`, y una línea de más acá las rompe a las dos (MEDIDO: el candado `citas-ancladas` las reportó)

// Mismo doble cerrado que `flow.test.tsx`: jsdom no implementa `requestAnimationFrame`, así que sin
// esto el exit de `AnimatePresence` no completa y los pasos nunca montan. Lo que no esté acá NO EXISTE
// para este archivo, y el síntoma es la suite entera del archivo caída, no un `it` suelto.
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
  // 🔴 CACHEA POR TAG, y el caché ES el target del Proxy (WKH-233 it4 · F4/§4.3): un `get` que fabrica en cada acceso da un TIPO de componente distinto por render y React REMONTA el subárbol entero.
  motion: new Proxy({} as Record<string, unknown>, {
    get: (t: Record<string, unknown>, tag: string) => {
      if (!(tag in t))
        t[tag] = ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
          React.createElement(tag, props, children);
      return t[tag];
    },
  }),
}));

const KYC_APROBADO: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true, realVerified: true, verifiedAt: null,
  riskLevel: "low",
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

const DIRECCION = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // la del `FakeWallet`, y la del viaje
const REM = "rem-1";

/** Una remesa que YA pasó por `confirm`: es el único estado en el que AC-3 permite reanudar. */
async function sembrarRemesaConfirmada(repo: InMemoryRepo, estado: "confirmed" | "kyc_passed", dueño: string = DIRECCION) { // WKH-359: el 3er argumento, con default = el de siempre. Los `it` del PoP necesitan una cuenta cuya PRIVADA tengan, para poder firmar de verdad, y el dueño de la remesa tiene que ser ESA misma o el cruce de `flow.tsx:507` corta con `wallet_account_changed`.
  const r = Remittance.create(REM, beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(1478.15, "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt: "2099-01-01T00:00:00.000Z",
      provenance: "fake",
    },
    T0,
  );
  r.startKyc(T0, dueño); // 🔴 esto es lo que escribe `ownerAddress`, la fuente que el enlace NO toca
  r.applyKyc(KYC_APROBADO, T0);
  if (estado === "confirmed") r.confirm(T0);
  await repo.save(r);
  return r;
}

/** Deja este navegador en el estado EXACTO de una vuelta de la billetera: el viaje en el disco, la
 *  elección persistida, `availability === "none"` y la BARRA con la marca del paso. */
function sembrarVuelta(paso: string, extra: Record<string, string> = {}) {
  const almacen = almacenDeNavegador(window.localStorage);
  guardarEleccion(almacen, "phantom");
  solanaWalletBridge.setWalletAvailability("none");
  vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true"); // la 3ª condición del gate del adaptador (fix-pack · AR/BLQ-MED-1): sin ella `caminoPorEnlace()` contesta `null` y esta siembra no describe una vuelta de la billetera
  guardarViaje(almacen, {
    billetera: "phantom",
    secreta: bs58.encode(new Uint8Array(32)),
    publica: bs58.encode(new Uint8Array(32)),
    claveBilletera: bs58.encode(new Uint8Array(32)),
    session: "s",
    direccion: DIRECCION,
    paso: "firmar-tx",
    remittanceId: REM,
    pasosConsumidos: ["conectar"],
    desde: Date.now(),
  });
  const u = new URL("https://chaski.test/enviar");
  u.searchParams.set("kyc", "return"); // 🔴 un parámetro AJENO al enlace: tiene que sobrevivir (AC-4)
  u.searchParams.set("dl", paso);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  window.history.replaceState(null, "", `${u.pathname}${u.search}`);
}

function contenedor(repo: InMemoryRepo) {
  return buildTestContainer({
    repo,
    wallet: new FakeWallet(),
    connectedWallet: new SolanaWalletAdapter(), // 🔴 EL ADAPTADOR REAL: lo que se prueba es el cableado
    recorridoPorEnlace: new RecorridoPorEnlaceReal(),
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/enviar");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs(); // la bandera del enlace que siembra `sembrarVuelta` no se filtra a otro archivo
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  solanaWalletBridge.setWalletAvailability("unknown");
  act(() => {
    solanaWalletBridge.setState({ publicKey: null, connected: false });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-7 (AC-3) — la reanudación corre UNA vez por montaje, y sólo con la remesa `confirmed`
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-065-7: la reanudación de `execute()`", () => {
  // MUTANTE QUE MATA: en `flow.tsx`, borrar el `if (yaCorrioRef.current) return` del productor ⇒ con
  // `reactStrictMode` el efecto corre dos veces y este `it` ve 2 llamadas. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`.)
  it("con `dl=firmar-tx` y la remesa en `confirmed`, llama a `execute()` EXACTAMENTE una vez", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("firmar-tx");
    const c = contenedor(repo);
    const spy = vi.spyOn(c.confirmAndSend, "execute");
    const confirmSpy = vi.spyOn(Remittance.prototype, "confirm");

    render(
      <React.StrictMode>
        <RemittanceFlow pasoInicial="send" container={c} />
      </React.StrictMode>,
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    { const pasado = spy.mock.calls[0]?.[0] as { remittanceId: string; hrefDeLaVuelta: string }; expect(pasado.remittanceId).toBe(REM); expect(new URL(pasado.hrefDeLaVuelta).searchParams.get("dl"), "el productor le pasó a `execute()` un href SIN `dl`: es el de DESPUÉS de limpiar la barra, y con él `authorizePrincipal` no puede reconocer de qué salto se volvió").toBe("firmar-tx"); } // 🔴 WKH-373 — EN ESTA MISMA LÍNEA (Δ0: este archivo se cita por número desde otros cuatro). ACÁ DECÍA `toEqual({ remittanceId: REM })` y esa igualdad estricta era la que se ponía roja al agregar el campo, o sea que el `it` medía la FORMA del argumento y no su contenido. Ahora mide lo que importa: que el href que viaja a `execute()` —y de ahí a `authorizePrincipal`— sea el de ANTES del paso 2.
    // ⛔ Y NO SE VOLVIÓ A LLAMAR `r.confirm()`: la remesa ya entró `confirmed`, así que el guard de
    // reanudación del use-case tiene que saltearlo. El espía va sobre el PROTOTIPO del dominio y no
    // sobre el estado final, porque el estado final depende de lo que haga la billetera de mentira
    // después (acá termina en `refunded`, que es correcto y no dice nada sobre este guard).
    expect(confirmSpy, "el use-case volvió a confirmar una remesa que ya estaba confirmada").toHaveBeenCalledTimes(0);
  });

  // 🔴 EL GATE FAIL-CLOSED, Y ES EL QUE IMPIDE QUE UN ENLACE DISPARE UNA ORDEN DE PAGO. Sin la
  // condición del `status`, una URL con `?dl=firmar-tx` puesta a mano sobre una remesa que la persona
  // NO confirmó haría que `execute()` la confirmara y siguiera hasta `prepare()`.
  // MUTANTE QUE MATA: en `flow.tsx`, borrar `|| enCurso.status !== "confirmed"` del gate.
  it("con la remesa SIN confirmar, NO llama a `execute()` aunque la barra traiga la marca", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "kyc_passed");
    sembrarVuelta("firmar-tx");
    const c = contenedor(repo);
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    // CD-18 — el fixture fabricó el caso: la marca ESTÁ y la remesa NO está confirmada.
    expect(new URL(window.location.href).searchParams.get("dl")).toBe("firmar-tx");
    expect((await repo.get(REM))?.snapshot.status).not.toBe("confirmed");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("dl")).toBeNull());
    expect(spy, "un enlace disparó una orden de pago sobre una remesa que nadie confirmó").toHaveBeenCalledTimes(0);
  });

  // 🔴 EL `it` DE ABAJO NO ALCANZABA, Y LO MIDIÓ LA BATERÍA. Con `dl=conectar` sobre un viaje que ya
  // trae `claveBilletera` y su paso consumido, `completar()` sale por un CORTE (`ya-consumida`) y el
  // productor vuelve ANTES de llegar al gate de la marca: el mutante «cualquier marca reanuda» pasaba
  // con exit=0 y 0 rojos. Este `it` usa una marca que NO existe, que es la que llega hasta el gate.
  // MUTANTE QUE MATA: en `flow.tsx`, cambiar `marca !== "firmar-tx" && marca !== "firmar-patrocinio"`
  // por `marca === null` ⇒ una marca cualquiera reanuda el envío. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`, que trae exit, `it` rojos y el árbol de los 54, y se re-corre con `node scripts/mutacion/bateria-065.mjs`.)
  it("con una marca que NO es del motor, NO reanuda: sólo `firmar-*` viene después de una orden", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("una-marca-que-nadie-escribio");
    const c = contenedor(repo);
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    // CD-18 — el fixture fabricó el caso: la marca ESTÁ, es ajena, y la remesa SÍ está confirmada. Sin
    // las tres, el gate de la marca no es lo que decide y este `it` mediría otra cosa.
    expect(new URL(window.location.href).searchParams.get("dl")).toBe("una-marca-que-nadie-escribio");
    expect((await repo.get(REM))?.snapshot.status).toBe("confirmed");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("dl")).toBeNull());
    await act(async () => {
      await Promise.resolve();
    });
    expect(spy, "una marca que nadie escribió reanudó un envío").toHaveBeenCalledTimes(0);
  });

  // MUTANTE QUE MATA: ídem, aunque este `it` NO lo caza (ver el bloque de arriba): con `dl=conectar` el
  // productor corta antes del gate. Se queda porque mide otra cosa que sí importa —que la vuelta del
  // connect no reanude— y su valor no depende del gate de la marca.
  it("con `dl=conectar` NO reanuda: ese paso pasa antes de que exista ninguna orden", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("conectar");
    const c = contenedor(repo);
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("dl")).toBeNull());
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it("sin ningún viaje en el disco, el productor no llama a nada y no toca la barra", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    window.history.replaceState(null, "", "/enviar?kyc=return");
    const c = contenedor(repo);
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(spy).toHaveBeenCalledTimes(0);
    expect(window.location.search).toBe("?kyc=return");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-8 (AC-3 / CD-7) — el pisón: si la persona ya interactuó, se avisa y NO se navega
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 POR QUÉ ESTO ES UNA PÉRDIDA DE DATOS Y NO UN DETALLE DE EXPERIENCIA (fix-pack 3 de WKH-063,
// mutante G5): una remesa `created` con `ownerAddress: null` NO la lista `repo.list(address)` nunca,
// así que pisarla con `setRem` la vuelve inalcanzable. Acá el productor va más lejos que el del KYC:
// **ni siquiera llama a `execute()`**, porque reanudar por debajo mientras la persona usa la pantalla
// es la misma pisada con una orden de pago adentro.
//
// MUTANTE QUE MATA: en `flow.tsx`, mover el gate `if (yaInteractuo.current)` DESPUÉS de la llamada a
// `c.confirmAndSend.execute(...)` (o borrarlo). (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`.)
describe("T-065-8: el pisón", () => {
  it("si la persona ya interactuó, avisa, NO llama a `execute()` y NO la saca de su pantalla", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("firmar-tx");
    const c = contenedor(repo);
    // La reanudación queda colgada hasta que el test la suelte: así hay una ventana real en la que la
    // persona puede tocar la pantalla, que es exactamente el caso que este `it` mide.
    let soltar: () => void = () => {};
    const puerta = new Promise<void>((res) => {
      soltar = res;
    });
    const listaOriginal = c.listHistory.execute.bind(c.listHistory);
    vi.spyOn(c.listHistory, "execute").mockImplementation(async (dir: string) => {
      await puerta;
      return listaOriginal(dir);
    });
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

    // La persona se va a otro destino con la barra: eso es lo que marca `yaInteractuoRef` (`irADestino`,
    // `./flow.tsx:426`).
    //
    // 🔴 ACÁ TOCABA «Empezar un envío», Y ESE BOTÓN YA NO EXISTE EN ESTA VENTANA — no es un test
    // ajustado para pasar, es que la superficie se movió a propósito (HU-075/aterrizaje, `./flow.tsx:1195`).
    // Mientras la vuelta por enlace no resuelve, la pantalla de entrada NO se pinta: era el CTA más
    // grande de la pantalla justo cuando la persona vuelve de firmar, y tocarlo mandaba su reanudación
    // a este mismo aviso en vez de al salto que venía a dar.
    // ⛔ LO QUE ESTE `it` MIDE NO CAMBIÓ, y el gate que vigila tampoco: la barra de destinos SÍ sigue
    // pintada en esa ventana, porque la pinta el (`esDestino`, `./flow.tsx:1237`) del paso y `bienvenida`
    // ES un destino. O sea que la interacción que dispara el pisón sigue siendo alcanzable en producción
    // por este camino. Si algún día la barra también se apagara ahí, este `it` se cae y lo que hay que
    // rediscutir es el pisón, no el fixture.
    fireEvent.click(await screen.findByRole("button", { name: /Recuperar/ }));
    expect(await screen.findByRole("heading", { name: /Recuperar fondos de un envío anterior/ })).toBeInTheDocument();

    await act(async () => {
      soltar();
      await Promise.resolve();
    });

    // (i) avisa; (ii) NO llamó al use-case; (iii) sigue en el destino que la persona estaba usando.
    // El (iii) es MÁS falsable que antes: sin el pisón, `alReanudar` hace `setStep("track")` y este
    // encabezado desaparece.
    expect(await screen.findByText(/Volviste de tu billetera/)).toBeInTheDocument();
    expect(spy, "la reanudación corrió por debajo mientras la persona usaba la pantalla").toHaveBeenCalledTimes(0);
    expect(screen.getByRole("heading", { name: /Recuperar fondos de un envío anterior/ })).toBeInTheDocument();
  });

  // 🔴 T-065-8b — EL SEGUNDO PISÓN, QUE NO TENÍA NINGÚN `it` Y LO DESTAPÓ LA BATERÍA DEL FIX-PACK.
  //
  // `flow.tsx` tiene DOS `if (yaInteractuo.current)` en el mismo productor, y son dos ramas distintas:
  // la de la REANUDACIÓN (la que mide el `it` de arriba) y la del CONNECT (`res.estado === "conectado"`).
  // El mutante que apaga la del connect —`if (false) return;`— dejaba la suite COMPLETA en verde:
  // **2685 passed, exit 0**. O sea que ese gate no lo custodiaba nadie.
  //
  // ⚠️ QUÉ SE PIERDE SIN ÉL, sin exagerarlo: esta rama NO hace `setStep` ni `setRem`, así que no saca a la
  // persona de su pantalla como la otra. Lo que sí hace es pedirle a la billetera un `connect()` y después
  // ir a la CADENA a preguntar por la cuenta de nonce, mientras ella está tipeando. Es trabajo y una
  // lectura de red que nadie pidió, en el medio de un formulario.
  //
  // ⛔ ACÁ EL COLABORADOR ES UN DOBLE Y NO EL REAL, y es deliberado: lo que se mide es el gate de la
  // PANTALLA, que es donde vive el mutante. Producir un `{estado:"conectado"}` con el recorrido real exige
  // rehacer el sobre cifrado del connect, que es lo que `preparacion-por-enlace.test.ts` ya mide; hacerlo
  // otra vez acá mediría la criptografía y no el gate.
  //
  // MUTANTE QUE MATA: en `flow.tsx`, borrar el `if (yaInteractuo.current) return;` de la rama
  // `res.estado === "conectado"` (MEDIDO en el fix-pack: exit=1, 1 rojo, y el rojo es este `it`).
  it("T-065-8b: y con la vuelta del CONNECT, si la persona ya interactuó tampoco se conecta por debajo", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("conectar");
    let soltar: () => void = () => {};
    const puerta = new Promise<void>((res) => {
      soltar = res;
    });
    /** El doble contesta la vuelta del CONNECT, y la deja colgada hasta que el test la suelte: así hay
     *  una ventana real en la que la persona toca la pantalla, igual que en el `it` de arriba. */
    class RecorridoQueVuelveConectado extends RecorridoPorEnlaceNulo {
      override remesaEnCurso(): string {
        return REM;
      }
      override async completar(): Promise<never> {
        await puerta;
        return { estado: "conectado", direccion: DIRECCION } as never;
      }
    }
    const c = buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: new RecorridoQueVuelveConectado(),
    });
    const conectar = vi.spyOn(c.connectWallet, "execute");

    render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

    // La persona se va a otro destino con la barra: eso es lo que marca `yaInteractuoRef`. Mismo motivo
    // que en el `it` de arriba para que NO sea «Empezar un envío» (ver el bloque de ahí).
    fireEvent.click(await screen.findByRole("button", { name: /Recuperar/ }));
    expect(await screen.findByRole("heading", { name: /Recuperar fondos de un envío anterior/ })).toBeInTheDocument();

    await act(async () => {
      soltar();
      await Promise.resolve();
    });

    expect(
      conectar,
      "el productor conectó la billetera por debajo mientras la persona usaba la pantalla",
    ).toHaveBeenCalledTimes(0);
    expect(screen.getByRole("heading", { name: /Recuperar fondos de un envío anterior/ })).toBeInTheDocument();
  });

  // El par negativo, y es lo que hace falsable al `it` de arriba: sin ninguna interacción, la MISMA vuelta
  // del connect SÍ se aplica. Sin esto, un productor que nunca conectara pasaría el de arriba igual.
  it("T-065-8b (control): sin ninguna interacción, la misma vuelta del connect SÍ conecta", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("conectar");
    class RecorridoQueVuelveConectado extends RecorridoPorEnlaceNulo {
      override remesaEnCurso(): string {
        return REM;
      }
      override async completar(): Promise<never> {
        return { estado: "conectado", direccion: DIRECCION } as never;
      }
      override async estadoDeLaCuentaDeNonce(): Promise<never> {
        return "no-pudimos-preguntar" as never;
      }
    }
    const c = buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: new RecorridoQueVuelveConectado(),
    });
    const conectar = vi.spyOn(c.connectWallet, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await waitFor(() => expect(conectar).toHaveBeenCalledTimes(1));
  });

  it("CONTROL: sin ninguna interacción, la misma vuelta SÍ reanuda", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("firmar-tx");
    const c = contenedor(repo);
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Volviste de tu billetera/)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// T-065-9 / T-065-10 (AC-4) — la barra queda limpia, y limpia DESPUÉS de leer
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-065-9 / T-065-10: la limpieza de la barra", () => {
  // MUTANTE QUE MATA: en `flow.tsx`, cambiar `window.history.replaceState` por
  // `window.location.assign` ⇒ jsdom registra una navegación y el `it` se pone rojo por el
  // `Not implemented: navigation`. (MEDIDO: ver LA BATERÍA DE MUTACIÓN al final de `deeplink/conexion.test.ts`.)
  it("T-065-9: tras interpretar, la barra pierde la marca y la respuesta, y CONSERVA `?kyc=return`", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("conectar", {
      phantom_encryption_public_key: bs58.encode(new Uint8Array(32)),
      nonce: bs58.encode(new Uint8Array(24)),
      data: bs58.encode(new Uint8Array(48)),
    });
    // CD-18 — el fixture fabricó el caso: los cuatro parámetros del enlace ESTÁN antes de montar.
    const antes = new URL(window.location.href).searchParams;
    for (const p of ["dl", "phantom_encryption_public_key", "nonce", "data"]) {
      expect(antes.get(p), `el fixture no puso \`${p}\``).toBeTruthy();
    }
    const documentoAntes = window.document;

    render(<RemittanceFlow pasoInicial="send" container={contenedor(repo)} />);

    await waitFor(() => expect(new URL(window.location.href).searchParams.get("dl")).toBeNull());
    const q = new URL(window.location.href).searchParams;
    for (const p of ["phantom_encryption_public_key", "nonce", "data", "errorCode", "errorMessage"]) {
      expect(q.get(p), `quedó \`${p}\` en la barra`).toBeNull();
    }
    // 🔴 Y NADA MÁS SE TOCÓ: `?kyc=return` es de otro recorrido y sigue viajando.
    expect(q.get("kyc"), "la limpieza se llevó un parámetro que no era suyo").toBe("return");
    expect(window.location.pathname).toBe("/enviar");
    // Y SIN RECARGAR: `replaceState` no reemplaza el documento; `location.assign` sí lo intentaría.
    expect(window.document).toBe(documentoAntes);
  });

  // 🔴 EL CASO QUE LA OLA 2 MIDE CON TRES INVOCACIONES IDÉNTICAS: un `errorCode` que queda en la barra
  // hace que la invocación SIGUIENTE vuelva a leer el mismo rechazo. Sin la limpieza, la persona no
  // puede reintentar nunca.
  // MUTANTE QUE MATA: en `flow.tsx`, correr `limpiarLaBarra()` ANTES de `completar()` ⇒ el primer
  // montaje deja de ver el rechazo y el `it` de abajo pierde su mitad positiva.
  it("T-065-10: con un `errorCode` en la barra, el PRIMER montaje avisa y el SEGUNDO ya no repite", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("conectar", { errorCode: "4001", errorMessage: "User rejected" });

    const { unmount } = render(<RemittanceFlow pasoInicial="send" container={contenedor(repo)} />);
    // (i) el primer montaje SÍ lee el rechazo y lo dice.
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("errorCode")).toBeNull());
    const primerAviso = document.body.textContent ?? "";
    expect(
      /No pudimos|cancel|rechaz|intent/i.test(primerAviso),
      "el primer montaje no dijo nada del rechazo: la limpieza corrió ANTES de leer",
    ).toBe(true);

    unmount();
    cleanup();

    // (ii) el segundo montaje, sobre la barra ya limpia, no repite el corte.
    //
    // 🔴 ACÁ ESTA MITAD NO MEDÍA NADA (fix-pack · AR/MNR-2). Asserteaba `errorCode === null` y
    // `kyc === "return"`, que son **exactamente los dos valores que el PRIMER montaje ya dejó fijados**:
    // pasaban aunque el segundo montaje repitiera el aviso palabra por palabra. Lo que hay que medir es la
    // AUSENCIA DEL COPY, que es lo único que distingue "no repitió" de "la barra ya estaba limpia".
    const cuerpoAntes = document.body.textContent ?? "";
    render(<RemittanceFlow pasoInicial="send" container={contenedor(repo)} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(new URL(window.location.href).searchParams.get("errorCode")).toBeNull();
    expect(new URL(window.location.href).searchParams.get("kyc")).toBe("return");
    // CD-18 — el instrumento sirve: el `cleanup()` de arriba dejó el documento sin el aviso anterior, así
    // que lo que se busca abajo sólo puede haberlo puesto ESTE montaje.
    expect(
      /cancel|rechaz/i.test(cuerpoAntes),
      "el `cleanup()` no borró el aviso del primer montaje: este barrido mediría el texto viejo",
    ).toBe(false);
    const segundoCuerpo = document.body.textContent ?? "";
    expect(
      /cancel|rechaz/i.test(segundoCuerpo),
      "el SEGUNDO montaje volvió a anunciar el rechazo: la vuelta se está leyendo dos veces",
    ).toBe(false);
    // Y la pantalla del segundo montaje es la que corresponde, no una en blanco (si no, la ausencia del
    // copy sería por un render que falló y no por la limpieza).
    expect(screen.getByPlaceholderText("Nombre de tu familiar")).toBeInTheDocument();
  });

  // ⚠️ SON DOS MONTAJES Y NO LAS TRES INVOCACIONES QUE AC-4 CITA (AR/MNR-2), y va escrito en vez de
  // maquillado: la ola 2 midió el caso con TRES invocaciones idénticas del motor sobre la misma URL, y acá
  // hay DOS montajes de la pantalla. Dos alcanzan para lo que este `it` afirma —que la limpieza corre
  // después de leer y que el segundo no repite—, y el tercero no agregaría un estado nuevo: la barra ya
  // está limpia desde el primero. Lo que las tres invocaciones sí miden, y esto no, es el comportamiento
  // del MOTOR con el rastro intacto; eso vive en `firma-por-enlace.test.ts` y sigue ahí.
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-359 · T-067-11 y T-067-12 (AC-7) — VOLVER DEL SALTO DEL PERMISO NO RE-PIDE NINGUNA FIRMA
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ SE MIDE ACÁ Y QUÉ SE MIDE EN OTRO LADO, dicho antes de que alguien lo lea al revés. Lo que
// vive en este archivo es **la rama de `flow.tsx:4009`**: que la marca del permiso llegue a
// `completarPop()`, que sólo se reanude si el desenlace es `pop-listo`, y que el doble montaje de
// StrictMode no la consuma dos veces. La VERIFICACIÓN de la firma (los cinco chequeos + ed25519) la
// mide `deeplink/pop-por-enlace.test.ts`, con sobres cifrados y firmas ed25519 reales.
//
// ⛔ Y POR QUÉ ESA MITAD NO PUEDE VIVIR ACÁ, medido y no elegido por comodidad: **este archivo corre en
// jsdom** (`@vitest-environment jsdom`, arriba de todo), y bajo jsdom
// `new TextEncoder().encode(...)` devuelve un `Uint8Array` que **NO es `instanceof Uint8Array`** del
// realm donde vive `tweetnacl` (medido con una sonda: `instanceof Uint8Array: false`). Cualquier
// llamada a `iniciarPop` o `vueltaDelPop` desde acá muere en `checkArrayTypes` de tweetnacl con
// `unexpected type, use Uint8Array`, ANTES de ejercitar una sola línea de esta HU.
// ⚠️ Es un límite del RUNNER, no de producción: en un navegador real hay un solo realm y esto no pasa.
// Es la lección "el runner de tests NO es el runtime real", en su versión más cara.
//
// ⇒ Por eso acá se dobla la costura que el propio módulo declara tener para esto
// (`preparacion-por-enlace.ts`: *"la costura que la pantalla puede doblar en los tests sin tocar el
// adaptador"*), y se dice qué queda afuera en vez de fingir que se mide todo.
describe("T-067-11 / T-067-12 (WKH-359/AC-7): la vuelta del salto del permiso", () => {
  /** El recorrido con la vuelta del PoP programada. ⛔ Sólo se dobla `completarPop`: todo lo demás
   *  sigue siendo el `RecorridoPorEnlaceNulo`, que TIRA, así que un camino no previsto se ve. */
  class RecorridoConVueltaDelPop extends RecorridoPorEnlaceNulo {
    public llamadas = 0;
    constructor(
      private readonly desenlace: { estado: "pop-listo"; proposito: "pop-payout" | "pop-kyc" } | { estado: "nada" } | { estado: "corte"; causa: string },
      /** El viaje del DEPÓSITO, que vence a los 20 min y es un reloj distinto del `exp` del desafío
       *  (10 min). `false` = ya venció mientras la persona firmaba (fix-pack · AR/BLQ-BAJO-4). */
      private readonly viajeVivo = true,
    ) {
      super();
    }
    override remesaEnCurso(): string | null {
      return this.viajeVivo ? REM : null;
    }
    override async completar(): Promise<never> {
      // La vuelta del MOTOR contesta `nada`: la marca del permiso NO es un `PasoDelViaje`, así que
      // el motor no la mira y no consume ni destruye el viaje del depósito (CD-11, `T-067-16`).
      return { estado: "nada" } as never;
    }
    /** Lo que el PRODUCTOR le pasó, sin interpretarlo. Es la mitad que faltaba: hasta el fix-pack este
     *  doble no miraba el argumento, y el bug de `AR/BLQ-ALTO-1` vivía justo ahí. */
    public hrefsRecibidos: string[] = [];
    override async completarPop(i: { hrefDeLaVuelta: string }): Promise<never> {
      this.llamadas += 1;
      this.hrefsRecibidos.push(i.hrefDeLaVuelta);
      return this.desenlace as never;
    }
  }

  function contenedorConPop(repo: InMemoryRepo, recorrido: RecorridoConVueltaDelPop) {
    return buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: recorrido,
    });
  }

  // 🔴 MUTANTE QUE MATA: en `flow.tsx:4009`, quitar `"pop-payout"` de la condición de la rama (la marca
  // cae al filtro `marca !== "firmar-tx" && marca !== "firmar-patrocinio"` de (`marca`, `./flow.tsx:4070`) y el productor
  // vuelve sin reanudar), o decidir por `viaje.paso` —que en este fixture dice `firmar-tx`— en vez de
  // por el desenlace.
  //
  // 🔴 Y EL SEGUNDO MUTANTE, EL DEL FIX-PACK (AR/BLQ-ALTO-1): en `flow.tsx:4009`, pasarle a
  // `completarPop` el href YA LIMPIO —`hrefSinRastroDeVuelta(hrefAlMontar)` en vez de `hrefAlMontar`—.
  // Es exactamente lo que hacía el código rechazado, sólo que allá el href limpio no se pasaba sino que
  // lo leía el adaptador de `location` en vivo, después de que el paso 2 ya hubiera corrido.
  // ⚠️ ESTE `it` MIDE LA MITAD DEL PRODUCTOR Y NADA MÁS: que lo que sale de acá conserve el rastro. La
  // otra mitad —que la implementación REAL use ese argumento y no `location`— la mide
  // (`completarPop`, `../infrastructure/solana/preparacion-por-enlace.test.ts:696`), en entorno `node`,
  // porque bajo jsdom tweetnacl no acepta el `Uint8Array` de este realm.
  it("T-067-11: con el permiso conseguido, reanuda y el bridge recibe CERO pedidos de firma", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    // ⛔ LOS TRES PARÁMETROS DE RESPUESTA VAN EN LA SIEMBRA A PROPÓSITO: son los que
    // `hrefSinRastroDeVuelta` borra, o sea los que distinguen el href de ANTES del paso 2 del de
    // después. Sin ellos, "sucio" y "limpio" se diferencian sólo en el `dl` y este `it` mediría menos.
    sembrarVuelta("pop-payout", {
      phantom_encryption_public_key: "8TB7whSu6PvhWWNQnZRZBpTsCTZKm3Y6y1WVHZE8gWy3",
      nonce: "3HqTh8HFEZ6zMbTuxHmYVX",
      data: "2Fk9WkH7pJpTz3ZQ5ZC3Rn",
    });
    const firmaSpy = vi.fn(async () => new Uint8Array(64));
    solanaWalletBridge.registerSignMessage(firmaSpy);
    const recorrido = new RecorridoConVueltaDelPop({ estado: "pop-listo", proposito: "pop-payout" });
    const c = contenedorConPop(repo, recorrido);
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    // CD-18 — el fixture fabricó el caso: la marca del PERMISO está en la barra, y el paso del VIAJE
    // dice `firmar-tx`. Sin esta mitad, este `it` podría estar pasando por el camino de siempre.
    expect(new URL(window.location.href).searchParams.get("dl")).toBe("pop-payout");

    render(<RemittanceFlow pasoInicial="send" container={c} />);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    { const pasado = spy.mock.calls[0]?.[0] as { remittanceId: string; hrefDeLaVuelta: string }; expect(pasado.remittanceId).toBe(REM); for (const q of ["phantom_encryption_public_key", "nonce", "data", "dl"]) expect(new URL(pasado.hrefDeLaVuelta).searchParams.get(q), `el productor le pasó a \`execute()\` un href SIN \`${q}\`: es el de DESPUÉS de limpiar la barra, y con él \`authorizePrincipal\` contesta \`no-volvimos\`, re-ancla y vuelve a pedir la MISMA firma`).not.toBeNull(); } // 🔴 WKH-373 — EL GEMELO DEL DEPÓSITO, EN ESTA MISMA LÍNEA (Δ0). Éste es exactamente el `it` que faltaba: el de abajo mide el href que recibe `completarPop` y NADIE medía el que recibe el consumidor de la vuelta del DEPÓSITO. Con el código de antes, `authorizePrincipal` no recibía ningún href —lo leía de `location` en vivo, ya limpiado— y este `it` no podía ni escribirse.
    expect(recorrido.llamadas, "la vuelta del permiso no se leyó, o se leyó de más").toBe(1);
    // 🔴 WKH-373 — Y EL CABLEADO DEL RENGLÓN DE `?diag=1`, MEDIDO ACÁ Y NO EN EL BLOQUE. Los `it` del
    // bloque de diagnóstico anotan los hitos A MANO, así que verdes los dos no prueban que ALGUIEN los
    // escriba en producción: un `formaDelHref` sin llamador y uno cableado son indistinguibles desde
    // allá. Éste es el único `it` que monta el flujo REAL y mira lo que quedó anotado.
    // MUTANTE QUE MATA: borrar cualquiera de los dos `anotarHito` de `./flow.tsx` (`:3997` y `:4087`).
    for (const [hito, quien] of [["href-al-montar", "el productor de montaje"], ["href-al-reanudar", "la reanudación"]] as const) {
      expect(leerHito(hito), `${quien} no anotó su href: el renglón \`href al leer\` de \`?diag=1\` diría «no corrió» en una captura de un teléfono donde SÍ corrió`).toBe(
        "dl=pop-payout nonce=sí data=sí key=sí",
      );
    }

    // 🔴 LA MITAD DEL FIX-PACK (AR/BLQ-ALTO-1): lo que el productor le pasó a `completarPop` es el href
    // de ANTES de limpiar la barra. Los tres parámetros de respuesta tienen que estar: sin ellos, el
    // guard write-once de la `claveBilletera` no encuentra clave y toda firma buena sale
    // `deeplink_pop_alterado`.
    const recibido = recorrido.hrefsRecibidos[0] as string;
    for (const p of ["phantom_encryption_public_key", "nonce", "data", "dl"]) {
      expect(
        new URL(recibido).searchParams.get(p),
        `el productor le pasó a \`completarPop\` un href SIN \`${p}\`: es el href de después de limpiar ` +
          "la barra, y con él ninguna vuelta del permiso puede verificar",
      ).not.toBeNull();
    }
    // ⛔ Y LA REFUTACIÓN DEL INSTRUMENTO, que es lo que impide que esto pase por no limpiar nunca: la
    // barra SÍ quedó limpia. O sea que las dos cosas ocurrieron, y en este orden: se leyó con el href
    // sucio y se limpió igual (AC-4).
    for (const p of ["phantom_encryption_public_key", "nonce", "data", "dl"]) {
      expect(
        new URL(window.location.href).searchParams.get(p),
        `la barra quedó con \`${p}\`: el paso 2 no corrió y este \`it\` no distingue sucio de limpio`,
      ).toBeNull();
    }
    expect(new URL(window.location.href).searchParams.get("kyc"), "el paso 2 se llevó un parámetro ajeno").toBe("return");

    // ⛔ Y NO se le volvió a pedir al bridge una firma que la persona ya dio. En el camino por enlace
    // ese bridge está vacío, así que un pedido acá además muere.
    expect(
      firmaSpy,
      "se le pidió al bridge una firma teniendo el permiso conseguido: eso es pedirle a la persona " +
        "una firma que ya dio, y en un teléfono ese pedido ni siquiera puede prosperar",
    ).not.toHaveBeenCalled();
  });

  // 🔴 MUTANTE QUE MATA: borrar el `if (yaCorrioRef.current) return` del productor ⇒ con `StrictMode`
  // el efecto corre dos veces y la vuelta se consume DOS veces. Mismo patrón que `T-065-7`.
  it("T-067-12: en StrictMode el doble montaje consume la vuelta UNA sola vez", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("pop-payout");
    const recorrido = new RecorridoConVueltaDelPop({ estado: "pop-listo", proposito: "pop-payout" });
    const c = contenedorConPop(repo, recorrido);
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(
      <React.StrictMode>
        <RemittanceFlow pasoInicial="send" container={c} />
      </React.StrictMode>,
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(spy, "el doble montaje de StrictMode consumió la vuelta dos veces").toHaveBeenCalledTimes(1);
    expect(recorrido.llamadas, "la vuelta del permiso se leyó dos veces").toBe(1);
  });

  // ⛔ La mitad fail-closed, y es la que impide que un enlace dispare una orden de pago SIN permiso.
  // MUTANTE QUE MATA: en `flow.tsx:4009`, quitar el `if (vp.estado !== "pop-listo") return;`.
  it("si el permiso NO quedó listo, la marca no dispara ningún `execute()`", async () => {
    for (const desenlace of [
      { estado: "corte" as const, causa: "deeplink_pop_alterado" },
      { estado: "nada" as const },
    ]) {
      const repo = new InMemoryRepo();
      await sembrarRemesaConfirmada(repo, "confirmed");
      sembrarVuelta("pop-payout");
      const c = contenedorConPop(repo, new RecorridoConVueltaDelPop(desenlace));
      const spy = vi.spyOn(c.confirmAndSend, "execute");

      render(<RemittanceFlow pasoInicial="send" container={c} />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        spy,
        `con el desenlace \`${desenlace.estado}\` se disparó el money-path igual: \`prepare\` va a ` +
          "contestar 403 y la remesa se va a degradar por un camino que nadie pidió",
      ).toHaveBeenCalledTimes(0);
      cleanup();
      window.localStorage.clear();
    }
  });

  // 🔴 T-067-22 (fix-pack · AR/BLQ-BAJO-4) — EL VIAJE VENCIÓ MIENTRAS LA PERSONA FIRMABA, Y ANTES
  // ESO ERA **CERO COPY**. Son dos relojes distintos con arranques distintos: el viaje dura 20 min
  // (`MAX_EDAD_MS`, `../infrastructure/solana/deeplink/sesion.ts:111`) y el `exp` del desafío 10, y el
  // del viaje arranca antes —al tocar el selector—, así que es alcanzable volver de firmar con el
  // ancla viva y el viaje muerto. Con el gate de `remId` ANTES de la rama del permiso, el productor
  // limpiaba la barra y retornaba sin llamar a `completarPop()` y sin `alFallar`: la persona volvía de
  // firmar y no leía absolutamente nada, y el ancla quedaba sin consumir, así que el reintento volvía
  // a caer en el mismo silencio.
  //
  // MUTANTE QUE MATA: en `flow.tsx`, mover la rama del permiso ((`completarPop`, `./flow.tsx:4009`))
  // DEBAJO del `if (remId === null) { limpiarLaBarra(); return; }` de (`remId`, `./flow.tsx:4010`)
  // — que es exactamente donde estaba.
  it("T-067-22: si el viaje venció mientras firmaba, la vuelta del permiso igual se lee y se avisa", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("pop-payout");
    const recorrido = new RecorridoConVueltaDelPop(
      { estado: "corte", causa: "deeplink_viaje_vencido" },
      false, // ⚠️ LA ÚNICA VARIABLE QUE SE MUEVE contra `T-067-11`: `remesaEnCurso()` contesta `null`
    );
    const c = contenedorConPop(repo, recorrido);
    const spy = vi.spyOn(c.confirmAndSend, "execute");

    render(<RemittanceFlow pasoInicial="send" container={c} />);

    // 1 · la vuelta SE LEYÓ: el permiso no depende de `remittanceId` y no puede quedar colgado de un
    // gate que habla de otra cosa.
    await waitFor(() => expect(recorrido.llamadas, "la vuelta del permiso ni se leyó").toBe(1));
    // 2 · y la persona LEE algo. Este es el hallazgo: antes acá no aparecía ningún texto.
    expect(
      await screen.findByText(/Pasó demasiado tiempo desde que empezaste/),
      "la persona volvió de firmar y no leyó nada",
    ).toBeInTheDocument();
    // 3 · y ⛔ NO se disparó ninguna orden de pago: avisar no es reanudar.
    expect(spy).toHaveBeenCalledTimes(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-075 · AC-2 y AC-5 — la espera no toca el camino de siempre, y una marca CONOCIDA no muere muda
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-075-2 / T-075-5 / T-075-5b / T-075-1c / T-075-3d / T-075-4b / T-075-4c (WKH-075)", () => {
  /** 🔴 EL RECORRIDO QUE LLEGA HASTA EL FALLTHROUGH, y por qué hace falta doblarlo. Con el recorrido
   *  REAL y una barra sin carga de respuesta, `completar()` contesta un CORTE (`deeplink_viaje_vencido`)
   *  y el productor retorna en `flow.tsx:4027`, o sea **antes** de la línea que esta HU cambia. El
   *  desenlace que llega a `:4070` es `nada` —la marca estaba pero ninguna rama la reclamó—, que es
   *  exactamente el caso que hoy muere en silencio. ⛔ Hereda de `RecorridoPorEnlaceNulo`, que TIRA en
   *  todo lo demás: un camino no previsto se ve. */
  class RecorridoQueNoReclamaLaMarca extends RecorridoPorEnlaceNulo {
    override remesaEnCurso(): string | null {
      return REM;
    }
    override async completar(): Promise<never> {
      return { estado: "nada" } as never;
    }
  }
  function contenedorQueLlegaAlFallthrough(repo: InMemoryRepo) {
    return buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: new RecorridoQueNoReclamaLaMarca(),
    });
  }

  /** Un trozo del copy de `deeplink_marca_sin_consumidor`, y ⛔ NO la causa escrita como literal: lo que
   *  la persona lee es la frase, y es lo que este archivo puede afirmar sin mirar el `Record`. */
  const SENAL_SIN_CONSUMIDOR = /esta pantalla no pudo retomar el envío desde donde lo dejaste/;
  /** Ídem para `deeplink_disponibilidad_sin_resolver`. */
  const CAUSA_DEL_TECHO = /terminar de reconocer qué billetera hay en este navegador/;

  // ── AC-2 · el camino de siempre no cambia ──────────────────────────────────────────────────────
  // 🔴 EL CORTE SIN TICK ES LO QUE HACE ESTO CIERTO, y se mide aparte en
  // `../infrastructure/solana/disponibilidad-decidible.test.ts` (que cuenta timers y listeners). Acá se
  // mide la consecuencia visible: con la disponibilidad YA decidida, el recorrido llega igual y ⛔ la
  // causa del techo NO aparece nunca.
  it("T-075-2 (AC-2): con `injected` la vuelta se resuelve igual que siempre y la causa del techo NO aparece", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("conectar");
    solanaWalletBridge.setWalletAvailability("injected"); // ⚠️ pisa el `none` del arnés: es el camino inyectado
    const c = contenedor(repo);

    render(<RemittanceFlow pasoInicial="send" container={c} />);

    // Que la barra se limpie prueba que el consumidor CORRIÓ. Sin esta mitad, el `queryByText` de abajo
    // sería un cero vacuo: pasaría igual si el productor no hubiera arrancado nunca.
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("dl")).toBeNull());
    expect(
      screen.queryByText(CAUSA_DEL_TECHO),
      "el camino inyectado leyó la causa del techo: la espera está frenando un recorrido que no tiene por qué esperar",
    ).toBeNull();
  });

  // ── AC-5 · la señal del fallthrough ────────────────────────────────────────────────────────────
  it("T-075-5b (AC-5): `crear-nonce` —marca CONOCIDA que ninguna rama reclama— deja SEÑAL, no silencio", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("crear-nonce");
    // CD-18 — el fixture fabricó el caso: la marca está, y es una de las CONOCIDAS.
    expect(new URL(window.location.href).searchParams.get("dl")).toBe("crear-nonce");
    expect(MARCAS_DE_VUELTA as readonly string[]).toContain("crear-nonce");

    render(<RemittanceFlow pasoInicial="send" container={contenedorQueLlegaAlFallthrough(repo)} />);

    await waitFor(() => expect(screen.getByText(SENAL_SIN_CONSUMIDOR)).toBeInTheDocument());
  });

  // 🔴 LA OTRA MITAD, Y SIN ELLA EL `it` DE ARRIBA NO DICE NADA: si la señal saliera para CUALQUIER
  // marca, sería ruido y no información. `marcaDeVuelta` devuelve la marca CRUDA SIN VALIDAR, así que
  // una marca de otro sistema llega hasta el mismo punto — y NO tiene que disparar nada.
  it("T-075-5b (control negativo): una marca que NADIE escribió NO dispara la señal", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("una-marca-que-nadie-escribio");

    render(<RemittanceFlow pasoInicial="send" container={contenedorQueLlegaAlFallthrough(repo)} />);

    await waitFor(() => expect(new URL(window.location.href).searchParams.get("dl")).toBeNull());
    expect(
      screen.queryByText(SENAL_SIN_CONSUMIDOR),
      "una marca ajena disparó la señal: el gate está mirando `marca != null` en vez de «marca conocida»",
    ).toBeNull();
  });

  // ── AC-5 · la lista es un VALOR, no una copia a mano ───────────────────────────────────────────
  // ⛔ Hasta esta HU el universo de marcas vivía SÓLO en el tipo del parámetro de `enlaceDeVuelta`, y un
  // tipo no se puede recorrer en runtime: un test que las listara las copiaría a mano y sería una lista
  // que envejece sola. Este `it` las recorre DERIVÁNDOLAS.
  it("T-075-5 (AC-5): las marcas se derivan de `MARCAS_DE_VUELTA`, y las tres del motor NO disparan la señal", async () => {
    // 🔴 CONTROL POSITIVO PRIMERO: si la tupla llegara vacía, el `for` de abajo no correría y este `it`
    // pasaría sin medir nada. Es la trampa nº1 de `readme-test-count.test.ts:18-23`.
    expect(MARCAS_DE_VUELTA.length, "la tupla de marcas llegó vacía: el barrido de abajo sería vacuo").toBeGreaterThanOrEqual(6);
    expect(MARCAS_DE_VUELTA as readonly string[]).toEqual(
      expect.arrayContaining(["conectar", "firmar-tx", "firmar-patrocinio", "crear-nonce", "pop-payout", "pop-kyc"]),
    );
    // Las tres que el `if` de la reanudación deja pasar SIGUEN DE LARGO y ⛔ no disparan la señal: si la
    // dispararan, la persona leería «no pudimos retomar» justo cuando sí se está retomando.
    for (const marca of MARCAS_DE_VUELTA.filter((m) => m === "firmar-tx" || m === "firmar-patrocinio" || m === "pop-payout")) {
      cleanup();
      window.localStorage.clear();
      const repo = new InMemoryRepo();
      await sembrarRemesaConfirmada(repo, "confirmed");
      sembrarVuelta(marca);
      render(<RemittanceFlow pasoInicial="send" container={contenedorQueLlegaAlFallthrough(repo)} />);
      await waitFor(() => expect(new URL(window.location.href).searchParams.get("dl")).toBeNull());
      expect(screen.queryByText(SENAL_SIN_CONSUMIDOR), `\`${marca}\` disparó la señal del fallthrough`).toBeNull();
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════
  // FIX-PACK 1 — LAS TRES COMBINACIONES QUE NO EJERCITABA NADIE:
  //   `unknown` × marca AJENA (CR/BLQ-1) · `unknown` × techo vencido CON RENDER (AR/BLQ-2) ·
  //   la BANDERA de repliegue apagada (AR/BLQ-5).
  //
  // 🔴 POR QUÉ VIVEN ACÁ Y NO EN `vuelta-por-enlace-carrera.test.tsx`. Allá se monta `SolanaProviders`,
  // y ese árbol escribe `"none"` a los `WALLET_GRACE_MS = 1500`, o sea SIEMPRE antes del techo de 3000:
  // con el árbol montado la rama del techo es **inalcanzable**, y por eso ningún `it` de allá la podía
  // ejecutar. Acá `RemittanceFlow` se monta SOLO —sin providers—, que es exactamente el caso que el
  // módulo declara alcanzable por escrito en el docblock de
  // (`esperarDisponibilidadDecidible`, `../infrastructure/solana/disponibilidad-decidible.ts:72`): el
  // chunk de `next/dynamic` no carga ⇒ el árbol nunca monta ⇒ la gracia nunca corre ⇒ la
  // disponibilidad queda en `"unknown"` PARA SIEMPRE.
  //
  // ⚠️ LO QUE ESTE BLOQUE **NO** MIDE, escrito ANTES de que alguien se apoye en su verde: sin
  // `SolanaProviders` no hay ningún `.wallet-adapter-modal` que consultar, así que un `querySelector`
  // de esa clase acá daría `null` SIEMPRE y sería vacuo — es la lección del cero uniforme. El
  // observable del selector vive en `vuelta-por-enlace-carrera.test.tsx` (CD-17). Lo que acá se mide en
  // su lugar es `execute()`, y la relación entre los dos es de LLAMADOR: `openModal()` vive adentro de
  // `connect()` del adaptador de Solana, que vive adentro de `ConnectWallet.execute()` ⇒ 0 llamadas a
  // `execute()` implica 0 llamadas a `openModal()` por este camino. Eso es una
  // DERIVACIÓN DEL GRAFO DE LLAMADAS, ⛔ no una medición de esta suite.

  /** 🔴 IDÉNTICO A `sembrarVuelta` (`:95`) SALVO EN LA LÍNEA QUE DESHACE: la disponibilidad vuelve a
   *  `"unknown"`, que es como arranca un navegador de verdad, y ⛔ se queda ahí PARA SIEMPRE porque
   *  este archivo no monta el árbol de providers. Ésa es toda la diferencia, y es la carrera. */
  function sembrarVueltaConLaDisponibilidadSinDecidir(paso: string) {
    sembrarVuelta(paso);
    solanaWalletBridge.setWalletAvailability("unknown");
  }

  /** El recorrido que SÍ llega a `execute()`: la vuelta del paso `conectar` que trajo dirección (es la
   *  PUERTA 2 de `./vuelta-por-enlace-carrera.test.tsx`, acá sin árbol de providers). ⛔ Hereda de
   *  `RecorridoPorEnlaceNulo`, que TIRA en todo lo demás: un camino no previsto se VE. */
  class RecorridoQueConectaPorEnlace extends RecorridoPorEnlaceNulo {
    override remesaEnCurso(): string | null {
      return REM;
    }
    override async completar(): Promise<never> {
      return { estado: "conectado", direccion: DIRECCION } as never;
    }
  }
  /** 🔴 `wallet: new SolanaWalletAdapter()` Y ⛔ NO `FakeWallet`, y es la lección del auto-blindaje W4:
   *  el caso de uso `ConnectWallet` recibe `o.wallet` (`connectWallet`, `../test-support/test-container.ts:100`), así que
   *  con el default el contador de abajo estaría espiando un camino que el defecto no toca. */
  function contenedorQueLlegaAExecute(repo: InMemoryRepo) {
    return buildTestContainer({
      repo,
      wallet: new SolanaWalletAdapter(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: new RecorridoQueConectaPorEnlace(),
    });
  }

  /** Reloj REAL más allá del techo. ⚠️ Se DERIVA de la constante y no se escribe `3000` a mano; que la
   *  constante no pueda crecer hasta volver eterna esta espera lo sostiene el otro lado del invariante
   *  de `T-075-TECHO`, que este mismo fix-pack le agregó. */
  async function dejarVencerElTecho() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, TECHO_DISPONIBILIDAD_MS + 400));
    });
  }

  // ── fix-pack 1 · CR/BLQ-1 · el gate de `:4005` es «marca CONOCIDA», ⛔ no `marca != null` ────────
  // 🔴 LA COMBINACIÓN QUE NO EJERCITABA NADIE: marca AJENA **×** disponibilidad `unknown`. El control
  // negativo de `:798` siembra la marca ajena, pero su arnés escribe `availability = "none"`, así que
  // allá la espera resuelve en el primer tick y esta rama no se ejecuta ni con el gate roto. Medido por
  // el CR sobre el árbol entregado: con `?dl=una-marca-que-nadie-escribio` en la barra, la pantalla
  // mostraba el copy del techo.
  it("T-075-1c (AC-1): una marca AJENA con la disponibilidad SIN DECIDIR ⛔ no entra a la espera", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVueltaConLaDisponibilidadSinDecidir("una-marca-que-nadie-escribio");
    // CD-18 · el fixture fabricó el caso, y se afirman las TRES mitades que lo definen.
    expect(new URL(window.location.href).searchParams.get("dl")).toBe("una-marca-que-nadie-escribio");
    expect(MARCAS_DE_VUELTA as readonly string[]).not.toContain("una-marca-que-nadie-escribio");
    expect(
      solanaWalletBridge.getWalletAvailability(),
      "precondición: sin `unknown` este `it` repite el caso que `:798` ya cubre y no mide nada nuevo",
    ).toBe("unknown");

    render(<RemittanceFlow pasoInicial="send" container={contenedorQueLlegaAlFallthrough(repo)} />);

    // 1 · POR TIEMPO. La barra se limpia MUY por debajo del techo; con el gate en `marca != null` el
    //     productor queda bloqueado en la espera y esto se pone rojo por timeout. La distancia entre
    //     los dos números —1200 acá contra `TECHO_DISPONIBILIDAD_MS`— ES el discriminante.
    await waitFor(
      () =>
        expect(
          new URL(window.location.href).searchParams.get("dl"),
          "la barra sigue sucia 1200 ms después de montar: el productor está bloqueado en la espera, o sea que una marca AJENA entró al gate",
        ).toBeNull(),
      { timeout: 1200 },
    );
    // 2 · POR CONTENIDO, y es el síntoma exacto que midió el CR. Se deja correr el reloj MÁS ALLÁ del
    //     techo para que la ausencia signifique «no pasa» y no «todavía no llegó».
    await dejarVencerElTecho();
    expect(
      screen.queryByText(CAUSA_DEL_TECHO),
      "una marca ajena disparó la espera: el gate está mirando `marca != null` en vez de «marca conocida»",
    ).toBeNull();
    expect(screen.queryByText(SENAL_SIN_CONSUMIDOR), "una marca ajena disparó la señal del fallthrough").toBeNull();
    // ⚠️ EL TECHO DE ESTE `it` ES EXPLÍCITO Y NO COSMÉTICO: acá corre RELOJ REAL por encima de
    // `TECHO_DISPONIBILIDAD_MS`, y con el default de vitest (5 s) el rojo saldría como «Test timed out»
    // —o sea por el reloj y no por la propiedad—, que es un rojo que no dice nada. MEDIDO: con el gate
    // roto y el `waitFor` aflojado, el default se comía la aserción POR CONTENIDO antes de ejecutarla.
  }, 20_000);

  // ── fix-pack 1 · AR/BLQ-2 · LA RAMA DEL TECHO, QUE NO EJECUTABA NI UN TEST DEL REPO ──────────────
  // 🔴 M16 —reemplazar el cuerpo de esa rama por un `throw`, líneo-neutro— SOBREVIVÍA a la suite
  // entera: 162 archivos / 3305 tests en verde. ⚠️ ESE `3305` ES UNA FOTO DEL ÁRBOL EN QUE SE CORRIÓ EL EXPERIMENTO (fix-pack 1) Y ⛔ NO SE RE-DERIVA: re-escribirlo con el número de hoy falsearía la medición, porque el mutante se corrió contra ESA suite. Lo que sí quedaba implícito y ahora está dicho (AR-fp/MNR-6): no es una afirmación sobre el árbol actual, y el conteo vivo del repo vive en un solo sitio, con su fecha, en (`MARCAS_DE_VUELTA`, `../infrastructure/solana/deeplink/sesion.ts:495`). Y con él M14 (emitir otra causa) y M10-bis (borrar
  // `limpiarLaBarra()` de esa rama). Este `it` es el testigo de AC-3 que `sdd.md:530` declaraba
  // —«el módulo + un `it` de render»— y que nunca se había escrito.
  it("T-075-3d (AC-3): con la disponibilidad `unknown` PARA SIEMPRE vence el techo, la persona LEE la causa, la barra queda limpia y ⛔ no se llama a `execute()`", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVueltaConLaDisponibilidadSinDecidir("conectar");
    const c = contenedorQueLlegaAExecute(repo);
    const espia = vi.spyOn(c.connectWallet, "execute");
    expect(
      solanaWalletBridge.getWalletAvailability(),
      "precondición: si esto no es `unknown` el techo no puede vencer y el `it` mide otra cosa",
    ).toBe("unknown");

    render(<RemittanceFlow pasoInicial="send" container={c} />);

    // 1 · LA CAUSA PROPIA, EN PANTALLA. ⛔ Ni silencio (M16) ni otra causa (M14) ni `"none"` degradado.
    expect(
      await screen.findByText(CAUSA_DEL_TECHO, {}, { timeout: TECHO_DISPONIBILIDAD_MS + 2000 }),
      "el techo venció y la persona no leyó nada: volvió de firmar y la pantalla se quedó muda",
    ).toBeInTheDocument();
    // 2 · el paso 2 TAMBIÉN corre en esta rama (M10-bis).
    expect(
      new URL(window.location.href).searchParams.get("dl"),
      "el techo venció y dejó el rastro de la vuelta en la barra",
    ).toBeNull();
    // 3 · ⛔ Y NO SE PIDIÓ NINGUNA CONEXIÓN. El techo sale por su causa propia, corta, y no navega.
    expect(
      espia,
      "el techo venció y aun así se llamó a `execute()`: por ahí adentro está `openModal()`, o sea el selector que esta HU vino a cerrar",
    ).toHaveBeenCalledTimes(0);

    // 🔴 CONTROL POSITIVO EN LA MISMA CORRIDA, con el MISMO contador y el MISMO container: un cero sólo
    // dice «no pasó» si el mismo instrumento sabe dar ≠ 0 en el caso que sí pasa.
    cleanup();
    window.history.replaceState(null, "", "/enviar");
    sembrarVuelta("conectar"); // ⚠️ LA ÚNICA VARIABLE QUE SE MUEVE: acá la disponibilidad SÍ está decidida
    render(<RemittanceFlow pasoInicial="send" container={c} />);
    await waitFor(() =>
      expect(
        espia.mock.calls.length,
        "el MISMO contador no llega a 1 ni con la disponibilidad decidida: el cero de arriba no dice «no pasó», dice «no medí»",
      ).toBeGreaterThan(0),
    );
  }, 20_000);

  // ── fix-pack 1 · AR/BLQ-5 · AC-4: la espera TAMBIÉN cuelga de la bandera de repliegue ────────────
  // ⚠️ ⛔ ESTO NO ES UNA SEGUNDA PERILLA, QUE ES LO QUE CD-3 PROHÍBE: es LA MISMA env
  // (`deeplinkEnabled`, `./wallet-availability.ts:156`), aplicada en un sitio más. Con la bandera
  // apagada —que es EL repliegue declarado del BUILD, y el escenario es apagarla con gente a mitad de
  // viaje— una vuelta con `?dl=` bloqueaba el consumidor de montaje hasta la gracia y podía mostrar un
  // copy que en `b71e917` no existía. M17 (agregar `&& deeplinkEnabled()`) dejaba la suite en 162/3305
  // verde: ningún `it` distinguía las dos formas. ⚠️ Ese `3305` es una FOTO del árbol del fix-pack 1, igual que el de `:947`, y ⛔ no se re-deriva por el mismo motivo: el mutante se corrió contra ESA suite (AR-fp/MNR-6).
  it("T-075-4b (AC-4): con la bandera de repliegue AUSENTE la vuelta ⛔ no entra a la espera", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVueltaConLaDisponibilidadSinDecidir("crear-nonce");
    // ⚠️ AUSENTE y ⛔ no `"false"`: es el estado de un build que nunca la declaró, y el resolver es
    // opt-in estricto (`resolveSolanaDeeplinkEnabled`, `../infrastructure/chain.ts:269`).
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", undefined);
    // CD-18 · las CUATRO mitades del fixture, y la primera es la que decide si el `it` mide algo.
    expect(deeplinkEnabled(), "precondición: la bandera quedó PRENDIDA y este `it` está midiendo el caso de siempre").toBe(false);
    expect(new URL(window.location.href).searchParams.get("dl")).toBe("crear-nonce");
    expect(MARCAS_DE_VUELTA as readonly string[]).toContain("crear-nonce");
    expect(solanaWalletBridge.getWalletAvailability()).toBe("unknown");

    render(<RemittanceFlow pasoInicial="send" container={contenedorQueLlegaAlFallthrough(repo)} />);

    await waitFor(
      () =>
        expect(
          new URL(window.location.href).searchParams.get("dl"),
          "con la bandera apagada la barra sigue sucia 1200 ms después: la espera corrió igual, o sea que la superficie nueva NO es replegable",
        ).toBeNull(),
      { timeout: 1200 },
    );
    await dejarVencerElTecho();
    expect(
      screen.queryByText(CAUSA_DEL_TECHO),
      "con la bandera de repliegue apagada la persona leyó un copy que en `b71e917` no existía (AC-4)",
    ).toBeNull();
  }, 20_000);

  // 🔴 LA OTRA MITAD DE AC-4, Y ES UN HALLAZGO PROPIO DE ESTE FIX-PACK: la SEÑAL de `:4070` es copy tan
  // nuevo como el del techo, así que con la bandera apagada tampoco puede aparecer. Acá la
  // disponibilidad va YA DECIDIDA a propósito: así la espera es un no-op y la ÚNICA variable que se
  // mueve entre las dos mitades de este `it` es la bandera.
  it("T-075-4c (AC-4): con la bandera AUSENTE la señal del fallthrough ⛔ tampoco aparece, y con la bandera puesta SÍ", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("crear-nonce");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", undefined);
    expect(deeplinkEnabled(), "precondición: la bandera quedó prendida").toBe(false);

    render(<RemittanceFlow pasoInicial="send" container={contenedorQueLlegaAlFallthrough(repo)} />);
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("dl")).toBeNull());
    expect(
      screen.queryByText(SENAL_SIN_CONSUMIDOR),
      "con la bandera de repliegue apagada la persona leyó la señal, que es copy que `b71e917` no tenía (AC-4)",
    ).toBeNull();

    // 🔴 CONTROL POSITIVO EN LA MISMA CORRIDA: el MISMO fixture, moviendo SÓLO la bandera, SÍ la muestra.
    // Sin esto, el `queryByText` de arriba sería un cero que no distingue «la bandera la apagó» de «este
    // fixture nunca llega al fallthrough».
    cleanup();
    window.history.replaceState(null, "", "/enviar");
    sembrarVuelta("crear-nonce"); // vuelve a poner la env en `"true"`
    expect(deeplinkEnabled(), "el control positivo no encendió la bandera: la ausencia de arriba no dice nada").toBe(true);
    render(<RemittanceFlow pasoInicial="send" container={contenedorQueLlegaAlFallthrough(repo)} />);
    await waitFor(() => expect(screen.getByText(SENAL_SIN_CONSUMIDOR)).toBeInTheDocument());
  }, 20_000);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// HU-075/reanudar — EL BLOQUEANTE DEL FOUNDER: volver de la billetera y SEGUIR DONDE ESTABA
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 EL SÍNTOMA, TEXTUAL, EN EL SITIO DESPLEGADO: *«yo ya estoy en la 3ra pantalla, ya llené datos, el
// monto, la persona que recibe, la cuenta del banco, le doy ok y me pasa a una pantalla para conectar
// la wallet, conecto, debería seguir el proceso pero me re envía a la pantalla inicial»*.
//
// 🔴 LA CAUSA, MEDIDA: la vuelta de la billetera es un REMONTE de la página. `step` es estado de React
// y `pasoInicial` vale `"bienvenida"` por default, así que el recorrido arranca de cero SIEMPRE. El
// consumidor de la vuelta repoblaba la conexión (`setAddress` y los dos del KYC) y nada más: no había
// un solo `setStep` en la rama `conectado`.
//
// 🔴 POR QUÉ NINGÚN `it` DE ESTE ARCHIVO LO VEÍA, y es la lección que se cobró caro. Todos montan con
// `pasoInicial="send"` y ninguno pregunta EN QUÉ PANTALLA quedó la persona. El más cercano —el control
// de `T-065-8b`— sólo cuenta las llamadas a `connectWallet.execute()`, y ese contador da 1 tanto si el
// recorrido sigue como si muere en la pantalla de entrada. ⇒ **el caso de prueba es el RECORRIDO
// COMPLETO y el observable es la PANTALLA**, no un contador ni una dirección en un chip. Yo mismo di
// esta HU por funcionando mirando una captura del INICIO del recorrido.
//
// ⚠️ `pasoInicial="bienvenida"` NO ES DECORATIVO ACÁ: es el default de producción (lo declara el
// docblock de `pasoInicial` en `flow.tsx`, y `barra-destinos.test.tsx` tiene el candado que impide que
// `app/page.tsx` pase otro). Montar en `"send"` como hacen los demás `it` de este archivo ESCONDE
// exactamente el defecto, porque el paso inicial ya sería uno del flujo.
//
// ⛔ LO QUE ESTOS `it` NO MIDEN, dicho antes de que alguien se apoye en su verde:
//   1. Corren en **jsdom**, con `completar()` doblado. NO sustituyen a un teléfono: lo que el founder
//      reportó se comprueba en un celular. Lo que se mide acá es el CABLEADO de la pantalla.
//   2. No miden el segundo salto real (el sobre cifrado del connect); eso vive en
//      `preparacion-por-enlace.test.ts`. Acá el doble contesta el desenlace y se mide qué hace la
//      pantalla con él.
describe("HU-075/reanudar: la vuelta por enlace RETOMA el recorrido con los datos ya cargados", () => {
  /** El borrador EXACTO que deja `onSend`: la remesa ya existe en el repo —`createRemittance` la
   *  escribió antes del salto— y ⛔ NO tiene `ownerAddress` (eso lo escribe `startKyc`, más adelante).
   *  Es lo que hace inservible al historial para recuperarla: `repo.list(dueño)` NO la devuelve. Por
   *  eso la reanudación del connect NO puede pasar por el mismo camino que la del `firmar-tx`. */
  async function sembrarBorradorDelFormulario(repo: InMemoryRepo) {
    const r = Remittance.create(REM, beneficiary(), Money.of(400, "USDC"), T0);
    await repo.save(r);
    return r;
  }

  /** ⛔ Hereda de `RecorridoPorEnlaceNulo`, que TIRA en todo lo demás: un camino no previsto se VE. */
  class RecorridoQueVuelveConectado extends RecorridoPorEnlaceNulo {
    override remesaEnCurso(): string {
      return REM;
    }
    override async completar(): Promise<never> {
      return { estado: "conectado", direccion: DIRECCION } as never;
    }
    override async estadoDeLaCuentaDeNonce(): Promise<never> {
      return "no-pudimos-preguntar" as never;
    }
  }

  function contenedorQueVuelveConectado(repo: InMemoryRepo) {
    return buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(), // el adaptador REAL: lo que se prueba es el cableado
      recorridoPorEnlace: new RecorridoQueVuelveConectado(),
    });
  }

  // 🔴 MUTANTE QUE MATA (medido, ver el reporte): en `flow.tsx:286`, borrar
  // `if (remittanceId !== undefined) void onConnect({ remittanceId, rc: r });` del `alConectar`. Es
  // exactamente el código de antes de esta HU, y deja este `it` en rojo por su motivo propio: el
  // `findByText("Revisá el envío")` no encuentra nada y la pantalla sigue mostrando la bienvenida.
  it("T-075-REANUDAR-1: con el formulario YA LLENO, al volver de la billetera la persona retoma en `review` con SUS datos", async () => {
    const repo = new InMemoryRepo();
    await sembrarBorradorDelFormulario(repo);
    sembrarVuelta("conectar");
    const c = contenedorQueVuelveConectado(repo);

    // CD-18 — el fixture fabricó el caso ANTES de medir nada: la barra trae la vuelta y la remesa está
    // en el repo sin dueño, o sea el estado exacto de quien saltó desde la pantalla `connect`.
    expect(new URL(window.location.href).searchParams.get("dl")).toBe("conectar");
    expect((await repo.get(REM))?.snapshot.ownerAddress).toBeNull();

    render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

    // 1 · EL RECORRIDO SIGUE. `review` es la pantalla a la que lleva conectar por el camino inyectado,
    // así que la vuelta por enlace aterriza en la MISMA, que es lo que "seguir el proceso" significa.
    expect(await screen.findByText("Revisá el envío")).toBeInTheDocument();

    // 2 · Y LLEGA CON LOS DATOS, que es la otra mitad del reporte («ya llené datos, el monto, la
    // persona que recibe, la cuenta del banco»). Los tres salen del snapshot del repo, no del estado
    // de React, que el remonte borró.
    expect(screen.getByText(/Mamá/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(TEST_CCI))).toBeInTheDocument();
    expect(screen.getAllByText("$400.00").length, "el monto del borrador no llegó a la pantalla que se retomó").toBeGreaterThan(0);

    // 3 · Y NO quedó nada de la pantalla de entrada por debajo.
    expect(screen.queryByRole("button", { name: /Empezar un envío/ })).toBeNull();
  });

  // 🔴 EL PAR NEGATIVO, Y ES LO QUE HACE FALSABLE AL DE ARRIBA. Mismo montaje, misma remesa en el
  // repo, misma bandera: la ÚNICA variable que se mueve es que NO hay vuelta en la barra. Sin esto, un
  // arreglo que saltara a `review` en cualquier montaje pasaría el `it` de arriba y rompería la
  // pantalla de entrada para todo el mundo (AC-1 de la HU 068).
  it("T-075-REANUDAR-1(control): si la vuelta NO trajo conexión, el MISMO montaje se queda en la bienvenida", async () => {
    const repo = new InMemoryRepo();
    await sembrarBorradorDelFormulario(repo);
    sembrarVuelta("conectar"); // MISMA barra, MISMO viaje, MISMA bandera, MISMO cuadrante que arriba
    /** La ÚNICA variable que se mueve: `completar()` contesta `nada` en vez de `conectado`. */
    class RecorridoSinConexion extends RecorridoPorEnlaceNulo {
      override remesaEnCurso(): string {
        return REM;
      }
      override async completar(): Promise<never> {
        return { estado: "nada" } as never;
      }
    }
    const c = buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: new RecorridoSinConexion(),
    });

    render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

    expect(await screen.findByRole("button", { name: /Empezar un envío/ })).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("Revisá el envío")).toBeNull();
  });

  // 🔴 EL ATERRIZAJE QUE DE VERDAD OCURRE EN PRODUCCIÓN, Y NO ES EL DE ARRIBA. Desde `connect` la
  // persona salta con `dl=conectar`; al volver, `connectWallet.execute()` le pide LA FIRMA del PoP de
  // KYC y la manda a la billetera OTRA VEZ, ahora con `dl=pop-kyc`. La vuelta de ese SEGUNDO salto
  // entra por `resolverVueltaDelPermiso`, no por la rama `conectado`, y hasta esta HU moría en la
  // pantalla de entrada igual que la otra. Arreglar una sola de las dos mueve el síntoma un salto más
  // allá y lo deja idéntico para quien lo sufre.
  //
  // ⛔ Y ACÁ ESTÁ LA RAZÓN POR LA QUE `onConnect` RECIBE EL `rc` YA RESUELTO EN VEZ DE CONECTAR DE
  // NUEVO: la prueba del PoP por enlace es de UN SOLO USO (`leerPruebaPop` borra el ancla ANTES de
  // devolver), así que una segunda llamada a `connectWallet.execute()` saldría `hay-que-salir` y
  // mandaría a la persona a firmar por tercera vez. Este `it` lo pincha contando las llamadas.
  //
  // 🔴 MUTANTE QUE MATA: en `flow.tsx`, volver `alConectar(rk, remId ?? undefined)` a `alConectar(rk)`
  // dentro de `resolverVueltaDelPermiso`.
  it("T-075-REANUDAR-2: la vuelta del PoP de KYC también retoma el recorrido, y ⛔ sin pedir una segunda conexión", async () => {
    const repo = new InMemoryRepo();
    await sembrarBorradorDelFormulario(repo);
    sembrarVuelta("pop-kyc");
    class RecorridoConPopDeKyc extends RecorridoPorEnlaceNulo {
      override remesaEnCurso(): string {
        return REM;
      }
      override async completarPop(): Promise<never> {
        return { estado: "pop-listo", proposito: "pop-kyc" } as never;
      }
    }
    const c = buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: new RecorridoConPopDeKyc(),
    });
    const conectar = vi.spyOn(c.connectWallet, "execute");

    expect(new URL(window.location.href).searchParams.get("dl")).toBe("pop-kyc");

    render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

    expect(await screen.findByText("Revisá el envío")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(TEST_CCI))).toBeInTheDocument();
    expect(
      conectar,
      "el recorrido pidió una SEGUNDA conexión: con la prueba del PoP ya consumida eso manda a la persona a firmar otra vez",
    ).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// HU-075/gesto — EL SEGUNDO SALTO SALE DE UN TOQUE, NO DE UN EFECTO DE MONTAJE
//
// 🔴 EL DEFECTO, MEDIDO EN EL TELÉFONO DEL FOUNDER con el bloque `?diag=1` (foto t=12830 ms):
//
//     marca al montar : conectar          disco : viaje=sí eleccion=sí pop=sí
//     connect         : hay-que-salir     continuacion : no corrió
//     pantalla        : bienvenida        corte : sin corte      error : sin error
//
// O sea: la vuelta llegó bien, el viaje estaba vigente, `connectWallet.execute()` pidió el SEGUNDO
// salto (la firma del PoP de KYC), no hubo excepción… y a los 12,8 segundos la persona seguía en la
// bienvenida. La marca nunca pasó de `conectar` a `pop-kyc`: el segundo salto NO SE DISPARÓ.
//
// LA CAUSA: `flow.tsx:286` resolvía ese desenlace con `window.location.href = r.irA` DESDE EL EFECTO
// DE MONTAJE, o sea una navegación programática a una app externa fuera de todo gesto de la persona.
// Los navegadores móviles la descartan sin error y sin rastro, que es exactamente lo que el
// diagnóstico muestra.
//
// ⚠️ QUÉ MIDEN ESTOS `it` Y QUÉ NO (CD-12, y va sin suavizar). jsdom NO bloquea nada: acá una
// asignación a `location.href` "funciona" siempre. Lo que estos `it` miden es que la asignación
// PROGRAMÁTICA YA NO OCURRE y que en su lugar queda en pantalla un `<a href>` que la persona toca —el
// mismo patrón que este repo ya tiene probado para `phantomBrowseUrl` (`flow.tsx:1379`)—. Que un
// teléfono real descarte la primera y honre el segundo NO lo mide este archivo: lo mide el
// diagnóstico de arriba, de un lado, y el patrón ya desplegado, del otro.
//
// 🔴 Y MIDEN LA OTRA MITAD, que era la hipótesis rival: que `r.irA` llegara VACÍO o mal formado, con
// lo cual la navegación no habría tenido a dónde ir y la causa sería otra. Por eso el contenedor de
// `T-075-GESTO-1` cablea el `pop` REAL (`SolanaWalletAdapter`) contra el disco REAL que siembra
// `sembrarVuelta`: el `irA` que llega a la pantalla lo arma el código de producción, y el `it` LEE su
// forma. Lo único de mentira es la respuesta del emisor del desafío.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("HU-075/gesto: el segundo salto necesita un TOQUE", () => {
  const TITULO_FIRMA = /Falta una firma para seguir/;
  const CTA_FIRMA = /Ir a firmar a mi billetera/;

  /** Igual que el del bloque de arriba: la remesa que dejó `onSend`, sin `ownerAddress`. */
  async function sembrarBorrador(repo: InMemoryRepo) {
    await repo.save(Remittance.create(REM, beneficiary(), Money.of(400, "USDC"), T0));
  }

  /** Reemplaza `window.location` por uno que ANOTA los `href = …` en vez de navegar. Es la misma
   *  receta que `flow.test.tsx:3236`, y es la única forma de ver la navegación programática en jsdom.
   *  Devuelve el array de lo asignado y el restaurador. */
  function espiarNavegacion(): { asignado: string[]; restaurar: () => void } {
    const original = window.location;
    const asignado: string[] = [];
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...original,
        get href() {
          return original.href;
        },
        set href(v: string) {
          asignado.push(v);
        },
        get origin() {
          return original.origin;
        },
        get search() {
          return original.search;
        },
        get pathname() {
          return original.pathname;
        },
      },
    });
    return { asignado, restaurar: () => Object.defineProperty(window, "location", { configurable: true, value: original }) };
  }

  /** 🔴 EL `irA` DE PRODUCCIÓN, COPIADO DE UNA CORRIDA REAL Y NO INVENTADO. Es la forma que devolvió
   *  `T-075-GESTO-IRA` (`../infrastructure/solana/preparacion-por-enlace.test.ts`), que sí corre el
   *  cableado de `container.ts:185` con el disco real. ⛔ ACÁ NO SE PUEDE CORRER ESE CAMINO, y la
   *  razón está MEDIDA (sonda temporal del 2026-08-30, creada, corrida y borrada): en el entorno jsdom
   *  de este repo `new TextEncoder().encode(…)` devuelve un `Uint8Array` DE OTRO REALM ⇒
   *  `b instanceof Uint8Array` es **false**, y `tweetnacl` rechaza el cifrado con
   *  `TypeError: unexpected type, use Uint8Array` adentro de (`sobre`, `../infrastructure/solana/deeplink/protocol.ts:170`).
   *  O sea que `urlFirmarMensaje` es INALCANZABLE desde jsdom. ⇒ el reparto es: el `irA` real lo mide
   *  el `it` de node; lo que estos `it` miden es qué HACE la pantalla con él. */
  const IR_A_POP_KYC = "https://phantom.app/ul/v1/signMessage?dapp_encryption_public_key=6b1t&nonce=9xQz&redirect_link=https%3A%2F%2Fchaski.test%2Fenviar%3Fdl%3Dpop-kyc&payload=Ax7k";

  /** El doble de `ConnectWallet` que devuelve la suspensión, con la forma EXACTA del tipo de
   *  `connect-wallet.ts:83`. ⛔ No es un `as any`: si el desenlace cambia de forma, esto no compila. */
  function connectWalletQueSuspende(irA = IR_A_POP_KYC) {
    return { execute: async () => ({ estado: "hay-que-salir" as const, address: DIRECCION, irA, esperando: "firma-pop-kyc" as const }) } as unknown as Container["connectWallet"];
  }

  class RecorridoQueVuelveConectado2 extends RecorridoPorEnlaceNulo {
    override remesaEnCurso(): string {
      return REM;
    }
    override async completar(): Promise<never> {
      return { estado: "conectado", direccion: DIRECCION } as never;
    }
    override async estadoDeLaCuentaDeNonce(): Promise<never> {
      return "no-pudimos-preguntar" as never;
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 🔴 MUTANTE QUE MATA (medido, ver el reporte): en `flow.tsx:286`, dentro de `alConectar`, volver
  // `setSaltoPendiente(r.irA)` a `window.location.href = r.irA`. Deja este `it` en rojo por su motivo
  // propio: `asignado` vuelve a tener la URL de Phantom y el `<a>` no se renderiza.
  it("T-075-GESTO-1: con la vuelta resolviendo `hay-que-salir`, ⛔ NO navega sola y ofrece un enlace que la persona toca", async () => {
    const repo = new InMemoryRepo();
    await sembrarBorrador(repo);
    sembrarVuelta("conectar");
    const c = buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: new RecorridoQueVuelveConectado2(),
      useCases: { connectWallet: connectWalletQueSuspende() },
    });

    // CD-18 — el fixture fabricó el caso ANTES de medir: la barra trae la vuelta, la remesa está en el
    // repo sin dueño, y `execute()` contesta la suspensión, que es lo que leyó el diagnóstico.
    expect(new URL(window.location.href).searchParams.get("dl")).toBe("conectar");
    expect((await repo.get(REM))?.snapshot.ownerAddress).toBeNull();
    expect((await c.connectWallet.execute()).estado, "el fixture no reproduce el caso: `execute()` no pidió el segundo salto").toBe("hay-que-salir");

    const espia = espiarNavegacion();
    try {
      render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

      // 1 · SE ESPERA A QUE LA VUELTA RESUELVA, Y ⛔ NO A QUE APAREZCA EL ENLACE. La diferencia es lo
      //     que hace que el mutante muera POR SU MOTIVO: con un `findByRole` acá, la versión que
      //     navega sola moriría por "no encuentro el enlace", que es el síntoma, y el `expect` de
      //     abajo —el que nombra la navegación y la IMPRIME— no llegaría a correr nunca.
      await waitFor(() =>
        expect(
          espia.asignado.length > 0 || screen.queryByRole("link", { name: CTA_FIRMA }) !== null,
          "la vuelta no resolvió: ni navegó ni ofreció el enlace",
        ).toBe(true),
      );

      // 2 · ⛔ NO HUBO NINGUNA NAVEGACIÓN PROGRAMÁTICA. Es el assert que mata el mutante.
      expect(
        espia.asignado,
        "la pantalla navegó sola a la billetera: en un móvil eso lo descarta el navegador sin error y la persona se queda mirando la bienvenida",
      ).toEqual([]);

      // 3 · EL ARREGLO. La pantalla ofrece el salto como un `<a href>` y la persona sigue donde estaba.
      const enlace = screen.getByRole("link", { name: CTA_FIRMA });
      expect(screen.getByText(TITULO_FIRMA)).toBeInTheDocument();

      // 3 · Y EL DESTINO LLEGA TAL CUAL: la pantalla no lo parsea, no lo reescribe y no le agrega nada.
      //     Es la misma regla que `flow.tsx:521` ya tenía escrita para la navegación del depósito.
      expect(enlace).toHaveAttribute("href", IR_A_POP_KYC);

      // 4 · Y EL BLOQUE DE DIAGNÓSTICO PUBLICA LA FORMA DEL DESTINO. ⛔ Esto NO es decoración: es lo
      //     único que deja volver a separar EN EL TELÉFONO las dos causas que la foto del founder no
      //     separaba (`irA` vacío vs. navegación sin gesto) si algo cambia río arriba. Sin este
      //     `expect`, `formaDelDestino` sería un `export` que corre en producción y que ningún control
      //     mira, o sea un artefacto sin llamador verificado.
      expect(
        leerHito("connect"),
        "el renglón `connect` del bloque `?diag=1` dejó de publicar la forma del destino",
      ).toBe(`hay-que-salir · destino https://phantom.app/ul/v1/signMessage (${IR_A_POP_KYC.length} chars)`);
    } finally {
      espia.restaurar();
    }
  });

  // 🔴 EL PAR NEGATIVO, Y ES LO QUE HACE FALSABLE AL DE ARRIBA. Mismo montaje, misma barra, mismo
  // disco: la ÚNICA variable que se mueve es que `execute()` resuelve `listo`. Sin esto, un arreglo
  // que pintara el aviso en CUALQUIER montaje pasaría el `it` de arriba y le pondría un cartel de
  // "falta una firma" a todo el mundo.
  it("T-075-GESTO-1(control): si la vuelta resuelve `listo`, ⛔ no hay aviso de firma y el recorrido sigue", async () => {
    const repo = new InMemoryRepo();
    await sembrarBorrador(repo);
    sembrarVuelta("conectar");
    const c = buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: new RecorridoQueVuelveConectado2(),
    });
    expect((await c.connectWallet.execute()).estado, "el control no es control: acá `execute()` también suspende").toBe("listo");

    render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

    expect(await screen.findByText("Revisá el envío")).toBeInTheDocument();
    expect(screen.queryByText(TITULO_FIRMA)).toBeNull();
    expect(screen.queryByRole("link", { name: CTA_FIRMA })).toBeNull();
  });

  // 🔴 EL SEGUNDO SITIO CON EL MISMO DEFECTO, y corre por el mismo efecto de montaje: `alReanudar`.
  // La persona vuelve del salto del depósito, `confirmAndSend.execute()` pide OTRA firma, y hasta este
  // arreglo eso también era un `window.location.href` sin gesto. ⛔ NO es el mismo camino que
  // `flow.tsx:521` (ése corre adentro del `onClick` de "Confirmar y enviar", que SÍ es un gesto, y lo
  // mide `T-062-22/AC-1` en `flow.test.tsx`).
  //
  // 🔴 MUTANTE QUE MATA: en `flow.tsx:286`, dentro de `alReanudar`, volver `setSaltoPendiente(r.irA)`
  // a `window.location.href = r.irA`.
  it("T-075-GESTO-2: la reanudación del depósito tampoco navega sola, y ofrece el mismo enlace", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("firmar-tx");
    const IR_A = "https://phantom.app/ul/v1/signTransaction?payload=abc&nonce=def";
    const c = buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: new RecorridoPorEnlaceReal(),
      useCases: {
        confirmAndSend: { execute: async () => ({ estado: "hay-que-salir", irA: IR_A, esperando: "firma-tx" }) } as unknown as Container["confirmAndSend"],
      },
    });

    const espia = espiarNavegacion();
    try {
      render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

      // Mismo orden que en `T-075-GESTO-1`, y por el mismo motivo: primero se espera a que la vuelta
      // resuelva DE CUALQUIERA DE LAS DOS FORMAS, y recién después se acusa a la navegación. Al revés,
      // el mutante moriría por "no encuentro el enlace" y este `expect` no correría nunca.
      await waitFor(() =>
        expect(
          espia.asignado.length > 0 || screen.queryByRole("link", { name: CTA_FIRMA }) !== null,
          "la reanudación no resolvió: ni navegó ni ofreció el enlace",
        ).toBe(true),
      );
      expect(
        espia.asignado,
        "la reanudación navegó sola a la billetera desde el efecto de montaje",
      ).toEqual([]);
      expect(screen.getByRole("link", { name: CTA_FIRMA })).toHaveAttribute("href", IR_A);
    } finally {
      espia.restaurar();
    }
  });

  // ⛔ EL COPY NO PUEDE AFIRMAR QUE ALGO FALLÓ, y no falló: la firma volvió, el viaje está vigente y la
  // billetera quedó conectada. Es el pecado que esta HU persigue desde el primer día, y un `it` sobre
  // el texto es lo único que lo pone rojo cuando alguien lo "mejore".
  it("T-075-GESTO-3: el copy dice que la billetera quedó conectada y que falta UNA firma, y ⛔ no dice que falló ni que hay que empezar de nuevo", async () => {
    const repo = new InMemoryRepo();
    await sembrarBorrador(repo);
    sembrarVuelta("conectar");
    const c = buildTestContainer({ repo, wallet: new FakeWallet(), connectedWallet: new SolanaWalletAdapter(), recorridoPorEnlace: new RecorridoQueVuelveConectado2(), useCases: { connectWallet: connectWalletQueSuspende() } });

    // ⚠️ EL ESPÍA VA ACÁ AUNQUE ESTE `it` NO MIDA LA NAVEGACIÓN, y no es simetría: es para que el
    // ARNÉS no rompa lo que mide. MEDIDO el 2026-08-30: sin él, al correr el mutante de `alConectar`
    // este `it` hacía una asignación REAL a `window.location.href` en jsdom, y en 1 de 4 corridas del
    // archivo completo apareció un rojo EXTRA en `T-065-8` —un `it` que no toca nada de esto— que en
    // aislamiento pasaba 3 de 3. Un arnés que ensucia el entorno vuelve ilegibles las corridas de
    // mutación que vengan después, que es exactamente cómo se fabrica un falso KILLED.
    const espia = espiarNavegacion();
    try {
      render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);
      const aviso = (await screen.findByRole("link", { name: CTA_FIRMA })).closest("div") as HTMLElement;
      const texto = aviso.textContent ?? "";

      expect(texto).toMatch(/quedó conectada/);
      expect(texto).toMatch(/una firma más/);
      for (const prohibida of [/fall(ó|a)/i, /error/i, /empez(á|a)r? de nuevo/i, /volv(é|e)r? a empezar/i, /no se pudo/i, /—/]) {
        expect(texto, `el copy del aviso dice algo que no es cierto o que no corresponde: ${prohibida}`).not.toMatch(prohibida);
      }
    } finally {
      espia.restaurar();
    }
  });

  // ⛔ EL PAR POSITIVO DE `T-075-GESTO-3`, que mide sólo lo que el copy NO dice. La pregunta del founder
  // fue textual: «por qué me pide dos firmas cuando conecto wallet, es raro», y hasta acá la pantalla no
  // la contestaba en ninguna parte. Un `it` que sólo prohíbe palabras queda verde con un copy mudo.
  //
  // 🔴 MUTANTE QUE MATA (medido, ver el reporte): en `flow.tsx:757`, borrar del cuerpo del aviso la
  // frase «Conectar y firmar son dos permisos distintos: conectar nos da tu dirección, y cada firma la
  // autorizás vos por separado.». Deja ESTE `it` en rojo por su motivo propio (los dos `toMatch` de
  // abajo) y ⛔ NO toca a `T-075-GESTO-3`, que sigue verde porque lo que él mide son ausencias.
  //
  // ⚠️ LO QUE ESTE `it` **NO** MIDE, declarado: que la persona ENTIENDA la frase. Eso no se mide con un
  // `toMatch` y no se afirma acá. Lo único verificado es que la pantalla lo DICE, en el mismo aviso y en
  // el mismo momento en que la pregunta aparece.
  it("T-075-COPY-2FIRMAS: el aviso explica POR QUÉ hace falta esa firma, sin nombrar un mecanismo que no aplica a los tres saltos", async () => {
    const repo = new InMemoryRepo();
    await sembrarBorrador(repo);
    sembrarVuelta("conectar");
    const c = buildTestContainer({ repo, wallet: new FakeWallet(), connectedWallet: new SolanaWalletAdapter(), recorridoPorEnlace: new RecorridoQueVuelveConectado2(), useCases: { connectWallet: connectWalletQueSuspende() } });
    const espia = espiarNavegacion(); // mismo motivo que en `T-075-GESTO-3`: que el arnés no ensucie el entorno
    try {
      render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);
      const aviso = (await screen.findByRole("link", { name: CTA_FIRMA })).closest("div") as HTMLElement;
      const texto = aviso.textContent ?? "";

      // 1 · CONTESTA LA PREGUNTA: conectar y firmar no son lo mismo, y cada firma se autoriza sola.
      expect(texto, "el aviso no dice que conectar y firmar sean dos cosas distintas").toMatch(/dos permisos distintos/);
      expect(texto, "el aviso no dice que cada firma se autoriza por separado").toMatch(/cada firma la autorizás vos por separado/);

      // 2 · ⛔ Y NO NOMBRA LA PRUEBA DE POSESIÓN, que es lo que hace verdadera a la frase en los TRES
      // saltos: este MISMO aviso sale para `firmar-tx` y `firmar-patrocinio`, donde «esta firma prueba
      // que la billetera es tuya» sería FALSO. Sin este `expect`, un copy más específico y más lindo
      // pasaría el punto 1 y mentiría en el camino del depósito.
      for (const prohibida of [/prueba que .{0,30}es tuya/i, /posesión/i]) {
        expect(texto, `el aviso afirma un mecanismo que no vale para los tres saltos: ${prohibida}`).not.toMatch(prohibida);
      }
    } finally {
      espia.restaurar();
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // HU-075/aterrizaje — «me bota al inicio y me dice que falta una firma»
  //
  // 🔴 EL DEFECTO, TEXTUAL DEL FOUNDER: «cuando firmo la primera vez me bota al inicio y me dice que
  // falta una firma … debería pedirme la firma sin necesidad de ir al inicio». El BOTÓN es necesario
  // (el navegador descarta el salto automático: es todo el razonamiento de `T-075-GESTO-1`); mandarla
  // a la pantalla de entrada NO lo es.
  //
  // ⚠️ MEDIDO ANTES DE TOCAR NADA (sonda del 2026-08-30, creada, corrida y borrada): con `dl=firmar-tx`
  // y la reanudación devolviendo `hay-que-salir`, el `document.body` decía «Chaskitu plata a Perú, sin
  // vueltas · Falta una firma para seguir … · Tu plata no pasa por Chaski …», o sea el aviso ENCIMA de
  // la pantalla de entrada entera.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /** El CTA de la pantalla de entrada. Es lo que la persona ve cuando «la botan al inicio». */
  const CTA_INICIO = /Empezar un envío/;

  // 🔴 MUTANTE QUE MATA (medido, ver el reporte): en `flow.tsx:1195`, sacar `saltoPendiente === null` de
  // la condición del `<Bienvenida>`.
  // ⚠️ Y EL MUTANTE ESTÁ ELEGIDO PARA QUE NO LO MATE NINGÚN VECINO: `T-075-GESTO-2` monta este MISMO
  // fixture y sólo mira el `<a>`, así que sigue verde con la bienvenida puesta; y
  // `T-075-REANUDAR-1(control)` exige que la bienvenida SÍ aparezca cuando no hay conexión, o sea que
  // vigila el sentido contrario. El rojo sale con el nombre de este `it`.
  it("T-075-ATERRIZAJE-1: con la firma pendiente, la pantalla se queda pidiendo la firma y ⛔ NO vuelve al inicio", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("firmar-tx");
    const IR_A = "https://phantom.app/ul/v1/signTransaction?payload=abc&nonce=def";
    const c = buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: new RecorridoPorEnlaceReal(),
      useCases: {
        confirmAndSend: { execute: async () => ({ estado: "hay-que-salir", irA: IR_A, esperando: "firma-tx" }) } as unknown as Container["confirmAndSend"],
      },
    });

    const espia = espiarNavegacion();
    try {
      render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

      // 1 · Lo que la persona TIENE que poder hacer sigue estando.
      expect(await screen.findByRole("link", { name: CTA_FIRMA })).toHaveAttribute("href", IR_A);

      // 2 · Y la pantalla de entrada NO está debajo. ⛔ El `queryBy` va DESPUÉS del `findBy` de arriba a
      // propósito: preguntarlo antes de que la vuelta resuelva daría `null` por el motivo equivocado
      // (todavía no había pasado nada) y este `it` quedaría verde sin poder fallar.
      expect(screen.queryByRole("button", { name: CTA_INICIO }), "la persona quedó en la pantalla de entrada con el aviso encima").toBeNull();
      expect(espia.asignado, "además navegó sola").toEqual([]);
    } finally {
      espia.restaurar();
    }
  });

  // 🔴 LA SEGUNDA MITAD, Y NO ES SIMETRÍA: cierra una CARRERA medida. El productor de la vuelta espera
  // hasta `TECHO_DISPONIBILIDAD_MS` (3 s) antes de resolver nada, y en esa ventana la pantalla de
  // entrada ofrecía su CTA, que marca `yaInteractuoRef` (`./flow.tsx:175`). Un toque ahí manda la
  // reanudación al aviso del pisón (`T-065-8`) en vez de al salto: la persona vuelve de firmar y se
  // queda sin poder dar la firma que venía a dar.
  //
  // 🔴 MUTANTE QUE MATA: en `flow.tsx:1195`, sacar `!vueltaSinResolver` de la condición del
  // `<Bienvenida>`.
  //
  // ⚠️ LO QUE ESTE `it` NO AFIRMA: que la ventana quede intocable. La barra de destinos SIGUE pintada
  // ahí (`esDestino("bienvenida")`), y por ese camino el pisón se sigue disparando — es exactamente lo
  // que mide `T-065-8` desde este mismo fix. Lo que se saca es el CTA más grande de la pantalla, no
  // toda la superficie táctil.
  it("T-075-ATERRIZAJE-2: mientras la vuelta no resuelve, ⛔ la pantalla de entrada no se ofrece", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("firmar-tx");
    let soltar: () => void = () => {};
    const puerta = new Promise<void>((res) => {
      soltar = res;
    });
    /** La ÚNICA variable del `it`: la vuelta queda colgada, que es la ventana real de hasta 3 s. */
    class RecorridoColgado extends RecorridoPorEnlaceNulo {
      override remesaEnCurso(): string {
        return REM;
      }
      override async completar(): Promise<never> {
        await puerta;
        return { estado: "nada" } as never;
      }
    }
    const IR_A = "https://phantom.app/ul/v1/signTransaction?payload=abc&nonce=def";
    const c = buildTestContainer({
      repo,
      wallet: new FakeWallet(),
      connectedWallet: new SolanaWalletAdapter(),
      recorridoPorEnlace: new RecorridoColgado(),
      useCases: {
        confirmAndSend: { execute: async () => ({ estado: "hay-que-salir", irA: IR_A, esperando: "firma-patrocinio" }) } as unknown as Container["confirmAndSend"],
      },
    });

    const espia = espiarNavegacion();
    try {
      render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

      // 1 · Se dice lo que está pasando, y ⛔ no se afirma que la vuelta haya salido bien.
      expect(await screen.findByText(/Volviendo de tu billetera/)).toBeInTheDocument();
      // 2 · Y el CTA que envenena la reanudación no está.
      expect(screen.queryByRole("button", { name: CTA_INICIO }), "el CTA de la pantalla de entrada quedó tocable en la ventana de la vuelta").toBeNull();

      // 3 · Y al resolverse, la persona pasa de «volviendo» al pedido de firma SIN ver la pantalla de
      // entrada en el medio, que es la queja entera del founder. ⛔ La supresión NO es permanente y eso
      // lo miden dos controles que NO dependen de este fixture: `T-075-ATERRIZAJE(control)` (sin marca
      // en la barra, la entrada está desde el primer render) y `T-075-REANUDAR-1(control)` (con marca,
      // en cuanto la vuelta resuelve sin conexión la entrada aparece).
      await act(async () => {
        soltar();
        await Promise.resolve();
      });
      expect(await screen.findByRole("link", { name: CTA_FIRMA })).toHaveAttribute("href", IR_A);
      expect(screen.queryByRole("button", { name: CTA_INICIO })).toBeNull();
    } finally {
      espia.restaurar();
    }
  });

  // 🔴 EL PAR NEGATIVO DE LOS DOS DE ARRIBA, y es lo que los hace falsables. MISMO montaje, MISMA
  // remesa, MISMA bandera: la única variable que se mueve es que la barra NO trae marca nuestra. Sin
  // esto, un arreglo que apagara la pantalla de entrada SIEMPRE pasaría los dos y rompería la app
  // entera para todo el mundo (AC-1 de la HU 068).
  it("T-075-ATERRIZAJE(control): sin marca en la barra, la pantalla de entrada se ofrece como siempre", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    // ⛔ NADA de `sembrarVuelta`: la barra queda en `/enviar` sin `dl`, que es el caso de los ~100 `it`
    // que montan esta pantalla sin tener nada que ver con el enlace.
    const c = buildTestContainer({ repo, wallet: new FakeWallet(), connectedWallet: new SolanaWalletAdapter(), recorridoPorEnlace: new RecorridoPorEnlaceNulo() });

    render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

    expect(await screen.findByRole("button", { name: CTA_INICIO })).toBeInTheDocument();
    expect(screen.queryByText(/Volviendo de tu billetera/)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-373 · LA SALIDA DE EMERGENCIA NO SE ESCONDE JUSTO CUANDO EL CAMINO POR ENLACE NO CIERRA
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 EL HECHO, MEDIDO Y NO SUPUESTO. El founder reporta que en el navegador interno de Phantom el
// mismo recorrido SÍ cierra: o sea que hay un camino que funciona, y la pantalla lo ofrece con
// «Abrir Chaski en Phantom» ((`urlDeSalidaAlNavegadorDeLaBilletera`, `./flow.tsx:757`)). Ese ofrecimiento
// estaba gateado, entre otras cosas, por `saltoPendiente === null` y `estadoNonce === null`, que son
// exactamente los dos estados en los que el camino por enlace NO está cerrando:
//   · `saltoPendiente !== null` es «la vuelta resolvió que hace falta OTRO salto», que bajo la causa
//     raíz de esta HU ocurría en CADA vuelta (el bucle de «me sigue pidiendo muchas firmas»);
//   · `estadoNonce !== null` es la tarjeta de la cuenta de nonce, que se enciende justamente cuando el
//     depósito cortó por `deeplink_nonce_ausente`.
// ⇒ La puerta al camino que funciona se cerraba en los dos momentos en que hacía falta.
//
// ⚠️ ACÁ HAY UNA PRECISIÓN QUE HAY QUE HACER PARA NO AFIRMAR DE MÁS. El diagnóstico decía que el
// culpable era `vueltaSinResolver`, «que sólo se apaga cuando la vuelta resuelve BIEN». **Es falso, y
// está medido**: se apaga en `.finally(alResolverseLaVuelta)` ((`alResolverseLaVuelta`, `./flow.tsx:4092`)),
// que corre en los SEIS desenlaces y en los dos `catch`. La bandera no es la que esconde nada, y por
// eso ⛔ NO se tocó: mientras la vuelta se está resolviendo la pantalla muestra un spinner, y ofrecer
// una salida ahí sería ruido. Los que sí escondían son los otros dos, y son los que cambian.
describe("WKH-373: la salida al navegador de la billetera", () => {
  it("T-373-5: con un salto pendiente (la vuelta pidió OTRA firma), la salida SIGUE ofrecida", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("firmar-tx");
    const c = contenedor(repo);
    // El desenlace del bucle: `execute()` contesta que hace falta OTRO salto, en cada vuelta.
    vi.spyOn(c.confirmAndSend, "execute").mockResolvedValue({
      estado: "hay-que-salir",
      irA: "https://phantom.app/ul/v1/signTransaction?x=1",
      esperando: "firma-tx",
    });

    render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

    // CD-18 — el fixture reproduce el estado del founder: la pantalla ofrece el salto otra vez.
    await screen.findByText(/Falta una firma para seguir/);
    expect(
      screen.queryByRole("link", { name: /Abrir Chaski en Phantom/ }),
      "con un salto pendiente la pantalla escondió la salida al camino que SÍ cierra",
    ).not.toBeNull();
  });

  // 🔴 EL CONTROL, Y CAMBIA UNA SOLA VARIABLE: el DESENLACE de `execute()`. Con un corte —el que el
  // founder leyó, `deeplink_tx_alterada`— no hay salto pendiente, la persona se queda en la misma
  // pantalla y la salida SÍ estaba ofrecida, también antes de esta HU. Los dos `it` juntos son los que
  // fijan «igual, o más»: sin este control, el de arriba no distingue «el gate dejó de depender de
  // `saltoPendiente`» de «la salida se muestra siempre, pase lo que pase».
  it("T-373-5b: con el CORTE que leyó el founder la salida también está (el control)", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("firmar-tx");
    const c = contenedor(repo);
    vi.spyOn(c.confirmAndSend, "execute").mockRejectedValue(new Error("deeplink_tx_alterada"));

    render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

    await screen.findByText(/no es lo que te mandamos a firmar/);
    expect(screen.queryByText(/Falta una firma para seguir/), "el control no controla: hay salto pendiente").toBeNull();
    expect(
      screen.queryByRole("link", { name: /Abrir Chaski en Phantom/ }),
      "con el corte en pantalla la salida al camino que SÍ cierra no está",
    ).not.toBeNull();
  });

  // Y el tercer estado en que el camino por enlace no cierra: la tarjeta de la cuenta de nonce, que se
  // enciende con `deeplink_nonce_ausente` ((`alSaberDelNonce`, `./flow.tsx:4090`)). Mismo argumento: es
  // justo cuando hace falta la otra puerta.
  it("T-373-5c: con la tarjeta de la cuenta de nonce encendida, la salida SIGUE ofrecida", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("firmar-tx");
    const c = contenedor(repo);
    vi.spyOn(c.confirmAndSend, "execute").mockRejectedValue(new Error("deeplink_nonce_ausente"));

    render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);

    await screen.findByText(/Crear la cuenta/);
    expect(
      screen.queryByRole("link", { name: /Abrir Chaski en Phantom/ }),
      "con la tarjeta del nonce encendida la pantalla escondió la salida al camino que SÍ cierra",
    ).not.toBeNull();
  });
});
