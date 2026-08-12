// Tests de las piezas puras del smoke (`scripts/smoke-helpers.ts`). El smoke en sí NO se testea acá:
// toca la red y exige credenciales. Lo que sí se puede clavar es lo que se puede equivocar en
// silencio: el formato del HMAC del release, la validación de una env numérica y la de una signature.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as anchor from "@coral-xyz/anchor";
import { describe, expect, it } from "vitest";
import { REAL_PAYOUT_PROVENANCES, isPayoutDemo } from "../src/presentation/flow-vm";
import {
  KNOWN_NON_REAL_PAYOUT_PROVENANCES,
  classifyPayoutProvenance,
  computeReleaseAttestation,
  encodeReleaseAttestationMessage,
  isBase58Signature,
  parseNumericEnv,
  resolveAnchorBn,
  usdToUsdcMinorUnits,
} from "./smoke-helpers";

describe("atestación de release (espejo del facilitator)", () => {
  it("el mensaje lleva el largo del remittanceId adelante (encoding del facilitator)", () => {
    expect(encodeReleaseAttestationMessage("m5-smoke-1", "SENDER")).toBe("10:m5-smoke-1SENDER");
  });

  it("el encoding es INYECTIVO: el corte naive por ':' colisiona y este no", () => {
    // Con `${remittanceId}:${sender}` los dos casos dan "a:b:c" y una atestación sería replayable
    // cruzando escrows. Con el largo adelante son mensajes distintos.
    expect(encodeReleaseAttestationMessage("a:b", "c")).not.toBe(
      encodeReleaseAttestationMessage("a", "b:c"),
    );
  });

  it("vector fijo: si alguien cambia el encoding o el algoritmo, esto se pone rojo", () => {
    // Valor calculado con la MISMA fórmula que wasiai-facilitator/src/routes/solana-escrow.ts:97-105.
    // Si el facilitator cambia su encoding, el smoke empieza a mandar atestaciones que el facilitator
    // rechaza con 422, y este test es lo único del lado de chaski que puede avisarlo antes.
    expect(
      computeReleaseAttestation(
        "m5-smoke-1",
        "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        "secreto-de-prueba",
      ),
    ).toBe("ce1baa8bd9ee4c7a5c385b032026c1fe1483b0c54f6430faea9c4948b8cc30a1");
  });

  it("cambiar el sender cambia la atestación (está atada a las dos partes)", () => {
    const a = computeReleaseAttestation("r-1", "SENDER-A", "s");
    const b = computeReleaseAttestation("r-1", "SENDER-B", "s");
    expect(a).not.toBe(b);
  });
});

describe("validación base58 de una signature", () => {
  it("acepta una signature real de devnet", () => {
    expect(
      isBase58Signature(
        "22A61CyncHSGGHHDujNVJUvrgx8wxETSaGzPFdHrE9WMxatsxr4vNTg6JFesBQdBdbycTj6iF3gX2eoRY65JcFnN",
      ),
    ).toBe(true);
  });

  it("rechaza lo que un `typeof === string` dejaba pasar", () => {
    for (const bad of ["", "   ", "no-base58-porque-tiene-0-y-l: 0l", "corta"]) {
      expect(isBase58Signature(bad)).toBe(false);
    }
    expect(isBase58Signature(null)).toBe(false);
    expect(isBase58Signature(123)).toBe(false);
  });

  it("rechaza los caracteres que base58 excluye a propósito (0, O, I, l)", () => {
    const base = "22A61CyncHSGGHHDujNVJUvrgx8wxETSaGzPFdHrE9WMxatsxr4vNTg6JFesBQdBdbycTj6iF3gX2eoRY65JcFnN";
    for (const ch of ["0", "O", "I", "l"]) {
      expect(isBase58Signature(base.slice(1) + ch)).toBe(false);
    }
  });
});

describe("parseNumericEnv", () => {
  it("parsea un valor válido", () => {
    expect(parseNumericEnv("SMOKE_AMOUNT_USD", "10")).toEqual({ ok: true, value: 10 });
    expect(parseNumericEnv("SMOKE_AMOUNT_USD", " 2.5 ")).toEqual({ ok: true, value: 2.5 });
  });

  it("un valor no numérico NO devuelve NaN: devuelve un error que NOMBRA la env", () => {
    const r = parseNumericEnv("SMOKE_DEADLINE_SECONDS", "una hora");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("SMOKE_DEADLINE_SECONDS");
  });

  it("el motivo NUNCA incluye el valor de la env", () => {
    const r = parseNumericEnv("SMOKE_AMOUNT_USD", "valor-secreto-que-no-debe-salir");
    expect(r.ok === false && r.reason).not.toContain("valor-secreto-que-no-debe-salir");
  });

  it("ausente o vacía es error (no cae a un default silencioso)", () => {
    expect(parseNumericEnv("X", undefined).ok).toBe(false);
    expect(parseNumericEnv("X", "").ok).toBe(false);
    expect(parseNumericEnv("X", "   ").ok).toBe(false);
  });

  it("Infinity y NaN explícitos son error", () => {
    expect(parseNumericEnv("X", "Infinity").ok).toBe(false);
    expect(parseNumericEnv("X", "NaN").ok).toBe(false);
  });

  it("aplica integer y min", () => {
    expect(parseNumericEnv("X", "3.5", { integer: true }).ok).toBe(false);
    expect(parseNumericEnv("X", "0", { min: 1 }).ok).toBe(false);
    expect(parseNumericEnv("X", "1", { integer: true, min: 1 })).toEqual({ ok: true, value: 1 });
  });

  it("aplica max: un deadline por encima del techo del programa muere ACÁ, no on-chain", () => {
    // Sin `max`, un SMOKE_DEADLINE_SECONDS mayor a MAX_CUSTODY_SECS (86400) se descubría como un
    // rechazo opaco del programa recién en el checkpoint 5.
    expect(parseNumericEnv("SMOKE_DEADLINE_SECONDS", "86401", { max: 86400 }).ok).toBe(false);
    expect(parseNumericEnv("SMOKE_DEADLINE_SECONDS", "86400", { max: 86400 })).toEqual({
      ok: true,
      value: 86400,
    });
    const r = parseNumericEnv("SMOKE_DEADLINE_SECONDS", "999999", { max: 86400 });
    expect(r.ok === false && r.reason).toContain("SMOKE_DEADLINE_SECONDS");
    expect(r.ok === false && r.reason).not.toContain("999999"); // CD-4: nunca el valor
  });
});

describe("usdToUsdcMinorUnits", () => {
  it("convierte a 6 decimales", () => {
    expect(usdToUsdcMinorUnits(10)).toBe(10_000_000n);
    expect(usdToUsdcMinorUnits(0.5)).toBe(500_000n);
  });
});

describe("resolveAnchorBn — el import que tenía trabado al smoke en el checkpoint 3", () => {
  // ⚠️ LEER ANTES DE "SIMPLIFICAR" ESTOS TESTS.
  //
  // Bajo vitest (Vite) `anchor.BN` es una función, así que un test que sólo hiciera
  // `expect(typeof anchor.BN).toBe("function")` pasaría en verde y NO diría nada del bug: el smoke
  // corre con `tsx` (Node ESM cargando el CJS de anchor), y AHÍ `anchor.BN` es `undefined`. Medido en
  // los dos runtimes, no deducido. Por eso los casos de abajo le pasan a la función las DOS formas del
  // módulo a mano: así el test dice lo mismo corra donde corra.
  const fakeBn = function FakeBN(): void {
    /* sólo importa que sea `function` */
  };

  it("forma BUNDLER (webpack/Vite): toma el export nombrado", () => {
    expect(resolveAnchorBn({ BN: fakeBn })).toBe(fakeBn);
  });

  it("forma tsx/Node ESM→CJS: sin export nombrado, lo saca de `default` (ESTE era el caso roto)", () => {
    // Réplica exacta del namespace que Node arma para anchor 0.30.1: `BorshAccountsCoder` y `Program`
    // sí viajan como nombrados, `BN` no, y `default` es el `module.exports` entero.
    const nodeShape = {
      BorshAccountsCoder: fakeBn,
      Program: fakeBn,
      default: { BN: fakeBn, BorshAccountsCoder: fakeBn, Program: fakeBn },
    };
    expect(resolveAnchorBn(nodeShape)).toBe(fakeBn);
  });

  it("si BN no está en ninguna de las dos formas, TIRA en vez de devolver undefined", () => {
    // Devolver `undefined` es lo que producía `TypeError: anchor.BN is not a constructor` tres líneas
    // más abajo, sin nombrar la causa. El error tiene que apuntar a anchor, no a una línea cualquiera.
    expect(() => resolveAnchorBn({ Program: fakeBn })).toThrow(/@coral-xyz\/anchor/);
    expect(() => resolveAnchorBn({ BN: "no soy una función" })).toThrow(/BN/);
    expect(() => resolveAnchorBn(null)).toThrow();
    expect(() => resolveAnchorBn(undefined)).toThrow();
  });

  it("contra el módulo REAL devuelve un BN construible desde string decimal", () => {
    const BN = resolveAnchorBn(anchor);
    expect(new BN("123456789012345678901234567890").toString()).toBe(
      "123456789012345678901234567890",
    );
  });

  it("el smoke NO vuelve a usar `anchor.BN` directo (lo único que puede vigilar esto es el fuente)", () => {
    // No hay test de comportamiento que atrape esta regresión: bajo vitest `anchor.BN` funciona, así
    // que un smoke que volviera a `new anchor.BN(...)` daría verde acá y rojo con `tsx`. Lo único
    // observable desde el runner es el texto del script.
    const src = readFileSync(
      fileURLToPath(new URL("./smoke-solana-e2e.ts", import.meta.url)),
      "utf8",
    );
    const offenders = src
      .split("\n")
      .map((line, i) => ({ n: i + 1, line }))
      .filter(({ line }) => /\bnew\s+anchor\.BN\b/.test(line) && !line.trimStart().startsWith("//"));
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
    // Y que efectivamente pase por el resolver (si alguien borra la llamada, esto se pone rojo).
    expect(src).toContain("resolveAnchorBn(anchor)");
  });
});

describe("el default del deadline del smoke sale de producción, no de un literal", () => {
  // El segundo muro, después del import: el default era `"3600"`, el piso EXACTO del programa
  // (`MIN_CUSTODY_SECS`, solana-programs/programs/escrow/src/lib.rs:121). El `now` que el programa
  // compara es el del validador al EJECUTAR, así que `now_cliente + 3600` ya está por debajo apenas
  // pasa un segundo y el depósito muere con `DeadlineTooSoon`. Producción arregló esa carrera
  // (CUSTODY_WINDOW_SECS = 2 h, con su propio test en (`CUSTODY_WINDOW_SECS`, `solana-wallet.test.ts:506`)) y el smoke se
  // quedó con el valor viejo.
  //
  // Esto se vigila leyendo el fuente porque el default vive en el módulo del smoke, y ese módulo
  // `process.exit(1)` en su primer statement: importarlo desde un test mata al runner.
  const src = readFileSync(fileURLToPath(new URL("./smoke-solana-e2e.ts", import.meta.url)), "utf8");

  it("usa CUSTODY_WINDOW_SECS de producción como default", () => {
    expect(src).toContain("process.env.SMOKE_DEADLINE_SECONDS ?? String(CUSTODY_WINDOW_SECS)");
  });

  it("no vuelve al literal que perdía la carrera", () => {
    expect(src).not.toContain('process.env.SMOKE_DEADLINE_SECONDS ?? "3600"');
  });
});

describe("classifyPayoutProvenance — el guard que era una denylist de un solo valor", () => {
  // QUÉ ESTABA MAL, para que no vuelva: el smoke abortaba sólo con `provenance === "transfi"`. Eso es
  // una DENYLIST de UN valor sobre un dato que elige un agente remoto, o sea "cualquier string".
  // Producción usa el mismo dato como ALLOWLIST (`REAL_PAYOUT_PROVENANCES`, `flow-vm.ts:25`). Con la
  // denylist, "transfi-v2" o "TransFi" seguían de largo Y el script IMPRIMÍA que la pata fiat estaba
  // en mock. Los casos de abajo son exactamente esos.

  it("un valor de la allowlist REAL de producción aborta, y el motivo dice por qué", () => {
    const v = classifyPayoutProvenance("transfi");
    expect(v.kind).toBe("real");
    expect(v.kind).not.toBe("no-real"); // "no-real" es lo ÚNICO que deja seguir la corrida
    expect(v.reason).toContain("REAL_PAYOUT_PROVENANCES");
    expect(v.reason).toContain("src/presentation/flow-vm.ts:25");
  });

  it("TODO valor de REAL_PAYOUT_PROVENANCES aborta (si producción suma un proveedor, entra solo)", () => {
    // Este es el test que se pone rojo si alguien saca "transfi" del Set de producción: la lista deja
    // de estar vacía de sentido y el guard deja de estar cableado a ella.
    expect(REAL_PAYOUT_PROVENANCES.size).toBeGreaterThan(0);
    for (const real of REAL_PAYOUT_PROVENANCES) {
      expect(classifyPayoutProvenance(real).kind).toBe("real");
    }
  });

  it("un proveedor real NUEVO o una variante de versión NO se declara mock: aborta", () => {
    // Con la denylist vieja los tres pasaban de largo y el script imprimía "no se moverá dinero fiat".
    for (const desconocida of ["transfi-v2", "algo-nuevo", "wise", "transfi2", "TRANSFI"]) {
      const v = classifyPayoutProvenance(desconocida);
      expect(v.kind).toBe("desconocida");
      expect(v.reason).toContain(desconocida);
      expect(v.reason).toContain("no se puede descartar que sea un desembolso real");
    }
  });

  it("otra capitalización: aborta como DESCONOCIDA, sin normalizar (misma comparación que producción)", () => {
    // Decisión y su motivo: NO se pasa a minúsculas. Producción compara exacto
    // (`REAL_PAYOUT_PROVENANCES.has`, `flow-vm.ts:30`), así que normalizar acá haría que las dos capas opinaran distinto del MISMO
    // string. No hace falta para la seguridad: con la allowlist, "TransFi" tampoco está entre las
    // no-reales conocidas y aborta igual. Las dos capas caen de su lado seguro sin contradecirse.
    expect(REAL_PAYOUT_PROVENANCES.has("TransFi")).toBe(false); // producción: no es "real"…
    expect(isPayoutDemo("TransFi")).toBe(true); //                 …y por eso sobre-avisa (banner demo)
    expect(classifyPayoutProvenance("TransFi").kind).toBe("desconocida"); // el smoke: aborta
    expect(classifyPayoutProvenance("Transfi").kind).toBe("desconocida");
    expect(classifyPayoutProvenance(" transfi").kind).toBe("desconocida"); // con espacio tampoco pasa
  });

  it("las proveniencias no-reales conocidas siguen dejando correr el smoke", () => {
    expect([...KNOWN_NON_REAL_PAYOUT_PROVENANCES]).toEqual([
      "local-fallback",
      "devnet-stub",
      "n/a",
    ]);
    for (const mock of KNOWN_NON_REAL_PAYOUT_PROVENANCES) {
      expect(classifyPayoutProvenance(mock).kind).toBe("no-real");
    }
  });

  it("ausente / vacío / null: ABORTA, porque falta de dato no es prueba de simulación", () => {
    // Decisión explícita. `""` no significa "mock": significa "el agente no declaró proveniencia"
    // (supabase-settlement-ledger.ts:69-71 lo guarda como NULL por ese mismo motivo). Tratarlo como
    // mock sería el mismo error que este cambio arregla, con otra ropa. Además el smoke YA abortaba
    // con "" antes de este cambio, por el shape-check del checkpoint 3: acá no se afloja nada.
    for (const ausente of [undefined, null, "", "   "]) {
      const v = classifyPayoutProvenance(ausente);
      expect(v.kind).toBe("ausente");
      expect(v.reason).toContain("no declaró");
    }
  });

  it("el motivo del caso que SIGUE no promete nada universal ni futuro", () => {
    // La frase vieja era: «el único valor que significa fiat real es "transfi" […] no se movió ni se
    // moverá dinero fiat». Dos afirmaciones que el script no puede sostener: una universal sobre un
    // dominio abierto, y una sobre el futuro de un sistema ajeno. La nueva acota lo que afirma.
    const reason = classifyPayoutProvenance("devnet-stub").reason;
    expect(reason).not.toContain("el único valor");
    expect(reason).not.toContain("no se moverá");
    expect(reason).toContain("Eso es TODO lo que afirma este chequeo");
    expect(reason).toContain("No dice qué hizo el agente con la orden de payout");
  });
});

describe("el guard de la proveniencia está CABLEADO al smoke (no es una función suelta)", () => {
  const smokeSrc = readFileSync(
    fileURLToPath(new URL("./smoke-solana-e2e.ts", import.meta.url)),
    "utf8",
  );

  it("el checkpoint 3 llama al clasificador y sigue SÓLO con 'no-real'", () => {
    expect(smokeSrc).toContain("classifyPayoutProvenance(provenance)");
    expect(smokeSrc).toContain('provenanceVerdict.kind !== "no-real"');
  });

  it("no volvió la denylist de un solo valor ni una copia del Set de producción", () => {
    // Una segunda copia de la lista es exactamente cómo se desincronizan las dos capas: el único
    // acceso al conjunto real es el import de flow-vm, así que NINGUNA línea de código (los
    // comentarios sí pueden nombrarlo) puede traer el valor escrito a mano.
    const helpersSrc = readFileSync(
      fileURLToPath(new URL("./smoke-helpers.ts", import.meta.url)),
      "utf8",
    );
    const codeLines = (src: string): string[] =>
      src.split("\n").filter((l) => {
        const t = l.trimStart();
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
      });
    const offenders = [...codeLines(smokeSrc), ...codeLines(helpersSrc)].filter((l) =>
      /transfi/i.test(l),
    );
    expect(offenders).toEqual([]);
    expect(smokeSrc).not.toContain('provenance === "transfi"');
    expect(helpersSrc).toContain(
      'import { REAL_PAYOUT_PROVENANCES } from "../src/presentation/flow-vm"',
    );
  });

  it("la frase que afirmaba de más ya no se imprime en ningún lado del script", () => {
    expect(smokeSrc).not.toContain("el único valor que significa fiat real");
    expect(smokeSrc).not.toContain("no se movió ni se moverá dinero fiat");
  });

  it("cada `flow-vm.ts:NN` citado en scripts/ apunta a la línea que dice (candado anti-drift)", () => {
    // El hallazgo traía este detalle: el script citaba `flow-vm.ts:7` y la constante estaba en la 17.
    // Una cita a mano se desactualiza sola; esto lo vuelve mecánico.
    const flowVm = readFileSync(
      fileURLToPath(new URL("../src/presentation/flow-vm.ts", import.meta.url)),
      "utf8",
    ).split("\n");
    const cites: string[] = [];
    for (const file of ["./smoke-helpers.ts", "./smoke-solana-e2e.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      for (const m of src.matchAll(/flow-vm\.ts:(\d+)/g)) {
        const n = Number(m[1]);
        const line = flowVm[n - 1] ?? "";
        cites.push(`${file}:${n} → ${line.trim()}`);
      }
    }
    expect(cites.length).toBeGreaterThan(0);
    for (const cite of cites) {
      expect(cite).toMatch(/REAL_PAYOUT_PROVENANCES/);
    }
  });
});

describe("el smoke CARGA bajo `tsx`, que es el runtime con el que corre de verdad", () => {
  // ⚠️ POR QUÉ ESTO CORRE UN PROCESO EN VEZ DE IMPORTAR: bajo vitest (Vite) el interop de módulos se
  // resuelve distinto que bajo `tsx` (Node ESM). Ya pasó en este mismo archivo con `anchor.BN`: verde
  // en vitest, `TypeError` en la corrida real. El guard nuevo agregó un import de `scripts/` hacia
  // `src/presentation/flow-vm`, y que ese import resuelva bajo Vite NO prueba que resuelva bajo tsx.
  // Lo único que lo prueba es cargarlo con tsx, y eso es barato: el smoke `process.exit(1)` en su
  // primer statement si falta el opt-in, DESPUÉS de evaluar todos los imports y ANTES de cualquier red.
  it("sin SMOKE_ALLOW_REAL llega al abort del opt-in (o sea: todo el grafo de imports cargó)", () => {
    const res = spawnSync(
      fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url)),
      [fileURLToPath(new URL("./smoke-solana-e2e.ts", import.meta.url))],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, SMOKE_ALLOW_REAL: "" }, // nunca "true": no toca la red ni crea órdenes
      },
    );
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    // El exit 1 solo NO alcanza: un import roto también sale 1. Lo que distingue es el mensaje.
    expect(out).toContain("SMOKE aborted: SMOKE_ALLOW_REAL !== 'true'");
    expect(out).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError/);
    expect(res.status).toBe(1);
  });
});
