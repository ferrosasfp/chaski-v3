// Infrastructure — mensaje canónico del patrocinio de gas Solana (SDD 037, Guard B).
//
// Qué firma la persona: un texto LEGIBLE que dice qué está autorizando (remesa, monto, token, red)
// más la firma de la transacción concreta que va a pagar. El facilitator reconstruye ese mismo texto
// leyendo cada línea de la transacción y de su propia config, y verifica la firma ed25519. Como no
// hay ningún secreto compartido, quien no controla la billetera no puede producir una firma válida.
//
// ⚠️ ESTE ES EL SEGUNDO PROMPT DE BILLETERA, y es el requisito, no un descuido. `authorizePrincipal`
// pide `signTransaction` y después `signMessage`. En un producto que mueve plata de la familia de
// alguien, que la persona lea qué autoriza vale más que ahorrarle un toque. PROHIBIDO
// "optimizarlo" a una sola firma: sin este mensaje, una firma de transacción capturada sirve para
// pedirle al facilitator que pague el gas de un depósito que quien lo pide nunca autorizó.
//
// ⚠️ Y LO QUE ESO **NO** ES: no es "patrocinio de cualquier monto". Se midió (CR MNR-1): el monto
// vive en `deposit.data[88..96]`, o sea DENTRO de los bytes que la billetera firmó, así que editarlo
// invalida la firma de la transacción y lo corta A3 del lado del facilitator — que es Guard A y
// sigue en pie aunque Guard B se caiga entero. Con una firma capturada el atacante consigue
// exactamente el monto que la víctima firmó. Lo que este mensaje sí compra es el CONSENTIMIENTO
// sobre ese depósito y ese momento, más el amarre a ESA transacción por la línea `tx`.
//
// ⚠️ QUÉ NO NOMBRA ESTE MENSAJE: el `beneficiary`. Las 7 líneas son dominio, `sender`, `network`,
// `remittance`, `amount`, `mint` y `tx` — el destino del dinero NO está entre ellas. Vive en
// `deposit.data[24..56]` y queda atado sólo transitivamente, por la línea `tx` (cambiar el destino
// cambia los bytes y por lo tanto la firma). La exclusión está decidida en el §2 del SDD 037 y no se
// discute acá; lo que se dice es dónde vive el control que sí lo cubre y bajo qué condición deja de
// cubrirlo: `app/api/settle/solana-sponsor/route.ts` (paso S3.5) compara el destino que está adentro
// de la tx contra la deposit-address que ESTE servidor registró al preparar. Ese chequeo depende del
// ledger: con `SETTLEMENT_LEDGER_ENABLED != "true"` o sin envs de Supabase, `getSettlementLedger()`
// devuelve null y **el control no existe**. Entonces: apagar el ledger deja al destino sin ninguna
// verificación, ni acá ni allá.
//
// SSOT (CD-7): éste es el ÚNICO lugar de chaski donde se arma este string. Su gemelo byte-idéntico
// vive en `wasiai-facilitator/src/methods/solana-sponsor/sponsor-pop.ts`. Lo que detecta que los dos
// se separen es el vector golden (`src/test-support/sponsor-pop-golden.ts`): cambiar acá `network:`
// por `Network:` deja este repo internamente coherente y sólo rompe contra el servidor real.
//
// Browser+node-safe: sólo template strings. NUNCA `Buffer` (es node-only y este builder corre en el
// bundle del navegador — auto-blindaje HU-SOL-5 BLQ-MED-1).

/** Separador de dominio. Distinto del `Chaski Proof-of-Possession` del leg de payout a propósito:
 *  una firma legítima de aquel challenge NO debe servir para pedir patrocinio. */
const SPONSOR_POP_DOMAIN = "WasiAI Sponsor Request v1";

export interface SponsorPopFields {
  /** base58 del pubkey de la billetera que deposita. */
  sender: string;
  /** CAIP-2 del cluster: "solana:devnet" | "solana:mainnet". */
  networkId: string;
  /** id de la remesa (el mismo que va en la ix `deposit`). */
  remittanceId: string;
  /** monto en unidades mínimas, decimal, sin separadores ni signo. */
  amountMinor: string;
  /** base58 del mint del token que se deposita. */
  mint: string;
  /** base58 de la firma de 64 bytes que la billetera puso sobre ESTA transacción. */
  txSignatureB58: string;
}

/**
 * SSOT del mensaje. 7 líneas separadas por `\n`, SIN newline final — mismo idiom que
 * `buildSolanaPopMessage` (`pop-challenge.ts:54-56`). La billetera lo firma VERBATIM.
 */
export function buildSponsorPopMessage(p: SponsorPopFields): string {
  return `${SPONSOR_POP_DOMAIN}\nsender: ${p.sender}\nnetwork: ${p.networkId}\nremittance: ${p.remittanceId}\namount: ${p.amountMinor}\nmint: ${p.mint}\ntx: ${p.txSignatureB58}`;
}
