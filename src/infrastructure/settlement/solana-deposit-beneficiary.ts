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
// `authorizePrincipal`, `solana-wallet.ts:554`). Si el IDL cambia de forma, el lector cambia con él, y el test que decodifica
// la salida REAL de authorizePrincipal se pone rojo si dejan de coincidir.
import type { Idl } from "@coral-xyz/anchor";

/**
 * WKH-347 — ¿esta transacción registró el escrow en el índice del remitente?
 *
 * TRES valores y no un booleano, y la razón es la misma que gobierna al tipo de abajo: *no pude
 * preguntar* no es *no*. Un `boolean` colapsaría "la tx salió SIN registrar" (un hecho, y el que la
 * constancia de AC-10 quiere contar) con "hay una segunda instrucción del escrow que no pude nombrar"
 * (una ignorancia). Son cosas distintas y un operador tiene que poder separarlas.
 *
 *   · `registered`     — hay una 2ª ix de negocio del escrow y su discriminador es `register_escrow`.
 *   · `not_registered` — hay EXACTAMENTE una ix de negocio del escrow. El escrow quedó fuera del índice,
 *                        y eso es un hecho medido sobre los bytes firmados, no una sospecha.
 *   · `unreadable`     — hay una 2ª ix del escrow y no se pudo decodificar, o decodifica limpio y NO es
 *                        `register_escrow`. ⛔ NO se puede reportar como `not_registered`. ⚠️ Y el segundo
 *                        caso NO es una ignorancia pura: ahí quedó determinado que la tx no registró, y se
 *                        reporta conservador igual. El motivo, con su input y con qué lo volvería un
 *                        problema, está escrito en la route que consume este campo.
 */
export type DepositIndexRegistrationRead = "registered" | "not_registered" | "unreadable";

/** DOS desenlaces, y ninguno de los dos es "está bien": `unreadable` significa que de esta tx no se
 *  puede afirmar ningún destino, que NO es lo mismo que un destino que no coincide. El caller los
 *  reporta con enums distintos.
 *
 *  ⚠️ WKH-347 agregó `escrowIndexRegistration` a la rama `read`, y es ADITIVO: el desenlace
 *  `unreadable` no cambió de significado ni ganó casos. Una tx cuya 2ª ix no se entiende sigue teniendo
 *  un beneficiary perfectamente legible, así que degradar TODA la lectura a `unreadable` por eso
 *  convertiría una ignorancia sobre el índice en un 400 sobre el depósito. La ignorancia se reporta
 *  adentro, en su propio campo de tres valores. */
export type DepositBeneficiaryRead =
  | {
      state: "read";
      beneficiary: string; // base58 canónico, tal como está en la ix firmada
      escrowIndexRegistration: DepositIndexRegistrationRead;
    }
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
    // lazy-import (mismo patrón que solana-wallet.ts).
    //
    // 🔴 CUÁL FLAG, PORQUE HAY DOS Y LA FRASE DE ANTES NO LO DECÍA (fix-pack WKH-347, AR/MNR-3). Decía
    // "estas libs no se cargan en el camino del flag apagado", sin nombrarlo, y bajo la lectura del flag
    // del LEDGER eso es FALSO desde W4.2 de esta HU:
    //   · `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED != "true"` ⇒ la route contesta 501 en su PRIMER guard, antes
    //     de leer el body y antes de llamar acá. Ahí sí: estas libs no se cargan. Es el flag al que la
    //     frase se refería.
    //   · `getSettlementLedger() === null` (el ledger apagado, o sin envs de Supabase) ⇒ esta función SE
    //     LLAMA IGUAL, porque la constancia de AC-10 tiene que existir también en ese camino y por eso el
    //     decode se izó fuera del `if (ledger)`. O sea que con el ledger apagado los cuatro
    //     `await import()` de acá abajo se ejecutan en cada POST válido. El costo está declarado en la
    //     route, en el comentario del punto donde se la llama.
    // Y el body inválido sí corta antes, en los dos casos.
    const { PublicKey, Transaction } = await import("@solana/web3.js");
    const anchor = await import("@coral-xyz/anchor");
    const { escrowIdl } = await import("../solana/escrow-idl");

    const raw = Buffer.from(partialSignedTxB64, "base64");
    // `Transaction.from` valida el wire-format legacy y tira ante basura. Una tx VERSIONADA (v0) no
    // deserializa acá y cae a `unreadable`: hoy el escritor arma una legacy (`authorizePrincipal`, `solana-wallet.ts:554`) y
    // el día que eso cambie tiene que fallar ruidoso, no pasar de largo sin comparar nada.
    const tx = Transaction.from(raw);
    const programId = new PublicKey((escrowIdl as { address: string }).address);
    // 🔴 CD-13 — EL `deposit` ES SIEMPRE LA IX DE NEGOCIO DE POSICIÓN 0, Y ESTE ARCHIVO ES UNO DE LOS
    // TRES ACTORES QUE DEPENDEN DE ESA POSICIÓN. Los otros dos viven en el facilitator (el Check 2 de
    // CR-1, que hace `businessIx[0]` sin buscar por discriminador, y el Guard A de SDD 037).
    //
    // ⛔ CON EL ORDEN INVERTIDO ESTE ARCHIVO DEVUELVE `unreadable` Y LA ROUTE RESPONDE 400
    // `solana_settle_deposit_unreadable` PARA TODO DEPÓSITO PATROCINADO, antes de que el facilitator
    // llegue a ver nada. No es una degradación parcial: es el money-path entero caído, y por una causa
    // que se ve en la posición de un elemento de array. Es la forma exacta del incidente del 10-ago, con
    // un tercer actor. Cubierto por T-347-20.
    //
    // Se toma el ARRAY porque desde WKH-347 la transacción puede llevar DOS ix del mismo programId y hay
    // que poder mirar la SEGUNDA (`escrowIxs[1]`, más abajo): eso con un `.find()` no se puede.
    //
    // ⚠️ LO QUE NO CAMBIÓ, Y ACÁ SE DECÍA QUE SÍ (fix-pack WKH-347, AR/MNR-1): el `[0]` de la línea de
    // abajo NO es más estricto que el `.find()` de antes. `filter(p)[0]` y `find(p)` devuelven el MISMO
    // elemento, por definición, así que ese cambio no distingue ningún orden invertido y no compra nada.
    // Lo que hace fallar el orden invertido es el `decoded.name !== "deposit"` de más abajo, que ya
    // estaba. Medido: revertir esta línea a `.find(...)` deja la suite entera verde.
    const escrowIxs = tx.instructions.filter((i) => i.programId.equals(programId));
    const ix = escrowIxs[0];
    if (!ix) return { state: "unreadable" }; // ninguna ix del escrow: no hay depósito que juzgar

    const coder = new anchor.BorshInstructionCoder(escrowIdl as unknown as Idl);
    const decoded = coder.decode(ix.data); // null si el discriminator no es de ninguna ix del IDL
    if (!decoded || decoded.name !== "deposit") return { state: "unreadable" };

    // WKH-347 — la 2ª ix de negocio del escrow, leída de los MISMOS bytes. Sin llamadas nuevas, sin un
    // decoder nuevo y sin tocar nada del camino del beneficiary.
    const segunda = escrowIxs[1];
    let escrowIndexRegistration: DepositIndexRegistrationRead;
    if (!segunda) {
      escrowIndexRegistration = "not_registered"; // UNA sola ix de negocio: el escrow no entró al índice
    } else {
      const decodedSegunda = coder.decode(segunda.data);
      escrowIndexRegistration =
        decodedSegunda?.name === "register_escrow" ? "registered" : "unreadable";
    }

    const beneficiary = (decoded.data as { beneficiary?: unknown }).beneficiary;
    // El coder devuelve un PublicKey; se pide el base58 por el mismo camino que lo escribió el
    // ledger (canonicalizeAddress ⇒ new PublicKey(x).toBase58()), así que la comparación de arriba
    // es entre dos codificaciones canónicas y no entre dos formas distintas del mismo valor.
    if (!(beneficiary instanceof PublicKey)) return { state: "unreadable" };
    return { state: "read", beneficiary: beneficiary.toBase58(), escrowIndexRegistration };
  } catch {
    return { state: "unreadable" };
  }
}
