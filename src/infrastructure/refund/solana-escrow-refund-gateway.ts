// Infrastructure — SolanaEscrowRefundGateway (HU-SOL-13/AC-6, CD-10). Delega en `wallet.refundEscrow`
// (SolanaWalletAdapter): el SENDER firma + broadcastea el `refund` del escrow, SIN facilitator ni
// release-authority. NO revierte nada por su cuenta: la garantía money-path la da la ix `refund` del
// programa Anchor (has_one sender, DeadlineNotReached/EscrowNotDeposited) + el read on-chain del adapter.
import type {
  SolanaEscrowRefundGateway as SolanaEscrowRefundPort,
  SolanaEscrowRefundResult,
} from "../../application/ports";

// Dependencia mínima: sólo `refundEscrow` (subconjunto de SolanaWalletAdapter). Mantiene el gateway
// desacoplado del resto de WalletPort y testeable con un stub.
// HU-SOL-20/AC-2: `remittanceId` OPCIONAL. Ausente ⇒ el adapter lo recupera del store durable
// server-side (localStorage perdido / otro dispositivo). Presente ⇒ path byte-idéntico (AC-6).
export interface SolanaRefundCapableWallet {
  refundEscrow(remittanceId?: string, sender?: string): Promise<SolanaEscrowRefundResult>;
}

export class SolanaEscrowRefundGateway implements SolanaEscrowRefundPort {
  constructor(private readonly wallet: SolanaRefundCapableWallet) {}
  // Propaga el `confirmation` TAL CUAL. Traducirlo acá (o defaultearlo a "confirmed") sería volver a
  // meter la afirmación no verificada que este fix-pack vino a sacar.
  async refund(input: { remittanceId?: string; sender: string }): Promise<SolanaEscrowRefundResult> {
    // CD-10: el sender (input.sender) es quien firma; la release-authority NUNCA interviene.
    return this.wallet.refundEscrow(input.remittanceId, input.sender);
  }
}
