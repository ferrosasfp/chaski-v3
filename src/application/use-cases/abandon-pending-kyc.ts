import type { KycPendingStore } from "../ports";

/** Abandona un KYC en curso (limpia el pending) — usado cuando el resume-loop agota el timeout,
 *  para que el próximo reload no repita el bloqueo. */
export class AbandonPendingKyc {
  constructor(private readonly pending: KycPendingStore) {}

  async execute(): Promise<void> {
    await this.pending.clear();
  }
}
