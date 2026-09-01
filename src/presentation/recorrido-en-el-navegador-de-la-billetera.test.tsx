// @vitest-environment jsdom
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-372 · W1.0 — LA PREMISA DE LA OLA, FALSABLE, SOBRE EL ÁRBOL DE HOY
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 QUÉ MIDE ESTE ARCHIVO, Y POR QUÉ SE ESCRIBIÓ ANTES DE UNA SOLA LÍNEA DE PRODUCCIÓN.
//
// W1 ofrece saltar al navegador de la billetera. Todo el diseño de la ola se apoya en una premisa que
// nadie había corrido entera: que ADENTRO de ese navegador —donde la billetera está INYECTADA— el
// recorrido ya hace hoy lo que la ola promete, sin escribir nada. Si esa premisa fuera falsa, la ola
// no sería «agregar una puerta»: sería construir el recorrido detrás de la puerta. Por eso estos `it`
// van primero y con cero producción: son la puerta de entrada de la ola, no un test más.
//
// Los cinco puntos de la premisa, cada uno con su `it`:
//   1. `caminoPorEnlace()` es `null` ⇒ `pedir()` contesta `no-corresponde`   → T-372-W1-3
//   2. `authorizePrincipal` no construye ninguna ix de cuenta de nonce       → T-372-W1-4
//   3. el umbral que aplica es el INYECTADO, medido POR VALOR                → T-372-W1-5
//   4. `prepare()` se invoca EXACTAMENTE una vez en un envío que cierra      → T-372-W1-12
//   5. no se asigna `window.location.href` a ningún host de billetera        → T-372-W1-3 / T-372-W1-13
// Más el candado del camino de respaldo, que esta ola NO puede romper        → T-372-W1-11
// y el conteo de travesías de la pantalla de entrada                         → T-372-W1-13
//
// ⛔ LA DISPONIBILIDAD SE LEE DEL ÁRBOL, NUNCA SE SETEA A MANO. Es el patrón `T-CABLE-2`
// (`./wallet-availability.test.tsx:146`): se monta el árbol de providers REAL, con los adapters
// REALES de la librería, y se LEE lo que el bridge terminó diciendo. Un `setWalletAvailability(...)`
// escrito a mano probaría que este archivo sabe escribir un string, no que el navegador de la
// billetera produce ese estado. Cada `it` empieza afirmando lo que el árbol contestó (CD-18): sin esa
// primera línea, un `it` que nunca llegó al cuadrante «injected» daría verde por vacío.
//
// ⚠️ LO QUE ESTE ARCHIVO **NO** PRUEBA, dicho antes de que alguien lea su verde de más: NINGUNO DE
// ESTOS `it` CORRE EN UN TELÉFONO. Corren sobre el árbol, con la librería real y `jsdom`. Que el
// `localStorage` cruce o no cruce el salto al navegador de la billetera NO lo contesta este archivo:
// lo contesta el aviso de aterrizaje en un teléfono real, y hasta entonces sigue sin verificar.
import React from "react";
import { existsSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Connection, Keypair, SystemProgram, type Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { RemittanceFlow } from "./flow";
import { phantomBrowseUrl } from "./wallet-availability";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import type { FirmaPorEnlace } from "../infrastructure/solana/deeplink/firma-por-enlace";
import { CLAVE_ELECCION } from "../infrastructure/solana/deeplink/conexion";
import type { PruebaDePosesionPorEnlace, PruebaPorEnlace } from "../application/ports";
import { ConfirmAndSend } from "../application/use-cases/confirm-and-send";
import {
  SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT,
  SENDER_MIN_LAMPORTS_FOR_DEPOSIT,
} from "../application/solana-escrow-rent";
import { Money } from "../domain/money";
import { type KycVerification, type Quote, Remittance } from "../domain/remittance";
import {
  FAKE_SOLANA_BENEFICIARY,
  FakeKycGateway,
  FakeKycStore,
  FakePruebaDePosesionPorEnlace,
  FakeRefundGateway,
  FakeSolanaEscrowDepositProbe,
  FakeSolanaPayoutPrepareGateway,
  FakeSolanaSenderSolBalanceProbe,
  FakeSolanaSettlementGateway,
  FakeSolanaWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  TEST_CCI,
  T0,
  beneficiary,
} from "../test-support/fakes";
import { esperarListo } from "../test-support/desenlaces";
import { buildTestContainer } from "../test-support/test-container";

// El barrel `@solana/wallet-adapter-wallets` arrastra el adapter de Ledger, que no resuelve bajo
// vitest. Mismo reemplazo, y por el mismo motivo, que `./wallet-availability.test.tsx:32`: lo único
// que se saltea es el re-export; la detección que se está midiendo sigue siendo la de la librería.
vi.mock("@solana/wallet-adapter-wallets", async () => {
  const p = await import("@solana/wallet-adapter-phantom");
  const s = await import("@solana/wallet-adapter-solflare");
  return {
    PhantomWalletAdapter: p.PhantomWalletAdapter,
    SolflareWalletAdapter: s.SolflareWalletAdapter,
  };
});

// framer-motion pass-through, mismo doble que el resto de la suite de pantalla: jsdom no implementa
// `requestAnimationFrame` y sin esto los pasos del flujo nunca montan.
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

const UA_ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

function setUserAgent(value: string): void {
  Object.defineProperty(window.navigator, "userAgent", { value, configurable: true });
}

/** Inyecta la wallet en el scope global, exactamente como lo hace el navegador interno de Phantom en
 *  el celular. Los dos nombres son los que sondea el adapter de la librería. Copiado de
 *  (`inyectarWallet`, `./wallet-availability.test.tsx:72`), que es donde el par `T-CABLE-1`/`T-CABLE-2`
 *  lo dejó medido. */
function inyectarWallet(): void {
  const solana = {
    isPhantom: true,
    isConnected: false,
    publicKey: { toBytes: () => new Uint8Array(32).fill(1) },
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
  };
  const w = window as unknown as Record<string, unknown>;
  w.isPhantomInstalled = true;
  w.phantom = { solana };
  w.solana = solana;
}

function quitarWalletInyectada(): void {
  const w = window as unknown as Record<string, unknown>;
  w.isPhantomInstalled = undefined;
  w.phantom = undefined;
  w.solana = undefined;
}

/**
 * 🔴 EL ARNÉS DE LA OLA: monta el árbol REAL y devuelve lo que el bridge terminó diciendo.
 *
 * ⛔ NO SETEA NADA. La disponibilidad la produce la librería sondeando el scope global, igual que en
 * un teléfono adentro de Phantom. Con `inyectar = false` el mismo arné produce el otro cuadrante
 * (`"none"`), con el MISMO user agent de celular: es el par que impide «arreglar» cualquiera de estos
 * `it` mirando el user agent.
 *
 * La espera de 1700 ms para el caso sin wallet no es un timeout de infra: el árbol no afirma `"none"`
 * en el primer efecto, espera la gracia de `WALLET_GRACE_MS`. Está medido en `T-CABLE-1`.
 */
async function entrarAlNavegadorDeLaBilletera(inyectar = true, esperaMs = 1200): Promise<string> {
  setUserAgent(UA_ANDROID_CHROME);
  if (inyectar) inyectarWallet();
  const { default: SolanaProviders } = await import("./solana/solana-providers");
  await act(async () => {
    render(
      <SolanaProviders>
        <div />
      </SolanaProviders>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, esperaMs));
  });
  return solanaWalletBridge.getWalletAvailability();
}

/** El host de la billetera, DERIVADO del productor de producción y ⛔ nunca escrito a mano acá: si
 *  alguien cambia el universal link, este valor lo sigue solo. Es el mismo antídoto que `T-H1-3` usa
 *  para el alto del CTA (`./wallet-availability.test.tsx:975`): se LEE, no se re-escribe. */
const HOST_DE_LA_BILLETERA = new URL(phantomBrowseUrl("https://chaski.test/", "https://chaski.test"))
  .hostname;

/** Reemplaza `window.location` por uno que ANOTA los `href = …` en vez de navegar. Misma receta que
 *  (`espiarNavegacion`, `./flow-reanudacion.test.tsx:1304`), que es la única forma de ver la
 *  navegación programática bajo jsdom. */
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
  return {
    asignado,
    restaurar: () => Object.defineProperty(window, "location", { configurable: true, value: original }),
  };
}

/** Los hosts de billetera que aparecieron en una tanda de navegaciones. Vacío = ningún viaje a la
 *  billetera, que es exactamente lo que AC-1-2a mide. ⚠️ Un href que no parsea se DESCARTA y NO se cuenta como viaje.
 *  Hoy no llega ninguno: medido cambiando el `catch` por un `throw` ⇒ los 6 `it` del archivo siguen verdes. Y ningún verde se apoya en esta función sola: los 3 llamadores miran además la lista CRUDA (`T-372-W1-3` su contenido; `T-372-W1-13` su largo y el hostname del único href). */
function viajesALaBilletera(asignado: string[]): string[] {
  return asignado.filter((h) => {
    try {
      return new URL(h).hostname === HOST_DE_LA_BILLETERA;
    } catch {
      return false;
    }
  });
}

// ── El mundo del camino por enlace, ARMADO ENTERO salvo la disponibilidad ─────────────────────────
//
// 🔴 POR QUÉ SE SIEMBRA LA ELECCIÓN Y SE PRENDE LA BANDERA EN LOS `it` DE LA PREMISA. `caminoPorEnlace`
// conjuga TRES condiciones: disponibilidad `"none"`, bandera del build, y elección persistida. Si un
// `it` dejara las otras dos apagadas, mediría «el camino por enlace no se enciende» y no «la
// disponibilidad inyectada lo apaga»: cualquiera de las tres explicaría el verde. Sembrando las otras
// dos, la ÚNICA variable que queda es la que el árbol produjo, y el mutante que invierte el gate de
// disponibilidad no tiene dónde esconderse.
function sembrarElCaminoPorEnlace(): void {
  vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
  // ⚠️ EL VALOR VA CRUDO, NO EN JSON, y esto NO es un detalle de estilo: lo escribe
  // (`guardarEleccion`, `../infrastructure/solana/deeplink/conexion.ts:170`) con `a.escribir(clave,
  // billetera)`, y (`leerEleccion`, `../infrastructure/solana/deeplink/conexion.ts:149`) valida contra el conjunto cerrado `"phantom" | "solflare"`.
  // Un `JSON.stringify({billetera:"phantom"})` sale `null` de esa validación ⇒ el gate contesta
  // «este recorrido no es por enlace» POR EL DISCO, y no por la disponibilidad. Está MEDIDO: con la
  // siembra en JSON, el mutante que invierte el gate de disponibilidad SOBREVIVÍA a los dos `it` que
  // dicen medirlo — 6 passed con el árbol sano y 6 passed con el gate invertido.
  window.localStorage.setItem(CLAVE_ELECCION, "phantom");
}

const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  realVerified: true,
  verifiedAt: null,
  riskLevel: "low",
  provenance: "didit",
  identity: null,
};

const quote: Quote = {
  quoteId: "q1",
  send: Money.of(400, "USDC"),
  receive: Money.of(1480, "PEN"),
  feeUsd: Money.of(0.5, "USDC"),
  rate: 3.7,
  etaMinutes: 30,
  expiresAt: QUOTE_EXPIRES,
  provenance: "fake",
};

/** Una remesa cotizada y con el KYC aplicado: el estado desde el que `ConfirmAndSend` corre entero.
 *  Copiado de (`seedQuoted`, `../application/use-cases/confirm-and-send.sol-balance.test.ts:54`). */
async function sembrarCotizada(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  await repo.save(r);
  return "r-1";
}

/** El `ConfirmAndSend` real, con todo en verde salvo lo que cada `it` varía. Mismo armado que el del
 *  archivo del guard de rent, con UNA diferencia deliberada: el puerto `pop` puede ser el ADAPTADOR
 *  REAL, que es lo que hace que el desenlace dependa de la disponibilidad que produjo el árbol. */
function armarEnvio(p: {
  repo: InMemoryRepo;
  wallet: FakeSolanaWallet;
  prepare: FakeSolanaPayoutPrepareGateway;
  gateway: FakeSolanaSettlementGateway;
  senderBalance: FakeSolanaSenderSolBalanceProbe;
  pop: PruebaDePosesionPorEnlace;
}): ConfirmAndSend {
  return new ConfirmAndSend(p.wallet, p.repo, new FixedClock(), new FakeRefundGateway("no-receipt"), {
    prepare: p.prepare,
    gateway: p.gateway,
    probe: new FakeSolanaEscrowDepositProbe(),
    senderBalance: p.senderBalance,
    pop: p.pop,
  });
}

/** El adaptador REAL como puerto `pop`, anotando qué contestó cada vez. ⛔ No sustituye la respuesta:
 *  la deja pasar tal cual. Sin esta anotación, «`pedir()` nunca dijo `hay-que-salir`» sería una
 *  inferencia a partir del estado terminal, y no una observación. */
class PopDelAdaptadorReal implements PruebaDePosesionPorEnlace {
  readonly respuestas: string[] = [];
  private readonly real = new SolanaWalletAdapter();
  async pedir(input: { proposito: "pop-payout" | "pop-kyc"; direccion: string }): Promise<PruebaPorEnlace> {
    try {
      const r = await this.real.pedir(input);
      this.respuestas.push(r.estado);
      return r;
    } catch (e) {
      // ⛔ ANOTA EL THROW Y LO DEJA SUBIR. Sin esta rama, un `pedir()` que TIRA mata al `it` con un
      // error sin nombre en vez de con la aserción que lo mide, y un rojo así no dice qué se rompió.
      this.respuestas.push(`TIRÓ: ${(e as Error).message}`);
      throw e;
    }
  }
}

beforeEach(() => {
  solanaWalletBridge.reset();
  quitarWalletInyectada();
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  solanaWalletBridge.reset();
  quitarWalletInyectada();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 1 · EL CAMINO POR ENLACE NO SE ENCIENDE ADENTRO DEL NAVEGADOR DE LA BILLETERA
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W1.0 · adentro del navegador de la billetera el recorrido es el inyectado", () => {
  // MUTANTE QUE LO TIENE QUE MATAR: en `../infrastructure/solana-wallet.ts:2240`, invertir
  // `getWalletAvailability() !== "none"` por `=== "none"` ⇒ con `"injected"` el gate se enciende,
  // `pedir()` va a buscar el desafío y contesta `hay-que-salir`.
  // ⛔ FALSO KILLED A EVITAR: si el fixture no llegara al final del recorrido, este `it` daría verde
  // por no haber ejercitado nada. Por eso se assertan las TRES cosas: el estado terminal de la remesa,
  // la lista COMPLETA de lo que contestó `pedir()`, y que el emisor del desafío no se tocó.
  it("T-372-W1-3: `pedir()` contesta `no-corresponde` y el envío cierra sin un solo viaje a la billetera", async () => {
    expect(
      await entrarAlNavegadorDeLaBilletera(),
      "el árbol no llegó a `injected`: este `it` no está midiendo el navegador de la billetera",
    ).toBe("injected");
    sembrarElCaminoPorEnlace();
    // El emisor del desafío, ARMADO Y RESPONDIENDO. Es la mitad que hace falsable al `it`: con el
    // gate invertido `pedir()` tiene todo lo que necesita para salir a la billetera.
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            popChallenge: "ch-372",
            popMessage: "chaski:pop:payout:x:1",
            exp: Math.floor(Date.now() / 1000) + 600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const espia = espiarNavegacion();
    try {
      const repo = new InMemoryRepo();
      const pop = new PopDelAdaptadorReal();
      const id = await sembrarCotizada(repo);

      // ⚠️ EL `catch` NO ES DEFENSIVO: es lo que hace que el rojo lo produzca una ASERCIÓN NOMBRADA y
      // no un throw suelto. Con el gate de disponibilidad invertido, `pedir()` TIRA
      // (`deeplink_viaje_vencido`), y un `it` que muere así no dice qué propiedad se rompió.
      const salida = await armarEnvio({
        repo,
        wallet: new FakeSolanaWallet(),
        prepare: new FakeSolanaPayoutPrepareGateway(),
        gateway: new FakeSolanaSettlementGateway(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(1_000_000_000),
        pop,
      })
        .execute({ remittanceId: id , hrefDeLaVuelta: "https://chaski.test/enviar" })
        .catch((e: unknown) => e as Error);

      // 1 · QUÉ CONTESTÓ `pedir()`, la lista entera y no un `not.toContain`. Va PRIMERA: es la
      //     propiedad del AC, y es la que tiene que nombrar el rojo.
      expect(pop.respuestas, "el camino por enlace se encendió con la billetera INYECTADA").toEqual([
        "no-corresponde",
      ]);
      expect(
        salida instanceof Error ? salida.message : "(sin error)",
        "el recorrido tiró en vez de cerrar",
      ).toBe("(sin error)");
      // 2 · EL ESTADO TERMINAL. Sin esto el `it` podría pasar por haberse cortado antes de pedir nada.
      const out = esperarListo(salida as Exclude<typeof salida, Error>);
      expect(out.snapshot.status, "el envío no llegó a su estado terminal: no se ejercitó el recorrido").toBe(
        "payout_submitted",
      );
      // 3 · Y no se le pidió un desafío a nadie: el corte es el gate, antes de tocar la red.
      expect(fetchSpy, "el camino inyectado salió a pedir un desafío de posesión").not.toHaveBeenCalled();
      // 4 · CERO viajes a la billetera en todo el recorrido.
      expect(viajesALaBilletera(espia.asignado), "hubo un salto a la app de la billetera").toEqual([]);
      expect(espia.asignado, "hubo una navegación programática que este recorrido no tiene que hacer").toEqual(
        [],
      );
    } finally {
      espia.restaurar();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · NINGUNA CUENTA DE NONCE, Y EL UMBRAL QUE APLICA ES EL INYECTADO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W1.0 · el recargo del durable nonce desaparece por INALCANZABILIDAD", () => {
  const MINT_B58 = Keypair.generate().publicKey.toBase58();
  const FACILITATOR_B58 = Keypair.generate().publicKey.toBase58();
  const SENDER_KP = Keypair.generate();

  /** El colaborador de firma por enlace, PRESENTE. Que esté es parte de lo que se mide: la condición
   *  del bloque del nonce es `this.firmaPorEnlace && this.caminoPorEnlace() !== null`, así que dejarlo
   *  ausente explicaría el verde sin decir nada de la disponibilidad. */
  const firmaPorEnlace: FirmaPorEnlace = {
    resolver: () => ({ tipo: "salto", irA: "https://ejemplo.invalid/", esperando: "firma-tx" }),
  };

  // MUTANTE QUE LO TIENE QUE MATAR: el MISMO de arriba y ninguno otro — invertir `!== "none"` por
  // `=== "none"` en `caminoPorEnlace` (`solana-wallet.ts:2240`). ⛔ ESA CITA VA SIN ANCLA A PROPÓSITO:
  // ese archivo lleva marcadores `[[CENSO … entrantes]]` y una cita ANCLADA nueva los corre a todos,
  // o sea que obligaría a editar un archivo que esta ola tiene PROHIBIDO tocar. Con el gate
  // invertido y todo lo demás sembrado, `authorizePrincipal` entra al bloque del nonce, la cuenta no
  // existe en la cadena mockeada, y corta con `deeplink_nonce_ausente`.
  // ⛔ FALSO KILLED A EVITAR: un mutante sobre `this.firmaPorEnlace` mata este mismo `it` SIN decir
  // nada del gate de disponibilidad. Los dos se corren POR SEPARADO, y el que cuenta es el de arriba.
  it("T-372-W1-4: con la billetera inyectada `authorizePrincipal` no arma ninguna ix del System Program", async () => {
    expect(
      await entrarAlNavegadorDeLaBilletera(),
      "el árbol no llegó a `injected`: este `it` no está midiendo el navegador de la billetera",
    ).toBe("injected");
    sembrarElCaminoPorEnlace();
    // 🔴 REPARACIÓN DEL ENTORNO, NO DEL SUJETO — y está MEDIDA, no razonada (sonda del 2026-08-31,
    // creada, corrida y borrada). Bajo `jsdom` en este repo `Buffer.from(x) instanceof Uint8Array` es
    // **false**: jsdom instala su propio `Uint8Array` en el realm global y el `Buffer` de Node viene
    // de otro. Consecuencia medida: `PublicKey.createProgramAddressSync` rechaza con «Uint8Array
    // expected», `isOnCurve` contesta `true` para TODO, y `findProgramAddressSync` agota los 255
    // bumps y tira «Unable to find a viable program address nonce». O sea que `authorizePrincipal`
    // es INALCANZABLE desde jsdom sin esto, y no por nada que tenga que ver con el gate que este `it`
    // mide. Es la misma clase de defecto que este repo ya tiene escrita para `tweetnacl` en
    // (`IR_A_POP_KYC`, `./flow-reanudacion.test.tsx:1340`).
    // ⛔ LO QUE ESTA LÍNEA **NO** HACE: no toca la disponibilidad, no toca `caminoPorEnlace`, no toca
    // el colaborador de firma por enlace, y no fabrica ninguna PDA. Alinea el realm y nada más; el
    // mutante del gate sigue matando este `it` con esta línea puesta.
    // Medido: sin ella el `it` da rojo con «Unable to find a viable program address nonce» tanto con
    // el gate sano como con el gate invertido, o sea que el `it` no podía distinguir nada.
    vi.stubGlobal("Uint8Array", Object.getPrototypeOf(Buffer.prototype).constructor);
    vi.stubEnv("NEXT_PUBLIC_SOLANA_USDC_MINT", MINT_B58);
    vi.stubEnv("NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY", FACILITATOR_B58);
    vi.spyOn(Connection.prototype, "getLatestBlockhash").mockResolvedValue({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    } as Awaited<ReturnType<Connection["getLatestBlockhash"]>>);
    // La cadena contesta «esa cuenta no existe» para todo: es el remitente que deposita por primera
    // vez, y también es la cuenta de nonce AUSENTE que el camino por enlace necesitaría.
    vi.spyOn(Connection.prototype, "getAccountInfo").mockResolvedValue(null as never);
    // Saldo MUY por encima de los dos umbrales: ningún guard de saldo puede explicar este desenlace.
    vi.spyOn(Connection.prototype, "getBalance").mockResolvedValue(9_000_000_000 as never);
    const firmadas: Transaction[] = [];
    solanaWalletBridge.registerSignTransaction(async (tx) => {
      firmadas.push(tx as Transaction);
      (tx as Transaction).partialSign(SENDER_KP);
      return tx;
    });
    solanaWalletBridge.registerSignMessage(async (bytes) =>
      nacl.sign.detached(new Uint8Array(bytes), SENDER_KP.secretKey),
    );
    solanaWalletBridge.setState({ publicKey: SENDER_KP.publicKey.toBase58(), connected: true });

    const adapter = new SolanaWalletAdapter(undefined, undefined, firmaPorEnlace);
    await adapter.connect();
    const desenlace = await adapter
      .authorizePrincipal(quote, "r-372-w1-4", {
        address: "unused-evm-field",
        escrow: {
          beneficiary: Keypair.generate().publicKey.toBase58(),
          authority: Keypair.generate().publicKey.toBase58(),
        },
      }, "https://chaski.test/enviar")
      .catch((e: unknown) => e as Error);

    // 1 · NO CORTÓ POR EL CAMINO POR ENLACE. Con el gate invertido el corte sería
    //     `deeplink_nonce_ausente`, y este `expect` lo nombra en vez de dejarlo salir por un throw.
    expect(
      desenlace instanceof Error ? desenlace.message : "(sin error)",
      "`authorizePrincipal` cortó por el camino por enlace con la billetera INYECTADA",
    ).toBe("(sin error)");
    // 2 · Y LA TRANSACCIÓN QUE SE FIRMÓ NO LLEVA NI UNA IX DEL SYSTEM PROGRAM. La `nonceAdvance` y la
    //     creación de la cuenta de nonce son las dos del System Program: si no hay ninguna, no se
    //     construyó ninguna. ⛔ El programId se LEE de la librería (`SystemProgram.programId`), no se
    //     escribe acá.
    const tx = firmadas[0];
    expect(tx, "nadie le pidió una firma a la billetera: el fixture no llegó a armar la transacción").toBeDefined();
    const delSystemProgram = (tx as Transaction).instructions.filter((ix) =>
      ix.programId.equals(SystemProgram.programId),
    );
    expect(delSystemProgram, "la transacción del camino inyectado trae una ix del System Program").toEqual([]);
  });

  // MUTANTE QUE LO TIENE QUE MATAR: en `../application/use-cases/confirm-and-send.ts:428`, cambiar
  // `SENDER_MIN_LAMPORTS_FOR_DEPOSIT` por `SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT` ⇒ el saldo
  // exactamente igual al umbral inyectado deja de alcanzar y el envío corta.
  // ⛔ Este `it` IMPORTA las dos constantes y compara; ⛔ no re-escribe ningún literal (CD-W1-4).
  it("T-372-W1-5: el umbral que aplica es el INYECTADO, medido por VALOR y no por nombre", async () => {
    expect(
      await entrarAlNavegadorDeLaBilletera(),
      "el árbol no llegó a `injected`: este `it` no está midiendo el navegador de la billetera",
    ).toBe("injected");
    // La calibración del instrumento, ANTES de usarlo: si los dos umbrales fueran iguales, este `it`
    // no podría distinguirlos y su verde no diría nada.
    expect(
      SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT,
      "los dos umbrales son iguales: este `it` no puede separar cuál se aplicó",
    ).toBeGreaterThan(SENDER_MIN_LAMPORTS_FOR_DEPOSIT);

    // (a) EL BORDE QUE PASA: exactamente el umbral inyectado. Con el umbral del enlace no pasaría.
    const repoA = new InMemoryRepo();
    const walletA = new FakeSolanaWallet();
    const idA = await sembrarCotizada(repoA);
    const salidaA = esperarListo(
      await armarEnvio({
        repo: repoA,
        wallet: walletA,
        prepare: new FakeSolanaPayoutPrepareGateway(),
        gateway: new FakeSolanaSettlementGateway(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(SENDER_MIN_LAMPORTS_FOR_DEPOSIT),
        pop: new FakePruebaDePosesionPorEnlace(),
      }).execute({ remittanceId: idA , hrefDeLaVuelta: "https://chaski.test/enviar" }),
    );
    expect(
      salidaA.snapshot.status,
      "un saldo igual al umbral INYECTADO no alcanzó: el guard está usando el umbral del enlace",
    ).toBe("payout_submitted");
    expect(walletA.authorizeCalls, "no se llegó a pedir la firma").toHaveLength(1);

    // (b) EL BORDE QUE CORTA: uno menos. Sin esta mitad, un guard borrado pasaría la mitad (a).
    const repoB = new InMemoryRepo();
    const walletB = new FakeSolanaWallet();
    const idB = await sembrarCotizada(repoB);
    const salidaB = esperarListo(
      await armarEnvio({
        repo: repoB,
        wallet: walletB,
        prepare: new FakeSolanaPayoutPrepareGateway(),
        gateway: new FakeSolanaSettlementGateway(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(SENDER_MIN_LAMPORTS_FOR_DEPOSIT - 1),
        pop: new FakePruebaDePosesionPorEnlace(),
      }).execute({ remittanceId: idB , hrefDeLaVuelta: "https://chaski.test/enviar" }),
    );
    expect(salidaB.snapshot.status, "un lamport por debajo del umbral igual pasó: el guard no corta").toBe(
      "payout_failed",
    );
    expect(walletB.authorizeCalls, "se pidió una firma con el saldo por debajo del umbral").toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · UN `prepare()` POR ENVÍO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W1.0 · el conteo de `prepare()` por envío", () => {
  // MUTANTE QUE LO TIENE QUE MATAR: hacer que el puerto `pop` conteste `hay-que-salir` (que es lo que
  // el camino por enlace produce) ⇒ el envío suspende y la reanudación vuelve a llamar `prepare()`.
  // ⛔ `toHaveBeenCalled()` NO SIRVE acá: el número es la afirmación, no la presencia.
  it("T-372-W1-12: `prepare()` se invoca EXACTAMENTE una vez en un envío que cierra", async () => {
    expect(
      await entrarAlNavegadorDeLaBilletera(),
      "el árbol no llegó a `injected`: este `it` no está midiendo el navegador de la billetera",
    ).toBe("injected");
    sembrarElCaminoPorEnlace();
    const repo = new InMemoryRepo();
    const prepare = new FakeSolanaPayoutPrepareGateway();
    const pop = new PopDelAdaptadorReal();
    const id = await sembrarCotizada(repo);

    const out = esperarListo(
      await armarEnvio({
        repo,
        wallet: new FakeSolanaWallet(),
        prepare,
        gateway: new FakeSolanaSettlementGateway(),
        senderBalance: new FakeSolanaSenderSolBalanceProbe(1_000_000_000),
        pop,
      }).execute({ remittanceId: id , hrefDeLaVuelta: "https://chaski.test/enviar" }),
    );

    expect(
      prepare.calls.length,
      "el envío no creó EXACTAMENTE una orden de payout server-side: cada invocación de más deja una " +
        "orden huérfana, porque la remesa guarda sólo el último `payoutId`",
    ).toBe(1);
    // CD-18 — y el conteo se midió sobre un recorrido que CERRÓ. Un `1` sobre un recorrido cortado
    // antes del prepare sería un cero disfrazado.
    expect(out.snapshot.status, "el envío no cerró: un conteo sobre un recorrido cortado no dice nada").toBe(
      "payout_submitted",
    );
    expect(pop.respuestas, "el recorrido salió del camino inyectado").toEqual(["no-corresponde"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · EL CAMINO DE RESPALDO SIGUE ENTERO (AC-1-5)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W1.0 · W1 no borra el recorrido por enlace profundo", () => {
  // MUTANTE QUE LO TIENE QUE MATAR: renombrar `nonce-duradero.ts` (o borrar cualquiera de los módulos
  // de `deeplink/`) en un worktree ⇒ la primera mitad se pone roja.
  // ⛔ FALSO KILLED A EVITAR: un `it` que sólo mirara el diff NO es un guard. Éste LEE EL ÁRBOL con
  // `node:fs` y monta la pantalla real.
  it("T-372-W1-11: los módulos del camino de respaldo están, y el selector de enlace sigue apareciendo", async () => {
    // (a) EL ÁRBOL. Se AFIRMA POR NOMBRE lo que no puede desaparecer, y ⛔ NO se afirma un CONTEO.
    //     La diferencia importa: un conteo se pudre solo el día que alguien agrega un módulo legítimo
    //     (y entonces se "arregla" subiendo el número, que es cómo muere un candado), mientras que el
    //     conjunto de nombres sólo se pone rojo cuando algo se BORRA — que es exactamente lo que
    //     AC-1-5 prohíbe. Los nombres se derivaron del árbol hoy con `readdirSync`, no de memoria.
    const enLaCarpeta = readdirSync("src/infrastructure/solana/deeplink").filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    for (const modulo of [
      "conexion.ts",
      "firma-por-enlace.ts",
      "pop-por-enlace.ts",
      "preparado.ts",
      "protocol.ts",
      "sesion.ts",
    ]) {
      expect(
        enLaCarpeta,
        `\`deeplink/${modulo}\` no está: W1 borró un módulo del camino de respaldo (AC-1-5)`,
      ).toContain(modulo);
    }
    expect(
      existsSync("src/infrastructure/solana/nonce-duradero.ts"),
      "`nonce-duradero.ts` no está: el código del durable nonce se BORRÓ en vez de volverse inalcanzable",
    ).toBe(true);
    expect(
      existsSync("src/infrastructure/solana/preparacion-por-enlace.ts"),
      "`preparacion-por-enlace.ts` no está",
    ).toBe(true);
    // 🔴 SE MIDE EL INSTRUMENTO ANTES DE CREERLE, y acá no es una formalidad: es lo ÚNICO que hace
    // falsable a la mitad (a) de este `it`. MEDIDO el 2026-08-31: borrar `nonce-duradero.ts` de verdad
    // NO produce un `×` nombrado — produce `Failed to resolve import "./solana/nonce-duradero" from
    // "src/infrastructure/solana-wallet.ts"` y el archivo entero colapsa en `0 test`. O sea que el
    // mutante «renombrar el módulo» **no puede aislar este `it`**: se lleva puesta a toda la suite, y
    // un rojo así es indistinguible de un error de sintaxis (CD-W1-5). Lo que sí protege AC-1-5 en el
    // CI es exactamente eso: **este repo no compila sin esos módulos**. Y lo que impide que estas
    // aserciones sean decorativas es el control de acá abajo, que exige que los dos predicados sepan
    // contestar que NO.
    expect(
      existsSync("src/infrastructure/solana/nonce-duradero-que-no-existe.ts"),
      "`existsSync` contesta `true` para un archivo inventado: este instrumento no puede decir que NO",
    ).toBe(false);
    expect(
      enLaCarpeta,
      "el listado de la carpeta contiene un módulo inventado: este instrumento no puede decir que NO",
    ).not.toContain("un-modulo-que-nadie-escribio.ts");

    // (b) LA PANTALLA. Sin wallet inyectada y con la bandera prendida, el selector de enlace sigue
    //     siendo una salida ofrecida. ⛔ La disponibilidad la produce el MISMO arnés, sin inyectar.
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
    expect(
      await entrarAlNavegadorDeLaBilletera(false, 1700),
      "el árbol no llegó a `none`: no se está midiendo el navegador común",
    ).toBe("none");
    render(<RemittanceFlow pasoInicial="send" container={buildTestContainer()} />);
    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), { target: { value: "Mamá" } });
    fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    await screen.findByRole("button", { name: /Conectar wallet/ });
    expect(
      await screen.findByText(/Conectá desde tu app de billetera/),
      "el selector del camino por enlace desapareció de la pantalla `connect`",
    ).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · LAS TRAVESÍAS DE LA PANTALLA DE ENTRADA (AC-1-2a / AC-1-2b)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 CÓMO SE CUENTA UNA TRAVESÍA, Y POR QUÉ ASÍ. La pantalla de entrada se atraviesa una vez por CARGA
// de la página. La app arranca cargada una vez (travesía 1) y cada asignación de `window.location.href`
// se lleva la pestaña afuera; la vuelta es una carga nueva, o sea otra travesía. ⇒
// `travesías = 1 + asignaciones`. El propio repo llama a esa vuelta «una RECARGA», textual, en
// `./flow.tsx:235`.
describe("W1.0 · cuántas veces se atraviesa la pantalla de entrada", () => {
  const DIRECCION = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

  async function cargarYEnviar(container: ReturnType<typeof buildTestContainer>): Promise<void> {
    render(<RemittanceFlow pasoInicial="send" container={container} />);
    fireEvent.change(screen.getByPlaceholderText("Nombre de tu familiar"), { target: { value: "Mamá" } });
    fireEvent.change(screen.getByPlaceholderText("002 193 004455667788 99"), { target: { value: TEST_CCI } });
    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));
    const conectar = await screen.findByRole("button", { name: /Conectar wallet/ });
    await act(async () => {
      fireEvent.click(conectar);
    });
  }

  // MUTANTE QUE LO TIENE QUE MATAR: borrar del bloque de `./flow.tsx:356-360` la condición
  // `rememberedKyc.approved && rememberedKyc.realVerified` ⇒ el caso (a) deja de tomar el atajo,
  // vuelve a pasar por `review`/`verify`, sale al verificador ⇒ 2 travesías ⇒ rojo.
  // ⛔ LOS DOS FALSOS KILLED A EVITAR:
  //   (1) si el fixture de (a) no sembrara el KYC aprobado, el atajo nunca se ejercita y el `it` da
  //       verde por vacío. Por eso (a) afirma el paso `confirm` alcanzado ANTES de contar nada.
  //   (2) si (b) no assertara el HOST del `location.href`, pasaría sin contar nada: la recarga que se
  //       hereda es la del VERIFICADOR y de ninguna manera la de una billetera.
  it("T-372-W1-13: recurrente ⇒ 1 travesía y 0 viajes a la billetera; primera vez ⇒ la recarga es del verificador", async () => {
    expect(
      await entrarAlNavegadorDeLaBilletera(),
      "el árbol no llegó a `injected`: este `it` no está midiendo el navegador de la billetera",
    ).toBe("injected");

    // ── (a) RECURRENTE — el listón estricto, y no se afloja ──────────────────────────────────────
    const kycStore = new FakeKycStore();
    await kycStore.save(DIRECCION, passKyc);
    const espiaA = espiarNavegacion();
    try {
      await cargarYEnviar(buildTestContainer({ kycStore }));
      // CD-18 — el fixture ejercitó el atajo: se llegó a `confirm` sin pasar por el escaneo.
      // ⚠️ El `.catch(() => null)` NO es defensivo: es lo que hace que el rojo lo produzca ESTA
      // aserción, con su motivo, en vez del «Unable to find role» genérico de la librería.
      const enConfirm = await screen
        .findByRole("button", { name: /Confirmar y enviar/ })
        .catch(() => null);
      expect(
        enConfirm,
        "el atajo KYC-once no se tomó: el recorrido recurrente volvió a pasar por `review`/`verify`, " +
          "o sea que sale al verificador y atraviesa la pantalla de entrada DOS veces",
      ).not.toBeNull();
      expect(
        screen.queryByRole("button", { name: /Verificar mi identidad/ }),
        "el recorrido recurrente pasó por el escaneo de identidad",
      ).toBeNull();
      expect(1 + espiaA.asignado.length, "el recorrido recurrente atravesó la pantalla de entrada más de una vez").toBe(
        1,
      );
      expect(viajesALaBilletera(espiaA.asignado), "hubo un salto a la app de la billetera").toEqual([]);
    } finally {
      espiaA.restaurar();
    }
    cleanup();

    // ── (b) PRIMERA VEZ — declara la recarga que HEREDA, y sigue midiendo 0 viajes a la billetera ──
    const espiaB = espiarNavegacion();
    try {
      await cargarYEnviar(buildTestContainer({ kyc: new FakeKycGateway({}, true) }));
      fireEvent.click(await screen.findByRole("button", { name: /Continuar/ })); // review → verify
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: /Verificar mi identidad/ }));
      });

      // La travesía adicional existe y se declara: la causa es el redirect del verificador
      // (`./flow.tsx:460`), que ya existía y NO es de esta HU.
      expect(
        1 + espiaB.asignado.length,
        "el recorrido de primera vez no produjo la recarga del verificador: el caso no ejercitó nada",
      ).toBe(2);
      const destino = espiaB.asignado[0] as string;
      expect(new URL(destino).hostname, "la única recarga heredada no es la del verificador").toBe(
        "verificacion.example",
      );
      // Y LO QUE W1 SÍ CONTROLA: cero viajes a la billetera, también en el recorrido de primera vez.
      expect(viajesALaBilletera(espiaB.asignado), "hubo un salto a la app de la billetera").toEqual([]);
    } finally {
      espiaB.restaurar();
    }
  });
});
