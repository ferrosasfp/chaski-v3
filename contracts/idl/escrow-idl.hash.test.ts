import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { escrowIdl } from "../../src/infrastructure/solana/escrow-idl"; // SIN extensión (bundler)
import { canonicalSha256 } from "./canonical-hash";

// Pinneada y verificada en F2 sobre los 3 IDL reales (todos canonicalizan igual, address DR5G).
// Re-pinneo SOLO con SDD explícito, jamás por drift silencioso (ver CONTRACT-VERSIONS.md).
// RE-PIN 2026-08-10 — WKH-343, despliegue en devnet (slot 482775110, binario verificado byte a byte
// contra el artefacto local). Motivo, medido con un diff normalizado del IDL entero: la ÚNICA
// diferencia es que `deposit` suma una NOVENA cuenta, `beneficiary_ata`, en el ÍNDICE 8, al final de
// la lista (después de `system_program`), NO opcional, writable=false y signer=false. Ningún
// discriminador se movió: los 6 de las instrucciones y los 2 de las cuentas (`EscrowIndex`,
// `EscrowState`) son idénticos, y `deposit` conserva su discriminador y sus args. `close`, `refund`,
// `release`, `register_escrow` y `deregister_escrow` conservan cuentas, orden y args. Los errores
// siguen siendo 6000..6008 sin renumerar y `EscrowStatus` sigue con 3 variantes, así que el decode
// de la cuenta no se mueve.
// ⚠️ Este re-pin NO es compatible en las dos direcciones para lo que este repo invoca: el programa
// desplegado EXIGE las 9 cuentas y Anchor tolera de más pero no de menos, así que con el IDL viejo
// `authorizePrincipal` armaba la ix con 8 y TODO depósito fallaba. Por eso el fix del cliente
// (mandar la cuenta explícita) viaja en el mismo commit que este re-pin.
// ✅ YA alineado con wasiai-facilitator: su pin activo también es este valor, medido el 2026-08-11
// (su `ESCROW_IDL_SHA256`; el `bfbdfe5a…` que hay ahí es el comentario `Anterior:`, no el pin).
// Igual conviene saberlo: esto es un pin de test, no un guard de runtime. El guard que sí corre en
// el camino del dinero es CR-1, que acepta cuentas extra no-signer y no-writable desde el índice 8.
// Anterior: bfbdfe5aedd55d68e6dda4663b5d26daada815c99db03df34a1601fe4a4d3922.
// RE-PIN 2026-08-05 — despliegue en devnet (slot 481495859, binario verificado byte a byte contra
// el artefacto local). Motivo, medido con un diff normalizado del IDL entero (claves ordenadas):
// la ÚNICA diferencia es que `close` suma una SÉPTIMA cuenta, `escrow_index`, `optional: true`, al
// final de la lista (después de `token_program`). Ningún discriminador se movió: los 6 de las
// instrucciones y los 2 de las cuentas (`EscrowIndex`, `EscrowState`) son idénticos. `deposit`,
// `release`, `refund`, `register_escrow` y `deregister_escrow` conservan cuentas, orden y args.
// Los errores siguen siendo 6000..6008, sin renumerar ni borrar. `EscrowStatus` sigue con 3
// variantes, así que el decode de la cuenta no se mueve.
// Valor idéntico al pineado en wasiai-facilitator (src/chains/escrow-idl.hash.test.ts).
// Anterior: fb64c937dbdab7a58045e663a85724808c4539707fedbdf244e11a28dbe5c071.
// RE-PIN 2026-08-01 — ventana de custodia. Motivo, medido con un diff instrucción por instrucción
// contra el IDL nuevo: (a) `close` suma la cuenta `sender_ata` (el barrido del vault) y (b) entran
// los errores 6006 DeadlineTooSoon, 6007 DeadlineTooFar y 6008 ReleaseWindowClosed. NINGÚN código
// existente se renumeró ni se borró, y `deposit`, `refund`, `release`, `register_escrow` y
// `deregister_escrow` conservan discriminador, cuentas y args, así que el re-pin es compatible en
// las dos direcciones para todo lo que este repo realmente invoca (`close` no lo invoca nadie acá).
// EscrowStatus sigue con 3 variantes, o sea que el decode de la cuenta no se mueve.
// Valor idéntico al pineado en wasiai-facilitator (src/chains/escrow-idl.hash.test.ts).
// Anterior: 4bcc34a997396d360ab996ea5bb1015ffdd8a1d357d3f4b4cffcbfe8ea98d12b.
// RE-PIN 2026-07-28 — HU-SOL-20 / R2b (SDD solana-programs/doc/sdd/002-escrow-remittance-id-recovery
// /sdd.md §4.10 DT-9). Motivo: R1 agregó register_escrow + deregister_escrow, la cuenta EscrowIndex
// y el error 6005. Anterior: aa53c03f159f7381cedf598cfd1b9e0b12d34dcdb2ae3240e9c14b288225fb71.
const ESCROW_IDL_SHA256 = "cc2761266dcf8335a17562129de040805f37f69cfe654f5be472045ba7bfcd51";

describe("escrow IDL — hash canónico (WKH-227 / AC-2, AC-3)", () => {
  // AC-2 (siempre corre): si alguien edita escrow-idl.ts a mano sin re-pinnear → ROJO.
  it("AC-2: canonicalSha256(escrowIdl) == constante pinneada", () => {
    expect(canonicalSha256(escrowIdl)).toBe(ESCROW_IDL_SHA256);
  });

  // AC-3 (best-effort, skip limpio si el sibling no existe en el workspace).
  const SIBLING = path.resolve(process.cwd(), "../solana-programs/target/idl/escrow.json");
  (existsSync(SIBLING) ? it : it.skip)("AC-3: coincide con solana-programs (sibling)", () => {
    const sibling: unknown = JSON.parse(readFileSync(SIBLING, "utf8")); // solo LECTURA (CD-2)
    expect(canonicalSha256(sibling)).toBe(ESCROW_IDL_SHA256);
  });

  // T-R2b-3 / AC-R2b-2 — el program id vive SOLO en el IDL (CD-15): un upgrade in-place NO lo cambia.
  // Incondicional a propósito: asertea el IDL vendoreado, que siempre existe (nunca con existsSync).
  it("AC-R2b-2: el address del IDL sigue siendo el program id DR5G (upgrade in-place)", () => {
    expect(escrowIdl.address).toBe("DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x");
  });

  // T-R2b-4 / AC-R2b-3 + AC-R2b-4 — R3 pinea las cuentas de CR-1 POR POSICIÓN: si el orden cambia y
  // nadie lo nota, la tx se rechaza en producción y el depósito no se broadcastea. Incondicional.
  it("AC-R2b-3/4: deposit y refund intactos (disc + orden de cuentas) y register_escrow con sus 4 cuentas en orden", () => {
    type IxView = { name: string; discriminator: number[]; accounts: ReadonlyArray<{ name: string }> };
    const ix = escrowIdl.instructions as unknown as ReadonlyArray<IxView>;
    const accountsOf = (name: string): string[] | undefined =>
      ix.find((i) => i.name === name)?.accounts.map((a) => a.name);
    const discOf = (name: string): number[] | undefined => ix.find((i) => i.name === name)?.discriminator;

    // Las 6 instrucciones post-R1 (4 viejas + 2 nuevas), en el orden alfabético que emite Anchor.
    expect(ix.map((i) => i.name)).toEqual([
      "close",
      "deposit",
      "deregister_escrow",
      "refund",
      "register_escrow",
      "release",
    ]);

    // NO-REGRESIÓN (CD-8): deposit conserva discriminador y sus cuentas posicionales, ahora NUEVE
    // (WKH-343 sumó `beneficiary_ata` al final; las 8 primeras no se movieron ni cambiaron de orden).
    expect(discOf("deposit")).toEqual([242, 35, 198, 137, 82, 225, 242, 182]);
    expect(accountsOf("deposit")).toEqual([
      "sender",
      "mint",
      "escrow_state",
      "vault",
      "sender_ata",
      "token_program",
      "associated_token_program",
      "system_program",
      "beneficiary_ata",
    ]);

    // NO-REGRESIÓN: refund (el camino que R0 acaba de tocar) conserva discriminador y sus 7 cuentas.
    expect(discOf("refund")).toEqual([2, 96, 183, 251, 63, 208, 46, 46]);
    expect(accountsOf("refund")).toEqual([
      "sender",
      "mint",
      "escrow_state",
      "vault",
      "sender_ata",
      "token_program",
      "associated_token_program",
    ]);

    // AC-R2b-4: register_escrow tal como lo fijó R1 — habilitador de R4.
    expect(discOf("register_escrow")).toEqual([200, 17, 194, 170, 224, 144, 127, 166]);
    expect(accountsOf("register_escrow")).toEqual([
      "sender",
      "escrow_state",
      "escrow_index",
      "system_program",
    ]);
  });

  // WKH-327 / H-4 — `close` NO estaba en el pin posicional de arriba, y hasta esta HU no lo construía
  // nadie. A partir de ahora sí: `closeEscrow` (solana-wallet.ts) arma la ix y sus tests assertan sobre
  // el ÍNDICE 6 (`escrow_index`), que es la cuenta opcional. Sin este candado, un re-pin futuro que
  // reordenara las cuentas de `close` dejaría la app rota en silencio: el hash cambiaría, el re-pin lo
  // actualizaría, y ahí terminaría la conversación.
  //
  // Esto NO es re-pinnear (CD-9): no toca ESCROW_IDL_SHA256 ni el IDL vendoreado. Sale verde desde el
  // minuto cero. El input que lo pone en rojo: mover `escrow_index` de la posición 6, sacarle
  // `optional: true`, o cambiar el discriminador de `close`.
  it("WKH-327/H-4: close conserva su discriminador y sus 7 cuentas en orden, con la 7ª opcional", () => {
    type IxView = {
      name: string;
      discriminator: number[];
      accounts: ReadonlyArray<{ name: string; optional?: boolean; writable?: boolean }>;
    };
    const ix = escrowIdl.instructions as unknown as ReadonlyArray<IxView>;
    const closeIx = ix.find((i) => i.name === "close");
    if (!closeIx) throw new Error("el IDL no declara la instrucción `close`");

    expect(closeIx.discriminator).toEqual([98, 165, 201, 177, 108, 65, 206, 96]);
    expect(closeIx.accounts.map((a) => a.name)).toEqual([
      "sender",
      "mint",
      "escrow_state",
      "vault",
      "sender_ata",
      "token_program",
      "escrow_index",
    ]);

    // La premisa de AC-1/AC-2: la cuenta del índice 6 es la OPCIONAL y es escribible. Si dejara de ser
    // opcional, `escrowIndex: null` no sería un valor válido y todo el camino de AC-1 se cae.
    const seventh = closeIx.accounts[6];
    if (!seventh) throw new Error("close no tiene una 7ª cuenta");
    expect(seventh.name).toBe("escrow_index");
    expect(seventh.optional).toBe(true);
    expect(seventh.writable).toBe(true);
  });

  // WKH-343 — la NOVENA cuenta de `deposit` y, sobre todo, SUS FLAGS. El nombre y la posición ya los
  // pinea el `it` de arriba; lo que se candea acá es que siga entrando SIN `mut`.
  //
  // Por qué merece su propio assert: si un re-pin futuro le pusiera `mut` en el programa, este repo
  // seguiría armando la ix "bien" y el rojo aparecería recién en producción, del lado del
  // facilitator. CR-1 acepta cuentas extra a partir del índice 8 sólo si son no-signer y no-writable
  // (wasiai-facilitator/src/methods/solana-sponsor/cr1.ts:284-288 → `REMAINING_ACCOUNT_FLAGS_INVALID`),
  // así que un `beneficiary_ata` writable haría rebotar el 100% de los depósitos patrocinados.
  // El input que lo pone en rojo: agregarle `"writable": true` o `"signer": true` en el IDL.
  it("WKH-343: deposit declara `beneficiary_ata` en el índice 8, no writable, no signer y NO opcional", () => {
    type IxView = {
      name: string;
      accounts: ReadonlyArray<{ name: string; optional?: boolean; writable?: boolean; signer?: boolean }>;
    };
    const ix = escrowIdl.instructions as unknown as ReadonlyArray<IxView>;
    const depositIx = ix.find((i) => i.name === "deposit");
    if (!depositIx) throw new Error("el IDL no declara la instrucción `deposit`");

    const ninth = depositIx.accounts[8];
    if (!ninth) throw new Error("deposit no tiene una 9ª cuenta");
    expect(ninth.name).toBe("beneficiary_ata");
    // Anchor omite la clave cuando el flag es false, así que se compara contra "falsy declarado",
    // no contra `false` literal: `toBe(false)` daría rojo por un IDL correcto.
    expect(ninth.writable ?? false).toBe(false);
    expect(ninth.signer ?? false).toBe(false);
    expect(ninth.optional ?? false).toBe(false);
  });

  // ── AC-DOC — el documento publicado NO puede separarse de la constante ─────────────────────────
  // Por qué existe: el re-pin del 2026-08-01 (commit 8c8527b) movió ESCROW_IDL_SHA256 acá y dejó
  // CONTRACT-VERSIONS.md publicando el hash del 2026-07-28. Nadie lo vio: el CR de SDD 038 revisó esa
  // misma línea y la aprobó por ser "byte-idéntica a main" (cr-report.md:57), que es exactamente lo
  // que pasa cuando el doc se quedó atrás. La regla escrita en prosa ("re-pinneá también el doc") ya
  // estaba en el archivo y no alcanzó. Esto la vuelve mecánica.
  //
  // Deliberadamente NO es best-effort: el doc vive en este repo, así que si no se puede leer o no
  // parsea, eso es un fallo, no un skip. Un checkpoint que se salta solo cuando su insumo falta es un
  // OK regalado.
  describe("AC-DOC: CONTRACT-VERSIONS.md publica exactamente la constante pinneada", () => {
    const DOC_PATH = fileURLToPath(new URL("../CONTRACT-VERSIONS.md", import.meta.url));
    const HEADING = "## `ESCROW_IDL_SHA256`";

    /** El texto del doc desde el encabezado de la sección hasta el final. Tira si no está. */
    function readPinSection(): string {
      const md = readFileSync(DOC_PATH, "utf8"); // sólo LECTURA
      const start = md.indexOf(HEADING);
      if (start < 0) throw new Error(`CONTRACT-VERSIONS.md: no existe la sección ${HEADING}`);
      return md.slice(start);
    }

    it("el valor del bloque de código de la sección == ESCROW_IDL_SHA256", () => {
      const headline = /```\n([0-9a-f]{64})\n```/.exec(readPinSection());
      if (!headline) {
        throw new Error(
          `CONTRACT-VERSIONS.md: la sección ${HEADING} no tiene un bloque con un sha256 de 64 hex`,
        );
      }
      expect(headline[1]).toBe(ESCROW_IDL_SHA256);
    });

    it("la ÚLTIMA fila de la bitácora == ESCROW_IDL_SHA256 (el re-pin quedó registrado)", () => {
      // El bloque de arriba se puede editar sin dejar rastro de por qué cambió. La bitácora es el
      // registro auditable, y también se desincroniza: se chequea aparte.
      const rows = [
        ...readPinSection().matchAll(/^\| (\d{4}-\d{2}-\d{2}) \| `([0-9a-f]{64})` \|/gm),
      ];
      if (rows.length < 2) {
        throw new Error(
          `CONTRACT-VERSIONS.md: la bitácora de re-pinneos tiene ${rows.length} fila(s) parseables; se esperaban >= 2`,
        );
      }
      expect(rows[rows.length - 1]?.[2]).toBe(ESCROW_IDL_SHA256);
    });
  });
});
