// Tests — HttpPopSigner (WKH-206 W2.3). Fetchea /challenge y firma el popMessage con la wallet.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WalletPort } from "../../application/ports";
import { HttpPopSigner } from "./http-pop-signer";

const ADDR = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"; // base58 pubkey

// Wallet mínima: solo signMessage importa acá; el resto no se invoca.
function fakeWallet(sig = "0xwalletsig"): WalletPort {
  return {
    connect: async () => ADDR,
    getAddress: async () => ADDR,
    authorizePrincipal: async () => ({ tx: "0x" }),
    signMessage: vi.fn(async () => sig),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HttpPopSigner (WKH-206)", () => {
  it("prove: fetchea /challenge, firma el popMessage y devuelve { challenge, signature }", async () => {
    // mockImplementation (NO mockResolvedValue): el body de un Response se consume en la 1ª lectura;
    // con un objeto reusado sería falso verde en escenarios multi-llamada (auto-blindaje 168 W2).
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ popChallenge: "pop-ch", popMessage: "MENSAJE A FIRMAR" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const wallet = fakeWallet("0xwalletsig");

    const out = await new HttpPopSigner(wallet).prove(ADDR);

    expect(out).toEqual({ challenge: "pop-ch", signature: "0xwalletsig" });
    // Fetcheó el endpoint correcto con la address en el body.
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/a2a/payout/challenge");
    expect(JSON.parse(init?.body as string)).toEqual({ address: ADDR });
    // Firmó el popMessage VERBATIM (CD-10: no reconstruye el string).
    expect(wallet.signMessage).toHaveBeenCalledWith("MENSAJE A FIRMAR");
  });

  it("prove: 501 (mecanismo apagado server-side) ⇒ null (SKIP), la wallet NUNCA firma", async () => {
    // DT-2 (fix-pack AR-MNR-1): 501 `pop_not_configured` = secreto server-only ausente ⇒ SKIP. prove()
    // devuelve null; el use-case NO adjunta popChallenge/popSignature ⇒ submit byte-idéntico al demo.
    const signSpy = vi.fn(async () => "0xwalletsig");
    const wallet: WalletPort = { ...fakeWallet(), signMessage: signSpy };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 501, json: async () => ({ error: "pop_not_configured" }) })),
    );

    const out = await new HttpPopSigner(wallet).prove(ADDR);

    expect(out).toBeNull();
    expect(signSpy).not.toHaveBeenCalled();
  });

  it("prove: !ok NO-501 (5xx en un deployment ON) ⇒ throw fail-closed, la wallet NUNCA firma", async () => {
    // DT-2: cualquier otro error (400 / 5xx en un deployment genuinamente ON) NO es skip ⇒ lanza; el
    // use-case lo degrada controlado (failAndRefund). NUNCA es una excepción sin capturar.
    const signSpy = vi.fn(async () => "0xwalletsig");
    const wallet: WalletPort = { ...fakeWallet(), signMessage: signSpy };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "boom" }) })),
    );

    await expect(new HttpPopSigner(wallet).prove(ADDR)).rejects.toThrow("pop_challenge_unavailable");
    expect(signSpy).not.toHaveBeenCalled();
  });
});
