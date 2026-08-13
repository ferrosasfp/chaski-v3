// Cuántas entradas caben en el `EscrowIndex` de un remitente, del lado del cliente.
//
// ⚠️ ESTE ARCHIVO NO IMPORTA NADA, Y ES A PROPÓSITO. Misma forma y misma razón que
// `escrow-lookup-limits.ts`: lo consume código que corre en el navegador (la sonda del índice, en
// `src/infrastructure/solana-wallet.ts`) y cualquier import acá arrastra dependencias al bundle del
// cliente. Si esto necesita importar algo, la constante está en el lugar equivocado.
//
// ── DE DÓNDE SALE EL 32 ──────────────────────────────────────────────────────────────────────────
//
// De `MAX_ENTRIES: usize = 32` en `solana-programs/programs/escrow/src/lib.rs:422`, que es lo que el
// `require!` de `lib.rs:362` compara antes de empujar una entrada: pasado el tope, `register_escrow`
// falla con `EscrowIndexFull` (código 6005).
//
// ── POR QUÉ SE ESCRIBE A MANO Y NO SE DERIVA, que es la parte incómoda ──────────────────────────
//
// El IDL NO EXPRESA `max_len`. El tipo de `EscrowIndex.entries` es `vec<[u8;16]>` sin ninguna cota
// (la copia pinneada, `src/infrastructure/solana/escrow-idl.ts`, lo declara así). O sea que el
// cliente NO PUEDE derivar este número de nada que tenga a mano: o lo escribe, o no lo sabe.
//
// ── LAS TRES FORMAS DE QUEDAR DESALINEADO, Y CUÁLES SON PELIGROSAS ───────────────────────────────
//
// ⚠️ Acá decía "LAS DOS DIRECCIONES DEL DRIFT" y enumeraba dos. Hay una tercera que no es drift del
// número sino del MOMENTO en que se lo compara, y faltaba (fix-pack WKH-347, AR/MNR-5). Un conteo
// enumerado a mano sin decir qué queda afuera es el defecto que este repo ya tiene documentado.
//
//   · El programa SUBE `MAX_ENTRIES` y este archivo queda en 32 ⇒ se dejan de registrar escrows que
//     el programa habría aceptado. Degradación SEGURA: ningún depósito revierte, sólo quedan menos
//     escrows redescubribles.
//   · 🔴 El programa BAJA `MAX_ENTRIES` y este archivo sigue en 32 ⇒ `register_escrow` devuelve 6005
//     con el índice todavía por debajo de 32, y como la instrucción viaja en la MISMA transacción que
//     el `deposit`, el fallo REVIERTE EL DEPÓSITO ENTERO. Ésta es la peligrosa, y NADA del lado de
//     Chaski la detecta: no hay chequeo cruzado contra el programa desplegado. Se declara acá; no se
//     mitiga en esta HU.
//   · 🔴 LOS DOS NÚMEROS COINCIDEN Y EL DEPÓSITO REVIERTE IGUAL, porque el cliente decide con un conteo
//     que leyó ANTES y el programa evalúa `entries.len() < MAX_ENTRIES` cuando la tx se ejecuta. El
//     input concreto: una billetera con 31 entradas arranca DOS depósitos antes de que el primero
//     confirme; las dos sondas leen 31 y las dos transacciones llevan `register_escrow`; la primera
//     aterriza y deja el índice en 32; la segunda falla con `EscrowIndexFull` (6005) y REVIERTE SU
//     DEPÓSITO COMPLETO, con la orden de payout ya creada del lado del servidor. Es una carrera
//     (TOCTOU), no un número mal escrito, así que subir o bajar esta constante no la toca.
//     ⛔ NO ES REPRODUCIBLE EN LA SUITE: pide concurrencia real contra un validador. Se declara y no se
//     mitiga acá. Lo que la haría inofensiva es que el cliente NO decida (que la ix vaya siempre y el
//     programa la ignore si está llena), y eso es un cambio del programa, o sea otra HU.
//     ⚠️ El caso simétrico —el índice AUSENTE y dos depósitos a la vez— es SEGURO: la cuenta es
//     `init_if_needed`, así que el segundo `register_escrow` la encuentra creada y sigue.
//
// Subir el tope del programa es otra HU (`lib.rs:422` ya lo dice). Este número lo sigue, no lo lidera.
export const ESCROW_INDEX_MAX_ENTRIES = 32;
