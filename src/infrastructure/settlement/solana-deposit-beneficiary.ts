// Infrastructure SERVER-ONLY: lee el `beneficiary` que viaja DENTRO de los bytes de la tx `deposit`
// que la wallet firmó. No recibe ningún campo suelto del request: el único input es la tx serializada,
// que es exactamente lo que se va a broadcastear.
//
// POR QUÉ SE LEE DE LOS BYTES Y NO DE UN CAMPO DEL BODY. El settle es el último punto donde se puede
// cortar un depósito hacia una dirección que nuestro servidor no emitió. Si el destino se leyera de
// una clave del body, quien controla el body (el navegador comprometido, o el intermediario que ya
// reescribió las respuestas de prepare y de la atestación) pondría ahí la dirección buena y dejaría
// la suya adentro de la tx: el guard compararía dos valores del atacante y aplaudiría. Los bytes de
// acá, en cambio, son los que la wallet firmó y los que la cadena va a ejecutar; nadie puede cambiar
// el destino sin invalidar la firma del sender.
//
// El layout NO se hardcodea: se decodifica con el BorshInstructionCoder de anchor sobre la MISMA
// copia pinneada del IDL que usa el escritor (solana/escrow-idl.ts, la que arma la ix en
// `authorizePrincipal`, `solana-wallet.ts:340`). Si el IDL cambia de forma, el lector cambia con él, y el test que decodifica
// la salida REAL de authorizePrincipal se pone rojo si dejan de coincidir.
import type { Idl } from "@coral-xyz/anchor";

/** DOS desenlaces, y ninguno de los dos es "está bien": `unreadable` significa que de esta tx no se
 *  puede afirmar ningún destino, que NO es lo mismo que un destino que no coincide. El caller los
 *  reporta con enums distintos. */
export type DepositBeneficiaryRead =
  | { state: "read"; beneficiary: string } // base58 canónico, tal como está en la ix firmada
  | { state: "unreadable" }; // base64 roto, tx versionada, sin ix del escrow, o data que no decodifica

/**
 * Extrae el beneficiary de la ix `deposit` del programa de escrow dentro de `partialSignedTxB64`.
 * NUNCA tira: cualquier problema es `unreadable` (fail-closed en el caller, que corta el forward).
 * NUNCA loguea la tx ni la dirección.
 */
export async function readDepositBeneficiary(
  partialSignedTxB64: string,
): Promise<DepositBeneficiaryRead> {
  try {
    // lazy-import (mismo patrón que solana-wallet.ts): estas libs no se cargan en el camino del flag
    // apagado ni en el de un body inválido, que cortan antes.
    const { PublicKey, Transaction } = await import("@solana/web3.js");
    const anchor = await import("@coral-xyz/anchor");
    const { escrowIdl } = await import("../solana/escrow-idl");

    const raw = Buffer.from(partialSignedTxB64, "base64");
    // `Transaction.from` valida el wire-format legacy y tira ante basura. Una tx VERSIONADA (v0) no
    // deserializa acá y cae a `unreadable`: hoy el escritor arma una legacy (`authorizePrincipal`, `solana-wallet.ts:340`) y
    // el día que eso cambie tiene que fallar ruidoso, no pasar de largo sin comparar nada.
    const tx = Transaction.from(raw);
    const programId = new PublicKey((escrowIdl as { address: string }).address);
    const ix = tx.instructions.find((i) => i.programId.equals(programId));
    if (!ix) return { state: "unreadable" }; // ninguna ix del escrow: no hay depósito que juzgar

    const coder = new anchor.BorshInstructionCoder(escrowIdl as unknown as Idl);
    const decoded = coder.decode(ix.data); // null si el discriminator no es de ninguna ix del IDL
    if (!decoded || decoded.name !== "deposit") return { state: "unreadable" };

    const beneficiary = (decoded.data as { beneficiary?: unknown }).beneficiary;
    // El coder devuelve un PublicKey; se pide el base58 por el mismo camino que lo escribió el
    // ledger (canonicalizeAddress ⇒ new PublicKey(x).toBase58()), así que la comparación de arriba
    // es entre dos codificaciones canónicas y no entre dos formas distintas del mismo valor.
    if (!(beneficiary instanceof PublicKey)) return { state: "unreadable" };
    return { state: "read", beneficiary: beneficiary.toBase58() };
  } catch {
    return { state: "unreadable" };
  }
}
