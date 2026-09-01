// @vitest-environment jsdom
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-372 · W3.0 — LA PREMISA DE LA OLA, FALSABLE, SOBRE EL ÁRBOL DE HOY
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 POR QUÉ ESTE ARCHIVO SE ESCRIBIÓ ANTES DE UNA SOLA LÍNEA DE PRODUCCIÓN. W3 dice que hoy se piden
// DOS firmas de identidad que prueban lo mismo, y que la causa es que la app no tiene sesión. Si hoy
// fuera UNA, W3 no tendría nada que borrar; si ya existiera un atajo (un almacén que el gateway del
// pago pueda leer, una credencial que la ruta acepte por cookie, una fila que haga de sesión), la ola
// estaría construyendo algo que ya está. Los cinco puntos, cada uno con su `it`:
//   1. dos `signMessage` de identidad en un recorrido inyectado que CIERRA      → T-372-W3-0a
//   2. el emisor del desafío contesta 200 para cualquier dirección, SIN firma   → T-372-W3-0b
//   3. `prepare` no lee cookie ni header: la credencial son dos campos del body → T-372-W3-0c
//   4. `PopSigner` no tiene `peek` ⇒ la 2ª firma no está saltada por otra vía   → T-372-W3-0d
//   5. `kyc_session_tokens` no puede servir de sesión                           → T-372-W3-0e
//
// ⚠️ LO QUE NO PRUEBA, antes de que alguien lea su verde de más: ninguno de estos `it` corre en un
// teléfono y ninguno habla con un servidor de verdad (el `fetch` está doblado, las rutas se invocan
// como funciones). Lo que sí hacen es ejercitar los handlers REALES y los gateways REALES.
//
// ⚠️ MEDICIÓN DEL ENTORNO, antes de que alguien lea un rojo de acá como un hallazgo: bajo `jsdom`
// `nacl.sign.detached` TIRA `unexpected type, use Uint8Array` (el `Uint8Array` de este realm no es el
// que tweetnacl compara con `instanceof`; medido el 2026-08-31 con una sonda) ⇒ acá NO se puede
// PRODUCIR una firma ed25519 y ningún `it` de este archivo llega a `P5`. Los que ejercitan `prepare`
// cortan en `P1`, que es el guard que la premisa 3 mide. La mitad con PoP REAL vive donde el realm lo
// permite: `app/api/payout/prepare/route.test.ts`, en entorno node.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";

// El rate-limit real es fail-closed sin Upstash (503), y este archivo invoca handlers de ruta: sin
// este doble los `it` medirían el limiter en vez del guard que dicen medir. Mismo patrón, y por el
// mismo motivo, que `app/api/payout/prepare/route.test.ts:9`.
const { checkRouteRateLimitMock } = vi.hoisted(() => ({ checkRouteRateLimitMock: vi.fn() }));
vi.mock("../infrastructure/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infrastructure/rate-limit")>();
  return { ...actual, checkRouteRateLimit: checkRouteRateLimitMock };
});

// El barrel `@solana/wallet-adapter-wallets` arrastra el adapter de Ledger, que no resuelve bajo
// vitest. Mismo reemplazo que `./wallet-availability.test.tsx:32`.
vi.mock("@solana/wallet-adapter-wallets", async () => {
  const p = await import("@solana/wallet-adapter-phantom");
  const s = await import("@solana/wallet-adapter-solflare");
  return { PhantomWalletAdapter: p.PhantomWalletAdapter, SolflareWalletAdapter: s.SolflareWalletAdapter };
});

// framer-motion pass-through: jsdom no implementa `requestAnimationFrame`.
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

import { POST as CHALLENGE_POST } from "../../app/api/a2a/payout/challenge/route";
import { POST as PREPARE_POST } from "../../app/api/payout/prepare/route";
import { ConfirmAndSend } from "../application/use-cases/confirm-and-send";
import { ConnectWallet } from "../application/use-cases/connect-wallet";
import type { PopSigner, PruebaDePosesionPorEnlace, PruebaPorEnlace } from "../application/ports";
import { HttpPopSigner } from "../infrastructure/auth/http-pop-signer";
import { InMemoryPopProofStore } from "../infrastructure/auth/pop-proof-store";
import { buildSolanaPopMessage, verifySolanaPopChallenge } from "../infrastructure/auth/pop-challenge"; // WKH-372/W3.5 — el CONSTRUCTOR REAL del mensaje PoP: `T-372-W3-10b` NO reescribe el mensaje a mano
import { emitirSesionDePosesion } from "../infrastructure/auth/sesion-de-posesion"; // el EMISOR REAL de la sesión: un token inventado no probaría nada
import { InMemorySesionStore } from "../infrastructure/auth/sesion-store";
import { resolveSolanaNetworkId } from "../infrastructure/chain"; // ⛔ el CAIP-2 se resuelve, NUNCA se escribe a mano
import { HttpKycVerdictGateway } from "../infrastructure/kyc/http-kyc-verdict-gateway";
import { SupabaseKycSessionTokenStore } from "../infrastructure/persistence/supabase-kyc-session-tokens";
import { HttpSolanaPayoutPrepareGateway } from "../infrastructure/settlement/http-solana-prepare-gateway";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { CLAVE_ELECCION } from "../infrastructure/solana/deeplink/conexion";
import { Money } from "../domain/money";
import { type KycVerification, type Quote, Remittance } from "../domain/remittance";
import {
  FAKE_SOLANA_AUTHORITY,
  FAKE_SOLANA_BENEFICIARY,
  FakeKycStore,
  FakeRefundGateway,
  FakeSolanaEscrowDepositProbe,
  FakeSolanaSenderSolBalanceProbe,
  FakeSolanaSettlementGateway,
  FakeSolanaWallet,
  FixedClock,
  InMemoryRepo,
  QUOTE_EXPIRES,
  T0,
  beneficiary,
} from "../test-support/fakes";
import { esperarListo } from "../test-support/desenlaces";

const UA_ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
/** Una dirección base58 válida que NO es la del caller. Sirve de "dirección arbitraria" en `-0b`. */
const OTRA_DIRECCION = "So11111111111111111111111111111111111111112";
/** El mensaje que el emisor real manda a firmar, con la MISMA forma de `buildSolanaPopMessage`. */
const MENSAJE_POP = "Chaski Proof-of-Possession\naddress: x\nnetwork: solana:devnet\nnonce: n\nexpires: 1";

function setUserAgent(value: string): void {
  Object.defineProperty(window.navigator, "userAgent", { value, configurable: true });
}

/** Inyecta la wallet en el scope global, como el navegador interno de Phantom en el celular. Copiado
 *  de (`inyectarWallet`, `./recorrido-en-el-navegador-de-la-billetera.test.tsx:115`). */
function inyectarWallet(): void {
  const solana = { isPhantom: true, isConnected: false, publicKey: { toBytes: () => new Uint8Array(32).fill(1) }, connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), on: vi.fn(), off: vi.fn() };
  const w = window as unknown as Record<string, unknown>;
  w.isPhantomInstalled = true;
  w.phantom = { solana };
  w.solana = solana;
}

function quitarWalletInyectada(): void {
  const w = window as unknown as Record<string, unknown>;
  w.isPhantomInstalled = w.phantom = w.solana = undefined;
}

/** 🔴 EL ARNÉS: monta el árbol REAL y devuelve lo que el bridge terminó diciendo. ⛔ NO SETEA NADA:
 *  la disponibilidad la produce la librería sondeando el scope global. Molde:
 *  (`entrarAlNavegadorDeLaBilletera`, `./recorrido-en-el-navegador-de-la-billetera.test.tsx:149`). */
async function entrarAlNavegadorDeLaBilletera(esperaMs = 1200): Promise<string> {
  setUserAgent(UA_ANDROID_CHROME);
  inyectarWallet();
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

/** Las otras dos condiciones del camino por enlace, SEMBRADAS: así la única variable que queda es la
 *  disponibilidad que produjo el árbol. Molde y razón:
 *  (`sembrarElCaminoPorEnlace`, `./recorrido-en-el-navegador-de-la-billetera.test.tsx:226`). */
function sembrarElCaminoPorEnlace(): void {
  vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
  window.localStorage.setItem(CLAVE_ELECCION, "phantom");
}

/** El adaptador REAL como puerto de prueba por enlace, anotando qué contestó. ⛔ No sustituye la
 *  respuesta. Molde: (`PopDelAdaptadorReal`, `./recorrido-en-el-navegador-de-la-billetera.test.tsx:294`). */
class PopDelAdaptadorReal implements PruebaDePosesionPorEnlace {
  readonly respuestas: string[] = [];
  private readonly real = new SolanaWalletAdapter();
  async pedir(input: { proposito: "pop-payout" | "pop-kyc"; direccion: string }): Promise<PruebaPorEnlace> {
    const r = await this.real.pedir(input);
    this.respuestas.push(r.estado);
    return r;
  }
}

// Remesa cotizada y con el KYC aplicado: el estado desde el que `ConfirmAndSend` corre entero.
// Molde: (`sembrarCotizada`, `./recorrido-en-el-navegador-de-la-billetera.test.tsx:262`).
const passKyc: KycVerification = { verificationId: "v-1", approved: true, payoutAllowed: true, realVerified: true, verifiedAt: null, riskLevel: "low", provenance: "didit", identity: null };
const quote: Quote = { quoteId: "q1", send: Money.of(400, "USDC"), receive: Money.of(1480, "PEN"), feeUsd: Money.of(0.5, "USDC"), rate: 3.7, etaMinutes: 30, expiresAt: QUOTE_EXPIRES, provenance: "fake" };

async function sembrarCotizada(repo: InMemoryRepo): Promise<string> {
  const r = Remittance.create("r-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(quote, T0);
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  await repo.save(r);
  return "r-1";
}

/** 🔴 EL SERVIDOR ES DE MENTIRA, LOS CLIENTES SON DE VERDAD. Los cuatro endpoints que un recorrido
 *  inyectado toca. Lo que se mide no es el servidor: son los DOS gateways reales y el `HttpPopSigner`
 *  real, que son los que deciden cuántas veces se le pide una firma a la persona. */
/** 🔴 LO QUE EL REGISTRO ANOTA, Y POR QUÉ HACE FALTA. Sin él, "la sesión reemplazó a la firma" sólo se
 *  podría afirmar contando prompts, y contar prompts no distingue "no se firmó porque la sesión viajó"
 *  de "no se firmó porque el recorrido se cortó antes". Acá quedan los cuerpos que efectivamente
 *  viajaron y los desafíos que el emisor REAL produjo. */
interface RegistroDelServidor {
  readonly prepares: Record<string, unknown>[];
  readonly desafios: { popChallenge: string; popMessage: string }[];
}

function registroVacio(): RegistroDelServidor {
  return { prepares: [], desafios: [] };
}

/** 🔴 EL SERVIDOR ES DE MENTIRA, LOS CLIENTES SON DE VERDAD. Los cuatro endpoints que un recorrido
 *  inyectado toca. Lo que se mide no es el servidor: son los DOS gateways reales y el `HttpPopSigner`
 *  real, que son los que deciden cuántas veces se le pide una firma a la persona.
 *
 *  ⚠️ LAS OPCIONES SON ADITIVAS: `servidorDeLaApp()` sin argumentos se comporta EXACTAMENTE como se
 *  comportaba cuando W3.0 midió la premisa, así que `T-372-W3-0a` sigue midiendo lo mismo.
 *  · `emisorReal` — el desafío lo emite el HANDLER de producción (`CHALLENGE_POST`) en vez de un
 *    literal, así que el mensaje que la billetera firma lo construye `buildSolanaPopMessage` de
 *    verdad. Es lo que hace falsable a `T-372-W3-10b`. Requiere `PAYOUT_POP_SECRET` stubeada.
 *  · `conSesion` — el 200 del veredicto trae una sesión emitida por el EMISOR REAL para el `sender`
 *    que el cliente mandó. ⛔ Nunca un string escrito a mano: un token inventado no probaría que el
 *    que viaja es el que el servidor acuña. Requiere `PAYOUT_SESSION_SECRET` stubeada. */
function servidorDeLaApp(
  opciones: { emisorReal?: boolean; conSesion?: boolean; registro?: RegistroDelServidor } = {},
): ReturnType<typeof vi.fn> {
  const reg = opciones.registro;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const cuerpo = (o: unknown) =>
      new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    const leerBody = (): Record<string, unknown> =>
      init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const destino = { beneficiary: FAKE_SOLANA_BENEFICIARY, authority: FAKE_SOLANA_AUTHORITY };
    if (url === "/api/a2a/payout/challenge") {
      if (!opciones.emisorReal)
        return cuerpo({ popChallenge: "ch-w3", popMessage: MENSAJE_POP, exp: Math.floor(Date.now() / 1000) + 600 });
      const res = await CHALLENGE_POST(pedido("/api/a2a/payout/challenge", leerBody()));
      const emitido = (await res.clone().json()) as { popChallenge: string; popMessage: string };
      reg?.desafios.push(emitido);
      return res;
    }
    if (url === "/api/kyc/verdict") {
      const sender = String(leerBody().sender ?? "");
      const sesion = opciones.conSesion ? emitirSesionDePosesion(sender, resolveSolanaNetworkId(), Date.now()) : null;
      if (opciones.conSesion && !sesion)
        throw new Error("el emisor de la sesión devolvió null: falta stubear PAYOUT_SESSION_SECRET");
      return cuerpo({
        verdict: { riskLevel: "low", provenance: "didit", verifiedAt: T0 },
        ...(sesion ? { sesion } : {}),
      });
    }
    if (url === "/api/payout/prepare") {
      reg?.prepares.push(leerBody());
      return cuerpo({ ...destino, attestation: "att-w3", payoutId: "po-w3", provenance: "transfi" });
    }
    if (url === "/api/payout/attestation") return cuerpo(destino);
    throw new Error(`endpoint no previsto en este arnes: ${url}`);
  });
}

/** El recorrido de identidad completo, con los colaboradores REALES: conectar (que consulta el
 *  veredicto) y enviar (que prepara el payout). Devuelve los mensajes que la billetera terminó
 *  firmando, en orden. */
async function recorridoInyectado(
  sesiones?: InMemorySesionStore,
): Promise<{ firmados: string[]; estadoFinal: string; enlace: string[] }> {
  const wallet = new FakeSolanaWallet();
  const firmados: string[] = [];
  vi.spyOn(wallet, "signMessage").mockImplementation(async (mensaje: string) => {
    firmados.push(mensaje);
    return "firma-de-mentira";
  });
  const popProofs = new InMemoryPopProofStore(new FixedClock());
  const enlace = new PopDelAdaptadorReal();

  await new ConnectWallet(
    wallet,
    new FakeKycStore(),
    new HttpKycVerdictGateway(new HttpPopSigner(wallet, popProofs), sesiones),
    enlace,
  ).execute();

  const repo = new InMemoryRepo();
  const id = await sembrarCotizada(repo);
  const remesa = esperarListo(
    await new ConfirmAndSend(wallet, repo, new FixedClock(), new FakeRefundGateway("no-receipt"), {
      prepare: new HttpSolanaPayoutPrepareGateway(new HttpPopSigner(wallet, popProofs), sesiones),
      gateway: new FakeSolanaSettlementGateway(),
      probe: new FakeSolanaEscrowDepositProbe(),
      senderBalance: new FakeSolanaSenderSolBalanceProbe(1_000_000_000),
      pop: enlace,
    }).execute({ remittanceId: id , hrefDeLaVuelta: "https://chaski.test/enviar" }),
  );
  return { firmados, estadoFinal: remesa.snapshot.status, enlace: enlace.respuestas };
}

function pedido(url: string, cuerpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(cuerpo),
  });
}

beforeEach(() => {
  solanaWalletBridge.reset();
  quitarWalletInyectada();
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
  checkRouteRateLimitMock.mockReset();
  checkRouteRateLimitMock.mockResolvedValue({ ok: true });
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
// 1 · HOY SE FIRMA DOS VECES PARA PROBAR LO MISMO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W3.0 · la premisa: dos firmas de identidad en el recorrido inyectado", () => {
  // Es una MEDICIÓN del árbol de hoy, así que no tiene mutante propio: lo que la vuelve falsable es
  // que el número es la afirmación (⛔ `toHaveBeenCalled()` no serviría) y que el recorrido CIERRA.
  // ⛔ FALSO KILLED A EVITAR: un fixture que se cortara antes del `prepare` contaría 1 y haría parecer
  // FALSA la premisa de la ola. Por eso el estado terminal se assertea, y va antes que el conteo.
  it("T-372-W3-0a: en un recorrido inyectado que CIERRA, `signMessage` se invoca EXACTAMENTE 2 veces", async () => {
    expect(
      await entrarAlNavegadorDeLaBilletera(),
      "el árbol no llegó a `injected`: este `it` no está midiendo el recorrido inyectado",
    ).toBe("injected");
    sembrarElCaminoPorEnlace();
    vi.stubGlobal("fetch", servidorDeLaApp());

    const { firmados, estadoFinal, enlace } = await recorridoInyectado();

    // 1 · EL RECORRIDO CERRÓ. Va primero: un conteo sobre un recorrido cortado no dice nada.
    expect(estadoFinal, "el envío no llegó a su estado terminal: no se ejercitó el recorrido entero").toBe(
      "payout_submitted",
    );
    // 2 · Y fue el camino INYECTADO, con el de enlace sembrado y aun así apagado.
    expect(enlace, "el recorrido salió del camino inyectado").toEqual(["no-corresponde", "no-corresponde"]);
    // 3 · LAS DOS FIRMAS. El número ES la afirmación: si diera 1, W3 no tendría nada que borrar.
    expect(
      firmados.length,
      "hoy no se piden DOS firmas de identidad: la premisa de W3 es falsa y la ola se detiene",
    ).toBe(2);
    // 4 · Y las dos prueban LO MISMO: el mensaje es de posesión, sin monto ni beneficiario.
    for (const m of firmados) {
      expect(m, "una de las dos firmas no es una prueba de posesión").toContain("Chaski Proof-of-Possession");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 2 · EL EMISOR DEL DESAFÍO NO PIDE NINGUNA FIRMA ⇒ LA SESIÓN NECESITA SECRETO PROPIO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W3.0 · el emisor del desafío es anónimo", () => {
  // ⛔ FALSO KILLED A EVITAR: un 200 que venga de un doble no mide nada. Acá se invoca el HANDLER REAL.
  it("T-372-W3-0b: `POST /api/a2a/payout/challenge` devuelve 200 para una dirección arbitraria SIN ninguna firma", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "secreto-del-desafio");
    const res = await CHALLENGE_POST(pedido("/api/a2a/payout/challenge", { address: OTRA_DIRECCION }));
    const cuerpo = (await res.json()) as Record<string, unknown>;

    expect(res.status, "el emisor pidió algo más que la dirección").toBe(200);
    expect(typeof cuerpo.popChallenge, "el 200 no trae token: no es el emisor que la premisa describe").toBe(
      "string",
    );
    // 🔴 LA CONSECUENCIA, escrita donde se mide: si el verificador de la sesión compartiera este
    // secreto y esta forma, cualquier anónimo se emitiría una sesión para la dirección de OTRO con un
    // solo `curl`. Por eso B lleva `PAYOUT_SESSION_SECRET` propio, y `T-372-W3-2` lo mide.
    expect(
      JSON.stringify(cuerpo),
      "el emisor pide una firma: entonces el challenge NO es forjable por un anónimo",
    ).not.toContain("signature");
    // CONTROL POSITIVO del instrumento: esta ruta SABE decir que no. Sin esta mitad, un handler que
    // contestara 200 a todo daría el mismo verde de arriba.
    const malo = await CHALLENGE_POST(pedido("/api/a2a/payout/challenge", { address: "no-es-base58" }));
    expect(malo.status, "el emisor contesta 200 hasta con una dirección basura: no mide nada").toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 3 · `prepare` NO TIENE HOY NINGUNA NOCIÓN DE SESIÓN
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W3.0 · la única credencial de identidad de `prepare` son dos campos del cuerpo", () => {
  const cuerpoSinPrueba = { remittanceId: "rem-1", quoteId: "q-400", address: OTRA_DIRECCION, amountUsd: 400, beneficiary: { name: "Mamá", country: "PE", method: "yape", destination: "999888777" }, idempotencyKey: "rem-1:q-400" };

  // ⛔ FALSO KILLED A EVITAR: un `it` que sólo LEYERA el archivo es prosa. Acá se MANDA un request con
  // cookie y con header de sesión y se compara la respuesta byte a byte con la del request pelado.
  it("T-372-W3-0c: `prepare` ignora cookie y header: la respuesta es byte-idéntica con y sin ellos", async () => {
    vi.stubEnv("DEPOSIT_ATTESTATION_SECRET", "att");
    vi.stubEnv("PAYOUT_POP_SECRET", "pop");
    const conCredenciales = await PREPARE_POST(
      pedido("/api/payout/prepare", cuerpoSinPrueba, { cookie: "chaski_sesion=tok; otra=1", "x-chaski-sesion": "tok", authorization: "Bearer tok" }),
    );
    const pelado = await PREPARE_POST(pedido("/api/payout/prepare", cuerpoSinPrueba));

    expect(conCredenciales.status, "presentar una sesión por cookie/header cambió el status").toBe(
      pelado.status,
    );
    expect(conCredenciales.status).toBe(403);
    expect(
      JSON.stringify(await conCredenciales.json()),
      "presentar una sesión por cookie/header cambió el cuerpo: `prepare` YA tiene una noción de sesión",
    ).toBe(JSON.stringify(await pelado.json()));
    // CONTROL POSITIVO: el instrumento SÍ distingue dos respuestas de esta misma ruta, y lo que las
    // distingue es el CUERPO. Sin esta mitad, una ruta que devolviera siempre lo mismo daría verde.
    const otroCuerpo = await PREPARE_POST(
      pedido("/api/payout/prepare", { ...cuerpoSinPrueba, quoteId: "" }, { cookie: "chaski_sesion=x" }),
    );
    expect(otroCuerpo.status, "este `it` no puede distinguir dos respuestas: no mide nada").toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 4 · LA SEGUNDA FIRMA NO ESTÁ SALTADA POR OTRA VÍA
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W3.0 · el firmante del pago no puede leer una prueba guardada", () => {
  // ⚠️ FALSO KILLED A EVITAR: un guard de existencia que IMPORTE lo que vigila muere por colapso del
  // resolvedor de módulos, no por aserción. Acá no se vigila un archivo: se vigila un TIPO (lo caza
  // `tsc` por el `@ts-expect-error`) y la FORMA del objeto real (lo caza el `expect`).
  it("T-372-W3-0d: `PopSigner` no tiene `peek`, y el firmante real tampoco", () => {
    const firmante: PopSigner = new HttpPopSigner(new FakeSolanaWallet());
    // @ts-expect-error — 🔴 EL MECANISMO ES EL TIPO: si alguien le agrega `peek` a `PopSigner`, ESTA
    // línea deja de dar error y `tsc` pone rojo el gate. Es el patrón de `../application/ports.ts:137-155`.
    const noExiste = firmante.peek;
    expect(noExiste, "`PopSigner` ganó un `peek`: la segunda firma ya estaría saltada por otra vía").toBe(
      undefined,
    );
    expect("peek" in firmante, "el firmante real expone `peek`").toBe(false);
    // CONTROL POSITIVO del instrumento: `"x" in y` sabe decir que SÍ, acá y en el almacén que sí lo tiene.
    expect("prove" in firmante, "el instrumento no sabe decir que sí: no mide nada").toBe(true);
    expect("peek" in new InMemoryPopProofStore(new FixedClock()), "idem, sobre el que SÍ tiene `peek`").toBe(
      true,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 5 · LA TABLA DE CREDENCIALES DE KYC NO PUEDE HACER DE SESIÓN
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W3.0 · `kyc_session_tokens` no sirve de sesión", () => {
  /** Un cliente de Supabase falso que APLICA los filtros pedidos y los anota. ⛔ No devuelve la fila
   *  "igual": si devolviera siempre lo mismo, la mitad negativa de abajo sería decorativa. */
  function almacenFalso(filas: Array<Record<string, string>>) {
    const filtros: Array<{ col: string; val: unknown }> = [];
    const columnas: string[] = [];
    const cadena = {
      select: (cols: string) => (columnas.push(cols), cadena),
      eq: (col: string, val: unknown) => (filtros.push({ col, val }), cadena),
      maybeSingle: async () => ({
        data: filas.find((r) => filtros.every(({ col, val }) => r[col] === val)) ?? null,
        error: null,
      }),
    };
    const client = { from: () => cadena } as unknown as SupabaseClient;
    return { store: new SupabaseKycSessionTokenStore(client), filtros, columnas };
  }

  // ⛔ FALSO KILLED A EVITAR: no se lee la migración por prosa. Se EJERCITA `getForOwner`.
  it("T-372-W3-0e: la credencial se indexa por el `session_id` del proveedor, no por la dirección, y no vence", async () => {
    const FILA = { session_id: "s-1", owner_address: FAKE_SOLANA_BENEFICIARY, decision_token: "dt-1" };
    // (a) LA MITAD POSITIVA: con el id del proveedor Y la dirección, la credencial sale.
    const a = almacenFalso([FILA]);
    expect(await a.store.getForOwner("s-1", FAKE_SOLANA_BENEFICIARY), "no salió la credencial").toBe("dt-1");
    // (b) LA MITAD QUE IMPORTA: la MISMA dirección, sin el id del proveedor, no consigue nada. Una
    //     sesión se pide con "¿qué tenés para ESTA dirección?", y esta tabla no contesta esa pregunta.
    const b = almacenFalso([FILA]);
    expect(
      await b.store.getForOwner("s-2", FAKE_SOLANA_BENEFICIARY),
      "conocer la dirección alcanzó para sacar la credencial: la tabla SÍ podría hacer de sesión",
    ).toBe(null);
    // (c) NO VENCE: la lectura no pide reloj y no mira ninguna columna de vencimiento.
    expect(a.columnas, "la lectura trae más que la credencial").toEqual(["decision_token"]);
    expect(a.filtros.map((f) => f.col)).toEqual(["session_id", "owner_address"]);
    expect(
      a.store.getForOwner.length,
      "`getForOwner` recibe un tercer argumento: puede haber un vencimiento que este `it` no ve",
    ).toBe(2);
    // CONTROL POSITIVO del anotador: sabe decir que una columna NO se miró.
    expect(a.filtros.map((f) => f.col), "el anotador afirma columnas que nadie filtró").not.toContain("exp");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 6 · W3.4 — CON LA SESIÓN CABLEADA, EL MISMO RECORRIDO PIDE UNA SOLA FIRMA
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 ES EL `it` QUE CIERRA LA OLA, Y SE LEE CONTRA `T-372-W3-0a`: el MISMO arnés, el MISMO recorrido,
// los MISMOS colaboradores reales. Lo único que cambia es que el almacén de la sesión está cableado y
// que el servidor manda el campo `sesion`. Si esto diera 2, la ola no borró nada.
describe("W3.4 · la sesión borra la SEGUNDA firma (AC-3-1)", () => {
  // MUTANTE QUE LO MATA: hacer que `peek()` devuelva siempre `null` (o que el gateway del depósito
  // ignore su resultado) ⇒ vuelve a firmarse 2 veces y esto se pone rojo.
  // ⛔ FALSO KILLED A EVITAR: `toHaveBeenCalled()` no sirve, tiene que ser el NÚMERO. Y el estado
  // terminal se assertea PRIMERO: un recorrido cortado antes del `prepare` también contaría 1, y
  // haría parecer que la ola funciona cuando lo que pasó es que el envío murió.
  it("T-372-W3-1: con el almacén cableado, el MISMO recorrido invoca `signMessage` EXACTAMENTE 1 vez", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "secreto-del-desafio");
    vi.stubEnv("PAYOUT_SESSION_SECRET", "secreto-de-la-sesion-distinto");
    expect(
      await entrarAlNavegadorDeLaBilletera(),
      "el árbol no llegó a `injected`: este `it` no está midiendo el recorrido inyectado",
    ).toBe("injected");
    sembrarElCaminoPorEnlace();
    const registro = registroVacio();
    vi.stubGlobal("fetch", servidorDeLaApp({ emisorReal: true, conSesion: true, registro }));

    const { firmados, estadoFinal, enlace } = await recorridoInyectado(new InMemorySesionStore(new FixedClock()));

    // 1 · EL RECORRIDO CERRÓ. Va primero, por el falso KILLED de arriba.
    expect(estadoFinal, "el envío no llegó a su estado terminal: no se ejercitó el recorrido entero").toBe(
      "payout_submitted",
    );
    // 2 · Y fue el camino INYECTADO, con el de enlace sembrado y aun así apagado. Idéntico a `-0a`.
    expect(enlace, "el recorrido salió del camino inyectado").toEqual(["no-corresponde", "no-corresponde"]);
    // 3 · UNA SOLA FIRMA. El número ES la afirmación, y el contraste con `T-372-W3-0a` (que mide 2 con
    //     el mismo arnés y sin almacén) es lo que dice que la sesión es lo que la borró.
    expect(
      firmados.length,
      "se siguen pidiendo DOS firmas de identidad: la sesión no está reemplazando a la segunda",
    ).toBe(1);
    // 4 · Y LA QUE QUEDA ES LA PRIMERA, la del connect: es un requisito (AC-3-5), no una concesión.
    expect(firmados[0], "la firma que quedó no es una prueba de posesión").toContain(
      "Chaski Proof-of-Possession",
    );
    // 5 · LA MITAD SIN LA CUAL EL CONTEO NO PRUEBA NADA: la sesión VIAJÓ en el cuerpo del `prepare`.
    //     Sin esto, un gateway que simplemente dejara de mandar credencial daría el mismo 1.
    expect(registro.prepares.length, "no hubo `prepare`: el recorrido no llegó al pago").toBe(1);
    const cuerpo = registro.prepares[0] ?? {};
    expect(cuerpo.sessionToken, "el `prepare` no llevó la sesión").toBeTypeOf("string");
    expect(
      Object.hasOwn(cuerpo, "popChallenge"),
      "viajaron las DOS credenciales: el gateway no está eligiendo, está mandando todo",
    ).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 7 · W3.4 — LA RECARGA SE LLEVA LA SESIÓN, Y ESO ES EL AC-3-5
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe("W3.4 · la sesión NO sobrevive a una recarga (AC-3-5)", () => {
  // MUTANTE QUE LO MATA: persistir la sesión en `localStorage` dentro de `InMemorySesionStore`
  // (escribirla en `record` y leerla en `peek`) ⇒ (a) el token aparece en el disco del navegador y
  // (b) el almacén NUEVO la encuentra. Las dos mitades se ponen rojas.
  // ⛔ FALSO KILLED A EVITAR: un `it` que sólo mirara el almacén no prueba el recorrido. Acá el árbol
  // se monta DOS veces y la segunda vuelta corre el recorrido entero otra vez.
  it("T-372-W3-8: tras una recarga (almacén nuevo), la PRIMERA firma se vuelve a pedir y la sesión no está en ningún disco", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "secreto-del-desafio");
    vi.stubEnv("PAYOUT_SESSION_SECRET", "secreto-de-la-sesion-distinto");

    // ── PRIMERA VISITA ────────────────────────────────────────────────────────────────────────────
    expect(await entrarAlNavegadorDeLaBilletera()).toBe("injected");
    sembrarElCaminoPorEnlace();
    const reg1 = registroVacio();
    vi.stubGlobal("fetch", servidorDeLaApp({ emisorReal: true, conSesion: true, registro: reg1 }));
    const antes = new InMemorySesionStore(new FixedClock());
    const v1 = await recorridoInyectado(antes);
    expect(v1.estadoFinal, "la primera visita no cerró: no hay sesión que perder").toBe("payout_submitted");
    expect(v1.firmados.length, "la primera visita no llegó a usar la sesión").toBe(1);

    // 🔴 (a) LA SESIÓN NO QUEDÓ EN NINGÚN DISCO DEL NAVEGADOR. Es la mitad que mata al mutante.
    const token = String((reg1.prepares[0] ?? {}).sessionToken ?? "");
    expect(token, "no viajó ninguna sesión: no hay nada que buscar en el disco").not.toBe("");
    expect(
      JSON.stringify({ ...window.localStorage }),
      "la sesión quedó escrita en `localStorage`: sobreviviría a la recarga y sería una credencial " +
        "al portador at-rest en el navegador",
    ).not.toContain(token);
    expect(JSON.stringify({ ...window.sessionStorage }), "la sesión quedó en `sessionStorage`").not.toContain(
      token,
    );
    expect(document.cookie, "la sesión quedó en una cookie").not.toContain(token);
    expect(window.location.href, "la sesión quedó en la URL").not.toContain(token);

    // ── LA RECARGA: árbol nuevo, almacén nuevo, y el recorrido entero otra vez ────────────────────
    cleanup();
    solanaWalletBridge.reset();
    quitarWalletInyectada();
    const despues = new InMemorySesionStore(new FixedClock());
    expect(
      despues.peek(FAKE_SOLANA_BENEFICIARY),
      "un almacén NUEVO encontró la sesión de la visita anterior: entonces sobrevive a la recarga y " +
        "la primera firma se saltearía",
    ).toBeNull();

    expect(await entrarAlNavegadorDeLaBilletera()).toBe("injected");
    sembrarElCaminoPorEnlace();
    const reg2 = registroVacio();
    vi.stubGlobal("fetch", servidorDeLaApp({ emisorReal: true, conSesion: true, registro: reg2 }));
    const v2 = await recorridoInyectado(despues);

    expect(v2.estadoFinal, "la segunda visita no cerró").toBe("payout_submitted");
    expect(
      v2.firmados.length,
      "tras la recarga no se volvió a pedir la PRIMERA firma: la sesión sobrevivió y AC-3-5 está roto",
    ).toBe(1);
    expect(v2.firmados[0], "lo que se volvió a firmar no es la prueba de posesión del connect").toContain(
      "Chaski Proof-of-Possession",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 8 · W3.5 — LA CUARTA FRASE DEL COPY ES VERDADERA, Y ACÁ ESTÁ SU TESTIGO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// 🔴 SIN ESTE `it`, LA FRASE 4 ES PROSA. El copy le dice a la persona: *"Si te la volvemos a pedir, es
// por lo mismo: confirmar que es tuya."* Eso es una afirmación falsable sobre TODA firma que la app le
// pida, y lo que la vuelve verdadera es que el único mensaje que se manda a firmar sea el que
// construye el constructor de mensajes de posesión.
//
// ⛔ EL `it` IMPORTA `buildSolanaPopMessage` Y `verifySolanaPopChallenge`: NO reescribe el mensaje a
// mano. Un `toContain("Chaski Proof-of-Possession")` con el literal escrito acá sería el guard
// leyéndose a sí mismo, y pasaría con cualquier mensaje que empezara igual y siguiera con un monto.
describe("W3.5 · toda firma que la app pide es una prueba de posesión (AC-3-6, frase 4)", () => {
  // MUTANTE QUE LO MATA: en `../infrastructure/auth/http-pop-signer.ts`, firmar un mensaje arbitrario
  // en vez del `popMessage` que el servidor emitió ⇒ la reconstrucción con el constructor real deja
  // de coincidir y esto se pone rojo.
  // ⛔ FALSO KILLED A EVITAR: comparar sólo el prefijo. Se compara el mensaje ENTERO, reconstruido
  // desde el challenge que el emisor REAL firmó.
  it("T-372-W3-10b: cada mensaje firmado es EXACTAMENTE el que construye `buildSolanaPopMessage`, y no lleva monto ni beneficiario", async () => {
    vi.stubEnv("PAYOUT_POP_SECRET", "secreto-del-desafio");
    expect(await entrarAlNavegadorDeLaBilletera()).toBe("injected");
    sembrarElCaminoPorEnlace();
    const registro = registroVacio();
    vi.stubGlobal("fetch", servidorDeLaApp({ emisorReal: true, registro }));

    // ⛔ SIN sesión: así se ejercitan las DOS firmas y la afirmación cubre las dos, no una.
    const { firmados, estadoFinal } = await recorridoInyectado();
    expect(estadoFinal, "el recorrido no cerró: no se ejercitaron todas las firmas").toBe("payout_submitted");
    expect(firmados.length, "no se midió ninguna firma: este `it` estaría vacío").toBe(2);
    expect(registro.desafios.length, "el emisor real no emitió los desafíos que el cliente firmó").toBe(2);

    // 🔴 LA AFIRMACIÓN: cada mensaje firmado se RECONSTRUYE con el constructor de producción a partir
    // del challenge que el emisor de producción firmó. Si el cliente firmara otra cosa, no coincide.
    const reconstruidos = registro.desafios.map((d) => {
      const ch = verifySolanaPopChallenge(d.popChallenge, Date.now());
      if (!ch) throw new Error("el emisor real produjo un challenge que su propio verificador rechaza");
      return buildSolanaPopMessage(ch);
    });
    expect(
      firmados,
      "la app mandó a firmar algo que NO es el mensaje de posesión que el servidor emitió: la frase " +
        '"si te la volvemos a pedir, es por lo mismo" sería falsa',
    ).toEqual(reconstruidos);

    // Y lo que esos mensajes NO contienen, que es la otra mitad de la frase: no mueven plata.
    for (const m of firmados) {
      expect(m, "el mensaje firmado lleva el monto del envío").not.toContain("400");
      expect(m, "el mensaje firmado lleva el destino del beneficiario").not.toContain("999888777");
      expect(m, "el mensaje firmado lleva el nombre del beneficiario").not.toContain("Mamá");
    }

    // CONTROL POSITIVO DEL INSTRUMENTO: la reconstrucción SABE distinguir. Si `buildSolanaPopMessage`
    // devolviera siempre lo mismo, la igualdad de arriba pasaría con cualquier par de firmas.
    expect(reconstruidos[0], "los dos desafíos produjeron el MISMO mensaje: el instrumento no distingue").not.toBe(
      reconstruidos[1],
    );
  });
});
