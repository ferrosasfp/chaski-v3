import { afterEach, describe, expect, it } from "vitest";
import {
  resolveSolanaComputeUnitLimit,
  resolveSolanaComputeUnitPriceMicroLamports,
  resolveSolanaExplorerTxUrl,
  resolveSolanaNetworkConfig,
  resolveSolanaReleaseAuthorityPubkey,
  resolveSolanaUsdcMint,
} from "./chain";

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SOLANA_USDC_MINT;
  delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY;
});

const SOLANA_USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

describe("resolveSolanaNetworkConfig — config de la red activa (AC-2)", () => {
  it('devuelve la config vm:"solana" devnet, sin ningún objeto Chain de una lib EVM', () => {
    const cfg = resolveSolanaNetworkConfig();
    expect(cfg.vm).toBe("solana");
    expect(cfg.cluster).toBe("devnet");
    expect(cfg.usdcMintEnvVar).toBe("NEXT_PUBLIC_SOLANA_USDC_MINT");
    expect(cfg.rpcEnvVar).toBe("SOLANA_DEVNET_RPC_URL");
    expect("viemChain" in cfg).toBe(false);
    expect("chainId" in cfg).toBe(false);
  });
});

describe("resolveSolanaUsdcMint — env-driven fail-loud (AC-3)", () => {
  it("mint base58 válido → devuelve el mint EXACTO", () => {
    process.env.NEXT_PUBLIC_SOLANA_USDC_MINT = SOLANA_USDC_DEVNET;
    expect(resolveSolanaUsdcMint()).toBe(SOLANA_USDC_DEVNET);
  });

  it("env ausente → throw solana_usdc_mint_not_configured", () => {
    delete process.env.NEXT_PUBLIC_SOLANA_USDC_MINT;
    expect(() => resolveSolanaUsdcMint()).toThrow("solana_usdc_mint_not_configured");
  });

  it('malformado ("0xNOT") → throw (fail-loud, no fallback)', () => {
    process.env.NEXT_PUBLIC_SOLANA_USDC_MINT = "0xNOT";
    expect(() => resolveSolanaUsdcMint()).toThrow("solana_usdc_mint_not_configured");
  });

  it("address EVM → RECHAZADA por el validador Solana (cruce prohibido CD-2)", () => {
    process.env.NEXT_PUBLIC_SOLANA_USDC_MINT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    expect(() => resolveSolanaUsdcMint()).toThrow("solana_usdc_mint_not_configured");
  });
});

// ── T3 (HU-SOL-9 / WKH-208, AC-4/AC-6): release-authority env-driven fail-loud ──
const RELEASE_AUTHORITY = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // base58 pubkey válida

describe("resolveSolanaReleaseAuthorityPubkey — env-driven fail-loud (AC-4/AC-6)", () => {
  it("base58 válido → devuelve el pubkey EXACTO (jamás lee del body, case-sensitive)", () => {
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY = RELEASE_AUTHORITY;
    expect(resolveSolanaReleaseAuthorityPubkey()).toBe(RELEASE_AUTHORITY);
  });

  it("env ausente → throw solana_release_authority_not_configured", () => {
    delete process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY;
    expect(() => resolveSolanaReleaseAuthorityPubkey()).toThrow(
      "solana_release_authority_not_configured",
    );
  });

  it('malformado ("0xNOT") → throw (fail-loud, no fallback)', () => {
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY = "0xNOT";
    expect(() => resolveSolanaReleaseAuthorityPubkey()).toThrow(
      "solana_release_authority_not_configured",
    );
  });

  it("address EVM → RECHAZADA por el validador Solana (cruce prohibido CD-2)", () => {
    process.env.SOLANA_ESCROW_RELEASE_AUTHORITY_PUBKEY =
      "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    expect(() => resolveSolanaReleaseAuthorityPubkey()).toThrow(
      "solana_release_authority_not_configured",
    );
  });
});

// ── T11 (WKH-321 / SDD 038, AC-2): los valores de ComputeBudget que Chaski DECLARA en el depósito ──
//
// Los dos números van escritos A MANO. Un assert que llamara al propio resolver (o que importara una
// constante compartida) se movería junto con el mutante y pasaría siempre: verificaría el cableado,
// no el valor. Su derivación completa vive en el JSDoc de cada resolver (regla R-CU / R-PRICE); acá
// sólo se congela el resultado.
describe("resolveSolanaComputeUnit* — los valores derivados que Chaski emite (WKH-321)", () => {
  it("el límite declarado es 120.000 CU", () => {
    expect(resolveSolanaComputeUnitLimit()).toBe(120_000);
  });

  it("el precio declarado es 10.000 µL/CU", () => {
    expect(resolveSolanaComputeUnitPriceMicroLamports()).toBe(10_000);
  });

  // BORRADO a propósito (CR MNR-3): acá había un tercer `it` que verificaba "los dos son enteros
  // positivos". No podía ponerse rojo por su cuenta — cualquier valor que rompiera "entero positivo"
  // rompe primero a los dos asserts de arriba, que congelan el valor exacto. Era un verde que se
  // leía como cobertura y no cubría nada. Lo que aquel test decía querer proteger —que el layout
  // serializa u32/u64 sin signo— sí está cubierto, pero sobre los BYTES y no sobre el número:
  // `solana-wallet.test.ts` T2 (`readUInt32LE(1)` / `readBigUInt64LE(1)`) y T12 (sobre el payload
  // que se postea). Si mañana los resolvers dejan de ser constantes, ese test de forma vuelve a
  // tener sentido; hoy no.
});

// ── T-346-2 / T-346-3 (WKH-346, AC-2): la URL del visor que enlaza el comprobante ──
//
// La URL esperada va escrita ENTERA A MANO, por la misma razón que los dos números de T11 de acá
// arriba (`:86-89`): un assert que la armara llamando al propio resolver —o interpolando la constante
// de la base del visor— se movería junto con el mutante y pasaría siempre; verificaría el cableado y
// no el valor. Acá se congelan las cuatro partes: dominio, ruta, firma y parámetro de cluster.
//
// La firma también va a mano y NO importada de `test-support/fakes`: son los 87 caracteres DE ESTE fixture. ⚠️ 87 no es "el largo de una firma" (AR/MNR-2): una firma ed25519 en base58 mide **87 u 88 caracteres, y 88 en la mayoría** (medido, 4000 muestras: 80,2 % dan 88). El nombre `SIGNATURE_87` describe a este valor, que sí mide 87.
// Lo que estos tests tienen que clavar es que ninguno de esos caracteres se pierde en la URL, cualquiera sea el largo.
// El truncado del texto VISIBLE es otra cosa (AC-1) y lo mide `tx-proof.test.tsx`.
const SIGNATURE_87 =
  "99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8";

describe("resolveSolanaExplorerTxUrl — el enlace del comprobante (WKH-346)", () => {
  it("emite la URL del visor con la firma COMPLETA y el cluster de la config activa", () => {
    // INPUT QUE LO PONE EN ROJO: borrar el `?cluster=devnet` (M-4); cambiar el dominio; truncar la
    // firma antes de interpolarla.
    expect(resolveSolanaExplorerTxUrl(SIGNATURE_87)).toBe(
      "https://explorer.solana.com/tx/99eUso3aSbE9tqGSTXzo3TLfKb9RkMTURrHKQ1K7Zh3BbeqPevr5E1iCbpTjqHuTFLtfxTTD5ekfVuZFzQyEQf8?cluster=devnet",
    );
    // Que los 87 estén enteros es el punto: no es el prefijo de una firma ya acortada.
    expect(SIGNATURE_87).toHaveLength(87);
  });

  it("escapa la firma en vez de pegarla cruda (un valor raro no fabrica una query string)", () => {
    // ⚠️ Base58 no tiene `/`, `?`, `=` ni `&`, así que con una firma legítima `encodeURIComponent` es
    // la IDENTIDAD y sacarlo no rompería ningún assert del `it` de arriba. Por eso el input de este
    // test es un valor que la cadena nunca devolvería: es la única forma de que el escape sea
    // observable. Y por eso mismo este test NO prueba que las firmas reales necesiten escape.
    //
    // INPUT QUE LO PONE EN ROJO: sacar el `encodeURIComponent` del template.
    expect(resolveSolanaExplorerTxUrl("a/b?c=1&d")).toBe(
      "https://explorer.solana.com/tx/a%2Fb%3Fc%3D1%26d?cluster=devnet",
    );
  });
});
