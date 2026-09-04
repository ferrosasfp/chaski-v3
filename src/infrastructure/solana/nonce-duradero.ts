// La cuenta de nonce durable del remitente: derivar su dirección, leer su valor y armar la
// instrucción que lo hace avanzar (WKH-357 / HU-064).
//
// 🔴 QUÉ PROBLEMA RESUELVE. Un blockhash vive ~60-90 s (`solana-wallet.ts:104`) y el recorrido de
// firma por enlace profundo tiene DOS saltos a otra app con una persona leyendo en el medio. La
// transacción se firma antes del primer salto y se transmite después del último, así que compite
// contra un reloj que no puede ganar. Un nonce durable reemplaza ese blockhash por un valor que
// **no vence por tiempo**: sólo deja de servir cuando se USA (cuando una tx lo consume). El reloj
// desaparece del problema.
//
// ⚠️ QUÉ NO RESUELVE, dicho entero (CD-14): el durable nonce elimina la carrera de LOS DOS SALTOS
// QUE LLEVAN PLATA. Queda expuesto UN salto: el de la transacción que CREA la cuenta de nonce, que
// usa un blockhash normal. Eso es aceptable y no es lo mismo: en ese salto no hay nada en riesgo
// —ningún escrow, ningún USDC, ninguna orden de payout— y si el blockhash vence, el reintento pide
// uno nuevo y no cuesta más que un toque. En el salto del depósito, vencer significa
// `PRINCIPAL_STATE_UNKNOWN` y una pantalla que dice "no sabemos si te cobramos"
// (`PRINCIPAL_STATE_UNKNOWN`, `solana-wallet.ts:1017`).
//
// ⛔ LO QUE ACÁ NO SE GUARDA NUNCA: ninguna clave privada, igual que en `deeplink/preparado.ts:8-10`.
// La dirección de la cuenta se DERIVA de la pubkey del remitente y de una semilla fija, así que
// sobrevive a la muerte del proceso de JavaScript sin que haya nada que persistir. Eso es el motivo
// entero por el que se usa la variante por semilla: ver `construirNonceAdvance` y el docblock de
// `SEMILLA_DEL_NONCE`.
//
// DT-7 (heredado de `preparado.ts:18-19`) — este módulo NO lee `window`, `Date`, `fetch` ni
// `process.env`. La conexión y el techo de tiempo entran por parámetro.
import { NONCE_ACCOUNT_LENGTH, NonceAccount, PublicKey, SystemProgram } from "@solana/web3.js";
import type { Connection, TransactionInstruction } from "@solana/web3.js";

/**
 * La semilla de `createWithSeed`. Fija y versionada.
 *
 * ⛔ CAMBIARLA LE CAMBIA LA CUENTA A TODO EL MUNDO. La dirección se deriva de
 * `(pubkey del remitente, esta semilla, System Program)`, así que un valor nuevo apunta a una cuenta
 * que no existe: cada remitente que ya tenía la suya creada y fondeada quedaría con la renta
 * bloqueada ahí y tendría que crear (y pagar) otra. Si algún día hay que rotarla, es una migración
 * con su propia HU, no una edición de esta línea. El `-v1` está para que ese día tenga nombre.
 *
 * ≤ 32 bytes (`MAX_SEED_LENGTH` de `@solana/web3.js`); esta cadena mide 15.
 */
export const SEMILLA_DEL_NONCE = "chaski-nonce-v1";

/**
 * Los 4 bytes de `AdvanceNonceAccount`. GEMELAS de las de
 * `wasiai-facilitator/src/methods/solana-sponsor/deposit-shape.ts` (CD-17): el facilitator compara
 * los bytes que llegan contra las suyas, así que si las dos listas divergen, todo depósito por
 * enlace se rechaza con `NONCE_IX_BAD_DISCRIMINATOR`.
 *
 * MEDIDO el 2026-08-17 contra el `@solana/web3.js` de ESTE `node_modules` (^1.98.4):
 * `SystemProgram.nonceAdvance({...}).data` → `[4,0,0,0]`, largo 4.
 *
 * ⚠️ El input concreto que delataría un error: un discriminador `[3,0,0,0]` o `[4,0,0,1]` produce una
 * instrucción que el System Program interpreta como OTRA cosa (o rechaza), y del lado del facilitator
 * ni siquiera entra a Check 2n — cae como "ix de negocio que no es del escrow" y sale por
 * `PROGRAM_NOT_WHITELISTED`, un marcador que no habla del nonce y manda a buscar al lugar equivocado.
 * T-N3 es el test que compara estas 5 constantes contra lo que la librería produce.
 */
export const NONCE_ADVANCE_DISCRIMINATOR: readonly number[] = [4, 0, 0, 0];

/** Largo EXACTO de la `data`. El facilitator compara con `===`, nunca con `>=`. */
export const NONCE_ADVANCE_DATA_LEN = 4;

/** La `nonceAdvance` lleva EXACTAMENTE estas 3 cuentas, en este orden y sin ninguna extra. */
export const NONCE_ADVANCE_POSITIONAL_ACCOUNTS = 3;

/**
 * Los índices posicionales y las banderas que cada cuenta DEBE llevar (medidas el 2026-08-17):
 *   0 NONCE               writable, NO signer   — la cuenta de nonce
 *   1 RECENT_BLOCKHASHES  readonly, NO signer   === SysvarRecentB1ockHashes11111111111111111111
 *   2 AUTHORITY           SIGNER,   readonly    — el remitente, y NUNCA el facilitator
 *
 * ⚠️ POR QUÉ LA AUTHORITY ES EL REMITENTE Y NO ES UNA ELECCIÓN DE ESTILO. El guard más fuerte del
 * facilitator (Check 5 de `cr1.ts`) rechaza toda transacción en la que el fee-payer aparezca
 * referenciado por CUALQUIER instrucción, y la `nonceAdvance` referencia a su authority. Si la
 * authority fuera el facilitator, **todo depósito por enlace sería rechazado** por el guard
 * anti-drain, que es fail-closed y está bien que lo sea. Leído en
 * `wasiai-facilitator/src/methods/solana-sponsor/cr1.ts` (Check 5), no supuesto.
 */
export const NONCE_ADVANCE_ACCOUNT_INDEX = {
  NONCE: 0,
  RECENT_BLOCKHASHES: 1,
  AUTHORITY: 2,
} as const;

/**
 * Los TRES valores de leer la cuenta de nonce. **NUNCA dos.**
 *
 * La distinción que importa es la tercera contra la segunda: "la cuenta no está" es un HECHO sobre la
 * cadena, y "no pudimos preguntar" es un hecho sobre NOSOTROS. Colapsarlos es convertir "no pude
 * preguntar" en "no pasó", que es el error que este repo tiene catalogado
 * (`DEEPLINK_BLOCKHASH_DESCONOCIDO`, `deeplink/firma-por-enlace.ts:136`) y que cuesta borrarle a una
 * persona dos firmas que estaban perfectas.
 */
export type LecturaDelNonce =
  | { readonly tipo: "hay"; readonly valor: string } // base58 del blockhash guardado
  | { readonly tipo: "no-hay" } // `getAccountInfo` devolvió null: la cuenta no existe
  | { readonly tipo: "no-pudimos-preguntar" }; // el RPC falló, venció el techo, o los datos no decodifican

/**
 * El techo de tiempo, INYECTADO por quien llama.
 *
 * ⛔ PROHIBIDO poner un default acá: el número tiene que seguir viviendo en un solo lugar
 * (`BLOCKHASH_PROBE_TIMEOUT_MS`, `solana-wallet.ts:121`). Un default en este módulo sería un segundo
 * número que nadie recuerda actualizar.
 */
export type ConTecho = <T>(p: Promise<T>) => Promise<T>;

/**
 * La dirección de la cuenta de nonce del remitente. Determinística y re-derivable desde la pubkey
 * SOLA, que es lo único que sobrevive a la muerte de la página (`preparado.ts:3-6`).
 *
 * `base == from == remitente` en la creación ⇒ **UNA sola firma** y **nada que persistir**. La
 * variante con `Keypair` (`SystemProgram.createAccount`) marca la cuenta nueva como firmante, lo que
 * exigiría DOS firmas y por lo tanto guardar una clave privada — prohibido. Medido: la forma por
 * semilla da 1 firmante y la de keypair da 2 (T-N5).
 *
 * ⚠️ Es `async` aunque no haga I/O: `PublicKey.createWithSeed` devuelve una `Promise` porque hashea.
 * No hay red acá — un `await` sobre esto no puede colgarse.
 */
export function direccionDelNonce(senderPk: PublicKey): Promise<PublicKey> {
  return PublicKey.createWithSeed(senderPk, SEMILLA_DEL_NONCE, SystemProgram.programId);
}

/**
 * Lee el valor guardado en la cuenta de nonce. Devuelve los TRES valores de `LecturaDelNonce` y
 * NUNCA tira.
 *
 * ⛔ NO USA `connection.getNonce`, a propósito. Verificado en el `@solana/web3.js` de este repo:
 * envuelve todo en un `.catch()` que re-tira un único `Error('failed to get nonce…')`, o sea
 * **colapsa "la cuenta es basura" con "el RPC se cayó"** — exactamente los dos casos que este tipo
 * existe para separar. Se usa `getAccountInfo` + `NonceAccount.fromAccountData` dentro de NUESTRO
 * `try`, que es lo que deja decidir qué es cada cosa.
 *
 * ⚠️ HONESTIDAD DE ALCANCE: el tercer valor mete en la misma bolsa "el RPC falló", "venció el techo"
 * y "los datos no decodifican". Es un colapso DELIBERADO y del lado conservador (no limpia nada, no
 * afirma que la transacción esté muerta), pero es un colapso: el tri-estado **no** es más fino que
 * esto. Si alguna vez hace falta distinguir "cuenta corrupta" de "RPC caído", es un cuarto valor, no
 * una lectura más atenta de éste.
 *
 * ⚠️ Y `conTecho` NO CANCELA NADA (CD-18). Es un `Promise.race` (`solana-wallet.ts:148-162`): corta
 * **la espera de quien llama**, y el `getAccountInfo` sigue en vuelo después de vencido el techo. Lo
 * que se acota es cuánto espera la persona, no cuánto trabaja la red.
 *
 * NO se verifica `accountInfo.owner`, y el motivo va escrito para que su ausencia no se lea como un
 * olvido: la dirección se derivó con `programId = SystemProgram.programId`, y lo que se compara
 * después es el valor guardado contra el `recentBlockhash` de la transacción. Una cuenta con otro
 * dueño no puede producir ese match. Un check de owner acá sería cargo-cult.
 */
export async function leerNonce(
  connection: Connection,
  noncePk: PublicKey,
  conTecho: ConTecho,
): Promise<LecturaDelNonce> {
  try {
    const info = await conTecho(connection.getAccountInfo(noncePk));
    if (info === null) return { tipo: "no-hay" };
    // Un largo distinto de 80 no es una cuenta de nonce, sea lo que sea. No se intenta decodificar
    // igual: `fromAccountData` sobre bytes de otra forma puede devolver basura con forma válida.
    if (info.data.length !== NONCE_ACCOUNT_LENGTH) return { tipo: "no-pudimos-preguntar" };
    const cuenta = NonceAccount.fromAccountData(info.data);
    const valor = cuenta.nonce;
    // Un `nonce` vacío no es un valor con el que se pueda firmar nada.
    if (typeof valor !== "string" || valor.length === 0) return { tipo: "no-pudimos-preguntar" };
    // ⚠️ LA PUBKEY NULA CUENTA COMO DATO DEFORME, y esto es una MEDICIÓN, no una precaución
    // decorativa: 80 bytes en cero SÍ decodifican (medido el 2026-08-17,
    // `NonceAccount.fromAccountData(Buffer.alloc(80)).nonce` → `"111…1"`, la pubkey nula), así que el
    // check de largo de arriba NO los caza y sin esta línea una cuenta existente-pero-sin-inicializar
    // se leería como `hay` con un valor con el que ninguna tx puede entrar. El costo de no cazarlo no
    // es un error nítido en el cliente: es una tx que se firma, viaja, y REVIERTE en cadena con un
    // fallo del System Program que no habla de esto. Cae en `no-pudimos-preguntar` —y no en
    // `no-hay`— porque es el lado conservador: no afirma que la transacción esté muerta y NO limpia
    // las firmas de la persona.
    if (valor === PublicKey.default.toBase58()) return { tipo: "no-pudimos-preguntar" };
    return { tipo: "hay", valor };
  } catch {
    // Cae acá el RPC que tira, el techo que vence y los bytes que `fromAccountData` no digiere.
    // Los tres comparten la consecuencia: NO se limpia el disco (ver la tabla de §6.8 del contrato).
    return { tipo: "no-pudimos-preguntar" };
  }
}

/**
 * La instrucción que hace avanzar el nonce. Va como instrucción **0 ABSOLUTA** de la transacción del
 * depósito por enlace, antes incluso de las de ComputeBudget.
 *
 * ⛔ SE PREPONE A MANO CON `.add(...)`, NUNCA CON `tx.nonceInfo`. `Transaction.compileMessage()`
 * prepone la instrucción en un array **LOCAL** y NO muta `this.instructions`, así que con `nonceInfo`
 * el objeto diría `instructions[0] === SetComputeUnitLimit` mientras el mensaje FIRMADO —lo que
 * viaja— dice `nonceAdvance` en 0. Eso desincroniza a los cuatro lectores que van por posición,
 * incluido nuestro propio servidor (`settlement/solana-deposit-beneficiary.ts:106`). Medido el
 * 2026-08-17: con `nonceInfo` seteado, `tx.instructions.length` da 1 y
 * `tx.compileMessage().instructions.length` da 2. T-N4 congela esa trampa.
 *
 * ⚠️ Y POR ESO MISMO, TODA CUENTA DE INSTRUCCIONES TIENE QUE INCLUIR A ÉSTA. El presupuesto de
 * cómputo del runtime es `200.000 × <ix que NO son ComputeBudget>` y la `nonceAdvance` no es
 * ComputeBudget, así que el runtime la cuenta. Contar sólo las de negocio ya rompió una vez el
 * cálculo del facilitator (§6.4 del contrato, su test es T-25 allá).
 *
 * **Por qué esta función existe y no se llama `SystemProgram.nonceAdvance` en el sitio de uso**: es
 * el único lugar donde nuestras 5 constantes pinneadas se comparan contra lo que la librería produce
 * en NUESTRO `node_modules` (T-N3). Un bump de `@solana/web3.js` que mueva el discriminador o el
 * orden de las cuentas se cae ACÁ, en un test, y no en producción contra el Check 2n del
 * facilitator. ⛔ No la borres por "wrapper inútil".
 */
export function construirNonceAdvance(
  noncePk: PublicKey,
  senderPk: PublicKey,
): TransactionInstruction {
  return SystemProgram.nonceAdvance({ noncePubkey: noncePk, authorizedPubkey: senderPk });
}

/**
 * Las DOS instrucciones que CREAN e inicializan la cuenta de nonce del remitente (WKH-358 / AC-5).
 *
 * 🔴 SE COMPONEN A MANO PORQUE LA FUNCIÓN QUE PARECE QUE HAY NO EXISTE. Medido contra el
 * `@solana/web3.js` de este `node_modules` (1.98.4):
 *
 * ```
 * createNonceAccount           function
 * createNonceAccountWithSeed   undefined   ← 🔴 NO EXISTE
 * nonceInitialize              function
 * createAccountWithSeed        function
 * NONCE_ACCOUNT_LENGTH         80
 * ```
 *
 * ⛔ Y `createNonceAccount` —el atajo que suena bien— ESTÁ PROHIBIDO. La diferencia no es de estilo:
 *
 * | Forma | ix | `numRequiredSignatures` | Quién firma |
 * |---|---|---|---|
 * | **`createAccountWithSeed` + `nonceInitialize`** (`base == from == sender`) | **2** | **1** | el sender, y nadie más |
 * | `createNonceAccount(...)` con un `Keypair` | 2 | **2** | el sender **y la cuenta nueva** |
 *
 * Con dos firmantes habría que **persistir una clave privada** para que la segunda firma sobreviva al
 * salto a la billetera, y eso es exactamente lo que la ola 3 descartó (`:109-115`) y lo que
 * `deeplink/preparado.ts:8-10` prohíbe. Una firma y nada que persistir es el contrato entero de esta
 * cuenta. Lo mide `T-065-11`.
 *
 * ⛔ EL `space` VA COMO `NONCE_ACCOUNT_LENGTH` DE LA LIBRERÍA, **nunca** el literal `80` (CD-20). Es el
 * mismo número que `leerNonce` compara en `:159`: si un bump de la librería lo moviera, escribir `80`
 * a mano dejaría la cuenta creada con un largo que nuestra propia lectura rechaza. Lo mide `T-065-11b`
 * con **dos** fuentes.
 *
 * ⚠️ EL ALQUILER NO VUELVE POR NINGÚN BOTÓN DE CHASKI, y quien muestre esto en pantalla tiene que
 * decirlo: recuperarlo exige un `nonceWithdraw`, que no existe en este árbol (está declarado en
 * (`nonceWithdraw`, `../../application/solana-escrow-rent.ts:401`)). El monto lo pone quien llama, desde
 * `NONCE_ACCOUNT_RENT_LAMPORTS`.
 *
 * ⚠️ ESTA TRANSACCIÓN USA UN BLOCKHASH NORMAL y por lo tanto vence en ~60-90 s (ver el encabezado de
 * este archivo). Es el único salto del recorrido que sigue compitiendo contra el reloj, y es
 * aceptable porque no hay nada en riesgo: sin escrow, sin USDC y sin orden de payout, el reintento
 * cuesta un toque. ⛔ **PROHIBIDO reusar la transacción guardada** en el reintento: se arma de cero,
 * con un blockhash nuevo.
 *
 * `lamports` va por parámetro y no se lee de una constante acá por lo mismo que `ConTecho`: el número
 * vive en UN solo lugar (`NONCE_ACCOUNT_RENT_LAMPORTS`), y un default en este módulo sería un segundo
 * número que nadie recuerda actualizar.
 */
export function construirCreacionDeNonce(
  senderPk: PublicKey,
  noncePk: PublicKey,
  lamports: number,
): readonly TransactionInstruction[] {
  return [
    // `basePubkey === fromPubkey === senderPk` es lo que hace que la cuenta nueva NO sea firmante: su
    // dirección se deriva, no se genera. Es la misma derivación que `direccionDelNonce`, y quien
    // llama pasa el resultado de ésa como `noncePk` — el `it` lo compara.
    SystemProgram.createAccountWithSeed({
      fromPubkey: senderPk,
      basePubkey: senderPk,
      newAccountPubkey: noncePk,
      seed: SEMILLA_DEL_NONCE,
      lamports,
      space: NONCE_ACCOUNT_LENGTH, // ⛔ NUNCA el literal 80 (CD-20)
      programId: SystemProgram.programId,
    }),
    // La authority es el SENDER, siempre (CD-6). Si fuera el facilitator, Check 5 rechazaría todo
    // depósito por enlace: el bloque de `:72-77` lo explica entero.
    SystemProgram.nonceInitialize({ noncePubkey: noncePk, authorizedPubkey: senderPk }),
  ];
}
