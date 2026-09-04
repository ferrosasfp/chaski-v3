#!/usr/bin/env tsx
/**
 * HU-079 / W3 — EL VIGÍA DEL ALQUILER. Le pregunta a las dos cadenas cuánto cuesta hoy el rent-exempt
 * de las cuentas que la app crea, y compara ese número contra los RESPALDOS escritos en el repo.
 *
 * ══ POR QUÉ EXISTE, Y POR QUÉ NO ES UN TEST ══════════════════════════════════════════════════════
 *
 * Lo que rompe estos números NO es un commit: es una FECHA. La HU-077 se desplegó el 2026-09-03 con
 * los valores medidos ese día, y el 2026-09-04 la cadena había movido su tarifa en las DOS redes sin
 * que nadie tocara el repo (`git log cd94bfd..HEAD` ⇒ 0 commits). Un guard atado a `npm test` no puede
 * ponerse rojo un día en que nadie corre `npm test`, así que atarlo al gate sería fabricar la ilusión
 * de una defensa. Y meterlo DENTRO del gate sería peor todavía: volvería el gate dependiente de un RPC
 * público. Medido en la misma sesión que escribió esto: `rpc.ankr.com/solana` devolvió `HTTP 403` y
 * `solana-devnet-rpc.publicnode.com` devolvió `HTTP 404`. Rojos que no hablan del diff, en un gate que
 * la gente aprende a saltear.
 *
 * ══ ⛔ POR QUÉ NO ESTÁ INSCRIPTO EN NINGÚN `schedule:` — LA MEDICIÓN, SIN SUAVIZAR ═════════════════
 *
 * Este repo SÍ corre workflows programados, y el que tiene está roto y nadie actúa. Medido con
 * `gh api` el 2026-09-04 sobre `reconcile-orphans.yml`:
 *
 *     199 corridas en total, 165 con éxito
 *     de las últimas 100 (2026-08-23 → 2026-09-04): 72 success / 28 failure
 *     🔴 las últimas 24 son TODAS `failure`, desde 2026-08-31T05:49:30Z  ⇒ ~5 días en rojo continuo
 *     cadencia real ~5 corridas/día, aunque su `schedule` es HORARIO: GitHub saltea la mayoría
 *
 * El propio docblock de ese workflow lo había predicho —"un job crónicamente rojo entrena a ignorarlo,
 * y ahí L1 deja de verse"— y está pasando. Inscribir un vigía nuevo en ese canal HOY no crea una
 * defensa: crea un guard decorativo, que es peor que no tener ninguno, porque quien lea el repo va a
 * creer que este riesgo está cubierto.
 *
 * ⛔ POR ESO LA DECISIÓN DE INSCRIBIRLO ES DEL HUMANO Y NO DE ESTA HU. El script existe, se tipa en el
 * gate (el `include` de `tsconfig.scripts.json` toma todos los `.ts` de `scripts/`) y se corre a mano con
 * `npx tsx scripts/vigia-alquiler.ts` cuando alguien quiera saber si los respaldos envejecieron.
 *
 * ══ QUÉ MIRA, Y EN QUÉ DIRECCIÓN ═════════════════════════════════════════════════════════════════
 *
 * Sale con código ≠ 0 SÓLO cuando un respaldo quedó POR DEBAJO de lo que la cadena pide, que es la
 * dirección peligrosa. La otra —el respaldo por encima— es el estado normal y esperado: un respaldo es
 * un máximo histórico congelado, así que pedir de más es su modo de operación, no una alarma.
 *
 *   · `SENDER_MIN_LAMPORTS_FOR_DEPOSIT` se COMPARA (es un umbral). Si queda corto, el guard deja pasar
 *     a alguien que no puede pagar y la transacción REVIERTE en cadena.
 *   · `NONCE_ACCOUNT_RENT_LAMPORTS` se GASTA: fondea una cuenta real
 *     (`../src/infrastructure/solana/preparacion-por-enlace.ts`). Si queda corto, la cuenta nace
 *     sub-fondeada y la transacción falla. Está fuera del alcance de la HU-079 (⇒ HU 080) y por eso el
 *     vigía SÍ lo mira: es el que quedó sin arreglar.
 *
 * ⚠️ LO QUE ESTE SCRIPT NO HACE, dicho para que nadie le crea de más:
 *   · No mira la cifra que se MUESTRA en pantalla, y no es un olvido: desde HU-079 esa cifra ya no
 *     existe en el repo — sale de `readOpenEscrowRent`, o sea de la cadena, y no hay nada que envejezca.
 *   · No escribe nada, no toca ninguna cuenta y no necesita ninguna credencial: son CUATRO llamadas
 *     `getMinimumBalanceForRentExemption` por cluster —una por cada tamaño de `sizes`—, que son
 *     lecturas públicas. El «cuatro» sale de contar el array, no de acordarme.
 *   · No falla si un RPC no contesta. Un endpoint caído es "no pudimos preguntar", y eso ⛔ NO es "el
 *     respaldo está bien": se imprime como `sin respuesta` y NO cuenta como verde. Si NINGÚN cluster
 *     contestó, sale con código 2 — un vigía que no pudo medir nada no puede reportar que todo está en
 *     orden, que es exactamente el fail-open que esta HU vino a cerrar en la app.
 */
import {
  ESCROW_INDEX_RENT_LAMPORTS,
  NONCE_ACCOUNT_RENT_LAMPORTS,
  SENDER_MIN_LAMPORTS_FOR_DEPOSIT,
  senderMinLamportsForDeposit,
} from "../src/application/solana-escrow-rent";

/** Los tamaños del PROGRAMA DESPLEGADO. Son literales legítimos (`CD-079-2`): los cambia un
 *  redespliegue, o sea un commit, y `071/W1a` va a llevar `EscrowState` de 154 a 186. Van acá y no
 *  importados porque viven `private` en el adapter de infraestructura. */
const ESCROW_STATE_SPACE = 154;
const ESCROW_INDEX_SPACE = 558;
/** El tamaño de una token account SPL. Es `ACCOUNT_SIZE` de `@solana/spl-token` 0.4.15, verificado en
 *  runtime: vale 165, igual que `AccountLayout.span`. */
const TOKEN_ACCOUNT_SIZE = 165;
/** La cuenta de nonce durable. `NonceAccount.length` de `@solana/web3.js` 1.98.4. */
const NONCE_ACCOUNT_SPACE = 80;

const CLUSTERS = {
  devnet: "https://api.devnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
} as const;

type Lectura = { readonly cluster: string; readonly tamanos: ReadonlyMap<number, number> };

async function rentExempt(url: string, size: number): Promise<number | null> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMinimumBalanceForRentExemption",
      params: [size],
    }),
  });
  if (!res.ok) return null;
  const cuerpo: unknown = await res.json();
  const valor = (cuerpo as { result?: unknown }).result;
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

async function leer(cluster: string, url: string): Promise<Lectura | null> {
  const sizes = [ESCROW_STATE_SPACE, TOKEN_ACCOUNT_SIZE, ESCROW_INDEX_SPACE, NONCE_ACCOUNT_SPACE];
  const tamanos = new Map<number, number>();
  for (const size of sizes) {
    let valor: number | null;
    try {
      valor = await rentExempt(url, size);
    } catch {
      valor = null; // no pudimos preguntar: NO es "el respaldo está bien"
    }
    if (valor === null) return null;
    tamanos.set(size, valor);
  }
  return { cluster, tamanos };
}

function sol(lamports: number): string {
  return (lamports / 1_000_000_000).toFixed(6);
}

async function main(): Promise<void> {
  const hallazgos: string[] = [];
  let clustersQueContestaron = 0;

  for (const [cluster, url] of Object.entries(CLUSTERS)) {
    const lectura = await leer(cluster, url);
    if (lectura === null) {
      // ⛔ Esto NO es un verde. Es "no pudimos preguntar", y se imprime como tal.
      console.log(`  ${cluster.padEnd(8)} sin respuesta — NO se pudo verificar ningún respaldo acá`);
      continue;
    }
    clustersQueContestaron += 1;
    const estado = lectura.tamanos.get(ESCROW_STATE_SPACE) as number;
    const vault = lectura.tamanos.get(TOKEN_ACCOUNT_SIZE) as number;
    const indice = lectura.tamanos.get(ESCROW_INDEX_SPACE) as number;
    const nonce = lectura.tamanos.get(NONCE_ACCOUNT_SPACE) as number;

    // El umbral REAL de hoy, calculado con la MISMA función que usa producción. ⛔ No se re-escribe la
    // aritmética acá: un vigía que recalcula la fórmula que vigila aplaude cualquier cosa.
    const umbralReal = senderMinLamportsForDeposit({
      status: "known",
      escrowPairLamports: estado + vault,
      escrowIndexLamports: indice,
    });
    const factor = (vault - estado) / (TOKEN_ACCOUNT_SIZE - ESCROW_STATE_SPACE);

    console.log(`  ${cluster.padEnd(8)} factor ${factor}  ·  umbral real ${umbralReal} (${sol(umbralReal)} SOL)`);
    console.log(
      `           respaldo umbral ${SENDER_MIN_LAMPORTS_FOR_DEPOSIT}  ·  respaldo índice ${ESCROW_INDEX_RENT_LAMPORTS}  ·  respaldo nonce ${NONCE_ACCOUNT_RENT_LAMPORTS}`,
    );

    if (SENDER_MIN_LAMPORTS_FOR_DEPOSIT < umbralReal) {
      hallazgos.push(
        `🔴 ${cluster}: el RESPALDO del umbral (${SENDER_MIN_LAMPORTS_FOR_DEPOSIT}) quedó POR DEBAJO de lo ` +
          `que la cadena pide (${umbralReal}). Con la lectura caída, el guard deja pasar a alguien ` +
          `${umbralReal - SENDER_MIN_LAMPORTS_FOR_DEPOSIT} lamports corto y la transacción REVIERTE.`,
      );
    }
    if (ESCROW_INDEX_RENT_LAMPORTS < indice) {
      hallazgos.push(
        `🔴 ${cluster}: el RESPALDO del EscrowIndex (${ESCROW_INDEX_RENT_LAMPORTS}) quedó por debajo del ` +
          `rent-exempt real (${indice}).`,
      );
    }
    if (NONCE_ACCOUNT_RENT_LAMPORTS < nonce) {
      hallazgos.push(
        `🔴 ${cluster}: NONCE_ACCOUNT_RENT_LAMPORTS (${NONCE_ACCOUNT_RENT_LAMPORTS}) quedó por debajo del ` +
          `rent-exempt real (${nonce}). Este número se GASTA, no se compara: la cuenta de nonce nace ` +
          `sub-fondeada y la transacción falla. Es la HU 080.`,
      );
    }
  }

  if (clustersQueContestaron === 0) {
    console.error("\n⛔ ningún cluster contestó: este vigía NO midió nada y NO puede decir que todo esté bien.");
    process.exit(2);
  }
  if (hallazgos.length > 0) {
    console.error(`\n${hallazgos.join("\n")}`);
    process.exit(1);
  }
  console.log(
    `\n✅ los respaldos siguen por ENCIMA de lo que la cadena pide en ${clustersQueContestaron} de ${Object.keys(CLUSTERS).length} clusters.`,
  );
}

void main();
