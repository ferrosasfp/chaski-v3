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

  // 🔴 EL `it` DE `"a2a"` CAMBIÓ DE BANDO EN W3 Y VIVE ABAJO, entre los que TIRAN. No se borró: el
  // valor sigue existiendo en entornos configurados antes del flip, y lo que hay que custodiar es
  // que ahí falle ruidoso en vez de reinterpretarse como "fallback".

  // ⚠️ La cita vive en el NOMBRE de un `it`, no en un comentario, así que `citas-ancladas.test.ts` no la
  // ve (`esComentario()` la salta) y `.env.example` tampoco lo escanea nadie: la única defensa es abrir
  // la línea. Estaba en `:144`, que en el árbol previo a WKH-336 ya era off-by-one dentro del mismo
  // párrafo, y esa HU la degradó a apuntar a la documentación de OTRA bandera (AR/BLQ-BAJO-1). Medida
  // con `sed -n '155p' .env.example` sobre este árbol.
  it("la env AUSENTE (undefined) cae al default documentado en .env.example:155 → 'fallback'", () => {
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

  // 🔴 EL VALOR VIEJO. Hasta W3 `"a2a"` era el nombre del carril punto a punto y pasaba; ese carril
  // ya no existe, así que el valor no nombra ningún camino. El input que importa es un entorno que
  // quedó con la env vieja: acá TIRA, y no cae a los simuladores en silencio.
  it("'a2a' —el valor del carril borrado— TIRA: ya no nombra ningún transporte", () => {
    expect(() => resolveValueDeliveryAdapter("a2a")).toThrow("value_delivery_adapter_invalido");
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
