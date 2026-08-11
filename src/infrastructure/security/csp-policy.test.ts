// Candado de la política de CSP.
//
// Lo que vigila, y por qué cada cosa:
//
// 1. Que `connect-src` se DERIVE de la env del RPC y no esté escrita a mano. Dos listas que tienen
//    que coincidir y que nada obliga a coincidir es el defecto que este proyecto ya se comió tres
//    veces en un día (el KYC configurado de un solo lado, la bandera del adapter de cotización, y
//    el tope de ComputeBudget entre servicios). Acá el síntoma sería una firma que falla.
// 2. Que el WebSocket viaje junto al HTTPS. web3.js lo abre solo derivando el host de la misma URL;
//    omitirlo NO rompe el envío, rompe la CONFIRMACIÓN, que es el modo de falla más confuso.
// 3. Que una URL inválida no se convierta en un origen inventado.
// 4. Que la cabecera siga siendo `Report-Only` mientras la política no esté verificada con un
//    recorrido real — y que el día que se endurezca, sea una decisión y no un descuido.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — módulo .mjs sin tipos, compartido con next.config.mjs a propósito: la política
// tiene que ser LA MISMA que la que se sirve, y next.config no puede importar TypeScript.
import { buildCspPolicy, rpcOrigins } from "./csp-policy.mjs";

const RAIZ = join(__dirname, "..", "..", "..");
const leer = (rel: string): string => readFileSync(join(RAIZ, rel), "utf8");

/** Extrae los valores de una directiva del string de la política. */
function directiva(politica: string, nombre: string): string[] {
  const parte = politica.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${nombre} `));
  return parte ? parte.slice(nombre.length + 1).split(" ") : [];
}

describe("candado · política de CSP", () => {
  // ── El origen del RPC se deriva ───────────────────────────────────────────────────────────────
  it("T-CSP-1: de una URL https salen DOS orígenes, el https y el wss", () => {
    expect(rpcOrigins("https://api.devnet.solana.com")).toEqual([
      "https://api.devnet.solana.com",
      "wss://api.devnet.solana.com",
    ]);
  });

  it("T-CSP-2: conserva puerto y subdominio, que es donde viven los proveedores dedicados", () => {
    expect(rpcOrigins("https://mi-nodo.ejemplo.com:8899/ruta")).toEqual([
      "https://mi-nodo.ejemplo.com:8899",
      "wss://mi-nodo.ejemplo.com:8899",
    ]);
  });

  it.each([
    ["vacía", ""],
    ["no es una URL", "no-soy-una-url"],
    ["ausente", undefined],
    ["protocolo raro", "ftp://api.devnet.solana.com"],
  ])("T-CSP-3: una URL %s NO produce un origen inventado", (_caso, valor) => {
    expect(rpcOrigins(valor as string)).toEqual([]);
  });

  // ── La política SIGUE a la env, no la duplica ────────────────────────────────────────────────
  // Este es el test que importa: con otro RPC, la política cambia sola. Si alguien vuelve a clavar
  // el dominio a mano, este caso se pone rojo.
  it("T-CSP-4: cambiar la env del RPC cambia connect-src", () => {
    const a = buildCspPolicy({ rpcUrl: "https://api.devnet.solana.com" });
    const b = buildCspPolicy({ rpcUrl: "https://otro-proveedor.example:8899" });
    expect(directiva(a, "connect-src")).toContain("https://api.devnet.solana.com");
    expect(directiva(b, "connect-src")).toContain("https://otro-proveedor.example:8899");
    expect(directiva(b, "connect-src")).not.toContain("https://api.devnet.solana.com");
  });

  // El puerto POR DEFECTO se normaliza y desaparece, y eso es lo correcto: un origen de CSP en 443
  // se escribe sin puerto, y `https://host:443` no matchea `https://host`. Este caso existe porque
  // la primera versión del test esperaba lo contrario y el rojo era del test, no del código.
  it("T-CSP-4b: el puerto por defecto NO aparece en el origen", () => {
    expect(rpcOrigins("https://x.example:443")).toEqual(["https://x.example", "wss://x.example"]);
    expect(rpcOrigins("http://x.example:80")).toEqual(["http://x.example", "ws://x.example"]);
  });

  // ── Forma: nadie clava el dominio en el archivo de la política ───────────────────────────────
  // Sobre el TEXTO y no sobre el valor, porque el comportamiento coincidiría igual mientras la env
  // apunte a devnet: es la misma trampa que un guard que se compara con lo que él mismo calculó.
  it("T-CSP-5: el archivo de la política no menciona ningún host de Solana a mano", () => {
    const src = leer("src/infrastructure/security/csp-policy.mjs");
    const codigo = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(codigo).not.toMatch(/api\.(devnet|testnet|mainnet-beta)\.solana\.com/);
  });

  // ── Las directivas que cierran vectores clásicos están presentes ─────────────────────────────
  it.each([
    ["default-src", "'self'"],
    ["object-src", "'none'"],
    ["frame-ancestors", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
  ])("T-CSP-6: %s incluye %s", (dir, valor) => {
    expect(directiva(buildCspPolicy({ rpcUrl: "https://x.example" }), dir)).toContain(valor);
  });

  // ── Los reportes tienen a dónde llegar, por los DOS mecanismos ───────────────────────────────
  it("T-CSP-7: declara report-uri y report-to", () => {
    const p = buildCspPolicy({ rpcUrl: "https://x.example" });
    expect(directiva(p, "report-uri")).toContain("/api/csp-report");
    expect(directiva(p, "report-to")).toContain("csp");
  });

  // ── La cabecera y su destino viajan juntos ───────────────────────────────────────────────────
  it("T-CSP-8: next.config sirve el CSP y declara Reporting-Endpoints", () => {
    const src = leer("next.config.mjs");
    expect(src).toContain("Content-Security-Policy-Report-Only");
    // Sin esta cabecera, `report-to csp` no apunta a ningún lado.
    expect(src).toContain("Reporting-Endpoints");
    expect(src).toContain("buildCspPolicy");
  });

  // ── El estado declarado es Report-Only, y es DELIBERADO ──────────────────────────────────────
  // Cuando se endurezca, este test se pone rojo y obliga a actualizarlo en el mismo commit. Es lo
  // que impide que "activar el CSP" pase inadvertido, en cualquiera de las dos direcciones.
  it("T-CSP-9: hoy NO bloquea — la clave es Report-Only y no la de bloqueo", () => {
    const src = leer("next.config.mjs");
    expect(src).toContain('key: "Content-Security-Policy-Report-Only"');
    expect(src).not.toMatch(/key:\s*"Content-Security-Policy"/);
  });
});
