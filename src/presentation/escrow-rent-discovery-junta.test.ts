// LA JUNTA entre el adapter que propaga y el copy que traduce (WKH-327 / AC-8, fix-pack AR/BLQ-MED-1).
//
// 🔴 POR QUÉ ESTE ARCHIVO EXISTE. Había dos mitades probadas y ningún test en el medio:
//   · `solana-wallet.closeable.test.ts` probaba que `listCloseable` PROPAGA cuando el RPC lanza
//     (el test que mató al mutante M12), con un `Error("rpc_down")` inventado por el test;
//   · `escrow-rent-recovery.test.tsx` probaba que la UI TRADUCE un error a "no llegamos a preguntar",
//     con un fixture que eligió `escrow_recovery_unavailable` — uno de los dos únicos códigos que el
//     guard del copy reconocía.
// Las dos en verde, y el camino real roto: el mensaje que el adapter propaga de verdad no contiene
// ninguno de esos dos códigos, así que caía en el `return` final, que decía "No encontramos envíos
// terminados con cuentas abiertas para esta billetera. Miramos los últimos 20 envíos". Una afirmación
// sobre las cuentas de la persona construida a partir de nuestra propia falla.
//
// Este archivo no elige el mensaje: lo PRODUCE. Corre el `SolanaWalletAdapter` REAL contra un RPC que
// no contesta y le pasa al copy REAL lo que salga de ahí.
//
// ⚠️ NO renderiza React a propósito, y no es una omisión: en jsdom el adapter no llega a la red porque
// `PublicKey.findProgramAddressSync` falla con "Uint8Array expected" (el `Buffer` de Node no es
// `instanceof Uint8Array` en ese realm, y @noble/hashes lo rechaza). Medido. La mitad de UI la cubre
// `escrow-rent-recovery.test.tsx`, que parte del MISMO string a través de `MENSAJE_RPC_CAIDO_MEDIDO`,
// y la aserción de acá abajo es lo que impide que esa constante se desactualice en silencio.
import { afterEach, describe, expect, it } from "vitest";
import { SolanaWalletAdapter } from "../infrastructure/solana-wallet";
import { escrowRentDiscoveryEmpty, escrowRentDiscoveryError } from "./flow-vm";
import { MENSAJE_RPC_CAIDO_MEDIDO } from "../test-support/rpc-caido";
import { FAKE_SOLANA_BENEFICIARY } from "../test-support/fakes";

// Un puerto cerrado en loopback: la conexión se rechaza al instante y NO sale ningún paquete a
// internet. El RPC público de devnet nunca se toca (CD-11: cero I/O real fuera de la máquina).
const RPC_MUERTO = "http://127.0.0.1:1/";
const RPC_ANTES = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;

afterEach(() => {
  if (RPC_ANTES === undefined) delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  else process.env.NEXT_PUBLIC_SOLANA_RPC_URL = RPC_ANTES;
});

/** Corre el adapter REAL con el RPC caído y devuelve el mensaje que propagó. */
async function mensajeRealDelRpcCaido(): Promise<string> {
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL = RPC_MUERTO;
  const adapter = new SolanaWalletAdapter({ listBySender: async () => ["rem-a", "rem-b"] });
  try {
    await adapter.listCloseable({ sender: FAKE_SOLANA_BENEFICIARY });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("el adapter NO propagó: la razón 3 de su docblock dejó de cumplirse");
}

describe("la junta: lo que el adapter propaga de verdad, dicho por el copy de verdad", () => {
  it("el mensaje real de un RPC que no contesta NO se traduce a 'No encontramos envíos'", async () => {
    const real = await mensajeRealDelRpcCaido();

    const copy = escrowRentDiscoveryError(real);
    // La aserción que el bloqueante necesitaba y no existía.
    expect(copy).not.toContain("No encontramos");
    expect(copy).not.toContain("Miramos los últimos");
    expect(copy).toContain("no llegamos a preguntar");
    expect(copy).toContain("no es una respuesta sobre tus cuentas");
  });

  it("y ese mensaje real NO contiene ninguno de los dos códigos que el guard viejo reconocía", async () => {
    const real = await mensajeRealDelRpcCaido();

    // Esto es EL bug, escrito como aserción: el guard viejo (`code.includes(...)` de estos dos) daba
    // falso para el input real, y el default afirmaba haber mirado 20 envíos.
    expect(real).not.toContain("escrow_id_unavailable");
    expect(real).not.toContain("escrow_recovery_unavailable");
  });

  it("el string del que parten los tests de UI es el que el adapter produce HOY (candado)", async () => {
    // Si @solana/web3.js o Node cambian lo que dice un fetch fallido, este test se pone rojo y hay que
    // actualizar la constante — en vez de que los tests de UI sigan verdes sobre un string muerto.
    expect(await mensajeRealDelRpcCaido()).toBe(MENSAJE_RPC_CAIDO_MEDIDO);
  });

  // El control sin el cual los tres de arriba no prueban nada: la frase "No encontramos" SIGUE
  // existiendo y sigue siendo la correcta para el otro desenlace. Si alguien la borrara, arriba todo
  // quedaría verde.
  it("control: la lista vacía SÍ dice 'No encontramos', y las dos frases son distintas", () => {
    const vacio = escrowRentDiscoveryEmpty(20);
    expect(vacio).toContain("No encontramos envíos terminados");
    expect(vacio).toContain("Miramos los últimos 20 envíos");
    expect(vacio).not.toContain("no llegamos a preguntar");
    expect(vacio).not.toBe(escrowRentDiscoveryError(MENSAJE_RPC_CAIDO_MEDIDO));
  });

  // 🔴 El barrido que reemplaza a la lista de códigos reconocidos. El bug era una allowlist: sólo dos
  // mensajes se decían bien y TODO lo demás se decía mal. Con el default invertido, la propiedad que
  // vale es "ningún mensaje del catch puede afirmar sobre las cuentas", y se asserta como propiedad.
  it("NINGÚN mensaje que llegue al catch dice 'No encontramos', ni el vacío ni uno desconocido", () => {
    const entradas = [
      MENSAJE_RPC_CAIDO_MEDIDO,
      "failed to get info about accounts 8tJV…: TypeError: fetch failed",
      "escrow_id_unavailable",
      "escrow_recovery_unavailable",
      "User rejected the request.",
      "429 Too Many Requests",
      "",
      "algo que nadie previó",
    ];
    for (const entrada of entradas) {
      const copy = escrowRentDiscoveryError(entrada);
      expect(copy, `input: ${JSON.stringify(entrada)}`).not.toContain("No encontramos");
      expect(copy, `input: ${JSON.stringify(entrada)}`).not.toContain("Miramos los últimos");
      expect(copy, `input: ${JSON.stringify(entrada)}`).toContain("no llegamos a preguntar");
    }
  });

  // La firma rechazada es un TERCER desenlace y no un sinónimo: la persona cerró el popup, no falló la
  // red. Decirle "no pudimos consultar la red" la manda a esperar a que algo se arregle solo.
  it("el rechazo de la firma de posesión se dice distinto de una falla de red", () => {
    const rechazo = escrowRentDiscoveryError("User rejected the request.");
    expect(rechazo).toContain("aceptá la firma");
    expect(rechazo).not.toBe(escrowRentDiscoveryError(MENSAJE_RPC_CAIDO_MEDIDO));
  });
});
