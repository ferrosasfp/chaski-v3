import { describe, expect, it } from "vitest";
import { humanError } from "../flow-vm";
import { walletErrorCode } from "./wallet-error-code";

describe("walletErrorCode", () => {
  it("reusa los códigos que la UI ya sabía traducir, en vez de inventar sinónimos", () => {
    expect(walletErrorCode({ name: "WalletNotConnectedError" })).toBe("wallet_not_connected");
    expect(walletErrorCode({ name: "WalletDisconnectedError" })).toBe("wallet_not_connected");
    expect(walletErrorCode({ name: "WalletTimeoutError" })).toBe("wallet_connect_timeout");
  });

  it("distingue las causas que la librería sí distingue", () => {
    expect(walletErrorCode({ name: "WalletWindowClosedError" })).toBe("wallet_window_closed");
    expect(walletErrorCode({ name: "WalletWindowBlockedError" })).toBe("wallet_window_blocked");
    expect(walletErrorCode({ name: "WalletConnectionError" })).toBe("wallet_connect_failed");
  });

  // El punto del hallazgo original: un código que nadie reconoce NO puede evaporarse, porque
  // entonces el reporte desde un celular vuelve a quedar sin nada que buscar.
  it("un nombre desconocido conserva el nombre en el código, no se colapsa a un genérico", () => {
    expect(walletErrorCode({ name: "WalletFuturoError" })).toBe("wallet_error:WalletFuturoError");
  });

  it("acota el nombre: viene de una librería de terceros y termina en pantalla", () => {
    const code = walletErrorCode({ name: "W".repeat(300) });
    expect(code.length).toBeLessThanOrEqual("wallet_error:".length + 40);
  });

  it("un valor que no es un error tampoco rompe: da un código nombrable", () => {
    for (const raro of [null, undefined, "boom", 42, {}, { name: 7 }]) {
      expect(walletErrorCode(raro)).toBe("wallet_error:sin_nombre");
    }
  });

  it("NO afirma que la persona rechazó: la librería usa el mismo error para el rechazo y para un fallo interno", () => {
    const copy = humanError(walletErrorCode({ name: "WalletConnectionError" }));
    expect(copy).not.toMatch(/rechazaste|cancelaste/i);
    expect(copy).toMatch(/rechazado|falla|fallado/i);
  });

  // `WalletNotReadyError` YA NO tiene entrada propia, y este test lo fija. Su código mapeaba a
  // `no_wallet`, cuyo copy afirmaba qué wallet había instalada en el dispositivo (el navegador no lo
  // puede saber) y encima nadie podía leerlo: la app no llama `useWallet().connect()`, y el efecto de
  // autoConnect exige `Installed || Loadable` antes de tocar al adapter, que es la misma condición que
  // el adapter volvería a chequear para tirar esa excepción.
  //
  // Lo que se conserva es lo diagnosticable: el nombre sobrevive dentro del código que se muestra en
  // pantalla, igual que cualquier error nuevo de la librería.
  it("WalletNotReadyError sale por la rama de los nombres que no conocemos, con el nombre intacto", () => {
    expect(walletErrorCode({ name: "WalletNotReadyError" })).toBe(
      "wallet_error:WalletNotReadyError",
    );
    expect(humanError(walletErrorCode({ name: "WalletNotReadyError" }))).toContain(
      "no reconocemos",
    );
  });

  // El contrato con la otra mitad: si alguien agrega un código acá y se olvida del copy, esto se
  // pone rojo en vez de reaparecer en producción como "Algo salió mal".
  it("TODO código que produce este módulo tiene copy propio en humanError()", () => {
    const nombres = [
      "WalletNotReadyError",
      "WalletNotConnectedError",
      "WalletDisconnectedError",
      "WalletTimeoutError",
      "WalletWindowClosedError",
      "WalletWindowBlockedError",
      "WalletConnectionError",
      "WalletAccountError",
      "WalletPublicKeyError",
      "WalletLoQueVenga",
    ];
    for (const name of nombres) {
      expect(humanError(walletErrorCode({ name }))).not.toBe("Algo salió mal. Intentá de nuevo.");
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// WKH-MWA · el clasificador de errores de Mobile Wallet Adapter
//
// 🔴 EL AGUJERO QUE CIERRAN, reportado desde un Android real contra producción: la persona tocó
// "Mobile Wallet Adapter" en el selector, no se abrió ninguna billetera, y la app dijo
// "Se cerró el selector de wallet sin conectar" con el código `wallet_connect_cancelled`. Nadie cerró
// nada. Ese mensaje le atribuye a la persona una acción que no hizo Y tira la causa real.
//
// Este bloque cubre la mitad "que la causa se pueda nombrar". La mitad "que no se pierda" —o sea, que
// `cancelConnection()` no le gane la carrera a `failConnection()`— vive en `wallet-availability.test.tsx`
// (T-CANCEL-*), porque necesita el árbol de providers REAL.
import { MWA_CODES, mwaErrorCode, mwaHumanError } from "./wallet-error-code";

/** El enum REAL, resuelto desde la copia que carga el adapter que corre en producción. */
async function enumDelPaquete(): Promise<string[]> {
  const { createRequire } = await import("node:module");
  const path = (await import("node:path")).default;
  const desdeElAdapter = createRequire(
    path.join(
      process.cwd(),
      "node_modules/@solana/wallet-adapter-react/node_modules/@solana-mobile/wallet-adapter-mobile/lib/cjs/index.js",
    ),
  );
  const proto = desdeElAdapter("@solana-mobile/mobile-wallet-adapter-protocol") as {
    SolanaMobileWalletAdapterErrorCode: Record<string, string>;
  };
  return Object.keys(proto.SolanaMobileWalletAdapterErrorCode);
}

describe("WKH-MWA · los códigos que el adapter puede producir", () => {
  it("T-ERR-1: la lista escrita a mano es EXACTAMENTE el enum del paquete instalado", async () => {
    // El catálogo de `wallet-error-code.ts` está copiado a mano de la declaración de tipos, y una lista
    // a mano envejece con la próxima versión del paquete. Esto no la compara contra otro literal: la
    // compara contra el enum que exporta la copia que el adapter REALMENTE carga.
    const real = await enumDelPaquete();
    // Control anti-verde-por-vacío: si el `require` fallara y devolviera `[]`, las dos aserciones de
    // abajo pasarían por vacío en la dirección equivocada.
    expect(real.length).toBeGreaterThanOrEqual(11);
    expect([...MWA_CODES].sort()).toEqual([...real].sort());
  });

  it("T-ERR-2: el código de MWA sale de ADENTRO de la cadena, no del `name` de la envoltura", async () => {
    // Los errores se construyen con las clases REALES de las dos librerías, no con objetos inventados.
    // La FORMA de la cadena (`.error` de `WalletError`, después `.cause` estándar) está medida contra
    // el adapter vivo; quien la vuelve a medir end-to-end es T-CANCEL-2.
    const { createRequire } = await import("node:module");
    const path = (await import("node:path")).default;
    const desdeElAdapter = createRequire(
      path.join(
        process.cwd(),
        "node_modules/@solana/wallet-adapter-react/node_modules/@solana-mobile/wallet-adapter-mobile/lib/cjs/index.js",
      ),
    );
    const proto = desdeElAdapter("@solana-mobile/mobile-wallet-adapter-protocol") as {
      SolanaMobileWalletAdapterError: new (c: string, m: string) => Error;
      SolanaMobileWalletAdapterErrorCode: Record<string, string>;
    };
    const base = (await import("@solana/wallet-adapter-base")) as unknown as {
      WalletConnectionError: new (m: string, e: unknown) => Error;
    };

    const adentro = new proto.SolanaMobileWalletAdapterError(
      proto.SolanaMobileWalletAdapterErrorCode.ERROR_LOOPBACK_ACCESS_BLOCKED as string,
      "permiso de red local denegado",
    );
    const medio = new Error("envoltura intermedia", { cause: adentro });
    const arriba = new base.WalletConnectionError("lo que ve `onError`", medio);

    // (i) LA ASERCIÓN QUE DECIDE, primero: esto NO puede volver a leerse como una cancelación.
    expect(walletErrorCode(arriba)).not.toBe("wallet_connect_cancelled");
    // (ii) Y tampoco puede colapsarse en el genérico de la envoltura, que es lo que pasaba antes: el
    //      `name` de arriba es `WalletConnectionError` ⇒ `wallet_connect_failed` para los ONCE códigos.
    expect(walletErrorCode(arriba)).not.toBe("wallet_connect_failed");
    expect(walletErrorCode(arriba)).toBe("mwa:ERROR_LOOPBACK_ACCESS_BLOCKED");
    // (iii) El control de que (ii) mide algo: sin la cadena adentro, el mismo `name` SÍ da el genérico.
    expect(walletErrorCode(new base.WalletConnectionError("pelado", undefined))).toBe(
      "wallet_connect_failed",
    );
  });

  it("T-ERR-3: el copy de un código de MWA no acusa a la persona de cancelar", () => {
    for (const code of MWA_CODES) {
      const copy = humanError(`mwa:${code}`);
      expect(copy, code).not.toBe("Algo salió mal. Intentá de nuevo.");
      // "cancelaste"/"rechazaste" en segunda persona no puede aparecer para NINGUNO de los once. El
      // único que habla de una cancelación es ERROR_ASSOCIATION_CANCELLED, y dice dónde ocurrió
      // ("desde la app de tu billetera"), no que la haya hecho la persona en el selector.
      expect(copy, code).not.toMatch(/cancelaste|rechazaste|cerraste/i);
      expect(copy, code).not.toMatch(/Se cerró el selector/);
    }
  });

  it("T-ERR-4: un código que NO conocemos no inventa causa, y deja el código a la vista", () => {
    // La regla del mapa: sólo tiene texto propio lo que se puede afirmar. Un código nuevo del paquete
    // tiene que caer del lado que no acusa.
    const copy = mwaHumanError("mwa:ERROR_DEL_FUTURO");
    expect(copy).toMatch(/No sabemos por qué/);
    expect(copy).toContain("ERROR_DEL_FUTURO");
    expect(copy).not.toMatch(/cancelaste|rechazaste/i);
  });

  it("T-ERR-5: sin un error de MWA adentro, el clasificador se comporta igual que antes", () => {
    // El par negativo: esta rama no puede robarle casos a la familia `wallet_*`. Si `mwaErrorCode`
    // devolviera algo para cualquier objeto, TODOS los códigos de arriba cambiarían de significado.
    expect(mwaErrorCode({ name: "WalletConnectionError" })).toBeNull();
    expect(mwaErrorCode({ name: "SolanaMobileWalletAdapterError" })).toBeNull(); // sin `code` no hay nada que decir
    expect(mwaErrorCode(null)).toBeNull();
    expect(walletErrorCode({ name: "WalletTimeoutError" })).toBe("wallet_connect_timeout");
  });

  it("T-ERR-6: la cadena tiene un tope de profundidad (una causa ciclada colgaría el render)", () => {
    const a: Record<string, unknown> = { name: "Wrap" };
    a.cause = a;
    expect(() => mwaErrorCode(a)).not.toThrow();
    expect(mwaErrorCode(a)).toBeNull();
  });
});
