// Las TRES clases de un `fund_failed` de TransFi, y el estado previo de la fila que define cada una.
// SERVER-ONLY (lo consume el ledger de settlements).
//
// Por qué existe: el proveedor manda UN solo evento (`fund_failed`) para tres situaciones que piden
// tres acciones distintas de una persona, y el estado previo de la fila es lo que las separa:
//   · 'prepared'                  ⇒ nunca hubo depósito nuestro: no hay nada nuestro en juego.
//   · 'principal_in'/'forward_error' ⇒ el principal está en el escrow y NO se liberó (refund tras el deadline).
//   · 'submitted'                 ⇒ el proveedor confirmó `asset_deposited`, o sea que el release ya entró.
// Escribir el MISMO `last_error` para los tres no borra la diferencia: la vuelve invisible.
import type { SettlementLedgerStatus, WebhookFailureClass } from "../../application/ports";

// Los TRES literales que un operador lee para decidir si escalar. Definidos ACÁ y en ningún otro
// lado: un literal duplicado es un enum que driftea sin que nada se ponga rojo (mismo criterio que
// preparedPlaceholderTxHash, supabase-settlement-ledger.ts).
export const TRANSFI_FUND_FAILED_NO_PRINCIPAL = "transfi_fund_failed_no_principal";
export const TRANSFI_FUND_FAILED_PRINCIPAL_IN_ESCROW = "transfi_fund_failed_principal_in_escrow";
export const TRANSFI_FUND_FAILED_PRINCIPAL_RELEASED = "transfi_fund_failed_principal_released";

export interface WebhookFailureClassSpec {
  readonly failureClass: WebhookFailureClass;
  readonly previousStatuses: readonly SettlementLedgerStatus[];
  readonly lastError: string;
}

// Los tres conjuntos son DISJUNTOS dos a dos y su unión es exactamente WEBHOOK_UPDATABLE_STATUSES
// (lo asserta T-INV contra esa constante como fuente independiente). Ninguno contiene el valor que se
// escribe ('failed') ni ningún otro estado terminal ⇒ una fila mutada por un UPDATE sale de todos los
// conjuntos y el orden de aplicación no puede cambiar el resultado.
export const WEBHOOK_FAILURE_CLASSES: readonly WebhookFailureClassSpec[] = [
  { failureClass: "no_principal", previousStatuses: ["prepared"], lastError: TRANSFI_FUND_FAILED_NO_PRINCIPAL },
  { failureClass: "principal_in_escrow", previousStatuses: ["principal_in", "forward_error"], lastError: TRANSFI_FUND_FAILED_PRINCIPAL_IN_ESCROW },
  { failureClass: "principal_released", previousStatuses: ["submitted"], lastError: TRANSFI_FUND_FAILED_PRINCIPAL_RELEASED },
];
