// Infrastructure — chain env-driven (M1/AC-7, CD-5). ÚNICA fuente del chainId para AMBOS
// adapters de WalletPort (InjectedWallet + WalletConnectWallet). PROHIBIDO hardcodear el
// chainId en un adapter y config en el otro.
import { type Chain, isAddress } from "viem";
import { base, baseSepolia } from "viem/chains";

const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_MAINNET_CHAIN_ID = 8453;

/** Config estable por red (NO secreta, NO env-editable para name/version — DT-3). El `eip712`
 *  coincide con el DOMAIN_SEPARATOR on-chain real (verificado, wasiai-facilitator/chains/base.ts). */
export type NetworkConfig = {
  chainId: number;
  viemChain: Chain;
  /** USDC canónico de Circle en esta red — REFERENCIA documentada (DT-4). El verifyingContract real
   *  de la firma sigue saliendo de resolveUsdcAddress() (env-driven). Usado en tests de consistencia. */
  canonicalUsdc: `0x${string}`;
  /** Domain EIP-712: DEBE matchear el contrato on-chain (CD-4). Sepolia="USDC", mainnet="USD Coin". */
  eip712: { name: string; version: string };
  rpcEnvVar: "BASE_SEPOLIA_RPC_URL" | "BASE_MAINNET_RPC_URL";
};

const NETWORKS: Record<typeof BASE_SEPOLIA_CHAIN_ID | typeof BASE_MAINNET_CHAIN_ID, NetworkConfig> = {
  [BASE_SEPOLIA_CHAIN_ID]: {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    viemChain: baseSepolia,
    canonicalUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    eip712: { name: "USDC", version: "2" }, // ← Hallazgo F0: testnet usa "USDC", NO "USD Coin"
    rpcEnvVar: "BASE_SEPOLIA_RPC_URL",
  },
  [BASE_MAINNET_CHAIN_ID]: {
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
