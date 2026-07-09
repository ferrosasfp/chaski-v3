import type { KycVerification } from "../../domain/remittance";
import type { KycStore, WalletPort } from "../ports";

/**
 * Conecta la wallet (el "login" de la DApp) y devuelve la address + el KYC recordado (si lo hay),
 * para que el flujo sepa si saltear la verificación (KYC-once).
 */
export class ConnectWallet {
  constructor(
    private readonly wallet: WalletPort,
    private readonly store: KycStore,
  ) {}

  async execute(): Promise<{ address: string; rememberedKyc: KycVerification | null }> {
    const address = await this.wallet.connect();
    const rememberedKyc = await this.store.get(address);
    return { address, rememberedKyc };
  }
}
