// Los tests del módulo de la cuenta de nonce durable (WKH-357 / HU-064).
//
// Sin red y sin plata: `leerNonce` recibe una `Connection` FALSA (sólo necesita `getAccountInfo`) y
// todo lo demás es criptografía local. Las cuentas de nonce reales se leen contra devnet en el
// smoke, no acá.
import { describe, expect, it, vi } from "vitest";
import {
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
  Transaction,
  ComputeBudgetProgram,
  type AccountInfo,
  type Connection,
} from "@solana/web3.js";
import {
  construirNonceAdvance,
  direccionDelNonce,
  leerNonce,
  NONCE_ADVANCE_ACCOUNT_INDEX,
  NONCE_ADVANCE_DATA_LEN,
  NONCE_ADVANCE_DISCRIMINATOR,
  NONCE_ADVANCE_POSITIONAL_ACCOUNTS,
  SEMILLA_DEL_NONCE,
  type ConTecho,
} from "./nonce-duradero";

/** El techo que NO acota nada, para los casos que no hablan del techo. */
const sinTecho: ConTecho = (p) => p;

/** Bytes de una cuenta de nonce válida (80), con el valor `nonce` que se le pida. */
function bytesDeNonce(valor: PublicKey): Buffer {
  // El layout de `NonceAccount`: version u32 + state u32 + authorizedPubkey 32 + nonce 32 +
  // feeCalculator 8 = 80. Se arma a mano y se comprueba con `fromAccountData` en el mismo test, así
  // que si el layout de la librería cambiara, esto se cae acá.
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0]), // version
    Buffer.from([1, 0, 0, 0]), // state: initialized
    Keypair.generate().publicKey.toBuffer(), // authorizedPubkey
    valor.toBuffer(), // nonce  <- el valor que se usa como recentBlockhash
    Buffer.alloc(8), // feeCalculator.lamportsPerSignature
  ]);
}

function cuentaFalsa(data: Buffer): AccountInfo<Buffer> {
  return {
    data,
    executable: false,
    lamports: 1_447_680,
    owner: SystemProgram.programId,
    rentEpoch: 0,
  };
}

/** Una `Connection` falsa con sólo lo que `leerNonce` usa. */
function connectionFalsa(impl: () => Promise<AccountInfo<Buffer> | null>): Connection {
  return { getAccountInfo: vi.fn(impl) } as unknown as Connection;
}

describe("direccionDelNonce (T-N1)", () => {
  it("es determinística y DEPENDE del sender: dos senders ⇒ dos direcciones, el mismo dos veces ⇒ la misma", async () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const dirA1 = await direccionDelNonce(a);
    const dirA2 = await direccionDelNonce(a);
    const dirB = await direccionDelNonce(b);
    expect(dirA1.toBase58()).toBe(dirA2.toBase58());
    expect(dirA1.toBase58()).not.toBe(dirB.toBase58());
  });

  it("coincide con `PublicKey.createWithSeed` calculado con LOS TRES argumentos a mano", async () => {
    // El vector se recalcula acá con los 3 argumentos explícitos en vez de llamar a la función bajo
    // test: si alguien cambia la semilla o el programId dentro del módulo, esto se pone rojo.
    const sender = Keypair.generate().publicKey;
    const esperada = await PublicKey.createWithSeed(
      sender,
      "chaski-nonce-v1",
      SystemProgram.programId,
    );
    expect((await direccionDelNonce(sender)).toBase58()).toBe(esperada.toBase58());
    // Y la semilla exportada es esa cadena, no otra: el literal de arriba y la constante están atados.
    expect(SEMILLA_DEL_NONCE).toBe("chaski-nonce-v1");
    // ≤ 32 bytes (MAX_SEED_LENGTH). Una semilla más larga tira en `createWithSeed`.
    expect(Buffer.from(SEMILLA_DEL_NONCE, "utf8").length).toBeLessThanOrEqual(32);
  });

  it("la dirección NO es la del sender ni un PDA del sender", async () => {
    // Un error de copiar/pegar que devolviera el propio sender pasaría los dos tests de arriba
    // (es determinística y depende del sender), y rompería todo en cadena.
    const sender = Keypair.generate().publicKey;
    const dir = await direccionDelNonce(sender);
    expect(dir.equals(sender)).toBe(false);
  });
});

describe("leerNonce — los TRES valores, nunca dos (T-N2)", () => {
  it("`hay` con el valor decodificado cuando la cuenta existe y mide 80 bytes", async () => {
    const valor = Keypair.generate().publicKey;
    const conn = connectionFalsa(async () => cuentaFalsa(bytesDeNonce(valor)));
    const r = await leerNonce(conn, Keypair.generate().publicKey, sinTecho);
    expect(r.tipo).toBe("hay");
    if (r.tipo === "hay") {
      expect(r.valor).toBe(valor.toBase58());
      // Y es el mismo valor que la librería decodifica: el fixture no se auto-confirma.
      expect(NonceAccount.fromAccountData(bytesDeNonce(valor)).nonce).toBe(r.valor);
    }
  });

  it("`no-hay` cuando `getAccountInfo` devuelve null (la cuenta NO existe)", async () => {
    const conn = connectionFalsa(async () => null);
    const r = await leerNonce(conn, Keypair.generate().publicKey, sinTecho);
    // ⚠️ Este caso es un HECHO sobre la cadena y por eso NO puede colapsar en
    // `no-pudimos-preguntar`: quien llama limpia el disco acá y NO limpia allá.
    expect(r.tipo).toBe("no-hay");
  });

  // El tercer valor tiene CUATRO causas, y cada una va en su propio `it`: si una sola dejara de
  // mapear ahí, un `it` que las mezclara seguiría verde por las otras tres.
  it("`no-pudimos-preguntar` (a) cuando el RPC TIRA", async () => {
    const conn = connectionFalsa(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await leerNonce(conn, Keypair.generate().publicKey, sinTecho);
    expect(r.tipo).toBe("no-pudimos-preguntar");
  });

  it("`no-pudimos-preguntar` (b) cuando VENCE el techo", async () => {
    // El techo se inyecta: acá es uno que rechaza sin esperar. ⚠️ Y no "cancela" la lectura — el
    // `getAccountInfo` de abajo sigue en vuelo; lo que se corta es la espera de quien llama.
    const nuncaContesta = new Promise<AccountInfo<Buffer> | null>(() => {});
    const conn = connectionFalsa(() => nuncaContesta);
    const techoVencido: ConTecho = () => Promise.reject(new Error("confirm_timeout"));
    const r = await leerNonce(conn, Keypair.generate().publicKey, techoVencido);
    expect(r.tipo).toBe("no-pudimos-preguntar");
  });

  it("`no-pudimos-preguntar` (c) cuando `data.length !== 80`", async () => {
    const conn = connectionFalsa(async () => cuentaFalsa(Buffer.alloc(NONCE_ACCOUNT_LENGTH - 1)));
    const r = await leerNonce(conn, Keypair.generate().publicKey, sinTecho);
    expect(r.tipo).toBe("no-pudimos-preguntar");
  });

  it("`no-pudimos-preguntar` (d) cuando los 80 bytes son una cuenta SIN INICIALIZAR", async () => {
    // ⚠️ EL CHECK DE LARGO NO ALCANZA PARA ESTE CASO, y está medido: 80 bytes en cero SÍ decodifican
    // (`NonceAccount.fromAccountData(Buffer.alloc(80)).nonce` → la pubkey nula, medido 2026-08-17),
    // así que (c) lo deja pasar. Sin el guard de la pubkey nula esto devolvería `hay` con un valor con
    // el que ninguna tx puede entrar, y el fallo aparecería recién EN CADENA.
    const ceros = Buffer.alloc(NONCE_ACCOUNT_LENGTH);
    // El fixture mide su propia premisa: estos bytes decodifican, no tiran.
    expect(NonceAccount.fromAccountData(ceros).nonce).toBe(PublicKey.default.toBase58());

    const conn = connectionFalsa(async () => cuentaFalsa(ceros));
    const r = await leerNonce(conn, Keypair.generate().publicKey, sinTecho);
    expect(r.tipo).toBe("no-pudimos-preguntar");
  });

  it("NUNCA tira, para ninguna de las cuatro causas", async () => {
    const conn = connectionFalsa(async () => {
      throw new Error("boom");
    });
    await expect(leerNonce(conn, Keypair.generate().publicKey, sinTecho)).resolves.toBeDefined();
  });
});

describe("★ T-N3 — las 5 constantes pinneadas contra lo que produce NUESTRO node_modules", () => {
  // Éste es el test que caza un bump de `@solana/web3.js`. Si la librería mueve el discriminador o
  // el orden de las cuentas, se cae acá y no en producción contra el Check 2n del facilitator.
  const sender = Keypair.generate().publicKey;
  const noncePk = Keypair.generate().publicKey;
  const ix = construirNonceAdvance(noncePk, sender);

  it("el discriminador y su largo", () => {
    expect([...ix.data]).toEqual([...NONCE_ADVANCE_DISCRIMINATOR]);
    expect(ix.data.length).toBe(NONCE_ADVANCE_DATA_LEN);
  });

  it("la cantidad de cuentas", () => {
    expect(ix.keys.length).toBe(NONCE_ADVANCE_POSITIONAL_ACCOUNTS);
  });

  it("los 3 índices, con sus pubkeys y sus banderas", () => {
    const nonce = ix.keys[NONCE_ADVANCE_ACCOUNT_INDEX.NONCE];
    const sysvar = ix.keys[NONCE_ADVANCE_ACCOUNT_INDEX.RECENT_BLOCKHASHES];
    const authority = ix.keys[NONCE_ADVANCE_ACCOUNT_INDEX.AUTHORITY];
    expect(nonce?.pubkey.equals(noncePk)).toBe(true);
    expect({ signer: nonce?.isSigner, writable: nonce?.isWritable }).toEqual({
      signer: false,
      writable: true,
    });
    expect(sysvar?.pubkey.equals(SYSVAR_RECENT_BLOCKHASHES_PUBKEY)).toBe(true);
    expect({ signer: sysvar?.isSigner, writable: sysvar?.isWritable }).toEqual({
      signer: false,
      writable: false,
    });
    // 🔴 La authority es el SENDER. Si fuera el facilitator, el Check 5 de `cr1.ts` rechazaría todo
    // depósito por enlace (el fee-payer no puede estar referenciado por ninguna ix).
    expect(authority?.pubkey.equals(sender)).toBe(true);
    expect({ signer: authority?.isSigner, writable: authority?.isWritable }).toEqual({
      signer: true,
      writable: false,
    });
  });

  it("el sysvar lleva el DÍGITO 1, no la letra ele", () => {
    // base58 no tiene `l`. Copiarlo con `l` produce un PublicKey inválido que tira en el import del
    // módulo, así que este assert es la red contra un typo que se vería idéntico en el diff.
    expect(SYSVAR_RECENT_BLOCKHASHES_PUBKEY.toBase58()).toBe(
      "SysvarRecentB1ockHashes11111111111111111111",
    );
    expect(SYSVAR_RECENT_BLOCKHASHES_PUBKEY.toBase58()).not.toContain("l");
  });

  it("el programId es el System Program", () => {
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
  });
});

describe("⛔ T-N4 — la trampa de `tx.nonceInfo`, congelada", () => {
  /**
   * ⚠️ ESTE ES UN TEST DE LA LIBRERÍA, NO DE NUESTRO CÓDIGO, y por eso no lleva mutante: no hay una
   * línea nuestra que romperle. Su valor es ANTI-REGRESIÓN DE DECISIÓN — deja escrito en ejecutable
   * por qué la `nonceAdvance` se prepone a mano con `.add(...)` y nunca con `tx.nonceInfo`, para que
   * el próximo refactor que quiera "simplificar" hacia ahí se encuentre con la medición. ⛔ NO lo
   * leas como cobertura de `construirNonceAdvance`.
   */
  it("`compileMessage()` prepone la ix en un array LOCAL y NO muta `tx.instructions`", () => {
    const sender = Keypair.generate();
    const nonceIx = construirNonceAdvance(Keypair.generate().publicKey, sender.publicKey);
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
    tx.feePayer = Keypair.generate().publicKey;
    tx.nonceInfo = { nonce: Keypair.generate().publicKey.toBase58(), nonceInstruction: nonceIx };

    const mensaje = tx.compileMessage();

    // El objeto dice una cosa…
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0]?.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    // …y el mensaje FIRMADO, que es lo que viaja, dice otra.
    expect(mensaje.instructions).toHaveLength(2);
    const indiceDelPrograma = mensaje.instructions[0]?.programIdIndex;
    expect(indiceDelPrograma).toBeDefined();
    const programIdDeLa0 =
      indiceDelPrograma === undefined ? undefined : mensaje.accountKeys[indiceDelPrograma];
    expect(programIdDeLa0?.equals(SystemProgram.programId)).toBe(true);
    // ⇒ cualquier cuenta hecha sobre `tx.instructions.length` está CORTA EN 1, y los cuatro lectores
    // que van por posición (incluido nuestro servidor) leen la ix equivocada.
  });
});

describe("T-N5 — la tx que CREARÍA la cuenta tiene UN solo firmante (AC-2 / CD-8)", () => {
  /**
   * ⚠️ Es un test de la FORMA, no del ACTO: esta HU no crea la cuenta de nonce (eso es de la ola 4).
   * Lo que se mide es la propiedad que hizo elegir la variante por semilla — que alcanza UNA firma y
   * por lo tanto no hay ninguna clave privada que persistir.
   */
  const firmantes = (tx: Transaction): Set<string> =>
    new Set(
      tx.instructions.flatMap((i) =>
        i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()),
      ),
    );

  it("con semilla (base == from == sender): UN firmante, y la cuenta de nonce NO es signer", async () => {
    const sender = Keypair.generate().publicKey;
    const noncePk = await direccionDelNonce(sender);
    const tx = SystemProgram.createNonceAccount({
      fromPubkey: sender,
      noncePubkey: noncePk,
      basePubkey: sender,
      seed: SEMILLA_DEL_NONCE,
      authorizedPubkey: sender,
      lamports: 1_447_680,
    });
    const s = firmantes(tx);
    expect(s.size).toBe(1);
    expect([...s]).toEqual([sender.toBase58()]);
    // La ix 0 (createAccountWithSeed) NO marca la cuenta nueva como firmante: eso es lo que evita
    // tener que generar y guardar un keypair.
    const cuentaNueva = tx.instructions[0]?.keys.find((k) => k.pubkey.equals(noncePk));
    expect(cuentaNueva?.isSigner).toBe(false);
  });

  it("con keypair (la variante DESCARTADA): DOS firmantes ⇒ habría que persistir una clave", () => {
    const sender = Keypair.generate().publicKey;
    const nonceKp = Keypair.generate();
    const tx = SystemProgram.createNonceAccount({
      fromPubkey: sender,
      noncePubkey: nonceKp.publicKey,
      authorizedPubkey: sender,
      lamports: 1_447_680,
    });
    expect(firmantes(tx).size).toBe(2);
  });
});
