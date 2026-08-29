// @vitest-environment jsdom
// WKH-075 · LA CARRERA DE LA VUELTA POR ENLACE, CONTRA EL ÁRBOL REAL Y LA LIBRERÍA REAL.
//
// 🔴 QUÉ MIDE ESTE ARCHIVO, Y POR QUÉ NO PODÍA SER UN `it` MÁS EN `flow-reanudacion.test.tsx`. Allá el
// arnés (`sembrarVuelta`, `flow-reanudacion.test.tsx:95`) escribe SIEMPRE
// `solanaWalletBridge.setWalletAvailability("none")`, o sea que siembra el mundo DESPUÉS de que la
// carrera terminó. Eso está bien para lo que ese archivo mide, y es exactamente lo que hace que el
// defecto de esta HU sea invisible ahí. Acá la disponibilidad se deja en `"unknown"` —que es como
// arranca un navegador de verdad— y se deja correr el RELOJ REAL.
//
// 🔴 CD-17 · EL OBSERVABLE ES EL DOM, ⛔ NUNCA `registerOpenModal(spy)`. La primera sonda del F2
// observaba `solanaWalletBridge.registerOpenModal(spy)` y midió `openModal.llamadas = 0`, o sea "no
// hay bug". ERA FALSO: el árbol real registra su propio handle en un efecto
// (`solana-providers.tsx:95`, `registerOpenModal(() => setVisible(true))`) y PISA el doble del test.
// Un doble que el árbol real sobreescribe mide silencio y lo reporta como ausencia del defecto.
// ⇒ Se mide `.wallet-adapter-modal` en el DOM, que es el OTRO extremo del cable y no lo puede pisar
// nadie. La clase se verificó contra la versión INSTALADA (`@solana/wallet-adapter-react-ui` 0.9.39,
// `node_modules/@solana/wallet-adapter-react-ui/lib/cjs/WalletModal.js`), no de memoria.
//
// ⚠️ LOS TRES LÍMITES DE ESTE INSTRUMENTO, escritos ANTES de que alguien se apoye en su verde:
//   1. Corre en **jsdom**, no en un navegador. El runner de tests no es el runtime real.
//   2. Se mockea **el barrel** de wallets (arrastra Ledger y no resuelve bajo vitest). Los adapters de
//      Phantom y Solflare son los REALES, y la detección que se ejercita es la de la librería.
//   3. ⛔ NO SUSTITUYE A UN TELÉFONO.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import bs58 from "bs58";
import { RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { InMemoryRepo, RecorridoPorEnlaceNulo, T0, beneficiary } from "../test-support/fakes";
import { type KycVerification, Remittance, toPersistedIdentity } from "../domain/remittance";
import { Money } from "../domain/money";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { almacenDeNavegador, guardarViaje } from "../infrastructure/solana/deeplink/sesion";
import { guardarEleccion } from "../infrastructure/solana/deeplink/conexion";

// E2 · OBLIGATORIO en cualquier test que monte `SolanaProviders` bajo vitest: el barrel arrastra el
// adapter de Ledger, que no resuelve. Lo único que se saltea es el RE-EXPORT.
vi.mock("@solana/wallet-adapter-wallets", async () => {
  const p = await import("@solana/wallet-adapter-phantom");
  const s = await import("@solana/wallet-adapter-solflare");
  return { PhantomWalletAdapter: p.PhantomWalletAdapter, SolflareWalletAdapter: s.SolflareWalletAdapter };
});

// jsdom no implementa `requestAnimationFrame`: sin este doble los pasos del flujo nunca montan.
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

const DIRECCION = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const REM = "rem-1";
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
  r.startKyc(T0, DIRECCION);
  r.applyKyc(KYC_APROBADO, T0);
  r.confirm(T0);
  await repo.save(r);
}

/** 🔴 IDÉNTICO A `sembrarVuelta` (`flow-reanudacion.test.tsx:95`) SALVO EN UNA LÍNEA QUE NO ESTÁ: acá
 *  ⛔ NO se llama a `setWalletAvailability("none")`. Ésa es toda la diferencia, y es la carrera. */
function sembrarVueltaConLaDisponibilidadSinDecidir(marca: string) {
  const almacen = almacenDeNavegador(window.localStorage);
  guardarEleccion(almacen, "phantom");
  vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
  guardarViaje(almacen, {
    billetera: "phantom", secreta: bs58.encode(new Uint8Array(32)), publica: bs58.encode(new Uint8Array(32)),
    claveBilletera: bs58.encode(new Uint8Array(32)), session: "s", direccion: DIRECCION,
    paso: "firmar-tx", remittanceId: REM, pasosConsumidos: ["conectar"], desde: Date.now(),
  });
  const u = new URL("https://chaski.test/enviar");
  u.searchParams.set("dl", marca);
  window.history.replaceState(null, "", `${u.pathname}${u.search}`);
}

/**
 * 🔴 LA ÚNICA COSTURA DOBLADA, Y POR QUÉ HAY QUE DOBLAR ÉSTA. Para llegar a la puerta hay que VOLVER de
 * la billetera con una respuesta válida, y eso es cripto real: `completarPop` verifica ed25519 sobre
 * los bytes anclados y `completar` descifra la carga de Phantom con el secreto compartido. Fabricar
 * eso a mano acá mediría el motor de la vuelta —que ya tiene sus propios tests— y no la carrera.
 *
 * ⛔ LO QUE **NO** SE DOBLA, y es todo lo que esta HU toca: el bridge, el adaptador
 * (`SolanaWalletAdapter` REAL), el árbol de providers, los adapters de Phantom/Solflare, y el RELOJ.
 * Es la costura que el propio módulo declara tener para esto, y es la misma que dobla `T-067-11`
 * (`flow-reanudacion.test.tsx:527`).
 *
 * ⛔ Y HEREDA DE `RecorridoPorEnlaceNulo`, que TIRA en todo lo demás (E4, `../test-support/fakes.ts:1051`):
 * un camino no previsto se VE, en vez de devolver un valor de mentira.
 */
class RecorridoDeVueltaValida extends RecorridoPorEnlaceNulo {
  constructor(private readonly proposito: "pop-kyc" | "pop-payout") {
    super();
  }
  override remesaEnCurso(): string | null {
    return REM;
  }
  /** La puerta 2: la vuelta del paso `conectar` que SÍ trajo dirección. */
  override async completar(): Promise<never> {
    return { estado: "conectado", direccion: DIRECCION } as never;
  }
  /** La puerta 1: el permiso conseguido. */
  override async completarPop(): Promise<never> {
    return { estado: "pop-listo", proposito: this.proposito } as never;
  }
}

function contenedor(repo: InMemoryRepo, recorrido: RecorridoPorEnlaceNulo) {
  return buildTestContainer({
    repo,
    // 🔴 EL ADAPTADOR REAL COMO `WalletPort`, Y ACÁ ESTÁ LA MITAD QUE NINGÚN TEST DEL REPO TENÍA. El
    // `connect()` que cae al selector es el de `ConnectWallet`, y ese caso de uso recibe `o.wallet`
    // (`../test-support/test-container.ts:100`), NO `o.connectedWallet`. Con el default `FakeWallet` el
    // recorrido nunca toca el bridge: el fixture da verde con y sin el arreglo, o sea que no mide nada.
    // MEDIDO: con `FakeWallet`, borrar la espera de `flow.tsx:4005` deja los tres `it` en VERDE.
    wallet: new SolanaWalletAdapter(),
    connectedWallet: new SolanaWalletAdapter(),
    recorridoPorEnlace: recorrido,
  });
}

/** El observable de CD-17. ⛔ No se dobla nada para leerlo. */
function selectorDeLaLibreriaEnElDOM(): boolean {
  return document.querySelector(".wallet-adapter-modal") !== null;
}

/** Monta el árbol REAL —providers de la librería + la pantalla real— y le da RELOJ REAL de sobra para
 *  pasar la gracia de la disponibilidad (`WALLET_GRACE_MS = 1500`). Los 1700 ms salen de `T-CABLE-1`
 *  (`wallet-availability.test.tsx:128`) CON SU MOTIVO: con 1200 el valor correcto todavía es
 *  `"unknown"`, así que un `expect` a los 1200 ms mediría otra cosa. */
async function montarLaVueltaYDejarCorrerElReloj(marca: "pop-kyc" | "conectar", esperaMs = 1700) {
  const repo = new InMemoryRepo();
  await sembrarRemesaConfirmada(repo);
  sembrarVueltaConLaDisponibilidadSinDecidir(marca);
  const { default: SolanaProviders } = await import("./solana/solana-providers");
  // 🔴 PRECONDICIÓN: el DOM arranca SIN selector. Sin esto, un selector que quedó de un `it` anterior
  // haría fallar el `it` de abajo acusando a un defecto que no está.
  expect(selectorDeLaLibreriaEnElDOM(), "el DOM ya traía un selector ANTES de montar: se filtró de otro `it`").toBe(false);
  await act(async () => {
    render(
      <SolanaProviders>
        <RemittanceFlow pasoInicial="send" container={contenedor(repo, new RecorridoDeVueltaValida("pop-kyc"))} />
      </SolanaProviders>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, esperaMs));
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/enviar");
  window.localStorage.clear();
  solanaWalletBridge.reset(); // deja la disponibilidad en "unknown", que es la precondición de la carrera
});

// 🔴 EL ORDEN DE ESTE TEARDOWN NO ES COSMÉTICO, Y MEDIRLO COSTÓ UN FLAKE DE ~2 DE CADA 10.
// El bridge es un SINGLETON que vive toda la corrida, y el trabajo asíncrono de un `it` NO se detiene
// cuando el `it` termina: la cadena `resolverVueltaDelPermiso → ConnectWallet.execute → connect()`
// sigue en vuelo. MEDIDO con un registro de transiciones: el `openModal()` intruso venía de
// `SolanaWalletAdapter.connect` (`../infrastructure/solana-wallet.ts:191`) y aterrizaba FUERA de la
// ventana de su propio `it`. Cada puerta corrida SOLA daba 12/12 verde; las tres juntas, ~2 de 10 rojo.
//
// ⇒ El desorden que lo causaba era mío: si al rezagado se le borra el `localStorage` y se le
// desestabiliza la env ANTES de que aterrice, `direccionDelViajeConectado()` contesta `null` —el viaje
// ya no está— y `connect()` se va al camino INYECTADO, que es el que abre el selector. O sea: el mundo
// que el rezagado necesita para NO abrir nada tiene que seguir en pie hasta que aterrice.
//
//   1. `cleanup()` PRIMERO: desmonta. Lo que aterrice después no tiene árbol vivo donde pintar.
//   2. DRENAR con el mundo INTACTO (disco + env): el rezagado toma el camino por enlace y no abre nada.
//   3. RECIÉN AHÍ se borra el mundo y se resetea el singleton.
// ⛔ Borrar el disco antes de drenar es exactamente lo que fabricaba el falso rojo.
afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  solanaWalletBridge.reset();
});

describe("T-075-1 · AC-1/AC-6 · la vuelta por enlace NO cae al selector de la librería", () => {
  it("PUERTA 1 · `dl=pop-kyc` con la disponibilidad todavía sin decidir ⇒ el selector NO aparece", async () => {
    await montarLaVueltaYDejarCorrerElReloj("pop-kyc");
    // 🔴 LA PRECONDICIÓN VA PRIMERO Y SE AFIRMA EN DURO (`"none"`, no «distinto de unknown»). Si la
    // disponibilidad terminara en `"injected"`, el selector se abriría **correctamente** —ése es el
    // camino inyectado, que esta HU tiene PROHIBIDO tocar— y el `toBe(false)` de abajo fallaría
    // acusando a un defecto que no está. Así el rojo dice cuál de las dos cosas pasó.
    expect(
      solanaWalletBridge.getWalletAvailability(),
      "la disponibilidad no terminó en `none`: este `it` no está midiendo la carrera del defecto",
    ).toBe("none");
    expect(
      selectorDeLaLibreriaEnElDOM(),
      "el selector de la librería está en el DOM tras una vuelta válida: la persona va a leer «Se cerró el selector de wallet sin conectar», una acción que no hizo",
    ).toBe(false);
  });

  it("PUERTA 2 · `dl=conectar` con la disponibilidad todavía sin decidir ⇒ el selector tampoco aparece", async () => {
    // 🔴 LA CARRERA ENTRA POR LAS DOS PUERTAS Y ESTÁ MEDIDO. Arreglar sólo la del PoP deja el síntoma
    // entrando por ésta, y este `it` es lo que lo delata.
    await montarLaVueltaYDejarCorrerElReloj("conectar");
    expect(solanaWalletBridge.getWalletAvailability(), "la disponibilidad no terminó en `none`").toBe("none");
    expect(selectorDeLaLibreriaEnElDOM(), "la otra puerta sigue abriendo el selector").toBe(false);
  });

  // 🔴 EL CONTROL POSITIVO VA ÚLTIMO, Y EL ORDEN ES PARTE DEL INSTRUMENTO (medido, no estético). Sin él, `querySelector(".wallet-adapter-modal")
  // === null` no dice "el selector no apareció": dice "estoy preguntando por una clase que quizá no
  // existe en esta versión". Un cero uniforme acusa al instrumento.
  //
  // ⚠️ Y VA AL FINAL PORQUE ENVENENA AL `it` QUE LE SIGUE. MEDIDO con el arnés de estrés: las dos
  // puertas corridas SOLAS dan 12/12 verde; con este `it` DELANTE, ~2 de cada 14 rojo. Este `it` es el
  // único que deja el selector ABIERTO y un handle de `openModal` vivo sobre un singleton que dura toda
  // la corrida, así que lo que quede en vuelo cuando el `it` siguiente ya montó su árbol le pinta un
  // selector que ese `it` no pidió. ⛔ No lo muevas arriba "por legibilidad": el orden es el arreglo.
  it("CONTROL POSITIVO · el MISMO observable SÍ ve el selector cuando el selector está", async () => {
    const { default: SolanaProviders } = await import("./solana/solana-providers");
    let arbol!: ReturnType<typeof render>;
    await act(async () => {
      arbol = render(
        <SolanaProviders>
          <div />
        </SolanaProviders>,
      );
    });
    expect(selectorDeLaLibreriaEnElDOM(), "precondición: sin abrirlo no está").toBe(false);
    await act(async () => {
      solanaWalletBridge.openModal(); // el mismo camino que `connect()` toma cuando el gate lo manda al camino inyectado
    });
    expect(
      selectorDeLaLibreriaEnElDOM(),
      "el observable no ve el selector ni cuando está abierto: la clase cambió de nombre y todos los `toBe(false)` de este archivo son vacuos",
    ).toBe(true);
    // ⚠️ ESTE `it` DEJA EL SELECTOR ABIERTO, así que se desmonta ACÁ y no en el `afterEach`: el bridge
    // es un SINGLETON que vive toda la corrida, y un handle de `openModal` que sobrevive a su árbol es
    // exactamente cómo un `it` le mete un selector en el DOM al `it` siguiente. Y de paso queda medido
    // que desmontar SE LO LLEVA.
    await act(async () => {
      arbol.unmount();
    });
    expect(selectorDeLaLibreriaEnElDOM(), "desmontar el árbol no se llevó el selector").toBe(false);
  });
});
