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
// 4. Que el MODO de la cabecera (bloquear vs. sólo reportar) sea una decisión escrita: T-CSP-9 lo
//    afirma en una sola dirección, así que cambiarlo obliga a dar vuelta el test en el mismo commit.
// 5. Que las violaciones del recorrido real NO se hayan autorizado por comodidad (T-CSP-10): la
//    salida fácil es agregar el dominio hasta que el navegador deje de quejarse, y acá está
//    prohibido tomarla sin volver a medir de QUIÉN es la violación.
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
    // Se busca el PREFIJO, así este caso sobrevive el cambio de modo: lo que vigila es que la
    // cabecera exista y que su valor venga de la política, no cuál de las dos variantes es. De qué
    // variante se trata lo afirma T-CSP-9, que es el único lugar donde eso se declara.
    expect(src).toContain("Content-Security-Policy");
    // Sin esta cabecera, `report-to csp` no apunta a ningún lado.
    expect(src).toContain("Reporting-Endpoints");
    expect(src).toContain("buildCspPolicy");
  });

  // ── El estado declarado es BLOQUEO, y es DELIBERADO ─────────────────────────────────────────
  // Este test tenía la afirmación INVERSA (que la clave fuera `Report-Only`) y se dio vuelta a mano
  // en el commit que endureció la política, que es justo para lo que existe: obliga a que cambiar de
  // modo sea una decisión escrita y no un descuido, en cualquiera de las dos direcciones.
  it("T-CSP-9: la política BLOQUEA — la clave es la real, no la de sólo-reportar", () => {
    const src = leer("next.config.mjs");
    expect(src).toMatch(/key:\s*"Content-Security-Policy"/);
    expect(src).not.toContain('key: "Content-Security-Policy-Report-Only"');
  });

  // ── Lo que NO se autorizó, y tiene que seguir sin autorizarse ───────────────────────────────
  // Las cinco violaciones del recorrido del 2026-08-11 las produce la barra que Vercel inyecta, no
  // la app. Autorizarlas exigiría `'unsafe-eval'` y tres dominios más para todos los visitantes.
  // Este test existe porque "agregar el dominio hasta que deje de quejarse" es el camino de menor
  // resistencia, y acá está prohibido tomarlo sin volver a medir de quién es la violación.
  it.each([
    ["'unsafe-eval'", "script-src"],
    ["https://fonts.googleapis.com", "style-src"],
    ["https://fonts.gstatic.com", "font-src"],
    ["https://vercel.live", "connect-src"],
  ])("T-CSP-10: %s NO está autorizado en %s", (valor, dir) => {
    const p = buildCspPolicy({ rpcUrl: "https://api.devnet.solana.com" });
    expect(directiva(p, dir)).not.toContain(valor);
  });

  // La tipografía propia se auto-hospeda (`next/font/google`), y por eso `font-src 'self' data:`
  // alcanzó sin una sola violación. Si alguien la cambia por un `<link>` externo, esto se pone rojo
  // ANTES de que el CSP la bloquee en producción — que es el orden que importa.
  it("T-CSP-11: la tipografía se pide por next/font, no por un link externo", () => {
    const layout = leer("app/layout.tsx");
    expect(layout).toContain("next/font/google");
    expect(layout).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });
});
