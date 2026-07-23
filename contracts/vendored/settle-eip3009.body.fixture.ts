// COPIA PINNEADA, NO SE EDITA — WKH-227 / HU-SOL-24.
// Origen: wasiai-facilitator/src/contracts/settle-eip3009.body.fixture.ts. Sync: 2026-07-22.
// Fixture vendoreado del CONTRATO del provider (/settle). Se sincroniza MANUALMENTE en el mismo PR que
// cambie el provider (DT-1 — ver CONTRACT-VERSIONS.md). El contract test de este repo compara byte-a-byte
// el body que arma broadcastSettle() contra esta copia: si el facilitator agrega un campo requerido y se
// re-vendorea, el body del consumer no lo incluye → toEqual mismatch → ROJO (AC-1).
//
// ── CD-4 (árbitro consumer) ──────────────────────────────────────────────────────────────────────
// El origen W2 usó valores PLACEHOLDER para los campos runtime-variables de payload:
//   · payload.signature: "0x"+"ab"*65 (65-byte sig de shape) — se conserva (es INPUT del broadcast).
//   · payload.authorization.nonce: "0x"+"cd"*32 (placeholder).
// El body REAL que arma chaski usa el nonce DETERMINÍSTICO keccak256("<remittanceId>:<quoteId>")
// (CD-19, wallet.ts:deterministicNonce). Para el fixture determinístico (remittanceId="rmt_fixed_0001",
// quoteId="q_fixed_0001") ese nonce = 0xdbe8185143ae74c74fd732bc99ea20992b6c4904b208b19a85afa598986aac82.
// CD-4: gana la salida REAL del consumer → se re-pinnea el nonce acá (el resto del body es idéntico a W2).
// Amounts = decimal STRING (AC-5).
export const settleVendoredFixture = {
  x402Version: 2, // z.literal(2) — el NÚMERO, no "2"
  resource: { url: "https://chaski.example/api/settle" },
  accepted: {
    scheme: "exact",
    network: "eip155:84532", // eip155:<chainId>
    amount: "400000000", // uint256 decimal STRING (AC-5) — 400 USDC (6 dec)
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC Base Sepolia (0x-hex, AddressHex)
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 60,
    extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
  },
  payload: {
    signature: `0x${"ab".repeat(65)}`, // 65-byte 0x-hex (pasa el regex de PayloadSchema)
    authorization: {
      from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // AddressHex (checksum)
      to: "0x1111111111111111111111111111111111111111",
      value: "400000000", // == accepted.amount (decimal string)
      validAfter: "0",
      validBefore: "1893456000", // decimal string (Date.parse("2030-01-01T00:00:00.000Z")/1000)
      nonce: "0xdbe8185143ae74c74fd732bc99ea20992b6c4904b208b19a85afa598986aac82", // CD-4: nonce REAL determinístico
    },
  },
} as const;
