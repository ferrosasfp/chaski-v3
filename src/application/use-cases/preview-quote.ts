import type { PayoutMethod, Quote } from "../../domain/remittance";
import type { QuoteGateway } from "../ports";

/** Cotización en vivo para el preview (no crea remesa). */
export class PreviewQuote {
  constructor(private readonly quotes: QuoteGateway) {}

  execute(input: { amountUsd: number; method: PayoutMethod; destCountry?: string }): Promise<Quote> {
    return this.quotes.requestQuote({
      amountUsd: input.amountUsd,
      method: input.method,
      destCountry: input.destCountry ?? "PE",
    });
  }
}
