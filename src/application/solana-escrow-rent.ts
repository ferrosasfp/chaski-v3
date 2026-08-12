// De dónde sale el SOL que el remitente necesita para depositar, y por qué el depósito NO es gasless
// para él.
//
// Dos cosas distintas se pagan en una transacción de Solana, y sólo una la paga el facilitator:
//
//   · COMISIÓN DE RED (fee). La paga el `feePayer` de la transacción, y en el depósito el feePayer es
//     el facilitator (`solana-wallet.ts`, `tx.feePayer = resolveSolanaFacilitatorPubkey()`). Medido en
//     devnet sobre las 3 transacciones patrocinadas que existen: el feePayer `4wPhH4dC` quedó en
//     -10.000 lamports. El remitente NO paga esto.
//
//   · ALQUILER (rent) DE LAS CUENTAS QUE SE CREAN. Lo paga el `payer` de cada cuenta `init`, y en el
//     contexto `Deposit` del programa ese payer es el SENDER
//     (`solana-programs/programs/escrow/src/lib.rs`, `#[account(init, payer = sender, ...)]`). Sobre
//     esas mismas 3 transacciones, el remitente `8tJVcM2J` quedó en -4.002.000 lamports.
//
// 🔴 ACÁ VIVIÓ UNA CUENTA QUE EL DEPÓSITO NO PAGABA, Y WKH-347 LA TRAJO DE VUELTA. Van las DOS
// mitades, porque borrar la primera es cómo se repite el error:
//
//   · HASTA WKH-347 el sumando estaba MAL. El umbral sumaba el rent de `EscrowIndex` (4.774.560
//     lamports) "para el primer depósito de una wallet nueva", y esa cuenta NO la creaba el depósito:
//     la ix `deposit` recibe 9 cuentas y `escrow_index` no es ninguna (verificable en
//     `src/infrastructure/solana/escrow-idl.ts`, la copia pinneada del IDL, y hay un test que lo ata).
//     La crea `register_escrow`, que Chaski no emitía. El sumando era 2,2× el costo real y podía
//     voltear una demo en vivo con un "te falta SOL" falso sobre una billetera que podía depositar
//     perfectamente.
//   · DESDE WKH-347 el sumando es CORRECTO, y la diferencia es exactamente ésa: la transacción del
//     depósito lleva `register_escrow` como SEGUNDA instrucción de negocio, así que crea la cuenta de
//     verdad y su alquiler sale de la billetera del remitente. El sumando NO volvió porque el error
//     viejo fuera correcto: volvió porque cambió el hecho que lo hacía falso. La ix `deposit` sigue sin
//     tocar `escrow_index`, y eso no cambió.
//
// ⚠️ LA FRASE QUE ESTA HU VOLVIÓ FALSA, dicha para que nadie la vuelva a citar: acá se leía que "un
// grep de `register` en `src/infrastructure/solana-wallet.ts` da CERO resultados". Desde WKH-347 da
// varios, porque ese archivo construye la ix.
//
// Y la lectura de la medición en cadena sigue siendo correcta PARA SU FECHA (2026-08, antes de
// WKH-347): las 3 txs costaron 4.002.000 y no 8.776.560, y el motivo no era que el índice ya
// existiera, sino que ninguna de esas transacciones emitía `register_escrow`.
//
// DERIVACIÓN DEL UMBRAL — cada sumando tiene una fuente, ninguno sale de una estimación:
//
//   ── lo que el DEPÓSITO le saca a la billetera ──────────────────────────────────────────────────
//   EscrowState (154 bytes) ......... 1.962.720 lamports  ← solana-programs/README.md, sección
//                                                            "On-chain state": el renglón que dice
//                                                            ese mismo número. Medido, no estimado.
//   vault (ATA del mint, 165 bytes) . 2.039.280 lamports  ← el README lo da como "standard SPL" sin
//                                                            número. Sale de la resta de la medición
//                                                            en cadena: 4.002.000 - 1.962.720 =
//                                                            2.039.280, que es exactamente el
//                                                            rent-exempt canónico de una token
//                                                            account SPL. Los dos caminos coinciden.
//   subtotal depósito ............... 4.002.000 lamports  ← COINCIDE EXACTO con lo medido en cadena
//                                                            para el primer depósito de una wallet
//                                                            nueva. Es la prueba de que no falta
//                                                            ninguna cuenta en esta lista.
//
//   ── lo que el REFUND le va a sacar después, y el umbral no cubría ──────────────────────────────
//   En `refundEscrow` el feePayer es el SENDER (`solana-wallet.ts`, `tx.feePayer = senderPk`), así
//   que la comisión de esa transacción sale de su billetera. El archivo lo DECLARABA como no cubierto
//   y no lo sumaba, y esa combinación deja a la persona que depositó con lo justo sin con qué firmar
//   su propia recuperación: los USDC quedan en el vault y la única salida trustless no se puede
//   pagar. Se suma, y con los dos términos separados:
//
//   comisión base (1 firma) .........     5.000 lamports  ← 5.000 por firma. No es un número elegido:
//                                                            el depósito tiene 2 firmas (facilitator
//                                                            + sender) y midió 10.000 en cadena. El
//                                                            refund tiene UNA sola (el sender es el
//                                                            único signer, `signed.serialize()` con
//                                                            requireAllSignatures por default).
//   propina de la billetera .........    75.000 lamports  ← la tx de refund NO declara instrucciones
//                                                            de ComputeBudget, así que la billetera
//                                                            inyecta las suyas. Medido sobre el
//                                                            depósito antes de WKH-321, cuando
//                                                            tampoco las declaraba: Phantom metía
//                                                            375.000 µL/CU y 200.000 CU (SDD 038,
//                                                            `doc/sdd/038-.../sdd.md`:18). Eso da
//                                                            375.000 × 200.000 / 1e6 = 75.000
//                                                            lamports, consistente con los "80-85 k
//                                                            lamports" de fee total que el SDD
//                                                            reporta para esa transacción.
//
//   ── lo que el REGISTRO EN EL ÍNDICE le saca a la billetera, desde WKH-347 ───────────────────────
//   EscrowIndex (558 bytes) ......... 4.774.560 lamports  ← el renglón que este archivo tenía
//                                                            RESERVADO por adelantado en "lo que
//                                                            sigue sin cubrir": "si algún día se
//                                                            emite `register_escrow`, el sumando
//                                                            vuelve acá con su propia línea". Ese día
//                                                            es WKH-347. Derivación completa en el
//                                                            docblock de la constante, más abajo.
//   ────────────────────────────────────────────────────
//   suma .............................. 8.856.560 lamports
//   umbral (redondeo ARRIBA) .......... 8.874.560 lamports  (0,0089 SOL)
//
// EL MARGEN, DICHO COMO LO QUE ES. Los 18.000 lamports de diferencia son REDONDEO, no una reserva
// calculada: no hay ninguna medición que diga cuánto margen hace falta, así que no se inventa una. Se
// redondea HACIA ARRIBA a propósito: quedar corto por redondeo deja a alguien sin poder firmar su
// refund, y quedar largo sólo le pide unos lamports de más. Son EXACTAMENTE los mismos 18.000 del
// umbral anterior: esta HU no inventa margen nuevo, sólo agrega un sumando que corresponde a una
// cuenta.
//
// 🔴 LO QUE ESTE UMBRAL CUESTA, SIN SUAVIZARLO (es parte de la decisión G-2, no una nota al pie):
//
//   1. Le pide 2,22× lo que el depósito cuesta a la MAYORÍA de los remitentes, que ya tienen índice y
//      por lo tanto no van a pagar ese alquiler. El sobrepedido es real y afecta a todos menos al
//      primer depósito de cada billetera. EL DENOMINADOR VA NOMBRADO, porque acá hay dos números que se
//      parecen: es `MEASURED_FIRST_DEPOSIT_LAMPORTS` (4.002.000, la medición en cadena), y
//      8.874.560 / 4.002.000 = 2,2175 ⇒ 2,22×.
//      🔴 ACÁ DECÍA 2,16×, Y ERA FALSO EN LA LÍNEA QUE EXISTE PARA NO SUAVIZAR EL COSTO. Ese 2,16 sale
//      de dividir por 4.100.000, o sea por el UMBRAL ANTERIOR, que es otra pregunta ("pide el doble que
//      el umbral que había") y no "lo que el depósito cuesta". El punto 2 de acá abajo usa el
//      denominador correcto, así que las dos cifras vivían en la misma lista con bases distintas.
//      Y el ratio ya no es sólo prosa: lo asserta `solana-escrow-rent.test.ts` contra las constantes.
//   2. 8.874.560 es prácticamente el 9.000.000 que este mismo archivo describe más arriba como "pedía
//      2,25× lo que el depósito cuesta" y que ESTE REPO YA REVIRTIÓ UNA VEZ por eso. El parecido no es
//      casualidad ni ironía: es el mismo orden de magnitud y el mismo riesgo de "te falta SOL" sobre
//      una billetera que podría depositar.
//   3. LA DIFERENCIA QUE LO VUELVE DEFENDIBLE, y es la única: aquella vez el sumando no correspondía a
//      NINGUNA cuenta que la transacción creara. Ahora corresponde a una cuenta que la transacción
//      crea de verdad. El número se parece; el motivo no.
//   4. POR QUÉ ES ÚNICO Y NO CONDICIONAL. La forma condicional —pedir 4.100.000 a quien ya tiene
//      índice y 8.874.560 a quien no— obliga a que DOS lecturas del índice coincidan: la del guard, en
//      la capa de aplicación, y la de `authorizePrincipal`, en infraestructura, separadas por una
//      llamada de red. Si el guard leyó "presente" y la sonda lee "ausente", la transacción crea el
//      índice con un saldo que no lo cubre y EL DEPÓSITO REVIERTE EN CADENA. El umbral único elimina
//      ese modo de falla por construcción, y ése es el costo que se aceptó a cambio.
//
// LO QUE ESTE UMBRAL SIGUE SIN CUBRIR, y se declara en vez de disfrazarse:
//   · Una propina de billetera mayor a la medida. 375.000 µL/CU es lo que se midió de Phantom; otra
//     billetera, u otra versión, puede inyectar más. No hay medición de eso y no se inventa una.
//
// NO TOCAR ESTE NÚMERO sin cambiar los tamaños de las cuentas del programa, sin cambiar qué cuentas
// tocan las ix `deposit` / `register_escrow`, o sin una medición nueva: es lo único que lo determina.

/**
 * Alquiler exento de renta de la cuenta `EscrowIndex`, que la ix `register_escrow` crea con
 * `payer = sender`.
 *
 * ⚠️ VA DECLARADO ACÁ ARRIBA, Y NO AL FINAL DEL ARCHIVO, por una razón mecánica y no estética: el
 * umbral de abajo lo SUMA, y un `const` no puede referenciar a otro que se declara después. Que el
 * sumando esté antes de la suma es lo que permite escribir el umbral como una suma de sumandos
 * NOMBRADOS en vez de como un literal nuevo.
 *
 * LA DERIVACIÓN, que es lo que lo vuelve una suma y no un literal:
 *
 *     space      = 8 (discriminador de anchor) + EscrowIndex::INIT_SPACE      (lib.rs:840)
 *     INIT_SPACE = 32 (sender) + 1 (version) + 1 (bump) + 4 (prefijo del Vec)
 *                  + 16 × 32 (las entradas, `#[max_len(MAX_ENTRIES)]`)  = 550
 *     ⇒ space    = 558 bytes
 *     rent-exempt = (128 + 558) × 6960 = 4.774.560 lamports
 *
 * LA VALIDACIÓN QUE LO VUELVE UNA DERIVACIÓN Y NO UNA ESTIMACIÓN: la MISMA fórmula aplicada a
 * `EscrowState` (154 bytes) da (128 + 154) × 6960 = 1.962.720, que es exactamente
 * (`ESCROW_STATE_RENT_LAMPORTS`, `:203`), un número que salió de una medición en cadena y no de esta
 * fórmula. Los dos caminos coinciden sobre un valor conocido-bueno. Sin esta validación, el 4.774.560
 * sería un literal más.
 *
 * UNA SOLA VEZ POR REMITENTE, y por eso el segundo depósito y los siguientes no pagan nada: la cuenta
 * es `init_if_needed` (`lib.rs:838`) y se aloja al tamaño MÁXIMO desde el principio
 * (`#[max_len(MAX_ENTRIES)]`, `lib.rs:432`), así que no hay realloc ni alquiler incremental. El umbral
 * igual lo pide siempre: ver el punto 4 de "lo que este umbral cuesta", más arriba.
 *
 * ⛔ LO QUE NO VUELVE, y va dicho porque cambia lo que se le puede prometer a la persona: este
 * alquiler NO está en (`ESCROW_DEPOSIT_RENT_LAMPORTS`, `:223`) y NO vuelve con el `close`. La cuenta
 * `escrow_index` es OPCIONAL en la ix `close` y existe un `close` válido que ni la recibe, así que su
 * alquiler no puede estar en lo que `close` devuelve siempre. Que ninguna instrucción del programa la
 * cierre es lectura del RUST, no del IDL: el IDL no expresa las constraints `close = ...` de Anchor.
 * ⇒ el copy de "cuánto recuperás al cerrar" NO cambia por esta constante.
 */
export const ESCROW_INDEX_RENT_LAMPORTS = 4_774_560;

/** Lo que el remitente `8tJVcM2J` pagó de verdad en su PRIMER depósito, medido en devnet: el subtotal
 *  de arriba. Se escribe como la MEDICIÓN y no como la suma de sus partes a propósito — son dos
 *  fuentes independientes del mismo número, y hay un test que verifica que coinciden con
 *  (`ESCROW_DEPOSIT_RENT_LAMPORTS`, `:223`). Si divergen, una de las dos está mal y hay que ir a ver
 *  cuál. */
const MEASURED_FIRST_DEPOSIT_LAMPORTS = 4_002_000;

/** La comisión que el REFUND le va a sacar al sender después, y que el umbral tiene que dejarle
 *  guardada: 5.000 de comisión base por su única firma + 75.000 de propina de billetera. Los dos
 *  sumandos, con su fuente, están en la derivación de arriba. */
const REFUND_FEE_ALLOWANCE_LAMPORTS = 5_000 + 75_000;

/** El redondeo hacia arriba, que es redondeo y no reserva calculada. Ver "EL MARGEN, DICHO COMO LO QUE
 *  ES", arriba. Es el mismo que ya tenía el umbral anterior. */
const ROUNDING_UP_LAMPORTS = 18_000;

export const SENDER_MIN_LAMPORTS_FOR_DEPOSIT =
  MEASURED_FIRST_DEPOSIT_LAMPORTS +
  REFUND_FEE_ALLOWANCE_LAMPORTS +
  ROUNDING_UP_LAMPORTS +
  ESCROW_INDEX_RENT_LAMPORTS;

// ── WKH-327 · el mismo alquiler, ahora mirado desde el lado que lo DEVUELVE ─────────────────────────
// Estos tres números NO son nuevos: son exactamente los sumandos que la derivación de acá arriba ya
// escribió (`:42-55`), extraídos a constantes porque a partir de esta HU hay una segunda pregunta que
// los necesita — cuánto recupera la persona al cerrar las cuentas. Escribirlos de nuevo en la UI es
// cómo la cifra de pantalla y la derivación empiezan a divergir sin que nada se ponga rojo.
//
// ⛔ Ninguno de estos se suma a SENDER_MIN_LAMPORTS_FOR_DEPOSIT ni lo modifica.

/** `EscrowState`, 154 bytes. Fuente: `:43-45` (solana-programs/README.md:345, medido por la suite del
 *  programa contra el banco in-process). */
export const ESCROW_STATE_RENT_LAMPORTS = 1_962_720;

/** ATA del vault, 165 bytes. Fuente: `:46-51` — sale de la resta de la medición en cadena
 *  (4.002.000 − 1.962.720) y coincide con el rent-exempt canónico de una token account SPL. */
export const ESCROW_VAULT_RENT_LAMPORTS = 2_039_280;

/**
 * Lo que la ix `close` le devuelve al remitente: el alquiler de LAS DOS cuentas que el `deposit` creó
 * con `payer = sender`. Fuente del subtotal: `:52-55`, donde ya está dicho que 4.002.000 COINCIDE
 * EXACTO con lo medido en cadena para el primer depósito de una billetera nueva.
 *
 * ⛔ NO incluye el alquiler de `EscrowIndex` (4.774.560 lamports) y no es un olvido. Lo que sostiene
 * la exclusión, y es lo verificable: la ix `close` declara `escrow_index` como cuenta OPCIONAL en el
 * IDL, así que existe un `close` válido que ni la recibe y su alquiler no puede estar en lo que
 * `close` devuelve siempre (test en `solana-escrow-rent.test.ts`). Que ninguna instrucción del
 * programa cierre esa cuenta **no se pudo verificar** desde este repo: el IDL no expresa las
 * constraints `close = ...` de Anchor. Ver `:16-38` (la historia del sumando) y `:82-89` (el renglón
 * del índice en la derivación del umbral, que desde WKH-347 SÍ se cobra en el depósito aunque no vuelva
 * con el `close` — son dos preguntas distintas y ésta no cambió).
 */
export const ESCROW_DEPOSIT_RENT_LAMPORTS =
  ESCROW_STATE_RENT_LAMPORTS + ESCROW_VAULT_RENT_LAMPORTS;

/** 5.000 lamports por firma. Fuente: `:64-69` — el depósito tiene 2 firmas y midió 10.000 en cadena.
 *  La tx de `close` tiene UNA sola (el sender es el único signer). Lo que este número NO cubre: la
 *  propina que inyecta la billetera, que es una incógnita declarada (`propina`, `:128`) y que `close` tampoco
 *  acota, porque no declara ComputeBudget. Por eso el copy no promete un neto. */
export const SOLANA_BASE_FEE_PER_SIGNATURE_LAMPORTS = 5_000;

/** Lamports por SOL. Constante del protocolo (1 SOL = 10^9 lamports). */
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Decimales con los que se muestra un monto en SOL. Cuatro y no tres porque el umbral vive en el
 *  cuarto decimal (0,0089 SOL desde WKH-347; era 0,0041 antes): con tres, el copy mostraría "0,008" y
 *  estaría pidiendo MENOS de lo que el guard exige. El razonamiento no cambió con el umbral nuevo, y
 *  sigue habiendo un test que lo ata leyendo el texto de vuelta a lamports. */
const SOL_DISPLAY_DECIMALS = 4;
const SOL_DISPLAY_FACTOR = 10 ** SOL_DISPLAY_DECIMALS;
/** Cuántos lamports vale el último decimal que se muestra. División exacta entre potencias de 10. */
const LAMPORTS_PER_DISPLAY_UNIT = LAMPORTS_PER_SOL / SOL_DISPLAY_FACTOR;

/**
 * Lamports → SOL en texto, para el copy de la UI. Se formatea DESDE la constante para que el número
 * que lee la persona no pueda divergir del que compara el guard (una sola fuente, dos usos).
 *
 * ⚠️ REDONDEA HACIA ARRIBA, y no es cosmético: este texto le dice a alguien cuánto SOL cargar. Un
 * redondeo hacia abajo le hace cargar menos de lo que el guard exige, o sea que vuelve a chocar con
 * el mismo error después de haber hecho exactamente lo que la pantalla le pidió. El único error
 * gratis es pedir de más.
 *
 * El `ceil` corre sobre ENTEROS (lamports por unidad de display), nunca sobre el flotante en SOL:
 * `Math.ceil(0.0041 * 10000)` puede dar 42 por representación binaria, y el copy diría 0,0042.
 */
export function formatLamportsAsSol(lamports: number): string {
  const units = Math.ceil(lamports / LAMPORTS_PER_DISPLAY_UNIT);
  return (units / SOL_DISPLAY_FACTOR).toFixed(SOL_DISPLAY_DECIMALS).replace(".", ",");
}

/**
 * El MISMO formateo, redondeando hacia ABAJO. WKH-327.
 *
 * POR QUÉ EXISTE UNA SEGUNDA FUNCIÓN Y NO UN PARÁMETRO: el sentido del redondeo no es una preferencia
 * de estilo, depende de si el número es algo que se PIDE o algo que se RECIBE, y son dos decisiones
 * distintas que conviene no poder mezclar en un call-site.
 *   · `formatLamportsAsSol` redondea ARRIBA porque le dice a alguien cuánto cargar, y pedir de más es
 *     el error gratis (ver su docblock, `formatLamportsAsSol`, `:256`).
 *   · Ésta redondea ABAJO porque el número es lo que la persona va a COBRAR, y redondear hacia arriba
 *     lo que alguien va a cobrar es prometer de más.
 *
 * EL CASO CONCRETO, medido: `formatLamportsAsSol(ESCROW_DEPOSIT_RENT_LAMPORTS)` devuelve "0,0041"
 * sobre un valor real de 0,004002 SOL — sobreestima 2,4% lo que la persona recupera. Con el floor la
 * cifra es "0,0040", y ésa sigue siendo la razón por la que esta función existe: no prometer de más lo
 * que alguien va a cobrar.
 *
 * ⚠️ LA COLISIÓN QUE MOTIVÓ ESTA FUNCIÓN YA NO EXISTE, y conviene decirlo antes de que alguien la cite
 * como si siguiera vigente. Hasta WKH-347, "0,0041" era EXACTAMENTE la misma cadena que devolvía
 * `formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT)`, así que un test de copy que assertara
 * "0,0041" pasaba igual con la constante equivocada adentro, y el `floor` era lo que separaba las dos
 * cadenas. Con el umbral de WKH-347 el umbral se muestra "0,0089" y el alquiler devuelto "0,0041": ya
 * no colisionan por sí solos.
 *
 * ⇒ El `floor` NO se saca por eso, y el test de separación TAMPOCO. La colisión desapareció por el
 * VALOR de una constante que puede volver a moverse, no por una propiedad de estas dos funciones; el
 * único guard que no depende de ese valor es el que compara `floor(RENT)` contra `ceil(UMBRAL)`
 * directamente. Ése es el que sostiene al test de copy y el que hay que conservar.
 *
 * LO QUE EL FLOOR CUESTA, dicho: subestima 0,000002 SOL (0,05%). Es el error barato — quedarse corto
 * en lo que se promete devolver.
 *
 * El `floor` corre sobre ENTEROS (lamports por unidad de display), nunca sobre el flotante en SOL, por
 * la misma razón de representación binaria que su hermana.
 */
export function formatLamportsAsSolFloor(lamports: number): string {
  const units = Math.floor(lamports / LAMPORTS_PER_DISPLAY_UNIT);
  return (units / SOL_DISPLAY_FACTOR).toFixed(SOL_DISPLAY_DECIMALS).replace(".", ",");
}

