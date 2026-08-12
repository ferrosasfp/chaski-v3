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
// ── LAS DOS DIRECCIONES DEL DRIFT, Y CUÁL ES LA PELIGROSA ────────────────────────────────────────
//
//   · El programa SUBE `MAX_ENTRIES` y este archivo queda en 32 ⇒ se dejan de registrar escrows que
//     el programa habría aceptado. Degradación SEGURA: ningún depósito revierte, sólo quedan menos
//     escrows redescubribles.
//   · 🔴 El programa BAJA `MAX_ENTRIES` y este archivo sigue en 32 ⇒ `register_escrow` devuelve 6005
//     con el índice todavía por debajo de 32, y como la instrucción viaja en la MISMA transacción que
//     el `deposit`, el fallo REVIERTE EL DEPÓSITO ENTERO. Ésta es la peligrosa, y NADA del lado de
//     Chaski la detecta: no hay chequeo cruzado contra el programa desplegado. Se declara acá; no se
//     mitiga en esta HU.
//
// Subir el tope del programa es otra HU (`lib.rs:422` ya lo dice). Este número lo sigue, no lo lidera.
export const ESCROW_INDEX_MAX_ENTRIES = 32;
