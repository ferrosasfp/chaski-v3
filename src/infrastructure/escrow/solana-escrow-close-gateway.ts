// Infrastructure — SolanaEscrowCloseGateway (WKH-327). Delega en `wallet.closeEscrow`
// (SolanaWalletAdapter): el SENDER firma + broadcastea el `close` del escrow, que barre el vault hacia
// su propia ATA, cierra `escrow_state` y el vault devolviéndole los 4.002.000 lamports de alquiler que
// él mismo pagó en el `deposit`, y saca la entrada del índice. NO revierte ni decide nada por su
// cuenta: los guards viven en la ix `close` del programa Anchor (exige estado terminal, `has_one
// sender`, `close = sender`) y en la lectura on-chain que el adapter hace ANTES de firmar.
import type {
  SolanaEscrowCloseGateway as SolanaEscrowClosePort,
  SolanaEscrowCloseResult,
} from "../../application/ports";

// Dependencia mínima: sólo `closeEscrow` (subconjunto de SolanaWalletAdapter). Mantiene el gateway
// desacoplado del resto de WalletPort y testeable con un stub.
export interface SolanaCloseCapableWallet {
  closeEscrow(remittanceId: string, sender?: string): Promise<SolanaEscrowCloseResult>;
}

export class SolanaEscrowCloseGateway implements SolanaEscrowClosePort {
  constructor(private readonly wallet: SolanaCloseCapableWallet) {}
  // Propaga el `confirmation` TAL CUAL. Traducirlo acá, o defaultearlo a "confirmed", sería volver a
  // meter la afirmación no verificada: el adapter sólo dice "confirmed" después de LEER que
  // `escrow_state` ya no existe, y un default acá tiraría esa lectura a la basura.
  async close(input: { remittanceId: string; sender: string }): Promise<SolanaEscrowCloseResult> {
    // El sender (input.sender) es quien firma y quien paga el fee: es SU alquiler el que vuelve.
    return this.wallet.closeEscrow(input.remittanceId, input.sender);
  }
}
