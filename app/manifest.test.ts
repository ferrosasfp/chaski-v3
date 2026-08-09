// Tests — T-341-2 (AC-4): el `id` del manifiesto PWA es `chaski-v3`, no `chaski-v2`.
//
// EL DEFECTO QUE CIERRA. `public/manifest.json` declaraba `"id": "chaski-v2"`. El `id` es la
// identidad de la app instalada: dos despliegues que declaran el MISMO `id` son la misma app para el
// navegador, y `chaski-v2` es un despliegue distinto y vivo. Este repo es v3.
//
// Lo que este test SÍ prueba: el archivo sigue siendo JSON parseable y su `id` es `chaski-v3`.
// Lo que NO prueba: nada del comportamiento del navegador al instalar la PWA, ni que Next sirva este
// archivo en `/manifest.json` (eso lo declara `metadata.manifest` en `app/layout.tsx` y no se mide
// acá).
//
// INPUT QUE LO PONE EN ROJO: dejar `"chaski-v2"`; borrar el campo `id`; o romper el JSON (una coma de
// más alcanza) — el `JSON.parse` es el candado de "sigue siendo JSON válido".
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("T-341-2 (AC-4): el `id` del manifiesto PWA", () => {
  it("es `chaski-v3`", () => {
    expect(manifest.id).toBe("chaski-v3");
  });

  it("no es `chaski-v2` (la identidad de otro despliegue)", () => {
    // Redundante con el `it` de arriba a propósito: es el que nombra el valor viejo, así que el
    // rojo dice POR QUÉ importa y no sólo "esperaba v3".
    expect(manifest.id).not.toBe("chaski-v2");
  });
});
