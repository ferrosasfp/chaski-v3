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
import { FakeWallet, InMemoryRepo, RecorridoPorEnlaceNulo, T0, beneficiary } from "../test-support/fakes";
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
    expect(spy.mock.calls[0]?.[0]).toEqual({ remittanceId: REM });
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

    // La persona entra al formulario: eso es lo que marca `yaInteractuoRef`.
    fireEvent.click(await screen.findByRole("button", { name: /Empezar un envío/ }));
    expect(await screen.findByPlaceholderText("Nombre de tu familiar")).toBeInTheDocument();

    await act(async () => {
      soltar();
      await Promise.resolve();
    });

    // (i) avisa; (ii) NO llamó al use-case; (iii) sigue en el formulario que la persona estaba usando.
    expect(await screen.findByText(/Volviste de tu billetera/)).toBeInTheDocument();
    expect(spy, "la reanudación corrió por debajo mientras la persona usaba la pantalla").toHaveBeenCalledTimes(0);
    expect(screen.getByPlaceholderText("Nombre de tu familiar")).toBeInTheDocument();
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

    // La persona entra al formulario: eso es lo que marca `yaInteractuoRef`.
    fireEvent.click(await screen.findByRole("button", { name: /Empezar un envío/ }));
    expect(await screen.findByPlaceholderText("Nombre de tu familiar")).toBeInTheDocument();

    await act(async () => {
      soltar();
      await Promise.resolve();
    });

    expect(
      conectar,
      "el productor conectó la billetera por debajo mientras la persona usaba la pantalla",
    ).toHaveBeenCalledTimes(0);
    expect(screen.getByPlaceholderText("Nombre de tu familiar")).toBeInTheDocument();
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
    expect(spy.mock.calls[0]?.[0]).toEqual({ remittanceId: REM });
    expect(recorrido.llamadas, "la vuelta del permiso no se leyó, o se leyó de más").toBe(1);

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
  // entera: 162 archivos / 3305 tests en verde. Y con él M14 (emitir otra causa) y M10-bis (borrar
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
  // verde: ningún `it` distinguía las dos formas.
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
