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
import { FakeWallet, InMemoryRepo, T0, beneficiary } from "../test-support/fakes";
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
async function sembrarRemesaConfirmada(repo: InMemoryRepo, estado: "confirmed" | "kyc_passed") {
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
  r.startKyc(T0, DIRECCION); // 🔴 esto es lo que escribe `ownerAddress`, la fuente que el enlace NO toca
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
    eleccionDeEnlace: new RecorridoPorEnlaceReal(),
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/enviar");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
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
  // `reactStrictMode` el efecto corre dos veces y este `it` ve 2 llamadas. (MEDIDO en la batería §9.)
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

  // MUTANTE QUE MATA: en `flow.tsx`, sacar la condición sobre la marca (`marca !== "firmar-tx" && …`)
  // ⇒ una vuelta del CONNECT reanudaría el envío.
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
// `c.confirmAndSend.execute(...)` (o borrarlo). (MEDIDO en la batería §9.)
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
  // `Not implemented: navigation`. (MEDIDO en la batería §9.)
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
    render(<RemittanceFlow pasoInicial="send" container={contenedor(repo)} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(new URL(window.location.href).searchParams.get("errorCode")).toBeNull();
    expect(new URL(window.location.href).searchParams.get("kyc")).toBe("return");
  });
});
