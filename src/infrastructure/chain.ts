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
