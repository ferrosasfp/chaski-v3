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
//   EscrowState (154 bytes) ......... 1.962.720 lamports  ← solana-programs/README.md, "On-chain
//                                                            state". 🔴 ES EL NÚMERO DE MAINNET (factor
//                                                            6960): devnet HOY cobra 1.785.906 (6333).
//   vault (ATA del mint, 165 bytes) . 2.039.280 lamports  ← el README lo da como "standard SPL" sin
//                                                            número. Sale de la resta de la medición
//                                                            en cadena (4.002.000 - 1.962.720) y es el
//                                                            rent-exempt canónico de una token account
//                                                            SPL. 🔴 TAMBIÉN ES DE MAINNET: devnet hoy
//                                                            cobra 1.855.569. Ver el bloque HU-077.
//   subtotal depósito ............... 4.002.000 lamports  ← ERA CIERTO PARA SU FECHA, y lo prueban 14
//                                                            cuentas vivas en devnet creadas a 6960. La
//                                                            tarifa de devnet cambió SOLA a 6333: hoy
//                                                            son 3.641.475. NO baja acá: PIDE ⇒ MÁXIMO.
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
 *     rent-exempt = (128 + 558) × 6960 = 4.774.560 lamports  ← 🔴 el factor de MAINNET; devnet hoy
 *     cobra 4.344.438 (6333). Este número es el MÁXIMO de {devnet, mainnet} porque es lado PIDE (CD-44).
 * LA VALIDACIÓN QUE LO VUELVE UNA DERIVACIÓN Y NO UNA ESTIMACIÓN: la MISMA fórmula aplicada a
 * `EscrowState` (154 bytes) da (128 + 154) × 6960 = 1.962.720, que es exactamente
 * lo que `getMinimumBalanceForRentExemption(154)` contestó en mainnet ese día — una medición en
 * cadena, no esta fórmula. Los dos caminos coinciden sobre un valor conocido-bueno. Sin esta
 * validación, el 4.774.560 sería un literal más. (HU-079 borró la constante que guardaba ese
 * 1.962.720; la medición sigue siendo verificable con el mismo `getMinimumBalance…`.)
 *
 * UNA SOLA VEZ POR REMITENTE, y por eso el segundo depósito y los siguientes no pagan nada: la cuenta
 * es `init_if_needed` (`lib.rs:838`) y se aloja al tamaño MÁXIMO desde el principio
 * (`#[max_len(MAX_ENTRIES)]`, `lib.rs:432`), así que no hay realloc ni alquiler incremental. El umbral
 * igual lo pide siempre: ver el punto 4 de "lo que este umbral cuesta", más arriba.
 *
 * ⛔ LO QUE NO VUELVE, y va dicho porque cambia lo que se le puede prometer a la persona: este
 * alquiler NO entra en lo que la pantalla del cierre promete y NO vuelve con el `close`. La cuenta
 * `escrow_index` es OPCIONAL en la ix `close` y existe un `close` válido que ni la recibe, así que su
 * alquiler no puede estar en lo que `close` devuelve siempre. Que ninguna instrucción del programa la
 * cierre es lectura del RUST, no del IDL: el IDL no expresa las constraints `close = ...` de Anchor.
 * ⇒ el copy de "cuánto recuperás al cerrar" NO cambia por esta constante.
 */
export const ESCROW_INDEX_RENT_LAMPORTS = 4_774_560;

/** Lo que el remitente `8tJVcM2J` pagó de verdad en su PRIMER depósito, medido en devnet CUANDO DEVNET
 *  COBRABA 6960: el subtotal de arriba. Se escribe como la MEDICIÓN y no como la suma de sus partes a
 *  propósito — son dos fuentes independientes del mismo número, y hay un test que verifica que coinciden
 *  con la suma de sus hojas. 🔴 HU-079: esas hojas SE BORRARON y este número se queda, ahora como lo
 *  que es — un RESPALDO: ver su renglón en el bloque de arriba y en (`senderMinLamportsForDeposit`,
 *  `:301`), que es quien lo usa cuando la lectura de cadena no ocurre. */
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

// ── HU-079 · EL ALQUILER DEL LADO QUE SE DEVUELVE YA NO VIVE ACÁ ───────────────────────────────────
//
// 🔴 ACÁ VIVÍAN SEIS CONSTANTES Y LAS SEIS SE BORRARON, no porque su valor fuera incorrecto sino
// porque la forma lo era: `ESCROW_{STATE,VAULT}_RENT_{MAINNET,DEVNET}_LAMPORTS` y el par
// `_RETURNED_` / `_CHARGED_` que se derivaba de ellas con un `min` y un `max`.
//
// LA HISTORIA, con su fecha, porque explica la regla y no se reescribe (WKH-327 → HU-077 → HU-079):
//   · 2026-09-03 · HU-077. La pantalla del cierre prometía "0,0040" y la cadena devolvía "0,0036".
//     La causa NO fue un número mal medido: los 4.002.000 eran CIERTOS para su fecha. Fue que LA
//     CADENA MOVIÓ SU TARIFA SOLA — devnet de 6960 a 6333 lamports por byte-año. El arreglo separó
//     los dos lados por dirección (CD-44) y congeló CUATRO hojas medidas ESE día:
//         size                        devnet        mainnet
//         154 (EscrowState) ....... 1.785.906      1.962.720
//         165 (ATA del vault) ..... 1.855.569      2.039.280
//   · 2026-09-04 · HU-079, UN DÍA DESPUÉS y sin un solo commit en el medio (`git log cd94bfd..HEAD`
//     ⇒ 0), las CUATRO habían envejecido: devnet pasó a 5080 y mainnet a 6333, o sea que lo que ayer
//     era el par de devnet hoy es el de mainnet. Peor: NINGUNA de las 15 cuentas vivas de devnet
//     tenía el mínimo de ese día, porque la tarifa se cobra al CREAR. Convivían TRES respuestas
//     correctas y distintas, y la pantalla mostraba UNA.
//
// 🔴 LA CONCLUSIÓN, QUE ES LO ÚNICO NORMATIVO DE ESTE BLOQUE (CD-079-2): un literal es legítimo
// cuando lo que describe cambia con un DESPLIEGUE, e ilegítimo cuando lo cambia la cadena SOLA. Lo
// primero es un evento de COMMIT y un pin atado al gate sí puede cazarlo; lo segundo es un evento de
// CALENDARIO y NINGÚN guard del gate puede. ⇒ la tarifa de alquiler no se escribe: se PREGUNTA, con
// (`SolanaRentReader`, `./ports.ts:1318`). Todo literal que sobreviva en este archivo lleva en su
// docblock cuál de los dos es.
//
// ⚠️ ACÁ DECÍA, TEXTUALMENTE, "leer la tarifa del RPC en runtime es otra HU, y no es ésta". ÉSTA ES
// ESA HU, y conviene decir qué mitad cerró y qué mitad no: se leen el par del escrow ABIERTO (lo que
// el `close` devuelve, exacto) y el del depósito NUEVO (lo que el umbral necesita). Lo que NO se leyó
// es la cifra de `PantallaFirmar` —su pregunta es la prospectiva y la lectura existe, pero atravesar
// el VM del recorrido es otra ola, y esa pantalla cuelga de una bandera APAGADA— ni
// `NONCE_ACCOUNT_RENT_LAMPORTS`, que es el MISMO defecto de clase y queda declarado en su docblock.

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
 *     el error gratis (ver su docblock, `formatLamportsAsSol`, `:259`).
 *   · Ésta redondea ABAJO porque el número es lo que la persona va a COBRAR, y redondear hacia arriba
 *     lo que alguien va a cobrar es prometer de más.
 *
 * EL CASO CONCRETO, con el valor que la cadena devolvía el 2026-09-03: `formatLamportsAsSol(3_641_475)`
 * devuelve "0,0037" sobre un valor real de 0,003641475 SOL — sobreestima 1,61 % lo que la persona
 * recupera. ⚠️ ESE PORCENTAJE ES DE ESE VALOR Y NO DE LA FUNCIÓN: desde HU-079 la cifra la lee la
 * cadena, así que cuánto sobreestimaría el ceil depende de qué se leyó. Lo invariante es la dirección.
 *
 * ⚠️ LA COLISIÓN QUE MOTIVÓ ESTA FUNCIÓN YA NO EXISTE, y conviene decirlo antes de que alguien la cite
 * como si siguiera vigente. Hasta WKH-347, "0,0041" era EXACTAMENTE la misma cadena que devolvía
 * `formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT)`, así que un test de copy que assertara
 * "0,0041" pasaba igual con la constante equivocada adentro, y el `floor` era lo que separaba las dos
 * cadenas. Con el umbral de WKH-347 el umbral se muestra "0,0089" y el alquiler devuelto "0,0036"
 * (era "0,0041" hasta HU-077, cuando el lado que se muestra llevaba el valor de mainnet): ya no
 * colisionan por sí solos.
 *
 * ⇒ El `floor` NO se saca por eso, y el test de separación TAMPOCO. La colisión desapareció por el
 * VALOR de una constante que puede volver a moverse, no por una propiedad de estas dos funciones; el
 * único guard que no depende de ese valor es el que compara `floor(RENT)` contra `ceil(UMBRAL)`
 * directamente. Ése es el que sostiene al test de copy y el que hay que conservar.
 *
 * LO QUE EL FLOOR CUESTA, dicho SIN SUAVIZAR porque creció 23×: subestima 0,000041475 SOL, o sea el
 * 1,14 % (41.475 / 3.641.475). Hasta HU-077 eran 0,000002 SOL (0,05 %) sobre el valor de mainnet, y la
 * diferencia no es del formateador: es que 3.641.475 cae casi en el borde superior de su banda de
 * display mientras 4.002.000 caía cerca del inferior. Sigue siendo el error barato —quedarse corto en
 * lo que se promete devolver— pero ya no es despreciable, y quien lo lea tiene que verlo en su tamaño.
 *
 * El `floor` corre sobre ENTEROS (lamports por unidad de display), nunca sobre el flotante en SOL, por
 * la misma razón de representación binaria que su hermana.
 */
export function formatLamportsAsSolFloor(lamports: number): string {
  const units = Math.floor(lamports / LAMPORTS_PER_DISPLAY_UNIT);
  return (units / SOL_DISPLAY_FACTOR).toFixed(SOL_DISPLAY_DECIMALS).replace(".", ",");
}

// ── WKH-357 · el umbral del camino por ENLACE PROFUNDO (durable nonce) ──────────────────────────────
//
// Va TODO al FINAL del archivo, y eso es una decisión medida, no un descuido de orden: este archivo
// recibe citas ancladas por número, y HU-077 las re-derivó: hoy son a `:128` (×2), `:232`, `:273` y
// `:290` — las tres últimas eran a `:203`/`:223`/`:223`, o sea a las dos constantes que HU-077 partió
// en cuatro hojas y dos agregados, así que ni los números ni los nombres sobrevivieron. Insertando acá
// abajo no se mueve NINGUNA; insertando arriba de `:181` se mueven 3. Y además tiene que estar después de
// `:299`, porque referencia a `SOLANA_BASE_FEE_PER_SIGNATURE_LAMPORTS`: es la misma regla que este
// archivo ya escribió en `:138-141` — un `const` no puede referenciar a otro que se declara después.

/** La propina que la billetera inyecta en una tx que NO declara ComputeBudget: 375.000 µL/CU ×
 *  200.000 CU / 1e6 = 75.000 lamports. Fuente: la derivación de `:70-80` de este archivo.
 *
 *  ⚠️ SÍ, ES EL MISMO 75.000 QUE `REFUND_FEE_ALLOWANCE_LAMPORTS` (`:181`) LLEVA COMO LITERAL, y `:181`
 *  NO se reescribe para usar esta constante. El motivo es mecánico y no estético: `:181` se declara
 *  ANTES que `SOLANA_BASE_FEE_PER_SIGNATURE_LAMPORTS` (`:299`), así que no puede referenciarlo, y
 *  mover cualquiera de las dos cosas para "unificar" rompe la evaluación del módulo o corre 3 citas
 *  ancladas. El candado contra la deriva silenciosa de los dos 75.000 es T-22, que los ata al mismo
 *  valor: si alguien cambia uno, el test se pone rojo. */
const WALLET_TIP_ALLOWANCE_LAMPORTS = 75_000;

/** Alquiler exento de renta de la cuenta de nonce (80 bytes = `NONCE_ACCOUNT_LENGTH`).
 *
 *  RE-MEDIDO contra devnet el 2026-08-17: `getMinimumBalanceForRentExemption(80)` → 1447680.
 *  Coincide con la fórmula pública de rent: (128 + 80) × 3480 × 2 = 1.447.680. Dos fuentes
 *  independientes sobre el mismo número, que es lo que lo vuelve una derivación y no un literal.
 *
 *  🔴 HU-077 — ESE 1.447.680 ES EL VALOR DE MAINNET, y hoy hay que decirlo: devnet devuelve 1.317.264
 *  (medido el 2026-09-03, después de que su tarifa bajara de 6960 a 6333). Este número es el MÁXIMO de
 *  {devnet, mainnet} porque es lado PIDE (CD-44) — se muestra como "Cuesta X SOL" y además FONDEA la
 *  cuenta en cadena — y hoy ese máximo es mainnet. Fondear de más es recuperable; de menos, la tx
 *  revierte. ⛔ Es PIDE por lo que hace, no por su valor: si algún día devnet superara a mainnet, el
 *  máximo cambiaría de cadena y este número tendría que subir.
 *
 *  ⚠️ LA CADENA ENVEJECE SOLA: si volvés a medirlo y da otro número, el que tiene razón es el RPC y no
 *  este comentario. La medición se re-corre con:
 *    node -e 'const {Connection}=require("@solana/web3.js"); new Connection("https://api.devnet.solana.com","confirmed").getMinimumBalanceForRentExemption(80).then(console.log)'
 *
 *  ⛔ LO QUE NO VUELVE: este alquiler NO se recupera salvo que alguien emita un `nonceWithdraw`, y esta
 *  HU NO lo implementa. Son 0,00145 SOL por remitente, UNA sola vez, que quedan bloqueados en su propia
 *  cuenta de nonce. El remitente los puede recuperar cuando quiera; Chaski no le ofrece el botón. */
export const NONCE_ACCOUNT_RENT_LAMPORTS = 1_447_680;

/** El umbral de SOL del camino por ENLACE PROFUNDO.
 *
 *  ⛔ NO es el del camino de la billetera inyectada y NO lo reemplaza:
 *  `SENDER_MIN_LAMPORTS_FOR_DEPOSIT` (`:187`) NO cambió de valor. Subirlo cambiaría el veredicto del
 *  camino inyectado para una billetera con 9.000.000 lamports, y ése es el recorrido del video de M5
 *  que YA movió USDC real en cadena.
 *
 *  Los tres sumandos que se agregan son los de la tx de CREACIÓN de la cuenta de nonce, que el
 *  remitente firma y paga él (feePayer = sender, UNA sola firma):
 *    + NONCE_ACCOUNT_RENT_LAMPORTS ............ 1.447.680  el alquiler de la cuenta
 *    + SOLANA_BASE_FEE_PER_SIGNATURE_LAMPORTS .     5.000  su única firma (`:299`)
 *    + WALLET_TIP_ALLOWANCE_LAMPORTS ..........    75.000  la propina, el mismo sumando que el refund
 *
 *  ⚠️ SE PIDE SIEMPRE en el camino por enlace, tenga o no el remitente su cuenta de nonce ya creada, y
 *  por la MISMA razón que el punto 4 de `:120-125`: un umbral condicional obliga a que la lectura del
 *  guard y la de la construcción coincidan, y si divergen la tx REVIERTE EN CADENA. Pedir de más a
 *  quien ya tiene la cuenta cuesta que un caso borde vea un mensaje de saldo insuficiente; pedir de
 *  menos cuesta una transacción revertida con el escrow a medio crear. */
export const SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT =
  SENDER_MIN_LAMPORTS_FOR_DEPOSIT +
  NONCE_ACCOUNT_RENT_LAMPORTS +
  SOLANA_BASE_FEE_PER_SIGNATURE_LAMPORTS +
  WALLET_TIP_ALLOWANCE_LAMPORTS;

/** Sólo para T-22: ata los dos `75_000` del archivo (éste y el sumando de `REFUND_FEE_ALLOWANCE_LAMPORTS`)
 *  para que no deriven en silencio. No se usa en producción. */
export const WALLET_TIP_ALLOWANCE_LAMPORTS_FOR_TESTS = WALLET_TIP_ALLOWANCE_LAMPORTS;

