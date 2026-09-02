// @vitest-environment jsdom
//
// WKH-374 · W1.2 — EL ANFITRIÓN DEL RECORRIDO NUEVO, EJECUTÁNDOSE
//
// Los cinco `it` de acá montan `<Recorrido/>` de verdad y lo recorren. ⛔ Nada de esto corre en un
// teléfono: todo es jsdom, y la medición en un dispositivo real es de otra ola. Se dice acá arriba
// para que nadie lea el verde de este archivo como si dijera algo sobre un teléfono.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// El barrel de billeteras arrastra el adapter de Ledger, que no resuelve bajo vitest. Mismo
// reemplazo, y por el mismo motivo, que el de `../wallet-availability.test.tsx`.
vi.mock("@solana/wallet-adapter-wallets", async () => {
  const p = await import("@solana/wallet-adapter-phantom");
  const s = await import("@solana/wallet-adapter-solflare");
  return { PhantomWalletAdapter: p.PhantomWalletAdapter, SolflareWalletAdapter: s.SolflareWalletAdapter };
});

import type { Container } from "../../composition/container";
import { Money } from "../../domain/money";
import { Remittance } from "../../domain/remittance";
import { emitirSesionDePosesion } from "../../infrastructure/auth/sesion-de-posesion";
import { InMemorySesionStore } from "../../infrastructure/auth/sesion-store";
import { resolveSolanaNetworkId } from "../../infrastructure/chain";
import {
  FAKE_WALLET_ADDRESS,
  FixedClock,
  T0,
  TEST_CCI,
  beneficiary,
} from "../../test-support/fakes";
import { buildTestContainer } from "../../test-support/test-container";
import { MARCA, enlaceDeVuelta } from "../../infrastructure/solana/deeplink/sesion";
import { MARCA_CREAR_NONCE } from "../../infrastructure/solana/deeplink/conexion";
import { MIN_SEND_USD } from "../../domain/remittance";
import { ETIQUETA_CONECTANDO, NO_CUSTODIAL } from "./pantallas";
import { TABLA } from "./pasos";
import { MS_DE_ESPERA_DE_LA_COTIZACION, type PropsDelRecorrido, Recorrido } from "./recorrido";
import { MOTIVO_SIN_ATERRIZAJE, TEXTO_EN_VUELO_IDENTIDAD, anuncioDe } from "./salto";

const NOMBRE = "Maria Elena Quispe";
const MONTO = "25";
/** El destino que un caso de uso puede contestar cuando hay que salir. ⛔ Es un doble: no se le pide
 *  forma de enlace universal de ninguna billetera, se le pide ser distinguible del `href` del test. */
const DESTINO_DE_LA_BILLETERA = "https://billetera.example/ul/v1/firmar?x=1";
const DESTINO_DEL_VERIFICADOR = "https://verificacion.example/session/fake";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

/** Monta el recorrido con un container de test. `pasoDeArranque` es la costura declarada del
 *  anfitrión: se pide en voz alta la pantalla de la que el `it` habla. */
function montar(o: PropsDelRecorrido = {}) {
  const container = o.container ?? buildTestContainer();
  // ⚠️ El resultado de `render` YA trae una propiedad `container` (el nodo del DOM), así que el
  // container de casos de uso sale con otro nombre: mezclarlos era un error de tipos, no de estilo.
  // El orden de los props importa: `hrefDeAterrizaje` va ANTES del spread para que un `it` lo pueda
  // pisar, y el container DESPUÉS para que sea siempre el que este helper resolvió.
  return {
    contenedorDeCasosDeUso: container,
    ...render(<Recorrido hrefDeAterrizaje="https://chaski.test/" {...o} container={container} />),
  };
}

/**
 * Toca un `<a href>` y ⛔ le corta la navegación.
 *
 * ⚠️ POR QUÉ, Y QUÉ **NO** DEBILITA: jsdom no implementa la navegación —tira «Not implemented» desde
 * un `setTimeout`, o sea DESPUÉS de que el `it` terminó, y ese error se le cuelga al archivo que
 * corra después—. Lo que este archivo afirma sobre el salto es el `href` del enlace, con su propia
 * aserción; el `preventDefault` sólo evita que el ruido cruce de archivo. El listener va en el
 * ELEMENTO y React escucha delegado en la raíz, así que el `onClick` del componente corre igual: si
 * no corriera, la aserción del estado en vuelo que le sigue se pondría roja.
 */
function tocarSinNavegar(a: HTMLElement) {
  a.addEventListener("click", (e) => e.preventDefault(), { once: true });
  fireEvent.click(a);
}

/**
 * Los TRES predicados de copy de `T-374-W1-8`, en un solo sitio.
 *
 * 🔴 Se extrajeron en el fix-pack porque el `it` pasó a mirar copy que los cinco montajes por default
 * ⛔ NO alcanzan (los motivos y el anuncio del camino por enlace), y tres predicados copiados cuatro
 * veces es un guard que envejece por partes: el día que se agregue el cuarto, entra en uno solo.
 */
function revisarCopy(texto: string, quien: string) {
  expect(texto.length, `${quien} no renderizó nada: el barrido pasaría por vacío`).toBeGreaterThan(50);
  expect(texto, `${quien} mete un em dash en copy visible`).not.toContain("—");
  // ⛔ Nada promete lo que hoy no está aprobado ni entregado: ni que desaparezca el paso de crear la
  // cuenta, ni que quien manda no necesite la moneda de red.
  expect(texto, `${quien} promete que no hace falta la moneda de red`).not.toMatch(
    /no (?:vas a )?necesit\w*\s+SOL/i,
  );
  expect(texto, `${quien} promete que «Crear la cuenta» desaparece`).not.toMatch(
    /sin crear (?:la )?cuenta/i,
  );
  // 🔴 LAS DOS MENTIRAS DEL CR, CERRADAS ACÁ PARA QUE NO VUELVAN. Las dos estuvieron renderizadas en
  // producción del árbol nuevo y las dos las leía la persona:
  //   · «Se guarda solo mientras lo completás» ⇒ no se guarda nada hasta tocar «Seguir»;
  //   · «Una vez sola / no la vuelven a pedir» ⇒ la costura que lo saltea ⛔ no tiene productor.
  // ⛔ Los predicados son por el SENTIDO y no por la frase exacta: prohibir el literal viejo dejaría
  // pasar la misma promesa escrita con otras palabras, que es como vuelven estas cosas.
  expect(texto, `${quien} sugiere que lo cargado se guarda solo`).not.toMatch(
    /se guarda\s+sol[oa]|guardado autom|se va guardando/i,
  );
  expect(texto, `${quien} promete que la identidad se pide una sola vez`).not.toMatch(
    /una vez sola|no (?:te )?la vuelven a pedir|no (?:te )?la volvemos a pedir/i,
  );
}

/** Completa los tres campos de la pantalla del envío. */
function cargarElEnvio() {
  fireEvent.change(screen.getByLabelText("Cuánto mandás"), { target: { value: MONTO } });
  fireEvent.change(screen.getByLabelText("Quién recibe"), { target: { value: NOMBRE } });
  fireEvent.change(screen.getByLabelText("CCI de la cuenta"), { target: { value: TEST_CCI } });
}

describe("WKH-374/W1.2 · el recorrido nuevo, montado y recorrido", () => {
  // MUTANTE QUE MATA (`MW-5`): mover el campo de monto a `PantallaEntrar` ⇒ cae la AUSENCIA.
  // ⛔ FALSO KILLED A EVITAR: afirmar sólo «hay un botón de conectar». Eso sigue siendo cierto con el
  // mutante puesto. Por eso el `it` afirma la AUSENCIA de los TRES campos en la pantalla 1 y su
  // PRESENCIA en la 2 — el control positivo es lo único que separa «no está» de «no se renderizó
  // nada».
  it("T-374-W1-5: conectar es lo PRIMERO: la pantalla de entrada no pide monto, ni quién recibe, ni el CCI", () => {
    montar();
    expect(
      screen.getByRole("button", { name: "Conectar mi billetera" }),
      "la pantalla de entrada no llegó a renderizarse",
    ).toBeInTheDocument();
    for (const campo of ["Cuánto mandás", "Quién recibe", "CCI de la cuenta"]) {
      expect(
        screen.queryByLabelText(campo),
        `la pantalla de entrada pide «${campo}» antes de que haya una billetera conectada (AC-1)`,
      ).not.toBeInTheDocument();
    }
    // CONTROL POSITIVO: los tres campos EXISTEN, en la pantalla 2. Sin esto, las tres ausencias de
    // arriba serían indistinguibles de tres etiquetas mal escritas.
    cleanup();
    montar({ pasoDeArranque: "envio" });
    for (const campo of ["Cuánto mandás", "Quién recibe", "CCI de la cuenta"]) {
      expect(
        screen.getByLabelText(campo),
        `«${campo}» no está en la pantalla del envío: el control positivo no está midiendo nada`,
      ).toBeInTheDocument();
    }
  });

  // MUTANTE QUE MATA (`MW-6`): que el manejador de «Volver» del anfitrión limpie el borrador
  // (`setBorrador(BORRADOR_VACIO)`) ⇒ caen los tres valores.
  // ⛔ FALSO KILLED A EVITAR: verificar EL PASO y no LOS CAMPOS. Con el mutante puesto el paso vuelve
  // bien igual, así que un `it` que mirara el paso quedaría verde. Acá se afirman los VALORES de los
  // tres campos, por valor.
  it("T-374-W1-6: «Volver» retrocede un paso y ⛔ NO borra monto, beneficiario ni CCI", async () => {
    montar({ pasoDeArranque: "envio" });
    cargarElEnvio();
    // Calibración: lo cargado ESTÁ antes de retroceder, o el `it` compararía vacío contra vacío.
    expect((screen.getByLabelText("Cuánto mandás") as HTMLInputElement).value).toBe(MONTO);

    fireEvent.click(screen.getByRole("button", { name: "Volver" }));
    expect(
      screen.getByRole("button", { name: "Conectar mi billetera" }),
      "«Volver» no retrocedió al paso anterior",
    ).toBeInTheDocument();

    // Y de vuelta adelante: los tres valores siguen ahí, comparados por VALOR.
    fireEvent.click(screen.getByRole("button", { name: "Conectar mi billetera" }));
    const monto = await screen.findByLabelText("Cuánto mandás");
    expect((monto as HTMLInputElement).value, "«Volver» borró el monto cargado (AC-3)").toBe(MONTO);
    expect(
      (screen.getByLabelText("Quién recibe") as HTMLInputElement).value,
      "«Volver» borró el nombre de quien recibe (AC-3)",
    ).toBe(NOMBRE);
    expect(
      (screen.getByLabelText("CCI de la cuenta") as HTMLInputElement).value,
      "«Volver» borró el CCI cargado (AC-3)",
    ).toBe(TEST_CCI);
  });

  // ── 🔴 LA SESIÓN NO QUEDA EN NINGÚN DISCO, CON EL ÁRBOL NUEVO MONTADO ──────────────────────────
  //
  // 🔴 POR QUÉ ESTE `it` LLEVA TRES ASERCIONES ANTES DE LAS CUATRO DE DISCO, y está medido: las
  // cuatro aserciones de disco del árbol viejo son todas `.not.toContain(token)`, y sobre un almacén
  // VACÍO pasan las cuatro. Copiarlas tal cual acá daría un VERDE POR VACÍO, que es exactamente la
  // clase de aserción negativa que se satisface con una lista vacía.
  //
  // ⚠️ Y ACÁ HAY UNA DECISIÓN DE DISEÑO DEL FIXTURE QUE HAY QUE DECIR EN VOZ ALTA, porque sin ella
  // este `it` no podría fallar NUNCA: en producción el token de sesión vive en un almacén EN MEMORIA
  // de la capa de infraestructura y no llega a la capa de pantalla. Si el doble no se lo entregara al
  // árbol, ninguna mutación del árbol podría hacer caer las cuatro de abajo, y el `it` sería
  // decorativo. Por eso el doble de `confirmAndSend` acuña el token con el EMISOR REAL y lo devuelve
  // dentro del snapshot, en el campo que en producción transporta una referencia del servidor. Lo que
  // se mide es lo que importa: que el árbol nuevo, teniendo el token a mano, ⛔ no lo escriba en
  // ningún disco ni en la URL.
  //
  // MUTANTE QUE MATA (`MW-7`): en `./recorrido.tsx`, dentro del `then` de `confirmAndSend`, agregar
  // `window.localStorage.setItem("x", JSON.stringify(r.remesa.snapshot))` ⇒ cae la PRIMERA de las
  // cuatro.
  // ⛔ FALSO KILLED A EVITAR: aplicar `MW-7` sin las tres aserciones previas. Si el árbol no llegara a
  // acuñar sesión, el `it` daría verde igual, que es el defecto que este diseño existe para prevenir.
  it("T-374-W1-7: con el árbol NUEVO montado y una sesión viva, el token no está en ningún disco ni en la URL", async () => {
    vi.stubEnv("PAYOUT_SESSION_SECRET", "secreto-de-la-sesion-de-este-test");
    const reloj = new FixedClock();
    const sesiones = new InMemorySesionStore(reloj);
    const acunados: string[] = [];

    const remesa = Remittance.create("r-1", beneficiary(), Money.of(Number(MONTO), "USDC"), T0);
    const container: Container = buildTestContainer({
      useCases: {
        confirmAndSend: {
          execute: async () => {
            // El EMISOR REAL: un token inventado no probaría nada sobre la forma que se busca abajo.
            const token = emitirSesionDePosesion(
              FAKE_WALLET_ADDRESS,
              resolveSolanaNetworkId(),
              Date.parse(reloj.nowIso()),
            );
            if (token === null) throw new Error("sesion_no_emitida");
            sesiones.record(FAKE_WALLET_ADDRESS, token);
            acunados.push(token);
            const conToken = Remittance.rehydrate({ ...remesa.snapshot, payoutId: token });
            return { estado: "listo", remesa: conToken } as const;
          },
        } as unknown as Container["confirmAndSend"],
      },
    });

    // Se RECORRE hasta la firma en vez de arrancar ahí: el paso de firmar necesita un envío creado,
    // y crearlo es lo que hace la pantalla anterior. `identidadYaVerificada` deja el itinerario corto.
    montar({ container, pasoDeArranque: "envio", identidadYaVerificada: true });
    cargarElEnvio();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Seguir" }));
    });
    await screen.findByRole("heading", { name: "Firmar y enviar" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Abrir mi billetera" }));
    });

    // ── (1) EL DESENLACE ALCANZADO ───────────────────────────────────────────────────────────────
    // El árbol se montó Y llegó al paso donde la sesión se acuña. Afirmar el desenlace ANTES de contar.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Seguimiento" }),
        "el árbol nuevo no llegó al paso donde la sesión se acuña: todo lo de abajo pasaría por vacío",
      ).toBeInTheDocument(),
    );
    expect(acunados.length, "no se acuñó ninguna sesión durante el recorrido").toBe(1);

    // ── (2) EL TOKEN ES UNA CADENA NO VACÍA CON FORMA `payloadB64.firma` ──────────────────────────
    const token = acunados[0] ?? "";
    expect(token, "no viajó ninguna sesión: no hay nada que buscar en el disco").not.toBe("");
    const partes = token.split(".");
    expect(partes.length, "la sesión no tiene la forma de dos partes separadas por punto").toBe(2);
    expect(partes[0]?.length, "la primera parte de la sesión está vacía").toBeGreaterThan(0);
    expect(partes[1]?.length, "la firma de la sesión está vacía").toBeGreaterThan(0);

    // ── (3) CONTROL POSITIVO: EL INSTRUMENTO SABE DECIR QUE SÍ ────────────────────────────────────
    // Se siembra el token a mano y se exige que LA MISMA expresión lo encuentre. Sin esto, las cuatro
    // de abajo son indistinguibles de un instrumento roto.
    window.localStorage.setItem("control-positivo", token);
    expect(
      JSON.stringify({ ...window.localStorage }),
      "el instrumento NO encuentra un token que está puesto a mano: no está midiendo nada",
    ).toContain(token);
    window.localStorage.removeItem("control-positivo");

    // ── (4) LAS CUATRO, YA NO VACUAS ─────────────────────────────────────────────────────────────
    expect(
      JSON.stringify({ ...window.localStorage }),
      "la sesión quedó escrita en `localStorage`: sobreviviría a la recarga y sería una credencial al portador at-rest",
    ).not.toContain(token);
    expect(JSON.stringify({ ...window.sessionStorage }), "la sesión quedó en `sessionStorage`").not.toContain(
      token,
    );
    expect(document.cookie, "la sesión quedó en una cookie").not.toContain(token);
    expect(window.location.href, "la sesión quedó en la URL").not.toContain(token);
  });

  // MUTANTE QUE MATA (`MW-8`): meter un em dash en cualquier copy de `./pantallas.tsx`.
  // ⛔ FALSO KILLED A EVITAR: dar por suficiente el `it` de em dashes que ya existe en
  // `../honest-copy.test.tsx`. Ese monta el árbol VIEJO ⇒ no cubre ni una pantalla de éstas. ⛔ Y no
  // se lo toca.
  it("T-374-W1-8: el copy preserva la afirmación no custodial, no mete em dashes y no promete lo que otra HU entrega", async () => {
    // 🔴 LOS PASOS SE DERIVAN DE `TABLA`, ⛔ NO SE ESCRIBEN (fix-pack AR/MNR-3). Escritos a mano, un
    // paso nuevo en la tabla quedaba sin barrer y este `it` seguía verde sobre la pantalla que nadie
    // miró. La calibración de abajo es lo que impide que una `TABLA` vacía lo deje pasar por vacío.
    const pasos = TABLA.map((f) => f.id);
    expect(
      pasos.length,
      "la tabla de pasos vino vacía: el `for` de abajo no daría una vuelta y todo pasaría por vacío",
    ).toBeGreaterThanOrEqual(5);
    // ⛔ La pantalla de identidad NO habla de fondos, así que no lleva la afirmación no custodial:
    // repetirla ahí sería ruido. Las otras CUATRO sí, y por eso el conteo de abajo es sobre esas.
    const hablanDeFondos = pasos.filter((x) => x !== "identidad");
    let conNoCustodial = 0;
    for (const paso of pasos) {
      montar({ pasoDeArranque: paso });
      const texto = document.body.textContent ?? "";
      revisarCopy(texto, `la pantalla «${paso}»`);
      if (texto.includes(NO_CUSTODIAL)) conNoCustodial++;
      cleanup();
    }

    // 🔴 Y LOS TRES TEXTOS QUE LOS CINCO MONTAJES DE ARRIBA ⛔ NO ALCANZAN, que son todos copy que
    // ENTRÓ CON EL FIX-PACK. Sin esto, el barrido de arriba diría «el copy del recorrido» y estaría
    // mirando el subconjunto que se ve sin tocar nada, o sea el que menos cambió.
    //
    // (a) EL MOTIVO DE UNA MARCA QUE NADIE ESCRIBIÓ.
    montar({ hrefDeAterrizaje: `https://chaski.test/?${MARCA}=marca-que-nadie-escribio` });
    revisarCopy(document.body.textContent ?? "", "el motivo de la marca sin consumidor");
    expect(
      document.body.textContent ?? "",
      "el fixture (a) no llegó a pintar el motivo: el barrido pasaría por vacío",
    ).toContain(MOTIVO_SIN_ATERRIZAJE);
    cleanup();

    // (b) EL ANUNCIO DEL CAMINO POR ENLACE, que enumera una firma MÁS que el otro camino y ⛔ no se
    //     ve montando la pantalla de firmar sin marca.
    montar({ hrefDeAterrizaje: enlaceDeVuelta("https://chaski.test/", MARCA_CREAR_NONCE) });
    const porEnlace = document.body.textContent ?? "";
    revisarCopy(porEnlace, "el anuncio del camino por enlace");
    for (const f of anuncioDe({ porEnlace: true }).firmas) {
      expect(
        porEnlace,
        `el fixture (b) no enumera «${f.queSeFirma}»: no está mostrando el anuncio del camino por enlace`,
      ).toContain(f.queSeFirma);
    }
    cleanup();

    // (c) EL MOTIVO DE «no hay envío en esta pestaña», que sale al tocar el salto sin remesa.
    montar({ pasoDeArranque: "firmar" });
    fireEvent.click(screen.getByRole("button", { name: "Abrir mi billetera" }));
    const sinEnvio = document.body.textContent ?? "";
    revisarCopy(sinEnvio, "el motivo de «sin envío en esta pestaña»");
    expect(
      sinEnvio,
      "el fixture (c) no dejó ningún motivo: la vuelta a un paso sin envío sigue siendo un callejón silencioso",
    ).toContain("todavía no hay nada que firmar");
    cleanup();
    // Las cuatro pantallas que hablan de fondos preservan la afirmación no custodial (AC-16).
    expect(
      conNoCustodial,
      "hay pantallas del recorrido que hablan de fondos sin preservar la afirmación no custodial (AC-16)",
    ).toBe(hablanDeFondos.length);
  });

  // MUTANTE QUE MATA (`MW-9`): borrar el bloque `<AnuncioDelSalto .../>` de `PantallaFirmar`.
  // ⛔ FALSO KILLED A EVITAR: buscar EL BOTÓN y no EL TEXTO del anuncio. El botón sobrevive al
  // mutante —queda el de «Volver», y cualquier otro botón que la pantalla tenga—, así que lo que se
  // afirma es el TEXTO: el título del anuncio, la enumeración de las firmas y la promesa de la vuelta.
  it("T-374-W1-9: el anuncio existe ANTES del salto, enumera las firmas y ⛔ no escribe ningún número literal", async () => {
    // 🔴 EL DOBLE CONTESTA `hay-que-salir`, QUE ES EL DESENLACE DEL CAMINO DEL QUE TRATA ESTA HU.
    // ⚠️ Acá el doble devolvía una promesa que NUNCA resolvía, «para dejar el estado en vuelo a la
    // vista». Eso medía el estado en vuelo de un salto que no existía: el AR midió que el anfitrión
    // descartaba `hay-que-salir` en silencio (un `if (estado === "listo")` sin `else`) y aun así la
    // pantalla decía «Estamos en tu billetera» con el navegador quieto.
    const container: Container = buildTestContainer({
      useCases: {
        confirmAndSend: {
          execute: async () =>
            ({ estado: "hay-que-salir", irA: DESTINO_DE_LA_BILLETERA, esperando: "firma-tx" }) as const,
        } as unknown as Container["confirmAndSend"],
      },
    });
    montar({ container, pasoDeArranque: "envio", identidadYaVerificada: true });
    cargarElEnvio();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Seguir" }));
    });
    await screen.findByRole("heading", { name: "Firmar y enviar" });
    const esperado = anuncioDe({ porEnlace: false });
    const texto = document.body.textContent ?? "";

    expect(texto, "no hay bloque de anuncio antes del salto (AC-5)").toContain(esperado.titulo);
    expect(texto, "el anuncio no dice a dónde va la persona").toContain(esperado.aDondeVas);
    expect(texto, "el anuncio no promete la vuelta al mismo paso (AC-6)").toContain(esperado.volves);
    for (const f of esperado.firmas) {
      expect(texto, `el anuncio no enumera la firma «${f.queSeFirma}»`).toContain(f.queSeFirma);
    }
    // 🔴 EL NÚMERO SE DERIVA DE LA LISTA, ⛔ no está escrito. Se afirma la relación, no el valor: el
    // texto dice el largo de la MISMA lista que enumera arriba.
    expect(
      texto,
      "el anuncio no dice cuántas firmas va a pedir, o dice un número que no es el de la lista que enumera",
    ).toContain(String(esperado.firmas.length));
    expect(
      esperado.firmas.length,
      "la lista de firmas vino vacía: la aserción de arriba pasaría por vacío",
    ).toBeGreaterThan(0);

    // Y el estado EN VUELO aparece recién cuando se sale, ⛔ nunca antes.
    expect(screen.queryByText(/Estamos en tu billetera/)).not.toBeInTheDocument();
    // (1) El control ES un botón mientras no hay destino: lo que dispara es el caso de uso.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: esperado.boton }));
    });
    // (2) 🔴 Y CON EL DESTINO YA CONTESTADO, EL CONTROL ES UN ENLACE QUE APUNTA A ÉL. Ésta es la
    // aserción que el AR midió ausente: sin ella, «se ejecuta el salto» era una promesa en prosa y el
    // `location.href` no se movía nunca.
    const enlace = await screen.findByRole("link", { name: esperado.boton });
    expect(
      enlace.getAttribute("href"),
      "el control de salida no apunta a donde el caso de uso dijo: el salto no se ejecuta y la pantalla igual dice que estamos en la billetera",
    ).toBe(DESTINO_DE_LA_BILLETERA);
    // Y todavía NO dice que estamos en la billetera: nadie tocó nada.
    expect(
      screen.queryByText(/Estamos en tu billetera/),
      "la pantalla afirma que estamos en la billetera y la persona todavía no tocó el enlace",
    ).not.toBeInTheDocument();
    // (3) Recién al tocarlo aparece el estado en vuelo.
    await act(async () => {
      tocarSinNavegar(enlace);
    });
    expect(
      screen.getByText(/Estamos en tu billetera/),
      "al salir no queda ningún texto en pantalla: AC-6 prohíbe la pantalla vacía y el indicador mudo",
    ).toBeInTheDocument();
  });

  // ── 🔴 EL INVARIANTE DE LA HU, CON EL ANFITRIÓN MONTADO ────────────────────────────────────────
  //
  // 🔴 POR QUÉ ESTE `it` EXISTE Y POR QUÉ NINGUNO DE LOS QUE HABÍA PODÍA VERLO. `AC-8` pide, textual:
  // «marca ausente, marca sin consumidor, firma rechazada ⇒ aterrizar en el mismo paso con un motivo
  // legible, y NUNCA en la pantalla de entrada». La FUNCIÓN PURA lo cumplía —contesta el tercer
  // valor— y el ANFITRIÓN lo colapsaba con un `? :` contra el paso de arranque. `T-374-W1-0` y
  // `T-374-W1-3` no lo podían ver porque NINGUNO DE LOS DOS MONTA EL ANFITRIÓN: los dos miden la
  // función pura, que era la mitad que estaba bien.
  //
  // MUTANTE QUE MATA (`MW-15`): en `./recorrido.tsx`, volver al colapso, o sea reemplazar el
  // `aterrizajeDelAnfitrion(...)` del `useState` por
  // `{ paso: v.desenlace === "aterriza" ? v.paso : pasoDeArranque, motivo: null }` ⇒ caen la (1) y la (2).
  // ⛔ FALSO KILLED A EVITAR: afirmar sólo la AUSENCIA del botón de conectar. Un árbol que no
  // renderizara nada la pasaría igual, y ése es el síntoma exacto del `BLQ-MED-1` (`?dl=toString`
  // dejaba el `body` en «Paso 1 de 5» sin ninguna pantalla). Por eso el `it` afirma también QUÉ
  // pantalla es y trae un control positivo sin marca.
  it("T-374-W1-15: con una marca sin consumidor el anfitrión ⛔ NO aterriza en la entrada y muestra el motivo", () => {
    for (const valor of ["marca-que-nadie-escribio", "", "toString", "CONECTAR"]) {
      montar({ hrefDeAterrizaje: `https://chaski.test/?${MARCA}=${valor}` });
      const cuerpo = document.body.textContent ?? "";

      // (1) ⛔ NO ES LA PANTALLA DE ENTRADA. Es el caso que `AC-8` nombra con esas palabras.
      // ⚠️ `toBeNull()` Y ⛔ NO `.not.toBeInTheDocument()`: medido, ese matcher DESCARTA el mensaje y
      // el rojo sale como «expected document not to contain element», que no dice qué se rompió.
      expect(
        screen.queryByRole("button", { name: "Conectar mi billetera" }),
        `\`?${MARCA}=${valor}\` aterriza en la PANTALLA DE ENTRADA: AC-8 lo prohíbe con la palabra NUNCA`,
      ).toBeNull();

      // (2) Y HAY UN MOTIVO LEGIBLE. Sin esto, mandarla a otro paso seguiría siendo en silencio.
      expect(
        cuerpo,
        `\`?${MARCA}=${valor}\` no deja ningún motivo: la persona cambió de paso sin que nadie le diga por qué`,
      ).toContain(MOTIVO_SIN_ATERRIZAJE);

      // (3) Y SE MONTÓ UNA PANTALLA DE VERDAD, ⛔ no un marco vacío. Es lo que separa «no está el
      // botón de conectar» de «no se renderizó nada», que es el síntoma que el AR midió con `toString`.
      expect(
        screen.getByRole("heading", { name: "Cuánto y para quién" }),
        `\`?${MARCA}=${valor}\` no montó ninguna pantalla: el marco quedó con el indicador de progreso y nada más`,
      ).toBeInTheDocument();
      cleanup();
    }

    // CONTROL POSITIVO: sin marca, la pantalla de entrada SÍ se muestra. Sin esto, las cuatro
    // ausencias de arriba serían indistinguibles de un anfitrión que nunca la renderiza.
    montar();
    expect(
      screen.getByRole("button", { name: "Conectar mi billetera" }),
      "sin marca en la URL la pantalla de entrada no aparece: el control positivo no mide nada",
    ).toBeInTheDocument();
    expect(document.body.textContent ?? "", "sin marca no hay ningún motivo que mostrar").not.toContain(
      MOTIVO_SIN_ATERRIZAJE,
    );
  });

  // ── EL SALTO AL VERIFICADOR SE PIDE, Y ⛔ NADIE DA LA IDENTIDAD POR VERIFICADA ──────────────────
  //
  // MUTANTE QUE MATA (`MW-16`): en `./recorrido.tsx`, volver `verificar` a `setEnVuelo(true);
  // avanzar();` ⇒ cae la aserción del conteo de llamadas Y la de que la pantalla no avanzó.
  // ⛔ FALSO KILLED A EVITAR: mirar sólo el conteo de llamadas. El defecto que el AR midió tiene DOS
  // mitades y la segunda es la grave —«avanza igual» = da la identidad por verificada sin verificar
  // nada—, así que las dos se afirman por separado y con el control de que ANTES del clic el conteo
  // era cero.
  it("T-374-W1-16: «Verificar mi identidad» llama al caso de uso y ⛔ no avanza sola", async () => {
    const llamadas: { remittanceId: string; address: string }[] = [];
    const base = buildTestContainer();
    const container: Container = {
      ...base,
      startKyc: {
        execute: async (i: { remittanceId: string; address: string }) => {
          llamadas.push(i);
          return { kind: "redirect", url: DESTINO_DEL_VERIFICADOR } as const;
        },
      } as unknown as Container["startKyc"],
    };
    montar({ container, pasoDeArranque: "envio" });
    cargarElEnvio();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Seguir" }));
    });
    await screen.findByRole("heading", { name: "Tu identidad" });
    // CALIBRACIÓN: hasta acá NADIE pidió verificar nada. Sin esto, un doble que se llamara solo
    // dejaría verde la aserción de abajo.
    expect(llamadas.length, "el caso de uso se llamó antes de que la persona tocara el botón").toBe(0);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verificar mi identidad" }));
    });

    expect(
      llamadas.length,
      "«Verificar mi identidad» no llama al caso de uso: la pantalla dice que se verificó y no se verificó nada",
    ).toBe(1);
    expect(
      llamadas[0]?.remittanceId,
      "el caso de uso se llamó sin el envío: no habría qué verificar",
    ).toBeTruthy();
    // ⛔ Y NO AVANZÓ. Ésta es la mitad grave: avanzar acá es dar la identidad por verificada.
    expect(
      screen.getByRole("heading", { name: "Tu identidad" }),
      "el recorrido avanzó sin que la verificación haya terminado",
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Firmar y enviar" }),
      "el recorrido llegó a firmar sin haber verificado la identidad",
    ).not.toBeInTheDocument();
    // Y el salto quedó como algo que la persona TOCA, apuntando a donde el caso de uso dijo.
    const enlace = await screen.findByRole("link", { name: "Verificar mi identidad" });
    expect(
      enlace.getAttribute("href"),
      "el control de salida al verificador no apunta a la pantalla que el caso de uso devolvió",
    ).toBe(DESTINO_DEL_VERIFICADOR);

    // ── EL OTRO DESENLACE: EL CASO DE USO CONTESTA SIN REDIRECT Y LA VERIFICACIÓN **NO** PASÓ ─────
    // ⛔ Ése tampoco puede avanzar, y es el que más se parece al defecto original: el caso de uso
    // contesta, no hay excepción, y avanzar ahí es dar por verificada una identidad que no lo está.
    cleanup();
    const sinPasar = Remittance.create("r-2", beneficiary(), Money.of(Number(MONTO), "USDC"), T0);
    const container2: Container = {
      ...buildTestContainer(),
      startKyc: {
        execute: async () => ({ kind: "done", snapshot: sinPasar.snapshot }) as const,
      } as unknown as Container["startKyc"],
    };
    montar({ container: container2, pasoDeArranque: "envio" });
    cargarElEnvio();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Seguir" }));
    });
    await screen.findByRole("heading", { name: "Tu identidad" });
    // Calibración del fixture: el snapshot que el doble devuelve NO está verificado, o el `it` estaría
    // midiendo el camino feliz con el nombre del otro.
    expect(
      sinPasar.snapshot.status,
      "el fixture no reproduce el caso: este snapshot ya está verificado",
    ).not.toBe("kyc_passed");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verificar mi identidad" }));
    });
    expect(
      screen.queryByRole("heading", { name: "Firmar y enviar" }),
      "el recorrido avanzó con una verificación que NO pasó: eso es dar la identidad por verificada",
    ).toBeNull();
    const texto = document.body.textContent ?? "";
    expect(
      texto,
      "la verificación no pasó y la pantalla no dice nada: la persona se queda sin saber por qué no avanza",
    ).toContain("No pudimos verificar tu identidad");
    revisarCopy(texto, "el motivo de la verificación que no pasó");
  });

  // ── LA COTIZACIÓN: UNA POR LO QUE SE TIPEA, NINGUNA POR DEBAJO DEL MÍNIMO, Y EL ERROR SE LIMPIA ──
  //
  // MUTANTES QUE MATAN, y son TRES porque el hallazgo eran tres defectos en el mismo efecto:
  //   · `MW-17a` — que el pedido NO se difiera (el cuerpo del `setTimeout` corre dentro del propio
  //     efecto) ⇒ cae (B): `pedidos` queda `[9, 95]`, que es la misma forma que el AR midió (`[2, 25]`).
  //     ⚠️ Y ACÁ VA EL LÍMITE, MEDIDO Y NO RAZONADO: el primer intento de este mutante fue
  //     `setTimeout(…, 0)` y **SOBREVIVIÓ** (`8 passed`). El motivo es estructural: con temporizadores
  //     falsos el tiempo sólo avanza cuando el `it` lo avanza, y la limpieza del efecto cancela el
  //     temporizador anterior en cada tecla ⇒ con CUALQUIER demora, incluida 0, las dos teclas
  //     colapsan en un pedido. ⇒ **lo que este `it` clava es que el pedido esté DIFERIDO fuera del
  //     render, ⛔ NO que la demora sean 300 ms.** El valor vive en `MS_DE_ESPERA_DE_LA_COTIZACION` y
  //     ⛔ no lo vigila nada de acá.
  //   · `MW-17b` — cambiar el corte del mínimo por `monto > 0` ⇒ cae (A).
  //   · `MW-17c` — borrar el `setMotivo(null)` del `then` ⇒ cae (C): el banner queda junto a la cifra.
  // ⛔ FALSO KILLED A EVITAR en (B): tipear un monto POR DEBAJO del mínimo como primera tecla. Ahí el
  // corte del mínimo mata al mutante del debounce y el `×` no diría nada del debounce. Por eso las dos
  // teclas de (B) están las dos POR ENCIMA del mínimo, derivado de la constante de producción.
  it("T-374-W1-17: una sola cotización por lo tipeado, ninguna por debajo del mínimo, y el error no queda pegado", async () => {
    vi.useFakeTimers();
    try {
      const pedidos: number[] = [];
      let debeFallar = true;
      const base = buildTestContainer();
      const container: Container = {
        ...base,
        previewQuote: {
          execute: async (i: { amountUsd: number; method: string }) => {
            pedidos.push(i.amountUsd);
            if (debeFallar) throw new Error("a2a_quote_rejected");
            return base.previewQuote.execute(i as never);
          },
        } as unknown as Container["previewQuote"],
      };
      montar({ container, pasoDeArranque: "envio" });
      const campo = screen.getByLabelText("Cuánto mandás");

      // ── (A) POR DEBAJO DEL MÍNIMO NO SE COTIZA ────────────────────────────────────────────────
      // El monto sale de la constante de producción: ⛔ acá no se escribe ninguna cifra.
      fireEvent.change(campo, { target: { value: String(MIN_SEND_USD - 1) } });
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(
        pedidos,
        "se pidió una cotización por debajo del mínimo: el agente la rechaza igual, así que es un viaje garantizado a un error",
      ).toEqual([]);

      // ── (B) UNA SOLA COTIZACIÓN POR LO TIPEADO, Y ES LA DEL MONTO FINAL ───────────────────────
      const primera = MIN_SEND_USD + 4;
      const segunda = primera * 10 + 5;
      fireEvent.change(campo, { target: { value: String(primera) } });
      fireEvent.change(campo, { target: { value: String(segunda) } });
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(
        pedidos,
        "se pidió una cotización POR TECLA: la del monto a medio escribir no la pidió nadie",
      ).toEqual([segunda]);
      // Y el error de esa cotización SÍ se ve: sin esto, la limpieza de (C) sería indistinguible de
      // un banner que nunca se prendió.
      expect(
        screen.getByText("No pudimos terminar ese paso"),
        "la cotización falló y la pantalla no dice nada",
      ).toBeInTheDocument();

      // ── (C) EL CAMINO FELIZ LIMPIA EL MOTIVO ─────────────────────────────────────────────────
      debeFallar = false;
      const tercera = segunda + 1;
      fireEvent.change(campo, { target: { value: String(tercera) } });
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(pedidos, "la tercera cotización no se pidió: lo de abajo pasaría por vacío").toEqual([
        segunda,
        tercera,
      ]);
      expect(
        screen.getByText("Es lo que le llega a quien recibe."),
        "la cotización buena no llegó a la pantalla",
      ).toBeInTheDocument();
      expect(
        screen.queryByText("No pudimos terminar ese paso"),
        "el banner de error quedó pegado JUNTO a la cotización correcta: es copy que dice que algo falló cuando no falló",
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── EL CORTE POR EL MÍNIMO SE LE DICE A LA PERSONA (CR/BLQ-MED-2) ──────────────────────────────
  //
  // MUTANTE QUE MATA (`MW-24`): en `./recorrido.tsx`, `const porDebajoDelMinimo = false;` ⇒ cae la
  // primera aserción, la del `role="alert"`.
  // MUTANTE QUE TAMBIÉN MATA (`MW-24b`): en `./pantallas.tsx`, escribir la cifra a mano en vez de
  // interpolar la constante ⇒ cae la aserción que compara contra `MIN_SEND_USD` el día que la
  // constante cambie. ⚠️ DECLARADO: mientras la constante valga lo que hoy vale, ese mutante ⛔ NO
  // muere, y por eso la aserción de la cifra ⛔ no se cuenta como el candado del mutante. Lo que sí
  // clava este `it` es que el mensaje EXISTA, que sea un `alert` y que lleve la cifra.
  // ⛔ FALSO KILLED A EVITAR: afirmar sólo que «Seguir» está en gris. Eso ya era cierto ANTES del
  // arreglo —el gate del mínimo existía— y el hallazgo era justamente que la persona no sabía por
  // qué. Lo que se afirma es el TEXTO, y que el hueco ⛔ deje de pedir lo que ya se hizo.
  it("T-374-W1-18: por debajo del mínimo la pantalla DICE por qué no cotiza, y no repite «escribí el monto»", async () => {
    vi.useFakeTimers();
    try {
      montar({ pasoDeArranque: "envio" });
      const campo = screen.getByLabelText("Cuánto mandás");

      // CALIBRACIÓN 1 · CON EL CAMPO VACÍO NO SE LE GRITA A NADIE. Sin esto, un mensaje que estuviera
      // SIEMPRE pasaría la aserción de abajo y sería indistinguible del arreglo.
      expect(
        screen.queryByRole("alert"),
        "la pantalla avisa del mínimo con el campo vacío: le está reclamando a alguien que todavía no escribió nada",
      ).toBeNull();

      // ── EL CASO ─────────────────────────────────────────────────────────────────────────────
      // El monto sale de la constante de producción: ⛔ acá no se escribe ninguna cifra.
      fireEvent.change(campo, { target: { value: String(MIN_SEND_USD - 1) } });
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      const aviso = screen.getByRole("alert");
      expect(
        aviso.textContent ?? "",
        "por debajo del mínimo la pantalla no dice por qué no hay cotización: «Seguir» queda en gris sin motivo, en la única pantalla donde se escribe algo",
      ).toContain("El mínimo para enviar es");
      // Y la cifra es LA CONSTANTE, no un número escrito al lado.
      expect(
        aviso.textContent ?? "",
        "el mensaje del mínimo no lleva la cifra de `MIN_SEND_USD`: estaría anunciando un mínimo que no es el que corta",
      ).toContain(String(MIN_SEND_USD));
      // ⛔ Y EL HUECO DEJÓ DE PEDIR LO QUE LA PERSONA ACABA DE HACER.
      expect(
        screen.queryByText("Escribí el monto y te decimos cuánto llega."),
        "el hueco sigue pidiendo el monto que la persona ya escribió: dos textos sobre el mismo hecho y ninguno útil",
      ).toBeNull();
      // «Seguir» sigue en gris, que es la mitad que ya existía: el arreglo AGREGA el motivo.
      expect(
        screen.getByRole("button", { name: "Seguir" }),
        "«Seguir» dejó de estar deshabilitado por debajo del mínimo",
      ).toBeDisabled();
      revisarCopy(document.body.textContent ?? "", "la pantalla del envío por debajo del mínimo");

      // CALIBRACIÓN 2 · CON UN MONTO VÁLIDO EL MENSAJE SE VA. Sin esto, un `alert` pegado para
      // siempre pasaría todo lo de arriba.
      fireEvent.change(campo, { target: { value: String(MIN_SEND_USD + 5) } });
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
      expect(
        screen.queryByRole("alert"),
        "el aviso del mínimo quedó pegado con un monto que SÍ cotiza: es copy que dice que algo está mal cuando no lo está",
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── EL ESTADO EN VUELO SE APAGA (CR/BLQ-MED-3) ────────────────────────────────────────────────
  //
  // MUTANTE QUE MATA (`MW-25`): en `./recorrido.tsx`, borrar el `useEffect` que hace
  // `setEnVuelo(false)` con `[paso]` ⇒ cae la aserción (A).
  // MUTANTE QUE MATA (`MW-25b`): borrar el efecto de `visibilitychange`/`pageshow` ⇒ cae la (B).
  // ⛔ FALSO KILLED A EVITAR: mirar sólo que el texto esté al tocar el enlace. Eso ya pasaba ANTES:
  // el defecto no era que no se prendiera, era que ⛔ NO SE APAGABA NUNCA, así que las dos mitades
  // que cuentan son las de después. Por eso primero se afirma que el texto ESTÁ (si no, lo de abajo
  // pasaría por vacío) y recién después que se fue.
  it("T-374-W1-22: el estado «estamos en la otra app» se apaga al cambiar de paso y al volver a la pestaña", async () => {
    const base = buildTestContainer();
    const container: Container = {
      ...base,
      startKyc: {
        execute: async () => ({ kind: "redirect", url: DESTINO_DEL_VERIFICADOR }) as const,
      } as unknown as Container["startKyc"],
    };
    montar({ container, pasoDeArranque: "envio" });
    cargarElEnvio();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Seguir" }));
    });
    await screen.findByRole("heading", { name: "Tu identidad" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verificar mi identidad" }));
    });
    tocarSinNavegar(await screen.findByRole("link", { name: "Verificar mi identidad" }));

    // Calibración: el texto TIENE que estar acá, o las dos mitades de abajo no dirían nada.
    expect(
      document.body.textContent ?? "",
      "tocar el enlace no dejó el texto del estado en vuelo: lo de abajo pasaría por vacío",
    ).toContain(TEXTO_EN_VUELO_IDENTIDAD);

    // ── (A) CAMBIAR DE PASO LO APAGA ────────────────────────────────────────────────────────────
    //
    // 🔴 SE VUELVE AL MISMO PASO, Y ⛔ NO SE MIRA LA PANTALLA DEL MEDIO. Ésta es la reproducción
    // LITERAL del CR —«Volver» y después «Seguir»— y la forma es load-bearing: mirar la pantalla del
    // envío no mide NADA, porque esa pantalla ⛔ no renderiza el bloque en vuelo en ningún caso, así
    // que el texto desaparece de ahí con apagador y sin él. MEDIDO: con el `useEffect` del apagador
    // atado a `[]` en vez de a `[paso]`, esa versión de esta aserción daba **13 passed**. Un control
    // vacío y un control que funciona se ven exactamente igual desde afuera.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Volver" }));
    });
    await screen.findByRole("heading", { name: "Cuánto y para quién" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Seguir" }));
    });
    await screen.findByRole("heading", { name: "Tu identidad" });
    expect(
      document.body.textContent ?? "",
      "volver al paso del verificador lo encuentra diciendo «estamos en el verificador» con el navegador quieto, y esa frase sigue a la persona por el recorrido",
    ).not.toContain(TEXTO_EN_VUELO_IDENTIDAD);

    // ── (B) VOLVER A LA PESTAÑA LO APAGA, SIN CAMBIAR DE PASO ───────────────────────────────────
    // Es el caso del teléfono: se sale a la otra app y se vuelve con el botón del sistema, al MISMO
    // paso. Sin este apagador, (A) sola dejaría la frase puesta justo en el camino que la HU trata.
    // ⚠️ Acá el control YA es el enlace y ⛔ no el botón: el destino que el caso de uso contestó sigue
    // en el estado del anfitrión, así que volver a este paso no obliga a pedirlo de nuevo. Se dice
    // porque buscar el botón acá deja este `it` rojo por el instrumento y no por lo que mide.
    tocarSinNavegar(await screen.findByRole("link", { name: "Verificar mi identidad" }));
    expect(
      document.body.textContent ?? "",
      "el segundo toque no dejó el texto en vuelo: la mitad (B) pasaría por vacío",
    ).toContain(TEXTO_EN_VUELO_IDENTIDAD);
    // La pestaña vuelve a estar a la vista. ⛔ `visibilityState` es de sólo lectura en jsdom, así que
    // se declara el valor y se emite el evento: es el mismo par que el navegador entrega al volver.
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(
      document.body.textContent ?? "",
      "volver a la pestaña no apagó «estamos en el verificador»: la frase se queda para siempre si no se cambia de paso",
    ).not.toContain(TEXTO_EN_VUELO_IDENTIDAD);
  });

  // ── EL SEGUNDO TOQUE NO LLEGA AL CASO DE USO, Y EL PRIMERO SE VE (CR/BLQ-MED-4) ────────────────
  //
  // MUTANTE QUE MATA (`MW-26`): en `./recorrido.tsx`, borrar el `if (enCursoRef.current) return;` de
  // `conGuarda` ⇒ cae (A), el conteo de llamadas.
  // MUTANTE QUE MATA (`MW-26b`): en `./pantallas.tsx`, sacarle el `disabled` y la etiqueta en curso
  // al botón de `Salir` ⇒ cae (B), la que mira lo que la persona VE.
  // ⛔ FALSO KILLED A EVITAR: medir sólo con `disabled`. Un `disabled` que llega tarde —porque el
  // render no alcanzó a pintarse entre dos toques— dejaría pasar la segunda llamada igual, y el
  // conteo es lo único que lo distingue. Por eso (A) usa un caso de uso que ⛔ NO resuelve, o sea el
  // escenario real: la red tardando.
  it("T-374-W1-23: el segundo toque ⛔ no vuelve a llamar al caso de uso, y entre el toque y el enlace la pantalla cambia", async () => {
    let llamadas = 0;
    let resolver: (() => void) | null = null;
    const base = buildTestContainer();
    const container: Container = {
      ...base,
      connectWallet: {
        execute: async () => {
          llamadas++;
          // ⛔ No resuelve hasta que el `it` lo diga: es la ventana en la que la persona toca de nuevo.
          await new Promise<void>((r) => {
            resolver = r;
          });
          return { estado: "hay-que-salir", address: FAKE_WALLET_ADDRESS, irA: DESTINO_DE_LA_BILLETERA } as const;
        },
      } as unknown as Container["connectWallet"],
    };
    montar({ container });
    const boton = screen.getByRole("button", { name: "Conectar mi billetera" });

    // ── (A) TRES TOQUES, UNA SOLA LLAMADA ───────────────────────────────────────────────────────
    await act(async () => {
      fireEvent.click(boton);
    });
    expect(llamadas, "el primer toque no llamó al caso de uso: lo de abajo pasaría por vacío").toBe(1);
    fireEvent.click(boton);
    fireEvent.click(boton);
    expect(
      llamadas,
      "el segundo y el tercer toque volvieron a llamar al caso de uso: del otro lado hay un depósito y una cuota de proveedor",
    ).toBe(1);

    // ── (B) Y LA PANTALLA CAMBIÓ ENTRE EL TOQUE Y EL ENLACE ─────────────────────────────────────
    // El hallazgo del CR no era sólo que se pudiera tocar dos veces: era que ⛔ no cambiaba un solo
    // pixel, así que tocar de nuevo era lo razonable. Se afirman las DOS mitades de lo que se ve.
    const enCurso = screen.getByRole("button", { name: ETIQUETA_CONECTANDO });
    expect(
      enCurso,
      "entre el toque y el enlace el botón sigue diciendo lo mismo: la persona no tiene forma de saber que el primer toque hizo algo",
    ).toBeInTheDocument();
    expect(enCurso, "el botón en curso se puede volver a tocar").toBeDisabled();
    revisarCopy(document.body.textContent ?? "", "la pantalla de entrada con el connect en curso");

    // ── (C) Y CUANDO EL CASO DE USO CONTESTA, LOS CONTROLES VUELVEN ─────────────────────────────
    // Sin esto, apagar el botón para siempre pasaría (A) y (B) y dejaría a la persona sin salida.
    await act(async () => {
      resolver?.();
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("link", { name: "Abrir mi billetera" }),
      "el caso de uso contestó y el salto no apareció: los controles quedaron apagados para siempre",
    ).toBeInTheDocument();
  });

  // ── EL TESTIGO DE LOS 300 ms DUPLICADOS (CR/MNR-1) ────────────────────────────────────────────
  //
  // MUTANTE QUE MATA (`MW-27`): en `./recorrido.tsx`, `MS_DE_ESPERA_DE_LA_COTIZACION = 0` ⇒ cae la
  // comparación. Antes de este `it` ese mutante daba la suite ENTERA en verde, y por eso «los mismos
  // 300 ms que el árbol viejo» era una frase que nadie podía refutar.
  // ⛔ FALSO KILLED A EVITAR: escribir `300` acá. Eso ataría la copia a un número de este archivo y
  // no al ORIGINAL, que es lo único que la frase afirma. El número se EXTRAE del fuente del árbol
  // viejo, y la calibración exige que la extracción haya encontrado algo.
  // ⛔ Cita SIN ancla y SIN número de línea a propósito: `../flow.tsx` lleva marcadores de censo de
  // citas entrantes por número.
  it("T-374-W1-19: la espera de la cotización es la MISMA que la del árbol viejo, leída de su fuente", () => {
    const viejo = readFileSync(path.join(process.cwd(), "src/presentation/flow.tsx"), "utf8");
    // El debounce del árbol viejo: desde el pedido de cotización hasta el cierre de su `setTimeout`.
    const m = /previewQuote\.execute\([\s\S]*?\},\s*(\d+)\);/.exec(viejo);
    expect(
      m,
      "no se encontró el debounce de la cotización en el árbol viejo: el testigo no estaría comparando con nada",
    ).not.toBeNull();
    const delViejo = Number(m?.[1]);
    expect(
      Number.isFinite(delViejo) && delViejo > 0,
      "el número extraído del árbol viejo no es una espera: la extracción está midiendo otra cosa",
    ).toBe(true);
    expect(
      MS_DE_ESPERA_DE_LA_COTIZACION,
      "la espera de la cotización del recorrido nuevo dejó de ser la del árbol viejo, y el docblock dice que son la misma",
    ).toBe(delViejo);
  });

  // ── LOS DOS PREDICADOS QUE CIERRAN LAS MENTIRAS, CALIBRADOS CONTRA EL COPY QUE SE FUE ──────────
  //
  // 🔴 SIN ESTO, LOS DOS `not.toMatch` DE `revisarCopy` SON INDISTINGUIBLES DE DOS LÍNEAS QUE NO
  // PUEDEN FALLAR. Las frases de abajo son los LITERALES que estaban renderizados en `5afe979`, y lo
  // que se afirma es que el predicado las habría puesto en rojo. ⛔ No alcanza con que hoy no estén.
  it("T-374-W1-24: los predicados de copy cazan las dos frases que le mentían a la persona", () => {
    const mentiras = [
      "Se guarda solo mientras lo completás.",
      "Una vez sola. Después de esto, tus próximos envíos no la vuelven a pedir.",
    ];
    for (const frase of mentiras) {
      let cazada = false;
      try {
        revisarCopy(`${NO_CUSTODIAL} ${frase} ${"relleno ".repeat(12)}`, "el control de calibración");
      } catch {
        cazada = true;
      }
      expect(
        cazada,
        `el barrido de copy NO caza «${frase}»: el predicado que la prohíbe no puede fallar y no está midiendo nada`,
      ).toBe(true);
    }
    // Y el control positivo: un copy sano ⛔ NO se pone rojo, o el barrido estaría prohibiendo todo.
    expect(() =>
      revisarCopy(`${NO_CUSTODIAL} Verificamos quién sos antes de mandar la plata. ${"relleno ".repeat(12)}`, "el control positivo"),
    ).not.toThrow();
  });
});
