import type { Remittance } from "../../domain/remittance";
import type { Clock, QuoteGateway, RemittanceRepository } from "../ports";

/** Fija la tasa (quote) tras KYC pasado — la remesa queda lista para confirmar. */
export class LockQuote {
  constructor(
    private readonly quotes: QuoteGateway,
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
  ) {}

  async execute(input: { remittanceId: string }): Promise<Remittance> {
    const r = await this.repo.get(input.remittanceId);
    if (!r) throw new Error("remittance_not_found");
    const s = r.snapshot;
    const quote = await this.quotes.requestQuote({
      amountUsd: s.sendUsd.major,
      method: s.beneficiary.method,
      destCountry: s.beneficiary.country,
    });
    r.attachQuote(quote, this.clock.nowIso()); // valida monto + no-vencido (invariante)
    await this.repo.save(r);
    return r;
  }
}
