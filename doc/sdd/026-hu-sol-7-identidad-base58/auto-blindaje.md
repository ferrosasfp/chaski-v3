# Auto-Blindaje — HU-SOL-7 / WKH-213 (identidad multi-VM base58, gate IDOR)

### [2026-07-21 20:55] Wave 1 — Cascada del port en inline-types del impl
- **Error**: al agregar `vm` al port `SettlementLedger`, `tsc` NO marcaba rojo el impl real
  (`supabase-settlement-ledger.ts`) porque sus métodos declaran el tipo del param con un object-literal
  inline propio, no `Parameters<SettlementLedger[...]>`. Podía haber quedado sin `input.vm` usable.
- **Causa raíz**: bivarianza de métodos — un param inline con MENOS props sigue satisfaciendo el port; el
  impl compilaría pero `input.vm` no existiría en el tipo local.
- **Fix**: agregar `vm: "evm" | "solana";` a los 3 object-literals inline del impl (y del `FakeSettlementLedger`),
  no solo al port. Sin eso, `canonicalizeAddress(input.senderAddress, input.vm)` no tipa.
- **Aplicar en**: cualquier HU que extienda un port cuyo impl/fake use inline-types en vez de derivar del
  port. Revisar SIEMPRE impl + fake + los inputs literales de los tests (cascada WKH-207/211).

### [2026-07-21 21:05] Wave 3 — `lowercase(pubkey)` puede seguir siendo base58 válido
- **Error**: el borrador de W3.2 asumía que `K.toLowerCase()` de una pubkey Solana siempre es base58
  INVÁLIDO (para el test "variante lowercase → throw"). Falso: para
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, `toLowerCase()` sigue siendo un PublicKey válido
  (32 bytes) y DISTINTO → no throw, sino otra key.
- **Causa raíz**: el alfabeto base58 excluye `0 O I l`, pero muchas pubkeys mixed-case lowercaseadas
  siguen cayendo dentro del alfabeto y decodifican a 32 bytes ⇒ válidas. El throw solo ocurre si la
  lowercased introduce un char fuera del alfabeto o rompe el largo.
- **Fix**: el test de "malformada → throw" usa un string explícitamente inválido (`"no-base58-!!!"`),
  NO `K.toLowerCase()`. La no-colisión se prueba con dos pubkeys válidas distintas (`get(K')→null`) y con
  la aserción de case-preservado (`toBase58() !== toLowerCase()`), que ES el core del cierre IDOR.
- **Aplicar en**: HU-SOL-8/HU-SOL-9 y cualquier test de identidad Solana. NUNCA asumir que lowercasear
  una pubkey la invalida; el riesgo IDOR es la COLISIÓN/aliasing, no (solo) el throw.
