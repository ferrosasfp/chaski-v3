// @vitest-environment jsdom
//
// Tests — WKH-346: el comprobante de una transacción Solana se trunca, se enlaza y se puede copiar.
//
// EL DEFECTO QUE CIERRAN, con su medida. Cinco lugares le muestran a la persona una firma base58 de
// Solana. Tres la imprimían ENTERA —los 87 caracteres de `FAKE_SOLANA_SIGNATURE`, el fixture con el que se mide acá— dentro de una app de UNA columna, y desbordaban la tarjeta. ⚠️ 87 NO es "el largo de una firma ed25519 en base58", que es lo que afirmaba esta línea (AR/MNR-2): una firma de 64 bytes mide **87 u 88 caracteres, y 88 en la mayoría de los casos**. Medido con el `bs58` del repo, 4000 muestras: 3209 dieron 88 y 791 dieron 87 (80,2 % / 19,8 %); el largo depende del primer byte. Los 87 son propiedad DEL FIXTURE —`new Uint8Array(64).fill(7)`, `fakes.ts:835`—, no de la clase.
// Los otros dos ya la acortaban y no llevaban a
// ninguna parte, así que quien quería auditar su transacción no tenía el valor completo ni un enlace.
//
// ⚠️ QUÉ CLAVAN ESTOS TESTS Y QUÉ NO, porque la diferencia es grande:
//   · SÍ prueban que el texto visible son 17 caracteres y no 87, sobre el DOM realmente renderizado.
//   · SÍ prueban que la firma COMPLETA sobrevive en el `href` y en el `title`, o sea que truncar no
//     perdió información.
//   · SÍ prueban los TRES desenlaces del copiado, incluido el de "no se pudo".
//   · NO prueban que el comprobante deje de desbordar en un teléfono. jsdom no hace layout: acá se lee
//     el NÚMERO QUE ESTÁ EN EL NOMBRE DE LA CLASE (`min-h-[44px]` ⇒ 44) y la PRESENCIA de `break-all`.
//     Que esas clases produzcan 44 px y el quiebre lo hace Tailwind y esta suite no lo verifica. Es el
//     mismo alcance declarado que `touch-targets.test.tsx` (ver su cabecera).
//   · NO prueban que `explorer.solana.com` sirva la ruta que se emite: es un tercero. Que la sirva hoy
//     sale de un precedente del propio repo (`scripts/smoke-solana-e2e.ts:567`), no de esta HU.
//   · NO prueban que Safari en iOS acepte `writeText` en este handler. Se mide contra un
//     `navigator.clipboard` STUBBEADO — y precisamente por eso el control tiene tres estados y no dos.
//
// Y un agujero que NINGÚN test de este archivo puede cubrir: reemplazar el `switch` de
// `resolveSolanaExplorerTxUrl` por la URL con el cluster pegado en un literal. El día que la config sea
// mainnet el enlace apuntaría a devnet en silencio y todo acá seguiría verde. Está escrito en el
// docblock de esa función, al lado del código.
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  LostEscrowRecovery,
  Receipt,
  recoveryMoreEscrowsHint,
  recoveryWindowExhausted,
  TrackView,
  TxProof,
} from "./flow";
import { Money } from "../domain/money";
import { MAX_RECOVERY_CANDIDATES } from "../infrastructure/solana-wallet";
import {
  type KycVerification,
  Remittance,
  type RemittanceState,
  toPersistedIdentity,
} from "../domain/remittance";
import {
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FakeSolanaEscrowRefundGateway,
  T0,
  beneficiary,
} from "../test-support/fakes";

afterEach(cleanup);

// La forma TRUNCADA, escrita A MANO: primeros 8 + `…` + últimos 8. No se calcula con `shortTx` a
// propósito — un valor esperado que llamara a la función bajo prueba se movería junto con el mutante
// (subir el umbral `tx.length <= 16`) y el assert pasaría siempre, igual que advierte
// `chain.test.ts:86-89` para los números de ComputeBudget.
const SIGNATURE_CORTA = "99eUso3a…FzQyEQf8";

// T-346-17: un tamaño de ventana que NO es el de producción. Ver el docblock de ese describe: llamar
// a las funciones de copy con el valor real las dejaría verdes ante un literal escrito a mano.
const VALOR_DE_PRUEBA = 7;

const resolveSender = async () => FAKE_SOLANA_BENEFICIARY;

/** El px declarado en el nombre de la clase del elemento renderizado. Copiado de `minHpx` en
 *  `touch-targets.test.tsx:66-73` en vez de importado, porque ahí es una función de módulo no
 *  exportada; se duplica igual que los 9 `passKyc` locales del repo. Lo que NO se cambia al copiarlo
 *  es que falle RUIDOSAMENTE: un helper que devolviera 0 haría pasar el `expect` de abajo por vacuidad,
 *  y un candado que no encuentra lo que vigila es un candado que dejó de existir. */
function minHpx(el: HTMLElement): number {
  const m = /(?:^|\s)min-h-\[(\d+)px\]/.exec(el.className);
  if (m === null)
    throw new Error(
      `«${el.textContent}» no declara ningún min-h-[Npx]. className = «${el.className}»`,
    );
  return Number(m[1]);
}

/** Reemplaza `navigator.clipboard` por el doble pedido. `undefined` simula el caso REAL de un contexto
 *  no seguro, donde la API entera no existe. Mismo mecanismo que `wallet-availability.test.tsx:62`. */
function stubClipboard(writeText: ((value: string) => Promise<void>) | undefined): void {
  Object.defineProperty(window.navigator, "clipboard", {
    value: writeText === undefined ? undefined : { writeText },
    configurable: true,
  });
}

const passIdentity = toPersistedIdentity({
  firstName: "Test",
  lastNamePaternal: "Quispe",
  lastNameMaternal: "Mamani",
  documentType: "DNI",
  documentNumber: "12345678",
  dateOfBirth: "1990-01-01",
  nationality: "PE",
});
const passKyc: KycVerification = {
  verificationId: "v-1",
  approved: true,
  payoutAllowed: true,
  riskLevel: "low",
  provenance: "didit",
  identity: passIdentity,
};

/** Snapshot construido POR EL DOMINIO y no como objeto literal: las transiciones son las que la app
 *  hace de verdad, así que si mañana `markRefunded` exige otra precondición esto no compila en vez de
 *  seguir midiendo un estado imposible. `principalTx` queda en "0xp" (3 caracteres) para que la ÚNICA
 *  firma larga de la pantalla sea la del reembolso y los asserts no puedan confundir una con otra. */
function snapshotConReembolso(): RemittanceState {
  const r = Remittance.create("rem-1", beneficiary(), Money.of(400, "USDC"), T0);
  r.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(1478.15, "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt: "2099-01-01T00:00:00.000Z",
      provenance: "didit",
    },
    T0,
  );
  r.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  r.applyKyc(passKyc, T0);
  r.confirm(T0);
  r.markPrincipalIn("0xp", T0);
  r.markPayoutFailed("partner_down", T0);
  r.markRefunded(FAKE_SOLANA_SIGNATURE, T0);
  return r.snapshot;
}

/** El mismo camino hasta `settled`, con la firma LARGA en `principalTx` y sin reembolso: así el sitio 4
 *  del recibo es el único comprobante largo de esa pantalla. */
function snapshotConDeposito(): RemittanceState {
  const base = Remittance.create("rem-2", beneficiary(), Money.of(400, "USDC"), T0);
  base.attachQuote(
    {
      quoteId: "q",
      send: Money.of(400, "USDC"),
      receive: Money.of(1478.15, "PEN"),
      feeUsd: Money.of(0.5, "USDC"),
      rate: 3.7,
      etaMinutes: 30,
      expiresAt: "2099-01-01T00:00:00.000Z",
      provenance: "didit",
    },
    T0,
  );
  base.startKyc(T0, FAKE_SOLANA_BENEFICIARY);
  base.applyKyc(passKyc, T0);
  base.confirm(T0);
  base.markPrincipalIn(FAKE_SOLANA_SIGNATURE, T0);
  base.markPayoutSubmitted("p1", T0, "transfi");
  base.markSettled("0xs", Money.of(1478.15, "PEN"), T0);
  return base.snapshot;
}

/** El `<span>` de `TxProof` que contiene ESTE comprobante largo. Se resuelve subiendo desde el enlace y
 *  no con `getAllByTestId(...)[0]`: el recibo del sitio 5 renderiza DOS comprobantes —el depósito "0xp"
 *  y el reembolso— y tomar el primero mediría el corto mientras el largo puede estar roto. */
function comprobanteDe(enlace: HTMLElement): HTMLElement {
  const span = enlace.closest('[data-testid="tx-proof"]');
  if (span === null) throw new Error("el enlace del comprobante no está dentro de un TxProof");
  return span as HTMLElement;
}

/** Abre la puerta de "Recuperar un envío perdido" y dispara la búsqueda, que es lo que renderiza el
 *  desenlace. Mismo molde que `abrirPuerta` en `lost-escrow-recovery.test.tsx:42-45`. */
function buscarEscrows(gateway: FakeSolanaEscrowRefundGateway): void {
  render(<LostEscrowRecovery refund={gateway} resolveSender={resolveSender} />);
  fireEvent.click(screen.getByRole("button", { name: /Recuperar un envío perdido/ }));
  fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));
}

/**
 * Los CINCO sitios, cada uno con su montaje mínimo y montados DE UNO EN UNO. Montarlos juntos haría
 * que `getByRole("link", { name })` encontrara varios y un assert podría pasar por el sitio equivocado
 * mientras el que se quería medir está roto.
 *
 * Los cinco son los del SDD: 1 seguimiento (referencia de reembolso), 2 la orden de recuperación sin
 * confirmar, 3 la recuperación exitosa —el sitio de la captura del founder—, 4 y 5 las dos filas del
 * recibo.
 */
const SITIOS: Array<{ nombre: string; montar: () => Promise<void> }> = [
  {
    nombre: "1 · seguimiento, Referencia de reembolso",
    montar: async () => {
      render(
        <TrackView
          rem={snapshotConReembolso()}
          sender={FAKE_SOLANA_BENEFICIARY}
          onRecovered={() => {}}
        />,
      );
      await screen.findByText(/Referencia de reembolso/);
    },
  },
  {
    nombre: "2 · orden de recuperación sin confirmar, Orden enviada",
    montar: async () => {
      buscarEscrows(
        new FakeSolanaEscrowRefundGateway(FAKE_SOLANA_SIGNATURE, "resolve", "pending"),
      );
      await screen.findByText(/Orden enviada/);
    },
  },
  {
    nombre: "3 · recuperación exitosa, Comprobante (la captura del founder)",
    montar: async () => {
      buscarEscrows(new FakeSolanaEscrowRefundGateway());
      await screen.findByText(/Comprobante/);
    },
  },
  {
    nombre: "4 · recibo, Depósito en Solana",
    montar: async () => {
      render(<Receipt rem={snapshotConDeposito()} onNew={() => {}} />);
      await screen.findByText(/Depósito en Solana/);
    },
  },
  {
    nombre: "5 · recibo, Reembolso",
    montar: async () => {
      render(<Receipt rem={snapshotConReembolso()} onNew={() => {}} />);
      await screen.findByText(/Reembolso/);
    },
  },
];

describe("T-346-1 (AC-1, AC-6): los 5 sitios muestran la firma TRUNCADA, nunca los 87 caracteres", () => {
  // INPUT QUE LO PONE EN ROJO: revertir el swap de `TxProof` en cualquiera de los 5 sitios (un caso por
  // sitio, M-3); subir el umbral `tx.length <= 16` de `shortTx` a `<= 128` (M-2, los 5 casos a la vez).
  it.each(SITIOS.map((s) => [s.nombre, s.montar] as const))(
    "sitio %s muestra 17 caracteres y no 87",
    async (_nombre, montar) => {
      await montar();
      expect(screen.getByRole("link", { name: SIGNATURE_CORTA })).toBeInTheDocument();
      // El valor entero NO está en ningún nodo de texto de la pantalla. Sigue vivo en el `href` y el
      // `title`, que son atributos: `getByText` no los mira, y ese es justo el punto.
      expect(screen.queryByText(new RegExp(FAKE_SOLANA_SIGNATURE))).toBeNull();
    },
  );

  it("y la forma corta es 17 caracteres contra 87, medido acá y no razonado", () => {
    expect(FAKE_SOLANA_SIGNATURE).toHaveLength(87);
    expect(SIGNATURE_CORTA).toHaveLength(17);
  });
});

describe("T-346-4 (AC-2): en los 5 sitios el href lleva la firma COMPLETA", () => {
  // INPUT QUE LO PONE EN ROJO: poner `shortTx(signature)` en el `href` — el enlace abriría el visor con
  // una firma inexistente y la pantalla seguiría viéndose bien, que es el modo de falla peligroso.
  it.each(SITIOS.map((s) => [s.nombre, s.montar] as const))(
    "sitio %s: href con los 87 caracteres, texto visible con 17",
    async (_nombre, montar) => {
      await montar();
      const enlace = screen.getByRole("link", { name: SIGNATURE_CORTA });
      expect(enlace.getAttribute("href")).toContain(FAKE_SOLANA_SIGNATURE);
      expect(enlace.getAttribute("href")).toContain("cluster=");
      // La tercera vía de recuperar el valor entero, para quien no puede o no quiere copiar.
      expect(enlace).toHaveAttribute("title", FAKE_SOLANA_SIGNATURE);
    },
  );
});

describe("T-346-5 (AC-3): el enlace se abre aislado de esta pestaña", () => {
  it("target _blank y rel con noopener Y noreferrer", () => {
    // INPUT QUE LO PONE EN ROJO: borrar cualquiera de los tres (3 casos). No es cosmético: sin
    // `noopener` la página del visor recibe una referencia a esta ventana, y esta ventana es la que
    // acaba de manejar el dinero de la persona.
    render(<TxProof signature={FAKE_SOLANA_SIGNATURE} />);
    const enlace = screen.getByRole("link", { name: SIGNATURE_CORTA });
    expect(enlace).toHaveAttribute("target", "_blank");
    expect(enlace.getAttribute("rel")).toContain("noopener");
    expect(enlace.getAttribute("rel")).toContain("noreferrer");
  });
});

describe("T-346-6 (AC-4): copiar la firma completa, con sus TRES desenlaces", () => {
  it("(a) writeText resuelve ⇒ dice Copiado, y se copió la firma COMPLETA", async () => {
    // INPUT QUE LO PONE EN ROJO: copiar `shortTx(signature)` en vez de la firma. Copiar 17 caracteres
    // y decir "Copiado" es peor que no ofrecer copiar: la persona pega un valor que no existe.
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    render(<TxProof signature={FAKE_SOLANA_SIGNATURE} />);

    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /Copiado/ })).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith(FAKE_SOLANA_SIGNATURE);
  });

  it("(b) writeText RECHAZA ⇒ lo dice, y NUNCA dice Copiado", async () => {
    // 🔴 EL test del tri-estado. INPUT QUE LO PONE EN ROJO: pintar "Copiado" en un `finally`, que es la
    // forma natural de escribir esto con dos estados. La pantalla afirmaría que la firma está en el
    // portapapeles cuando no está, sobre el único dato verificable contra la cadena.
    stubClipboard(async () => {
      throw new Error("NotAllowedError");
    });
    render(<TxProof signature={FAKE_SOLANA_SIGNATURE} />);

    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "No pudimos copiar" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /Copiado/ })).toBeNull();
  });

  it("(c) sin API de portapapeles ⇒ idem (b), y no revienta con una excepción sin capturar", async () => {
    // El caso REAL de un contexto no seguro: `navigator.clipboard` no existe. Mata al mutante que
    // cambiara el `?.` por un `.` y tirara un TypeError dentro del handler.
    stubClipboard(undefined);
    render(<TxProof signature={FAKE_SOLANA_SIGNATURE} />);

    fireEvent.click(screen.getByRole("button", { name: "Copiar" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "No pudimos copiar" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: /Copiado/ })).toBeNull();
  });

  it("el control declara min-h de 44 px o más, leído del DOM renderizado", () => {
    // INPUT QUE LO PONE EN ROJO: escribir `h-11`. Da los mismos 44 px en Tailwind y `minHpx` NO lo
    // reconoce, así que TIRA con el nombre del control en vez de dejarlo pasar sin medir. 44 px es el
    // piso de WCAG 2.5.5 que fijó WKH-341 (`touch-targets.test.tsx:191-195`).
    stubClipboard(async () => {});
    render(<TxProof signature={FAKE_SOLANA_SIGNATURE} />);
    expect(minHpx(screen.getByRole("button", { name: "Copiar" }))).toBeGreaterThanOrEqual(44);
  });
});

describe("T-346-7 (AC-5): la regla de quiebre está declarada en los 5 sitios", () => {
  // La SEGUNDA causa del desborde, y la que el truncado no cierra: sin regla de quiebre, cualquier
  // string largo sin espacios empuja la tarjeta. INPUT QUE LO PONE EN ROJO: borrar `break-all` (M-1).
  //
  // ⚠️ Esto lee la PRESENCIA de la clase, no el layout. Con `break-all` y sin truncado los 87
  // caracteres envuelven en varios renglones en vez de desbordar: el síntoma cambia, no desaparece.
  // Por eso hacen falta los dos, y por eso AC-5 nombra las dos causas.
  it.each(SITIOS.map((s) => [s.nombre, s.montar] as const))(
    "sitio %s declara break-all sobre el comprobante renderizado",
    async (_nombre, montar) => {
      await montar();
      const comprobante = comprobanteDe(screen.getByRole("link", { name: SIGNATURE_CORTA }));
      expect(comprobante.className).toContain("break-all");
    },
  );
});

describe("T-346-8 (AC-1, AC-6): los 5 sitios usan el MISMO componente, no 5 copias", () => {
  // INPUT QUE LO PONE EN ROJO: reimplementar el patrón a mano en un sitio (el ancla y el botón sin
  // pasar por `TxProof`). Es el modo de falla que AC-6 nombra: cinco implementaciones que divergen, y
  // el arreglo de la próxima HU aplicado en cuatro.
  it.each(SITIOS.map((s) => [s.nombre, s.montar] as const))(
    "sitio %s trae el par ancla + botón de copiar del componente compartido",
    async (_nombre, montar) => {
      await montar();
      const enlace = screen.getByRole("link", { name: SIGNATURE_CORTA });
      const comprobante = comprobanteDe(enlace);
      // Las dos mitades, dentro del MISMO nodo: un sitio que sólo tuviera el enlace, o sólo el texto
      // corto sin poder copiar, no está usando este componente.
      expect(comprobante.querySelector("a")).toBe(enlace);
      expect(comprobante.querySelector("button")).not.toBeNull();
    },
  );
});

// ── T-346-17 (fix-pack AR/MNR-3): las dos frases del final, como COPY PURA ───────────────────────
//
// 🔴 ESTE ES EL TEST QUE MATA EL LITERAL, y es distinto de T-346-18. Ese verifica, sobre la pantalla,
// que el número mostrado ES el de la constante hoy; pero un `10` escrito a mano en el cuerpo de la
// función también le daría verde, porque `MAX_RECOVERY_CANDIDATES` vale 10. Acá se llaman las funciones
// con un valor DISTINTO del real, así que un literal en el cuerpo se cae.
//
// ⚠️ El 7 no es un número mágico: es "cualquier valor que no sea el de producción". Si algún día
// `MAX_RECOVERY_CANDIDATES` pasara a valer 7, este test dejaría de matar el mutante en silencio, y por
// eso el assert de abajo lo comprueba.
describe("T-346-17: el número de las frases del final sale del parámetro, no de un literal", () => {
  it("el valor de prueba NO coincide con el de producción, o este test no mata nada", () => {
    expect(VALOR_DE_PRUEBA).not.toBe(MAX_RECOVERY_CANDIDATES);
  });

  it("recoveryMoreEscrowsHint interpola el parámetro", () => {
    const frase = recoveryMoreEscrowsHint(VALOR_DE_PRUEBA);
    expect(frase).toContain(`los últimos ${VALOR_DE_PRUEBA} envíos`);
    // Y el parámetro es el ÚNICO número de la frase: nada de "te quedan N", que el código no sabe.
    expect((frase.match(/\d+/g) ?? []).map(Number)).toEqual([VALOR_DE_PRUEBA]);
    // La instrucción sigue nombrando la acción real de la pantalla.
    expect(frase).toContain('Buscar mis escrows');
  });

  it("recoveryWindowExhausted interpola el parámetro", () => {
    const frase = recoveryWindowExhausted(VALOR_DE_PRUEBA);
    expect(frase).toContain(`los últimos ${VALOR_DE_PRUEBA} envíos`);
    expect((frase.match(/\d+/g) ?? []).map(Number)).toEqual([VALOR_DE_PRUEBA]);
  });

  // Cero em dashes en copy visible: el repo lo barre sobre el DOM en 5 lugares, y acá se barre sobre
  // el texto que las funciones EMITEN, que es un valor y no un estado que haya que alcanzar.
  it("ninguna de las dos trae un em dash", () => {
    expect(recoveryMoreEscrowsHint(VALOR_DE_PRUEBA)).not.toContain("—");
    expect(recoveryWindowExhausted(VALOR_DE_PRUEBA)).not.toContain("—");
  });

  // ⛔ Lo que estas frases NO dicen, y no puede volver: CUÁNTOS escrows le quedan a la persona. El
  // resolver devuelve un `string` y no expone esa cifra (CD-6). El tamaño de la ventana es otro número.
  it("ninguna afirma cuántos escrows quedan", () => {
    for (const frase of [recoveryMoreEscrowsHint(VALOR_DE_PRUEBA), recoveryWindowExhausted(VALOR_DE_PRUEBA)]) {
      expect((frase.match(/\d+/g) ?? []).length).toBe(1);
    }
  });
});
