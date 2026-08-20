// Candado estático — NINGÚN `fireEvent.click` sobre un botón gateado por `busy` va pegado a otro click.
//
// 🔴 QUÉ DEFECTO CIERRA (re-AR it2 · BLQ-BAJO-2). H-13 diagnosticó bien el flake y lo arregló en UN
// `it`. El mismo par de líneas seguía vivo en `agent-plan-card.test.tsx:119-120` —un archivo que el
// propio commit reportaba haber visto fallar— y en otros 30 sitios. Arreglar un síntoma de una familia
// es lo que deja la familia viva; este archivo la vigila.
//
// EL MECANISMO, para que no haya que buscarlo (el detalle está en `../test-support/clicks.ts`):
// `guard()` hace `setBusy(true)` → `await fn()` → `setBusy(false)` en un `finally`, y el `setStep` que
// cambia de pantalla corre DENTRO del `await`. La pantalla nueva pinta `<Button disabled={busy}>`, y un
// `fireEvent.click` sobre un botón deshabilitado **no hace nada y no avisa**. ⇒ el segundo click de un
// par se descarta en silencio y el flujo queda parado para siempre. Es una carrera, no un timeout.
//
// ⛔ LO QUE ESTE CANDADO **NO** HACE, y hay que leerlo antes de apoyarse en su verde:
//
//   1. NO prueba que la lista de nombres esté COMPLETA. Es opt-in, igual que las citas ancladas. Lo que
//      sí está medido es que cada nombre de la lista SIGUE EXISTIENDO en la UI (`it` de abajo), o sea
//      que un rename se pone rojo en vez de vaciar el candado en silencio. Un botón `disabled={busy}`
//      NUEVO no entra solo: hay que sumarlo acá.
//   2. NO mira si el PRIMER click del par dispara un `guard`. Eso se resuelve a mano: un par cuyo
//      primer click es un `setState` síncrono NO instancia la carrera, y los tres del árbol que están
//      en ese caso figuran abajo en `EXENTOS`, con el `onClick` que lo demuestra citado en su propia
//      línea del test. Un cuarto sitio no entra solo: hay que agregarlo a esa lista, o sea decir por
//      qué. ⇒ el criterio sintáctico sobre-detecta a propósito, y la exención es la que carga la
//      prueba.
//   3. NO mide una TASA de flake. Repetir corridas verdes no dice nada de una carrera de 1 en 1000. Lo
//      medido es el MECANISMO y su ausencia sintáctica, nada más.
//   4. NO cubre los ~95 clicks sobre botones gateados que NO van pegados a otro click. Ésos siguen a un
//      `await` que ya dejó asentar el `busy`, y convertirlos sería ruido sin defecto que cerrar.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DIR = path.resolve(ROOT, "src/presentation");

/**
 * Los botones que la app deshabilita mientras un `guard()` está en vuelo. Escritos a mano (ver el
 * punto 1 de arriba), y con el `it` que los ata a la UI real.
 */
const GATEADOS_POR_BUSY: readonly string[] = [
  "Conectar wallet",
  "Verificar mi identidad",
  "Continuar",
  "Recotizar tasa",
  "Confirmar y enviar",
  "Recuperar fondos",
  "Cerrar y recuperar",
  "Buscar mis escrows",
  "Buscar envíos con cuentas abiertas",
  "Empezar un envío",
  "Volver al inicio",
];

/**
 * Los tres pares que se dejan CRUDOS a propósito, cada uno con el `onClick` síncrono que prueba que su
 * primer click no abre ningún `guard`. La exención es por ARCHIVO+LÍNEA, no por archivo: mover el sitio
 * la invalida y el candado vuelve a mirarlo.
 */
const EXENTOS: readonly string[] = [
  "barra-destinos.test.tsx:284", // el de arriba es `VolverAlInicio` ⇒ `onVolver` = `setStep`, síncrono
  "refund-perdido-registro-mudo.test.tsx:82", // el de arriba es la puerta ⇒ `setOpen(true)`, síncrono
  "tx-proof.test.tsx:178", // ídem
];

function archivosDeTest(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".test.tsx"))
    .map((f) => path.join(DIR, f))
    .filter((p) => statSync(p).isFile());
}

/** Los pares: dos `fireEvent.click` en líneas ADYACENTES, con el segundo sobre un botón gateado. */
function paresPegados(lineas: readonly string[], archivo: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < lineas.length - 1; i++) {
    const a = lineas[i] as string;
    const b = lineas[i + 1] as string;
    if (!a.includes("fireEvent.click(") || !b.includes("fireEvent.click(")) continue;
    if (!GATEADOS_POR_BUSY.some((n) => b.includes(n))) continue;
    out.push(`${archivo}:${i + 2}`);
  }
  return out;
}

const FUENTE_UI = ["flow.tsx", "bienvenida.tsx", "barra-destinos.tsx", "ui.tsx"]
  .map((f) => path.join(DIR, f))
  .filter((p) => statSync(p).isFile())
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");

describe("candado: ningún click sobre un botón gateado por `busy` va pegado a otro click", () => {
  // Sin esto el candado puede quedar vigilando CERO archivos y seguir en verde.
  it("el candado no está vacío: hay archivos de test de pantalla que mirar", () => {
    expect(archivosDeTest().length).toBeGreaterThanOrEqual(20);
  });

  // 🔴 LA LISTA ESTÁ ATADA A LA UI. Un rename de un botón dejaría la lista apuntando a un nombre que ya
  // no existe, y el barrido pasaría a no encontrar nada — un candado vacío, en verde. Esto lo impide.
  it("cada nombre de la lista sigue existiendo en la UI (un rename NO vacía el candado)", () => {
    const ausentes = GATEADOS_POR_BUSY.filter((n) => !FUENTE_UI.includes(n));
    expect(ausentes, "estos botones se renombraron y el candado dejó de vigilarlos").toEqual([]);
    // Y que la app siga teniendo botones gateados: si `disabled={busy}` desapareciera, el mecanismo
    // entero dejaría de existir y esta lista sería arqueología.
    expect(FUENTE_UI.split("disabled={busy}").length - 1).toBeGreaterThanOrEqual(10);
  });

  it("no hay pares de clicks pegados sobre un botón que puede estar deshabilitado", () => {
    const rotos: string[] = [];
    for (const abs of archivosDeTest()) {
      const nombre = path.basename(abs);
      for (const hit of paresPegados(readFileSync(abs, "utf8").split("\n"), nombre)) {
        if (!EXENTOS.includes(hit)) rotos.push(hit);
      }
    }
    expect(
      rotos,
      "el segundo click de estos pares puede caer sobre un botón `disabled={busy}` y descartarse en " +
        "silencio: usá `clickCuandoHabilite` de `src/test-support/clicks.ts`",
    ).toEqual([]);
  });

  // 🧪 CONTROL POSITIVO, EN LA MISMA CORRIDA. Sin esto, el `it` de arriba pasaría igual con un
  // `paresPegados` que devuelve siempre `[]` —por un regex roto, por un `filter` invertido, por un
  // `continue` de más—, que es la forma más común de un guard que aplaude.
  it("CONTROL: el detector SÍ encuentra el par cuando está (no es un barrido ciego)", () => {
    const sintetico = [
      '    fireEvent.click(screen.getByRole("button", { name: /Continuar/ }));',
      '    fireEvent.click(await screen.findByRole("button", { name: /Conectar wallet/ }));',
    ];
    expect(paresPegados(sintetico, "sintetico.tsx")).toEqual(["sintetico.tsx:2"]);
    // Y la otra dirección: un click suelto sobre el mismo botón NO es un hallazgo.
    expect(paresPegados([sintetico[1] as string], "sintetico.tsx")).toEqual([]);
  });

  // Las exenciones son tres, y son las tres que quedaron declaradas en su propia línea. Si alguien
  // agrega una cuarta sin decir por qué, este `it` se pone rojo.
  it("las exenciones son exactamente las declaradas, y todas siguen existiendo", () => {
    expect(EXENTOS).toHaveLength(3);
    const vivas = EXENTOS.filter((e) => {
      const [f, ln] = e.split(":");
      const lineas = readFileSync(path.join(DIR, f as string), "utf8").split("\n");
      return (lineas[Number(ln) - 1] ?? "").includes("fireEvent.click(");
    });
    expect(vivas, "una exención apunta a una línea que ya no es un click: re-derivala").toEqual([
      ...EXENTOS,
    ]);
  });
});
