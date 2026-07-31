// WKH-320 — guard de configuración residual EVM. Se llama como PRIMERA línea de createContainer().
//
// CD-16 (la razón, no el capricho): cada env se lee como MEMBER EXPRESSION LITERAL, una por línea.
// Next inlinea `process.env.NEXT_PUBLIC_X` en el bundle del cliente SÓLO si aparece como acceso
// estático. Un `for (const k of NAMES) process.env[k]` NO se inlinea ⇒ en el browser da `undefined`
// siempre ⇒ el guard NO PUEDE FALLAR NUNCA, o sea que no es un guard. Mismo patrón que el switch
// sobre la unión literal de chain.ts (pre-WKH-320).
//
// Alcance HONESTO (DT-13): sólo las NEXT_PUBLIC_*, que son las que el container puede observar donde
// corre. BASE_SEPOLIA_RPC_URL, BASE_MAINNET_RPC_URL y SETTLE_ATTESTATION_SECRET son server-only: el
// container del cliente jamás las ve, y meterlas acá daría un check que nunca puede dispararse. Un
// control que no puede fallar es peor que no tenerlo. Van al done-report como acción de ops.
//
// El mensaje lleva NOMBRES de variables, JAMÁS valores.
export function assertNoEvmResidue(): void {
  const residue: string[] = [];
  if (process.env.NEXT_PUBLIC_VM) residue.push("NEXT_PUBLIC_VM");
  if (process.env.NEXT_PUBLIC_EIP3009_ENABLED) residue.push("NEXT_PUBLIC_EIP3009_ENABLED");
  if (process.env.NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS) residue.push("NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS");
  if (process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS) residue.push("NEXT_PUBLIC_USDC_CONTRACT_ADDRESS");
  if (process.env.NEXT_PUBLIC_CHAIN_ID) residue.push("NEXT_PUBLIC_CHAIN_ID");
  if (process.env.NEXT_PUBLIC_REOWN_PROJECT_ID) residue.push("NEXT_PUBLIC_REOWN_PROJECT_ID");
  if (residue.length > 0) {
    throw new Error(`evm_config_residue: ${residue.join(", ")}`); // nombres, NUNCA valores
  }
}
