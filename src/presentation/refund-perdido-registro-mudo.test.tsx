// @vitest-environment jsdom
//
// LA PUERTA DEL REFUND PERDIDO AFIRMABA HABER MIRADO LO QUE NO MIRÓ (WKH-331 / AC-1, AC-2, AC-3,
// AC-5, AC-8).
//
// 🔴 POR QUÉ ESTE ARCHIVO EXISTE. `resolveRemittanceIdFromLedger` consumía `listBySender`, que colapsa
// CUATRO condiciones en una lista vacía: el mecanismo de prueba de posesión apagado, el registro
// durable apagado, la prueba de posesión rechazada, y —la única legítima— el servidor contestando que
// no hay ids. Sobre esa lista vacía el adapter tiraba `escrow_not_found`, y la pantalla decía haber
// mirado los últimos N envíos del servidor. En los tres primeros casos nunca se llegó a preguntar.
//
// De dónde sale el árbol: de `createContainer()`, el container REAL. O sea el `HttpPopSigner` real, el
// `HttpSolanaRemittanceIdResolver` real, el `SolanaWalletAdapter` real y el `SolanaEscrowRefundGateway`
// real, cableados como en producción. Lo único stubbeado es `fetch` — la frontera de red — y la firma
// de la wallet. NO hay ningún doble del resolver escrito a mano (AC-8): un doble puede representar el
// desenlace que su autor tuvo en mente, y el desenlace a cazar es justamente el que nadie tenía.
//
// ⚠️ NINGÚN caso de acá llega a la cadena, y no es una omisión: los tres degradados cortan ANTES de
// derivar la PDA, y el CONTROL corta por lista vacía también antes (`solana-wallet.ts`, el guard de
// lista vacía, antes de los `await import(...)`). Por eso jsdom alcanza. La derivación de PDA en jsdom
// NO funciona (`escrow-rent-discovery-junta.test.ts` explica con qué mensaje) y ningún caso la
// necesita.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LostEscrowRecovery } from "./flow";
import { lostEscrowRecoveryError } from "./flow-vm";
import { createContainer } from "../composition/container";
import { MAX_RECOVERY_CANDIDATES } from "../infrastructure/solana-wallet";
import { solanaWalletBridge } from "../infrastructure/solana-wallet-bridge";
import { FAKE_SOLANA_BENEFICIARY } from "../test-support/fakes";

const SENDER = FAKE_SOLANA_BENEFICIARY;
const RUTA_CHALLENGE = "/api/a2a/payout/challenge";
const RUTA_IDS = "/api/solana/escrow/remittance-ids";

// ⚠️ Acá NO se ausentan las envs EVM (`container.test.ts` sí lo hace). Nombrarlas está PROHIBIDO en
// todo el árbol salvo en un allowlist enumerado (`no-evm-surface.test.ts`), y este archivo no tiene
// una razón estructural para entrar en él. Si alguna quedara seteada en el entorno, `createContainer`
// tira `evm_config_residue` y este test se pone rojo diciéndolo — que es el desenlace correcto.
beforeEach(() => {
  // La wallet firma: los desenlaces A/B/C/E de abajo NO son "la persona no firmó". El caso D
  // sobreescribe este handle a propósito, y ésa es la única diferencia.
  solanaWalletBridge.registerSignMessage(async () => new Uint8Array(64));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  solanaWalletBridge.reset();
});

/** Un `fetch` que contesta por ruta. Lo que no esté acá es un error del test, no del código. */
function stubFetch(rutas: Record<string, () => Response>) {
  const llamadas: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      llamadas.push(u);
      const handler = rutas[u];
      if (!handler) throw new Error(`ruta no stubbeada en el test: ${u}`);
      return handler();
    }),
  );
  return llamadas;
}

const challengeOk = () =>
  Response.json({ popChallenge: "chal-1", popMessage: "firmá esto" }, { status: 200 });

/**
 * Monta la puerta con el gateway del container REAL y aprieta "Buscar".
 *
 * El `sender` va explícito por `resolveSender`, así que no hace falta conectar el bridge: el gateway
 * se lo pasa a `refundEscrow`, que lo usa antes de cualquier guard de conexión.
 */
function buscarConElContainerReal() {
  const c = createContainer();
  render(<LostEscrowRecovery refund={c.solanaRefund} resolveSender={async () => SENDER} />);
  fireEvent.click(screen.getByRole("button", { name: /Recuperar un envío perdido/ }));
  fireEvent.click(screen.getByRole("button", { name: /Buscar mis escrows/ }));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// EL COPY LEGÍTIMO SE FIJA POR IGUALDAD EXACTA (fix-pack re-AR/MNR-6 + MNR-7)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// 🔴 POR QUÉ NO ALCANZAN LAS PROPIEDADES, medido DOS veces en direcciones opuestas.
//
// Primero fueron cuatro subcadenas ancladas, y el AR escribió alrededor de las cuatro una variante que
// decía "puede que no hayamos podido mirar ninguno de los últimos N envíos" — la sobre-corrección
// exacta que esta HU existe para no cometer — con la suite COMPLETA verde. Se reemplazaron por dos
// propiedades del texto (cero marcas de duda epistémica + afirmación en indicativo con el número), y
// el re-AR volvió a escribir alrededor de las DOS:
//
//   · DEMASIADO LAXA: la propiedad de las marcas es un chequeo de PRESENCIA, así que todo hedge puesto
//     DESPUÉS de la afirmación es invisible. "…y eso vale sólo para los que llegamos a revisar: la
//     lista del servidor vino incompleta y varios quedaron sin mirar", pegado al final del copy
//     legítimo, no trae ninguna de las 25 marcas, deja el indicativo intacto y conserva las cuatro
//     subcadenas. Suite completa verde: 1371.
//   · DEMASIADO ESTRICTA: la otra propiedad era una regexp con la sintaxis y el VERBO del copy de hoy
//     (`ninguno de los últimos N envíos[^.]*\sestá\s`). Reescribir el texto en el estilo del hermano
//     de WKH-327 ("miramos los últimos N envíos, y ninguno está abierto"), o cambiar sólo `está` por
//     `sigue`, daba rojo: dos textos MÁS afirmativos que el actual, castigados por la redacción. Un
//     guard que se pone rojo contra la redacción correcta se relaja la primera vez que alguien
//     armoniza este copy con el de WKH-327, que es lo que el SDD pide.
//
// Las dos fallas son la misma: un predicado que aproxima "afirmar" con la FORMA del texto. La igualdad
// exacta no aproxima nada. Es lo que ya hace `refund_tx_failed` en `flow-vm.test.ts`, donde no hay
// variante que sobreviva.
//
// ⚠️ EL LITERAL VA ESCRITO A MANO ACÁ Y NO IMPORTADO DE `flow-vm.ts`, y ésa es la decisión que define
// qué vigila esto. Un oráculo que sale de la misma función que vigila se aplaude a sí mismo, y esto
// NO es una intuición: se armó el diseño alternativo (una `copyNoEncontramos()` exportada por
// `flow-vm.ts` e importada acá) con la variante de alcance post-hoc metida ADENTRO de la constante, y
// las dos igualdades —ésta y la del caso E— quedaron VERDES. El único rojo de esa corrida fue el
// literal de veredicto conocido de más abajo, que también está escrito a mano. O sea: lo único que vio
// el hedge fue texto escrito a mano.
//
// ⚠️ Y LO QUE ESTO CUESTA, MEDIDO, para que nadie lo descubra de golpe: reescribir el copy en
// `flow-vm.ts` y NO tocar este literal deja 2 rojos (esta igualdad y la del caso E). No es el rojo
// de MNR-7: aquél decía "no matcheás esta regexp con este verbo" contra un texto correcto; éste
// imprime el texto viejo y el nuevo enteros y se arregla reescribiendo ESTE literal, sin relajar
// ningún predicado. Medido: reescrito el copy en el estilo del hermano de WKH-327 y actualizado este
// literal en la misma pasada, la suite queda verde (89 archivos / 1381 tests). Ése es el costo de una
// decisión de redacción sobre el dinero: dos ediciones y un diff que muestra el texto nuevo entero.
// El NÚMERO sí sale de la constante que sondea, para que el copy no pueda quedar diciendo un número
// que el código dejó de usar.
// 🔴 WKH-347 — ESTE LITERAL SE ACTUALIZÓ A MANO, y es exactamente el costo que el párrafo de arriba
// anticipó ("reescribir el copy en `flow-vm.ts` y NO tocar este literal deja 2 rojos... se arregla
// reescribiendo ESTE literal, sin relajar ningún predicado"). Pasó eso: se reescribió el copy, este
// literal quedó rojo, y se reescribió acá. Ningún predicado se relajó.
//
// QUÉ CAMBIÓ EN EL TEXTO, y por qué es un cambio de ALCANCE y no de mecanismo: antes nombraba UNA sola
// fuente ("los últimos N envíos que el servidor tiene guardados"). Desde WKH-347 la búsqueda mira DOS
// —la ventana del servidor y el índice on-chain de la billetera— y el copy tiene que nombrar las dos,
// porque afirmar "no encontramos" habiendo mirado una sola sería afirmar de más sobre la otra.
//
// El NÚMERO sigue saliendo de la constante que sondea, no de un literal escrito acá, para que el copy no
// pueda quedar diciendo un número que el código dejó de usar. El índice NO aporta número: su cupo no es
// una ventana que la persona pueda entender como "los últimos N", y prometer un número ahí sería
// inventarle un límite al índice que el código no aplica (los `entries` se sondean ENTEROS).
const COPY_LEGÍTIMO_DEL_NO_ENCONTRAMOS =
  `No encontramos escrows abiertos para esta billetera. Esto no dice que no tengas fondos: dice que ` +
  `ninguno de los últimos ${MAX_RECOVERY_CANDIDATES} envíos que el servidor tiene guardados de esta ` +
  `billetera, ni ninguno de los que la cadena tiene registrados en el índice de esta billetera, está ` +
  `abierto en el contrato.`;

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// LAS MARCAS DE DUDA, QUE SIGUEN VIGILANDO EL OTRO LADO
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Las cinco copias de la familia "no preguntamos" NO tienen una constante única que fijar (son cinco
// desenlaces con dos textos distintos), y lo que no pueden perder es el matiz: tienen que traer al
// menos una marca de duda sobre lo que NOSOTROS hicimos. Para eso siguen sirviendo. Es una clase
// cerrada del español (los modalizadores epistémicos con los que se hedgea), no una lista de frases
// prohibidas, y NO se declara completa.
//
// ⚠️ QUÉ SOSTIENE CARGA, MEDIDO (re-AR/MNR-8). La versión anterior de este comentario decía que la
// lista "no se puede achicar gratis" porque borrar un patrón pondría en rojo el otro lado. Es falso
// para 24 de los 25, y se midió patrón por patrón: borrar `/puede que/i` deja la suite verde, borrar
// `/no hayamos/i` también, y dejar SÓLO `/no llegamos/i` + `/no pudimos/i` (23 borrados) también.
// El único patrón con control es `/no llegamos/i`: borrarlo pone en rojo exactamente un caso, el de
// "User rejected the request.", que es la única de las cinco copias que no dice "no pudimos". Los
// otros 24 son cobertura preventiva SIN control: están para el texto que alguien escriba mañana, no
// porque algo los ejercite hoy. Achicar la lista es gratis para la suite; el costo es el de mañana.
const MARCAS_DE_DUDA: readonly RegExp[] = [
  /puede que/i,
  /puede ser/i,
  /podría/i,
  /podríamos/i,
  /quizá/i,
  /tal vez/i,
  /capaz que/i,
  /es posible/i,
  /posiblemente/i,
  /es probable/i,
  /probablemente/i,
  /aparentemente/i,
  /al parecer/i,
  /parece que/i,
  /creemos/i,
  /no estamos seguros/i,
  /no sabemos/i,
  /no pudimos/i,
  /no llegamos/i,
  /no alcanzamos/i,
  /no hayamos/i,
  /hubiéramos/i,
  /habríamos/i,
  /hasta donde/i,
  /si es que/i,
];

/** Las marcas de duda que un texto trae. Vacío = el texto afirma, no matiza. */
function dudasEn(texto: string): string[] {
  return MARCAS_DE_DUDA.filter((m) => m.test(texto)).map(String);
}

/**
 * La aserción del bloqueante: la pantalla NO afirma haber mirado ningún envío.
 *
 * 🔴 ALCANCE, Y ES MÁS CHICO QUE EL NOMBRE DE ESTA FUNCIÓN (WKH-346 fix-pack AR-2/MNR-4). Este guard
 * vale **sólo cuando no se recuperó nada antes**, que es el caso de los tres tests de abajo: la primera
 * búsqueda es la que falla.
 *
 * WKH-346 metió la subcadena `últimos ${MAX_RECOVERY_CANDIDATES} envíos` en el copy de
 * `recoveryMoreEscrowsHint`, que se muestra cuando YA se recuperó al menos un escrow. Existe un estado
 * alcanzable —y `T-346-15` lo EXIGE— donde la pantalla dice "no llegamos a preguntar" **y** contiene esa
 * subcadena: recuperar uno y después recibir `escrow_recovery_unavailable`. Ahí el assert de más abajo
 * fallaría, y no porque la pantalla afirme algo falso.
 *
 * ⚠️ Por qué NO es un bloqueante ni se relaja el guard: los dos textos dicen cosas distintas. El que
 * WKH-331 prohibió afirmaba un **resultado** ("ninguno de los últimos N está abierto"); el nuevo
 * describe el **mecanismo** ("cada búsqueda mira los últimos N"), y describir el alcance de la ventana
 * no es afirmar haberla mirado. Lo que quedó ciego es este guard, en el caso que WKH-346 creó.
 *
 * ⛔ SI ALGUIEN AMPLÍA ESTOS TESTS a un escenario con una recuperación previa, este assert va a fallar
 * por la razón equivocada. El arreglo NO es borrarlo: es acotarlo al bloque de error
 * (`queryByText` sobre el nodo del error), no sobre todo el documento.
 */
async function laPantallaNoAfirmaHaberMirado() {
  await waitFor(() => {
    expect(screen.getByText(/no llegamos a preguntar/)).toBeInTheDocument();
  });
  expect(screen.queryByText(/No encontramos escrows abiertos/)).not.toBeInTheDocument();
  expect(
    screen.queryByText(new RegExp(`últimos ${MAX_RECOVERY_CANDIDATES} envíos`)),
  ).not.toBeInTheDocument();
}

describe("AC-1/AC-2/AC-8: los TRES desenlaces en que el registro no nos contestó, con el resolver REAL", () => {
  // Los tres los dispara una BANDERA DE CONFIGURACIÓN, no una caída: con el registro apagado, o el
  // secreto del PoP ausente, le pasan a TODO EL MUNDO y en TODAS las búsquedas.
  it("A) el mecanismo de prueba de posesión está apagado (501 en el challenge) ⇒ no se afirma nada", async () => {
    const llamadas = stubFetch({
      [RUTA_CHALLENGE]: () => Response.json({ error: "pop_not_configured" }, { status: 501 }),
    });
    buscarConElContainerReal();

    await laPantallaNoAfirmaHaberMirado();
    // CD-7: y la prueba MEDIDA de que no se preguntó — nunca se llegó al endpoint de los ids.
    expect(llamadas).toEqual([RUTA_CHALLENGE]);
  });

  it("B) el registro durable está apagado (501 en los ids) ⇒ no se afirma nada", async () => {
    stubFetch({
      [RUTA_CHALLENGE]: challengeOk,
      [RUTA_IDS]: () => Response.json({ error: "escrow_recovery_not_enabled" }, { status: 501 }),
    });
    buscarConElContainerReal();

    await laPantallaNoAfirmaHaberMirado();
  });

  it("C) la prueba de posesión no verificó (403 en los ids) ⇒ no se afirma nada", async () => {
    stubFetch({
      [RUTA_CHALLENGE]: challengeOk,
      [RUTA_IDS]: () => Response.json({ error: "pop_invalid" }, { status: 403 }),
    });
    buscarConElContainerReal();

    await laPantallaNoAfirmaHaberMirado();
  });
});

describe("AC-5: la firma de posesión no se completó, que tampoco es una respuesta sobre los fondos", () => {
  // ⚠️ El string lo escribe la wallet y no lo controlamos: "User rejected the request." es el que
  // manda Phantom. Usar acá el código interno en vez del texto real dejaría sin vigilar justo la
  // traducción que la rama existe para hacer.
  it("D) la persona rechaza la firma ⇒ se dice que no llegamos a preguntar, NO que fracasamos", async () => {
    stubFetch({ [RUTA_CHALLENGE]: challengeOk });
    solanaWalletBridge.registerSignMessage(async () => {
      throw new Error("User rejected the request.");
    });
    buscarConElContainerReal();

    await waitFor(() => {
      expect(screen.getByText(/aceptá la firma/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/No pudimos recuperar los fondos/)).not.toBeInTheDocument();
  });
});

describe("AC-3: el CONTROL, sin el cual los cuatro de arriba no prueban nada", () => {
  // 🔴 POR QUÉ ESTE CASO EXISTE. Un arreglo que hiciera decir "no llegamos a preguntar" en las CUATRO
  // condiciones pasaría A/B/C/D sin despeinarse, y sería tan falso como el defecto que WKH-331 cerró,
  // sólo que en la otra dirección: la pantalla afirmaría no haber preguntado también cuando el servidor
  // sí contestó. Mismo resolver real, misma ruta, mismo árbol — la ÚNICA diferencia es el status y el
  // body.
  //
  // ⚠️ HASTA WKH-347 LAS ASERCIONES DE ACÁ ERAN POSITIVAS, y se exigían dos subcadenas PRESENTES para
  // que un mensaje distinto —o vacío— no satisficiera la negación. Ya no: con la segunda fuente del
  // índice, "el servidor contestó que no hay" dejó de agotar la búsqueda, y en jsdom el índice no se
  // puede leer. La razón completa y las dos mitades que hoy sostienen el control de la afirmación están
  // escritas sobre el `it` de abajo. Lo que este caso sigue vigilando, y es lo que no puede perderse, es
  // el otro extremo: que la pantalla NO afirme cuando no pudo mirar.
  // 🔴 WKH-347 — ESTE CONTROL CAMBIÓ DE SIGNO, Y NO ES UN TEST ROTO. Antes de esta HU "el servidor
  // contestó y no tiene ids" AGOTABA la búsqueda: el adapter tiraba `escrow_not_found` en el guard de
  // lista vacía, ANTES de cualquier `await import()`, y por eso la pantalla podía afirmar y jsdom
  // alcanzaba. Ahora hay una SEGUNDA fuente —el índice on-chain de esta billetera— y G-3 exige
  // consultarla exactamente acá. ⇒ La lista vacía del servidor ya no autoriza ninguna afirmación por sí
  // sola: falta saber qué dice el índice.
  //
  // ⚠️ Y EN ESTE ENTORNO EL ÍNDICE NO SE PUEDE LEER, y es un hecho de jsdom, no del código: la
  // derivación de PDA se cae acá con "Unable to find a viable program address nonce" (la misma causa que
  // `escrow-rent-discovery-junta.test.ts` ya dejó medida, y la razón por la que ese archivo no renderiza
  // React). Así que el desenlace correcto de este caso pasó a ser un MATIZ, y afirmar acá sería falso.
  //
  // 🔴 DÓNDE VIVE AHORA EL CONTROL DE QUE LA PANTALLA TODAVÍA PUEDE AFIRMAR — perderlo sería justo la
  // sobre-corrección que este archivo existe para cazar, así que va nombrado y son DOS mitades:
  //   · que el adapter produzca `escrow_not_found` con las DOS fuentes agotadas (el ledger sin ids y el
  //     índice existente y vacío): `T-347-10 (c)` en `solana-wallet.refund.test.ts`, que corre en node y
  //     sí puede derivar PDAs;
  //   · que ese código se diga con el copy que AFIRMA, palabra por palabra: el test de igualdad exacta
  //     de más abajo en este mismo archivo ("el copy legítimo REAL es EXACTAMENTE el literal vetado").
  // LO QUE SE PERDIÓ, dicho y no disimulado: el recorrido de las dos mitades juntas en un solo render.
  // No se puede recuperar en jsdom, porque después de G-3 no queda NINGÚN camino a `escrow_not_found`
  // que no toque la cadena.
  it("E) el registro contesta 200 con la lista vacía ⇒ se consulta el índice, y si no se pudo leer se MATIZA", async () => {
    stubFetch({
      [RUTA_CHALLENGE]: challengeOk,
      [RUTA_IDS]: () => Response.json({ remittanceIds: [] }, { status: 200 }),
    });
    buscarConElContainerReal();

    // Las tres aserciones son ESTABLES a través de W3.4 a propósito: valen igual para la red de
    // seguridad que se renderiza hoy y para el copy propio de `escrow_index_unreadable` que esa wave le
    // da. Así este test no hay que reescribirlo dos veces dentro de la misma HU.
    const err = await screen.findByText(/no es una respuesta sobre tus fondos/);
    // (1) MATIZA lo que NOSOTROS hicimos, con el mismo predicado que vigila a las otras cuatro copias.
    expect(dudasEn(err.textContent ?? "").length).toBeGreaterThan(0);
    // (2) 🚫 Y NO AFIRMA. Ésta es la aserción que esta HU no puede perder en la otra dirección: decir
    // "No encontramos" cuando el índice no se leyó sería afirmar de más sobre los fondos de la persona.
    expect(screen.queryByText(/No encontramos escrows abiertos/)).not.toBeInTheDocument();
    // (3) Ni se atribuye la VENTANA del servidor como si eso cerrara la pregunta. ⚠️ Ojo con el alcance
    // exacto, que cambió en el fix-pack de esta HU (AR/BLQ-2): el copy de `escrow_index_unreadable` SÍ
    // dice que el registro durable se consultó y no tenía ninguno abierto —es cierto, y negarlo era el
    // defecto— pero NO nombra el número de la ventana, porque "ninguno de los últimos N" al lado de un
    // índice que no se pudo leer se lee como una búsqueda terminada. Lo que este assert prohíbe es el
    // NÚMERO, no la mención de la fuente.
    expect(
      screen.queryByText(new RegExp(`últimos ${MAX_RECOVERY_CANDIDATES} envíos`)),
    ).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// LAS TRES VARIANTES MEDIDAS, Y POR DÓNDE SE COLABA CADA UNA
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Acá viven las tres variantes del copy legítimo que ALGUIEN APLICÓ DE VERDAD en `flow-vm.ts` y que
// dejaron la suite completa verde en su momento. No están como copy alternativo: son entradas de
// veredicto conocido, y cada una entró por una puerta distinta. Si mañana el guard vuelve a ser un
// predicado sobre la forma del texto, este bloque dice contra qué tiene que medirse.
describe("re-AR/MNR-6: la igualdad exacta rechaza las TRES variantes que las propiedades dejaban pasar", () => {
  // (1) La primera del AR: hedge epistémico ADELANTE de la afirmación. Conservaba las cuatro
  //     subcadenas ancladas, y por eso pasaba cuando el guard eran cuatro `toContain`.
  const VARIANTE_1_HEDGE_ADELANTE =
    `No encontramos escrows abiertos para esta billetera. Esto no dice que no tengas fondos: ` +
    `puede que no hayamos podido mirar ninguno de los últimos ${MAX_RECOVERY_CANDIDATES} envíos que ` +
    `el servidor tiene guardados de esta billetera.`;

  // (2) La que se escribió al calibrar la propiedad (2): SUBJUNTIVO. Hedgea sin usar ni una palabra de
  //     `MARCAS_DE_DUDA` — cambia "está abierto" por "esté abierto" y ya no afirma nada.
  const VARIANTE_2_SUBJUNTIVO =
    `No encontramos escrows abiertos para esta billetera. Esto no dice que no tengas fondos: dice que ` +
    `ninguno de los últimos ${MAX_RECOVERY_CANDIDATES} envíos que el servidor tiene guardados de esta ` +
    `billetera esté abierto en el contrato.`;

  // (3) La del re-AR: restricción de alcance POST-HOC. Cero marcas, indicativo intacto, las cuatro
  //     subcadenas enteras — porque el matiz va DESPUÉS. Contra un chequeo de PRESENCIA es invisible.
  const VARIANTE_3_ALCANCE_POST_HOC =
    `No encontramos escrows abiertos para esta billetera. Esto no dice que no tengas fondos: dice que ` +
    `ninguno de los últimos ${MAX_RECOVERY_CANDIDATES} envíos que el servidor tiene guardados de esta ` +
    `billetera está abierto en el contrato, y eso vale sólo para los que llegamos a revisar: la lista ` +
    `del servidor vino incompleta y varios quedaron sin mirar.`;

  // ⚠️ Las tres van escritas ENTERAS y no derivadas del literal de arriba con un `.replace()`. Una
  // derivación se convierte en no-op cuando el copy cambia, y entonces la variante pasaría a ser
  // idéntica al copy legítimo: el `not.toBe` de abajo quedaría rojo por la herramienta y no por el
  // código, que es exactamente el rojo que no señala nada real del que este fix-pack viene saliendo.

  it("el copy legítimo REAL es EXACTAMENTE el literal vetado", () => {
    expect(lostEscrowRecoveryError("escrow_not_found", MAX_RECOVERY_CANDIDATES)).toBe(
      COPY_LEGÍTIMO_DEL_NO_ENCONTRAMOS,
    );
  });

  for (const [nombre, variante] of [
    ["hedge adelante", VARIANTE_1_HEDGE_ADELANTE],
    ["subjuntivo", VARIANTE_2_SUBJUNTIVO],
    ["alcance post-hoc", VARIANTE_3_ALCANCE_POST_HOC],
  ] as const) {
    it(`la variante "${nombre}" NO es el copy legítimo, y conserva lo que estaba anclado`, () => {
      expect(variante).not.toBe(COPY_LEGÍTIMO_DEL_NO_ENCONTRAMOS);
      // Por qué hizo falta la igualdad: las tres pasaban las cuatro citas que había antes.
      expect(variante).toContain("No encontramos escrows abiertos");
      expect(variante).toContain("Esto no dice que no tengas fondos");
      expect(variante).toContain(`últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
      expect(variante).not.toContain("no llegamos a preguntar");
    });
  }

  // 🔴 EL CONTROL DE PRECISIÓN DE LA LISTA. Sin esto, `MARCAS_DE_DUDA` podría ensancharse hasta marcar
  // cualquier texto (un `/no/i` alcanzaría) y las aserciones de abajo seguirían verdes sin vigilar
  // nada. El copy legítimo AFIRMA: ninguna marca puede verlo.
  it("ninguna marca de duda marca al copy legítimo", () => {
    expect(dudasEn(COPY_LEGÍTIMO_DEL_NO_ENCONTRAMOS)).toEqual([]);
  });

  // 🔴 EL OTRO LADO, que es para lo que sigue existiendo la lista. Las copias de los desenlaces en que
  // NO se preguntó tienen que traer al menos una marca de duda, y no pueden afirmar haber mirado
  // ningún envío. Los códigos van escritos a mano.
  for (const code of [
    "User rejected the request.",
    "escrow_recovery_unavailable:pop_disabled",
    "escrow_recovery_unavailable:registry_disabled",
    "escrow_recovery_unavailable:pop_rejected",
    "escrow_id_unavailable",
  ]) {
    it(`"${code}" se dice matizando, y el predicado lo ve`, () => {
      const copy = lostEscrowRecoveryError(code, MAX_RECOVERY_CANDIDATES);
      expect(dudasEn(copy).length).toBeGreaterThan(0);
      // La afirmación del caso E no se cuela acá bajo ninguna redacción: es el número de lo mirado.
      expect(copy).not.toContain(`últimos ${MAX_RECOVERY_CANDIDATES} envíos`);
    });
  }
});
