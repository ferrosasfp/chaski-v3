// Infrastructure — SettlementLedger sobre Supabase (WKH-207). SERVER-ONLY (CD-11): usa el cliente
// de supabase-server.ts (SUPABASE_SERVICE_ROLE_KEY / BYPASSRLS). PROHIBIDO importarlo desde el browser.
//
// Persiste SOLO evidencia money-path (txHash/monto/address/quoteId/status) — NUNCA PII (CD-7). El
// guard REAL de ownership es app-layer: `.eq('sender_address', <caller>)` (CD-9), porque el service
// key bypassea RLS. Toda lectura de value_minor (numeric(78,0)) castea `::text` y los dígitos viajan
// COMO STRING hasta el consumidor, sin re-parseo — precisión uint256 (CD-12, WKH-196): PostgREST
// leería un numeric grande como número JSON y JSON.parse redondearía > 2^53. El `Number(...)` que
// había en mapRow deshacía el cast en la línea siguiente; hoy hay un guard que rompe fuerte si el
// valor NO llega como texto (uint256TextOrThrow).
//
// Factory getSettlementLedger(): null si SETTLEMENT_LEDGER_ENABLED !== "true" O el cliente Supabase
// es null (envs ausentes) ⇒ las rutas skipean el persist ⇒ byte-idéntico (AC-2/AC-10). La env se lee
// DENTRO de la factory en runtime (CD-14).
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  SenderRemittanceRef,
  SettlementLedger,
  SettlementLedgerStatus,
  SettlementRecord,
  SolanaPrincipalInOutcome,
  WebhookFailureClass,
  WebhookOutcome,
} from "../../application/ports";
import { getSupabaseServerClient } from "./supabase-server";
import { logLedgerAlert } from "./ledger-alert";
import { WEBHOOK_FAILURE_CLASSES } from "./webhook-failure-classes";
import { canonicalizeAddress } from "../address";
import { resolveSolanaNetworkId } from "../chain";

const TABLE = "remittance_settlements";

// Columnas de la tabla en snake_case. value_minor se selecciona con ::text (CD-12).
const SELECT_COLS =
  "id, remittance_id, quote_id, idempotency_key, tx_hash, chain_id, sender_address, receiver_address, value_minor::text, status, attempts, payout_id, payout_provenance, last_error, created_at, updated_at";

// Estados NO-terminales candidatos a varado (AC-4). Mirror del índice parcial de la migración
// (idx_remit_settle_stale ... where status in ('principal_in','submitted','forward_error')).
// NO agregar 'prepared' acá: rompería el mirror del índice parcial y haría que el reconcile
// re-procesara órdenes cuyo principal NUNCA entró (CD-6). Las 'prepared' se listan aparte
// (listPreparedOrphans) con su propio umbral.
const STALE_STATUSES: readonly SettlementLedgerStatus[] = [
  "principal_in",
  "submitted",
  "forward_error",
];

/** Estados que el webhook del proveedor PUEDE mutar (WKH-213/R1). Es STALE_STATUSES + 'prepared', y
 *  es un conjunto DISTINTO a propósito: 'prepared' es no-terminal (el proveedor puede avisar "pagado"
 *  antes de que el settle aterrice, o sin que aterrice nunca) pero NO es re-procesable por el
 *  reconcile. Compartir la constante era el bug: el webhook heredaba el conjunto del reconcile y
 *  dejaba las 'prepared' congeladas para siempre. Sigue sin incluir estados terminales
 *  (settled/failed) ni manual_review ⇒ nunca degrada ni reclasifica (DT-2b). */
const WEBHOOK_UPDATABLE_STATUSES: readonly SettlementLedgerStatus[] = [
  ...STALE_STATUSES,
  "prepared",
];

/** Los 6 status del CHECK MENOS 'prepared' (WKH-325). Lo usa el paso 3 de recordSolanaPrincipalIn
 *  para completar la evidencia de una fila que el webhook YA sacó de 'prepared'.
 *  Excluye 'prepared' porque esas filas las gobiernan los pasos 1/2, y dos escrituras del mismo
 *  tx_hash en la misma llamada chocarían contra uq_remit_settle_txhash.
 *  INCLUYE los terminales (settled/failed/manual_review) a propósito y sin degradar nada: el patch de
 *  ese paso NO contiene `status`, así que una fila 'settled' recibe su tx_hash y sigue 'settled'. */
const NON_PREPARED_STATUSES: readonly SettlementLedgerStatus[] = [
  "principal_in",
  "submitted",
  "settled",
  "failed",
  "forward_error",
  "manual_review",
];

/** tx_hash de una fila 'prepared': placeholder determinístico por idempotency_key (satisface el NOT
 *  NULL y no colisiona con un tx_hash real 0x+64hex ni con una signature base58). ÚNICA definición
 *  del formato: la escribe recordOrderPrepared y la reconoce recordPrincipalIn para saber si una fila
 *  todavía NO tiene evidencia real. Si esto se duplica, el rellenado de evidencia deja de encontrarla. */
export const PREPARED_TX_HASH_PREFIX = "prepared:";
function preparedPlaceholderTxHash(idempotencyKey: string): string {
  return `${PREPARED_TX_HASH_PREFIX}${idempotencyKey}`;
}

/** Valor de la columna `payout_provenance` a partir de la proveniencia que declaró el agente.
 *
 *  Se persiste la CADENA TAL CUAL, no un booleano derivado: el dato tiene más de dos valores
 *  ('transfi', 'devnet-stub', 'local-fallback', 'n/a', y los que traiga un proveedor futuro), y
 *  colapsarlo en `is_simulated` sería el mismo error que este cambio arregla, más chico — la fila
 *  volvería a no poder decir QUIÉN desembolsó, sólo una opinión nuestra sobre si contaba.
 *
 *  Vacío/whitespace ⇒ NULL. `""` es lo que produce la ruta cuando el agente NO declaró proveniencia
 *  (prepare/route.ts hace `typeof ... === "string" ? ... : ""`), y guardarlo como `''` inventaría una
 *  proveniencia llamada "cadena vacía". NULL ya significa exactamente eso en esta columna: no consta.
 *
 *  PROHIBIDO rellenar acá un default ('transfi', 'unknown', lo que sea): una proveniencia inventada por
 *  el que ESCRIBE la evidencia no es evidencia. La ausencia se persiste como ausencia. */
function provenanceColumn(declared: string): string | null {
  return declared.trim() ? declared : null;
}

/** El `chainId` del port sigue siendo `number` (CD-11: NO se re-tipa el port ni la columna, porque
 *  la columna describe filas ya escritas). Ningún caller vivo tiene un chainId que pasar: mandan
 *  esta constante, que
 *  `vmNetworkColumns` DESCARTA en la rama "solana" (escribe `chain_id: null`). Es un relleno inerte
 *  con nombre, no un chainId 0 que se persista en ningún lado. */
export const CHAIN_ID_NOT_APPLICABLE = 0;

/** Columnas de IDENTIDAD DE RED de un INSERT, coherentes por construcción con el CHECK
 *  `remittance_settlements_vm_netid_chk` (migración 20260721, YA aplicada):
 *      vm='evm'    ⇒ chain_id NOT NULL  Y  network_id NULL
 *      vm='solana' ⇒ network_id NOT NULL Y  chain_id NULL
 *  Las DOS mitades (el `vm` y su columna de red) salen de ACÁ y de ningún otro lado: es imposible que
 *  un escritor ponga `vm='solana'` y se olvide de anular `chain_id` (o al revés) — esa desincronización
 *  es exactamente el bug que arregla este cambio. Una violación del CHECK no rompe el money-path
 *  (CD-17: la ruta captura y sigue) ⇒ la fila simplemente NO se escribe, así que el acoplamiento tiene
 *  que ser estructural, no una convención entre call-sites.
 *  `network_id` sale de resolveSolanaNetworkId() (CAIP-2, la MISMA fuente server-side que ata el PoP
 *  ed25519, el envelope x402 `solana:<cluster>` y el binding P4 de /solana/escrow/remittance-ids) —
 *  NUNCA del body, NUNCA un literal nuevo. `chainId` es el identificador numérico de red que usaba una
 *  versión anterior de este servicio: acá NO se escribe (no hay chainId numérico en Solana, y
 *  escribirlo era el mislabel — filas con address base58 etiquetadas con un id de otra red). */
function vmNetworkColumns(
  vm: "evm" | "solana",
  chainId: number,
): { vm: "evm" | "solana"; chain_id: number | null; network_id: string | null } {
  switch (vm) {
    case "evm":
      return { vm: "evm", chain_id: chainId, network_id: null };
    case "solana":
      return { vm: "solana", chain_id: null, network_id: resolveSolanaNetworkId() };
    default:
      throw new Error("ledger_unsupported_vm"); // fail-loud (vm fuera del union, defensa runtime)
  }
}

// Shape crudo de una fila leída (value_minor llega como string por el ::text).
interface RawRow {
  id: string;
  remittance_id: string;
  quote_id: string;
  idempotency_key: string;
  tx_hash: string;
  // NULLABLE desde la migración 20260721: las filas Solana NO tienen chainId numérico (su identidad de
  // red vive en network_id). Tiparlo `number` sería mentir en un read del money-path.
  chain_id: number | null;
  sender_address: string;
  receiver_address: string;
  value_minor: string;
  status: SettlementLedgerStatus;
  attempts: number;
  payout_id: string | null;
  // Migración 20260804. NULL en toda fila anterior a ella (y en las que el agente no declaró
  // proveniencia): "no consta", NUNCA "real". Ver SettlementRecord.payoutProvenance.
  payout_provenance: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Dígitos decimales, sin signo ni notación científica: la forma EXACTA en que Postgres emite un
 *  `numeric(78,0)` casteado a texto. */
const UINT256_TEXT = /^\d+$/;

/** Devuelve los dígitos de value_minor TAL CUAL vinieron del `::text`, o TIRA.
 *
 *  Este guard es la contraparte en runtime del cast en SELECT_COLS. `mapRow` recibe filas via
 *  `as unknown as RawRow[]` (PostgREST no está tipado), así que `value_minor: string` es una promesa
 *  SIN verificar: si alguien borra el `::text` del select, PostgREST devuelve el numeric como número
 *  JSON, JSON.parse lo redondea > 2^53 y el tipo seguiría diciendo `string` mientras el dato ya
 *  está corrupto. Acá se rompe fuerte en vez de propagar un monto mentiroso al ledger de evidencia.
 *
 *  Fail-loud es seguro: el único lector es listStale (reconcile admin), cuyo call-site captura y
 *  responde 503 (route.ts:66-71). NADA de dinero se mueve por esta lectura ⇒ el peor caso de tirar
 *  es un reconcile que no corre; el peor caso de NO tirar es evidencia con montos redondeados.
 *
 *  PROHIBIDO "arreglarlo" con String(r.value_minor): un número ya redondeado se convierte en un
 *  string igual de corrupto, y el guard pasaría a certificar la pérdida en vez de detectarla. */
function uint256TextOrThrow(raw: unknown): string {
  if (typeof raw !== "string" || !UINT256_TEXT.test(raw)) {
    // NUNCA ecoa el valor recibido (el mensaje va a logs; enums estables, CD-7).
    throw new Error("ledger_value_minor_not_text");
  }
  return raw;
}

function mapRow(r: RawRow): SettlementRecord {
  return {
    id: r.id,
    remittanceId: r.remittance_id,
    quoteId: r.quote_id,
    idempotencyKey: r.idempotency_key,
    txHash: r.tx_hash,
    chainId: r.chain_id,
    senderAddress: r.sender_address,
    receiverAddress: r.receiver_address,
    // CD-12: los dígitos del ::text PASAN DERECHO, sin re-parseo. Un Number() acá redondearía > 2^53
    // y tiraría a la basura justo lo que el cast preserva (WKH-196). Ver SettlementRecord.valueMinor.
    valueMinor: uint256TextOrThrow(r.value_minor),
    status: r.status,
    attempts: r.attempts,
    payoutId: r.payout_id,
    // Normalizado a null en vez de pasar el crudo: las filas llegan `as unknown as RawRow[]` (PostgREST
    // no está tipado), así que un `undefined` (columna ausente porque la migración 20260804 todavía no
    // se aplicó) se colaría con tipo `string | null` mintiendo. Y `undefined` DESAPARECE en
    // JSON.stringify: la respuesta admin quedaría sin el campo, que se lee igual que "no lo miré".
    // null dice "no consta" de forma explícita, que es la única lectura honesta de los dos casos.
    payoutProvenance: typeof r.payout_provenance === "string" ? r.payout_provenance : null,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class SupabaseSettlementLedger implements SettlementLedger {
  constructor(private readonly client: SupabaseClient) {}

  async recordOrderPrepared(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    depositAddress: string;
    chainId: number;
    senderAddress: string;
    payoutId: string;
    payoutProvenance: string; // OBLIGATORIO (candado de compilación) — ver el port y provenanceColumn
    vm: "evm" | "solana";
  }): Promise<void> {
    // WKH-211/AC-8: registra la orden TransFi creada en prepare (ANTES del principal_in on-chain), para
    // visibilidad de huérfanas (DT-5). Upsert por idempotency_key (retry de prepare = una sola fila).
    // El depositAddress va en receiver_address (ES el receiver no-custodial, SIN columna nueva). NUNCA
    // PII (CD-7). value_minor no se conoce aún → '0' (el real llega en recordPrincipalIn). tx_hash aún
    // no existe (no hubo settle) → placeholder determinístico por idempotency_key (satisface el NOT NULL
    // y no colisiona con un tx_hash real 0x+64hex).
    // WKH-213: esta fila YA NO es un callejón sin salida. recordPrincipalIn se re-keyeó a
    // idempotency_key con MERGE, así que el settle COMPLETA esta misma fila (hash/monto reales →
    // 'principal_in') en vez de intentar insertar una nueva y morir contra uq_remit_settle_idem.
    //
    // payout_provenance (migración 20260804): la proveniencia que DECLARÓ el agente. Sin ella, la fila
    // de una orden simulada era indistinguible de una real — mismo 'prepared', misma address base58,
    // mismo payout_id, mismo network_id CAIP-2 — y lo único que las separaba era el prefijo `fb-` del
    // payoutId, una convención incidental del proveedor simulado que nadie se comprometió a mantener.
    // El día que ese formato cambie, una tabla llamada "evidencia money-path" deja de poder contestar
    // si movió plata. Requiere la migración YA APLICADA: escribir una columna inexistente devuelve
    // PGRST204 ⇒ esta función tira ⇒ el best-effort de la route (CD-17) se lo traga y se pierde la fila
    // ENTERA, no sólo la proveniencia. Ver la cabecera del _up: migración PRIMERO, código DESPUÉS.
    const { error } = await this.client.from(TABLE).upsert(
      {
        remittance_id: input.remittanceId,
        quote_id: input.quoteId,
        idempotency_key: input.idempotencyKey,
        tx_hash: preparedPlaceholderTxHash(input.idempotencyKey), // placeholder (NOT NULL); no hay settle aún
        // vm + (chain_id | network_id) en un solo lugar: acopladas por el CHECK de la DB (ver
        // vmNetworkColumns). Una versión anterior de este servicio escribía `chain_id: input.chainId`
        // a secas ⇒ TODA fila quedaba con el discriminador y el id de red heredados, y una address
        // base58. Esas filas siguen en la tabla: por eso el discriminador no se puede podar.
        ...vmNetworkColumns(input.vm, input.chainId),
        sender_address: canonicalizeAddress(input.senderAddress),
        receiver_address: canonicalizeAddress(input.depositAddress), // el depositAddress ES el receiver
        value_minor: "0", // desconocido en prepare; el real llega en recordPrincipalIn
        status: "prepared",
        payout_id: input.payoutId,
        payout_provenance: provenanceColumn(input.payoutProvenance),
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );
    if (error) throw new Error(`ledger_record_order_prepared_failed:${error.code ?? "unknown"}`);
  }

  async recordPrincipalIn(input: {
    remittanceId: string;
    quoteId: string;
    idempotencyKey: string;
    txHash: string;
    chainId: number;
    senderAddress: string;
    receiverAddress: string;
    valueMinor: number;
    vm: "evm" | "solana";
  }): Promise<void> {
    // WKH-213/R2 — el settle ATERRIZA SOBRE LA FILA PREPARADA. Antes esto era un solo
    // `upsert(..., { onConflict: "tx_hash", ignoreDuplicates: true })`: como la fila 'prepared' ya
    // ocupaba la MISMA idempotency_key, el INSERT violaba el OTRO índice único (uq_remit_settle_idem),
    // salía 23505 y el best-effort de la route se lo tragaba ⇒ en modo real NINGUNA fila llegaba nunca
    // a 'principal_in'. `ON CONFLICT` sólo resuelve el índice que se le declara: con DOS índices únicos
    // sobre la tabla, un upsert de una sola clave NO es idempotencia, es una bomba silenciosa.
    //
    // ⚠️ El índice único de tx_hash SIGUE VIVO y sigue protegiendo: si dos remesas distintas llegaran
    // con el mismo hash, el UPDATE/INSERT de abajo viola uq_remit_settle_txhash → 23505 → esta función
    // TIRA. Lo que cambia es que ahora esa colisión GRITA (log [ALERT] del best-effort de la route) en
    // vez de morir en silencio dentro de un ignoreDuplicates. La protección no se relajó: se hizo audible.
    const owner = canonicalizeAddress(input.senderAddress);
    const nowIso = new Date().toISOString();
    // Evidencia VERIFICADA on-chain (CD-13) — nunca un eco del body. payout_id NO está en el patch:
    // el id de la orden del proveedor que escribió prepare NO se pisa (un merge con null lo borraría).
    const evidence = {
      tx_hash: input.txHash,
      value_minor: String(input.valueMinor), // uint256-safe
      updated_at: nowIso,
    };
    const fullPatch = {
      ...evidence,
      remittance_id: input.remittanceId,
      quote_id: input.quoteId,
      ...vmNetworkColumns(input.vm, input.chainId), // MISMA fuente que recordOrderPrepared (CHECK 20260721)
      sender_address: owner,
      receiver_address: canonicalizeAddress(input.receiverAddress),
      status: "principal_in" as const,
    };

    // 1. Camino normal: la fila preparada de ESTE owner pasa a principal_in con la evidencia real.
    //    `.eq("status","prepared")` es un CAS: sólo asciende desde 'prepared', NUNCA degrada un estado
    //    ya avanzado (submitted/settled/failed/manual_review). `.eq("sender_address", owner)` es el
    //    guard de ownership (CD-9): el service key bypassea RLS, así que sin este filtro un settle
    //    ajeno podría sobrescribir la evidencia de otra remesa. `.select("id")` es lo que permite
    //    saber si matcheó (sin él, un UPDATE de 0 filas es indistinguible de uno exitoso).
    const { data: upgraded, error: upgradeErr } = await this.client
      .from(TABLE)
      .update(fullPatch)
      .eq("idempotency_key", input.idempotencyKey)
      .eq("sender_address", owner)
      .eq("status", "prepared")
      .select("id");
    if (upgradeErr)
      throw new Error(`ledger_record_principal_in_failed:${upgradeErr.code ?? "unknown"}`);
    if ((upgraded ?? []).length > 0) return;

    // 2. La fila ya avanzó: el webhook del proveedor llegó ANTES que el settle (R1 la sacó de
    //    'prepared' a submitted/settled/failed). El status es de la máquina de estados y NO se degrada;
    //    la evidencia es aditiva y sí se completa — pero SÓLO si el tx_hash sigue siendo el placeholder
    //    de prepare (`.eq("tx_hash", placeholder)`), o sea únicamente cuando nadie escribió evidencia
    //    real todavía. Así el hash verificado on-chain no se pierde por una carrera de llegada, y
    //    jamás pisa un hash real ya escrito.
    const { data: filled, error: fillErr } = await this.client
      .from(TABLE)
      .update(evidence)
      .eq("idempotency_key", input.idempotencyKey)
      .eq("sender_address", owner)
      .eq("tx_hash", preparedPlaceholderTxHash(input.idempotencyKey))
      .select("id");
    if (fillErr) throw new Error(`ledger_record_principal_in_failed:${fillErr.code ?? "unknown"}`);
    if ((filled ?? []).length > 0) return;

    // 3. ¿Existe la fila? Si existe (settle reintentado ⇒ ya tiene su evidencia real, o pertenece a
    //    otro sender), NO-OP: reintentar el settle es inocuo. Este SELECT es lo que separa "ya está"
    //    de "no está" — sin él, el INSERT de abajo chocaría contra uq_remit_settle_txhash (índice
    //    DISTINTO del target del ON CONFLICT) y convertiría un retry benigno en un falso [ALERT].
    const { data: existing, error: readErr } = await this.client
      .from(TABLE)
      .select("id")
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (readErr) throw new Error(`ledger_record_principal_in_failed:${readErr.code ?? "unknown"}`);
    if (existing) return;

    // 4. No hubo prepare (modo estático WKH-168/209, o el ledger estaba apagado cuando se preparó):
    //    INSERT. ignoreDuplicates cubre la carrera contra un prepare concurrente (llegó entre el
    //    SELECT y este INSERT) sin degradar nada.
    const { error: insertErr } = await this.client
      .from(TABLE)
      .upsert(
        { ...fullPatch, idempotency_key: input.idempotencyKey },
        { onConflict: "idempotency_key", ignoreDuplicates: true },
      );
    if (insertErr)
      throw new Error(`ledger_record_principal_in_failed:${insertErr.code ?? "unknown"}`);
  }

  async recordSolanaPrincipalIn(input: {
    remittanceId: string;
    senderAddress: string;
    signature: string;
  }): Promise<SolanaPrincipalInOutcome> {
    // WKH-213/R3 — el settle ESCRIBE al ledger. La signature base58 que /solana/sponsor verifica
    // on-chain es lo que ocupa el lugar del txHash; sin esto, una remesa nacía 'prepared' y MORÍA
    // 'prepared' (ninguna otra escritura la tocaba nunca).
    // Se ancla a la fila preparada en vez de insertar una nueva porque los datos que faltan
    // (quote_id, value_minor, receiver, payout_id) YA están ahí y son server-side: el sponsor sólo
    // devuelve la signature, y escribir un monto declarado por el cliente violaría CD-13. Sin fila
    // NO se inserta: quote_id/value_minor son NOT NULL y acá no hay fuente verificada para ninguno de
    // los dos; inventarlos sería evidencia falsa, peor que no tener fila. Lo que cambia (WKH-325) es
    // que ese "no escribí nada" DEJA DE SER MUDO: son cinco desenlaces y tres de ellos alertan.
    // NINGÚN paso lee la columna `status` (todos los select piden "id"): el estado previo que importa
    // viaja en el WHERE.
    const owner = canonicalizeAddress(input.senderAddress); // base58 case-sensitive (CD-10)
    // 1. ELEGIR DESTINO (no clasificar): la fila 'prepared' de ESTA remesa y ESTE sender.
    //    `.eq("sender_address", owner)` es el guard de ownership (CD-9). Una remesa re-cotizada puede
    //    tener MÁS de una 'prepared' (una por quoteId): se toma la más reciente — la vieja quedó
    //    genuinamente huérfana y debe seguir visible como tal. Sin el `id`, un UPDATE por
    //    (remittance_id, sender) ascendería las DOS con el MISMO tx_hash ⇒ 23505 contra
    //    uq_remit_settle_txhash ⇒ no se escribiría ninguna.
    //    NO filtra por `vm` a propósito (misma razón que listRemittanceIdsBySender: las filas escritas
    //    antes del fix de HU-SOL-7 dicen vm='evm' aunque sean Solana; la address base58 ya discrimina).
    const { data, error: readErr } = await this.client
      .from(TABLE)
      .select("id")
      .eq("remittance_id", input.remittanceId)
      .eq("sender_address", owner)
      .eq("status", "prepared")
      .order("created_at", { ascending: false })
      .limit(1);
    if (readErr)
      throw new Error(`ledger_record_solana_principal_in_failed:${readErr.code ?? "unknown"}`);
    const row = ((data ?? []) as unknown as Array<{ id: string }>)[0];
    const nowIso = new Date().toISOString();

    // 2. ASCENSO con re-check de 'prepared' (CAS): si el webhook la movió entre el SELECT y el UPDATE,
    //    NO se degrada el estado terminal. `.select("id")` para distinguir "ascendió" de "0 filas".
    if (row) {
      const { data: ascended, error: ascendErr } = await this.client
        .from(TABLE)
        .update({
          tx_hash: input.signature, // el hash Solana; el índice único de tx_hash sigue aplicando
          status: "principal_in",
          updated_at: nowIso,
        })
        .eq("id", row.id)
        .eq("status", "prepared")
        .select("id");
      if (ascendErr)
        throw new Error(`ledger_record_solana_principal_in_failed:${ascendErr.code ?? "unknown"}`);
      if ((ascended ?? []).length > 0) return "ascended";
      // 0 filas ⇒ el webhook la movió entre el paso 1 y este UPDATE. Sigue al paso 3.
    }

    // 3. EVIDENCIA ADITIVA sobre una fila que YA NO está en 'prepared'. Sin esto, un depósito cuya
    //    fila el webhook ya movió se quedaba con el placeholder del prepare como único tx_hash.
    //    ⚠️ `status` NO está en el patch: la máquina de estados no se toca, sólo se completa la
    //    evidencia (mismo criterio que el paso 2 de recordPrincipalIn). Y sólo se completa si el
    //    tx_hash SIGUE siendo un placeholder de prepare — borrar ese filtro sería pisar evidencia real
    //    ya verificada on-chain.
    //    El patrón es la constante "prepared:%", sin interpolar nada del request ⇒ no hay comodines
    //    inyectables. Se filtra por prefijo y no por el placeholder exacto porque éste necesita el
    //    idempotency_key, y este método no recibe el quoteId: el predicado honesto que sí se puede
    //    escribir es "el tx_hash todavía tiene forma de placeholder".
    //    NON_PREPARED_STATUSES incluye los terminales A PROPÓSITO y sin degradar nada: el patch no
    //    contiene `status`, así que una fila 'settled' recibe su tx_hash y sigue 'settled'. Excluir
    //    'prepared' es lo que evita que esta escritura pise las filas que gobiernan los pasos 1/2 y
    //    colisione contra uq_remit_settle_txhash consigo misma.
    const { data: filled, error: fillErr } = await this.client
      .from(TABLE)
      .update({ tx_hash: input.signature, updated_at: nowIso })
      .eq("remittance_id", input.remittanceId)
      .eq("sender_address", owner)
      .in("status", NON_PREPARED_STATUSES as unknown as string[])
      .like("tx_hash", `${PREPARED_TX_HASH_PREFIX}%`)
      .select("id");
    if (fillErr)
      throw new Error(`ledger_record_solana_principal_in_failed:${fillErr.code ?? "unknown"}`);
    if ((filled ?? []).length > 0) {
      logLedgerAlert("solana_principal_in_late_evidence", { remittanceId: input.remittanceId });
      return "evidence_filled";
    }

    // 4. ¿NUESTRA firma ya está persistida? Es el retry del sponsor sobre una remesa ya registrada:
    //    NO-OP y SIN alerta, porque la evidencia SÍ está. Va ANTES del paso 5 a propósito: una alerta
    //    que se emite en un caso benigno y frecuente deja de ser una alerta.
    const { data: mine, error: mineErr } = await this.client
      .from(TABLE)
      .select("id")
      .eq("remittance_id", input.remittanceId)
      .eq("sender_address", owner)
      .eq("tx_hash", input.signature)
      .limit(1);
    if (mineErr)
      throw new Error(`ledger_record_solana_principal_in_failed:${mineErr.code ?? "unknown"}`);
    if (((mine ?? []) as unknown as unknown[]).length > 0) return "already_recorded";

    // 5. Los dos desenlaces sin registro durable, separados porque piden diagnósticos distintos: hay
    //    fila pero con evidencia de otra cosa (la nuestra se pierde), o no hay fila en absoluto (el
    //    depósito quedó sin ningún registro). Los dos GRITAN — antes los dos eran un `return` mudo,
    //    indistinguible de un éxito. CD-7: sólo el remittanceId.
    const { data: any_, error: anyErr } = await this.client
      .from(TABLE)
      .select("id")
      .eq("remittance_id", input.remittanceId)
      .eq("sender_address", owner)
      .limit(1);
    if (anyErr)
      throw new Error(`ledger_record_solana_principal_in_failed:${anyErr.code ?? "unknown"}`);
    if (((any_ ?? []) as unknown as unknown[]).length > 0) {
      logLedgerAlert("solana_principal_in_evidence_conflict", { remittanceId: input.remittanceId });
      return "unrecorded_conflict";
    }
    logLedgerAlert("solana_principal_in_no_row", { remittanceId: input.remittanceId });
    return "unrecorded_no_row";
  }

  async recordPayoutOutcome(input: {
    idempotencyKey: string;
    senderAddress: string;
    status: SettlementLedgerStatus;
    payoutId?: string | null;
    error?: string | null;
    vm: "evm" | "solana";
  }): Promise<void> {
    // UPDATE owner-scoped (CD-9): un caller SOLO puede mutar su propia fila. El filtro por
    // sender_address es el guard REAL (el service key bypassea RLS).
    // NO toca vm/chain_id/network_id (ni las necesita): el patch no incluye esas columnas ⇒ el CHECK
    // vm_netid se re-evalúa sobre la fila resultante, que las conserva ⇒ pasa si la fila ya era
    // coherente. Y NO filtra por `vm` a propósito: las filas pre-fix de una remesa Solana dicen
    // vm='evm', así que agregar .eq("vm", ...) dejaría de mutarlas (una remesa vieja no llegaría nunca
    // a estado terminal). El input.vm se usa SOLO para canonicalizar la address del guard.
    const patch: Record<string, unknown> = {
      status: input.status,
      updated_at: new Date().toISOString(),
    };
    if (input.payoutId !== undefined) patch.payout_id = input.payoutId;
    if (input.error !== undefined) patch.last_error = input.error;
    const { error } = await this.client
      .from(TABLE)
      .update(patch)
      .eq("idempotency_key", input.idempotencyKey)
      .eq("sender_address", canonicalizeAddress(input.senderAddress));
    if (error) throw new Error(`ledger_record_payout_outcome_failed:${error.code ?? "unknown"}`);
  }

  async listStale(input: { olderThanIso: string; limit: number }): Promise<SettlementRecord[]> {
    // AC-4: no-terminales más viejas que el umbral. Global (admin) — sin owner filter (CD-9 exime al
    // reconcile). CD-12: el select trae value_minor::text.
    const { data, error } = await this.client
      .from(TABLE)
      .select(SELECT_COLS)
      .in("status", STALE_STATUSES as unknown as string[])
      .lt("updated_at", input.olderThanIso)
      .limit(input.limit);
    if (error) throw new Error(`ledger_list_stale_failed:${error.code ?? "unknown"}`);
    const rows = (data ?? []) as unknown as RawRow[];
    return rows.map(mapRow);
  }

  async listPreparedOrphans(input: {
    olderThanIso: string;
    limit: number;
  }): Promise<{ total: number; records: SettlementRecord[] }> {
    // WKH-213: órdenes 'prepared' cuyo settle nunca aterrizó. Global (admin), sin owner filter (mismo
    // criterio que listStale). CD-12: el select trae value_minor::text.
    // created_at (NO updated_at): una fila 'prepared' no se toca de nuevo, así que su updated_at no
    // envejece respecto de su nacimiento — el reloj con sentido es cuánto hace que se creó la orden.
    // count:"exact" ⇒ PostgREST devuelve el total de coincidencias en Content-Range, INDEPENDIENTE
    // del .limit() (la página). Sin eso no se puede distinguir "hay 100" de "hay 100.000".
    const { data, error, count } = await this.client
      .from(TABLE)
      .select(SELECT_COLS, { count: "exact" })
      .eq("status", "prepared")
      .lt("created_at", input.olderThanIso)
      .order("created_at", { ascending: true }) // las más viejas primero (las que más urgen)
      .limit(input.limit);
    if (error) throw new Error(`ledger_list_prepared_failed:${error.code ?? "unknown"}`);
    // Un count ausente NO se degrada a records.length: eso reportaría "total: 3" sobre una página de 3
    // cuando podría haber 300. Sin conteo exacto no hay respuesta honesta ⇒ se tira (la route → 503).
    if (typeof count !== "number") throw new Error("ledger_list_prepared_count_missing");
    const rows = (data ?? []) as unknown as RawRow[];
    return { total: count, records: rows.map(mapRow) };
  }

  async listRemittanceIdsBySender(input: {
    senderAddress: string;
    vm: "evm" | "solana";
    limit: number;
  }): Promise<SenderRemittanceRef[]> {
    // HU-SOL-20/AC-2: recuperación del remittanceId cuando el cliente lo perdió. OWNER-SCOPED: el
    // `.eq("sender_address", ...)` es el ÚNICO guard real (el service key bypassea RLS) ⇒ borrarlo es
    // un IDOR que expone las remesas de terceros.
    // NO filtra por `vm`, A PROPÓSITO y sigue siendo correcto DESPUÉS del fix de escritura: las filas
    // escritas ANTES de este fix (o sea TODAS las remesas Solana ya existentes) dicen vm='evm', y son
    // precisamente las que este fallback tiene que poder recuperar ⇒ un .eq("vm","solana") las perdería
    // y devolvería CERO. La address ya discrimina la VM sin ayuda de la columna (base58 case-sensitive
    // vs 0x+40hex lowercased — ver canonicalizeAddress). El test T-R0-1 (§4.2) se pone ROJO si alguien
    // agrega ese filtro.
    // NO filtra por status: las filas que interesan nacen 'prepared' (recordOrderPrepared), que NO está
    // en STALE_STATUSES; el status viaja en la respuesta y decide el consumidor.
    // NUNCA selecciona value_minor (no se lee ⇒ el ::text de CD-12 no aplica) ni PII (CD-7).
    const { data, error } = await this.client
      .from(TABLE)
      .select("remittance_id, status, created_at")
      .eq("sender_address", canonicalizeAddress(input.senderAddress)) // ← EL GUARD
      .order("created_at", { ascending: false })
      .limit(input.limit);
    if (error) throw new Error(`ledger_list_by_sender_failed:${error.code ?? "unknown"}`);
    const rows = (data ?? []) as unknown as Array<{
      remittance_id: string;
      status: SettlementLedgerStatus;
      created_at: string;
    }>;
    return rows.map((r) => ({
      remittanceId: r.remittance_id,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  async listPreparedDepositAddresses(input: {
    remittanceId: string;
    senderAddress: string;
  }): Promise<string[]> {
    // Las deposit-address que ESTE servidor registró al preparar la remesa. El settle Solana compara
    // contra esto el beneficiary que viaja dentro de la tx firmada (ver el port). OWNER-SCOPED: el
    // `.eq("sender_address", ...)` es el guard real (el service key bypassea RLS).
    // NO filtra por status: un settle reintentado encuentra su fila ya en 'principal_in' y su
    // receiver_address sigue siendo la misma dirección; filtrar por 'prepared' haría que el retry
    // pareciera "no registrada".
    // TIRA ante cualquier error de la consulta: devolver [] sería indistinguible de "no hay ninguna
    // registrada", y esos dos desenlaces terminan en respuestas distintas del settle a propósito.
    const { data, error } = await this.client
      .from(TABLE)
      .select("receiver_address")
      .eq("remittance_id", input.remittanceId)
      .eq("sender_address", canonicalizeAddress(input.senderAddress)); // ← EL GUARD
    if (error) throw new Error(`ledger_list_prepared_addresses_failed:${error.code ?? "unknown"}`);
    const rows = (data ?? []) as unknown as Array<{ receiver_address: unknown }>;
    // Una fila con receiver_address no-string es una fila que NO puede afirmar ninguna dirección: se
    // descarta en vez de convertirse en un "" que después compararía como una dirección vacía.
    return rows
      .map((r) => r.receiver_address)
      .filter((a): a is string => typeof a === "string" && a.length > 0);
  }

  async markOutcome(input: {
    id: string;
    status: SettlementLedgerStatus;
    payoutId?: string | null;
    error?: string | null;
    incrementAttempt: boolean;
  }): Promise<void> {
    // Por id (admin, owner-agnóstico). incrementAttempt ⇒ lee-incrementa-escribe (Supabase JS no
    // expresa `attempts = attempts + 1` sin RPC; el reconcile es de baja concurrencia).
    // UPDATE de status/attempts/last_error: NO toca vm/chain_id/network_id ⇒ nada que acoplar al CHECK
    // vm_netid (la fila conserva su identidad de red).
    const patch: Record<string, unknown> = {
      status: input.status,
      updated_at: new Date().toISOString(),
    };
    if (input.payoutId !== undefined) patch.payout_id = input.payoutId;
    if (input.error !== undefined) patch.last_error = input.error;
    if (input.incrementAttempt) {
      const { data, error: readErr } = await this.client
        .from(TABLE)
        .select("attempts")
        .eq("id", input.id)
        .single();
      if (readErr) throw new Error(`ledger_mark_outcome_read_failed:${readErr.code ?? "unknown"}`);
      const current = (data as { attempts?: number } | null)?.attempts ?? 0;
      patch.attempts = current + 1;
    }
    const { error } = await this.client.from(TABLE).update(patch).eq("id", input.id);
    if (error) throw new Error(`ledger_mark_outcome_failed:${error.code ?? "unknown"}`);
  }

  async recordWebhookOutcome(input: {
    payoutId: string;
    status: SettlementLedgerStatus;
  }): Promise<WebhookOutcome> {
    // WKH-210: UPDATE por payout_id, NO owner-scoped (el guard es el HMAC del endpoint, CD-12). El
    // filtro .in("status", ...) = no-terminal set (DT-2b): nunca degrada un estado terminal ni
    // reclasifica manual_review. NO lee columnas ⇒ no aplica el ::text de value_minor (es un UPDATE
    // puro, no un select). last_error es un enum estable, NUNCA PII (CD-3).
    // WKH-213/R1: el conjunto incluye 'prepared'. Con STALE_STATUSES (que NO lo incluye) el proveedor
    // podía avisar "pagado" sobre una orden cuyo settle nunca aterrizó y la fila se quedaba idéntica:
    // el aviso se perdía. 'prepared' es no-terminal ⇒ es mutable por el webhook.
    // NO toca vm/chain_id/network_id (UPDATE parcial) ⇒ nada que acoplar al CHECK vm_netid. Tampoco
    // discrimina por VM: correlaciona por payout_id, que es VM-agnóstico.
    //
    // WKH-325 — un `fund_failed` del proveedor tapa TRES situaciones distintas, y la que aplica la
    // dice el ESTADO PREVIO de la fila. El estado previo NO se lee: va en el WHERE de cada UPDATE.
    const nowIso = new Date().toISOString(); // UNA sola marca para las 3 escrituras

    // (I) Rama NO-failed: el camino de siempre, intacto. El patch es {status, updated_at} y NUNCA
    //     lleva last_error — un asset_deposited/fund_settled no tiene nada que clasificar.
    if (input.status !== "failed") {
      const { error } = await this.client
        .from(TABLE)
        .update({ status: input.status, updated_at: nowIso })
        .eq("payout_id", input.payoutId)
        .in("status", WEBHOOK_UPDATABLE_STATUSES as unknown as string[]); // no-terminal set (DT-2b + R1)
      if (error) throw new Error(`ledger_record_webhook_outcome_failed:${error.code ?? "unknown"}`);
      return { classified: false };
    }

    // (II) Rama failed: N=3 UPDATEs DISJUNTOS. Cada uno lleva SU estado previo esperado en el WHERE
    //      (compare-and-set, sin lectura previa) y su propio last_error. El `.select("id")` es lo
    //      único que permite saber CUÁL matcheó: sin él, un UPDATE de 0 filas es indistinguible de uno
    //      exitoso (mismo motivo que el paso 1 de recordPrincipalIn). Pide "id" y nada más — NO sirve
    //      para leer el estado previo: PostgREST devuelve la representación POSTERIOR al patch, o sea
    //      'failed', que es justo el valor que no aporta nada.
    //      El ORDEN no importa: ningún conjunto contiene 'failed', así que una fila mutada por un
    //      UPDATE sale de todos los demás conjuntos y ninguna se clasifica dos veces.
    //      Un fallo a mitad de camino deja cada fila individual final y correcta: la función tira, la
    //      route responde 503 sin quemar la key del claim, y la re-entrega completa el resto sin
    //      re-escribir lo ya clasificado (at-least-once de WKH-210, conservado).
    const failures: WebhookFailureClass[] = [];
    for (const spec of WEBHOOK_FAILURE_CLASSES) {
      const { data, error } = await this.client
        .from(TABLE)
        .update({ status: "failed", last_error: spec.lastError, updated_at: nowIso })
        .eq("payout_id", input.payoutId)
        .in("status", spec.previousStatuses as unknown as string[])
        .select("id");
      if (error) throw new Error(`ledger_record_webhook_outcome_failed:${error.code ?? "unknown"}`);
      if ((data ?? []).length > 0) failures.push(spec.failureClass);
    }
    return { classified: true, failures };
  }
}

/**
 * Factory del ledger. Devuelve null cuando SETTLEMENT_LEDGER_ENABLED !== "true" (flag OFF, CD-2) O el
 * cliente Supabase es null (envs ausentes) ⇒ las rutas skipean el persist ⇒ byte-idéntico
 * (AC-2/AC-10). La env se lee en runtime (CD-14).
 */
export function getSettlementLedger(): SettlementLedger | null {
  if (process.env.SETTLEMENT_LEDGER_ENABLED !== "true") return null;
  const client = getSupabaseServerClient();
  if (!client) return null;
  return new SupabaseSettlementLedger(client);
}
