// T-ORI-1..T-ORI-4 (WKH-366 · fix-pack AR/BLQ-ALTO-1) — las decisiones de borde de la comparación
// de origen, cada una escrita como fila y no como suposición.
//
// 🔴 ESTE ARCHIVO NO PRUEBA QUE EL DESEMBOLSO ESTÉ PROTEGIDO. Eso lo prueba
// `../payout/authority.gateway.test.ts` (T-C5c), que es donde el desenlace es `authorized`. Acá se
// fija el COMPORTAMIENTO de la pieza pura: qué cuenta como el mismo origen y qué no. Las dos cosas
// hacen falta y ninguna reemplaza a la otra — un test de la pieza puede ser verde con un consumidor
// que no la llame.
import { describe, expect, it } from "vitest";
import { originOf, sameOrigin } from "./agent-origin";

const NUESTRO = "https://agentes.test";

describe("T-ORI-1 · lo que NO tiene origen afirmable da `null` (⛔ nunca `\"\"`)", () => {
  it.each<[string, unknown]>([
    ["`undefined`", undefined],
    ["`null`", null],
    ["un número", 8080],
    ["un objeto", { host: "agentes.test" }],
    ["la cadena vacía", ""],
    ["una URL relativa", "/api/agents/remit-kyc-decision/invoke"],
    ["texto que no es URL", "agentes.test"],
    ["esquema exótico", "ftp://agentes.test/x"],
    ["`file:`", "file:///etc/passwd"],
    ["`javascript:`", "javascript:alert(1)"],
    ["`data:`", "data:text/plain,hola"],
  ])("%s ⇒ null", (_caso, v) => {
    expect(originOf(v)).toBeNull();
  });

  it("🔴 dos «no sé» NO se comparan iguales entre sí", () => {
    // 🧬 MUTANTE: devolver `""` en vez de `null` ⇒ este `toBe(false)` se pone ROJO, y el daño sería
    // que un ejecutor sin `invokeUrl` legible coincidiera con un deploy sin env legible.
    expect(sameOrigin(undefined, undefined)).toBe(false);
    expect(sameOrigin("ftp://a/x", "ftp://a/x")).toBe(false);
    expect(originOf("ftp://a/x")).not.toBe("");
  });
});

describe("T-ORI-2 · igualdad, NUNCA sufijo: los dominios parecidos NO pasan", () => {
  // 🧬 EL MUTANTE QUE ESTE `describe` EXISTE PARA MATAR: cambiar el `===` por
  // `invokeUrl.endsWith(host)` (o por un `includes`) ⇒ las primeras tres filas se ponen ROJAS. Un
  // sufijo se compra registrando un dominio; la igualdad no se compra.
  it.each<[string, string]>([
    ["un dominio que TERMINA en el nuestro", "https://evil-agentes.test/api/x"],
    ["un subdominio del atacante que lo CONTIENE", "https://agentes.test.evil.example/api/x"],
    ["el nuestro como prefijo de otro", "https://agentes.testing/api/x"],
    ["🔴 userinfo: parece el nuestro y el host es otro", "https://agentes.test@evil.example/api/x"],
    ["un host completamente ajeno", "https://evil.example/api/x"],
    ["subdominio propio: NO es el mismo origen", "https://kyc.agentes.test/api/x"],
  ])("%s ⇒ NO es el mismo origen", (_caso, url) => {
    expect(sameOrigin(url, NUESTRO)).toBe(false);
  });

  it("✅ calibración: el host EXACTO sí pasa (el guard no rechaza todo)", () => {
    expect(sameOrigin("https://agentes.test/api/agents/remit-kyc-decision/invoke", NUESTRO)).toBe(
      true,
    );
  });
});

describe("T-ORI-3 · mayúsculas, puerto default y ruta: lo que la comparación IGNORA a propósito", () => {
  it.each<[string, string]>([
    ["mayúsculas en el host (las baja el parser WHATWG)", "https://AGENTES.TEST/api/x"],
    ["`:443` explícito sobre `https:` (es el puerto default)", "https://agentes.test:443/api/x"],
    ["la ruta, que es DISTINTA a propósito", "https://agentes.test/api/agents/remit-kyc-session/invoke"],
    ["query y fragmento", "https://agentes.test/api/x?a=1#b"],
    ["la barra final", "https://agentes.test/"],
  ])("%s ⇒ SÍ es el mismo origen", (_caso, url) => {
    expect(sameOrigin(url, NUESTRO)).toBe(true);
  });

  it("`:80` sobre `http:` también es el default", () => {
    expect(sameOrigin("http://agentes.test:80/x", "http://agentes.test")).toBe(true);
  });
});

describe("T-ORI-4 · lo que la comparación SÍ discrimina: puerto no-default y esquema", () => {
  it("un puerto NO default es OTRO origen (en un host compartido, otro puerto es otro proceso)", () => {
    // 🧬 MUTANTE: comparar `hostname` en vez de `origin` ⇒ ROJO acá.
    expect(sameOrigin("https://agentes.test:8443/api/x", NUESTRO)).toBe(false);
    expect(originOf("https://agentes.test:8443")).toBe("https://agentes.test:8443");
  });

  it("`http:` contra un deploy `https:` NO pasa (cierra la DEGRADACIÓN de la credencial)", () => {
    // 🧬 MUTANTE: comparar `host` en vez de `origin` ⇒ ROJO acá. El daño sería mandarle el
    // `decisionToken` a nuestro propio agente en claro, porque alguien publicó la fila con `http://`.
    expect(sameOrigin("http://agentes.test/api/x", NUESTRO)).toBe(false);
  });

  it("el orden de los argumentos no cambia el veredicto", () => {
    expect(sameOrigin(NUESTRO, "https://evil.example")).toBe(
      sameOrigin("https://evil.example", NUESTRO),
    );
    expect(sameOrigin(NUESTRO, "https://agentes.test/x")).toBe(true);
  });
});
