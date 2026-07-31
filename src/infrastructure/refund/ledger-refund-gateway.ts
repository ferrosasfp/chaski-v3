// Infrastructure — RefundGateway adapter DEFAULT (WKH-186/AC-8). LEDGER-ONLY (CD-8): NO revierte
// ningún movimiento on-chain real. Produce un refundTx SINTÉTICO documentado.
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
  }): Promise<{ refundTx: string }> {
    return { refundTx: `refund-ledger-${Date.now().toString(36)}` };
  }
}
