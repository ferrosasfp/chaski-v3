// T-C12 (WKH-366 · AC-13) — las piezas PURAS del smoke del KYC por Coordinador.
//
// 🔴 POR QUÉ ESTE ARCHIVO NO ES OPCIONAL. Un script de sonda que nadie testea no es una sonda: es una
// opinión. Y las tres piezas de acá son justamente donde una sonda miente sin que se note:
//   · `deriveInput`, si dejara de leer su argumento y devolviera un cuerpo de memoria, seguiría
//     dando verde contra un catálogo que ya cambió;
//   · `classify`, si su fila por defecto fuera PASS, diría "todo anda" ante cualquier camino que
//     nadie previó (el precedente está escrito en este ecosistema);
//   · `assertExecutor`, si se relajara, daría verde ante un tercero que sirva el mismo slug, que es
//     exactamente lo que la sonda existe para ver. ⚠️ Y ESO YA PASÓ, medido por el AR: mientras sólo
//     comparaba el par `(slug, registry)` —los dos publicables por cualquier caller autenticado del
//     Coordinador— el exit 6 (SUPLANTACIÓN) era INALCANZABLE ante el ataque real. El fix-pack agrega
//     la comparación de ORIGEN, y las filas de abajo la ejercitan.
import { describe, expect, it } from "vitest";
import {
  EXIT,
  type Observacion,
  ECHO_MAX,
  assertExecutor,
  assertNoBridge,
  assertOutputKeys,
  classify,
  deriveInput,
  requiredSubset,
  safeEcho,
  schemaFingerprint,
} from "./smoke-kyc-helpers";

const SESSION_SLUG = "remit-kyc-session";
const DECISION_SLUG = "remit-kyc-decision";

/** El origen del agente propio, tal como la sonda lo toma de SU entorno (`KYC_AGENT_BASE_URL`). */
const ORIGEN = "https://agentes.test";

/** Un ejecutor propio: el par del catálogo Y la `invokeUrl` del host del deploy. */
const PROPIO = (slug: string) => ({
  slug,
  registry: "self-published",
  invokeUrl: `${ORIGEN}/api/agents/${slug}/invoke`,
});

describe("deriveInput — deriva de SU ARGUMENTO, y nunca inventa", () => {
  // 🧬 EL MUTANTE QUE ESTE `it` EXISTE PARA MATAR: hardcodear el cuerpo. Si `deriveInput` dejara de
  // leer su argumento, este caso —donde el valor sale de un `enum` que sólo existe en el schema que
  // se le pasó— se pone ROJO, y ningún otro assert de la sonda lo notaría.
  it("`enum` ⇒ el PRIMER valor del enum, leído del schema recibido", () => {
    const r = deriveInput({
      type: "object",
      required: ["metodo"],
      properties: { metodo: { type: "string", enum: ["plin", "yape"] } },
    });
    expect("input" in r && r.input).toEqual({ metodo: "plin" });
  });

  it("el MISMO campo con OTRO enum da OTRO valor (la derivación no es una constante)", () => {
    const r = deriveInput({
      type: "object",
      required: ["metodo"],
      properties: { metodo: { type: "string", enum: ["yape", "plin"] } },
    });
    expect("input" in r && r.input).toEqual({ metodo: "yape" });
  });

  it("un `string` libre OPCIONAL se OMITE (omitir un opcional es conforme al schema)", () => {
    // Es el schema real del paso de sesión: `identityRef` opcional, string libre.
    const r = deriveInput({
      type: "object",
      required: [],
      properties: { identityRef: { type: "string", minLength: 1 } },
    });
    expect("input" in r && r.input).toEqual({});
    expect(r.omitted).toEqual(["identityRef"]);
  });

  it("🔴 el MISMO campo, ahora REQUERIDO, ⇒ `required-not-derivable` (⛔ no se inventa)", () => {
    // La misma regla, sin ninguna excepción escrita: mover el campo a `required` lo convierte en
    // DRIFT ruidoso. Un valor inventado acá sería una afirmación que el catálogo no respalda.
    const r = deriveInput({
      type: "object",
      required: ["identityRef"],
      properties: { identityRef: { type: "string", minLength: 1 } },
    });
    expect("input" in r).toBe(false);
    expect(r).toMatchObject({
      reason: "required-not-derivable",
      field: "identityRef",
      detail: "string-libre-sin-enum",
    });
  });

  it("un `required` que no está en `properties` ⇒ tampoco se inventa", () => {
    const r = deriveInput({ type: "object", required: ["fantasma"], properties: {} });
    expect(r).toMatchObject({ reason: "required-not-derivable", field: "fantasma" });
  });

  it("cotas numéricas PUBLICADAS ⇒ se usa una de ellas; sin cotas satisfacibles ⇒ no derivable", () => {
    expect(
      "input" in deriveInput({ required: ["n"], properties: { n: { type: "integer", minimum: 5 } } }) &&
        (deriveInput({ required: ["n"], properties: { n: { type: "integer", minimum: 5 } } }) as {
          input: Record<string, unknown>;
        }).input,
    ).toEqual({ n: 5 });
    expect(
      deriveInput({ required: ["n"], properties: { n: { type: "integer", minimum: 9, maximum: 2 } } }),
    ).toMatchObject({ reason: "required-not-derivable", detail: "cotas-insatisfacibles" });
  });

  it("un schema ausente o basura no revienta: devuelve un cuerpo vacío", () => {
    expect(deriveInput(undefined)).toEqual({ input: {}, omitted: [] });
    expect(deriveInput("no soy un schema")).toEqual({ input: {}, omitted: [] });
  });
});

describe("schemaFingerprint — la misma huella para el mismo schema, distinta si cambió", () => {
  it("es estable ante el ORDEN de las claves y cambia ante el CONTENIDO", () => {
    const a = { type: "object", required: ["x"], properties: { x: { type: "string" } } };
    const b = { properties: { x: { type: "string" } }, required: ["x"], type: "object" };
    expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));
    expect(schemaFingerprint(a)).not.toBe(schemaFingerprint({ ...a, required: ["x", "y"] }));
    expect(schemaFingerprint(a)).toHaveLength(12);
  });
});

describe("assertExecutor — N3 en la sonda: el default es FALLO", () => {
  // 🧬 MUTANTE: chequear sólo el slug ⇒ las filas de registry se ponen rojas. 🧬 MUTANTE: aceptar
  // `null` ⇒ la primera fila se pone roja.
  const conInvoke = (a: Record<string, unknown>) => ({
    invokeUrl: `${ORIGEN}/api/agents/x/invoke`,
    ...a,
  });
  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["no es un objeto", "remit-kyc-session"],
    ["slug ajeno", conInvoke({ slug: "evil-kyc", registry: "self-published" })],
    ["registry ajeno", conInvoke({ slug: SESSION_SLUG, registry: "un-registry-cualquiera" })],
    ["registry AUSENTE", conInvoke({ slug: SESSION_SLUG })],
    ["el slug del OTRO paso", conInvoke({ slug: DECISION_SLUG, registry: "self-published" })],
  ])("%s ⇒ rechaza", (_caso, agent) => {
    expect(assertExecutor(agent, SESSION_SLUG, ORIGEN).ok).toBe(false);
  });

  // 🔴 EL IMPOSTOR REAL: el par PERFECTO —que se compra publicando primero en el Coordinador— y la
  // `invokeUrl` apuntando a otro lado. Éstas son las filas que hacen que el exit 6 exista de verdad.
  // 🧬 MUTANTE: soltar el chequeo de origen de `assertExecutor` ⇒ las SEIS se ponen rojas.
  it.each<[string, unknown]>([
    ["el host del atacante", "https://evil.example/api/x"],
    ["un dominio que TERMINA en el nuestro", "https://evil-agentes.test/api/x"],
    ["el nuestro como SUBdominio del atacante", "https://agentes.test.evil.example/api/x"],
    ["userinfo: el texto arranca con el nuestro", "https://agentes.test@evil.example/api/x"],
    ["otro puerto", "https://agentes.test:8443/api/x"],
    ["`invokeUrl` AUSENTE", undefined],
  ])("par perfecto + invokeUrl = %s ⇒ rechaza", (_caso, invokeUrl) => {
    const agent: Record<string, unknown> = { slug: SESSION_SLUG, registry: "self-published" };
    if (invokeUrl !== undefined) agent.invokeUrl = invokeUrl;
    expect(assertExecutor(agent, SESSION_SLUG, ORIGEN).ok).toBe(false);
  });

  it("🔴 sin origen esperado (`null`) NADA pasa, ni el ejecutor correcto", () => {
    // ⛔ «No pude verificar» no es «verificado». Que ESO salga como CONFIG y no como SUPLANTACIÓN lo
    // decide `classify`, y tiene su propio `it` más abajo.
    expect(assertExecutor(PROPIO(SESSION_SLUG), SESSION_SLUG, null).ok).toBe(false);
  });

  it("✅ calibración: el ejecutor propio SÍ pasa (el guard no deniega todo)", () => {
    expect(assertExecutor(PROPIO(SESSION_SLUG), SESSION_SLUG, ORIGEN)).toEqual({ ok: true });
  });

  it("✅ calibración: la RUTA no se compara, sólo el origen", () => {
    const agent = { ...PROPIO(SESSION_SLUG), invokeUrl: `${ORIGEN}/otra/ruta/cualquiera` };
    expect(assertExecutor(agent, SESSION_SLUG, ORIGEN)).toEqual({ ok: true });
  });

  it("⛔ el `reason` NO ecoa la `invokeUrl` observada (la controla un tercero y esto va a stdout)", () => {
    const agent = { ...PROPIO(SESSION_SLUG), invokeUrl: "https://evil.example/robame-el-log" };
    const r = assertExecutor(agent, SESSION_SLUG, ORIGEN);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).not.toContain("evil.example");
    expect(r.ok === false && r.reason).toContain(ORIGEN);
  });
});

// ── MNR-4 (AR ronda 2): lo que SÍ se ecoa, sale ACOTADO ───────────────────────────────────────────
//
// 🔴 QUÉ AFIRMA, Y POR QUÉ NO ALCANZABA EL `it` de arriba. Ese `it` verifica que la `invokeUrl` no
// se ecoa, y el comentario del código lo justificaba diciendo «ese string lo controla el publicador».
// La misma frase valía para el `slug` y el `registry`, que SÍ salían crudos: una fila squatteada con
// un `name` largo o con escapes ANSI se llevaba entera el stdout del operador. Estas filas cierran
// esa mitad, y `safeEcho` es lo que hace que la frase sea una regla del archivo.
//
// 🧬 EL MUTANTE: volver `safeEcho` a `String(v)` (o borrarle el clamp de `ECHO_MAX`, o abrirle la
// lista blanca). Cada fila hostil de acá se pone ROJA con el string hostil ENTERO adentro del
// `reason`, que es exactamente lo que el AR reprodujo.
describe("safeEcho — lo ajeno sale acotado en LARGO y en CHARSET", () => {
  const ANSI = "\u001b[2J\u001b[H";
  const CIRILICO = "remit-kyc-sessi\u043en"; // la `о` NO es la nuestra

  it.each<[string, string, string]>([
    ["ANSI (borra la pantalla y sube el cursor)", ANSI, "\u001b"],
    ["un newline (parte el renglón del operador)", "a\nb", "\n"],
    ["un retorno de carro (repisa el renglón)", "a\rb", "\r"],
    ["un NUL", "a\u0000b", "\u0000"],
    ["un DEL", "a\u007fb", "\u007f"],
    ["un C1 crudo", "a\u009bb", "\u009b"],
    ["un override RTL", "a\u202eb", "\u202e"],
  ])("%s NO sobrevive al eco", (_caso, hostil, prohibido) => {
    const r = assertExecutor({ ...PROPIO(SESSION_SLUG), slug: hostil }, SESSION_SLUG, ORIGEN);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).not.toContain(prohibido);
    expect(r.ok === false && r.reason).toContain("?");
  });

  it("un `slug` de 5.000 caracteres sale acotado, y el `reason` NO lo contiene entero", () => {
    const hostil = "A".repeat(5000);
    const r = assertExecutor({ ...PROPIO(SESSION_SLUG), slug: hostil }, SESSION_SLUG, ORIGEN);
    expect(r.ok).toBe(false);
    const reason = r.ok === false ? r.reason : "";
    expect(reason).not.toContain(hostil);
    // El techo se afirma sobre lo ECOADO, no sobre el `reason` entero: el resto de la frase es
    // nuestra y su largo no lo decide nadie de afuera.
    expect(safeEcho(hostil)).toBe(`${"A".repeat(ECHO_MAX)}[+${5000 - ECHO_MAX}]`);
    expect(reason).toContain("[+4936]");
  });

  it("el caso COMBINADO del AR: largo + ANSI + newline en la misma fila", () => {
    const hostil = `${"x".repeat(200)}\u001b[31mROJO\u001b[0m\nsegunda linea`;
    const r = assertExecutor({ ...PROPIO(SESSION_SLUG), registry: hostil }, SESSION_SLUG, ORIGEN);
    expect(r.ok).toBe(false);
    const reason = r.ok === false ? r.reason : "";
    expect(reason).not.toContain("\u001b");
    expect(reason).not.toContain("\n");
    expect(reason.length).toBeLessThan(200);
  });

  it("las claves de más del output también pasan por el filtro (mismo dueño: el agente)", () => {
    const SCHEMA = { properties: { sessionId: {} } };
    const r = assertOutputKeys(
      { sessionId: "s", ["\u001b[2Jbomba"]: 1 },
      ["sessionId"],
      SCHEMA,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).not.toContain("\u001b");
  });

  it("✅ CALIBRACIÓN: los valores REALES pasan intactos (el filtro no rompe el diagnóstico)", () => {
    // Sin esto, las filas de arriba serían verdes con un `safeEcho` que devuelve siempre `"?"`, y el
    // operador perdería el único dato por el que lee esa línea: QUIÉN ejecutó.
    expect(safeEcho("remit-kyc-session")).toBe("remit-kyc-session");
    expect(safeEcho("self-published")).toBe("self-published");
    const r = assertExecutor({ ...PROPIO(SESSION_SLUG), slug: "evil-kyc" }, SESSION_SLUG, ORIGEN);
    expect(r.ok === false && r.reason).toContain("evil-kyc");
  });

  it("✅ CALIBRACIÓN: el techo NO se dispara en el borde exacto", () => {
    // `ECHO_MAX` caracteres salen enteros y SIN sufijo; uno más ya lo lleva. Sin las dos mitades, un
    // `>=` en vez de `>` no se notaría.
    expect(safeEcho("z".repeat(ECHO_MAX))).toBe("z".repeat(ECHO_MAX));
    expect(safeEcho("z".repeat(ECHO_MAX + 1))).toBe(`${"z".repeat(ECHO_MAX)}[+1]`);
  });

  it("un homoglifo cirílico NO se imprime como si fuera el slug nuestro", () => {
    // ⚠️ Éste es el motivo por el que la lista blanca es ASCII y no «lo imprimible»: el string de
    // abajo se VE igual que el nuestro en cualquier terminal.
    expect(CIRILICO).not.toBe("remit-kyc-session");
    expect(safeEcho(CIRILICO)).toBe("remit-kyc-sessi?n");
  });

  // ⚠️ LOS TRES SITIOS QUE EL AR NO LISTÓ. MNR-4 nombra `assertExecutor`, pero el `reason` de esa
  // función no es lo único ajeno que termina en el stdout del operador: la escalera ecoa NOMBRES DE
  // PROPIEDAD del `inputSchema` publicado y el `code` del cuerpo de la respuesta. Arreglar sólo las
  // dos líneas del AR y dejar éstas sería volver a enunciar la regla sin aplicarla, que es EXACTAMENTE
  // el defecto que MNR-4 denuncia. 🧬 MUTANTE: sacarle el `safeEcho` a cualquiera de las tres ⇒ su
  // fila se pone roja con el string hostil entero adentro del `message`.
  it("la escalera: el nombre de campo no derivable sale filtrado", () => {
    const obs = corridaSana();
    obs.derive = { reason: "required-not-derivable", field: "\u001b[2Jbomba", detail: "x\ny" };
    const v = classify(obs);
    expect(v.klass).toBe("DRIFT");
    expect(v.message).not.toContain("\u001b");
    expect(v.message).not.toContain("\n");
  });

  it("la escalera: las claves `faltan` del paso de decisión salen filtradas", () => {
    const obs = corridaSana();
    obs.decisionRequired = { ok: false, faltan: ["\u001b[2Jbomba", "b".repeat(300)] };
    const v = classify(obs);
    expect(v.klass).toBe("DRIFT");
    expect(v.message).not.toContain("\u001b");
    expect(v.message).not.toContain("b".repeat(300));
  });

  it("la escalera: el `code` del cuerpo de un 402 sale filtrado", () => {
    const obs = corridaSana();
    obs.composeSession = { status: 402, body: { code: "\u001b[2Jbomba" } };
    const v = classify(obs);
    expect(v.klass).toBe("CONFIG");
    expect(v.message).not.toContain("\u001b");
  });

  it("un valor que NO es string tampoco se ecoa crudo", () => {
    // `agent.slug` es `unknown`: un array llega desde el JSON y su `String()` concatena lo que el
    // publicador quiera.
    const r = assertExecutor(
      { ...PROPIO(SESSION_SLUG), slug: ["\u001b[2J", "bomba"] },
      SESSION_SLUG,
      ORIGEN,
    );
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).not.toContain("\u001b");
  });
});

describe("assertNoBridge — PRESENCIA, no valor", () => {
  it.each([["LLM"], ["CACHE_L1"], [123], [null], [false]])("`bridgeType: %s` ⇒ rechaza", (v) => {
    expect(assertNoBridge({ output: {}, bridgeType: v }).ok).toBe(false);
  });
  it("✅ sin la clave, y con la clave en `undefined`, pasa", () => {
    expect(assertNoBridge({ output: {} })).toEqual({ ok: true });
    expect(assertNoBridge({ output: {}, bridgeType: undefined })).toEqual({ ok: true });
  });
});

describe("assertOutputKeys — cruza contra el outputSchema de la MISMA corrida", () => {
  const SCHEMA = {
    properties: { sessionId: {}, url: {}, decisionToken: {}, provenance: {} },
  };
  const CLAVES = ["sessionId", "url", "decisionToken", "provenance"] as const;
  const OUT = { sessionId: "s", url: "u", decisionToken: "t", provenance: "didit" };

  it("✅ el output completo, con su schema, pasa", () => {
    expect(assertOutputKeys(OUT, CLAVES, SCHEMA)).toEqual({ ok: true });
  });

  it("🔴 si el catálogo YA NO declara el campo, es DRIFT y no una caída", () => {
    const sinUrl = { properties: { sessionId: {}, decisionToken: {}, provenance: {} } };
    expect(assertOutputKeys(OUT, CLAVES, sinUrl)).toMatchObject({ ok: false, drift: true });
  });

  it("si el schema lo declara y el output no lo trae, NO es drift: es una caída", () => {
    const { url: _omitido, ...sinUrl } = OUT;
    expect(assertOutputKeys(sinUrl, CLAVES, SCHEMA)).toMatchObject({ ok: false, drift: false });
  });

  it("una clave de MÁS también es drift (el contrato dice EXACTAMENTE cuatro)", () => {
    expect(assertOutputKeys({ ...OUT, extra: "x" }, CLAVES, SCHEMA)).toMatchObject({
      ok: false,
      drift: true,
    });
  });
});

describe("requiredSubset — lo que se deriva del catálogo es el CONJUNTO DE CLAVES", () => {
  const LLENABLES = ["sessionId", "identityClaim", "decisionToken"];
  it("✅ los required de hoy son un subconjunto", () => {
    expect(requiredSubset({ required: ["sessionId", "decisionToken"] }, LLENABLES)).toEqual({ ok: true });
  });
  it("🔴 una clave nueva que la sonda no sabe llenar ⇒ NO es un verde", () => {
    expect(requiredSubset({ required: ["sessionId", "nonce"] }, LLENABLES)).toEqual({
      ok: false,
      faltan: ["nonce"],
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** Una corrida completa y sana, para poder romperle UNA cosa por vez. */
function corridaSana(): Observacion {
  return {
    credentialPresent: true,
    gatewayConfigured: true,
    discoverSession: { status: 200, inputSchema: { type: "object" } },
    derive: {},
    composeSession: { status: 200, body: { success: true } },
    sessionExecutor: { ok: true },
    sessionBridge: { ok: true },
    sessionShape: { ok: true },
    discoverDecision: { status: 200, inputSchema: { type: "object" } },
    decisionRequired: { ok: true },
    composeDecision: { status: 200, body: { success: true } },
    decisionExecutor: { ok: true },
    decisionBridge: { ok: true },
    decisionShape: { ok: true },
  };
}

describe("classify — la escalera, y su fila por defecto", () => {
  it("✅ la corrida sana ⇒ PASS / exit 0", () => {
    expect(classify(corridaSana())).toMatchObject({ klass: "PASS", exit: EXIT.PASS });
  });

  // 🔴 SIN ESTA FILA, UNA ENV NUESTRA QUE FALTA SE PRESENTA COMO UNA ACUSACIÓN CONTRA PRODUCCIÓN.
  // `assertExecutor` rechaza cuando no hay origen esperado (es fail-closed y tiene que serlo), así
  // que la escalera saldría por la fila de SUPLANTACIÓN. Eso sería un hallazgo FABRICADO: el mismo
  // modo de falla que ya cubría `selfTestFieldPresent`.
  // 🧬 MUTANTE: borrar la fila `agentOriginKnown === false` de la escalera ⇒ este `it` se pone rojo.
  it("🔴 sin `KYC_AGENT_BASE_URL` ⇒ CONFIG (3), NUNCA suplantación", () => {
    const obs = corridaSana();
    obs.agentOriginKnown = false;
    const v = classify(obs);
    expect(v.klass).toBe("CONFIG");
    expect(v.exit).toBe(EXIT.CONFIG);
    expect(v.exit).not.toBe(EXIT.IMPERSONATION);
    expect(v.message).toContain("KYC_AGENT_BASE_URL");
  });

  it("✅ calibración: con el origen conocido, la MISMA corrida sigue dando PASS", () => {
    const obs = corridaSana();
    obs.agentOriginKnown = true;
    expect(classify(obs)).toMatchObject({ klass: "PASS", exit: EXIT.PASS });
  });

  // El exit 6 tiene que seguir siendo ALCANZABLE, y ahora por el motivo que importa.
  it("🔴 el ejecutor rechazado CON el origen conocido sí sale SUPLANTACIÓN (6)", () => {
    const obs = corridaSana();
    obs.agentOriginKnown = true;
    obs.decisionExecutor = { ok: false, reason: "el Coordinador invocó un origen que NO es el nuestro" };
    const v = classify(obs);
    expect(v.klass).toBe("IMPERSONATION");
    expect(v.exit).toBe(EXIT.IMPERSONATION);
  });

  // 🔴 EL `it` MÁS IMPORTANTE DEL ARCHIVO, Y ESTUVO MAL ESCRITO. 🧬 MUTANTE: cambiar la ÚLTIMA fila
  // de la escalera por un PASS.
  //
  // ⚠️ CORRECCIÓN DE MI PROPIA EVIDENCIA, medida el 2026-08-26 y no razonada. Acá había un caso con
  // una observación VACÍA y el comentario decía que mataba ese mutante. **Lo corrí: NO lo mata.** Una
  // observación vacía no llega al default —sale MUCHO antes, por la fila "no se llegó a consultar el
  // catálogo"—, así que sigue dando DOWN con el mutante puesto y el `it` quedaba verde afirmando lo
  // contrario. Era un candado sobre una fila que no era la que decía vigilar.
  //
  // La observación que SÍ alcanza el default es ésta: todo el recorrido contestó bien, y aun así
  // ninguna de las cuatro verificaciones positivas se hizo. Con el mutante puesto, esto da PASS.
  it("🔴 un recorrido entero SIN ninguna verificación positiva NO es PASS (llega al default)", () => {
    const obs = corridaSana();
    obs.sessionExecutor = undefined;
    obs.sessionShape = undefined;
    obs.decisionExecutor = undefined;
    obs.decisionShape = undefined;
    const v = classify(obs);
    expect(v.klass).not.toBe("PASS");
    expect(v.exit).toBe(EXIT.DOWN);
  });

  it("🔴 ni siquiera con UNA sola verificación faltando (el ejecutor de la decisión)", () => {
    const obs = corridaSana();
    obs.decisionExecutor = undefined;
    const v = classify(obs);
    expect(v.exit).toBe(EXIT.DOWN);
  });

  // La fila de "ni siquiera se consultó el catálogo" existe aparte, y se mide aparte: no es el
  // default, y confundir las dos fue exactamente el error de arriba.
  it("una observación vacía sale por su PROPIA fila (no por el default), y tampoco es PASS", () => {
    const v = classify({ credentialPresent: true, gatewayConfigured: true });
    expect(v.exit).toBe(EXIT.DOWN);
    expect(v.message).toContain("no se llegó a consultar el catálogo");
  });

  it.each<[string, (o: Observacion) => void, number]>([
    ["sin credencial", (o) => { o.credentialPresent = false; }, EXIT.CONFIG],
    ["gateway sin configurar", (o) => { o.gatewayConfigured = false; }, EXIT.CONFIG],
    ["/discover caído (5xx)", (o) => { o.discoverSession = { status: 503 }; }, EXIT.DOWN],
    ["/discover sin schema", (o) => { o.discoverSession = { status: 200 }; }, EXIT.DRIFT],
    ["/discover 404", (o) => { o.discoverSession = { status: 404 }; }, EXIT.DRIFT],
    ["/discover 403 del borde", (o) => { o.discoverSession = { status: 403, inputSchema: {} }; }, EXIT.DOWN],
    ["campo requerido no derivable", (o) => { o.derive = { reason: "required-not-derivable", field: "x", detail: "d" }; }, EXIT.DRIFT],
    ["402 del gateway", (o) => { o.composeSession = { status: 402 }; }, EXIT.CONFIG],
    ["403 INSUFFICIENT_BUDGET", (o) => { o.composeSession = { status: 403, body: { error_code: "INSUFFICIENT_BUDGET" } }; }, EXIT.CONFIG],
    ["el agente rechazó el input derivado", (o) => { o.composeSession = { status: 400, body: { agentFailure: "INPUT_REJECTED" } }; }, EXIT.DRIFT],
    ["el agente falló", (o) => { o.composeSession = { status: 400, body: { agentFailure: "AGENT_ERROR" } }; }, EXIT.DOWN],
    ["422 sin campo que atribuya", (o) => { o.composeSession = { status: 422, body: { reason: "no_candidates" } }; }, EXIT.DOWN],
    ["200 con success:false", (o) => { o.composeSession = { status: 200, body: { success: false } }; }, EXIT.DOWN],
    ["red caída", (o) => { o.composeSession = { networkError: "ECONNRESET" }; }, EXIT.DOWN],
    ["🔴 SUPLANTACIÓN en sesión", (o) => { o.sessionExecutor = { ok: false, reason: "ejecutó otro" }; }, EXIT.IMPERSONATION],
    ["🔴 SUPLANTACIÓN en decisión", (o) => { o.decisionExecutor = { ok: false, reason: "ejecutó otro" }; }, EXIT.IMPERSONATION],
    ["bridge reportado", (o) => { o.sessionBridge = { ok: false, reason: "hubo bridge" }; }, EXIT.DRIFT],
    ["el outputSchema ya no declara un campo", (o) => { o.sessionShape = { ok: false, drift: true, reason: "r" }; }, EXIT.DRIFT],
    ["200 con un output que no es el contrato", (o) => { o.sessionShape = { ok: false, drift: false, reason: "r" }; }, EXIT.DOWN],
    ["la decisión pide una clave nueva", (o) => { o.decisionRequired = { ok: false, faltan: ["nonce"] }; }, EXIT.DRIFT],
  ])("%s ⇒ exit %d", (_caso, romper, esperado) => {
    const obs = corridaSana();
    romper(obs);
    const v = classify(obs);
    expect(v.exit).toBe(esperado);
    expect(v.klass).not.toBe("PASS");
  });
});

describe("el envoltorio de self-test NUNCA puede terminar en 0", () => {
  it("🔴 el campo que se pidió romper NO estaba en el cuerpo ⇒ CONFIG, no un hallazgo FABRICADO", () => {
    // Sin esta fila, un typo en el interruptor compra un hallazgo que nadie midió: el cuerpo habría
    // salido entero y conforme, y el gateway lo habría aceptado CON RAZÓN.
    const obs = corridaSana();
    obs.selfTestField = "identityRefff";
    obs.selfTestFieldPresent = false;
    expect(classify(obs)).toMatchObject({ klass: "CONFIG", exit: EXIT.CONFIG });
  });

  it("🔴 el cuerpo roto fue ACEPTADO ⇒ SELF-TEST / exit 5, jamás 0", () => {
    const obs = corridaSana();
    obs.selfTestField = "sessionId";
    obs.selfTestFieldPresent = true;
    expect(classify(obs)).toMatchObject({ klass: "SELF-TEST", exit: EXIT.SELF_TEST });
  });

  it("el cuerpo roto fue RECHAZADO ⇒ sale la clase del rechazo, no PASS", () => {
    const obs = corridaSana();
    obs.selfTestField = "sessionId";
    obs.selfTestFieldPresent = true;
    obs.composeDecision = { status: 400, body: { agentFailure: "INPUT_REJECTED" } };
    const v = classify(obs);
    expect(v.exit).toBe(EXIT.DRIFT);
    expect(v.klass).not.toBe("PASS");
  });

  it("NINGUNA combinación con self-test encendido devuelve 0", () => {
    // El barrido cierra el enunciado entero, no una fila: si mañana alguien agrega una rama que
    // vuelve PASS con el self-test puesto, esto se pone rojo.
    const variantes: Observacion[] = [];
    for (const present of [true, false, undefined]) {
      for (const romper of [
        (_o: Observacion): void => {},
        (o: Observacion): void => {
          o.composeDecision = { status: 400 };
        },
        (o: Observacion): void => {
          o.decisionExecutor = { ok: false, reason: "x" };
        },
      ]) {
        const o = corridaSana();
        o.selfTestField = "sessionId";
        o.selfTestFieldPresent = present;
        romper(o);
        variantes.push(o);
      }
    }
    expect(variantes).toHaveLength(9);
    for (const o of variantes) expect(classify(o).exit).not.toBe(EXIT.PASS);
  });
});
