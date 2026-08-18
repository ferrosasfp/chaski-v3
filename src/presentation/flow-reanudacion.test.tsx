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
import { almacenDeNavegador, guardarViaje } from "../infrastructure/solana/deeplink/sesion";
import { guardarEleccion } from "../infrastructure/solana/deeplink/conexion";

// Mismo doble cerrado que `flow.test.tsx`: jsdom no implementa `requestAnimationFrame`, así que sin
// esto el exit de `AnimatePresence` no completa y los pasos nunca montan. Lo que no esté acá NO EXISTE
// para este archivo, y el síntoma es la suite entera del archivo caída, no un `it` suelto.
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
          React.createElement(tag, props, children),
    },
  ),
}));

const KYC_APROBADO: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
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
// vive en este archivo es **la rama de `flow.tsx:4070`**: que la marca del permiso llegue a
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
    constructor(private readonly desenlace: { estado: "pop-listo"; proposito: "pop-payout" | "pop-kyc" } | { estado: "nada" } | { estado: "corte"; causa: string }) {
      super();
    }
    override remesaEnCurso(): string {
      return REM;
    }
    override async completar(): Promise<never> {
      // La vuelta del MOTOR contesta `nada`: la marca del permiso NO es un `PasoDelViaje`, así que
      // el motor no la mira y no consume ni destruye el viaje del depósito (CD-11, `T-067-16`).
      return { estado: "nada" } as never;
    }
    override async completarPop(): Promise<never> {
      this.llamadas += 1;
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

  // 🔴 MUTANTE QUE MATA: en `flow.tsx:4070`, quitar la rama de `pop-payout` (la marca cae al filtro
  // `marca !== "firmar-tx" && marca !== "firmar-patrocinio"` y el productor vuelve sin reanudar), o
  // decidir por `viaje.paso` —que en este fixture dice `firmar-tx`— en vez de por el desenlace.
  it("T-067-11: con el permiso conseguido, reanuda y el bridge recibe CERO pedidos de firma", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo, "confirmed");
    sembrarVuelta("pop-payout");
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
  // MUTANTE QUE MATA: en `flow.tsx:4070`, quitar el `if (vp.estado !== "pop-listo") return;`.
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
});
