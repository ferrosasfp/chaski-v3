// Infrastructure — config de red env-driven (CD-5). ÚNICA fuente de la red para el adapter de
// WalletPort. PROHIBIDO hardcodear el cluster o el mint en un adapter y config en el otro.
import { type Cluster, clusterApiUrl, PublicKey } from "@solana/web3.js";

// ── Solana (WKH-206 / HU-SOL-1) ───────────────────────────────────────────────────
export interface SolanaNetworkConfig {
  vm: "solana";
  cluster: "devnet"; // única entrada en esta HU (mainnet-beta → HU-SOL-2/SOL-4)
  /** USDC devnet de Circle — REFERENCIA documentada. El mint REAL sale de resolveSolanaUsdcMint()
   *  (env-driven, CD-6). NO se hardcodea en el resolver. */
  canonicalUsdcMint: string;
  usdcMintEnvVar: "NEXT_PUBLIC_SOLANA_USDC_MINT";
  rpcEnvVar: "SOLANA_DEVNET_RPC_URL";
}

const SOLANA_DEVNET: SolanaNetworkConfig = {
  vm: "solana",
  cluster: "devnet",
  canonicalUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Circle USDC devnet (REFERENCIA)
  usdcMintEnvVar: "NEXT_PUBLIC_SOLANA_USDC_MINT",
  rpcEnvVar: "SOLANA_DEVNET_RPC_URL",
};

/** Config de la red Solana activa (devnet, única entrada en esta HU). */
export function resolveSolanaNetworkConfig(): SolanaNetworkConfig {
  return SOLANA_DEVNET;
}

/** Network-id CAIP-2 del cluster Solana activo (HU-SOL-8/CD-3, anti-replay cross-cluster). switch
 *  sobre el literal cluster (sin object-injection). En esta HU solo existe devnet; mainnet-beta →
 *  "solana:mainnet" cuando HU-SOL-2/SOL-4 agreguen la entrada. */
export function resolveSolanaNetworkId(): string {
  switch (resolveSolanaNetworkConfig().cluster) {
    case "devnet":
      return "solana:devnet";
    // mainnet-beta → "solana:mainnet"
    default:
      throw new Error("unsupported_solana_cluster"); // fail-loud (cluster futuro sin mapeo)
  }
}

/** Límite de compute units que Chaski DECLARA en el depósito (WKH-321 / SDD 038).
 *
 *  REGLA R-CU (la regla es el contrato, no el número):
 *      computeUnitLimit = redondeo_arriba_a_10.000( peor_CU_medido × 1,5 )
 *          sujeto a: ≤ 50 % de SOLANA_SPONSOR_MAX_COMPUTE_UNITS
 *  Con peor_CU_medido = 79.826 ⇒ 79.826 × 1,5 = 119.739 ⇒ **120.000 CU**.
 *
 *  DE DÓNDE SALE EL 79.826: es el peor caso sobre **28 corridas** de `deposit` + `register_escrow`
 *  en una sola tx, medido contra el banco in-process (rango 52.826..79.826 CU, en pasos de 1.500;
 *  la varianza es la búsqueda del bump canónico, ~1.500 CU por iteración extra de sha256).
 *  Evidencia: `solana-programs/tests/escrow-index.ts:725-731` y `solana-programs/README.md`, sección "On-chain state" (⚠️ antes se citaba `:348`, que el 2026-08-11 era una línea EN BLANCO)
 *  (la muestra publicada de 57.326 CU es UNA corrida, no el peor caso).
 *
 *  DOS HONESTIDADES QUE NO SE BORRAN AL REFACTORIZAR:
 *   - 79.826 es el peor caso **OBSERVADO** en 28 muestras, NO un máximo demostrado.
 *   - Es el peor caso de la forma **más pesada** (`deposit` + `register_escrow`). Hasta WKH-347 esa
 *     forma NO era la que Chaski emitía, así que el 79.826 entraba acá como un **proxy conservador**:
 *     el `deposit` solo consume estrictamente menos, y por eso sobreestimaba y nunca subestimaba.
 *     DESDE WKH-347 la forma combinada ES la que se emite cuando el depósito registra el escrow, así
 *     que para ese caso el 79.826 dejó de ser un proxy y pasó a ser la **medición directa**. NINGÚN
 *     número cambia por eso, y no es una omisión: el proxy ya estaba dimensionado con la forma pesada,
 *     que es exactamente la que ahora se emite. Lo que cambia es de qué es evidencia.
 *   - El `deposit` solo sigue consumiendo estrictamente menos, y sigue siendo la forma que se emite en
 *     las ramas donde no se registra (índice lleno, o sonda ilegible). Medición propia del `deposit`
 *     solo (30 simulaciones en devnet con `simulateTransaction`, remittanceId distinto en cada una):
 *     30.825..53.325 CU, también en pasos de 1.500. Ese dato ya no explica un proxy: explica el
 *     **margen** que el límite declarado le deja a la forma liviana.
 *
 *  CONTRA QUÉ TOPE SE COMPARÓ: `SOLANA_SPONSOR_MAX_COMPUTE_UNITS` = 300.000
 *  (`wasiai-facilitator/src/infra/env.ts:214`). 120.000/300.000 = **40 % de uso**, margen **2,50×**.
 *  Política de SDD 038: ningún valor emitido usa más del 50 % de su tope. El fixture pinneado
 *  (`contracts/vendored/solana-sponsor-limits.fixture.ts`) y su contract test ponen el CI en rojo si
 *  este número deja de caber.
 *
 *  LA CONTRA (modo de falla NUEVO que esto abre, dicho para que nadie lo descubra en producción):
 *  hoy Chaski no declara límite y el runtime aplica su default implícito de `200.000 × business ix`.
 *  Al declarar 120.000, si el consumo real superara ese valor la tx **entra en un bloque y falla por
 *  CU excedidos**. La plata NO se mueve (la ix es atómica), el facilitator pierde el fee base y el
 *  usuario ve un depósito fallido **reintentable**. Es un fallo benigno y recuperable, pero es un
 *  fallo que hoy no puede ocurrir. Se acepta a cambio del margen de 2,50× (declarar 200.000 usaría
 *  el 66,7 % del tope y rompería la política del 50 %).
 *
 *  POR QUÉ `switch` POR CLUSTER Y NO UNA CONSTANTE SUELTA: mainnet tiene otro mercado de fees. La
 *  forma `switch` obliga a **decidir explícitamente** el valor de mainnet el día que
 *  `SolanaNetworkConfig` sume esa entrada, en vez de heredar en silencio un número derivado para devnet.
 *
 *  POR QUÉ NO SALE DE `process.env` (decisión, no olvido): un override por env anularía el contract
 *  test. El test verifica lo que el código emite; si el valor real saliera de una env de Vercel, el
 *  CI verificaría un valor y producción emitiría otro — exactamente la desalineación que esta HU
 *  viene a cerrar. Estos dos números son **derivados de una medición**, no configuración de
 *  despliegue: cambiarlos exige re-derivar, y re-derivar exige un PR. */
export function resolveSolanaComputeUnitLimit(): number {
  switch (resolveSolanaNetworkConfig().cluster) {
    case "devnet":
      return 120_000;
    // mainnet-beta → re-derivar con R-CU contra el mercado de fees de mainnet
    default:
      throw new Error("unsupported_solana_cluster"); // fail-loud (cluster futuro sin mapeo)
  }
}

/** Precio por compute unit, en microlamports, que Chaski DECLARA en el depósito (WKH-321 / SDD 038).
 *
 *  REGLA R-PRICE:
 *      computeUnitPrice = (propina_objetivo_lamports × 1.000.000) / computeUnitLimit
 *          con propina_objetivo = 1.000 lamports (~0,000001 SOL)
 *          sujeto a: ≤ 50 % de SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS
 *  1.000 × 1e6 / 120.000 = 8.333 ⇒ redondeado arriba a la decena de millar ⇒ **10.000 µL/CU**.
 *  Propina real resultante: `ceil(120.000 × 10.000 / 1e6)` = **1.200 lamports**.
 *
 *  POR QUÉ LA PROPINA ES BAJA: el depósito **no compite** por block space (no hay MEV, no hay
 *  carrera contra otra tx), y el fee lo **paga el facilitator, no el usuario**. Una propina alta
 *  transfiere costo justo a la billetera que los tres topes del sponsor existen para proteger.
 *
 *  CONTRA QUÉ TOPE SE COMPARÓ: `SOLANA_SPONSOR_MAX_PRIORITY_FEE_MICROLAMPORTS` = 50.000
 *  (`wasiai-facilitator/src/infra/env.ts:215`), que es el tope **por unidad** — distinto del tope
 *  agregado `SOLANA_SPONSOR_MAX_FEE_LAMPORTS` = 100.000. Confundir esos dos es lo que dejó pasar el
 *  bug que esta HU cierra: la billetera inyectaba 375.000 µL/CU (7,5× el tope por unidad) mientras el
 *  fee total quedaba cómodo bajo el tope agregado. 10.000/50.000 = **20 % de uso**, margen 5,00×.
 *
 *  Mismo criterio que el límite: `switch` por cluster (mainnet se decide, no se hereda) y NO se lee
 *  de `process.env` (un override por env verificaría un valor en CI y emitiría otro en producción). */
export function resolveSolanaComputeUnitPriceMicroLamports(): number {
  switch (resolveSolanaNetworkConfig().cluster) {
    case "devnet":
      return 10_000;
    // mainnet-beta → re-derivar con R-PRICE contra el mercado de fees de mainnet
    default:
      throw new Error("unsupported_solana_cluster"); // fail-loud (cluster futuro sin mapeo)
  }
}

/** Mint USDC Solana — ÚNICA fuente (env NEXT_PUBLIC_SOLANA_USDC_MINT); fail-loud si falta/malformado.
 *  Valida con PublicKey de @solana/web3.js (base58), NUNCA con un validador hexadecimal (CD-2/CD-6). */
export function resolveSolanaUsdcMint(): string {
  const raw = process.env.NEXT_PUBLIC_SOLANA_USDC_MINT;
  if (!raw) throw new Error("solana_usdc_mint_not_configured"); // fail-loud
  try {
    new PublicKey(raw); // lanza TypeError si no es base58 válido
  } catch {
    throw new Error("solana_usdc_mint_not_configured"); // fail-loud
  }
  return raw;
}

/** Pubkey del facilitator Solana (feePayer). ÚNICA fuente (env NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY);
 *  fail-loud si falta/malformado. Valida con PublicKey (base58), NUNCA con un validador hexadecimal
 *  (CD-SDD-7). */
export function resolveSolanaFacilitatorPubkey(): string {
  const raw = process.env.NEXT_PUBLIC_SOLANA_FACILITATOR_PUBKEY;
  if (!raw) throw new Error("solana_facilitator_not_configured"); // fail-loud
  try {
    new PublicKey(raw); // lanza si no es base58 válido
  } catch {
    throw new Error("solana_facilitator_not_configured"); // fail-loud
  }
  return raw;
}

/** Pubkey de la RELEASE-AUTHORITY del escrow Solana no-custodial (HU-SOL-9 / WKH-208). ÚNICA fuente
 *  (env SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY); fail-loud si falta/malformado. Valida con PublicKey
 *  (base58), NUNCA con un validador hexadecimal (CD-2). Devuelve el `raw` base58, JAMÁS derivado del
 *  body (CD-3/CD-9). La keypair PRIVADA que firma el release es founder-gated y NO vive en chaski
 *  (firma = HU-SOL-13); esta HU sólo conoce el PUBKEY. Invariante consumido por HU-SOL-13:
 *  SolanaDepositAttestation.authority === resolveSolanaReleaseAuthorityPubkey() === deposit.escrow.authority. */
export function resolveSolanaReleaseAuthorityPubkey(): string {
  const raw = process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY;
  if (!raw) throw new Error("solana_release_authority_not_configured"); // fail-loud
  try {
    new PublicKey(raw); // lanza si no es base58 válido
  } catch {
    throw new Error("solana_release_authority_not_configured"); // fail-loud
  }
  return raw;
}

/** RPC READ-ONLY de Solana devnet (server-only). undefined si la env no está → el caller fail-closea. */
export function resolveSolanaRpcUrl(): string | undefined {
  switch (resolveSolanaNetworkConfig().rpcEnvVar) {
    case "SOLANA_DEVNET_RPC_URL":
      return process.env.SOLANA_DEVNET_RPC_URL;
  }
}

/** RPC público CLIENT-SAFE de Solana (AR-MNR-2). A diferencia de resolveSolanaRpcUrl() (server-only,
 *  env NO-`NEXT_PUBLIC`), este corre en el bundle browser: lee `NEXT_PUBLIC_SOLANA_RPC_URL` y hace
 *  fallback al endpoint público de la lib (`clusterApiUrl(cluster)`) si la env no está. Fail-soft:
 *  NUNCA throwea por RPC ausente — el fallback siempre cubre. Se usa sólo para leer blockhash. */
export function resolveSolanaRpcUrlPublic(cluster: Cluster): string {
  return process.env.NEXT_PUBLIC_SOLANA_RPC_URL || clusterApiUrl(cluster);
}

// ── WKH-346 — el enlace del comprobante al visor de transacciones ────────────────────────────────

/** Base del visor de transacciones, y NADA MÁS que la base: la red NO va pegada acá.
 *
 *  POR QUÉ NO SALE DE `process.env` (decisión, no olvido): esto es el VISOR, no la red. Qué sitio se
 *  le ofrece a la persona para auditar su transacción es una decisión de producto fija en código, y
 *  vale el mismo criterio que los dos resolvers de ComputeBudget de arriba: un override por env
 *  verificaría un dominio en CI y emitiría otro en producción. Lo que sí es configuración de red es
 *  el cluster, y por eso el `?cluster=` NO está en este literal sino en la rama del `switch` de abajo,
 *  que la config elige. Pegarlos en un solo string es el hardcode de red que este repo prohíbe. */
const SOLANA_EXPLORER_TX_BASE = "https://explorer.solana.com/tx";

/** URL del visor para UNA firma de transacción, con el cluster derivado de la config activa
 *  (WKH-346 / AC-2). Formato ya usado por el repo en `scripts/smoke-solana-e2e.ts:567` y `:658`.
 *
 *  ⚠️ ESTA FUNCIÓN NO VALIDA LA FIRMA, y no es un olvido. Las **tres** vecinas de este archivo validan base58 con `new PublicKey(raw)`, y son éstas: `:133`, `:147`, `:164` (AR/MNR-1 — acá decía "cuatro", filtrado de los `default:`, que sí son cuatro y también van enumerados: `:37`, `:91`, `:122`, `:224`). NO va acá cuántas veces aparece el TEXTO `new PublicKey(` en el archivo, y el motivo está medido: un grep cuenta también las menciones de este propio comentario, así que ese total se desalinea con sólo editar el comentario. Ya pasó (QA, 10-ago): la versión anterior de esta línea daba un total y estaba mal por auto-mención. La defensa que sí aguanta es la de al lado: enumerar los sitios en vez de contarlos, que es exactamente por qué la afirmación sobre los `default:` sobrevivió a la misma trampa.
 *  Copiar ese patrón acá rechazaría el **100 % de las firmas reales**: `PublicKey` exige 32 bytes y una firma ed25519 son 64, que en base58 miden **87 u 88 caracteres, y 88 en la mayoría de los casos** (AR/MNR-2 — acá decía "87" a secas, como si fuera propiedad de una firma).
 *  Medido acá con el `bs58` del repo, 4000 valores aleatorios de 64 bytes: **3209 dieron 88 (80,2 %) y 791 dieron 87 (19,8 %)**. El largo depende del primer byte: con `1` da 87 y con `255` da 88.
 *  Los **87** de `FAKE_SOLANA_SIGNATURE` (`fakes.ts:835`) son propiedad **del fixture** —es `new Uint8Array(64).fill(7)`—, no de "una firma", y por eso los sitios que lo usan ahora dicen "los 87 de `FAKE_SOLANA_SIGNATURE`" en vez de generalizar.
 *  Además esto es presentación: una firma rara tiene que MOSTRARSE tal como la cadena la devolvió, no desaparecer detrás de un guard. Lo único que se le hace al valor es `encodeURIComponent`, igual que `phantomBrowseUrl` (`wallet-availability.ts:27`).
 *
 *  🔴 EL AGUJERO QUE ESTA FORMA NO CIERRA, escrito al lado del código y no sólo en el SDD.
 *  Reemplazar este `switch` por la URL con el cluster pegado en un solo literal **no lo mata ningún
 *  test**: el día que la config sea mainnet el enlace seguiría apuntando a devnet **en silencio**, y
 *  la pantalla diría "transacción no encontrada" sobre plata que sí se movió. Es el mismo agujero que
 *  `chain.test.ts:86-89` documenta para sus dos hermanas ("un assert que llamara al propio resolver
 *  se movería junto con el mutante y pasaría siempre"). Lo que lo contiene es que el `switch` **tire**
 *  en cuanto haya un segundo cluster, no un assert. Este mutante no tiene test y no lo puede tener.
 *
 *  🔴 Y LA MEDIA FRASE QUE FALTABA: QUÉ SE LLEVA PUESTO EL `throw` (AR/MNR-5). Esta función es la ÚNICA de las cuatro con `default: throw` de este archivo que corre en **posición de atributo JSX**: `href={resolveSolanaExplorerTxUrl(signature)}` (`resolveSolanaExplorerTxUrl`, `flow.tsx:3582`). Las otras tres corren fuera de render ((`resolveSolanaNetworkId`, `solana-wallet.ts:1140`), en 6 rutas de `app/api/**` y en el ledger; (`resolveSolanaComputeUnitLimit`, `solana-wallet.ts:675`); (`resolveSolanaComputeUnitPriceMicroLamports`, `solana-wallet.ts:678`)), así que ahí un `throw` **rechaza una operación**. Acá **desmonta el árbol de React**, y medido: en esta app NO hay ningún error boundary que lo atrape (cero `error.tsx`, cero `global-error.tsx`, cero `componentDidCatch`, cero `getDerivedStateFromError`) ⇒ el costo es **la pantalla en blanco**, no una operación rechazada. ⛔ Eso NO es razón para envolver esto en un `try` ni para devolver un fallback: un fallback silencioso pintaría un enlace a la red equivocada, que es exactamente el modo de falla de arriba. Es una razón más para **DECIDIR** el valor de mainnet cuando llegue, en vez de heredarlo. Hoy no es bug vivo: `cluster` es el tipo literal `"devnet"` (`:8`), TypeScript estrecha el `switch` y el `default` es inalcanzable. */
export function resolveSolanaExplorerTxUrl(signature: string): string {
  const tx = `${SOLANA_EXPLORER_TX_BASE}/${encodeURIComponent(signature)}`;
  switch (resolveSolanaNetworkConfig().cluster) {
    case "devnet":
      return `${tx}?cluster=devnet`;
    // mainnet-beta → se DECIDE el parámetro (`?cluster=mainnet-beta`, o ninguno: es el default del
    // visor). No se hereda en silencio el de devnet, que es exactamente el modo de falla de arriba.
    default:
      throw new Error("unsupported_solana_cluster"); // fail-loud (cluster futuro sin mapeo)
  }
}
