// @vitest-environment jsdom
// HU-075/diagnóstico — LOS CANDADOS DEL BLOQUE DE DIAGNÓSTICO.
//
// 🔴 QUÉ TIENE QUE PROBAR ESTE ARCHIVO, Y EN QUÉ ORDEN DE IMPORTANCIA. El entregable es una captura de
// pantalla que se le pide a una persona en producción, así que las tres propiedades que un fallo haría
// caro no son las del render: son las de lo que el bloque **no** hace.
//
//   1. ⛔ NO FILTRA SECRETOS (`T-DIAG-SECRETOS`). El fixture le siembra al disco un viaje con los CINCO
//      campos sensibles poblados con valores reconocibles y exige que ninguno llegue al DOM.
//   2. ⛔ SIN EL PARÁMETRO NO EXISTE (`T-DIAG-APAGADO`). Cero DOM **y cero lecturas de disco**: la
//      segunda mitad es la que hace que «no cambia el comportamiento» sea una medición y no una frase.
//   3. ⛔ NO TOCA EL RECORRIDO (`T-DIAG-OBSERVADOR`). Ni una escritura de disco, y la marca sigue en la
//      barra después de renderizar: un observador que consume la marca **quema el paso** del
//      consumidor real, que es el defecto contra el que
//      (`completarVuelta`, `../infrastructure/solana/deeplink/conexion.ts:254`) está escrita.
//
// ⚠️ LO QUE ESTE ARCHIVO **NO** MIDE, dicho antes de que alguien se apoye en su verde:
//   · Corre en **jsdom**. El runner de tests no es el runtime real, y en particular el
//     `localStorage` de jsdom no reproduce las particiones de almacenamiento de un navegador móvil,
//     que es justamente la hipótesis que el bloque existe para poder distinguir en el teléfono.
//   · ⛔ NO mide que el bloque diga la VERDAD sobre un teléfono. Mide que dice lo que el disco, el
//     bridge y la barra tienen en ese instante. Que eso alcance para diagnosticar lo decide la captura.
//   · El campo `disponibilidad` se ejercita con el bridge REAL, pero el instante de la decisión lo
//     empuja el test: acá no hay carrera de arranque (eso lo mide `vuelta-por-enlace-carrera.test.tsx`).
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import bs58 from "bs58";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { enlaceDeVuelta } from "../infrastructure/solana/deeplink/sesion";
import { hrefSinRastroDeVuelta } from "../infrastructure/solana/deeplink/conexion";
import { RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { FakeWallet, InMemoryRepo, RecorridoPorEnlaceNulo, T0, beneficiary } from "../test-support/fakes";
import { Remittance } from "../domain/remittance";
import { Money } from "../domain/money";
import { anotarCorteDeVuelta, anotarHito, leerHito, olvidarCorteDeVuelta, olvidarHitos, ultimoCorteDeVuelta } from "./bitacora-de-vuelta";
import { MAX_EDAD_MS } from "../infrastructure/solana/deeplink/sesion";
import { MARCA_POP_KYC, MARCA_POP_PAYOUT } from "../infrastructure/solana/deeplink/pop-por-enlace";
import { KEY as CLAVE_DEL_REPO } from "../infrastructure/persistence";
import {
  DiagnosticoDeVuelta,
  PARAM_DIAG,
  REFRESCO_MS,
  VALOR_DIAG,
  diagnosticoPedido,
  duracion,
  enmascarar,
  estadoEnElRepo,
  presenciaEnElDisco,
  renglonDeLaRemesa,
  renglonDelPaso,
  renglonDelPop,
  retratoDelPop,
} from "./diagnostico-de-vuelta";

// Mismo doble cerrado que `flow-reanudacion.test.tsx`: jsdom no implementa `requestAnimationFrame`, así
// que sin esto el exit de `AnimatePresence` no completa y los pasos de la pantalla nunca montan.
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

/** Los CINCO campos que ⛔ no pueden salir nunca, con valores que sólo pueden venir de acá. Se
 *  escriben como literales del test —y no importados del `Viaje`— a propósito: si el fixture los
 *  derivara del mismo sitio del que los deriva el componente, un cambio de nombre los sacaría a los
 *  dos a la vez y el candado quedaría vigilando el vacío. */
const SECRETOS = {
  secreta: "SECRETA-QUE-NO-PUEDE-SALIR-11111111111111111",
  session: "SESSION-QUE-NO-PUEDE-SALIR-2222222222222222",
  claveBilletera: "CLAVEBILLETERA-QUE-NO-PUEDE-SALIR-3333333333",
  transaccionFirmada: "TXFIRMADA-QUE-NO-PUEDE-SALIR-44444444444444",
  firmaDePatrocinio: "FIRMAPATROCINIO-QUE-NO-PUEDE-SALIR-555555555",
} as const;

/** ⛔ NO PUEDEN SALIR NUNCA, y son los del ancla del PoP: uno es la prueba de posesión FIRMADA y el
 *  otro el desafío que la autentica. Valores que sólo pueden venir de acá, por el mismo motivo que
 *  `SECRETOS`: derivarlos del sitio del que los deriva el componente dejaría el candado vigilando el
 *  vacío el día que uno de los dos se renombre. */
const FIRMA_QUE_NO_PUEDE_SALIR = "FIRMAPOP-QUE-NO-PUEDE-SALIR-666666666666666";
const DESAFIO_QUE_NO_PUEDE_SALIR = "DESAFIOPOP-QUE-NO-PUEDE-SALIR-7777777777777";

/** La PII que el blob del repo lleva de verdad: beneficiario, CCI y apellido. ⛔ El bloque lee DOS
 *  campos de ese blob (`id` y `status`) y este fixture es el que lo hace medible. */
const PII_DEL_REPO = {
  beneficiario: "BENEFICIARIO-QUE-NO-PUEDE-SALIR-8888888",
  cci: "00212345678901234567",
  apellido: "APELLIDO-QUE-NO-PUEDE-SALIR-999999999",
} as const;

/** Un id con la forma REAL —un UUID— y no `"rem-1"`: `enmascarar` tiene un piso de 12 caracteres, así
 *  que un id corto saldría «(inesperado, N chars)» y la captura de este archivo no se parecería a la
 *  del teléfono, que es lo único que hace útil al `it` de la captura. */
const REM_UUID = "8f3a2c11-0000-4000-8000-00000000c21b";

/** El blob del repo, escrito A MANO con la forma que `LocalRepo` persiste. ⛔ No se construye con
 *  `LocalRepo` a propósito: un fixture que use el mismo escritor que el lector deja de poder
 *  contradecirlo. */
function blobDelRepo(id: string, status: string): string {
  return JSON.stringify([
    {
      id,
      status,
      createdAt: "2026-01-01T00:00:00.000Z",
      ownerAddress: DIRECCION,
      version: 1,
      beneficiary: {
        name: PII_DEL_REPO.beneficiario,
        country: "PE",
        method: "bank_cci",
        destination: PII_DEL_REPO.cci,
      },
      kyc: { identity: { lastNamePaternal: PII_DEL_REPO.apellido, documentNumberLast4: "5678" } },
    },
  ]);
}

/** El doble que hace recorrer a la pantalla REAL el camino de la vuelta hasta `onConnect`. ⛔ Extiende
 *  el nulo en vez de implementar el puerto entero: lo que no se sobrescribe TIRA, así que un camino
 *  que este `it` no previó se ve en vez de pasar por un desenlace inventado. */
class RecorridoQueConecta extends RecorridoPorEnlaceNulo {
  override remesaEnCurso(): string | null {
    return "rem-1";
  }
  override async completar(): Promise<never> {
    return { estado: "conectado", direccion: DIRECCION } as never;
  }
  override async estadoDeLaCuentaDeNonce(): Promise<never> {
    return "existe" as never;
  }
}

/** Monta la pantalla REAL en el estado EXACTO de una vuelta del salto `conectar` y espera a que el
 *  productor de montaje termine. ⛔ No dobla `alConectar` ni `onConnect`: lo que se mide es el
 *  cableado, y un doble ahí lo escondería. */
async function montarLaVuelta(repo: InMemoryRepo): Promise<void> {
  barra("?dl=conectar");
  solanaWalletBridge.setWalletAvailability("none"); // la espera de la disponibilidad resuelve sin tick
  vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
  const c = buildTestContainer({ repo, wallet: new FakeWallet(), recorridoPorEnlace: new RecorridoQueConecta() });
  await act(async () => {
    render(<RemittanceFlow container={c} />);
  });
  await waitFor(() => expect(leerHito("continuacion"), "`onConnect` no anotó nada: el cableado se cortó antes").not.toBeNull());
}

function viajeCompleto(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    billetera: "phantom",
    secreta: SECRETOS.secreta,
    publica: bs58.encode(new Uint8Array(32)),
    claveBilletera: SECRETOS.claveBilletera,
    session: SECRETOS.session,
    direccion: DIRECCION,
    paso: "conectar",
    remittanceId: "rem-1",
    pasosConsumidos: ["conectar"],
    transaccionFirmada: SECRETOS.transaccionFirmada,
    firmaDePatrocinio: SECRETOS.firmaDePatrocinio,
    desde: Date.now(),
    ...extra,
  });
}

/** Pone la barra en el estado que el bloque va a leer en su PRIMER render. ⛔ `replaceState` y no una
 *  navegación: jsdom no navega, y lo que el componente lee es `window.location.href`. */
function barra(query: string): void {
  window.history.replaceState(null, "", `/${query}`);
}

/** La URL de la vuelta tal como llega del teléfono: el parámetro del bloque + la marca del paso. */
const VUELTA_CON_DIAG = `?${PARAM_DIAG}=${VALOR_DIAG}&dl=conectar`;

beforeEach(() => {
  window.localStorage.clear();
  olvidarCorteDeVuelta();
  olvidarHitos(); // ⛔ los hitos son estado de MÓDULO: sin esto un `it` lee el desenlace del anterior
  solanaWalletBridge.reset();
  vi.unstubAllEnvs();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  barra("");
});

/** El texto entero del bloque, o `null` si no se pintó. */
function textoDelBloque(): string | null {
  return document.querySelector('[data-diag="bloque"]')?.textContent ?? null;
}

describe("el bloque de diagnóstico de la vuelta por enlace", () => {
  // ── 1 · APAGADO ────────────────────────────────────────────────────────────────────────────────
  //
  // 🔴 LAS DOS MITADES HACEN FALTA Y NO SON LA MISMA. Un `innerHTML === ""` solo probaría que no se
  // PINTA; el espía sobre `getItem` es lo que prueba que tampoco se EJECUTA. La condición para
  // desplegar esto un domingo es la segunda, no la primera.
  it("T-DIAG-APAGADO: sin el parámetro no pinta nada y NO lee el disco", () => {
    barra("");
    window.localStorage.setItem("chaski.billetera.viaje.v1", viajeCompleto());
    const espia = vi.spyOn(Storage.prototype, "getItem");
    const { container } = render(<DiagnosticoDeVuelta />);
    expect(container.innerHTML, "el bloque pintó algo sin que nadie lo pidiera").toBe("");
    expect(espia, "leyó el disco sin el parámetro puesto").not.toHaveBeenCalled();
  });

  // 🔴 LA TERCERA MITAD DE «NO CAMBIA EL COMPORTAMIENTO», Y LA QUE NO SE VE EN EL DOM. Un componente
  // que pinta `null` pero se suscribe al bridge le agrega un oyente a CADA carga de página de CADA
  // persona, y cada cambio de disponibilidad le dispara un `setState`. Es barato, y aun así es un
  // comportamiento. Acá se mide que no hay ninguno.
  it("T-DIAG-APAGADO-3: sin el parámetro NO registra un solo oyente", () => {
    barra("");
    const espia = vi.spyOn(solanaWalletBridge, "subscribeWalletAvailability");
    render(<DiagnosticoDeVuelta />);
    expect(espia, "se suscribió al bridge sin que nadie pidiera el bloque").not.toHaveBeenCalled();
    // CALIBRACIÓN, en el mismo `it`: CON el parámetro sí se suscribe. Sin esta mitad, un componente
    // que no se suscribiera NUNCA —o un espía puesto sobre el objeto equivocado— dejaría el `it` en
    // verde para siempre y este candado sería el que se lee a sí mismo.
    cleanup();
    espia.mockClear();
    barra(VUELTA_CON_DIAG);
    render(<DiagnosticoDeVuelta />);
    expect(espia, "CALIBRACIÓN: con el parámetro puesto tampoco se suscribe ⇒ el espía no mide nada").toHaveBeenCalled();
  });

  it("T-DIAG-APAGADO-2: un valor que no es el exacto tampoco lo prende", () => {
    for (const q of [`?${PARAM_DIAG}`, `?${PARAM_DIAG}=`, `?${PARAM_DIAG}=0`, `?${PARAM_DIAG}=true`, `?${PARAM_DIAG}=11`]) {
      expect(diagnosticoPedido(`https://chaski.test/${q}`), `\`${q}\` prendió el bloque`).toBe(false);
    }
    expect(diagnosticoPedido(`https://chaski.test/?${PARAM_DIAG}=${VALOR_DIAG}`)).toBe(true);
    expect(diagnosticoPedido("no-es-una-url"), "un href que no parsea no puede pedir nada").toBe(false);
  });

  // ── 2 · SECRETOS ───────────────────────────────────────────────────────────────────────────────
  //
  // 🔴 EL FIXTURE ES POSITIVO Y REPRODUCE EL DEFECTO: el viaje que se siembra TIENE los cinco campos
  // poblados, así que un bloque que imprimiera el crudo del disco los sacaría y este `it` se pondría
  // rojo. Un fixture con el viaje vacío daría verde para siempre sin medir nada, que es el modo en que
  // un control de este tipo queda decorativo.
  it("T-DIAG-SECRETOS: ninguno de los cinco campos sensibles del viaje llega al DOM", () => {
    barra(VUELTA_CON_DIAG);
    window.localStorage.setItem("chaski.billetera.viaje.v1", viajeCompleto());
    render(<DiagnosticoDeVuelta />);
    const texto = textoDelBloque();
    expect(texto, "el bloque no se pintó: sin DOM este `it` pasaría por vacío").not.toBeNull();
    for (const [campo, valor] of Object.entries(SECRETOS)) {
      expect(texto, `el campo \`${campo}\` del viaje llegó al DOM`).not.toContain(valor);
    }
    // Y el DOCUMENTO entero, no sólo el bloque: un `title`, un `data-` o un comentario también filtran.
    for (const [campo, valor] of Object.entries(SECRETOS)) {
      expect(document.body.innerHTML, `\`${campo}\` apareció fuera del bloque`).not.toContain(valor);
    }
  });

  it("T-DIAG-SECRETOS-2: la dirección va enmascarada, nunca entera", () => {
    barra(VUELTA_CON_DIAG);
    window.localStorage.setItem("chaski.billetera.viaje.v1", viajeCompleto());
    render(<DiagnosticoDeVuelta />);
    const texto = textoDelBloque() ?? "";
    expect(texto, "la dirección salió entera").not.toContain(DIRECCION);
    expect(texto).toContain(`${DIRECCION.slice(0, 6)}…${DIRECCION.slice(-4)}`);
  });

  it("T-DIAG-MASCARA: una dirección corta NO se enmascara, se declara inesperada", () => {
    // Sin este piso los dos `slice` se SOLAPAN y el «enmascarado» devolvería el valor entero: con
    // `"abcdefgh"` (8), `slice(0,6)` + `slice(-4)` da `abcdef` + `efgh`, o sea todo el valor.
    expect(enmascarar("abcdefgh")).toBe("(inesperado, 8 chars)");
    expect(enmascarar("abcdefgh")).not.toContain("abcdefgh");
    expect(enmascarar(DIRECCION)).toBe(`${DIRECCION.slice(0, 6)}…${DIRECCION.slice(-4)}`);
  });

  // ── 3 · OBSERVADOR ─────────────────────────────────────────────────────────────────────────────
  it("T-DIAG-OBSERVADOR: no escribe ni borra el disco, y deja la marca en la barra", () => {
    barra(VUELTA_CON_DIAG);
    // Un viaje de BASURA y un ancla de nonce VENCIDA: los dos casos en los que los lectores del
    // módulo (`leerViaje`, `leerPasoDelNonce`) LIMPIAN. Si este bloque los usara, este `it` moriría.
    window.localStorage.setItem("chaski.billetera.viaje.v1", "{no soy json");
    window.localStorage.setItem(
      "chaski.billetera.nonce.v1",
      JSON.stringify({ mensajeBase64: "x", desde: Date.now() - 60 * 60 * 1000 }),
    );
    const escribir = vi.spyOn(Storage.prototype, "setItem");
    const borrar = vi.spyOn(Storage.prototype, "removeItem");
    render(<DiagnosticoDeVuelta />);
    expect(textoDelBloque(), "el bloque no se pintó: el resto de este `it` pasaría por vacío").not.toBeNull();
    expect(escribir, "el observador escribió el disco").not.toHaveBeenCalled();
    expect(borrar, "el observador borró una clave del recorrido").not.toHaveBeenCalled();
    expect(window.localStorage.getItem("chaski.billetera.viaje.v1"), "se llevó puesto el viaje").toBe("{no soy json");
    expect(window.localStorage.getItem("chaski.billetera.nonce.v1"), "se llevó puesta el ancla del nonce").not.toBeNull();
    // La marca sigue en la barra: nadie la consumió, así que el consumidor real todavía la puede leer.
    expect(new URL(window.location.href).searchParams.get("dl")).toBe("conectar");
  });

  // ── 4 · LO QUE EL BLOQUE DICE ──────────────────────────────────────────────────────────────────
  it("T-DIAG-DISCO: informa la presencia de las cinco claves, y el par que separa las dos hipótesis", () => {
    barra(VUELTA_CON_DIAG);
    // El caso de campo: viaje ausente, elección PRESENTE. Es «el viaje murió en un disco que sí es
    // nuestro», que pide un arreglo distinto de «este navegador nunca vio nada».
    window.localStorage.setItem("chaski.billetera.eleccion.v1", "phantom");
    render(<DiagnosticoDeVuelta />);
    expect(textoDelBloque()).toContain("viaje=no eleccion=sí pop=no");
  });

  it("T-DIAG-DISCO-2: `presenciaEnElDisco` distingue «no hay» de «no se pudo preguntar»", () => {
    const vacio = presenciaEnElDisco(() => null, Date.now());
    expect(vacio.ilegible).toBe(false);
    expect(vacio.viaje).toBe(false);
    const roto = presenciaEnElDisco(() => {
      throw new Error("SecurityError");
    }, Date.now());
    expect(roto.ilegible, "un disco que no se deja leer se reportó como disco vacío").toBe(true);
  });

  it("T-DIAG-MARCA: informa la marca que la barra traía AL MONTAR", () => {
    barra(VUELTA_CON_DIAG);
    render(<DiagnosticoDeVuelta />);
    expect(textoDelBloque()).toContain("marca al montar : conectar");
  });

  // 🔴 ÉSTA ES LA PROPIEDAD QUE HACE ÚTIL AL CAMPO, y no se ve en los dos `it` de arriba: el paso 2 del
  // productor de montaje ((`limpiarLaBarra`, `./flow.tsx:4023`)) BORRA la marca de la barra con
  // `replaceState`. Un bloque que leyera el href tarde diría «sin marca» en TODAS las vueltas, incluidas
  // las que sí funcionaron, y el campo sería ruido con forma de dato. Acá se limpia la barra DESPUÉS de
  // montar y se exige que la marca siga informada.
  it("T-DIAG-MARCA-3: la marca queda congelada del primer render, aunque después se limpie la barra", async () => {
    barra(VUELTA_CON_DIAG);
    render(<DiagnosticoDeVuelta />);
    await act(async () => {
      barra(`?${PARAM_DIAG}=${VALOR_DIAG}`); // lo que hace `limpiarLaBarra`: se lleva el `dl`, deja el resto
      solanaWalletBridge.setWalletAvailability("none"); // fuerza un re-render, que es cuando se releería
    });
    expect(new URL(window.location.href).searchParams.get("dl"), "precondición: la barra quedó limpia").toBeNull();
    expect(
      textoDelBloque(),
      "el bloque releyó la barra: con la marca ya borrada, este campo diría «sin marca» siempre",
    ).toContain("marca al montar : conectar");
  });

  it("T-DIAG-MARCA-2: sin marca lo dice, y no inventa una", () => {
    barra(`?${PARAM_DIAG}=${VALOR_DIAG}`);
    render(<DiagnosticoDeVuelta />);
    expect(textoDelBloque()).toContain("marca al montar : sin marca");
  });

  // 🔴 ÉSTE ES EL CAMPO QUE MIDE EL ARREGLO ANTERIOR EN EL APARATO DE LA PERSONA. Arranca en
  // `"unknown"` —como arranca un navegador de verdad— y el `it` empuja la transición.
  it("T-DIAG-DISPONIBILIDAD: pasa de «todavía sin decidir» a la decisión, en vivo", async () => {
    barra(`?${PARAM_DIAG}=${VALOR_DIAG}`);
    render(<DiagnosticoDeVuelta />);
    expect(textoDelBloque()).toContain("unknown · todavía sin decidir");
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });
    const texto = textoDelBloque() ?? "";
    expect(texto, "la transición no se vio: el bloque congeló la foto del primer cuadro").toContain("none · ");
    expect(texto).not.toContain("todavía sin decidir");
  });

  // ── 5 · LA CAUSA CRUDA, EN VIVO ────────────────────────────────────────────────────────────────
  //
  // 🔴 «sin corte» ES UNA MEDICIÓN, NO UN ADORNO: es lo que convierte «no me apareció ningún error» de
  // reporte humano en dato, y lo que separa un corte que nadie leyó del retorno MUDO de
  // (`remId`, `./flow.tsx:4010`).
  it("T-DIAG-CORTE: arranca en «sin corte» y se actualiza cuando el recorrido corta", async () => {
    barra(VUELTA_CON_DIAG);
    render(<DiagnosticoDeVuelta />);
    expect(textoDelBloque()).toContain("corte           : sin corte");
    await act(async () => {
      anotarCorteDeVuelta("deeplink_viaje_vencido");
    });
    expect(
      textoDelBloque(),
      "el bloque no se enteró del corte: la suscripción de la bitácora no avisa",
    ).toContain("corte           : deeplink_viaje_vencido");
  });

  it("T-DIAG-CORTE-2: la causa se muestra CRUDA, no traducida a copy", () => {
    // El banner de la pantalla muestra `humanError(causa)`, que para una causa sin copy propio cae en
    // un default y BORRA la única pista. Acá tiene que salir la etiqueta del dominio, tal cual.
    anotarCorteDeVuelta("una_causa_sin_copy_propio");
    barra(VUELTA_CON_DIAG);
    render(<DiagnosticoDeVuelta />);
    expect(textoDelBloque()).toContain("una_causa_sin_copy_propio");
  });

  // ── 6 · EL VIAJE REDONDO DE LA URL ─────────────────────────────────────────────────────────────
  //
  // 🔴 SIN ESTA PROPIEDAD EL BLOQUE NO SIRVE PARA NADA, y no es una suposición sobre la billetera: son
  // DOS funciones NUESTRAS las que podrían comerse el parámetro, y las dos se ejercitan acá de verdad.
  it("T-DIAG-VIAJE-REDONDO: el parámetro sobrevive al `redirect_link` y a la limpieza de la barra", () => {
    const origen = `https://chaski.test/enviar?${PARAM_DIAG}=${VALOR_DIAG}`;
    const irYVolver = enlaceDeVuelta(origen, "conectar");
    expect(new URL(irYVolver).searchParams.get(PARAM_DIAG), "el `redirect_link` se comió el parámetro").toBe(VALOR_DIAG);
    expect(new URL(irYVolver).searchParams.get("dl")).toBe("conectar");
    // Y la vuelta, con la respuesta de la billetera colgada, después de que el productor limpia:
    const vuelta = `${irYVolver}&nonce=n&data=d&phantom_encryption_public_key=k`;
    const limpio = hrefSinRastroDeVuelta(vuelta);
    expect(new URL(limpio).searchParams.get(PARAM_DIAG), "la limpieza de la barra se comió el parámetro").toBe(VALOR_DIAG);
    expect(new URL(limpio).searchParams.get("dl"), "la limpieza tiene que sacar la marca").toBeNull();
  });

  // ── 7 · ALGUIEN LO INVOCA ──────────────────────────────────────────────────────────────────────
  //
  // 🔴 UN ARTEFACTO SIN LLAMADOR NO ES UNA DEFENSA, y acá el llamador **no se puede ejercitar**: ⛔
  // `app/page.tsx` importa por el alias `@/`, y este repo NO TIENE `vitest.config.*`, así que vitest
  // no lo resuelve y un `await import("../../app/page")` muere en «Failed to resolve import». MEDIDO,
  // no supuesto: fue la primera forma de este `it` y ése fue su error. ⇒ Se mide el FUENTE.
  //
  // ⚠️ QUÉ PIERDE ESTA FORMA, dicho para que nadie le pida lo que no da: no ejecuta la página, así que
  // no puede afirmar que el bloque se RENDERICE. Afirma que está cableado.
  // ✅ Y QUÉ SÍ ATA, que es lo que lo hace algo más que un `grep` de un literal: el nombre NO se
  // escribe acá, se deriva del símbolo importado (`DiagnosticoDeVuelta.name`), así que renombrar el
  // componente y olvidarse de la página pone esto rojo. Y los comentarios se sacan ANTES de buscar,
  // que es lo que impide que comentar el elemento pase por cableado.
  it("T-DIAG-CABLEADO: `app/page.tsx` importa y monta el bloque, fuera de todo comentario", () => {
    const fuente = readFileSync(path.resolve(__dirname, "..", "..", "app", "page.tsx"), "utf8");
    const sinComentarios = fuente
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // los `{/* … */}` del JSX
      .replace(/\/\*[\s\S]*?\*\//g, "") //               los bloques `/* … */`
      .replace(/^[ \t]*\/\/.*$/gm, ""); //                  las líneas `//`
    const nombre = DiagnosticoDeVuelta.name;
    expect(nombre, "el componente perdió su nombre y este `it` quedaría midiendo la cadena vacía").toBe(
      "DiagnosticoDeVuelta",
    );
    expect(sinComentarios, "`app/page.tsx` no importa el bloque").toContain(
      `import { ${nombre} } from "@/presentation/diagnostico-de-vuelta"`,
    );
    expect(
      new RegExp(`<${nombre}\\s*/>`).test(sinComentarios),
      "`app/page.tsx` no monta el bloque fuera de un comentario",
    ).toBe(true);
    // CALIBRACIÓN: el mismo aparato sobre un fuente donde el elemento está COMENTADO tiene que decir
    // que no está. Sin esto, un bug en el borrado de comentarios dejaría este `it` verde para siempre.
    const comentado = fuente.replace(`<${nombre} />`, `{/* <${nombre} /> */}`);
    const comentadoSinComentarios = comentado
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(
      new RegExp(`<${nombre}\\s*/>`).test(comentadoSinComentarios),
      "CALIBRACIÓN: el borrado de comentarios no ve un elemento comentado ⇒ este `it` no puede fallar",
    ).toBe(false);
  });

  // ── 7-bis · LA HIDRATACIÓN ─────────────────────────────────────────────────────────────────────
  //
  // 🔴 ESTE `it` EXISTE PORQUE UN MUTANTE SOBREVIVIÓ. Borrarle el `!montado` al gate del render dejaba
  // los 20 `it` de este archivo en VERDE: `render()` de Testing Library monta en el cliente y no tiene
  // pasada de servidor, así que ninguno podía ver la diferencia. Y lo que `montado` sostiene no es
  // cosmético: SIN él, el servidor pinta `""` —ahí `typeof window === "undefined"`— y el PRIMER render
  // del cliente pinta el bloque, o sea un **error de hidratación en cada carga con el parámetro**.
  //
  // ⇒ El aparato es una pasada de `renderToString` + `hydrateRoot` sobre su salida, y el observable es
  // lo que React reporta. ⛔ No se mide el DOM final: con o sin el gate el DOM final es el mismo, y ése
  // es exactamente el motivo por el que el mutante sobrevivía.
  it("T-DIAG-HIDRATACION: el HTML del servidor y el primer render del cliente coinciden", async () => {
    barra(VUELTA_CON_DIAG);
    window.localStorage.setItem("chaski.billetera.eleccion.v1", "phantom");
    // 1 · La pasada de SERVIDOR. `renderToString` no corre efectos, así que lo que sale es lo que el
    //     navegador recibe en el HTML.
    const delServidor = renderToString(<DiagnosticoDeVuelta />);
    // ⚠️ QUÉ ES LO QUE ESTA LÍNEA MIDE ACÁ, Y NO ES LO QUE PARECE. En producción hay DOS cosas que
    // hacen `""` en el servidor: el `typeof window === "undefined"` y el `!montado`. En **jsdom**
    // `window` EXISTE incluso bajo `renderToString`, así que la primera no aplica y lo único que
    // sostiene este `expect` es `montado`. ⇒ Es justamente el aparato que hacía falta: el mutante que
    // le saca el `!montado` al gate SOBREVIVÍA a los 20 `it` anteriores y muere acá.
    // ⛔ Y ACÁ IBA UNA AFIRMACIÓN QUE MEDÍ Y ES FALSA, que se deja escrita porque la corrección vale
    // más que la frase: decía que la otra mitad (el `typeof window`) «la ejercita `npm run build`,
    // que prerenderiza `/` en Node: sin el guard el build muere con `window is not defined`». Lo
    // corrí. **El mutante que le saca el `typeof window` deja el build en `exit=0`.** El motivo lo
    // explica el HTML prerenderizado: `.next/server/app/index.html` NO contiene ni `data-diag`, ni
    // «Empezar un envío», ni «Conectá tu wallet» — ⇒ el subárbol entero de la app **no se renderiza
    // en el servidor**, porque `Providers` monta `SolanaProviders` con `next/dynamic({ssr:false})`
    // (`../presentation/providers.tsx:6`) y eso saltea a sus hijos en la pasada de SSR.
    // ⇒ CONSECUENCIA HONESTA: hoy ni el `typeof window` ni el `montado` tienen su caso disparador en
    // el árbol real; son defensas contra que esa composición cambie. Este `it` es el único lugar que
    // ejercita `montado`, y el `typeof window` **no lo mide nadie**. Queda declarado, no afirmado.
    expect(delServidor, "el primer render pintó el bloque antes de que corriera ningún efecto").toBe("");
    // 2 · La HIDRATACIÓN sobre ese HTML. React 19 reporta el desajuste por `console.error`.
    const anfitrion = document.createElement("div");
    anfitrion.innerHTML = delServidor;
    document.body.appendChild(anfitrion);
    const quejas: string[] = [];
    const consola = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      quejas.push(a.map(String).join(" "));
    });
    let raiz: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      raiz = hydrateRoot(anfitrion, <DiagnosticoDeVuelta />);
    });
    // CALIBRACIÓN, en el mismo `it`: el aparato TIENE que poder ver una queja. Sin esta mitad, un
    // `console.error` que React ya no emitiera dejaría el `it` verde para siempre.
    const antesDeCalibrar = quejas.length;
    console.error("CALIBRACIÓN: el espía de la consola está puesto");
    expect(quejas.length, "el espía de `console.error` no captura nada ⇒ este `it` no puede fallar").toBe(
      antesDeCalibrar + 1,
    );
    consola.mockRestore();
    const desajustes = quejas.filter((q) => /hydrat/i.test(q));
    expect(desajustes, `React reportó un desajuste de hidratación: ${desajustes[0] ?? ""}`).toEqual([]);
    // Y después de los efectos el bloque SÍ está: el gate aplaza, no borra.
    expect(anfitrion.querySelector('[data-diag="bloque"]'), "el bloque nunca apareció tras hidratar").not.toBeNull();
    await act(async () => {
      (raiz as unknown as { unmount: () => void }).unmount();
    });
    anfitrion.remove();
  });

  // ── 8 · LA PANTALLA COMPLETA, COMO LA VA A VER LA PERSONA ──────────────────────────────────────
  it("T-DIAG-BANDERA: con la bandera del enlace apagada, el bloque lo dice", () => {
    barra(VUELTA_CON_DIAG);
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "");
    render(<DiagnosticoDeVuelta />);
    expect(textoDelBloque()).toContain("enlace          : off");
  });

  it("T-DIAG-VIAJE-BASURA: un viaje que no parsea se reporta presente, no ausente", () => {
    barra(VUELTA_CON_DIAG);
    window.localStorage.setItem("chaski.billetera.viaje.v1", "{no soy json");
    render(<DiagnosticoDeVuelta />);
    const texto = textoDelBloque() ?? "";
    expect(texto, "un viaje ilegible se reportó como si no estuviera").toContain("viaje=sí");
    expect(texto).toContain("viaje.paso      : ?");
    expect(texto).toContain("viaje.direccion : —");
  });
  // ── 9 · EL LLAMADOR DE PRODUCCIÓN DE LA BITÁCORA ───────────────────────────────────────────────
  //
  // 🔴 SIN ESTE `it`, LA BITÁCORA ES UN MECANISMO SIN LLAMADOR VIGILADO. Todos los `it` de arriba le
  // escriben la causa a mano, así que borrar el `anotarCorteDeVuelta(causa)` del `alFallar` de
  // (`useVueltaPorEnlace`, `./flow.tsx:286`) los dejaría a TODOS en verde y el campo `corte` diría
  // «sin corte» para siempre en producción: exactamente el estado que el bloque existe para descartar.
  //
  // ⛔ NO SE DOBLA `alFallar`: se monta la pantalla REAL y se le hace producir un corte de verdad por
  // el único camino que lo produce, que es un `completar()` con `estado: "corte"`.
  it("T-DIAG-LLAMADOR: el corte que produce la pantalla real llega a la bitácora", async () => {
    barra("?dl=conectar");
    solanaWalletBridge.setWalletAvailability("none"); // la espera de la disponibilidad resuelve sin tick
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
    class RecorridoQueCorta extends RecorridoPorEnlaceNulo {
      override remesaEnCurso(): string | null {
        return "rem-1";
      }
      override async completar(): Promise<never> {
        return { estado: "corte", causa: "deeplink_viaje_vencido" } as never;
      }
    }
    const c = buildTestContainer({
      repo: new InMemoryRepo(),
      wallet: new FakeWallet(),
      recorridoPorEnlace: new RecorridoQueCorta(),
    });
    expect(ultimoCorteDeVuelta(), "precondición: la bitácora arranca vacía").toBeNull();
    await act(async () => {
      render(<RemittanceFlow container={c} />);
    });
    expect(
      ultimoCorteDeVuelta(),
      "la pantalla cortó y la bitácora no se enteró: el `alFallar` dejó de anotarla",
    ).toBe("deeplink_viaje_vencido");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 10 · LOS CAMPOS DE LA SEGUNDA VUELTA — los que la captura del founder no tenía
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // 🔴 QUÉ HAY QUE PROBAR ACÁ Y POR QUÉ. La captura anterior dijo `corte: sin corte`, `viaje=sí` y la
  // pantalla en la BIENVENIDA, y ningún campo separaba las razones posibles de eso. Estos `it` miden
  // que cada campo nuevo tenga los valores DISTINTOS que hacen falta para separarlas: un campo que
  // dijera lo mismo en dos hipótesis distintas sería ruido con forma de dato, que es exactamente el
  // defecto que esta segunda vuelta viene a arreglar.

  it("T-DIAG-REMESA: los cinco desenlaces del cruce contra el repo son cinco textos distintos", () => {
    const id = "8f3a2c11-0000-4000-8000-00000000c21b";
    const disco = { viaje: true, remesaDelViaje: id } as ReturnType<typeof presenciaEnElDisco>;
    const dichos = [
      renglonDeLaRemesa({ ...disco, viaje: false, remesaDelViaje: null }, { tipo: "sin-id" }),
      renglonDeLaRemesa({ ...disco, remesaDelViaje: null }, { tipo: "sin-id" }),
      renglonDeLaRemesa(disco, { tipo: "sin-blob" }),
      renglonDeLaRemesa(disco, { tipo: "ilegible" }),
      renglonDeLaRemesa(disco, { tipo: "no-esta" }),
      renglonDeLaRemesa(disco, { tipo: "esta", status: "confirmed" }),
    ];
    // 🔴 LA PROPIEDAD ES QUE SON SEIS TEXTOS DISTINTOS, no que cada uno diga una frase concreta: dos
    // desenlaces con el mismo texto dejan al campo sin poder separar las dos hipótesis, que es el
    // único motivo por el que este campo existe. Un `toContain` por rama no vería esa colisión.
    expect(new Set(dichos).size, `dos desenlaces se leen igual: ${JSON.stringify(dichos)}`).toBe(6);
    expect(dichos[1], "un viaje SIN `remittanceId` es el gate mudo de `flow.tsx:4010`, y tiene que gritarlo").toContain("SIN ID EN EL VIAJE");
    expect(dichos[5]).toBe(`${id.slice(0, 6)}…${id.slice(-4)} · repo: confirmed`);
    expect(dichos[5], "el id de la remesa salió entero").not.toContain(id);
  });

  it("T-DIAG-REMESA-2: `estadoEnElRepo` no colapsa «no puedo leer» con «no la encuentro»", () => {
    const fila = (id: string) => JSON.stringify([{ id, status: "confirmed" }]);
    expect(estadoEnElRepo(null, "rem-1")).toEqual({ tipo: "sin-blob" });
    expect(estadoEnElRepo("{no soy json", "rem-1")).toEqual({ tipo: "ilegible" });
    expect(estadoEnElRepo('{"no":"soy un array"}', "rem-1")).toEqual({ tipo: "ilegible" });
    expect(estadoEnElRepo(fila("otra"), "rem-1")).toEqual({ tipo: "no-esta" });
    expect(estadoEnElRepo(fila("rem-1"), "rem-1")).toEqual({ tipo: "esta", status: "confirmed" });
    expect(estadoEnElRepo(fila("rem-1"), null), "sin id no hay nada que cruzar").toEqual({ tipo: "sin-id" });
    // Un blob con una entrada que NO es un objeto no puede tapar a la que sí lo es: es la familia que
    // `LocalRepo.read()` colapsa a un Map vacío, y por eso este lector no lo usa.
    expect(estadoEnElRepo(JSON.stringify([null, { id: "rem-1", status: "quoted" }]), "rem-1")).toEqual({
      tipo: "esta",
      status: "quoted",
    });
  });

  // 🔴 EL FIXTURE REPRODUCE EL DEFECTO: el blob del repo lleva beneficiario, CCI y apellido con valores
  // que sólo pueden venir de acá, así que un lector que volcara la fila entera —o que pintara el id sin
  // enmascarar— pone este `it` en rojo. Un blob con la fila vacía daría verde para siempre.
  it("T-DIAG-SECRETOS-3: del blob del repo salen DOS campos y ninguno es PII", () => {
    barra(VUELTA_CON_DIAG);
    window.localStorage.setItem("chaski.billetera.viaje.v1", viajeCompleto());
    window.localStorage.setItem(CLAVE_DEL_REPO, blobDelRepo("rem-1", "confirmed"));
    render(<DiagnosticoDeVuelta />);
    const texto = textoDelBloque() ?? "";
    expect(texto, "el bloque no se pintó: sin DOM este `it` pasaría por vacío").not.toBe("");
    expect(texto, "el `status` no llegó ⇒ el cruce no se hizo y el resto de este `it` no mide nada").toContain("repo: confirmed");
    for (const [campo, valor] of Object.entries(PII_DEL_REPO)) {
      expect(texto, `el campo ${campo} del blob del repo llegó al bloque`).not.toContain(valor);
      expect(document.body.innerHTML, `el campo ${campo} apareció fuera del bloque`).not.toContain(valor);
    }
    expect(texto, "el id de la remesa salió entero").not.toContain("rem-1");
  });

  it("T-DIAG-EDAD: un viaje VENCIDO sale presente y con su edad, que es lo que el productor sí mira", () => {
    barra(VUELTA_CON_DIAG);
    window.localStorage.setItem(
      "chaski.billetera.viaje.v1",
      viajeCompleto({ desde: Date.now() - MAX_EDAD_MS - 60_000 }),
    );
    render(<DiagnosticoDeVuelta />);
    const texto = textoDelBloque() ?? "";
    // Las dos mitades: este bloque NO aplica la ventana (sigue diciendo `viaje=sí`) **y** publica el
    // juicio que el productor sí aplica. Sin la segunda, `viaje=sí` con el productor tratándolo como
    // ausente se lee igual que un viaje sano, que es la confusión que este campo cierra.
    expect(texto, "el bloque aplicó la ventana y se comió el dato").toContain("viaje=sí");
    expect(texto).toContain("⇒ VENCIDO");
    expect(renglonDelPaso(presenciaEnElDisco(() => null, Date.now())), "sin viaje no hay edad que inventar").toBe("—");
  });

  it("T-DIAG-EDAD-2: un `desde` en el FUTURO no se reporta como una edad chica", () => {
    // Es el cuarto desenlace de `leerViaje` («no-fechable»): con `ahora - desde` negativo la ventana no
    // vence NUNCA. Un `duracion()` sobre el valor absoluto lo mostraría como «edad 2m» y sería la
    // lectura opuesta a la verdad.
    const disco = presenciaEnElDisco(
      (k) => (k === "chaski.billetera.viaje.v1" ? viajeCompleto({ desde: Date.now() + 120_000 }) : null),
      Date.now(),
    );
    expect(renglonDelPaso(disco)).toContain("EMPEZÓ EN EL FUTURO");
    expect(renglonDelPaso(disco), "se leería como un viaje sano y recién nacido").not.toContain("⇒ vigente");
  });

  // ── EL ANCLA DEL PoP ───────────────────────────────────────────────────────────────────────────
  //
  // ⚠️ LO QUE ESTE CAMPO **NO** PUEDE CONTESTAR, y se dice acá para que nadie se lo pida: «¿el ancla es
  // de ESTA remesa?». (`PasoPop`, `../infrastructure/solana/deeplink/pop-por-enlace.ts:81`) ⛔ no tiene
  // `remittanceId` — sus campos son `proposito`, `popChallenge`, `popMessage`, `exp`, `direccion`,
  // `desde`, `consumido` y `firma`, y ninguno nombra una remesa. Lo que SÍ la scopea son el propósito
  // (CD-15), la cuenta y el `exp`, y son los tres que este renglón informa.
  it("T-DIAG-POP: el retrato cruza el propósito, la cuenta y el `exp`, y separa lo que decide", () => {
    // 🔴 UN INSTANTE FIJO Y MÚLTIPLO EXACTO DE 1000, y no `Date.now()`. MEDIDO, no razonado: con
    // `Date.now()` este `it` era FLAKY y lo cazó el barrido de mutación —`segundosAlExp` es
    // `round(exp - ahoraMs/1000)` y `exp` son segundos ENTEROS, así que la fracción de segundo del
    // reloj hacía que `300` cayera a `299` en algunas corridas—. ⛔ Un `it` que falla por el reloj es
    // ruido que enseña a ignorar los rojos, y en un barrido de mutación es peor: fabrica falsos KILLED.
    const ahora = 1_788_000_000_000;
    const ancla = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        proposito: MARCA_POP_KYC,
        popChallenge: DESAFIO_QUE_NO_PUEDE_SALIR,
        popMessage: "firmá esto",
        exp: Math.floor(ahora / 1000) + 300,
        direccion: DIRECCION,
        desde: ahora,
        ...extra,
      });
    const mismo = retratoDelPop(ancla(), DIRECCION, ahora);
    expect(mismo).toEqual({ proposito: MARCA_POP_KYC, cuenta: "misma", firma: false, usado: false, segundosAlExp: 300 });
    // La de OTRA cuenta: `leerPruebaPop` la entregaría igual (sólo cruza el propósito), y el `prepare`
    // la rechazaría del otro lado. Que se vea acá es la diferencia entre diagnosticar y adivinar.
    expect(retratoDelPop(ancla(), "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDX", ahora)?.cuenta).toBe("OTRA");
    expect(retratoDelPop(ancla(), null, ahora)?.cuenta, "sin viaje no hay contra qué cruzar, y no se inventa").toBe("?");
    // El propósito AJENO: un ancla de `pop-payout` ⛔ no satisface un pedido de `pop-kyc` (CD-15), así
    // que ver `pop=sí` sin ver el propósito es ver un ancla que puede no servir para nada.
    expect(retratoDelPop(ancla({ proposito: MARCA_POP_PAYOUT }), DIRECCION, ahora)?.proposito).toBe(MARCA_POP_PAYOUT);
    expect(retratoDelPop(ancla({ proposito: "cualquier-cosa" }), DIRECCION, ahora)?.proposito, "un texto del disco se pintó tal cual").toBe("?");
    expect(retratoDelPop(ancla({ consumido: true }), DIRECCION, ahora)?.usado).toBe(true);
    expect(retratoDelPop(ancla({ firma: "unafirma" }), DIRECCION, ahora)?.firma).toBe(true);
    expect(retratoDelPop(ancla({ exp: Math.floor(ahora / 1000) - 42 }), DIRECCION, ahora)?.segundosAlExp).toBe(-42);
    expect(retratoDelPop(ancla({ exp: "no soy un numero" }), DIRECCION, ahora)?.segundosAlExp).toBeNull();
    expect(retratoDelPop("{no soy json", DIRECCION, ahora), "un ancla ilegible no es un ancla vacía").toBeNull();
  });

  it("T-DIAG-POP-SECRETO: ni la firma ni el desafío del ancla llegan al DOM", () => {
    barra(VUELTA_CON_DIAG);
    window.localStorage.setItem("chaski.billetera.viaje.v1", viajeCompleto());
    window.localStorage.setItem(
      "chaski.billetera.pop.v1",
      JSON.stringify({
        proposito: MARCA_POP_KYC,
        popChallenge: DESAFIO_QUE_NO_PUEDE_SALIR,
        popMessage: "firmá esto",
        exp: Math.floor(Date.now() / 1000) + 300,
        direccion: DIRECCION,
        desde: Date.now(),
        firma: FIRMA_QUE_NO_PUEDE_SALIR,
      }),
    );
    render(<DiagnosticoDeVuelta />);
    const texto = textoDelBloque() ?? "";
    expect(texto, "el retrato no se pintó ⇒ el resto de este `it` pasaría por vacío").toContain("firma=sí");
    expect(texto, "la firma del PoP llegó al DOM").not.toContain(FIRMA_QUE_NO_PUEDE_SALIR);
    expect(texto, "el desafío del PoP llegó al DOM").not.toContain(DESAFIO_QUE_NO_PUEDE_SALIR);
    expect(document.body.innerHTML).not.toContain(FIRMA_QUE_NO_PUEDE_SALIR);
    expect(document.body.innerHTML).not.toContain(DESAFIO_QUE_NO_PUEDE_SALIR);
    // Y el ancla sigue en el disco: `leerPruebaPop` la BORRA al entregarla, y un observador que la
    // consumiera le quemaría la prueba al recorrido real (⛔ la tercera prohibición).
    expect(window.localStorage.getItem("chaski.billetera.pop.v1"), "el observador consumió el ancla del PoP").not.toBeNull();
  });

  it("T-DIAG-POP-2: sin ancla dice `—`, y con un ancla ilegible lo dice", () => {
    const sinAncla = presenciaEnElDisco(() => null, Date.now());
    expect(renglonDelPop(sinAncla)).toBe("—");
    const ilegible = presenciaEnElDisco(
      (k) => (k === "chaski.billetera.pop.v1" ? "{no soy json" : null),
      Date.now(),
    );
    expect(renglonDelPop(ilegible), "un ancla que no parsea se reportó como si no estuviera").toContain("ILEGIBLE");
  });

  // ── EL REFRESCO ────────────────────────────────────────────────────────────────────────────────
  //
  // 🔴 SIN ÉL LA CAPTURA ES UNA FOTO DE LOS PRIMEROS SEGUNDOS. La primera versión se re-renderizaba
  // TRES veces y todo lo que este bloque mira cambia después: `leerPruebaPop` consume el ancla, el
  // productor puede borrar el viaje, `onConnect` termina más tarde. Este `it` mueve el disco DESPUÉS
  // del render y exige que el bloque lo vea, con la calibración de que antes del tick todavía no.
  it("T-DIAG-REFRESCO: el bloque vuelve a mirar el disco solo", () => {
    vi.useFakeTimers();
    try {
      barra(VUELTA_CON_DIAG);
      window.localStorage.setItem("chaski.billetera.pop.v1", JSON.stringify({ proposito: MARCA_POP_KYC, desde: Date.now() }));
      render(<DiagnosticoDeVuelta />);
      expect(textoDelBloque(), "precondición: el ancla se sembró y el bloque la vio").toContain("pop=sí");
      window.localStorage.removeItem("chaski.billetera.pop.v1"); // lo que hace `leerPruebaPop` al entregarla
      // CALIBRACIÓN, en el mismo `it`: sin avanzar el reloj el bloque NO se enteró. Sin esta mitad, un
      // bloque que se re-renderizara por cualquier otra razón dejaría el `it` verde sin que el
      // temporizador existiera.
      expect(textoDelBloque(), "algo más lo re-renderizó ⇒ este `it` no mide el refresco").toContain("pop=sí");
      act(() => {
        vi.advanceTimersByTime(REFRESCO_MS);
      });
      expect(textoDelBloque(), "el bloque no volvió a mirar el disco: la captura sería una foto vieja").toContain("pop=no");
    } finally {
      vi.useRealTimers();
    }
  });

  it("T-DIAG-APAGADO-4: sin el parámetro NO arma un solo temporizador", () => {
    barra("");
    const conIntervalo = vi.spyOn(globalThis, "setInterval");
    const conTecho = vi.spyOn(globalThis, "setTimeout");
    render(<DiagnosticoDeVuelta />);
    expect(conIntervalo, "armó el refresco sin que nadie pidiera el bloque").not.toHaveBeenCalled();
    expect(conTecho, "armó el techo sin que nadie pidiera el bloque").not.toHaveBeenCalled();
    // CALIBRACIÓN: con el parámetro puesto sí los arma. Sin esta mitad, un espía sobre el objeto
    // equivocado dejaría las dos afirmaciones de arriba verdes para siempre.
    cleanup();
    conIntervalo.mockClear();
    conTecho.mockClear();
    barra(VUELTA_CON_DIAG);
    render(<DiagnosticoDeVuelta />);
    expect(conIntervalo, "CALIBRACIÓN: con el parámetro tampoco arma el refresco ⇒ el espía no mide nada").toHaveBeenCalled();
    expect(conTecho, "CALIBRACIÓN: con el parámetro tampoco arma el techo ⇒ el espía no mide nada").toHaveBeenCalled();
  });

  it("T-DIAG-DURACION: la duración se lee en un teléfono y no miente con el signo", () => {
    expect(duracion(0)).toBe("0s");
    expect(duracion(38_000)).toBe("38s");
    expect(duracion(252_000)).toBe("4m12s");
    expect(duracion(MAX_EDAD_MS)).toBe("20m00s");
    expect(duracion(-42_000), "el signo lo pone quien la llama, no ella").toBe("42s");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 11 · LOS LLAMADORES DE LOS CUATRO HITOS — un artefacto sin llamador no es una defensa
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // 🔴 TODOS LOS `it` DE ARRIBA QUE PINTAN UN HITO SE LO ESCRIBEN A MANO. Borrar los `anotarHito` de
  // `./flow.tsx` los dejaría a TODOS en verde y los cuatro campos dirían «no corrió» para siempre en
  // producción: exactamente el estado que este bloque existe para descartar. ⛔ Por eso acá se monta la
  // PANTALLA REAL y se la hace recorrer el camino de verdad.

  it("T-DIAG-LLAMADOR-2 · `pantalla`: la pantalla real anota su paso al montar", async () => {
    expect(leerHito("pantalla"), "precondición: los hitos arrancan vacíos").toBeNull();
    await act(async () => {
      render(<RemittanceFlow container={buildTestContainer({ repo: new InMemoryRepo(), wallet: new FakeWallet(), recorridoPorEnlace: new RecorridoPorEnlaceNulo() })} />);
    });
    expect(leerHito("pantalla"), "la pantalla montó y no anotó su paso: el campo diría `—` siempre").toBe("bienvenida");
  });

  it("T-DIAG-LLAMADOR-3 · `connect` + `continuacion` + `error`: la vuelta que REVIENTA en la continuación", async () => {
    // El repo NO tiene la remesa que el viaje nombra ⇒ `lockQuote` tira `remittance_not_found` adentro
    // de `onConnect`, que es una de las hipótesis vivas del reporte de campo. Los tres hitos juntos son
    // lo que la separa: la conexión SÍ resolvió, la continuación arrancó y NO llegó a navegar.
    await montarLaVuelta(new InMemoryRepo());
    expect(leerHito("connect"), "`alConectar` dejó de anotar el estado del `rc`").toBe("listo");
    expect(leerHito("continuacion"), "`onConnect` dejó de anotar que arrancó").toBe("vuelta: corriendo");
    expect(leerHito("error"), "el `catch` de `guard` dejó de anotar el código").toBe("remittance_not_found");
  });

  it("T-DIAG-LLAMADOR-4 · `continuacion`: la vuelta que SÍ continúa dice a dónde navegó", async () => {
    const repo = new InMemoryRepo();
    await repo.save(Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0));
    await montarLaVuelta(repo);
    expect(leerHito("continuacion"), "`onConnect` navegó y no lo anotó: «no corrió» y «navegó» se leerían igual").toBe(
      "vuelta: navegó a review",
    );
    expect(leerHito("error"), "no hubo error y el campo inventó uno").toBeNull();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 12 · LA CAPTURA COMPLETA — el texto EXACTO que va a ver el founder
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // 🔴 ES UNA IGUALDAD Y NO UNA LISTA DE `toContain`, a propósito: el entregable de esta HU es un
  // TEXTO que alguien lee en un teléfono, y un campo de más, uno de menos o una etiqueta desalineada
  // no los ve ningún `toContain`. Los dos números que cambian entre corridas (el instante de la foto y
  // el de la decisión) se normalizan; ⛔ nada más se normaliza.
  it("T-DIAG-CAPTURA: los quince renglones salen en una sola captura, con este texto exacto", async () => {
    // 🔴 EL RELOJ SE PINCHA, Y NO ES COMODIDAD: `exp` son SEGUNDOS y `Date.now()` son MILISEGUNDOS, así
    // que entre sembrar el ancla y renderizar pasa una fracción de segundo y `exp=vigente(+5m12s)` cae
    // a `+5m11s` cuando el redondeo cruza. MEDIDO: la primera forma de este `it` alternaba entre los
    // dos. ⛔ Se pincha `Date.now` y NO los temporizadores: `vi.useFakeTimers()` también congela
    // `performance.now()` en 0, y ahí `msDecision <= msMontaje` cambia el renglón de la disponibilidad
    // a la otra rama ⇒ el `it` mediría un texto que ninguna persona ve.
    vi.spyOn(Date, "now").mockReturnValue(1_788_000_000_000); // múltiplo exacto de 1000: `exp` no arrastra fracción
    barra(VUELTA_CON_DIAG);
    window.localStorage.setItem("chaski.billetera.viaje.v1", viajeCompleto({ desde: Date.now() - 252_000, remittanceId: REM_UUID }));
    window.localStorage.setItem("chaski.billetera.eleccion.v1", "phantom");
    window.localStorage.setItem(CLAVE_DEL_REPO, blobDelRepo(REM_UUID, "confirmed"));
    window.localStorage.setItem(
      "chaski.billetera.pop.v1",
      JSON.stringify({
        proposito: MARCA_POP_KYC,
        popChallenge: DESAFIO_QUE_NO_PUEDE_SALIR,
        popMessage: "m",
        exp: Math.floor(Date.now() / 1000) + 312,
        direccion: DIRECCION,
        desde: Date.now(),
      }),
    );
    anotarHito("pantalla", "bienvenida");
    anotarHito("connect", "listo");
    anotarHito("continuacion", "vuelta: corriendo");
    anotarHito("error", "remittance_not_found");
    vi.stubEnv("NEXT_PUBLIC_SOLANA_DEEPLINK_ENABLED", "true");
    render(<DiagnosticoDeVuelta />);
    await act(async () => {
      solanaWalletBridge.setWalletAvailability("none");
    });
    const texto = (textoDelBloque() ?? "").replace(/\d+ ms/g, "N ms");
    // 🔴 DOS TEXTOS ACEPTABLES Y NO UNA NORMALIZACIÓN, y la diferencia importa. El renglón de la
    // disponibilidad tiene DOS formas LEGÍTIMAS —el bloque no afirma haber medido la carrera si ya
    // estaba decidida al montar— y cuál sale depende de si `performance.now()` avanzó entre el montaje
    // y el efecto de la decisión. MEDIDO en este árbol: 2 de 14 corridas salieron por la segunda, y con
    // una sola forma esperada este `it` era FLAKY. ⛔ La salida barata era normalizar ese renglón con
    // un regex, y no se hizo: eso lo habría dejado de medir. Se enumeran las dos, que es lo que el
    // founder puede ver de verdad.
    const capturaCon = (cuando: string) =>
      [
        "DIAG · vuelta por enlace · foto t=N ms",
        "marca al montar : conectar",
        `disponibilidad  : none · ${cuando}`,
        "disco           : viaje=sí eleccion=sí pop=sí",
        "viaje.paso      : conectar · edad 4m12s (ventana 20m00s) ⇒ vigente",
        `viaje.direccion : ${DIRECCION.slice(0, 6)}…${DIRECCION.slice(-4)}`,
        `viaje.remesa    : ${REM_UUID.slice(0, 6)}…${REM_UUID.slice(-4)} · repo: confirmed`,
        "pop             : pop-kyc cuenta=misma firma=no usado=no exp=vigente(+5m12s)",
        "pantalla        : bienvenida",
        "connect         : listo",
        "continuacion    : vuelta: corriendo",
        "corte           : sin corte",
        "error           : remittance_not_found",
        // WKH-372/W1 — EL RENGLÓN QUINCE. Este `it` es lo que hace que agregar un renglón al bloque
        // NO se pueda hacer en silencio: se puso rojo con `expected […] to include …` en cuanto el
        // renglón nuevo entró. `no corrió` es el valor correcto acá: este `it` anota cuatro hitos a
        // mano y NO monta `RemittanceFlow`, así que nadie llamó al anotador del aterrizaje. Que la
        // ausencia se distinga del veredicto es justamente lo que separa «no pude preguntar» de «no
        // pasó», y lo mide `T-372-W1-7` en `wallet-availability.test.tsx`.
        "salida navegador: no corrió",
        "enlace          : on · cluster: devnet",
      ].join("\n");
    expect([capturaCon("decidida a los N ms (techo 3000)"), capturaCon("ya decidida al montar el bloque (N ms)")]).toContain(
      texto,
    );
    // Y el bloque es VISIBLE, no un nodo escondido: una captura tiene que poder mostrarlo.
    expect(screen.getByText(/DIAG · vuelta por enlace/)).toBeVisible();
  });
});
