# Auto-Blindaje — #027 [WKH-211 / HU-SOL-8] PoP ed25519 VM-aware

Registro de traps/errores encontrados durante F3 y cómo se blindaron. Alimenta futuras HUs de la
familia Solana (money-path).

### [2026-07-22] Wave 0 — `bs58@6` es ESM-only: `require('bs58').decode` es `undefined`
- **Trap**: al verificar la API tras `npm install bs58@6.0.0`, `node -e "require('bs58')"` devolvía
  `bs58.decode: undefined` / `bs58.encode: undefined`. Un chequeo apresurado con CommonJS habría
  concluido (falsamente) que la dep no exporta lo que el SDD asume.
- **Causa raíz**: `bs58@6` publica sólo ESM (`"type":"module"`). Bajo `require()` el default export no
  se resuelve como el objeto con `.encode/.decode`. El código del proyecto es ESM (`"type":"module"` en
  package.json) y usa `import bs58 from "bs58"`, que SÍ resuelve correcto.
- **Fix**: verificar la API con `node --input-type=module -e "import bs58 from 'bs58'; ..."` (o dentro
  de un test vitest, que ya corre ESM). `bs58.decode/encode` funcionan y round-trippean. Ningún cambio
  de código: el SDD ya especifica `import bs58 from "bs58"` (ESM default).
- **Aplicar en**: cualquier verificación manual de una dep ESM-only del árbol Solana (bs58, y en
  general libs modernas). NUNCA validar la API de una dep con `require()` en este repo — usar ESM.

### [2026-07-22] Wave 0 — `resolveSolanaNetworkId()`: switch sobre literal `"devnet"` exige `default`
- **Trap**: el `switch (resolveSolanaNetworkConfig().cluster)` con sólo `case "devnet"` deja a `tsc`
  (con `noImplicitReturns`/return-path analysis) sin un return garantizado en todos los caminos, porque
  la función declara `: string`.
- **Causa raíz**: aunque `cluster` es el tipo literal `"devnet"` (exhaustivo hoy), TS no siempre trata
  el switch como return-complete para una función con tipo de retorno explícito.
- **Fix**: agregar `default: throw new Error("unsupported_solana_cluster")` (fail-loud), exactamente el
  fallback que anticipa el Story File (nota TS de §"resolveSolanaNetworkId"). tsc W0 quedó exit 0.
- **Aplicar en**: futuros resolvers `switch` sobre uniones literales de un solo miembro con retorno no
  `void` — agregar `default` fail-loud desde el inicio.
