// Contrato del BORDE con el agente de verificación de identidad (WKH-233).
//
// 📌 CONTRA QUÉ SE ESCRIBIÓ: `wasiai-remittance-agents`, HEAD `8ea5afe`, leído el 2026-08-19
//    (`src/agents/kyc-validator.ts` — `KycSessionInputSchema`, `KycSessionOutput`,
//     `KycDecisionOutput`, `isStatusPayoutAllowed`). Si el borde cambia, el próximo tiene que saber
//    contra qué HEAD se midió esto para poder comparar.
//
// 🔴 POR QUÉ ESTOS TIPOS SE DECLARAN ACÁ Y NO SE IMPORTAN. Son DOS REPOSITORIOS distintos y no hay
// ningún paquete compartido entre ellos: no existe un `import` posible. Declararlos acá es la forma
// honesta de decir "esto es lo que ESTE repo cree que el otro devuelve". Lo que lo mantiene alineado
// no es el compilador —no puede—: es que el adapter estreche la respuesta en runtime
// (`agent-kyc-client.ts`) en vez de castearla. Un `as KycAgentDecisionOutput` sobre un `unknown`
// convertiría este archivo en una declaración de fe.
//
// ⛔ PROHIBIDO agregar acá un campo que el agente no devuelva. Un campo optimista en un tipo de borde
// es indistinguible de uno real para quien lo lee, y el compilador lo bendice.

/**
 * Salida de `POST {base}/api/agents/<agente>/session` — EXACTAMENTE CUATRO claves.
 *
 * 🔴 `decisionToken` ES UNA CREDENCIAL BEARER y NO VENCE NUNCA (decisión medida del otro repo, ver
 * el bloque "POR QUÉ EL TOKEN NO VENCE" de su `src/auth/decision-token.ts`). Nunca sale de este
 * servidor: no va a ninguna respuesta HTTP, ni a un log, ni a `localStorage`, ni a una URL (CD-20).
 * Se persiste server-side en `kyc_session_tokens` y se lee owner-scoped.
 */
export interface KycAgentSessionOutput {
  sessionId: string;
  url: string;
  decisionToken: string;
  /** Etiqueta CRUDA del origen. ⛔ Chaski NO la juzga: el juicio es `payoutAllowed` (DT-5'). */
  provenance: string;
}

/**
 * Salida de `GET {base}/api/agents/<agente>/decision` — OCHO claves, más `identityMatches` que
 * aparece SÓLO si el pedido llevó `identityClaim`.
 *
 * 🔴 `identityMatches` ES OPCIONAL DE VERDAD: LA CLAVE SE OMITE, no viene `false`. El otro repo lo
 * decidió así a propósito y su docblock lo dice: un `false` AFIRMARÍA que la identidad no coincide,
 * que es distinto de "no se preguntó". ⛔ PROHIBIDO normalizarlo con `?? false` en ningún consumidor
 * (CD-3): ausente ≠ `false` ≠ `true`, y el primero es un defecto NUESTRO (no mandamos el claim), no
 * un veredicto sobre la persona.
 *
 * 🔴 `verificationId` ES EL `sessionId` QUE SE PIDIÓ (el otro repo lo marca `verificationId, //
 * canónico = el PEDIDO`). Por eso `kyc_verdicts.verification_id` sigue sirviendo como llave del
 * money-path sin migrarla.
 *
 * ⚠️ NO HAY NINGÚN DATO DE IDENTIDAD ACÁ, y no es un olvido: el agente no devuelve nombre, apellidos,
 * tipo ni número de documento —tampoco sus últimos 4—. ⇒ `KycVerification.identity` va a ser siempre
 * `null` por este camino. Es lo que obligó a rediseñar `IdentityBadge` (D-2).
 */
export interface KycAgentDecisionOutput {
  terminal: boolean;
  status: string;
  approved: boolean;
  riskLevel: "low" | "medium" | "high";
  verificationId: string;
  /** CRUDA. La allow-list de "verificaciones reales" vive en el agente, no acá (D-3). */
  provenance: string;
  /**
   * 🔴 EL ÚNICO GATE DEL DESEMBOLSO (DT-5'). Por construcción de `isStatusPayoutAllowed` significa:
   * aprobado ∧ hubo reclamo de identidad ∧ la identidad COINCIDE ∧ la proveniencia está en la
   * allow-list de verificaciones REALES del agente. Es MÁS que lo que Chaski juzgaba por su cuenta.
   * ⛔ PROHIBIDO que Chaski recomponga ese criterio con `approved && identityMatches`: eso sería
   * re-implementar el juicio de KYC, o sea exactamente lo que WKH-233 existe para borrar.
   */
  payoutAllowed: boolean;
  /** Etiquetas de rama value-free del agente. Nunca PII. */
  reasons: string[];
  identityMatches?: boolean;
}
