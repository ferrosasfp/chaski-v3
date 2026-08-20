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
//   1. NO DERIVA la lista de nombres de la UI: sigue siendo opt-in, igual que las citas ancladas. Un
//      botón `disabled={busy}` nuevo no entra solo — hay que sumarlo acá. Lo que sí está medido es que
//      cada nombre SIGUE EXISTIENDO en la UI (`it` de abajo): un rename se pone rojo en vez de vaciar
//      el candado en silencio. ⚠️ Y ACÁ ESTABA EL AGUJERO (re-AR it3 · MNR-3): a la pregunta «¿qué pone
//      rojo esto cuando aparece un botón gateado NUEVO?» la respuesta era **NADA**, y por eso la lista
//      se quedó corta con botones que YA existían — `Borrar igual`, `Usar esta cuenta`,
//      `Volver a intentar` y las tres pestañas de la barra: seis nombres que no había visto nadie, y un
//      «32 gateados» que en realidad era ≥ 35. Hoy hay un DISPARADOR MECÁNICO: `T-CLICK-SITIOS` pinnea
//      el número EXACTO de ocurrencias de `disabled={busy}` en los cuatro archivos de UI. Una más —o una
//      menos— pone rojo y obliga a decidir si esa etiqueta entra en la lista. Sigue sin probar que la
//      lista esté completa; lo que prueba es que **no se puede agregar un botón gateado sin que alguien
//      lo mire**.
//   2. NO mira si el PRIMER click del par dispara un `guard`. Eso se resuelve a mano: un par cuyo
//      primer click es un `setState` síncrono NO instancia la carrera, y los CUATRO del árbol que están
//      en ese caso figuran abajo en `EXENTOS`, con el `onClick` que lo demuestra citado en su propia
//      línea del test. Un quinto sitio no entra solo: hay que agregarlo a esa lista, o sea decir por
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
 *
 * 🔴 LOS SEIS ÚLTIMOS ENTRARON EN LA it3 (re-AR · MNR-3), Y NO SON BOTONES NUEVOS: existían desde
 * antes y el candado no los miraba. Cada uno con el sitio que lo hace gateado, verificado leyendo la
 * UI y no la lista:
 *   · `Borrar igual`      — `<button onClick={forgetAndDisconnect} disabled={busy}>` (`flow.tsx:722`)
 *   · `Usar esta cuenta`  — `<CuentaCambiada … disabled={busy} />` (`flow.tsx:747`) lo reenvía a su
 *                           `<Button onClick={onAdoptar} disabled={disabled}>` (`flow.tsx:3815`)
 *   · `Volver a intentar` — es el MISMO botón que `Recuperar fondos` y que `Cerrar y recuperar`, con la
 *                           etiqueta cambiada tras un intento (`flow.tsx:2206`, `flow.tsx:2282`)
 *   · `Enviar`, `Mis envíos`, `Recuperar` — las tres pestañas de `<BarraDestinos … disabled={busy} />`
 *                           (`flow.tsx:1237`), que las apaga a las tres juntas (`barra-destinos.tsx:111`)
 *
 * ⚠️ SON SUBCADENAS Y SOBRE-DETECTAN A PROPÓSITO: `paresPegados` hace `includes`, así que `Recuperar`
 * también matchea `Recuperar fondos`. Eso agranda el perímetro, nunca lo achica, y la exención es la
 * que carga la prueba. Medido al agregarlas: **5 pares nuevos**, de los cuales 4 se convirtieron y 1
 * quedó exento con su razón.
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
  "Borrar igual",
  "Usar esta cuenta",
  "Volver a intentar",
  "Enviar",
  "Mis envíos",
  "Recuperar",
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
  // re-AR it3/MNR-3 — el par vive DENTRO de `irAMisEnvios()`, un helper SÍNCRONO. Su primer click es el
  // mismo `VolverAlInicio` de la exención de arriba (`onVolver` = `setStep("bienvenida")`, `flow.tsx:807`),
  // así que no abre ningún `guard` y no hay ventana de `busy`. Convertirlo obligaría a volver `async` el
  // helper y todos sus llamadores: mucho más cambio que el defecto que cerraría, que es ninguno.
  "flow.test.tsx:157",
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
  });

  // ── T-CLICK-SITIOS — EL DISPARADOR, y es lo que a MNR-3 le faltaba ────────────────────────────
  //
  // 🔴 QUÉ DEFECTO CIERRA. Acá había un `toBeGreaterThanOrEqual(10)` contra **15** ocurrencias, con la
  // razón "si `disabled={busy}` desapareciera, el mecanismo dejaría de existir". Eso es cierto y es lo
  // ÚNICO que veía: un piso no puede ver un botón gateado NUEVO (16 sigue siendo >= 10) y tampoco vio
  // los seis viejos que faltaban en la lista. Es la misma forma de candado que se pudre solo que el pin
  // de enums de `copy-de-prepare-en-pantalla.test.tsx` acaba de cerrar: el piso mide el vaciado, no la
  // deriva.
  //
  // ⇒ CONTEO EXACTO. Cualquier movimiento —un botón gateado nuevo, uno que deja de estarlo, o hasta un
  // comentario que nombre la cadena— pone rojo y obliga a decidir si esa etiqueta entra en
  // `GATEADOS_POR_BUSY`.
  //
  // ⚠️ EL PIN NO DISTINGUE CÓDIGO DE COMENTARIO, y está medido: de las 15 ocurrencias, **14 son props
  // reales** y **1 vive dentro de un comentario** (`flow.tsx:1185`, prosa que discute el `disabled`).
  // No se filtra a propósito: filtrar pide un lexer, y un lexer que se equivoque vuelve a perder un
  // sitio EN SILENCIO. Un rojo de más cuesta un renglón; uno de menos costó este MENOR.
  //
  // ⛔ LO QUE NO PRUEBA: que la lista esté completa. Un botón gateado nuevo pone rojo ESTE `it`, no el
  // de los pares, y su etiqueta la sigue escribiendo una persona.
  it("T-CLICK-SITIOS: el número de sitios `disabled={busy}` de la UI es EXACTAMENTE el pinneado", () => {
    const contar = (s: string): number => s.split("disabled={busy}").length - 1;
    expect(
      contar(FUENTE_UI),
      "cambió la cantidad de `disabled={busy}` en la UI. Si es un botón NUEVO: sumá su etiqueta a " +
        "`GATEADOS_POR_BUSY` y recién ahí actualizá este número. Si desapareció uno: sacá su etiqueta. " +
        "Mover el número sin mirar la lista es exactamente lo que dejó seis botones sin vigilancia.",
    ).toBe(15);
    // 🧪 CONTROL DEL INSTRUMENTO, MISMA CORRIDA: el contador discrimina de verdad, no es un `toBe`
    // sobre una constante. Con un sitio de mentira agregado da 16; sobre una fuente sin la cadena, 0.
    expect(contar(`${FUENTE_UI}\n<Button disabled={busy} />`)).toBe(16);
    expect(contar("<Button disabled={otraCosa} />")).toBe(0);
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
    expect(EXENTOS).toHaveLength(4);
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
