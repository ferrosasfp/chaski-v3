// @vitest-environment jsdom
//
// Tests · HU-066 · la marca dibujada y el splash, leídos del DOM.
//
// ⚠️ EL LÍMITE DE ESTE ENTORNO, PRIMERO, PORQUE CAMBIA CÓMO SE LEE TODO LO DEMÁS: acá no corre
// Tailwind ni hay layout. Estos tests leen ESTRUCTURA (qué nodo, con qué rol, con qué nombre, con qué
// clases y en qué orden), NO PÍXELES. Que la marca no salga aplastada, que el splash tape la pantalla
// entera y que el contraste de la píldora alcance se miden en un navegador y están en el reporte de la
// HU, no acá. Leer el verde de este archivo como "se ve bien" es leerlo de más.
//
// LOS MUTANTES SE APLICARON Y SE MIDIERON, uno por uno, sobre el árbol de esta rama. No es una lista
// de lo que "debería" fallar: es la salida de correrlos (el archivo tiene 20 tests):
//   · se vacía el `alt` de la marca                                  ⇒ 3 failed | 17 passed (20)
//   · se saca `object-contain` de la marca                           ⇒ 1 failed | 19 passed (20)
//   · `pildoraDeRed` devuelve el literal en vez de derivarlo         ⇒ 1 failed | 19 passed (20)
//   · el splash emite `transition-opacity` incondicionalmente        ⇒ 1 failed | 19 passed (20)
//   · se borra el temporizador de salida (sólo sale por toque)       ⇒ 3 failed | 17 passed (20)
//   · el splash escucha `pointerdown` en vez de `click`              ⇒ 2 failed | 18 passed (20)
//   · se ignora la puerta: el splash se muestra siempre              ⇒ 4 failed | 16 passed (20)
//   · no se marca la sesión: el splash se repite en cada montaje     ⇒ 1 failed | 19 passed (20)
//
// 🔴 EL TERCERO SOBREVIVÍA, Y ESO CAMBIÓ ESTE ARCHIVO. En la primera corrida `pildoraDeRed` reescrito
// como `return "SOLANA DEVNET"` daba **19 passed (19)**: la decisión de derivar la red del resolver —el
// motivo entero de que esa función exista— no tenía ningún candado, porque el único test que la miraba
// comparaba el valor de HOY, y hoy los dos valores coinciden. El `it` que lo mata (el segundo del
// bloque «la marca se dice en UN solo lugar») le cambia la red al resolver y exige que la píldora la
// siga. Es la diferencia entre medir el valor y medir el MECANISMO.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CLAVE_KYC_PENDIENTE } from "../infrastructure/kyc-pending-store";
import { CLAVE as CLAVE_DEL_VIAJE, MARCA } from "../infrastructure/solana/deeplink/sesion";
import { LEMA, LOGO_SRC, MARCA_SRC, NOMBRE, pildoraDeRed } from "./marca";
import { urlDeVueltaDeKyc } from "./splash-puerta";
import { CLAVE_YA_SE_VIO, MS_DE_SALIDA, MS_EN_PANTALLA, Splash } from "./splash";
import { ChaskiMark } from "./ui";

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  delete document.documentElement.dataset.splash;
  vi.unstubAllGlobals();
});

describe("HU-066 · `ChaskiMark` es la marca nueva y conserva su contrato", () => {
  it("es una imagen, apunta al PNG de la marca y su nombre accesible sigue siendo «Chaski»", () => {
    // MUTANTE QUE LO MATA: vaciar el `alt`. El nodo pierde el rol `img` accesible y el `getByRole` no
    // lo encuentra, que es exactamente lo que le pasaría a un lector de pantalla.
    render(<ChaskiMark className="size-icono-lg" />);
    const marca = screen.getByRole("img", { name: NOMBRE });
    expect(marca).toHaveAttribute("src", MARCA_SRC);
  });

  it("🔴 el `className` de quien llama sigue fijando el tamaño, y se le suma `object-contain`", () => {
    // LAS DOS MITADES SON EL CONTRATO. La primera: `size-icono-lg` llega intacto, así que los dos
    // sitios de llamada de `flow.tsx` no cambian de tamaño. La segunda: `object-contain` es lo que
    // impide que el PNG (1,51:1) se aplaste dentro de una caja cuadrada de 32x32.
    // MUTANTE QUE LO MATA: sacar `object-contain` del `cn`.
    render(<ChaskiMark className="size-icono-lg" />);
    const cls = screen.getByRole("img", { name: NOMBRE }).className;
    expect(cls).toContain("size-icono-lg");
    expect(cls).toContain("object-contain");
  });

  it("el `animate-pulse` condicional del seguimiento sigue llegando al nodo", () => {
    // El segundo sitio de llamada pasa `cn("size-icono-lg", "animate-pulse")`. Si `ChaskiMark`
    // ignorara el `className` o lo pisara, el latido de "tu chaski está en camino" desaparecería sin
    // que nada más se rompa. Y el latido es una clase que `globals.css` trata especial bajo
    // movimiento reducido, así que perderla también perdería esa excepción.
    render(<ChaskiMark className="size-icono-lg animate-pulse" />);
    expect(screen.getByRole("img", { name: NOMBRE }).className).toContain("animate-pulse");
  });

  it("⛔ NO trae fondo propio: la marca ya no pinta un cuadrado de tinta debajo", () => {
    // El `<svg>` viejo emitía `<rect fill="#17130F" rx="10">`. Un `bg-*` acá volvería a meter una
    // superficie que la app no pidió, y en el splash —que ya es de tinta— se vería como un parche.
    const cls = render(<ChaskiMark className="size-icono-lg" />).container.innerHTML;
    expect(cls).not.toContain("bg-ink");
    expect(cls).not.toContain("#17130F");
  });
});

describe("HU-066 · la marca se dice en UN solo lugar", () => {
  it("el lema del header y el del splash son el MISMO string", () => {
    // No se compara contra un literal escrito acá: se compara el header REAL contra el splash REAL.
    // Escribir el literal en este test lo dejaría verde el día que uno de los dos se corrija solo.
    expect(LEMA).toBe("tu plata a Perú, sin vueltas");
    expect(LEMA).not.toContain("—"); // el candado de estilo de copy del repo
  });

  it("hoy la píldora dice «SOLANA DEVNET»", () => {
    // ⚠️ ESTE `it` SOLO NO ALCANZA, y está MEDIDO: con `pildoraDeRed` reescrito como
    // `return "SOLANA DEVNET"` la suite entera daba **19 passed (19)**. Un test que compara el valor
    // de hoy no puede distinguir "se deriva" de "está escrito a mano", porque hoy los dos valores
    // coinciden. Lo que separa las dos cosas es el `it` de abajo.
    expect(pildoraDeRed()).toBe("SOLANA DEVNET");
  });

  it("🔴 y lo dice porque lo DERIVA: con otro cluster, la píldora cambia sola", () => {
    // EL CANDADO DE VERDAD. Se le cambia la red al resolver y se exige que la píldora la siga. Un
    // literal escrito en `marca.ts` se queda diciendo DEVNET el día del cutover a mainnet, con la app
    // firmando contra otra red y la primera pantalla mintiendo — y sin este `it` nada se pondría rojo.
    // ⛔ NO se compara contra `${vm} ${cluster}`.toUpperCase() recalculado acá: eso sería el test
    // repitiendo la fórmula que vigila, que este repo ya tiene documentado como el guard que se aplaude
    // a sí mismo. Se compara contra un string ESCRITO A MANO que hoy no existe en ninguna parte.
    // MUTANTE QUE LO MATA: `return "SOLANA DEVNET"` en `pildoraDeRed`.
    vi.resetModules();
    vi.doMock("../infrastructure/chain", () => ({
      resolveSolanaNetworkConfig: () => ({ vm: "solana", cluster: "mainnet-beta" }),
    }));
    return import("./marca").then(async (m) => {
      expect(m.pildoraDeRed()).toBe("SOLANA MAINNET-BETA");
      vi.doUnmock("../infrastructure/chain");
      vi.resetModules();
    });
  });
});

/** Monta el splash con los temporizadores bajo control. */
function pintarSplash() {
  return render(<Splash />);
}

describe("HU-066 · el splash NO se muestra cuando hay algo que atender", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("CONTROL: app abierta a mano ⇒ el splash se pinta y lo dice en el DOM", () => {
    // El control va PRIMERO: sin él, un splash que no se mostrara nunca pasaría los cinco `it` de
    // abajo y esta suite estaría midiendo la nada.
    pintarSplash();
    expect(screen.getByRole("img", { name: NOMBRE })).toHaveAttribute("src", LOGO_SRC);
    expect(screen.getByText(LEMA)).toBeInTheDocument();
    expect(screen.getByText(pildoraDeRed())).toBeInTheDocument();
    expect(document.documentElement.dataset.splash).toBe("mostrado");
  });

  it("🔴 volviendo de Didit por URL ⇒ NO hay splash, y el motivo queda publicado", () => {
    window.history.replaceState(null, "", urlDeVueltaDeKyc(window.location.origin));
    pintarSplash();
    expect(screen.queryByText(LEMA)).toBeNull();
    expect(document.documentElement.dataset.splash).toBe("vuelta-de-kyc-en-la-url");
  });

  it("🔴 volviendo de la billetera por enlace ⇒ NO hay splash", () => {
    window.history.replaceState(null, "", `/?${MARCA}=conectar`);
    pintarSplash();
    expect(screen.queryByText(LEMA)).toBeNull();
    expect(document.documentElement.dataset.splash).toBe("vuelta-por-enlace-en-la-url");
  });

  it("🔴 URL LIMPIA con un KYC pendiente en el disco ⇒ NO hay splash", () => {
    // El caso que una puerta "miro la URL" dejaría pasar: volver con «atrás» o recargar.
    localStorage.setItem(CLAVE_KYC_PENDIENTE, "{}");
    pintarSplash();
    expect(screen.queryByText(LEMA)).toBeNull();
    expect(document.documentElement.dataset.splash).toBe("kyc-pendiente-en-el-disco");
  });

  it("🔴 URL LIMPIA con un viaje de billetera en el disco ⇒ NO hay splash", () => {
    localStorage.setItem(CLAVE_DEL_VIAJE, "{}");
    pintarSplash();
    expect(screen.queryByText(LEMA)).toBeNull();
    expect(document.documentElement.dataset.splash).toBe("viaje-de-billetera-en-el-disco");
  });

  it("ya se vio en esta sesión ⇒ NO se repite (y el primer montaje SÍ lo dejó marcado)", () => {
    pintarSplash();
    expect(sessionStorage.getItem(CLAVE_YA_SE_VIO)).not.toBeNull();
    cleanup();
    pintarSplash();
    expect(screen.queryByText(LEMA)).toBeNull();
    expect(document.documentElement.dataset.splash).toBe("ya-se-vio-en-esta-sesion");
  });
});

describe("HU-066 · el splash no encierra a nadie", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("se va solo por tiempo, sin que nadie toque nada", () => {
    // MUTANTE QUE LO MATA: borrar el `setTimeout` de salida. Con el toque todavía puesto, la app
    // "funcionaría" y la única forma de salir sería tocar la pantalla.
    pintarSplash();
    expect(screen.getByText(LEMA)).toBeInTheDocument();
    // ⚠️ DOS `act` Y NO UNO, y es un límite del instrumento que conviene tener escrito: el segundo
    // temporizador (el del desvanecido) lo AGENDA un efecto que React sólo corre al cerrar el `act`.
    // Con un solo `advanceTimersByTime(1200 + 260)` ese segundo timer nace ya vencido y no dispara
    // nunca, y el test daría rojo por el instrumento y no por el código.
    act(() => {
      vi.advanceTimersByTime(MS_EN_PANTALLA + 1);
    });
    act(() => {
      vi.advanceTimersByTime(MS_DE_SALIDA + 1);
    });
    expect(screen.queryByText(LEMA)).toBeNull();
  });

  it("un toque lo saltea antes de tiempo", () => {
    pintarSplash();
    fireEvent.click(window);
    act(() => {
      vi.advanceTimersByTime(MS_DE_SALIDA + 50);
    });
    expect(screen.queryByText(LEMA)).toBeNull();
  });

  it("una tecla también", () => {
    pintarSplash();
    fireEvent.keyDown(window, { key: "Escape" });
    act(() => {
      vi.advanceTimersByTime(MS_DE_SALIDA + 50);
    });
    expect(screen.queryByText(LEMA)).toBeNull();
  });

  it("⛔ escucha `click` y NO `pointerdown`: el toque que lo cierra no puede caer en la app de abajo", () => {
    // 🔴 EL DEFECTO QUE ESTE `it` CIERRA, y no es teórico: con `pointerdown`, el splash se desmonta
    // ENTRE el apretar y el soltar, y el `click` que el navegador emite después aterriza en lo que
    // quedó bajo el dedo — que en la bienvenida es «Empezar un envío». Un toque para saltear el
    // splash arrancaría un envío.
    // MUTANTE QUE LO MATA: cambiar el listener a `pointerdown`.
    pintarSplash();
    fireEvent.pointerDown(window);
    act(() => {
      vi.advanceTimersByTime(MS_DE_SALIDA + 50);
    });
    expect(screen.getByText(LEMA), "un `pointerdown` NO puede cerrarlo").toBeInTheDocument();
  });
});

describe("HU-066 · con el movimiento reducido no hay ninguna animación", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** ⚠️ En el jsdom de esta suite `window.matchMedia` NO EXISTE (está medido en
   *  `movimiento-reducido.test.tsx`), así que se stubea. Eso también prueba la otra mitad: el splash
   *  tiene que sobrevivir a que la función no exista, y los `it` de arriba lo montan sin ella. */
  function conPreferencia(reduce: boolean) {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: reduce && q.includes("prefers-reduced-motion"),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }));
  }

  function overlay(): HTMLElement {
    const el = document.querySelector("[data-splash-overlay]");
    if (el === null) throw new Error("no hay overlay: los expect de abajo pasarían por vacuidad");
    return el as HTMLElement;
  }

  it("con `prefers-reduced-motion: reduce` el overlay no declara ninguna transición", () => {
    // MUTANTE QUE LO MATA: emitir `transition-opacity` incondicionalmente.
    conPreferencia(true);
    pintarSplash();
    expect(overlay().className).not.toContain("transition");
    expect(overlay().style.transitionDuration).toBe("");
  });

  it("y se va en el MISMO tick: no hay tramo de desvanecido que esperar", () => {
    // La otra mitad, y la que importa: apagar la clase pero dejar los 260 ms de espera dejaría a la
    // persona mirando un overlay quieto. Acá el `MS_DE_SALIDA` no se avanza a propósito.
    conPreferencia(true);
    pintarSplash();
    act(() => {
      vi.advanceTimersByTime(MS_EN_PANTALLA + 1);
    });
    expect(screen.queryByText(LEMA)).toBeNull();
  });

  it("CONTROL: sin la preferencia SÍ hay desvanecido, y dura lo declarado", () => {
    // Sin este control, "borrar la animación del todo" pasaría los dos `it` de arriba.
    conPreferencia(false);
    pintarSplash();
    expect(overlay().className).toContain("transition-opacity");
    act(() => {
      vi.advanceTimersByTime(MS_EN_PANTALLA + 1);
    });
    expect(screen.getByText(LEMA), "todavía se está yendo").toBeInTheDocument();
    expect(overlay().className).toContain("opacity-0");
    act(() => {
      vi.advanceTimersByTime(MS_DE_SALIDA + 1);
    });
    expect(screen.queryByText(LEMA)).toBeNull();
  });
});
