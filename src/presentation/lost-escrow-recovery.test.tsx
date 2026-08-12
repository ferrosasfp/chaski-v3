// @vitest-environment jsdom
//
// LA PUERTA QUE NO EXISTÍA.
//
// La recuperación durable estaba ENTERA y sin un solo consumidor:
//   · `POST /api/solana/escrow/remittance-ids` está vivo en producción (medido: responde 403
//     `escrow_recovery_unverified` sin PoP),
//   · `refundEscrow()` acepta el id ausente y lo resuelve contra ese endpoint sondeando hasta
//     `MAX_RECOVERY_CANDIDATES` PDAs (`resolveRemittanceIdFromLedger`, `solana-wallet.ts:341`),
//   · el gateway está cableado en el composition root (`solanaRefund`, `container.ts:169`).
// Y la interfaz llamaba únicamente a `recoverEscrowFunds`, que arranca con `repo.get(remittanceId)` y
// tira `remittance_not_found` (`recover-escrow-funds.ts`:49-50). O sea: quien borró los datos del
// navegador, o entra desde otro dispositivo, no tenía NINGÚN camino hacia sus USDC.
//
// Lo que estos tests clavan, en orden de importancia:
//   1. que la llamada sale SIN remittanceId (es lo único que dispara la resolución durable);
//   2. que la pantalla dice qué se va a firmar ANTES de que aparezca ningún diálogo;
//   3. que "no encontramos nada" NUNCA se dice como "no tenés fondos".
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import bs58 from "bs58";
import { LostEscrowRecovery, RemittanceFlow } from "./flow";
import { buildTestContainer } from "../test-support/test-container";
import { MAX_RECOVERY_CANDIDATES } from "../infrastructure/solana-wallet";
import type { SolanaEscrowRefundGateway, SolanaEscrowRefundResult } from "../application/ports";
import {
  FAKE_SOLANA_BENEFICIARY,
  FAKE_SOLANA_SIGNATURE,
  FakeSolanaEscrowRefundGateway,
  FakeSolanaWallet,
} from "../test-support/fakes";

afterEach(cleanup);

// WKH-346 — la forma TRUNCADA que muestra `TxProof`: 17 caracteres contra los 87 del valor entero.
// Escrita A MANO y no con `shortTx`, para que subir el umbral del truncado la ponga en rojo.
const SIGNATURE_CORTA = "99eUso3a…FzQyEQf8";

// WKH-346 fix-pack — la SEGUNDA firma, para el caso de dos recuperaciones seguidas (T-346-13). El
// valor se construye igual que `FAKE_SOLANA_SIGNATURE` (`fakes.ts:835`) con otro relleno, así que es
// base58 válido y DISTINTO; la forma corta va A MANO por el mismo motivo que la de arriba.
const SEGUNDA_FIRMA = bs58.encode(new Uint8Array(64).fill(9));
const SEGUNDA_CORTA = "BUguQsv2…m8XpSXRA";

const sender = FAKE_SOLANA_BENEFICIARY;
// AR-2/MNR-9: una SEGUNDA identidad, para el caso de cambiar de billetera a mitad de la pantalla.
const OTRA_BILLETERA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const resolveSender = async () => sender;

/** Abre la tarjeta (el paso que muestra el texto) y devuelve el gateway para inspeccionar llamadas. */
function abrirPuerta(gateway: SolanaEscrowRefundGateway) {
  render(<LostEscrowRecovery refund={gateway} resolveSender={resolveSender} />);
  fireEvent.click(screen.getByRole("button", { name: /Recuperar un envío perdido/ }));
}

function buscar() {
  fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));
}

/**
 * Un gateway que resuelve DISTINTO en llamadas sucesivas, que es lo único con lo que se puede
 * ejercitar la acumulación de comprobantes (T-346-13/14/15).
 *
 * 🔴 VIVE ACÁ Y NO EN `test-support/fakes.ts` A PROPÓSITO. Ese módulo lo importan decenas de suites y
 * agregarle un modo nuevo tiene el radio de explosión más grande del repo para cero beneficio: este
 * doble lo usa un solo archivo. `FakeSolanaEscrowRefundGateway` queda byte-idéntico.
 *
 * ⚠️ Y LO QUE ESTE DOBLE NO PRUEBA: que dos recuperaciones REALES en cadena acumulen. Es memoria, en
 * jsdom. La evidencia de los 40 USDC de esta HU son cuatro transacciones confirmadas en devnet, NO dos
 * clicks seguidos en esta pantalla con el estado nuevo. Nadie ejercitó eso.
 */
class GatewayEnSecuencia implements SolanaEscrowRefundGateway {
  public calls: Array<{ remittanceId?: string; sender: string }> = [];
  constructor(private readonly guion: ReadonlyArray<SolanaEscrowRefundResult | string>) {}
  async refund(input: { remittanceId?: string; sender: string }): Promise<SolanaEscrowRefundResult> {
    this.calls.push(input);
    // El último desenlace se repite si alguien aprieta una vez más: un `undefined` acá sería un
    // TypeError que se lee como "la UI falló" cuando lo que faltó fue guion.
    const paso = this.guion[Math.min(this.calls.length - 1, this.guion.length - 1)];
    if (paso === undefined) throw new Error("guion_vacio");
    if (typeof paso === "string") throw new Error(paso);
    return paso;
  }
}

const confirmado = (refundTx: string): SolanaEscrowRefundResult => ({
  refundTx,
  confirmation: "confirmed",
});

describe("recuperar un envío perdido: la llamada", () => {
  // EL test. Con `remittanceId` presente el adapter NO consulta el resolver (path byte-idéntico al
  // que ya andaba): la ausencia del campo es literalmente lo que enciende la recuperación durable.
  it("llama al gateway SIN remittanceId, que es lo que dispara la resolución contra el servidor", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    abrirPuerta(gateway);

    fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));

    await waitFor(() => expect(gateway.calls).toHaveLength(1));
    expect(gateway.calls[0]).toEqual({ sender });
    expect(gateway.calls[0]?.remittanceId).toBeUndefined();
  });

  it("con la cadena confirmando, dice que volvieron y muestra el comprobante", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    abrirPuerta(gateway);

    fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));

    expect(await screen.findByText(/Recuperaste tus fondos/)).toBeInTheDocument();
    expect(screen.getByText(/Tus USDC volvieron a tu wallet/)).toBeInTheDocument();
    // WKH-346: este assert pedía la firma ENTERA como texto y se puso rojo POR DISEÑO al truncarla; es
    // la señal de que la HU funcionó. Este es el sitio de la captura del founder: los 87 caracteres
    // desbordaban la columna. Ahora la pantalla muestra 17 y el valor entero vive en el `href`.
    const enlace = screen.getByRole("link", { name: SIGNATURE_CORTA });
    expect(enlace.getAttribute("href")).toContain(FAKE_SOLANA_SIGNATURE);
    expect(screen.queryByText(new RegExp(FAKE_SOLANA_SIGNATURE))).toBeNull();
  });

  // El tercer valor: el RPC aceptó la transacción y nadie la vio confirmada. Es el MISMO texto que la
  // otra puerta, y por eso vive en un solo componente.
  it.each([["pending"], ["unknown"]] as const)(
    "confirmation=%s: dice que la orden se envió, NUNCA que la plata volvió",
    async (confirmation) => {
      const gateway = new FakeSolanaEscrowRefundGateway(
        FAKE_SOLANA_SIGNATURE,
        "resolve",
        confirmation,
      );
      abrirPuerta(gateway);

      fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));

      expect(await screen.findByText(/Enviamos la orden de recuperación/)).toBeInTheDocument();
      expect(screen.queryByText(/Recuperaste tus fondos/)).toBeNull();
      expect(screen.queryByText(/Tus USDC volvieron a tu wallet/)).toBeNull();
    },
  );
});

describe("recuperar un envío perdido: lo que se dice antes de firmar", () => {
  // La persona va a ver DOS diálogos de firma de su billetera, por dos motivos distintos. Una app que
  // los abre sin haber dicho qué se firma entrena a la gente a firmar cualquier cosa.
  it("nombra las dos firmas y para qué es cada una, ANTES de tocar el gateway", () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    render(<LostEscrowRecovery refund={gateway} resolveSender={resolveSender} />);

    // Cerrada: todavía no se explicó nada, así que tampoco hay acción que dispare una firma.
    expect(screen.queryByRole("button", { name: /Buscar mis escrows/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Recuperar un envío perdido/ }));

    expect(screen.getByText(/una firma para probar que es tuya: es un texto/)).toBeInTheDocument();
    expect(screen.getByText(/no mueve fondos y no paga comisión de red/)).toBeInTheDocument();
    expect(
      screen.getByText(/una segunda firma, y esa sí es la transacción que saca tus USDC/),
    ).toBeInTheDocument();
    // Y el texto está en pantalla ANTES de que nada haya llamado al gateway.
    expect(gateway.calls).toHaveLength(0);
  });

  it("dice de dónde sale la lista que NO la tiene, que es el motivo de esta puerta", () => {
    abrirPuerta(new FakeSolanaEscrowRefundGateway());
    expect(
      screen.getByText(/Si borraste los datos del navegador o entrás desde otro dispositivo/),
    ).toBeInTheDocument();
  });
});

describe("recuperar un envío perdido: qué se dice cuando no aparece nada", () => {
  // 🔴 El error más caro de esta pantalla. `escrow_not_found` acá NO prueba que la persona no tenga
  // fondos: sale de "el servidor no devolvió ids" o de "ninguno de los sondeados estaba Deposited".
  it("no afirma que no tenga fondos: dice sobre cuántos envíos miramos", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway(
      FAKE_SOLANA_SIGNATURE,
      "reject",
      "confirmed",
      "escrow_not_found",
    );
    abrirPuerta(gateway);

    fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));

    const msg = await screen.findByText(/No encontramos escrows abiertos para esta billetera/);
    expect(msg).toBeInTheDocument();
    expect(msg).toHaveTextContent("Esto no dice que no tengas fondos");
    // El número sale de la MISMA constante que sondea, no de un literal escrito en el copy.
    expect(msg).toHaveTextContent(`los últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
    // Y no se recicla el copy de la otra puerta, que sí habla de un depósito concreto.
    expect(screen.queryByText(/No encontramos un depósito tuyo en el escrow/)).toBeNull();
  });

  // "No pudimos preguntar" no es "no hay nada". Es el mismo criterio del tri-estado del money-path.
  it("si no pudimos consultar el registro, lo dice como lo que es: no llegamos a preguntar", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway(
      FAKE_SOLANA_SIGNATURE,
      "reject",
      "confirmed",
      "escrow_recovery_unavailable",
    );
    abrirPuerta(gateway);

    fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));

    const msg = await screen.findByText(/No pudimos consultar el registro de envíos/);
    expect(msg).toHaveTextContent("no llegamos a preguntar");
    expect(screen.queryByText(/No encontramos escrows abiertos/)).toBeNull();
  });
});

describe("recuperar un envío perdido: la puerta en el recorrido", () => {
  // Vive en `send` porque es donde aterriza toda recarga y adonde vuelve "Enviar otra". Quien llega
  // desde otro dispositivo ve esta pantalla y ninguna otra.
  it("está en `send`, al lado de 'Ver mis envíos'", () => {
    const container = buildTestContainer({
      wallet: new FakeSolanaWallet(),
      solanaRefund: new FakeSolanaEscrowRefundGateway(),
    });
    render(<RemittanceFlow container={container} />);

    expect(screen.getByRole("button", { name: /Ver mis envíos/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recuperar un envío perdido/ })).toBeInTheDocument();
  });

  // Sin gateway cableado no se ofrece una puerta que no lleva a ningún lado.
  it("sin gateway de refund no se muestra", () => {
    render(<RemittanceFlow container={buildTestContainer()} />);
    expect(screen.queryByRole("button", { name: /Recuperar un envío perdido/ })).toBeNull();
  });

  // El PoP se firma con la wallet del sender, así que la address tiene que salir de la wallet
  // conectada y no de un campo que alguien tipea. Si se rompe el cableado, la llamada sale con otra.
  it("el sender sale de la wallet conectada, no de un input", async () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    const container = buildTestContainer({
      wallet: new FakeSolanaWallet(),
      solanaRefund: gateway,
    });
    render(<RemittanceFlow container={container} />);

    fireEvent.click(screen.getByRole("button", { name: /Recuperar un envío perdido/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Buscar mis escrows/ }));

    await waitFor(() => expect(gateway.calls).toHaveLength(1));
    expect(gateway.calls[0]?.sender).toBe(FAKE_SOLANA_BENEFICIARY);
  });

  it("no mete un em dash en el recorrido", () => {
    abrirPuerta(new FakeSolanaEscrowRefundGateway());
    expect(document.body.textContent ?? "").not.toContain("—");
  });
});

// ── T-346-9 (WKH-346, AC-7): qué se dice DESPUÉS de recuperar UNO ────────────────────────────────
//
// 🔴 EL DEFECTO. La pantalla decía "Recuperaste tus fondos" y nada más, y esta puerta resuelve UN
// escrow por vez: `resolveRemittanceIdFromLedger` sondea hasta `MAX_RECOVERY_CANDIDATES` PDAs y
// devuelve el PRIMERO en estado `Deposited` (`solana-wallet.ts:333`). Quien tenía dos envíos perdidos
// se iba de la pantalla creyendo que había recuperado todo, y el segundo se quedaba en el vault.
describe("recuperar un envío perdido: que puede haber más de uno", () => {
  it("dice que puede haber más envíos, SIN afirmar un número que el código no sabe", async () => {
    abrirPuerta(new FakeSolanaEscrowRefundGateway());

    buscar();

    const frase = await screen.findByText(/Puede haber más envíos con fondos por recuperar/);
    expect(frase).toBeInTheDocument();
    // Y nombra la acción que lo averigua: es lo único accionable que se puede decir con verdad.
    expect(frase).toHaveTextContent("Buscar mis escrows");
  });

  // ── T-346-18 (fix-pack AR/MNR-3): el ÚNICO número de la frase es la constante de la ventana ──────
  //
  // 🔴 ACÁ HABÍA UN `not.toMatch(/\d/)`, y era el assert de una frase que MENTÍA. La versión vieja
  // decía 'volvé a apretar "Buscar mis escrows" para revisar los que falten', y con más de
  // `MAX_RECOVERY_CANDIDATES` depósitos perdidos eso es falso: el orden es `created_at desc`, así que
  // volver a apretar nunca alcanza a los más viejos. La frase nueva nombra el tamaño de la ventana, y
  // por eso el assert ya no puede ser "cero dígitos".
  //
  // ⚠️ SON DOS NÚMEROS DISTINTOS Y SÓLO UNO SE PUEDE DECIR: cuántos escrows le QUEDAN a la persona el
  // código NO lo sabe (`resolveRemittanceIdFromLedger` devuelve un `string`), y sigue PROHIBIDO
  // afirmarlo (CD-6). Cuántos MIRA cada búsqueda sí lo sabe, porque es la constante con la que sondea.
  //
  // ⛔ El assert compara la lista DERIVADA de números del DOM contra la constante, y no una lista de
  // frases prohibidas escritas a mano ("te quedan", "hay N"): un enumerado a mano de sustantivos ya
  // dejó pasar un bloqueante en WKH-338. Agregar "te quedan 2 envíos" mueve el array a `[10, 2]`.
  it("el único número que muestra la frase es MAX_RECOVERY_CANDIDATES, y sale de la constante", async () => {
    abrirPuerta(new FakeSolanaEscrowRefundGateway());

    buscar();

    const frase = await screen.findByText(/Puede haber más envíos con fondos por recuperar/);
    const numeros = (frase.textContent?.match(/\d+/g) ?? []).map(Number);
    expect(numeros).toEqual([MAX_RECOVERY_CANDIDATES]);
    // Y dice qué NO alcanza la ventana, que es la mitad que la frase vieja se comía.
    expect(frase).toHaveTextContent("los más viejos que eso no van a aparecer");
  });

  // El barrido de em dash de más arriba NO visitaba este estado: corre sobre la tarjeta recién abierta,
  // y esta frase aparece recién DESPUÉS de recuperar. Un estado sin barrer es un estado donde el em
  // dash entra sin que nada se ponga rojo.
  it("no mete un em dash en el estado recuperado, que el otro barrido no visitaba", async () => {
    abrirPuerta(new FakeSolanaEscrowRefundGateway());

    fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));

    await screen.findByText(/Recuperaste tus fondos/);
    expect(document.body.textContent ?? "").not.toContain("—");
  });
});

// ── Fix-pack AR/BLQ-BAJO-1: acumular comprobantes, y el tri-estado del final ─────────────────────
//
// 🔴 EL DEFECTO QUE CIERRAN. `recovered` era un `useState<string | null>` que el segundo éxito
// SOBRESCRIBÍA, y esta puerta existe justamente para escrows que el dispositivo NO conoce: la primera
// firma no está en `localStorage`, no está en "Ver mis envíos", y esto es estado de componente. O sea
// que el segundo click borraba la única evidencia en pantalla de un movimiento de dinero que ya
// ocurrió. La plata no se pierde (la cadena es autoritativa); se pierde la prueba. Y la población
// afectada es EXACTAMENTE la que motivó la frase de AC-7: quien tiene dos o más envíos perdidos.
//
// Las tres propiedades, una por test:
//   1. ningún comprobante ya mostrado desaparece            → T-346-13
//   2. la frase "puede haber más" se calla cuando YA sabemos → T-346-14
//   3. "no queda ninguno" después de recuperar NO es un error → T-346-14
// y el tri-estado que no se puede colapsar                   → T-346-15
//
// ⚠️ ALCANCE DE LA PROPIEDAD 1, acotado tras el AR-2 (BLQ-BAJO-1). Estos tests la prueban para los
// comprobantes CONFIRMADOS (`recuperados`). NO la probaban para las órdenes SIN desenlace conocido:
// `sent` era un casillero único y se sobrescribía igual, y esta sección afirmaba la propiedad como si
// fuera del componente. Ese caso lo cubren ahora T-346-20/21, en su propio `describe`. La propiedad es
// de la FORMA de cada estado y hay que verificarla estado por estado: de "esta variable es append-only"
// no se deduce "el componente no pierde nada".
describe("recuperar un envío perdido: dos búsquedas seguidas", () => {
  // ── T-346-12 (fix-pack AR/MNR-4): POSICIÓN, no presencia ───────────────────────────────────────
  //
  // 🔴 El test de arriba abre la puerta, hace click en Buscar y busca la frase: clava la PRESENCIA.
  // Mover el `<p>` fuera del bloque condicional lo deja VERDE con una pantalla que afirma "puede haber
  // más envíos con fondos por recuperar" sin haberle preguntado NADA a la cadena.
  //
  // Es la SEGUNDA encarnación del mismo defecto en el mismo archivo: el CR de WKH-327 lo arregló en el
  // componente INMEDIATAMENTE SIGUIENTE (`explainer`, `flow.tsx:2283`), a unas pocas decenas de
  // líneas de donde nació este. ⚠️ Acá decía "48 líneas": una distancia es una cifra que envejece
  // sola, y mis propias inserciones la llevaron a 60 (AR-2/MNR-7). Lo estructural no envejece, y es lo
  // que hace al caso PEOR: nació al lado de la nota que lo describe, no lejos de ella.
  // Un test de presencia no lo ve; sólo lo ve uno que mire el DOM ANTES de preguntar.
  it("recién abierta la puerta, NINGUNA de las dos frases del final está en el DOM", () => {
    const gateway = new FakeSolanaEscrowRefundGateway();
    abrirPuerta(gateway);

    expect(screen.queryByText(/Puede haber más envíos con fondos por recuperar/)).toBeNull();
    expect(screen.queryByText(/Ya no queda ninguno abierto/)).toBeNull();
    expect(screen.queryByText(/Recuperaste tus fondos/)).toBeNull();
    // Y la razón por la que no pueden estar: todavía no se le preguntó nada a la cadena.
    expect(gateway.calls).toHaveLength(0);
  });

  // ── T-346-13 · Propiedad 1: nada de lo ya mostrado desaparece ──────────────────────────────────
  it("dos recuperaciones con firmas distintas dejan LOS DOS comprobantes, cada uno con su href", async () => {
    const gateway = new GatewayEnSecuencia([
      confirmado(FAKE_SOLANA_SIGNATURE),
      confirmado(SEGUNDA_FIRMA),
    ]);
    abrirPuerta(gateway);

    buscar();
    const primero = await screen.findByRole("link", { name: SIGNATURE_CORTA });
    buscar();
    const segundo = await screen.findByRole("link", { name: SEGUNDA_CORTA });

    // 🔴 EL ASSERT DEL BLOQUEANTE: el PRIMERO sigue en el documento después del segundo éxito.
    expect(primero).toBeInTheDocument();
    expect(segundo).toBeInTheDocument();
    // Y cada uno conserva SU valor entero, que es lo único auditable contra la cadena. Un `.map()`
    // que reusara la misma firma para los dos pasaría el assert de arriba y caería acá.
    expect(primero.getAttribute("href")).toContain(FAKE_SOLANA_SIGNATURE);
    expect(segundo.getAttribute("href")).toContain(SEGUNDA_FIRMA);
    expect(gateway.calls).toHaveLength(2);
  });

  // ── T-346-14 · Propiedades 2 y 3 ───────────────────────────────────────────────────────────────
  it("recuperar uno y después escrow_not_found: dice que ya no queda ninguno, y NO como error", async () => {
    const gateway = new GatewayEnSecuencia([
      confirmado(FAKE_SOLANA_SIGNATURE),
      "escrow_not_found",
    ]);
    abrirPuerta(gateway);

    buscar();
    const comprobante = await screen.findByRole("link", { name: SIGNATURE_CORTA });
    buscar();

    // Propiedad 2: la frase que promete más se calla, porque ahora SÍ sabemos.
    const cierre = await screen.findByText(/Ya no queda ninguno abierto/);
    expect(cierre).toHaveTextContent(`los últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
    expect(screen.queryByText(/Puede haber más envíos con fondos por recuperar/)).toBeNull();
    // Propiedad 1 otra vez: el comprobante NO desapareció al llegar el segundo desenlace.
    expect(comprobante).toBeInTheDocument();
    // Propiedad 3: el final del camino no es un error, así que el copy de error no está en el DOM.
    // ⛔ Sacar el `!caminoTerminado` del bloque de error pone esto rojo (mutante N-3): la tarjeta
    // volvería a decir "Recuperaste tus fondos" y en el color del error que no queda ninguno abierto.
    expect(screen.queryByText(/No encontramos escrows abiertos para esta billetera/)).toBeNull();
  });

  // ── T-346-15 · 🔴 EL TRI-ESTADO, que es lo que NO se puede colapsar ────────────────────────────
  //
  // `escrow_recovery_unavailable` llega con CINCO productores (`flow-vm.ts:323-332`) y NINGUNO afirma
  // que la ventana esté vacía: el endpoint contestó algo que no es 200/403/501, o los tres `not_asked`
  // que el refund propaga desde WKH-331. En los cinco NO llegamos a mirar la cadena, así que "puede
  // haber más" sigue siendo VERDAD. Colapsarlo con `escrow_not_found` repetiría la lección que este
  // repo ya tiene escrita: "no pude preguntar" NO es "no pasó".
  it("recuperar uno y después escrow_recovery_unavailable: SIGUE diciendo que puede haber más", async () => {
    const gateway = new GatewayEnSecuencia([
      confirmado(FAKE_SOLANA_SIGNATURE),
      "escrow_recovery_unavailable",
    ]);
    abrirPuerta(gateway);

    buscar();
    const comprobante = await screen.findByRole("link", { name: SIGNATURE_CORTA });
    buscar();

    // El error SÍ se pinta: no es el final del camino, es una pregunta que no se pudo hacer.
    const msg = await screen.findByText(/No pudimos consultar el registro de envíos/);
    expect(msg).toHaveTextContent("no llegamos a preguntar");
    // ⛔ Y la frase NO se apagó. Clasificar cualquier error como sin-abiertos (mutante N-4) pone
    // estos dos asserts en rojo a la vez.
    expect(screen.getByText(/Puede haber más envíos con fondos por recuperar/)).toBeInTheDocument();
    expect(screen.queryByText(/Ya no queda ninguno abierto/)).toBeNull();
    expect(comprobante).toBeInTheDocument();
  });

  // Regresión del camino que NO cambia: sin nada recuperado, `escrow_not_found` en el PRIMER click
  // sigue siendo el error de siempre. Lo cubre el test de "no afirma que no tenga fondos" de más
  // arriba; acá se clava lo único que ese test no dice: que la guarda nueva no lo suprimió.
  it("con CERO recuperados, escrow_not_found se sigue pintando como error", async () => {
    abrirPuerta(new GatewayEnSecuencia(["escrow_not_found"]));

    buscar();

    expect(
      await screen.findByText(/No encontramos escrows abiertos para esta billetera/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Recuperaste tus fondos/)).toBeNull();
    expect(screen.queryByText(/Ya no queda ninguno abierto/)).toBeNull();
  });

  // El barrido de em dash tampoco visitaba ESTE estado (dos recuperaciones + cierre de ventana).
  it("no mete un em dash en el estado de ventana agotada", async () => {
    abrirPuerta(
      new GatewayEnSecuencia([confirmado(FAKE_SOLANA_SIGNATURE), "escrow_not_found"]),
    );

    buscar();
    await screen.findByRole("link", { name: SIGNATURE_CORTA });
    buscar();

    await screen.findByText(/Ya no queda ninguno abierto/);
    expect(document.body.textContent ?? "").not.toContain("—");
  });
});

// ── Fix-pack AR-2/BLQ-BAJO-1: el OTRO casillero único del mismo componente ───────────────────────
//
// 🔴 EL DEFECTO, y es el mismo de antes en el slot de al lado. El fix-pack anterior convirtió
// `recovered` en una lista append-only, y dejó `sent` como un `{confirmation, refundTx} | null`. Ese
// campo guarda la firma de un refund YA TRANSMITIDO cuyo desenlace NADIE conoce: `confirmation` puede
// ser `"pending"` o `"unknown"` (`ports.ts:339`). O sea que es EXACTAMENTE la firma que la persona
// necesita para ir al visor a averiguar si entró, y esta HU la volvió prominente y enlazable
// ("Orden enviada: <TxProof/>").
//
// ⚠️ Y ERA EL DAÑO QUE MI PROPIO COMENTARIO DECLARABA IMPOSIBLE: decía que "ningún comprobante ya
// mostrado desaparece" era imposible de violar POR CONSTRUCCIÓN. Medido, eso valía para la VARIABLE
// `recuperados` y NO para el componente, que tenía otro casillero que sí se sobrescribía.
describe("recuperar un envío perdido: las órdenes sin desenlace tampoco se pierden", () => {
  // T-346-20 · pending y después confirmado: son DOS escrows distintos y DOS pruebas distintas.
  it("una orden pending y después una confirmada dejan LOS DOS comprobantes", async () => {
    const gateway = new GatewayEnSecuencia([
      { refundTx: FAKE_SOLANA_SIGNATURE, confirmation: "pending" },
      confirmado(SEGUNDA_FIRMA),
    ]);
    abrirPuerta(gateway);

    buscar();
    const pendiente = await screen.findByRole("link", { name: SIGNATURE_CORTA });
    buscar();
    const confirmada = await screen.findByRole("link", { name: SEGUNDA_CORTA });

    // 🔴 EL ASSERT DEL BLOQUEANTE: la firma de desenlace DESCONOCIDO sigue en el documento.
    expect(pendiente).toBeInTheDocument();
    expect(pendiente.getAttribute("href")).toContain(FAKE_SOLANA_SIGNATURE);
    expect(confirmada.getAttribute("href")).toContain(SEGUNDA_FIRMA);
    // Y sigue dicho lo que sabemos de ella, que es justamente "no sabemos".
    expect(screen.getAllByText(/Enviamos la orden de recuperación/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Todavía no la vemos confirmada en la cadena/)).toBeInTheDocument();
  });

  // T-346-21 · dos pending seguidas: dos órdenes transmitidas, dos hrefs.
  it("dos órdenes pending seguidas dejan DOS hrefs, no uno", async () => {
    const gateway = new GatewayEnSecuencia([
      { refundTx: FAKE_SOLANA_SIGNATURE, confirmation: "pending" },
      { refundTx: SEGUNDA_FIRMA, confirmation: "unknown" },
    ]);
    abrirPuerta(gateway);

    buscar();
    await screen.findByRole("link", { name: SIGNATURE_CORTA });
    buscar();
    await screen.findByRole("link", { name: SEGUNDA_CORTA });

    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => h.includes(FAKE_SOLANA_SIGNATURE) || h.includes(SEGUNDA_FIRMA));
    expect(hrefs).toHaveLength(2);
  });
});

// ── Fix-pack AR-2/MNR-9: el relato compuesto de DOS billeteras ───────────────────────────────────
//
// 🔴 `sinAbiertos` decidía con el `recuperados` de la identidad ANTERIOR. Reproducido: la billetera A
// recupera un escrow; se cambia de billetera; la B contesta `escrow_not_found`. La pantalla presentaba
// como UN SOLO relato el comprobante de A y el cierre de ventana de B, y SUPRIMÍA el error de B
// apoyándose en un éxito que no fue de B. Cada frase por separado es cierta; el compuesto no, y el
// "esta billetera" de la frase de cierre tampoco.
describe("recuperar un envío perdido: cambiar de billetera", () => {
  it("el cierre de ventana de la billetera B NO se apoya en un éxito de la billetera A", async () => {
    let quien = FAKE_SOLANA_BENEFICIARY;
    const gateway = new GatewayEnSecuencia([confirmado(FAKE_SOLANA_SIGNATURE), "escrow_not_found"]);
    render(<LostEscrowRecovery refund={gateway} resolveSender={async () => quien} />);
    fireEvent.click(screen.getByRole("button", { name: /Recuperar un envío perdido/ }));

    buscar();
    await screen.findByRole("link", { name: SIGNATURE_CORTA });

    // Se cambia de billetera y se vuelve a buscar: la respuesta es sobre OTRA identidad.
    quien = OTRA_BILLETERA;
    buscar();

    // El error de B se DICE, porque para B no hubo ningún éxito en el que apoyarse.
    expect(
      await screen.findByText(/No encontramos escrows abiertos para esta billetera/),
    ).toBeInTheDocument();
    // Y NO se afirma el final del camino, que sería el éxito de A contado como cierre de B.
    expect(screen.queryByText(/Ya no queda ninguno abierto/)).toBeNull();
  });
});
