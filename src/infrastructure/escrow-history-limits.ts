// Los dos techos de la lectura on-chain del HISTORIAL (WKH-349): cuántas cuentas caben en una
// consulta, y cuánto se la espera.
//
// ⚠️ ESTE ARCHIVO NO IMPORTA NADA, Y ES A PROPÓSITO. Misma forma y misma razón que
// `escrow-lookup-limits.ts` y `escrow-index-limits.ts`: lo consume código que corre en el navegador
// (`src/infrastructure/solana-wallet.ts`) y cualquier import acá arrastra dependencias al bundle del
// cliente. Si esto necesita importar algo, la constante está en el lugar equivocado.
//
// ── POR QUÉ ESTAS DOS CONSTANTES NO VIVEN AL LADO DE SUS HERMANAS ────────────────────────────────
//
// Es lo primero que va a preguntar quien lea `solana-wallet.ts`: el techo de tiempo tiene tres
// hermanas ahí mismo, en el bloque `:106-121`, y ésta está en otro archivo. El motivo es presupuesto,
// no prolijidad, y el invariante que lo sostiene no lleva número porque el número caduca solo: TODAS
// las citas ANCLADAS que `solana-wallet.ts` recibe apuntan de `:188` para abajo, o sea por debajo de
// ese bloque. Una línea nueva ahí arriba las rota a TODAS de golpe. Acá las desplazadas son 0. El
// import que las trae al adapter entra pegado a una línea existente, por lo mismo.
//
// ── DE DÓNDE SALE EL 100 ─────────────────────────────────────────────────────────────────────────
//
// Del método JSON-RPC `getMultipleAccounts`, que acepta hasta 100 pubkeys por request.
//
// ⚠️ ESTE REPO NO TIENE NINGUNA MEDICIÓN PROPIA DE ESE LÍMITE. El input que lo refutaría: una lectura
// con 101 PDAs contra `api.devnet.solana.com`, que nadie corrió desde acá. Si el límite real fuera
// menor, el síntoma es `"unknown"` en historiales grandes — degradación honesta, no una frase falsa.
//
// Los tres consumidores del batch que ya existen topean muy por debajo y nunca lo tocaron:
// `MAX_RECOVERY_CANDIDATES` = 20 y `MAX_CLOSEABLE_CANDIDATES` = 20, los dos vía
// (`ESCROW_ID_LOOKUP_CEILING`, `escrow-lookup-limits.ts:29`), y
// (`ESCROW_INDEX_MAX_ENTRIES`, `escrow-index-limits.ts:48`) = 32.
//
// 🔴 ESTE NÚMERO NO SE DERIVA DE `ESCROW_ID_LOOKUP_CEILING`, y la tentación de reusarlo es el defecto
// que ese archivo documenta, con los papeles cambiados: aquel 20 es el techo del SERVIDOR del registro
// durable, y su propio docblock lo dice ("lo consumen los dos lados: la route … y el cliente",
// `escrow-lookup-limits.ts:3-4`). Esta consulta no pasa por ninguna route: no hay servidor que la
// acote, así que el único techo que la limita es el del RPC.
export const ESCROW_STATE_BATCH_CEILING = 100;

// ── DE DÓNDE SALE EL 5 000 ───────────────────────────────────────────────────────────────────────
//
// De la familia de techos que este repo ya usa para sus LECTURAS SIMPLES —sin firma ni confirmación—
// que corren dentro del camino que la persona espera mirando la pantalla: `SOL_BALANCE_PROBE_TIMEOUT_MS`
// (sobre `getBalance`) y `ESCROW_INDEX_PROBE_TIMEOUT_MS` (sobre `getAccountInfo`), los dos en el bloque
// de `solana-wallet.ts` que se nombra arriba — SIN número de línea, justamente para no citar por
// número lo que está por ENCIMA de `:188`. El segundo es el precedente de ADOPTAR el número nombrando
// la familia: su docblock dice "Mismo número y MISMA razón que SOL_BALANCE_PROBE_TIMEOUT_MS".
//
// El tercer techo de ese bloque, `REFUND_CONFIRM_TIMEOUT_MS` = 30 000, NO aplica: mide la confirmación
// de una tx PROPIA y está calibrado contra la vida útil de un blockhash. Acá no hay tx ni confirmación.
//
// QUÉ SIGNIFICA QUE VENZA: ese chunk cae a `"unknown"`, o sea "no pudimos preguntar". NUNCA "no hay
// plata" ni "ya se resolvió". Es lo mismo que hacen los otros dos en su `catch`.
//
// EL TECHO ES POR CHUNK, NO GLOBAL: con 150 ids son 2 chunks y 2 techos de 5 000 ms. Si el primero
// vence, el segundo arranca con su techo entero y sus filas conservan la respuesta que consigan.
//
// ⚠️ LO QUE NO ESTÁ CALIBRADO, y no se puede escribir como certeza: los dos techos de 5 s de los que
// sale este número cubren lecturas de UNA cuenta. Ésta pide hasta `ESCROW_STATE_BATCH_CEILING` pubkeys
// en una sola request, y nadie cronometró eso contra el RPC público desde este repo. El input que lo
// refutaría: cronometrar 100 PDAs contra `api.devnet.solana.com`. Si el número fuera corto, el síntoma
// es `"unknown"` en historiales grandes — degradación honesta, no una afirmación falsa. Por eso acá
// dice DE DÓNDE SALE el número y no dice que "alcanza".
export const ESCROW_STATE_BATCH_TIMEOUT_MS = 5_000;
