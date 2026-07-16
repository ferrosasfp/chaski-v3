// Infrastructure — WalletPort. InjectedWallet (REAL, abre MetaMask via viem) + FallbackWallet (demo).
// pickWallet() usa la real si hay wallet inyectada, si no la simulada (para que el demo corra igual).
import { createWalletClient, custom, isAddress, keccak256, toBytes, toHex } from "viem";
import type { Eip3009Authorization, WalletPort } from "../application/ports";
import type { Quote } from "../domain/remittance";
import { isParseableIso } from "../domain/remittance";
import { resolveChain, resolveChainId, resolveReceiverAddress, resolveUsdcAddress } from "./chain";

// EIP-712 types de transferWithAuthorization (EIP-3009). Compartido por ambos wallets reales.
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** ¿Encender la firma REAL EIP-3009? Flag OFF por default (WKH-186/AC-9). El guard del container
 * (AC-11) ya garantizó adapter=a2a + receiver + usdc ANTES de construir cualquier wallet. */
function eip3009Enabled(): boolean {
  return process.env.NEXT_PUBLIC_EIP3009_ENABLED === "true";
}

/** Nonce EIP-3009 DETERMINÍSTICO por (remittanceId, quoteId) — CD-19 (WKH-168/DT-6).
 *
 * El nonce ERA aleatorio (32 bytes de CSPRNG) y se DESCARTABA: la firma se retenía y nadie la
 * transmitía. Con un nonce aleatorio, un settle con respuesta ambigua (timeout) + reintento = una
 * autorización NUEVA = el usuario PAGA DOS VECES. Determinístico: el contrato USDC marca
 * authorizationState[from][nonce] → el 2º settle de la MISMA autorización REVIERTE ⇒ doble-pago
 * IMPOSIBLE a nivel CONTRATO, no a nivel convención.
 *
 * El nonce NO es secreto (EIP-3009 solo exige unicidad por (from, nonce)) y sin la firma es inútil
 * para un tercero. remittanceId es único (CryptoIds). */
function deterministicNonce(remittanceId: string, quoteId: string): `0x${string}` {
  return keccak256(toBytes(`${remittanceId}:${quoteId}`));
}

/** Address de la FallbackWallet demo. Fuente ÚNICA del literal (CD-4, WKH-184):
 *  ningún otro archivo re-hardcodea este string — presentación/helpers lo importan. */
export const FALLBACK_WALLET_ADDRESS = "0xDEMO00000000000000000000000000000A11ce";

// biome-ignore lint/suspicious/noExplicitAny: provider EIP-1193 inyectado (window.ethereum)
function injectedProvider(): any {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: unknown }).ethereum;
}

/** REAL — usa la wallet inyectada (MetaMask/Rabby/etc.). connect() abre el modal de la wallet. */
export class InjectedWallet implements WalletPort {
  private address: `0x${string}` | null = null;

  async connect(): Promise<string> {
    const eth = injectedProvider();
    if (!eth) throw new Error("no_wallet");
    const client = createWalletClient({ chain: resolveChain(), transport: custom(eth) });
    const [addr] = await client.requestAddresses(); // eth_requestAccounts → abre la wallet
    if (!addr) throw new Error("no_account");
    if (!isAddress(addr)) throw new Error("invalid_address"); // AC-9: address EVM bien formada
    // AC-8: chainId de la sesión debe coincidir con el configurado; switch SUAVE si difiere.
    const chainId = await client.getChainId();
    if (chainId !== resolveChainId()) {
      try {
        await client.switchChain({ id: resolveChainId() });
      } catch {
        throw new Error("wrong_chain");
      }
    }
    this.address = addr;
    return addr;
  }

  async getAddress(): Promise<string | null> {
    return this.address;
  }

  async authorizePrincipal(
    quote: Quote,
    remittanceId: string,
  ): Promise<{ tx: string; eip3009?: { authorization: Eip3009Authorization; signature: string } }> {
    const eth = injectedProvider();
    if (!eth || !this.address) throw new Error("wallet_not_connected");
    if (!isAddress(this.address)) throw new Error("invalid_address"); // AC-9: antes de firmar
    const client = createWalletClient({ chain: resolveChain(), transport: custom(eth) });
    if (eip3009Enabled()) {
      // AC-10: firma REAL de transferWithAuthorization (EIP-712). value = quote.send.minor (micro-USDC
      // = base units EIP-3009, cero floats). validBefore atado a la expiración del quote.
      const usdc = resolveUsdcAddress();
      const receiver = resolveReceiverAddress(); // MNR-A: valida isAddress fail-loud (no cast crudo)
      const nonce = deterministicNonce(remittanceId, quote.quoteId); // CD-19: NO random (WKH-168)
      if (!isParseableIso(quote.expiresAt)) throw new Error("quote_expires_at_invalid"); // WKH-198 AC-5 (CD-8: fail LOUD)
      const validBefore = BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000));
      const sig = await client.signTypedData({
        account: this.address,
        domain: { name: "USD Coin", version: "2", chainId: resolveChainId(), verifyingContract: usdc },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: this.address,
          to: receiver,
          value: BigInt(quote.send.minor),
          validAfter: 0n,
          validBefore,
          nonce,
        },
      });
      // WKH-168/CD-16: la serialización bigint → string decimal canónico se hace ACÁ (donde se firma).
      // JAMÁS JSON.stringify sobre un bigint (TypeError). Money.minor es entero → String() es seguro.
      return {
        tx: sig,
        eip3009: {
          signature: sig,
          authorization: {
            from: this.address,
            to: receiver,
            value: String(quote.send.minor),
            validAfter: "0",
            validBefore: validBefore.toString(),
            nonce,
          },
        },
      };
    }
    // DEMO (default): firma un MENSAJE (prompt real de la wallet). Byte-idéntico a hoy (AC-9).
    const sig = await client.signMessage({
      account: this.address,
      message: `Chaski · autorizo enviar ${quote.send.format()} (remesa ${quote.quoteId})`,
    });
    return { tx: sig };
  }

  // WKH-206: firma el popMessage con la wallet real (personal_sign vía viem).
  async signMessage(message: string): Promise<string> {
    const eth = injectedProvider();
    if (!eth || !this.address) throw new Error("wallet_not_connected");
    const client = createWalletClient({ chain: resolveChain(), transport: custom(eth) });
    return client.signMessage({ account: this.address, message });
  }
}

/** Demo — simula conectar + firmar (sin wallet real). Se usa si no hay wallet inyectada. */
export class FallbackWallet implements WalletPort {
  private address: string | null = null;
  async connect(): Promise<string> {
    await new Promise((r) => setTimeout(r, 400));
    this.address = FALLBACK_WALLET_ADDRESS;
    return this.address;
  }
  async getAddress(): Promise<string | null> {
    return this.address;
  }
  async authorizePrincipal(_quote: Quote): Promise<{ tx: string }> {
    return { tx: `0xdemo${Date.now().toString(16)}` };
  }
  // WKH-206: firma fake demo (no toca red — mismo espíritu que authorizePrincipal).
  async signMessage(_message: string): Promise<string> {
    return `0xdemosig${Date.now().toString(16)}`;
  }
}

// EIP-1193 mínimo que expone el provider de WalletConnect (lo que usamos).
interface WcProvider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  connect(): Promise<void>;
  accounts: string[];
}

/** REAL vía WalletConnect — para navegadores móviles normales (Safari/Chrome): abre modal/deep-link
 * a la wallet instalada en el cel. connect() dispara el deep-link; la lib mantiene la sesión. */
export class WalletConnectWallet implements WalletPort {
  private address: `0x${string}` | null = null;
  private provider: WcProvider | null = null;

  constructor(private readonly projectId: string) {}

  private async ensureProvider(): Promise<WcProvider> {
    if (this.provider) return this.provider;
    // Lazy-import: la lib de WC es pesada y usa APIs del browser → solo se carga en el cliente.
    const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
    const p = await EthereumProvider.init({
      projectId: this.projectId,
      chains: [resolveChainId()], // Avalanche (AC-7/CD-5: única fuente env-driven)
      showQrModal: true, // QR en desktop, deep-link a la wallet en móvil
      qrModalOptions: { themeMode: "light" }, // evita el modal negro-sobre-negro
      metadata: {
        name: "Chaski",
        description: "Envía USDC a Perú, sin vueltas",
        url: typeof window !== "undefined" ? window.location.origin : "https://chaski-v2.vercel.app",
        icons: [],
      },
    });
    this.provider = p as unknown as WcProvider;
    return this.provider;
  }

  async connect(): Promise<string> {
    const provider = await this.ensureProvider();
    await provider.connect(); // abre el modal WC / deep-link a la wallet del cel
    const addr = provider.accounts?.[0];
    if (!addr) throw new Error("no_account");
    if (!isAddress(addr)) throw new Error("invalid_address"); // AC-9: address EVM bien formada
    // AC-8: chainId de la sesión debe coincidir; switch SUAVE (wallet_switchEthereumChain) si difiere.
    const hex = (await provider.request({ method: "eth_chainId" })) as string;
    const chainId = Number.parseInt(hex, 16);
    if (chainId !== resolveChainId()) {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: toHex(resolveChainId()) }], // CD-9: toHex de viem, no literal a mano
        });
      } catch {
        throw new Error("wrong_chain");
      }
    }
    this.address = addr as `0x${string}`;
    return this.address;
  }

  async getAddress(): Promise<string | null> {
    return this.address;
  }

  async authorizePrincipal(
    quote: Quote,
    remittanceId: string,
  ): Promise<{ tx: string; eip3009?: { authorization: Eip3009Authorization; signature: string } }> {
    const provider = await this.ensureProvider();
    if (!this.address) throw new Error("wallet_not_connected");
    if (!isAddress(this.address)) throw new Error("invalid_address"); // AC-9: antes de firmar
    const client = createWalletClient({ chain: resolveChain(), transport: custom(provider) });
    if (eip3009Enabled()) {
      // AC-10: firma REAL de transferWithAuthorization (EIP-712), idéntica a InjectedWallet.
      const usdc = resolveUsdcAddress();
      const receiver = resolveReceiverAddress(); // MNR-A: valida isAddress fail-loud (no cast crudo)
      const nonce = deterministicNonce(remittanceId, quote.quoteId); // CD-19: NO random (WKH-168)
      if (!isParseableIso(quote.expiresAt)) throw new Error("quote_expires_at_invalid"); // WKH-198 AC-5 (CD-8: fail LOUD)
      const validBefore = BigInt(Math.floor(Date.parse(quote.expiresAt) / 1000));
      const sig = await client.signTypedData({
        account: this.address,
        domain: { name: "USD Coin", version: "2", chainId: resolveChainId(), verifyingContract: usdc },
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          from: this.address,
          to: receiver,
          value: BigInt(quote.send.minor),
          validAfter: 0n,
          validBefore,
          nonce,
        },
      });
      // WKH-168/CD-16: bigint → string decimal canónico ACÁ (donde se firma). Ver InjectedWallet.
      return {
        tx: sig,
        eip3009: {
          signature: sig,
          authorization: {
            from: this.address,
            to: receiver,
            value: String(quote.send.minor),
            validAfter: "0",
            validBefore: validBefore.toString(),
            nonce,
          },
        },
      };
    }
    // DEMO (default): firma un MENSAJE. Byte-idéntico a hoy (AC-9).
    const sig = await client.signMessage({
      account: this.address,
      message: `Chaski · autorizo enviar ${quote.send.format()} (remesa ${quote.quoteId})`,
    });
    return { tx: sig };
  }

  // WKH-206: firma el popMessage vía el provider de WalletConnect (personal_sign).
  async signMessage(message: string): Promise<string> {
    const provider = await this.ensureProvider();
    if (!this.address) throw new Error("wallet_not_connected");
    const client = createWalletClient({ chain: resolveChain(), transport: custom(provider) });
    return client.signMessage({ account: this.address, message });
  }
}

/**
 * Elige la wallet:
 * - inyectada (MetaMask desktop / browser de la wallet en el cel) → InjectedWallet
 * - navegador móvil normal con projectId de WalletConnect → WalletConnectWallet (deep-link)
 * - si no hay ninguna → demo simulada
 */
export function pickWallet(): WalletPort {
  if (injectedProvider()) return new InjectedWallet();
  const wcId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;
  if (typeof window !== "undefined" && wcId) return new WalletConnectWallet(wcId);
  return new FallbackWallet();
}
