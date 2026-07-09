import { Money } from "../../domain/money";
import { type Beneficiary, Remittance } from "../../domain/remittance";
import type { Clock, IdGenerator, RemittanceRepository } from "../ports";

/** Crea la remesa (estado `created`) tras ingresar monto + destinatario. */
export class CreateRemittance {
  constructor(
    private readonly repo: RemittanceRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: { amountUsd: number; beneficiary: Beneficiary }): Promise<Remittance> {
    const r = Remittance.create(
      this.ids.newId(),
      input.beneficiary,
      Money.of(input.amountUsd, "USDC"),
      this.clock.nowIso(),
    );
    await this.repo.save(r);
    return r;
  }
}
