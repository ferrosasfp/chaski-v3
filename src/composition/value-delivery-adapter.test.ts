// T-3.1 (WKH-332 / AC-3) — la tabla completa de `resolveValueDeliveryAdapter`.
//
// CD-17: este `describe` NO depende de ningún `beforeEach`. La función se llama con el valor crudo
// por parámetro y no lee `process.env`, así que no hay estado de entorno que preparar ni limpiar.
// Esa independencia es a propósito: el test de arriba (T-3.2, en `container.test.ts`) es el que
// ejercita el cableado real, y este es el de la tabla.
import { describe, expect, it } from "vitest";
import { resolveValueDeliveryAdapter } from "./value-delivery-adapter";

describe("resolveValueDeliveryAdapter — los valores que PASAN", () => {
  it("'a2a-gateway' (el carril real) se devuelve tal cual", () => {
    expect(resolveValueDeliveryAdapter("a2a-gateway")).toBe("a2a-gateway");
  });

  it("'fallback' (el demo con mocks) se devuelve tal cual", () => {
    expect(resolveValueDeliveryAdapter("fallback")).toBe("fallback");
  });

  // 🔴 TRANSITORIO. Este `it` cambia de bando en W3, cuando `"a2a"` salga del conjunto en el MISMO
  // diff que borra el carril punto a punto. Hoy pasa porque hoy `"a2a"` es el valor con el que corre
  // producción y cablea los gateways A2A REALES, no los mocks.
  it("'a2a' PASA todavía: es el valor vigente en producción y sale del conjunto recién en W3", () => {
    expect(resolveValueDeliveryAdapter("a2a")).toBe("a2a");
  });

  it("la env AUSENTE (undefined) cae al default documentado en .env.example:144 → 'fallback'", () => {
    expect(resolveValueDeliveryAdapter(undefined)).toBe("fallback");
  });
});

describe("resolveValueDeliveryAdapter — los valores que TIRAN (AC-3: fail-loud, nunca mock)", () => {
  // La distinción `undefined` ≠ `""` es la razón por la que este `it` existe separado del de arriba:
  // `vercel env pull` escribe VACÍO lo que no puede leer, así que una key en blanco es una mala
  // configuración —alguien la escribió— y no la ausencia deliberada que el default cubre.
  it("la env PRESENTE Y VACÍA ('') tira, aunque undefined no tire", () => {
    expect(() => resolveValueDeliveryAdapter("")).toThrow("value_delivery_adapter_invalido");
  });

  it("un typo de una sola letra ('a2a-gatewayy') tira en vez de caer al mock", () => {
    expect(() => resolveValueDeliveryAdapter("a2a-gatewayy")).toThrow(
      "value_delivery_adapter_invalido",
    );
  });

  it("la diferencia de mayúsculas ('A2A-Gateway') tira: el conjunto es sensible a mayúsculas", () => {
    expect(() => resolveValueDeliveryAdapter("A2A-Gateway")).toThrow(
      "value_delivery_adapter_invalido",
    );
  });

  it("el mensaje nombra la variable y su valor, para que el error sea accionable sin adivinar", () => {
    expect(() => resolveValueDeliveryAdapter("a2a-gatewayy")).toThrow(
      "NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER",
    );
    expect(() => resolveValueDeliveryAdapter("a2a-gatewayy")).toThrow("a2a-gatewayy");
  });
});
