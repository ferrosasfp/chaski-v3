// WKH-075 · LA ESPERA A QUE LA DISPONIBILIDAD SEA DECIDIBLE — los `it` que NO necesitan render.
//
// 🔴 QUÉ MIDE ESTE ARCHIVO Y QUÉ MIDE `../../presentation/vuelta-por-enlace-carrera.test.tsx`. Acá
// está el módulo SOLO: el corte sin tick, el techo, la desuscripción, y los dos invariantes de
// AC-4/DT-3. Allá se monta el árbol REAL con los adapters reales y se mide el observable del defecto
// —que el selector de la librería NO esté en el DOM—. Un `it` de acá que montara un árbol estaría
// midiendo lo de allá otra vez, y encima en `node`.
//
// ⚠️ ESTE ARCHIVO CORRE EN `node` (el default de vitest en este repo; los 32 archivos que necesitan
// navegador declaran `// @vitest-environment jsdom` a mano). Por eso `T-075-TECHO` **lee**
// `solana-providers.tsx` con un regex en vez de importarlo: importarlo arrastraría React, el barrel de
// wallets que trae Ledger y una hoja `.css`, ninguno de los cuales resuelve acá.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { solanaWalletBridge } from "../solana-wallet-bridge";
import * as modulo from "./disponibilidad-decidible";
import { TECHO_DISPONIBILIDAD_MS, esperarDisponibilidadDecidible } from "./disponibilidad-decidible";

const ROOT = process.cwd();
const FUENTE = readFileSync(path.resolve(ROOT, "src/infrastructure/solana/disponibilidad-decidible.ts"), "utf8");
const UN_ARCHIVO_QUE_SI_LEE_ENV = readFileSync(path.resolve(ROOT, "src/presentation/wallet-availability.ts"), "utf8");

/** 🔴 EL OBSERVABLE DE LA DESUSCRIPCIÓN, y por qué es el privado del bridge y no un doble. El bridge
 *  es un **singleton que vive toda la sesión** (`../solana-wallet-bridge.ts:254`), así que un listener
 *  que sobrevive a su consumidor es un leak que ningún valor de retorno delata. `private` en TS es
 *  compile-time: en runtime el `Set` está ahí y se puede contar. ⛔ Y no se dobla el bridge: un doble
 *  mediría la desuscripción de un objeto que producción no usa. */
function listeners(): number {
  return (solanaWalletBridge as unknown as { availabilityListeners: Set<() => void> }).availabilityListeners.size;
}

afterEach(() => {
  vi.useRealTimers();
  solanaWalletBridge.reset(); // ⚠️ `reset()` vuelve la disponibilidad a "unknown", NUNCA a "none" (`:176`)
});

describe("T-075-3 · AC-3 · el techo vencido tiene una causa propia y ⛔ NO degrada a `none`", () => {
  it("con la disponibilidad en `unknown`, el techo vencido devuelve `sin-decidir` con la causa del enlace", async () => {
    solanaWalletBridge.reset();
    expect(solanaWalletBridge.getWalletAvailability(), "precondición: si esto no es `unknown` el `it` no está midiendo la carrera").toBe("unknown");
    const d = await esperarDisponibilidadDecidible(20);
    // ⛔ Lo que NO puede devolver: `{ estado: "decidida", valor: "none" }`. Un techo que degrada callado
    // es el mismo defecto una capa más abajo, y degradar acá reabre el camino inyectado.
    expect(d).toEqual({ estado: "sin-decidir", causa: "deeplink_disponibilidad_sin_resolver" });
  });

  // 🔴 CONTROL POSITIVO, en la MISMA corrida: sin él, un módulo que devolviera siempre `sin-decidir`
  // pasaría el `it` de arriba y el barrido no diría nada. Un cero uniforme acusa al instrumento.
  it("CONTROL POSITIVO · la MISMA llamada, con la disponibilidad ya decidida, devuelve `decidida`", async () => {
    solanaWalletBridge.reset();
    solanaWalletBridge.setWalletAvailability("none");
    expect(await esperarDisponibilidadDecidible(20)).toEqual({ estado: "decidida", valor: "none" });
  });

  it("T-075-3b · si la disponibilidad llega ANTES del techo, gana la suscripción y no se espera el techo", async () => {
    solanaWalletBridge.reset();
    const p = esperarDisponibilidadDecidible(5_000);
    expect(listeners(), "mientras espera tiene que haber UN listener; si es 0 esta prueba es vacua").toBe(1);
    solanaWalletBridge.setWalletAvailability("injected");
    expect(await p).toEqual({ estado: "decidida", valor: "injected" });
  });

  it("T-075-3c · se desuscribe SIEMPRE: gane la suscripción o gane el techo", async () => {
    solanaWalletBridge.reset();
    expect(listeners(), "el contador arranca en cero").toBe(0);
    const p1 = esperarDisponibilidadDecidible(5_000);
    expect(listeners(), "control positivo: mientras espera, el contador SUBE").toBe(1);
    solanaWalletBridge.setWalletAvailability("injected");
    await p1;
    expect(listeners(), "gana la suscripción ⇒ vuelve a cero").toBe(0);
    solanaWalletBridge.reset();
    const p2 = esperarDisponibilidadDecidible(20);
    expect(listeners(), "control positivo de la segunda mitad").toBe(1);
    await p2;
    expect(listeners(), "gana el TECHO ⇒ también vuelve a cero").toBe(0);
  });
});

describe("T-075-2 · AC-2 · con la disponibilidad YA decidida resuelve sin armar un solo timer", () => {
  // 🔴 ÉSTE ES EL CORTE QUE DEJA EL CAMINO INYECTADO Y LOS ~100 `it` SIN MARCA BYTE-IDÉNTICOS. No es
  // una optimización: sin él, toda pantalla que monta con la disponibilidad ya sabida pagaría un tick
  // y un timer que hoy no existen. El mutante que lo mata es hacer la espera incondicional.
  it("no arma techo ni se suscribe, y el MISMO instrumento da ≠ 0 con `unknown`", async () => {
    vi.useFakeTimers();
    solanaWalletBridge.reset();
    solanaWalletBridge.setWalletAvailability("injected");
    const p = esperarDisponibilidadDecidible();
    expect(vi.getTimerCount(), "con la disponibilidad decidida NO se arma techo").toBe(0);
    expect(listeners(), "con la disponibilidad decidida NO se suscribe").toBe(0);
    expect(await p).toEqual({ estado: "decidida", valor: "injected" });

    // 🔴 CONTROL POSITIVO EN LA MISMA CORRIDA (§2.5 / AH-4): los dos ceros de arriba sólo dicen
    // "no pasó" si el mismo instrumento sabe dar ≠ 0 en el caso que sí pasa.
    solanaWalletBridge.reset();
    const q = esperarDisponibilidadDecidible();
    expect(vi.getTimerCount(), "con `unknown` el MISMO contador de timers tiene que dar 1").toBe(1);
    expect(listeners(), "y el MISMO contador de listeners también").toBe(1);
    vi.advanceTimersByTime(TECHO_DISPONIBILIDAD_MS);
    expect(await q).toEqual({ estado: "sin-decidir", causa: "deeplink_disponibilidad_sin_resolver" });
  });
});

describe("T-075-4 · AC-4 · el módulo NO lee ninguna env y NO expone ninguna perilla", () => {
  const SONDAS = [/process\.env/, /import\.meta\.env/, /NEXT_PUBLIC_[A-Z_]+/];

  // ⛔ Sin este `it`, tres `not.toMatch` sobre un archivo mal leído pasarían siempre y el candado
  // dejaría de existir sin que nadie lo note. Es la trampa nº1 de `readme-test-count.test.ts:18-23`.
  it("CONTROL POSITIVO · las tres sondas discriminan, y el archivo se leyó de verdad", () => {
    const CON_LAS_TRES = 'process.env.X; import.meta.env.Y; NEXT_PUBLIC_ZZZ';
    for (const s of SONDAS) expect(CON_LAS_TRES, `la sonda ${s} no matchea ni el texto que la contiene`).toMatch(s);
    expect(UN_ARCHIVO_QUE_SI_LEE_ENV, "y en un archivo REAL del repo que sí lee env").toMatch(/process\.env/);
    expect(FUENTE, "el módulo se leyó de verdad, no vacío").toContain("esperarDisponibilidadDecidible");
  });

  it("el módulo de la espera no lee ninguna env", () => {
    // ⛔ Sería la TERCERA perilla de repliegue, y el repo declara dos y sólo dos (CD-3): la env
    // repliega el BUILD, «Cambiar de billetera» repliega el DISPOSITIVO.
    for (const s of SONDAS) expect(FUENTE, `el módulo de la espera lee env (${s})`).not.toMatch(s);
  });

  it("y su superficie exportada en runtime son exactamente DOS símbolos, ninguno una perilla", () => {
    // `Decidible` es un `type`: no existe en runtime, así que no aparece acá y eso es correcto.
    expect(Object.keys(modulo).sort()).toEqual(["TECHO_DISPONIBILIDAD_MS", "esperarDisponibilidadDecidible"]);
  });
});

describe("T-075-TECHO · DT-3 · el techo tiene que superar la gracia de la disponibilidad", () => {
  // ⛔ NO SE COMPARA CONSIGO MISMO (CD-6): son DOS constantes distintas, de DOS archivos distintos, y
  // este `it` se pone rojo el día que alguien suba la gracia por encima del techo. ⛔ Y no se
  // reemplaza el regex por un `1500` escrito a mano: eso lo convertiría en el candado podrido que
  // `solana-providers.tsx:78-83` prohíbe por escrito.
  it("gracia < TECHO_DISPONIBILIDAD_MS <= 2× gracia, leyendo las DOS constantes reales", () => {
    const GRACIA_SRC = readFileSync(path.resolve(ROOT, "src/presentation/solana/solana-providers.tsx"), "utf8");
    const m = GRACIA_SRC.match(/^export const WALLET_GRACE_MS = (\d+);$/m);
    // 🔴 CONTROL POSITIVO PRIMERO: un regex que dejó de matchear da `null` y las comparaciones de
    // abajo serían vacuas.
    expect(m, "el regex no encontró WALLET_GRACE_MS: el barrido está mirando otra cosa").not.toBeNull();
    const gracia = Number(m?.[1]);
    expect(Number.isFinite(gracia), "la gracia no salió como número").toBe(true);
    expect(gracia).toBeGreaterThan(0);
    expect(
      TECHO_DISPONIBILIDAD_MS,
      "el techo dejó de superar a la gracia: la espera cortaría ANTES de que el efecto de la gracia escriba `none`, y el defecto vuelve",
    ).toBeGreaterThan(gracia);
    // 🔴 Y EL OTRO LADO, QUE FALTABA (fix-pack · AR/MNR-2). Con sólo `> gracia`, `TECHO = 3_000_000`
    // dejaba la suite entera en verde: **un techo de 50 minutos no es un techo**, es la misma pantalla
    // colgada que esta HU vino a cerrar, con un número puesto. El límite superior se DERIVA de la misma
    // constante real y ⛔ no se escribe `3000` a mano: el docblock del módulo declara «3000 = 2× la
    // gracia», así que ése es el invariante, y si alguien quiere más techo tiene que cambiar los dos.
    expect(
      TECHO_DISPONIBILIDAD_MS,
      "el techo se fue por encima de 2× la gracia: dejó de ser un techo y pasó a ser una espera que la persona no puede distinguir de una pantalla colgada",
    ).toBeLessThanOrEqual(2 * gracia);
  });
});
