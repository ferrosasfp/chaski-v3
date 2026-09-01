#!/usr/bin/env node
// WKH-372 · W3.3 — EL GATE DE DESPLIEGUE DE LA OLA. Habla con el SERVIDOR DE VERDAD.
//
// 🔴 POR QUÉ EXISTE Y POR QUÉ `npm test` NO LO REEMPLAZA. Este repo no tiene suite e2e de navegador y
// sus tests doblan `fetch` con `vi.stubGlobal`. **Un test con un doble no prueba el cableado.** W3
// cambia un CONTRATO cliente-servidor, así que hace falta un instrumento que hable con el servidor.
//
// ⛔ SU LLAMADOR, NOMBRADO Y SIN ADORNOS: se corre A MANO con
//
//   node scripts/probe-sesion-de-posesion.mjs https://<el-deploy-de-W3.2>
//
// ⛔ NO ESTÁ CABLEADO A CI, y no se afirma que lo esté.
//
// LAS TRES AFIRMACIONES, contra el deploy de W3.2 y con `PAYOUT_SESSION_SECRET` ya puesta:
//   (a) un PoP VÁLIDO atraviesa el gate de identidad ⇒ no se rompió nada.
//   (b) una SESIÓN emitida por ESE MISMO servidor produce el MISMO desenlace que (a).
//   (c) ni sesión ni PoP ⇒ 403, con el MISMO cuerpo para tres `kycVerificationId` distintos.
//
// CÓDIGOS DE SALIDA — la atribución es el punto de este script:
//   exit 0    las tres afirmaciones ok
//   exit 10   (b) el servidor NO acepta la sesión
//   exit 11   (a) se rompió el camino del PoP
//   exit 12   (c) dejó de cortar
//   exit 30   EL INSTRUMENTO NO PUDO CORRER
//
// ⛔ `exit 30` NO ES UN VERDE. Es la lección del cero uniforme: un barrido que no ejecutó nada y uno
// que no encontró nada se ven igual. Causas típicas: la URL no responde, la env todavía no está
// puesta (el 200 no trae `sesion`), el deploy no terminó, no hay red. Ninguna de esas es «pasó».
//
// ⚠️ LOS TRES LÍMITES, escritos ANTES de que alguien se apoye en su `exit 0`:
//   1. Corre desde una CONSOLA, no desde un teléfono. No dice NADA sobre Phantom ni sobre MWA.
//   2. NO prueba la UI: no monta la pantalla y no ve un solo prompt de billetera. Que la persona
//      firme UNA vez en vez de dos lo miden los `it` de `src/presentation/`, no esto.
//   3. NO dice cuánto tarda un recorrido real, así que NO contesta si 30 minutos de TTL alcanzan.
//
// 🔴 CORRECCIÓN MEDIDA AL STORY FILE (§0.3), porque cambia quién vigila este archivo. Ahí decía que
// `lint` = `biome lint src app scripts` ⇒ *«el `.mjs` nuevo SÍ se lintea»*. **ES FALSO.**
// `biome.jsonc` → `files.includes` enumera SÓLO `src/**/*.ts(x)`, `app/**/*.ts(x)` y
// `scripts/**/*.ts(x)`: medido, `./node_modules/.bin/biome lint scripts/probe-sesion-de-posesion.mjs`
// contesta *«No files were processed … These paths were provided but ignored»*. Y `typecheck:scripts`
// tampoco lo mira (`tsconfig.scripts.json` incluye `scripts/**/*.ts`).
// ⇒ **ESTE ARCHIVO NO LO REVISA NINGUNA HERRAMIENTA DEL GATE.** Es preexistente (le pasa igual a
// `scripts/probe-vuelta-por-enlace.mjs`), no lo introduce W3, y ⛔ no se «arregla» ensanchando el
// includes de biome dentro de esta ola. Lo que se hizo en su lugar, y queda como su único control
// automático: `node --check` (parsea) y las DOS auto-pruebas del camino de `exit 30` —sin URL, y con
// una URL que no responde—, las dos verificadas devolviendo 30.
//
// ✅ Y LO QUE ESTE SCRIPT **NO HACE**, dicho porque apunta al money-path: NO crea ninguna orden de
// payout y NO mueve un centavo. Usa una billetera RECIÉN GENERADA, que por construcción no tiene fila
// de veredicto de KYC, así que las tres afirmaciones se resuelven en el gate de identidad y la ruta
// corta antes de hablar con ningún agente. Lo que se compara es EN QUÉ GUARD corta, no si paga.
import nacl from "tweetnacl";
import bs58 from "bs58";

const BASE = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!BASE) {
  console.error("uso: node scripts/probe-sesion-de-posesion.mjs <URL-del-deploy>");
  process.exit(30);
}

/** Todo fallo del INSTRUMENTO sale por acá. ⛔ Nunca por un `catch` que devuelva un valor por default:
 *  un default convertiría «no pude preguntar» en «la respuesta es no», que es el modo de falla que
 *  este script existe para no tener. */
function noSePudoCorrer(motivo, detalle) {
  console.error(`\n[exit 30] EL INSTRUMENTO NO PUDO CORRER — ⛔ ESTO NO ES UN VERDE.\n  ${motivo}`);
  if (detalle !== undefined) console.error(`  detalle: ${String(detalle)}`);
  process.exit(30);
}

async function postear(ruta, cuerpo) {
  let res;
  try {
    res = await fetch(`${BASE}${ruta}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
  } catch (e) {
    return noSePudoCorrer(`no hubo respuesta de ${ruta}`, e);
  }
  const texto = await res.text();
  return { status: res.status, texto };
}

function leerJson(r, ruta) {
  try {
    return JSON.parse(r.texto);
  } catch {
    return noSePudoCorrer(`${ruta} contestó ${r.status} con un cuerpo que no es JSON`, r.texto.slice(0, 200));
  }
}

// ── La billetera del probe: RECIÉN GENERADA, y ésa es la garantía de que no toca plata de nadie ────
const kp = nacl.sign.keyPair();
const DIRECCION = bs58.encode(kp.publicKey);

const cuerpoBase = {
  remittanceId: `probe-${Date.now()}`,
  quoteId: "probe-quote",
  address: DIRECCION,
  amountUsd: 1,
  beneficiary: { name: "Probe", country: "PE", method: "yape", destination: "000000000" },
  idempotencyKey: `probe-${Date.now()}`,
};

console.log(`probe de la sesión de posesión · ${BASE}\n  billetera efímera: ${DIRECCION}`);

// ── 0 · Un PoP real, firmado con la billetera efímera ──────────────────────────────────────────────
const desafio = await postear("/api/a2a/payout/challenge", { address: DIRECCION });
if (desafio.status !== 200) {
  noSePudoCorrer(`el emisor del desafío contestó ${desafio.status} (¿falta PAYOUT_POP_SECRET?)`, desafio.texto);
}
const { popChallenge, popMessage } = leerJson(desafio, "/api/a2a/payout/challenge");
if (typeof popChallenge !== "string" || typeof popMessage !== "string") {
  noSePudoCorrer("el desafío no trae `popChallenge`/`popMessage`");
}
const popSignature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(popMessage), kp.secretKey));

// ── (a) EL CAMINO DEL PoP SIGUE ENTERO ─────────────────────────────────────────────────────────────
const conPop = await postear("/api/payout/prepare", { ...cuerpoBase, popChallenge, popSignature });
if (conPop.status === 503) {
  noSePudoCorrer("`prepare` contestó 503: es configuración del servidor, no un veredicto", conPop.texto);
}
if (conPop.status === 429) noSePudoCorrer("`prepare` contestó 429: el rate-limit tapó la medición");
const errorConPop = leerJson(conPop, "/api/payout/prepare").error;
if (errorConPop === "payout_pop_unverified") {
  console.error(`\n[exit 11] (a) SE ROMPIÓ EL CAMINO DEL PoP: un PoP válido fue rechazado por el gate de identidad.`);
  console.error(`  respuesta: ${conPop.status} ${conPop.texto}`);
  process.exit(11);
}
console.log(`  (a) PoP válido ⇒ ${conPop.status} ${errorConPop ?? "(200)"} — atravesó el gate de identidad`);

// ── (b) LA SESIÓN QUE EMITE ESTE MISMO SERVIDOR ────────────────────────────────────────────────────
const veredicto = await postear("/api/kyc/verdict", { sender: DIRECCION, popChallenge, popSignature });
if (veredicto.status !== 200) {
  noSePudoCorrer(`\`/api/kyc/verdict\` contestó ${veredicto.status}: no hay sesión que probar`, veredicto.texto);
}
const sesion = leerJson(veredicto, "/api/kyc/verdict").sesion;
if (typeof sesion !== "string" || !sesion) {
  noSePudoCorrer("el 200 de `/api/kyc/verdict` NO trae `sesion`: falta `PAYOUT_SESSION_SECRET` en el servidor");
}
const conSesion = await postear("/api/payout/prepare", { ...cuerpoBase, sessionToken: sesion });
const errorConSesion = leerJson(conSesion, "/api/payout/prepare").error;
if (conSesion.status !== conPop.status || errorConSesion !== errorConPop) {
  console.error(`\n[exit 10] (b) EL SERVIDOR NO ACEPTA LA SESIÓN: el desenlace no coincide con el del PoP.`);
  console.error(`  con PoP:    ${conPop.status} ${conPop.texto}`);
  console.error(`  con sesión: ${conSesion.status} ${conSesion.texto}`);
  console.error(`  ⛔ NO DESPLEGAR EL CLIENTE DE W3.4: dejaría de mandar la prueba vieja antes de que`);
  console.error(`     el servidor acepte la nueva, y eso es 403 para TODOS.`);
  process.exit(10);
}
console.log(`  (b) sesión válida ⇒ ${conSesion.status} ${errorConSesion ?? "(200)"} — mismo desenlace que (a)`);

// ── (c) SIN NADA: 403 OPACO, IGUAL PARA LOS TRES ───────────────────────────────────────────────────
const sinNada = [];
for (const id of ["probe-id-inventado", "probe-id-ajeno", `probe-id-${Date.now()}`]) {
  const r = await postear("/api/payout/prepare", { ...cuerpoBase, kycVerificationId: id });
  sinNada.push(`${r.status}|${r.texto}`);
}
const primero = sinNada[0];
if (!primero.startsWith("403|") || !sinNada.every((x) => x === primero)) {
  console.error(`\n[exit 12] (c) DEJÓ DE CORTAR, o las respuestas se distinguen entre sí.`);
  for (const x of sinNada) console.error(`  ${x}`);
  process.exit(12);
}
console.log(`  (c) sin credencial ⇒ ${primero} — idéntico para los tres identificadores`);

console.log("\n[exit 0] las tres afirmaciones ok. El servidor acepta la sesión: W3.4 puede arrancar.");
process.exit(0);
