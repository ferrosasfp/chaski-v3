// EL UMBRAL DE SOL, CONTRA LA CADENA Y CONTRA EL IDL.
//
// El umbral viejo (9.000.000 lamports) sumaba el rent de `EscrowIndex`, una cuenta que el depósito NO
// crea. Pedía 2,25× lo que el primer depósito de una billetera nueva costó de verdad (4.002.000
// lamports, medido en cadena) y podía voltear una demo en vivo con un "te falta SOL" falso. Y aun
// pidiendo de más, no cubría la comisión del refund, que el propio archivo declaraba como no cubierta:
// quien depositaba con lo justo se quedaba sin con qué firmar su propia recuperación.
//
// Estos tests atan el número a sus DOS fuentes verificables: la medición en cadena y el IDL pinneado.
// Un test que sólo comparara la constante contra sí misma no probaría nada.
import { describe, expect, it } from "vitest";
import { escrowIdl } from "../infrastructure/solana/escrow-idl";
import {
  ESCROW_DEPOSIT_RENT_LAMPORTS,
  ESCROW_STATE_RENT_LAMPORTS,
  ESCROW_VAULT_RENT_LAMPORTS,
  LAMPORTS_PER_SOL,
  SENDER_MIN_LAMPORTS_FOR_DEPOSIT,
  formatLamportsAsSol,
  formatLamportsAsSolFloor,
} from "./solana-escrow-rent";

/** Lo que el remitente `8tJVcM2J` pagó de verdad en su PRIMER depósito, medido en devnet. */
const MEASURED_FIRST_DEPOSIT_LAMPORTS = 4_002_000;
/** Rent de `EscrowIndex` (558 bytes), medido por la suite del programa. La cuenta que NO se crea acá. */
const ESCROW_INDEX_RENT_LAMPORTS = 4_774_560;

describe("el umbral de SOL sale del costo REAL del depósito", () => {
  // 🔴 EL test. Si alguien vuelve a sumar el rent del índice, el umbral pasa de 4.100.000 a más de
  // 8.700.000 y este límite se rompe.
  it("no supera por mucho lo que el primer depósito costó en cadena", () => {
    expect(SENDER_MIN_LAMPORTS_FOR_DEPOSIT).toBeGreaterThanOrEqual(MEASURED_FIRST_DEPOSIT_LAMPORTS);
    // Cota dura: hasta un 10% por encima de lo medido. El viejo pedía 2,25×.
    expect(SENDER_MIN_LAMPORTS_FOR_DEPOSIT).toBeLessThanOrEqual(
      Math.round(MEASURED_FIRST_DEPOSIT_LAMPORTS * 1.1),
    );
  });

  it("NO incluye el rent de EscrowIndex, que ninguna transacción de Chaski paga", () => {
    // Si estuviera adentro, el umbral tendría que cubrir la suma de los dos.
    expect(SENDER_MIN_LAMPORTS_FOR_DEPOSIT).toBeLessThan(
      MEASURED_FIRST_DEPOSIT_LAMPORTS + ESCROW_INDEX_RENT_LAMPORTS,
    );
  });

  // La fuente de por qué el índice no entra: el IDL. No es una opinión sobre el programa, es su
  // contrato. Si un día `deposit` empieza a tocar `escrow_index`, este test se pone rojo y el umbral
  // hay que re-derivarlo.
  it("la ix `deposit` no toca `escrow_index` (por eso su rent no es un sumando)", () => {
    const idl = escrowIdl as unknown as {
      instructions: Array<{ name: string; accounts: Array<{ name: string }> }>;
    };
    const deposit = idl.instructions.find((i) => i.name === "deposit");
    expect(deposit).toBeDefined();
    const names = deposit?.accounts.map((a) => a.name) ?? [];
    expect(names).toHaveLength(8);
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

  it("NO incluye el alquiler de EscrowIndex: esa cuenta no la cierra ninguna instrucción", () => {
    expect(ESCROW_DEPOSIT_RENT_LAMPORTS).toBeLessThan(
      MEASURED_FIRST_DEPOSIT_LAMPORTS + ESCROW_INDEX_RENT_LAMPORTS,
    );
    expect(ESCROW_DEPOSIT_RENT_LAMPORTS).not.toBe(ESCROW_INDEX_RENT_LAMPORTS);
  });

  it("el umbral del depósito NO se movió (sigue sin sumarle nada de esto)", () => {
    expect(SENDER_MIN_LAMPORTS_FOR_DEPOSIT).toBe(4_100_000);
  });
});

describe("lo que se COBRA se redondea hacia abajo, y por eso deja de colisionar con el umbral", () => {
  it("el alquiler de las dos cuentas se muestra como 0,0040", () => {
    expect(formatLamportsAsSolFloor(ESCROW_DEPOSIT_RENT_LAMPORTS)).toBe("0,0040");
  });

  // 🔴 ESTE es el test que hace que el de copy discrimine. `formatLamportsAsSol(4_002_000)` y
  // `formatLamportsAsSol(4_100_000)` devuelven LA MISMA CADENA "0,0041": con el ceil, un mutante que
  // formatee la constante equivocada (el umbral en vez del alquiler) es INDISTINGUIBLE del código
  // correcto en pantalla. El floor separa las dos cadenas, y esta aserción es la colisión puesta en
  // rojo. 🚫 NO simplificar a una aserción de presencia: es el patrón que vuelve a dejar pasar ese
  // mutante.
  it("la cifra del cierre NO puede colisionar con la del umbral de depósito", () => {
    expect(formatLamportsAsSolFloor(ESCROW_DEPOSIT_RENT_LAMPORTS)).not.toBe(
      formatLamportsAsSol(SENDER_MIN_LAMPORTS_FOR_DEPOSIT),
    );
    // Y la colisión que el ceil SÍ produce, documentada acá para que nadie la redescubra:
    expect(formatLamportsAsSol(ESCROW_DEPOSIT_RENT_LAMPORTS)).toBe(
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
