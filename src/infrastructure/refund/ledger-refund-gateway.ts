// Infrastructure — RefundGateway adapter DEFAULT (WKH-186/AC-8). LEDGER-ONLY (CD-8): NO revierte
// ningún movimiento on-chain real.
//
// ⚠️ ACÁ NACÍA EL COMPROBANTE FABRICADO. Este método devolvía `refund-ledger-${Date.now()}`: un string
// con forma de identificador que no identifica NADA. Nadie lo puede buscar, en ninguna cadena ni en
// ningún libro. Aguas abajo el use-case lo escribía como `refundTx` y la remesa saltaba a `refunded`,
// que es terminal — así que la persona leía "Referencia de reembolso: refund-ledger-mabc" al lado de
// la palabra reembolso, con sus USDC todavía en el vault del escrow y sin ningún botón para sacarlos.
//
// `null` es la respuesta HONESTA de un adapter que no mueve plata: no revertí nada, no tengo
// comprobante. El use-case ya no puede escribir un estado terminal sobre eso, y el botón de recuperar
// (que exige refundTx == null) sigue disponible.
//
// El clawback on-chain real NO es de este adapter: cuando el depósito ya entró al vault del escrow,
// se recupera por el refund trustless post-deadline (SolanaEscrowRefundGateway, que el sender firma
// y broadcastea) o por la release-authority. Ver la marca `principal_settled_refund_manual`.
import type { Money } from "../../domain/money";
import type { RefundGateway } from "../../application/ports";

export class LedgerRefundGateway implements RefundGateway {
  async creditBack(_input: {
    remittanceId: string;
    amountUsd: Money;
    reason: string;
  }): Promise<{ refundTx: null }> {
    // Si alguna vez este adapter revierte plata de verdad, devolverá la tx REAL de esa reversión.
    // Cualquier otro string es una mentira con formato de comprobante.
    return { refundTx: null };
  }
}
