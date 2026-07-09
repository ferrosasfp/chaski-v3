import type { RemittanceState } from "../../domain/remittance";
import type { RemittanceRepository } from "../ports";

/** Historial de remesas (para la pantalla de historial). */
export class ListHistory {
  constructor(private readonly repo: RemittanceRepository) {}

  execute(): Promise<RemittanceState[]> {
    return this.repo.list();
  }
}
