// Infrastructure — RefundGateway adapter DEFAULT (WKH-186/AC-8). LEDGER-ONLY (CD-8): NO revierte
// ningún movimiento on-chain real. En modo mock el principal no se movió (authorizePrincipal firma
// un mensaje simbólico salvo EIP-3009 real, gated). Produce un refundTx SINTÉTICO documentado —
// análogo al `0xdemo...` de FallbackWallet. El clawback on-chain real (revertir un
// transferWithAuthorization ya settleado) es Scope OUT / follow-up de Fase A.
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
