// @vitest-environment jsdom
// HU-075/nonce · EL ÚLTIMO ESLABÓN DEL PAGO POR ENLACE: EL CORTE QUE ENCIENDE SU PROPIA REPARACIÓN.
//
// 🔴 EL DEFECTO QUE ESTE ARCHIVO EXISTE PARA CAZAR, medido el 2026-08-31 en el teléfono del founder
// con el bloque `?diag=1` abierto:
//
//     marca al montar : pop-payout
//     viaje.paso      : conectar · edad 1m28s
//     viaje.remesa    : f3ce04…1a96 · repo: confirmed
//     pop             : –
//     pantalla        : bienvenida
//     corte           : deeplink_nonce_ausente
//
// O sea que el corte por cuenta de nonce ausente SÍ se alcanza (los arreglos de HU-075 hicieron que
// `prepare()` pase), y lo único que la persona recibía era el COPY: un texto que le pide que cree la
// cuenta, en una pantalla que no le daba ningún botón para crearla. La tarjeta existía y estaba
// montada, pero su interruptor no lo tocaba nadie en ese camino. Callejón.
//
// ⚠️ LO QUE ESTOS `it` **NO** MIDEN, dicho antes de que alguien se apoye en su verde:
//   1. Corren en **jsdom**, con el recorrido por enlace DOBLADO. ⛔ NO dicen nada sobre si el depósito
//      por enlace cierra de punta a punta en un teléfono: eso NO LO CORRIÓ NADIE todavía. Lo que se
//      mide acá es el cableado de la pantalla ante un corte que ya sabemos alcanzable.
//   2. No miden la lectura REAL de la cadena ni el sobre cifrado de la creación: eso vive en
//      `../infrastructure/solana/preparacion-por-enlace.test.ts`.
//   3. El salto final a la billetera se dobla con una URL de fragmento (ver el doble): jsdom no
//      implementa navegación de verdad y lo que estos `it` afirman es a quién se le pidió el salto y
//      con qué remesa, no que el navegador se haya ido.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import bs58 from "bs58";
import { COPY_NONCE_SIN_BILLETERA_CONECTADA, COPY_NONCE_SIN_ENVIO_EN_CURSO, RemittanceFlow } from "./flow";
import { humanError } from "./flow-vm";
import { buildTestContainer } from "../test-support/test-container";
import { FakeWallet, InMemoryRepo, RecorridoPorEnlaceNulo, T0, TEST_CCI, beneficiary } from "../test-support/fakes";
import { clickCuandoHabilite } from "../test-support/clicks";
import { type KycVerification, Remittance, toPersistedIdentity } from "../domain/remittance";
import { Money } from "../domain/money";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { almacenDeNavegador, guardarViaje } from "../infrastructure/solana/deeplink/sesion";
import { guardarEleccion } from "../infrastructure/solana/deeplink/conexion";
import {
  DEEPLINK_NONCE_AUSENTE,
  DEEPLINK_SALDO_INSUFICIENTE,
} from "../infrastructure/solana/deeplink/firma-por-enlace";

// El MISMO doble cerrado de `flow.test.tsx` y `flow-reanudacion.test.tsx`: jsdom no implementa
// `requestAnimationFrame`, así que sin esto el exit de `AnimatePresence` no completa y los pasos nunca
// montan. El síntoma sería el archivo entero caído, no un `it` suelto.
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
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
  payoutAllowed: true,
  realVerified: true,
  verifiedAt: null,
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

/** Una remesa que YA pasó por `confirm`: el único estado desde el que la reanudación por enlace
 *  re-invoca `confirmAndSend.execute()`, que es donde vive el corte que este archivo mide. */
async function sembrarRemesaConfirmada(repo: InMemoryRepo) {
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
  r.startKyc(T0, DIRECCION); // escribe `ownerAddress`, que es lo que `repo.list(dueño)` filtra
  r.applyKyc(KYC_APROBADO, T0);
  r.confirm(T0);
  await repo.save(r);
  return r;
}

/** Deja el navegador en el estado EXACTO de una vuelta de la billetera: viaje en el disco, elección
 *  persistida, `availability === "none"` y la BARRA con la marca del paso. Copiado de
 *  `flow-reanudacion.test.tsx` a propósito: son fixtures de estado global de navegador y compartirlos
 *  entre archivos ata dos suites por el `localStorage`. */
function sembrarVuelta(paso: string) {
  const almacen = almacenDeNavegador(window.localStorage);
  guardarEleccion(almacen, "phantom");
  solanaWalletBridge.setWalletAvailability("none");
  vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
  guardarViaje(almacen, {
    billetera: "phantom",
    secreta: bs58.encode(new Uint8Array(32)),
    publica: bs58.encode(new Uint8Array(32)),
    claveBilletera: bs58.encode(new Uint8Array(32)),
    session: "s",
    direccion: DIRECCION,
    paso: "conectar",
    remittanceId: REM,
    pasosConsumidos: ["conectar"],
    desde: Date.now(),
  });
  const u = new URL("https://chaski.test/enviar");
  u.searchParams.set("dl", paso);
  window.history.replaceState(null, "", `${u.pathname}${u.search}`);
}

/**
 * El recorrido que reproduce la vuelta del founder: el permiso del payout YA conseguido, así que el
 * productor de montaje cae al bloque de reanudación y llama a `confirmAndSend.execute()`.
 *
 * ⛔ Hereda de `RecorridoPorEnlaceNulo`, que TIRA en todo lo demás: un camino no previsto se VE.
 */
class RecorridoConElPermisoConseguido extends RecorridoPorEnlaceNulo {
  /** Lo que el disco contesta HOY. Es mutable a propósito: el viaje dura 20 minutos y puede vencerse
   *  MIENTRAS la persona lee el corte, que es el caso que mide el `it` del botón sin envío. */
  public viajeEnDisco: string | null = REM;
  public creaciones: Array<{ direccion: string; remittanceId: string }> = [];
  override remesaEnCurso(): string | null {
    return this.viajeEnDisco;
  }
  override async completar(): Promise<never> {
    // La marca del permiso NO es un `PasoDelViaje`: el motor contesta `nada` y no consume el viaje.
    return { estado: "nada" } as never;
  }
  override async completarPop(): Promise<never> {
    return { estado: "pop-listo", proposito: "pop-payout" } as never;
  }
  /** ⛔ El `irA` es un FRAGMENTO y no la URL real de Phantom: jsdom no implementa navegación y una URL
   *  externa ensucia la corrida con `Not implemented: navigation`. Lo que estos `it` afirman es a quién
   *  se le pidió el salto y con qué remesa, y eso se lee de `creaciones`. */
  override async crearCuentaDeNonce(i: { direccion: string; remittanceId: string }): Promise<never> {
    this.creaciones.push(i);
    return { irA: "#salto-a-la-billetera" } as never;
  }
}

function contenedor(repo: InMemoryRepo, recorrido: RecorridoPorEnlaceNulo) {
  return buildTestContainer({
    repo,
    wallet: new FakeWallet(),
    connectedWallet: new SolanaWalletAdapter(), // 🔴 EL ADAPTADOR REAL: lo que se prueba es el cableado
    recorridoPorEnlace: recorrido,
  });
}

/** Monta la pantalla con la vuelta del `pop-payout` sembrada y el `execute()` del depósito cortando
 *  por `causa`. Devuelve el doble y el spy para que cada `it` mida lo suyo. */
async function montarConElCorte(causa: string) {
  const repo = new InMemoryRepo();
  await sembrarRemesaConfirmada(repo);
  sembrarVuelta("pop-payout");
  const recorrido = new RecorridoConElPermisoConseguido();
  const c = contenedor(repo, recorrido);
  const execute = vi.spyOn(c.confirmAndSend, "execute").mockRejectedValue(new Error(causa));
  render(<RemittanceFlow pasoInicial="bienvenida" container={c} />);
  return { recorrido, execute };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/enviar");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/enviar");
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ESLABÓN 2 — el corte enciende la tarjeta que lo repara
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-075N-1 · el corte por cuenta de nonce ausente deja de ser un callejón", () => {
  // 🔴 MUTANTE QUE MATA: en `flow.tsx`, borrar el `if (causa === DEEPLINK_NONCE_AUSENTE)
  // alSaberDelNonce("falta");` del `catch` de la reanudación por enlace ⇒ el copy sigue apareciendo
  // (o sea que NO muere por un guard vecino) y lo que desaparece es el botón «Crear la cuenta», que es
  // exactamente la propiedad nueva.
  it("T-075N-1: además del copy, la persona recibe la tarjeta con «Crear la cuenta»", async () => {
    const { execute } = await montarConElCorte(DEEPLINK_NONCE_AUSENTE);

    // CD-18 — el fixture fabricó el caso: el corte ocurrió de verdad, no se pintó una tarjeta suelta.
    await waitFor(() => expect(execute, "la reanudación ni llegó a pedir el depósito").toHaveBeenCalledTimes(1));

    // 1 · EL COPY SIGUE ENTERO. ⛔ La persona tiene que seguir leyendo que no se firmó nada, así que
    //     esta mitad NO es decorativa: un arreglo que reemplazara el texto por la tarjeta la rompe.
    expect(await screen.findByText(humanError(DEEPLINK_NONCE_AUSENTE))).toBeInTheDocument();

    // 2 · Y AHORA ADEMÁS TIENE CON QUÉ. Esta es la propiedad nueva.
    expect(
      await screen.findByRole("button", { name: "Crear la cuenta" }),
      "el copy le pide crear la cuenta y la pantalla no le da ningún botón para hacerlo",
    ).toBeInTheDocument();
  });

  // 🔴 EL PAR NEGATIVO, Y ES LO QUE HACE FALSABLE AL DE ARRIBA. La ÚNICA variable que se mueve es la
  // causa del corte. MUTANTE QUE MATA: cambiar la condición por `if (true)` (o borrarla) ⇒ la tarjeta
  // aparece también acá y este `it` se pone rojo por su nombre.
  it("T-075N-1(control): con OTRA causa de corte, la tarjeta NO aparece", async () => {
    const { execute } = await montarConElCorte(DEEPLINK_SALDO_INSUFICIENTE);

    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(humanError(DEEPLINK_SALDO_INSUFICIENTE))).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.queryByRole("button", { name: "Crear la cuenta" }),
      "un corte que NO habla de la cuenta de nonce ofrece igual pagar un alquiler que no arregla nada",
    ).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// ESLABÓN 3 — el botón deja de ser mudo cuando el remonte por enlace se llevó el estado de React
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("T-075N-2 · «Crear la cuenta» con `rem` en null, que es SIEMPRE el caso por enlace", () => {
  // 🔴 MUTANTE QUE MATA: en `flow.tsx`, volver `onCrearCuentaDeNonce` a su primera línea vieja
  // (`if (rem === null) return;`) ⇒ el click no llama a nada y `creaciones` queda vacío. Es el código
  // exacto de antes de este arreglo.
  it("T-075N-2: el `remittanceId` sale del disco y el salto se pide con ESA remesa", async () => {
    const { recorrido } = await montarConElCorte(DEEPLINK_NONCE_AUSENTE);
    fireEvent.click(await screen.findByRole("button", { name: "Crear la cuenta" }));

    await waitFor(() =>
      expect(
        recorrido.creaciones,
        "el botón no pidió nada: tras la vuelta por enlace `rem` está en null y ése es el único caso que importa",
      ).toEqual([{ direccion: DIRECCION, remittanceId: REM }]),
    );
  });

  // 🔴 LA OTRA MITAD, Y ES LA QUE IMPIDE QUE EL ARREGLO CAMBIE UN SILENCIO POR OTRO. El viaje dura 20
  // minutos y puede vencerse mientras la persona lee el corte, así que "tampoco está en disco" es
  // alcanzable de verdad. MUTANTE QUE MATA: borrar el `setError({ message: COPY_NONCE_SIN_ENVIO_EN_CURSO })`
  // y dejar el `return` pelado ⇒ el click no escribe nada en pantalla y este `it` se pone rojo.
  it("T-075N-2(sin viaje): si el disco tampoco lo tiene, el botón DICE algo y no pide ningún salto", async () => {
    const { recorrido } = await montarConElCorte(DEEPLINK_NONCE_AUSENTE);
    const boton = await screen.findByRole("button", { name: "Crear la cuenta" });

    // La única variable que se mueve contra el `it` de arriba: el viaje se venció mientras leía.
    recorrido.viajeEnDisco = null;
    fireEvent.click(boton);

    expect(await screen.findByText(COPY_NONCE_SIN_ENVIO_EN_CURSO)).toBeInTheDocument();
    expect(recorrido.creaciones, "se pidió un salto sin saber de qué remesa").toEqual([]);
    // ⛔ Y el texto NO dice que algo falló ni que se movió plata, porque ninguna de las dos pasó.
    expect(/falló|error|se debitó|se cobró/i.test(COPY_NONCE_SIN_ENVIO_EN_CURSO)).toBe(false);
    // ⛔ CD-16: sin em dashes en el copy que ve la persona.
    expect(COPY_NONCE_SIN_ENVIO_EN_CURSO).not.toContain("—");
    expect(COPY_NONCE_SIN_BILLETERA_CONECTADA).not.toContain("—");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// LA PREGUNTA, ADELANTADA A UN MOMENTO ALCANZABLE POR ENLACE
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 POR QUÉ HACÍA FALTA MOVERLA. El único sitio de producción que preguntaba por la cuenta vivía en la
// rama `conectado` del productor de montaje, DESPUÉS de un `return` que se dispara cuando el connect
// contesta `hay-que-salir`. Por enlace ese estado es SIEMPRE `hay-que-salir` (hay que ir a la billetera
// a firmar el PoP), así que la pregunta no corría NUNCA en el único recorrido que necesita la cuenta.
// ⛔ Ese `return` no se toca: existe para no gastar una lectura de red que nadie va a leer porque el
// navegador se está yendo. La pregunta se mueve a la vuelta del `pop-kyc`, donde la persona SE QUEDA.
describe("T-075N-3 · la vuelta del `pop-kyc` pregunta por la cuenta antes de gastar una orden de payout", () => {
  /** El borrador EXACTO que deja `onSend`: la remesa existe y todavía NO tiene `ownerAddress`. */
  async function sembrarBorrador(repo: InMemoryRepo) {
    await repo.save(Remittance.create(REM, beneficiary(), Money.of(400, "USDC"), T0));
  }

  class RecorridoConPopDeKyc extends RecorridoPorEnlaceNulo {
    public preguntas: string[] = [];
    override remesaEnCurso(): string {
      return REM;
    }
    override async completarPop(): Promise<never> {
      return { estado: "pop-listo", proposito: "pop-kyc" } as never;
    }
    override async estadoDeLaCuentaDeNonce(direccion: string): Promise<never> {
      this.preguntas.push(direccion);
      return "falta" as never;
    }
  }

  // 🔴 MUTANTE QUE MATA: en `flow.tsx`, borrar el `if (vuelta !== undefined) void
  // mirarLaCuentaDeNonce(addr)...` del final de `onConnect` ⇒ `preguntas` queda vacío y la tarjeta no
  // aparece, que es el estado de antes de este arreglo.
  it("T-075N-3: al aterrizar en `review` por enlace, la cuenta ya se preguntó y la oferta está a la vista", async () => {
    const repo = new InMemoryRepo();
    await sembrarBorrador(repo);
    sembrarVuelta("pop-kyc");
    const recorrido = new RecorridoConPopDeKyc();
    render(<RemittanceFlow pasoInicial="bienvenida" container={contenedor(repo, recorrido)} />);

    // 1 · el recorrido aterrizó donde el founder lo vio aterrizar (`continuacion: vuelta: navegó a review`).
    expect(await screen.findByText("Revisá el envío")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(TEST_CCI))).toBeInTheDocument();

    // 2 · y la cadena YA fue consultada, con la dirección del viaje.
    await waitFor(() => expect(recorrido.preguntas).toEqual([DIRECCION]));

    // 3 · lo que la persona ve: la oferta, ANTES de haber gastado ninguna orden de payout.
    expect(await screen.findByRole("button", { name: "Crear la cuenta" })).toBeInTheDocument();
  });

  // 🔴 EL PAR NEGATIVO DEL GATE, y sin él el `it` de arriba no dice nada sobre el camino de siempre:
  // un arreglo que preguntara en TODOS los `onConnect` le agregaría una lectura de cadena a cada
  // persona que conecta desde el navegador de siempre, donde la cuenta de nonce no hace falta.
  // MUTANTE QUE MATA: quitar el `vuelta !== undefined` del gate ⇒ `preguntas` deja de estar vacío.
  it("T-075N-3(control): el botón «Conectar wallet» del camino de siempre NO le pregunta nada a la cadena", async () => {
    const repo = new InMemoryRepo();
    const recorrido = new RecorridoConPopDeKyc(); // MISMO doble; lo que NO hay es vuelta en la barra
    render(<RemittanceFlow pasoInicial="send" container={contenedor(repo, recorrido)} />);

    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), { target: { value: "Mamá" } });
    fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    await clickCuandoHabilite(/Conectar wallet/);

    expect(await screen.findByText("Revisá el envío")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      recorrido.preguntas,
      "conectar desde el navegador de siempre gastó una lectura de cadena que ese camino no necesita",
    ).toEqual([]);
    expect(screen.queryByRole("button", { name: "Crear la cuenta" })).toBeNull();
  });
});
