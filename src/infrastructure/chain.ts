// Infrastructure — chain env-driven (M1/AC-7, CD-5). ÚNICA fuente del chainId para AMBOS
// adapters de WalletPort (InjectedWallet + WalletConnectWallet). PROHIBIDO hardcodear el
// chainId en un adapter y config en el otro.
import { type Chain, isAddress } from "viem";
import { base, baseSepolia } from "viem/chains";
import { PublicKey } from "@solana/web3.js";

const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_MAINNET_CHAIN_ID = 8453;

/** Config estable por red (NO secreta, NO env-editable para name/version — DT-3). El `eip712`
 *  coincide con el DOMAIN_SEPARATOR on-chain real (verificado, wasiai-facilitator/chains/base.ts). */
export type NetworkConfig = {
  vm: "evm";
  chainId: number;
  viemChain: Chain;
  /** USDC canónico de Circle en esta red — REFERENCIA documentada (DT-4). El verifyingContract real
   *  de la firma sigue saliendo de resolveUsdcAddress() (env-driven). Usado en tests de consistencia. */
  canonicalUsdc: `0x${string}`;
  /** Domain EIP-712: DEBE matchear el contrato on-chain (CD-4). Sepolia="USDC", mainnet="USD Coin". */
  eip712: { name: string; version: string };
  rpcEnvVar: "BASE_SEPOLIA_RPC_URL" | "BASE_MAINNET_RPC_URL";
};

export type EvmNetworkConfig = NetworkConfig; // alias de compat (discriminante vm:"evm")

const NETWORKS: Record<typeof BASE_SEPOLIA_CHAIN_ID | typeof BASE_MAINNET_CHAIN_ID, NetworkConfig> = {
  [BASE_SEPOLIA_CHAIN_ID]: {
    vm: "evm",
    chainId: BASE_SEPOLIA_CHAIN_ID,
    viemChain: baseSepolia,
    canonicalUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    eip712: { name: "USDC", version: "2" }, // ← Hallazgo F0: testnet usa "USDC", NO "USD Coin"
    rpcEnvVar: "BASE_SEPOLIA_RPC_URL",
  },
  [BASE_MAINNET_CHAIN_ID]: {
    vm: "evm",
    chainId: BASE_MAINNET_CHAIN_ID,
    viemChain: base,
    canonicalUsdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    eip712: { name: "USD Coin", version: "2" },
    rpcEnvVar: "BASE_MAINNET_RPC_URL",
  },
};

/** Deriva el chainId de NEXT_PUBLIC_CHAIN_ID. Solo Base mainnet (8453) / Sepolia (84532); unset o
 *  cualquier otra cosa → 84532 (Base Sepolia, fail-safe testnet — DT-5: jamás mainnet real). */
export function resolveChainId(): number {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return n === BASE_MAINNET_CHAIN_ID ? BASE_MAINNET_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID;
}

/** NetworkConfig de la red activa (acceso por clave literal — CD-7, sin object-injection). */
export function resolveNetworkConfig(): NetworkConfig {
  return resolveChainId() === BASE_MAINNET_CHAIN_ID
    ? NETWORKS[BASE_MAINNET_CHAIN_ID]
    : NETWORKS[BASE_SEPOLIA_CHAIN_ID];
}

/** El objeto Chain de viem de la red activa (CD-9: derivado de la lib). */
export function resolveChain(): Chain {
  return resolveNetworkConfig().viemChain;
}

/** RPC READ-ONLY de la red activa (server-only). `switch` sobre la unión literal (patrón
 *  wasiai-facilitator readRpcUrl — CD-7). undefined si la env no está → el caller fail-closea (V1). */
export function resolveRpcUrl(): string | undefined {
  switch (resolveNetworkConfig().rpcEnvVar) {
    case "BASE_SEPOLIA_RPC_URL":
      return process.env.BASE_SEPOLIA_RPC_URL;
    case "BASE_MAINNET_RPC_URL":
      return process.env.BASE_MAINNET_RPC_URL;
  }
}

/** Dirección del contrato USDC para la firma EIP-3009 (WKH-186/DT-10, CD-14/CD-16). ÚNICA fuente
 * (env `NEXT_PUBLIC_USDC_CONTRACT_ADDRESS`); fail-loud si falta o está malformada — NUNCA se
 * hardcodea el contrato (el `.env.example` documenta el USDC canónico de Circle por chain como
 * comentario). Sólo se llama en la rama EIP-3009 real, ya gateada por el guard del container. */
export function resolveUsdcAddress(): `0x${string}` {
  const raw = process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS;
  if (!raw || !isAddress(raw)) throw new Error("usdc_contract_not_configured"); // fail-loud
  return raw;
}

/** Dirección del RECEIVER del payout (destino de la firma EIP-3009, WKH-186/MNR-A). Simétrico con
 * `resolveUsdcAddress`: ÚNICA fuente (env `NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS`); fail-loud si falta
 * o está MALFORMADA (`isAddress`). Antes se tomaba con `as \`0x${string}\`` crudo → un typo con
 * checksum válido firmaría al destino equivocado. Se usa en el guard del container (la app NO arranca
 * con un receiver malformado cuando EIP-3009 está on) y en wallet.ts (en lugar del cast crudo). */
export function resolveReceiverAddress(): `0x${string}` {
  const raw = process.env.NEXT_PUBLIC_PAYOUT_RECEIVER_ADDRESS;
  if (!raw || !isAddress(raw)) throw new Error("payout_receiver_not_configured"); // fail-loud
  return raw;
}

// ── Solana (WKH-206 / HU-SOL-1) — config devnet paralela, NO reemplaza EVM ────────
export interface SolanaNetworkConfig {
  vm: "solana";
  cluster: "devnet"; // única entrada en esta HU (mainnet-beta → HU-SOL-2/SOL-4)
  /** USDC devnet de Circle — REFERENCIA documentada (análogo a canonicalUsdc EVM). El mint REAL sale
   *  de resolveSolanaUsdcMint() (env-driven, CD-6). NO se hardcodea en el resolver. */
  canonicalUsdcMint: string;
  usdcMintEnvVar: "NEXT_PUBLIC_SOLANA_USDC_MINT";
  rpcEnvVar: "SOLANA_DEVNET_RPC_URL";
}
export type VmNetworkConfig = EvmNetworkConfig | SolanaNetworkConfig;

const SOLANA_DEVNET: SolanaNetworkConfig = {
  vm: "solana",
  cluster: "devnet",
  canonicalUsdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // Circle USDC devnet (REFERENCIA)
  usdcMintEnvVar: "NEXT_PUBLIC_SOLANA_USDC_MINT",
  rpcEnvVar: "SOLANA_DEVNET_RPC_URL",
};

/** VM activa. Env ORTOGONAL a NEXT_PUBLIC_CHAIN_ID (que sigue siendo EVM-only). unset/"" → "evm"
 *  (fail-safe default, CD-SDD-12: ningún deploy existente cambia de VM por omisión). Un valor
 *  explícito inválido → throw (fail-loud, AC-6). */
export function resolveActiveVm(): "evm" | "solana" {
  const raw = process.env.NEXT_PUBLIC_VM;
  if (!raw || raw === "evm") return "evm";
  if (raw === "solana") return "solana";
  throw new Error("unsupported_vm"); // fail-loud (AC-6)
}

/** Config de la red Solana activa (devnet, única entrada en esta HU). */
export function resolveSolanaNetworkConfig(): SolanaNetworkConfig {
  return SOLANA_DEVNET;
}

/** Mint USDC Solana — ÚNICA fuente (env NEXT_PUBLIC_SOLANA_USDC_MINT); fail-loud si falta/malformado.
 *  Valida con PublicKey de @solana/web3.js (base58), NUNCA con isAddress de viem (CD-2/CD-6). */
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

/** RPC READ-ONLY de Solana devnet (server-only). Paralelo a resolveRpcUrl. undefined si la env no está. */
export function resolveSolanaRpcUrl(): string | undefined {
  switch (resolveSolanaNetworkConfig().rpcEnvVar) {
    case "SOLANA_DEVNET_RPC_URL":
      return process.env.SOLANA_DEVNET_RPC_URL;
  }
}

/** Dispatcher multi-VM (AC-2/AC-6). switch sobre resolveActiveVm() — sin object-injection (CD-7). */
export function resolveActiveNetworkConfig(): VmNetworkConfig {
  switch (resolveActiveVm()) {
    case "evm":
      return resolveNetworkConfig(); // reusa el resolver EVM INTACTO
    case "solana":
      return resolveSolanaNetworkConfig();
    default:
      throw new Error("unsupported_vm"); // inalcanzable (resolveActiveVm ya throwea), defensa AC-6
  }
}
