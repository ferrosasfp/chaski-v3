// @vitest-environment jsdom
// WKH-075 / fix · EL AVISO "no vemos ninguna wallet" NO SE LE MUESTRA A QUIEN YA ESTÁ CONECTADO.
//
// 🔴 EL SÍNTOMA, TEXTUAL DEL FOUNDER, EN PRODUCCIÓN: *"si sale la dirección arriba, pero rápidamente te
// manda al browser de Phantom, como para bajar la DApp al mobile, si la tengo instalada"*. O sea: la
// conexión por enlace FUNCIONÓ —el chip de la dirección está pintado— y acto seguido la pantalla le
// ofrece irse a otro navegador COMO ACCIÓN PRINCIPAL, porque con `esElUnicoCamino` el enlace «Abrir
// Chaski en Phantom» se estila como botón primario de 52 px y ancho completo.
//
// 🔴 LA CAUSA, Y POR QUÉ NINGÚN TEST LA VEÍA. El único guard del aviso era `availability !== "none"`, y
// `availability` es el bridge de la wallet INYECTADA: en un navegador de celular dice `"none"` y dice
// bien, porque no hay extensión. El aviso es MÁS VIEJO que los enlaces profundos, de cuando "no hay
// billetera inyectada" significaba "acá no podés usar la app". Con
// `NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED=true` esa premisa es falsa y nadie actualizó la condición.
// ⇒ El aviso se mostraba EXACTAMENTE en el estado en el que el camino por enlace es el que funciona.
//
// ⚠️ POR QUÉ ESTOS DOS `it` VAN EN UN ARCHIVO APARTE Y NO EN `wallet-availability.test.tsx`: allá el
// arnés llega al paso `connect` por el formulario y la disponibilidad se setea A MANO después de
// montar; acá hace falta sembrar la BARRA y el `localStorage` con una vuelta de la billetera ANTES de
// montar, que es estado compartido entre `it` y la forma más barata de fabricar un flake en un archivo
// que no lo necesita. Es el mismo motivo por el que existe `flow-reanudacion.test.tsx`.
//
// ⛔ LO QUE ESTE ARCHIVO **NO** MIDE, declarado antes de que alguien se apoye en su verde:
//   1. Corre en **jsdom**. El runner de tests no es el runtime real y ⛔ NO SUSTITUYE A UN TELÉFONO:
//      lo que el founder reportó se comprueba en un celular, no acá.
//   2. No mide el ESTILO del enlace (que sea el botón primario de 52 px). Eso lo mide `T-H1-3` en
//      `wallet-availability.test.tsx`. Acá lo que se mide es si el aviso ESTÁ o NO ESTÁ.
//   3. ⛔ NO se observa `registerOpenModal` con un espía. CD-17: el árbol real registra su propio
//      handle en un efecto y PISA el doble del test, así que un cero ahí no significa "no pasó", significa
//      "no medí". Acá el observable es el DOM.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"; // HU-075/reanudar: `act` EN ESTA MISMA LINEA, para mover la disponibilidad a mano dentro del transitorio
import bs58 from "bs58";
import { RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { FAKE_WALLET_ADDRESS, FakeWallet, InMemoryRepo, RecorridoPorEnlaceNulo, T0, beneficiary } from "../test-support/fakes";
import { type KycVerification, Remittance, toPersistedIdentity } from "../domain/remittance";
import { Money } from "../domain/money";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { almacenDeNavegador, guardarViaje } from "../infrastructure/solana/deeplink/sesion";
import { guardarEleccion } from "../infrastructure/solana/deeplink/conexion";

// Mismo doble cerrado que el resto de los archivos que montan el flujo: jsdom no implementa
// `requestAnimationFrame`, así que sin esto el exit de `AnimatePresence` no completa y los pasos nunca
// montan. El síntoma sería la suite entera del archivo caída, no un `it` suelto.
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

const REM = "rem-1";
/** El chip de la dirección, tal cual lo pinta el header: `address.slice(0, 6)` + `…` + `address.slice(-4)`. */
const CHIP = new RegExp(`${FAKE_WALLET_ADDRESS.slice(0, 6)}…${FAKE_WALLET_ADDRESS.slice(-4)}`);
const AVISO = /No vemos ninguna wallet en este navegador/;
const CAMINO = /Abrir Chaski en Phantom/;

const KYC_APROBADO: KycVerification = {
  verificationId: "v-1", approved: true, payoutAllowed: true, realVerified: true, verifiedAt: null,
  riskLevel: "low", provenance: "didit",
  identity: toPersistedIdentity({
    firstName: "Test", lastNamePaternal: "Quispe", lastNameMaternal: "Mamani",
    documentType: "DNI", documentNumber: "12345678", dateOfBirth: "1990-01-01", nationality: "PE",
  }),
};

async function sembrarRemesaConfirmada(repo: InMemoryRepo) {
  const r = Remittance.create(REM, beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote({
    quoteId: "q", send: Money.of(400, "USDC"), receive: Money.of(1478.15, "PEN"),
    feeUsd: Money.of(0.5, "USDC"), rate: 3.7, etaMinutes: 30,
    expiresAt: "2099-01-01T00:00:00.000Z", provenance: "fake",
  }, T0);
  r.startKyc(T0, FAKE_WALLET_ADDRESS);
  r.applyKyc(KYC_APROBADO, T0);
  r.confirm(T0);
  await repo.save(r);
}

/**
 * EL MUNDO COMPARTIDO POR LOS DOS `it`, y lo que los hace comparables: en LOS DOS la disponibilidad es
 * `"none"` y la bandera del enlace está PRENDIDA. Ése es el cuadrante del celular sin extensión, que es
 * donde el aviso se pintaba. ⛔ Lo que este arnés NO siembra es la dirección: eso lo aporta —o no— el
 * recorrido de cada `it`, y ES la única variable que se mueve entre los dos.
 */
function sembrarCelularSinExtension() {
  solanaWalletBridge.setWalletAvailability("none");
  vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
}

/**
 * HU-075/reanudar — EL MISMO CUADRANTE, PERO **ANTES** DE QUE LA DISPONIBILIDAD SE DECIDA.
 *
 * 🔴 POR QUE HACE FALTA UNA SEGUNDA SIEMBRA Y NO ALCANZABA CON LA DE ARRIBA, y es la lección entera de
 * este fix: `sembrarCelularSinExtension()` deja la disponibilidad en `"none"` **desde antes de montar**,
 * o sea que en esos dos `it` el TRANSITORIO no existe — la espera de `esperarDisponibilidadDecidible()`
 * resuelve sin un solo tick y la conexión llega prácticamente junto con el primer render. Por eso el
 * arreglo anterior (gatear el aviso por `direccionConectada !== null`) daba verde ahí y ⛔ seguía
 * fallando en el teléfono del founder.
 *
 * MEDIDO EN SU TELÉFONO con el bloque `?diag=1` (2026-08-30): `disponibilidad decidida a los 1852 ms`
 * (techo 3000), y la dirección llega DESPUÉS de eso. Entre los dos instantes `availability` ya vale
 * `"none"` y `address` todavía vale `null`: ésa es la ventana en la que el aviso se pintaba.
 *
 * ⇒ Acá la disponibilidad arranca SIN DECIDIR y el `it` la mueve a mano, que es la única forma de
 * tener esa ventana adentro de un test.
 */
function sembrarCelularConLaDisponibilidadSinDecidir() {
  solanaWalletBridge.setWalletAvailability("unknown");
  vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
}

/** La vuelta de la billetera en la barra y en el disco: el `dl=conectar` que dispara `alConectar`. */
function sembrarVueltaDelConectar() {
  const almacen = almacenDeNavegador(window.localStorage);
  guardarEleccion(almacen, "phantom");
  guardarViaje(almacen, {
    billetera: "phantom", secreta: bs58.encode(new Uint8Array(32)), publica: bs58.encode(new Uint8Array(32)),
    claveBilletera: bs58.encode(new Uint8Array(32)), session: "s", direccion: FAKE_WALLET_ADDRESS,
    paso: "firmar-tx", remittanceId: REM, pasosConsumidos: ["conectar"], desde: Date.now(),
  });
  const u = new URL("https://chaski.test/enviar");
  u.searchParams.set("dl", "conectar");
  window.history.replaceState(null, "", `${u.pathname}${u.search}`);
}

/** ⛔ Hereda de `RecorridoPorEnlaceNulo`, que TIRA en todo lo demás: un camino no previsto se VE. */
class RecorridoQueVuelveConectado extends RecorridoPorEnlaceNulo {
  override remesaEnCurso(): string {
    return REM;
  }
  override async completar(): Promise<never> {
    return { estado: "conectado", direccion: FAKE_WALLET_ADDRESS } as never;
  }
  override async estadoDeLaCuentaDeNonce(): Promise<never> {
    return "no-pudimos-preguntar" as never;
  }
}

function contenedor(repo: InMemoryRepo, recorrido: RecorridoPorEnlaceNulo) {
  return buildTestContainer({
    repo,
    wallet: new FakeWallet(),
    connectedWallet: new SolanaWalletAdapter(), // el adaptador REAL: lo que se prueba es el cableado
    recorridoPorEnlace: recorrido,
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/enviar");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  solanaWalletBridge.reset();
});

describe("WKH-075/fix · el aviso de 'no hay wallet' y la persona que YA conectó", () => {
  // 🔴 EL CASO DEL FOUNDER. La conexión por enlace aterriza, el chip de la dirección aparece, y el
  // aviso NO tiene que estar: ofrecer "Abrir Chaski en Phantom" como acción principal a alguien que
  // acaba de entrar es expulsarlo de la app que ya está usando.
  //
  // ⚠️ EL `expect` DE LA DISPONIBILIDAD NO ES DECORATIVO, y sin él este `it` sería un FALSO KILLED
  // esperando a pasar: si el arnés dejara la disponibilidad en `"injected"` o en `"unknown"`, el guard
  // VIEJO (`availability !== "none"`) escondería el aviso solo y el `it` daría verde con y sin el
  // arreglo. Pinchar `"none"` acá es lo que obliga a que el único motivo posible de la ausencia sea la
  // condición NUEVA. Es exactamente el falso KILLED que esta HU ya se comió dos veces.
  it("T-075-AVISO-1: con la dirección ya conectada por ENLACE, el aviso NO se pinta (y la disponibilidad sigue siendo 'none')", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo);
    sembrarCelularSinExtension();
    sembrarVueltaDelConectar();
    const c = contenedor(repo, new RecorridoQueVuelveConectado());

    render(<RemittanceFlow pasoInicial="connect" container={c} />);

    // La precondición del founder: "sale la dirección arriba". Sin esto, un `it` que nunca conectara
    // dejaría los `toBeNull()` de abajo vacuos — pasarían por no haber llegado, no por el arreglo.
    await waitFor(() => expect(screen.getByText(CHIP), "la vuelta por enlace no aplicó ninguna dirección: este `it` no está midiendo nada").toBeInTheDocument());

    // ⬅️ LA OTRA MITAD DEL CUADRANTE, PINCHADA: no hay extensión, y eso es CORRECTO.
    expect(
      solanaWalletBridge.getWalletAvailability(),
      "el arnés se desvió del cuadrante: con otra disponibilidad el guard VIEJO ya escondía el aviso y este `it` sería un falso KILLED",
    ).toBe("none");

    expect(screen.queryByText(AVISO)).toBeNull();
    expect(screen.queryByRole("link", { name: CAMINO })).toBeNull();
  });

  // 🔴 EL PAR NEGATIVO, Y ES LO QUE HACE FALSABLE AL DE ARRIBA. Mismo cuadrante exacto —disponibilidad
  // `"none"`, bandera prendida, mismo paso— y la ÚNICA diferencia es que acá no volvió ninguna
  // conexión, así que no hay dirección. Ahí el aviso es correcto y útil, y ⛔ TIENE que seguir estando:
  // un arreglo que lo borrara siempre pasaría el `it` de arriba y rompería éste.
  it("T-075-AVISO-1(control): sin ninguna dirección conectada, el MISMO cuadrante SÍ pinta el aviso y su camino", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo);
    sembrarCelularSinExtension();
    const c = contenedor(repo, new RecorridoPorEnlaceNulo());

    render(<RemittanceFlow pasoInicial="connect" container={c} />);

    await waitFor(() => expect(screen.getByText(AVISO)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: CAMINO })).toBeInTheDocument();
    // Y la precondición que lo distingue del `it` de arriba: acá NO hay chip, o sea NO hay dirección.
    expect(screen.queryByText(CHIP)).toBeNull();
    expect(solanaWalletBridge.getWalletAvailability()).toBe("none");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// HU-075/reanudar — EL AVISO NO SE PINTA **DURANTE** LA VENTANA DE ESPERA
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ QUEDÓ ABIERTO DESPUÉS DEL ARREGLO DE `T-075-AVISO-1`, y por qué su verde no lo veía. Ese `it`
// gatea el aviso por `direccionConectada !== null`, y eso cubre el estado **final**. El founder reportó
// el defecto otra vez, y midiéndolo en su teléfono con `?diag=1` apareció el estado **transitorio**:
//
//     marca al montar : conectar        disco · viaje  : sí        viaje.direccion : HSV3FF…KU1m
//     disponibilidad  : decidida a los 1852 ms (techo 3000)        corte : sin corte
//
// O sea que la conexión SÍ se completa y el viaje SÍ queda en disco: lo que falla es lo que pasa
// mientras vuelve. `address` arranca en `null` en cada remonte y la disponibilidad ya vale `"none"` a
// los 1852 ms, así que entre esos dos instantes las dos condiciones del guard viejo dejaban pasar el
// aviso — y con `esElUnicoCamino` ese aviso trae como acción principal un enlace que saca a la persona
// a OTRO navegador, justo después de que firmó. **El arreglo anterior era correcto y llegaba tarde.**
//
// 🔑 EL PREDICADO NUEVO ⛔ NO ES UNA TERCERA FUENTE DE «HAY BILLETERA» —ésas siguen siendo dos, el
// estado `address` y el bridge de la inyectada—: dice que TODAVÍA NO SE SABE. Mientras no se sabe, no
// se afirma.
//
// ⛔ LO QUE ESTOS `it` NO MIDEN: corren en jsdom y mueven la disponibilidad a mano. NO sustituyen al
// teléfono; lo que reproducen es la SECUENCIA (unknown → none → conexión), que es lo que el guard mira.
describe("HU-075/reanudar · el aviso y la VENTANA en la que todavía no se sabe", () => {
  /** La vuelta del connect, DETENIDA: `completar()` no contesta hasta que el `it` la suelte. Es lo que
   *  mantiene abierta la ventana entre «la disponibilidad ya dijo `none`» y «llegó la dirección». */
  class RecorridoQueVuelveConectadoDespacio extends RecorridoPorEnlaceNulo {
    constructor(private readonly puerta: Promise<void>) {
      super();
    }
    override remesaEnCurso(): string {
      return REM;
    }
    override async completar(): Promise<never> {
      await this.puerta;
      return { estado: "conectado", direccion: FAKE_WALLET_ADDRESS } as never;
    }
    override async estadoDeLaCuentaDeNonce(): Promise<never> {
      return "no-pudimos-preguntar" as never;
    }
  }

  // 🔴 MUTANTE QUE MATA (medido, ver el reporte): en `flow.tsx`, borrar `|| vueltaSinResolver` del
  // guard de `NoWalletHere`. Es el código de antes de este fix y deja este `it` en rojo por su motivo
  // propio: el `queryByText(AVISO)` del transitorio encuentra el aviso.
  it("T-075-AVISO-2: con la disponibilidad ya en `none` y la conexión TODAVÍA en vuelo, el aviso ⛔ no se pinta", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo);
    sembrarCelularConLaDisponibilidadSinDecidir();
    sembrarVueltaDelConectar();
    let soltar: () => void = () => {};
    const puerta = new Promise<void>((res) => {
      soltar = res;
    });
    const c = contenedor(repo, new RecorridoQueVuelveConectadoDespacio(puerta));

    render(<RemittanceFlow pasoInicial="connect" container={c} />);

    // ── LA VENTANA, FABRICADA A MANO ────────────────────────────────────────────────────────────
    // La disponibilidad se decide (1852 ms en el teléfono del founder; acá, a mano) y la conexión
    // todavía no volvió.
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
      await Promise.resolve();
    });

    // ⚠️ LAS DOS PRECONDICIONES, PINCHADAS, PORQUE SIN ELLAS ESTE `it` ES UN FALSO KILLED ESPERANDO:
    // con la disponibilidad en `"unknown"` el guard VIEJO ya escondía el aviso solo, y con la dirección
    // ya aplicada lo escondía la condición del fix ANTERIOR. Sólo con `"none"` y SIN chip el único
    // motivo posible de la ausencia es la condición nueva.
    expect(
      solanaWalletBridge.getWalletAvailability(),
      "el arnés se desvió del cuadrante: sin `none` el guard viejo ya escondía el aviso y esto sería un falso KILLED",
    ).toBe("none");
    expect(
      screen.queryByText(CHIP),
      "la conexión ya se había aplicado: esto ya no es el transitorio, es el estado final que `T-075-AVISO-1` mide",
    ).toBeNull();

    expect(screen.queryByText(AVISO)).toBeNull();
    expect(screen.queryByRole("link", { name: CAMINO })).toBeNull();

    // ── Y AL CERRARSE LA VENTANA SIGUE SIN PINTARSE, ahora por la condición del fix anterior ────
    await act(async () => {
      soltar();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText(CHIP)).toBeInTheDocument());
    expect(screen.queryByText(AVISO)).toBeNull();
  });

  // 🔴 EL PAR NEGATIVO, Y ES LO QUE HACE FALSABLE AL DE ARRIBA. La MISMA secuencia exacta —la misma
  // siembra, la misma disponibilidad moviéndose de `unknown` a `none`, el mismo recorrido detenido— y
  // la ÚNICA variable que se mueve es que la barra NO trae ninguna marca nuestra, o sea que no hay
  // ninguna vuelta en curso. Ahí el aviso es correcto y ⛔ TIENE que estar: un arreglo que lo apagara
  // siempre pasaría el `it` de arriba y rompería éste.
  it("T-075-AVISO-2(control): sin ninguna vuelta en la barra, la MISMA secuencia SÍ pinta el aviso", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo);
    sembrarCelularConLaDisponibilidadSinDecidir();
    let soltar: () => void = () => {};
    const puerta = new Promise<void>((res) => {
      soltar = res;
    });
    const c = contenedor(repo, new RecorridoQueVuelveConectadoDespacio(puerta));

    // CD-18 — el fixture fabricó el caso: la barra NO trae marca, que es la única diferencia.
    expect(new URL(window.location.href).searchParams.get("dl")).toBeNull();

    render(<RemittanceFlow pasoInicial="connect" container={c} />);

    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
      await Promise.resolve();
    });

    expect(solanaWalletBridge.getWalletAvailability()).toBe("none");
    expect(screen.queryByText(CHIP)).toBeNull();
    await waitFor(() => expect(screen.getByText(AVISO)).toBeInTheDocument());
    expect(screen.getByRole("link", { name: CAMINO })).toBeInTheDocument();
    soltar();
  });

  // 🔴 EL TERCER CASO, Y ES EL QUE IMPIDE QUE «no se sabe» SE VUELVA «no se sabe NUNCA MÁS». Si la
  // vuelta CORTA, no hay conexión y no la va a haber: el aviso vuelve a ser cierto y tiene que
  // reaparecer. Lo que lo garantiza es que el `.finally` del productor corre en TODOS los desenlaces,
  // no sólo en el feliz — un apagado escrito rama por rama se olvida de una y deja el aviso mudo para
  // el resto de la pestaña.
  //
  // 🔴 MUTANTE QUE MATA: en `flow.tsx`, cambiar `})().finally(alResolverseLaVuelta)` por `})()`.
  it("T-075-AVISO-3: si la vuelta CORTA, el aviso vuelve a aparecer (el apagado no es para siempre)", async () => {
    const repo = new InMemoryRepo();
    await sembrarRemesaConfirmada(repo);
    sembrarCelularConLaDisponibilidadSinDecidir();
    sembrarVueltaDelConectar();
    class RecorridoQueCorta extends RecorridoPorEnlaceNulo {
      override remesaEnCurso(): string {
        return REM;
      }
      override async completar(): Promise<never> {
        return { estado: "corte", causa: "deeplink_respuesta_invalida" } as never;
      }
    }
    const c = contenedor(repo, new RecorridoQueCorta());

    render(<RemittanceFlow pasoInicial="connect" container={c} />);

    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
      await Promise.resolve();
    });

    expect(screen.queryByText(CHIP), "hubo corte: no puede haber dirección aplicada").toBeNull();
    await waitFor(() => expect(screen.getByText(AVISO)).toBeInTheDocument());
  });
});
