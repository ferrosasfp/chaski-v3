// Las TRES clases de un `fund_failed` de TransFi, y el estado previo de la fila que define cada una.
// SERVER-ONLY (lo consume el ledger de settlements).
//
// Por qué existe: el proveedor manda UN solo evento (`fund_failed`) para tres situaciones que piden
// tres acciones distintas de una persona, y el estado previo de la fila es lo que las separa:
//   · 'prepared'                  ⇒ el ledger NO tiene registrado un depósito nuestro.
//     ⚠️ Eso es lo afirmable, y es más chico de lo que parece: dice el estado del REGISTRO, no el del
//     mundo. Un depósito REAL puede dejar la fila en 'prepared' si el write best-effort de
//     recordSolanaPrincipalIn falló de forma transitoria (el sponsor lo traga por diseño y el
//     clasificador lo trata como pasajero ⇒ console.warn, sin alerta). Es el residuo #5 del
//     auto-blindaje: acá 'prepared' se clasifica igual, pero el comentario no debe prometer que no
//     hubo plata.
//   · 'principal_in'/'forward_error' ⇒ el principal está en el escrow y NO se liberó (refund tras el deadline).
//   · 'submitted'                 ⇒ el proveedor DIJO haber visto los USDC (`asset_deposited`) y
//     DESPUÉS avisó que el fiat no salió. Que el release haya entrado en la cadena NO lo prueba este
//     estado: es el dicho del proveedor. La verificación on-chain la hace una persona — mismo fraseo
//     que app/api/webhooks/transfi/route.ts (la alerta es el PEDIDO de esa verificación, no su
//     veredicto).
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

// Los tres conjuntos son DISJUNTOS dos a dos y su unión es exactamente WEBHOOK_UPDATABLE_STATUSES.
// T-INV lo asserta DOS veces: contra un golden escrito a mano (fuente independiente) y contra la
// constante real importada de supabase-settlement-ledger.ts. Ese segundo assert es el que ata las dos
// definiciones: sin él —así estaba— tocar la constante no ponía rojo a ningún test que la nombre, y
// esta línea prometía un acoplamiento que no existía. Ninguno contiene el valor que se
// escribe ('failed') ni ningún otro estado terminal ⇒ una fila mutada por un UPDATE sale de todos los
// conjuntos y el orden de aplicación no puede cambiar el resultado.
export const WEBHOOK_FAILURE_CLASSES: readonly WebhookFailureClassSpec[] = [
  { failureClass: "no_principal", previousStatuses: ["prepared"], lastError: TRANSFI_FUND_FAILED_NO_PRINCIPAL },
  { failureClass: "principal_in_escrow", previousStatuses: ["principal_in", "forward_error"], lastError: TRANSFI_FUND_FAILED_PRINCIPAL_IN_ESCROW },
  { failureClass: "principal_released", previousStatuses: ["submitted"], lastError: TRANSFI_FUND_FAILED_PRINCIPAL_RELEASED },
];
