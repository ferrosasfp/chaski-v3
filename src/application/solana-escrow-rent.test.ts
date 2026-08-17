// EL UMBRAL DE SOL, CONTRA LA CADENA Y CONTRA EL IDL.
//
// El umbral de 9.000.000 lamports sumaba el rent de `EscrowIndex`, una cuenta que el depósito NO creaba.
// Pedía 2,25× lo que el primer depósito de una billetera nueva costó de verdad (4.002.000 lamports,
// medido en cadena) y podía voltear una demo en vivo con un "te falta SOL" falso. Y aun pidiendo de más,
// no cubría la comisión del refund, que el propio archivo declaraba como no cubierta: quien depositaba
// con lo justo se quedaba sin con qué firmar su propia recuperación. Por eso bajó a 4.100.000.
//
// 🔴 WKH-347 LO SUBIÓ A 8.874.560, Y NO ES UNA VUELTA ATRÁS. La transacción del depósito ahora emite
// `register_escrow` como segunda instrucción de negocio, así que CREA `EscrowIndex` de verdad y su
// alquiler sale de la billetera del remitente. El sumando volvió porque cambió el hecho que lo hacía
// falso, no porque el error viejo fuera correcto. El parecido con el 9.000.000 es real y está declarado
// sin suavizar en el docblock de la constante, junto con lo que cuesta: le pide 2,22× lo que el depósito
// cuesta (8.874.560 / 4.002.000, la medición en cadena) a la mayoría de los remitentes, que ya tienen
// índice y no van a pagar ese alquiler.
// 🔴 ACÁ DECÍA 2,16×, Y ESE NÚMERO ES OTRA COMPARACIÓN: 8.874.560 / 4.100.000, o sea contra el UMBRAL
// ANTERIOR y no contra el costo del depósito. Suavizaba el costo justo donde se declara que no se
// suaviza. Y el ratio ya no vive sólo en prosa: el `it` de más abajo lo asserta contra las constantes.
//
// Varios de los tests de abajo cambiaron de sentido por eso, y en cada uno está escrito por qué. Ninguno
// se borró: un test que se borra al cambiar un número deja de vigilar el número.
//
// Estos tests atan el número a sus DOS fuentes verificables: la medición en cadena y el IDL pinneado.
// Un test que sólo comparara la constante contra sí misma no probaría nada.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { escrowIdl } from "../infrastructure/solana/escrow-idl";
import {
  ESCROW_DEPOSIT_RENT_LAMPORTS,
  // WKH-347 (CD-22): se IMPORTA en vez de escribirse a mano. Acá vivía un
  // `const ESCROW_INDEX_RENT_LAMPORTS = 4_774_560;` local con el comentario "la cuenta que NO se crea
  // acá", y las dos mitades de esa línea envejecieron: el número es una DECISIÓN derivada que pertenece
  // al módulo, y la cuenta ahora sí se crea. Dos literales iguales en dos repositorios de decisión
  // distintos es el defecto que este repo ya documentó una vez.
  ESCROW_INDEX_RENT_LAMPORTS,
  ESCROW_STATE_RENT_LAMPORTS,
  ESCROW_VAULT_RENT_LAMPORTS,
  LAMPORTS_PER_SOL,
  NONCE_ACCOUNT_RENT_LAMPORTS,
  SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT,
  SENDER_MIN_LAMPORTS_FOR_DEPOSIT,
  SOLANA_BASE_FEE_PER_SIGNATURE_LAMPORTS,
  WALLET_TIP_ALLOWANCE_LAMPORTS_FOR_TESTS,
  formatLamportsAsSol,
  formatLamportsAsSolFloor,
} from "./solana-escrow-rent";

/** Lo que el remitente `8tJVcM2J` pagó de verdad en su PRIMER depósito, medido en devnet.
 *
 *  ⚠️ VA ESCRITO A MANO Y NO IMPORTADO, a propósito, y NO es el duplicado que CD-22 prohíbe: éste es
 *  una MEDICIÓN EN CADENA, o sea un oráculo independiente del código. Importarlo del módulo que se
 *  vigila convertiría las cotas de abajo en la constante comparándose consigo misma, que es justo lo
 *  que la cabecera de este archivo dice que no prueba nada. */
const MEASURED_FIRST_DEPOSIT_LAMPORTS = 4_002_000;

/** El umbral que este repo YA REVIRTIÓ una vez, y el que tenía antes de WKH-347. Los dos van a mano por
 *  la misma razón que el de arriba: son HISTORIA, no valores que el módulo exporte hoy, así que
 *  importarlos sería imposible y escribirlos es lo que permite comparar contra ellos. */
const UMBRAL_REVERTIDO_LAMPORTS = 9_000_000;
const UMBRAL_ANTERIOR_LAMPORTS = 4_100_000;

describe("el umbral de SOL sale del costo REAL del depósito", () => {
  // 🔴 WKH-347 — ESTA COTA SE RE-DERIVÓ, NO SE DEBILITÓ, y la diferencia importa. Hasta acá medía el
  // umbral contra el costo del DEPÓSITO SOLO (4.002.000 × 1,1), porque el depósito era todo lo que la
  // transacción pagaba. Desde WKH-347 la transacción también crea `EscrowIndex`, así que el costo
  // completo del peor caso es `depósito + índice` y la cota tiene que medirse contra ESO. Medir contra
  // el subtotal viejo sería exigirle al umbral que no cubra una cuenta que la tx crea de verdad.
  //
  // El ×1,1 NO se movió, y ése es el punto: lo que cambió es el costo real, no la tolerancia. Con
  // 8.776.560 × 1,1 = 9.654.216, el umbral de 8.874.560 entra con margen.
  it("no supera por mucho lo que el peor caso cuesta en cadena (depósito + índice)", () => {
    const peorCasoReal = MEASURED_FIRST_DEPOSIT_LAMPORTS + ESCROW_INDEX_RENT_LAMPORTS;
    expect(SENDER_MIN_LAMPORTS_FOR_DEPOSIT).toBeGreaterThanOrEqual(MEASURED_FIRST_DEPOSIT_LAMPORTS);
    // Cota dura: hasta un 10% por encima de lo medido. El de 9.000.000 pedía 2,25× el depósito solo
    // SIN que ninguna cuenta lo justificara; éste pide 2,22× con una cuenta que la tx crea. Los DOS
    // ratios están contra el MISMO denominador (`MEASURED_FIRST_DEPOSIT_LAMPORTS`), que es lo que los
    // hace comparables: 9.000.000 / 4.002.000 = 2,2489 y 8.874.560 / 4.002.000 = 2,2175.
    expect(SENDER_MIN_LAMPORTS_FOR_DEPOSIT).toBeLessThanOrEqual(Math.round(peorCasoReal * 1.1));
  });

  // 🔴 FIX-PACK CR/BLQ-3 — EL RATIO DECLARADO SE ASSERTA, PORQUE NO LO VERIFICABA NADA. En el docblock
  // de la constante (y en la cabecera de este archivo) decía 2,16×, y era falso: 2,16 es
  // 8.874.560 / 4.100.000, o sea el ratio contra el UMBRAL ANTERIOR, no contra "lo que el depósito
  // cuesta". La cifra correcta contra el costo del depósito es 2,22×, y estaba SUAVIZANDO justo en la
  // línea que existe para no suavizar. Mientras el número viva sólo en prosa vuelve a envejecer solo, así
  // que acá queda atado a las dos constantes.
  //
  // 🔴 LA PRIMERA VERSIÓN DE ESTE TEST PROMETÍA EL DOBLE DE LO QUE COMPRABA (fix-pack r2, re-AR/MNR-2).
  // Decía que lo ponía en rojo "escribir en la prosa cualquier otro ratio sin mover el umbral, o mover el
  // umbral sin re-escribir la prosa", y sólo la segunda mitad era cierta: el test assertaba `2.22` como
  // literal PROPIO y nunca leía el archivo de producción. MEDIDO: cambiando la prosa de `2,22×` a `1,05×`
  // sin tocar ninguna constante, la suite completa quedaba en 1963 verdes.
  //
  // ⇒ Se eligió la opción (b): el test LEE la prosa de producción y la compara contra los ratios
  // DERIVADOS de las constantes. Los dos números de esa lista salen del mismo denominador, así que se
  // verifican los dos juntos y ninguno se escribe a mano acá.
  //
  // ⚠️ QUÉ LO VUELVE FRÁGIL Y POR QUÉ SE ACEPTA: el test depende de una FRASE ("× lo que el depósito
  // cuesta"). Si alguien la reformula, esto se pone ROJO sin que el código esté mal. Es el lado barato
  // del error —falla ruidoso, no aplaude en silencio— y el rojo dice exactamente qué hacer: o se conserva
  // la frase, o se actualiza este test junto con la prosa. Lo que NO se puede es reescribir el ratio y que
  // nadie se entere, que es lo que pasaba.
  //
  // 🚫 LO QUE ESTE TEST SIGUE SIN CUBRIR, dicho para que nadie le crea de más: sólo mira las
  // apariciones con ESA frase. El "2,2× el costo real" del bloque histórico de arriba del archivo usa
  // otra redacción y queda afuera a propósito (es una cita de lo que se creía en su momento, no una
  // afirmación sobre el umbral de hoy). Y no mira la cabecera de ESTE archivo, que es prosa de test.
  it("CR/BLQ-3: los ratios que la prosa de producción declara son los que las constantes producen", () => {
    const fuente = readFileSync(join(__dirname, "solana-escrow-rent.ts"), "utf8");
    const declarados = [...fuente.matchAll(/(\d+),(\d+)× lo que el depósito cuesta/g)].map(
      (m) => Number(`${m[1]}.${m[2]}`),
    );
    // Control de que el barrido encontró algo: con la frase borrada, el `toEqual` de abajo pasaría con
    // dos listas vacías y este test se aplaudiría solo.
    expect(declarados).toHaveLength(2);
    // Los DOS esperados, derivados y no escritos: el umbral de hoy y el 9.000.000 que este repo revirtió,
    // los dos contra la MISMA medición en cadena. El orden es el de aparición en el archivo.
    const dosDecimales = (n: number): number => Number(n.toFixed(2));
    expect(declarados).toEqual([
      dosDecimales(SENDER_MIN_LAMPORTS_FOR_DEPOSIT / MEASURED_FIRST_DEPOSIT_LAMPORTS), // 2,22
      dosDecimales(UMBRAL_REVERTIDO_LAMPORTS / MEASURED_FIRST_DEPOSIT_LAMPORTS), // 2,25
    ]);
    // Y el control que separa las dos comparaciones que la prosa mezclaba: 2,16 es el ratio contra el
    // UMBRAL VIEJO, y no es el mismo número. Sin esto, "2,22" y "2,16" podrían volver a leerse como la
    // misma cosa, que es exactamente el error que este `it` vino a cerrar.
    expect(dosDecimales(SENDER_MIN_LAMPORTS_FOR_DEPOSIT / UMBRAL_ANTERIOR_LAMPORTS)).toBe(2.16);
    expect(declarados).not.toContain(2.16);
  });

  // 🔴 T-347-13 — ESTE TEST CAMBIÓ DE SENTIDO A PROPÓSITO. Antes exigía que el umbral NO llegara a
  // `depósito + índice`, porque ninguna transacción creaba el índice y sumarlo era el bug que este
  // archivo revirtió. Ahora la transacción SÍ lo crea, así que la exigencia se invierte: el umbral
  // TIENE que cubrir los dos. Dejarlo como estaba mandaría a alguien a depositar con un saldo que no
  // alcanza para la cuenta que su propia transacción va a crear, y el depósito REVERTIRÍA EN CADENA.
  //
  // 🔴 EL INPUT QUE LO PONE EN ROJO: volver el umbral a 4.100.000, o sacarle el sumando del índice.
  it("T-347-13 (AC-7): el umbral SÍ cubre el rent de EscrowIndex, que la tx ahora crea", () => {
    expect(SENDER_MIN_LAMPORTS_FOR_DEPOSIT).toBeGreaterThanOrEqual(
      MEASURED_FIRST_DEPOSIT_LAMPORTS + ESCROW_INDEX_RENT_LAMPORTS,
    );
    // Y la derivación del propio rent, contra la fórmula de rent-exempt de Solana y no contra sí mismo:
    // (128 bytes de overhead + 558 de la cuenta) × 6960 lamports por byte-año.
    expect(ESCROW_INDEX_RENT_LAMPORTS).toBe((128 + 558) * 6960);
    // La MISMA fórmula sobre `EscrowState` (154 bytes) reproduce un número que salió de una medición en
    // cadena, no de la fórmula. Es lo que vuelve a la de arriba una derivación y no una coincidencia.
    expect(ESCROW_STATE_RENT_LAMPORTS).toBe((128 + 154) * 6960);
  });

  // 🔴 EL CONTROL QUE VUELVE HONESTO AL `MEASURED_FIRST_DEPOSIT_LAMPORTS` escrito a mano: la medición en
  // cadena y la suma de las dos cuentas que el `deposit` crea tienen que dar el MISMO número. Si
  // divergen, una de las dos fuentes está mal y hay que ir a ver cuál, en vez de elegir la que conviene.
  it("la medición en cadena y la suma de las partes coinciden", () => {
    expect(MEASURED_FIRST_DEPOSIT_LAMPORTS).toBe(ESCROW_DEPOSIT_RENT_LAMPORTS);
  });

  // La fuente de por qué el índice no entra: el IDL. No es una opinión sobre el programa, es su
  // contrato. Si un día `deposit` empieza a tocar `escrow_index`, este test se pone rojo y el umbral
  // hay que re-derivarlo.
  it("la ix `deposit` no toca `escrow_index` (por eso su rent no es un sumando)", () => {
    const idl = escrowIdl as unknown as {
      instructions: Array<{ name: string; accounts: Array<{ name: string; writable?: boolean }> }>;
    };
    const deposit = idl.instructions.find((i) => i.name === "deposit");
    expect(deposit).toBeDefined();
    const names = deposit?.accounts.map((a) => a.name) ?? [];
    // 9 desde WKH-343. El número está acá a propósito, como alarma: si el set de cuentas de `deposit`
    // cambia, el umbral hay que RE-DERIVARLO en vez de asumir que sigue valiendo. Se re-derivó para
    // este cambio y NO se movió, y el motivo es verificable en la línea de abajo: `beneficiary_ata`
    // entra NO writable, así que `deposit` no puede crearla — sólo exige que ya exista. Una cuenta
    // que la ix no inicializa no le cobra rent a nadie, y menos al sender, que es de quien habla
    // este umbral. Lo que sí cambia es una PRECONDICIÓN operativa: si el beneficiario no tiene ATA
    // de ese mint, el depósito se rechaza. Eso no es plata del sender y por eso no entra acá.
    expect(names).toHaveLength(9);
    const beneficiaryAta = deposit?.accounts.find((a) => a.name === "beneficiary_ata");
    expect(beneficiaryAta).toBeDefined();
    expect(beneficiaryAta?.writable ?? false).toBe(false); // no writable ⇒ no la crea ⇒ no suma rent
    expect(names).not.toContain("escrow_index");
    // Y la que sí la crea existe, así que el `not.toContain` de arriba no pasa por un rename.
    const register = idl.instructions.find((i) => i.name === "register_escrow");
    expect(register?.accounts.map((a) => a.name)).toContain("escrow_index");
  });

  // Lo que el umbral viejo declaraba como NO cubierto y dejaba a la persona sin salida: si deposita
  // con lo justo, después no tiene con qué firmar su propia recuperación.
  it("cubre la comisión del refund, que la paga el sender", () => {
    const margenSobreElDeposito = SENDER_MIN_LAMPORTS_FOR_DEPOSIT - MEASURED_FIRST_DEPOSIT_LAMPORTS;
    // 5.000 de comisión base (1 firma) + 75.000 de propina inyectada por la billetera.
    expect(margenSobreElDeposito).toBeGreaterThanOrEqual(80_000);
  });
});

describe("el número que se le muestra a la persona nunca pide menos que el guard", () => {
  // Con `toFixed(3)` el umbral de 4.100.000 se mostraba como "0,004": la persona cargaba 0,004 SOL
  // (4.000.000 lamports), hacía exactamente lo que la pantalla le pidió, y volvía a chocar con el
  // mismo error.
  it("el texto del umbral, leído de vuelta a lamports, alcanza para pasar el guard", () => {
    const texto = formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT);
    const lamportsQueCargaria = Number(texto.replace(",", ".")) * LAMPORTS_PER_SOL;
    expect(lamportsQueCargaria).toBeGreaterThanOrEqual(SENDER_MIN_LAMPORTS_FOR_DEPOSIT);
  });

  it("redondea hacia arriba, nunca hacia abajo", () => {
    expect(formatLamportsAsSol(4_100_000)).toBe("0,0041"); // exacto, sin inflar
    expect(formatLamportsAsSol(4_100_001)).toBe("0,0042"); // un lamport de más ya sube el display
    expect(formatLamportsAsSol(1)).toBe("0,0001"); // nunca "0,0000"
    expect(formatLamportsAsSol(0)).toBe("0,0000");
  });

  it("usa coma decimal (es-PE), no punto", () => {
    expect(formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT)).toContain(",");
    expect(formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT)).not.toContain(".");
  });
});

// ── WKH-327 · el mismo alquiler, mirado desde el lado que lo DEVUELVE ───────────────────────────────
describe("el alquiler que `close` devuelve sale de la misma derivación que el umbral", () => {
  it("los dos sumandos están pinneados a los tamaños de cuenta del programa", () => {
    expect(ESCROW_STATE_RENT_LAMPORTS).toBe(1_962_720); // EscrowState, 154 bytes
    expect(ESCROW_VAULT_RENT_LAMPORTS).toBe(2_039_280); // ATA del vault, 165 bytes
  });

  it("el total es la suma de los dos, no un número escrito aparte", () => {
    expect(ESCROW_DEPOSIT_RENT_LAMPORTS).toBe(
      ESCROW_STATE_RENT_LAMPORTS + ESCROW_VAULT_RENT_LAMPORTS,
    );
    expect(ESCROW_DEPOSIT_RENT_LAMPORTS).toBe(4_002_000);
  });

  // 🔴 Ata la constante nueva a la MEDICIÓN EN CADENA, no a sí misma. Un test que sólo comparara
  // ESCROW_DEPOSIT_RENT_LAMPORTS contra la suma de sus propios sumandos aplaudiría cualquier par de
  // números que sumen bien.
  it("coincide EXACTO con lo que el primer depósito costó en cadena", () => {
    expect(ESCROW_DEPOSIT_RENT_LAMPORTS).toBe(MEASURED_FIRST_DEPOSIT_LAMPORTS);
  });

  // 🔴 ESTE TEST TENÍA UN NOMBRE QUE AFIRMABA MÁS QUE SU CUERPO Y UNA ASERCIÓN QUE NO PODÍA FALLAR
  // (fix-pack CR/MNR-4, CD-17). Decía "esa cuenta no la cierra ninguna instrucción" —una afirmación
  // sobre el programa— y asertaba `ESCROW_DEPOSIT_RENT_LAMPORTS < MEASURED_FIRST_DEPOSIT_LAMPORTS +
  // 4_774_560`. Como el `it` de arriba clava que los dos primeros son el MISMO número, eso es
  // `X < X + 4_774_560`: tautológicamente verdadero para cualquier X. Ningún valor de la constante lo
  // ponía rojo.
  //
  // Se eligió ACHICAR EL NOMBRE Y AGRANDAR EL CUERPO, en ese orden y por esta razón: "ninguna
  // instrucción cierra `escrow_index`" **no se puede verificar desde el IDL**, que no expresa las
  // constraints `close = ...` de Anchor. Probarlo pediría leer `solana-programs/`, que está fuera del
  // alcance de este repo. Un nombre que promete lo que ninguna aserción puede tocar es exactamente lo
  // que CD-17 prohíbe, así que el nombre ahora dice lo que las aserciones de abajo sí prueban.
  //
  // Lo que SÍ prueba, y puede ponerse rojo: la ix `close` declara `escrow_index` como cuenta
  // OPCIONAL, o sea que existe un `close` válido que ni siquiera la recibe. Una cuenta que la
  // instrucción puede no recibir no puede ser la fuente de un alquiler que esa instrucción devuelve
  // SIEMPRE, que es lo que esta constante afirma. Si algún día `close` la vuelve obligatoria, esto se
  // pone rojo y el número hay que re-derivarlo.
  //
  // ⚠️ Y NO SE LE AGREGÓ UNA ASERCIÓN ARITMÉTICA, a propósito. Cualquier `expect` sobre el VALOR de
  // `ESCROW_DEPOSIT_RENT_LAMPORTS` acá sería una tercera copia del pin que ya hacen los dos `it` de
  // arriba ((`ESCROW_DEPOSIT_RENT_LAMPORTS`, `:224`) y (`MEASURED_FIRST_DEPOSIT_LAMPORTS`, `:234`)).
  // Repetir un pin con otra redacción no agrega cobertura, agrega la ilusión de tenerla.
  it("la ix `close` declara `escrow_index` OPCIONAL: se puede cerrar sin esa cuenta", () => {
    const idl = escrowIdl as unknown as {
      instructions: Array<{
        name: string;
        accounts: Array<{ name: string; optional?: boolean }>;
      }>;
    };
    const close = idl.instructions.find((i) => i.name === "close");
    expect(close).toBeDefined();
    const escrowIndex = close?.accounts.find((a) => a.name === "escrow_index");
    // Control positivo: la cuenta EXISTE en la ix, así que el `optional` de abajo no da verde por un
    // `undefined` de un rename silencioso.
    expect(escrowIndex).toBeDefined();
    expect(escrowIndex?.optional).toBe(true);
  });

  // 🔴 EL PIN DEL VALOR, RE-DERIVADO PARA WKH-347. Decía `toBe(4_100_000)` y era el pin del umbral que
  // NO sumaba el índice. Ahora se pinnea contra la SUMA de sus sumandos nombrados y no contra un literal
  // suelto: un literal sólo dice "alguien escribió este número", mientras que la suma se rompe si
  // cualquiera de los cuatro términos cambia sin que la derivación del docblock lo acompañe.
  //
  // Los dos primeros salen de este archivo como oráculos independientes (la medición en cadena y el
  // rent-exempt derivado); los dos últimos son la comisión del refund que el umbral le reserva al
  // sender (5.000 de su única firma + 75.000 de propina de billetera) y el redondeo hacia arriba.
  it("el umbral del depósito es la SUMA de sus cuatro sumandos, no un literal", () => {
    expect(SENDER_MIN_LAMPORTS_FOR_DEPOSIT).toBe(
      MEASURED_FIRST_DEPOSIT_LAMPORTS + 5_000 + 75_000 + 18_000 + ESCROW_INDEX_RENT_LAMPORTS,
    );
    // Y el valor concreto, para que el diff de esta HU muestre el número que se movió.
    expect(SENDER_MIN_LAMPORTS_FOR_DEPOSIT).toBe(8_874_560);
  });
});

describe("lo que se COBRA se redondea hacia abajo, y por eso deja de colisionar con el umbral", () => {
  it("el alquiler de las dos cuentas se muestra como 0,0040", () => {
    expect(formatLamportsAsSolFloor(ESCROW_DEPOSIT_RENT_LAMPORTS)).toBe("0,0040");
  });

  // 🔴 ESTE es el test que hace que el de copy discrimine. Con el umbral en 4.100.000,
  // `formatLamportsAsSol(4_002_000)` y `formatLamportsAsSol(4_100_000)` devolvían LA MISMA CADENA
  // "0,0041": un mutante que formateara la constante equivocada (el umbral en vez del alquiler) era
  // INDISTINGUIBLE del código correcto en pantalla. El floor separa las dos cadenas, y la primera
  // aserción de abajo es esa separación puesta en rojo. 🚫 NO simplificar a una aserción de presencia:
  // es el patrón que vuelve a dejar pasar ese mutante.
  //
  // 🔴 WKH-347 — LA COLISIÓN DEL `ceil` DEJÓ DE EXISTIR, Y ES UNA BUENA NOTICIA MAL APROVECHABLE. Con el
  // umbral en 8.874.560 el ceil da "0,0089" y el alquiler "0,0041": ya no coinciden ni con ceil. La
  // aserción que EXIGÍA esa coincidencia se saca, porque exigir una colisión que el código ya no produce
  // sería un test rojo por la herramienta y no por el código.
  //
  // ⛔ PERO EL FLOOR NO SE SACA, NI ESTE TEST TAMPOCO, y la razón es la que importa: la colisión
  // desapareció por el VALOR de una constante que puede volver a moverse (ya se movió dos veces:
  // 9.000.000 → 4.100.000 → 8.874.560), no por ninguna propiedad de estas dos funciones. El día que el
  // umbral vuelva a caer cerca del alquiler, la colisión vuelve sola. La primera aserción de abajo es la
  // única que no depende de ese valor, y es la que sostiene al test de copy.
  it("la cifra del cierre NO puede colisionar con la del umbral de depósito", () => {
    expect(formatLamportsAsSolFloor(ESCROW_DEPOSIT_RENT_LAMPORTS)).not.toBe(
      formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT),
    );
    // Y el estado ACTUAL de la colisión del ceil, fijado para que su desaparición no pase inadvertida:
    // hoy NO colisionan. Si este assert se pone rojo, el umbral volvió a acercarse al alquiler y el
    // floor pasó de ser una precaución a ser lo único que separa las dos cifras en pantalla.
    expect(formatLamportsAsSol(ESCROW_DEPOSIT_RENT_LAMPORTS)).not.toBe(
      formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT),
    );
  });

  it("redondea hacia abajo, nunca hacia arriba (el error barato es prometer de menos)", () => {
    expect(formatLamportsAsSolFloor(4_002_000)).toBe("0,0040"); // 0,004002 real
    expect(formatLamportsAsSolFloor(4_099_999)).toBe("0,0040"); // un lamport de menos NO infla
    expect(formatLamportsAsSolFloor(99_999)).toBe("0,0000"); // menos de un dígito de display ⇒ 0
    expect(formatLamportsAsSolFloor(0)).toBe("0,0000");
  });

  it("usa coma decimal (es-PE), no punto, igual que su hermana", () => {
    expect(formatLamportsAsSolFloor(ESCROW_DEPOSIT_RENT_LAMPORTS)).toContain(",");
    expect(formatLamportsAsSolFloor(ESCROW_DEPOSIT_RENT_LAMPORTS)).not.toContain(".");
  });
});

// ── ★ T-22 (WKH-357 / CD-12) — el umbral del camino por ENLACE, y el que NO se movió ────────────────
describe("el umbral del camino por enlace profundo (durable nonce)", () => {
  it("🔴 el umbral del camino INYECTADO no se movió: sigue valiendo 8.874.560", () => {
    // El candado de CD-1/CD-12. Subir este número cambiaría el veredicto del recorrido del video de
    // M5 para una billetera con 9.000.000 lamports, y ese recorrido YA movió USDC real en cadena.
    // El `it` de más arriba ya lo ata a sus cuatro sumandos; acá se vuelve a clavar el valor desde la
    // HU que agregó un umbral NUEVO, que es cuando el riesgo de "aprovecho y le sumo la renta" existe.
    expect(SENDER_MIN_LAMPORTS_FOR_DEPOSIT).toBe(8_874_560);
  });

  it("el umbral por enlace es el inyectado MÁS los tres sumandos de crear la cuenta de nonce", () => {
    // ⛔ Sin literal del total (CD-12): se afirma la DIFERENCIA contra sus sumandos nombrados. Escribir
    // `10_402_240` acá sería un segundo repositorio del mismo número, que es lo que el archivo ya
    // prohíbe en su cabecera para `ESCROW_INDEX_RENT_LAMPORTS`.
    expect(SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT - SENDER_MIN_LAMPORTS_FOR_DEPOSIT).toBe(
      NONCE_ACCOUNT_RENT_LAMPORTS +
        SOLANA_BASE_FEE_PER_SIGNATURE_LAMPORTS +
        WALLET_TIP_ALLOWANCE_LAMPORTS_FOR_TESTS,
    );
    // Y es estrictamente MAYOR: un signo invertido en la suma daría un umbral más bajo que el de hoy
    // y la diferencia de arriba seguiría cuadrando en valor absoluto si alguien la escribiera con
    // `Math.abs`.
    expect(SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT).toBeGreaterThan(SENDER_MIN_LAMPORTS_FOR_DEPOSIT);
  });

  it("la renta de la cuenta de nonce coincide con la fórmula pública de rent (dos fuentes, no un literal)", () => {
    // (128 bytes de overhead + 80 de la cuenta) × 3480 lamports/byte-año × 2 años.
    // La otra fuente es el RPC: `getMinimumBalanceForRentExemption(80)` devolvió 1447680 contra devnet
    // el 2026-08-17. Las dos coinciden, y por eso el número es una derivación y no un literal.
    expect(NONCE_ACCOUNT_RENT_LAMPORTS).toBe((128 + 80) * 3480 * 2);
  });

  it("los DOS `75_000` del archivo son el mismo valor (candado contra la deriva silenciosa)", () => {
    // (`REFUND_FEE_ALLOWANCE_LAMPORTS`, `solana-escrow-rent.ts:181`) lleva `5_000 + 75_000` literales y NO se puede
    // reescribir para usar las constantes (se declara antes que ellas). Este assert es lo único que
    // impide que los dos 75.000 se separen sin que nada se ponga rojo.
    expect(WALLET_TIP_ALLOWANCE_LAMPORTS_FOR_TESTS).toBe(75_000);
    // Y el sumando gemelo, leído del propio archivo fuente para que no sea la constante mirándose al
    // espejo: la línea que declara el allowance del refund tiene que seguir diciendo `5_000 + 75_000`.
    const fuente = readFileSync(
      join(process.cwd(), "src/application/solana-escrow-rent.ts"),
      "utf8",
    );
    expect(fuente).toContain("const REFUND_FEE_ALLOWANCE_LAMPORTS = 5_000 + 75_000;");
  });
});
