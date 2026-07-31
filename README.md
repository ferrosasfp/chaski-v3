[Español](README.es.md)

# Chaski

Chaski is a crypto to fiat remittance app that never takes custody of the money. The sender connects
a wallet and the principal is locked in an escrow account on Solana. A release authority can move it
only to the beneficiary that was fixed at deposit time, and only once the payout in the destination
country is confirmed. If that never happens, the sender signs a refund and takes their own funds back
without anyone's permission. The escrow is an Anchor program on devnet, with no real money involved.

> **Status.** Devnet. The repo's default configuration moves nothing: settlement sits behind a flag
> that ships off, and the fiat payout runs against a mock adapter. See
> [Configuration](#configuration) for exactly which switch turns on what.

## What works today, and what does not

Working on devnet:

- The full product flow: amount with a rate preview, wallet connection, identity verification,
  review, confirmation, tracking and receipt.
- Non custodial deposit into the escrow, signed by the sender's wallet. The transaction is paid by a
  sponsoring fee payer, so the user never needs SOL.
- Release and refund against the escrow. The release authority runs server side and its private key
  does not live in this repo.
- An on chain index of a sender's escrows, so a remittance whose local identifier was lost can still
  be recovered.
- A settlement ledger in Postgres that records the network of every row as a CAIP-2 identifier
  (`solana:devnet`). The column also keeps a legacy discriminator, because it describes rows that
  were already written: pruning code is not the same as rewriting the history of a database.

Under construction or deliberately off:

- The fiat payout runs against a mock adapter by default. The real adapter exists and is wired, but
  it requires provider credentials that are not in this repo.
- None of this points at mainnet. The smoke script aborts if the cluster is not devnet.

## The money path

The escrow is an Anchor program deployed on devnet:

```
DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x
```

Six instructions: `deposit`, `release`, `refund`, `close`, `register_escrow`, `deregister_escrow`.

Per remittance state lives in a PDA derived from `[b"escrow", sender, remittance_id]`, where
`remittance_id` is a 16 byte array. The funds live in the associated token account of that PDA for
the mint, so the vault address is a function of the escrow account and cannot be pointed elsewhere.

The cycle:

1. The app asks the server for the deposit parameters. If the release authority pubkey is not
   configured, the server answers 503 instead of continuing.
2. The sender's wallet signs `deposit`, which takes `beneficiary`, `authority`, `amount` and
   `deadline` as arguments. The USDC leaves the sender's account and lands in the escrow vault. The
   operator never touches it.
3. The facilitator co-signs as fee payer and broadcasts, so the user needs no SOL. Requesting that
   sponsorship requires proof of possession of the key: an ed25519 signature over a server issued
   challenge, bound to the network through its CAIP-2 identifier so it cannot be replayed against
   another cluster.
4. Once the payout in the destination country is confirmed, the release authority signs `release`.
   `sender`, `beneficiary` and `mint` are `has_one` constrained against the escrow account, so the
   destination is the one fixed at deposit time and the authority cannot redirect the funds.
5. If something fails, the sender signs `refund` and the principal goes back to whoever deposited it,
   with no other signature required. The program rejects it unless the escrow is in the `Deposited`
   state and the deadline has passed (`EscrowNotDeposited` 6002, `DeadlineNotReached` 6003).

### The IDL is pinned by hash

The program IDL is vendored at `src/infrastructure/solana/escrow-idl.ts` and its canonical SHA-256 is
fixed in `contracts/idl/escrow-idl.hash.test.ts`, which runs on every `npm test`. The same test also
pins the program id and the positional account order of `deposit`, `refund` and `register_escrow`. If
someone hand edits the vendored IDL, or the deployed program reorders its accounts, the suite goes red
before a transaction gets rejected in production. Re pinning is an explicit decision with its entry in
`contracts/CONTRACT-VERSIONS.md`, never a silent drift. The pinned value matches the one held by
`wasiai-facilitator`.

### Devnet smoke

`npm run smoke:solana` runs the whole cycle against already deployed services. It is deliberately
uncomfortable to run:

- It aborts before any call unless `SMOKE_ALLOW_REAL=true`. It does not run in CI.
- Every input is an environment variable. There is no hardcoded URL, key, cluster or mint. If one is
  missing it aborts and prints the variable's name, never its value.
- The cluster is a `devnet` constant in the script. There is no fallback to mainnet.

## Running it

Requires Node 22 (tested on 22.22.0).

```bash
git clone https://github.com/ferrosasfp/chaski-v3.git
cd chaski-v3
npm install --legacy-peer-deps
cp .env.example .env.local     # everything empty starts in demo mode and moves no funds
npm run dev                    # http://localhost:3000
```

The dependency tree mixes React 19 with packages that still declare React 18 peers, hence
`--legacy-peer-deps`.

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Next in development |
| `npm run build` | Production build |
| `npm start` | Serves the build |
| `npm run typecheck` | `tsc --noEmit` over the app |
| `npm run typecheck:scripts` | `tsc --noEmit` over `scripts/`, which is outside the Next build |
| `npm test` | `vitest run`, the whole suite |
| `npm run test:core` | Domain and application only, no infrastructure or components |
| `npm run qa` | The full gate: lint, both typechecks and the suite |
| `npm run smoke:solana` | End to end smoke against devnet. Opt in, see above |
| `npm run lint` | `biome lint src app scripts` |

## Tests

**692 cases across 57 files**, all green. They break down as:

- Domain and application with test doubles, no network, wallet or browser. That is where the money
  path invariants live: nothing is confirmed without a verified identity and a live quote, an expired
  quote fails closed, the state machine admits no jumps.
- API routes, infrastructure adapters and components with Testing Library.
- Contract tests against pinned copies of each external service's output (`contracts/`). If a provider
  changes the shape of its response and someone re vendors the copy, the consumer's test goes red
  instead of breaking in production.
- The escrow IDL pinned by canonical hash (`contracts/idl/escrow-idl.hash.test.ts`), described above.
- A repo wide guarantee (`src/composition/no-evm-surface.test.ts`) that this app cannot acquire a
  second execution environment. It walks `src/`, `app/`, `scripts/` and `contracts/` on every run and
  fails on the import shaped patterns that would reintroduce one. Being a Solana application is not a
  matter of anyone remembering: a test holds it in place.

```bash
npm test          # 692 tests
npm run qa        # typechecks + tests
```

## Architecture

Clean Architecture, with the dependency rule pointing inward.

```
presentation   ->  application (use cases + ports)  ->  domain
infrastructure ->  implements the ports, injected at the composition root
```

- **`src/domain/`** is pure, with no dependencies. `Money` in minor units, zero floats. `Remittance`
  with the state machine (`created`, `kyc_pending`, `kyc_passed`, `quoted`, `confirmed`,
  `principal_in`, `payout_submitted`, `settled`, `refunded`, plus the failure states) and the business
  invariants.
- **`src/application/`** holds the use cases and the ports they need. They depend on interfaces only,
  never on a concrete adapter.
- **`src/infrastructure/`** holds the adapters: wallet, escrow, settlement, attestations, Postgres
  ledger, identity, rate limiting, agent clients.
- **`src/composition/container.ts`** is the only place that knows concrete classes. That is where the
  guards live that make an incoherent configuration break at startup rather than mid transfer.
- **`app/`** is the Next shell and the server only API routes, the ones that talk to external services
  with server side keys.

The domain knowing nothing about React or `@solana/web3.js` is what makes it possible to test the
money path with doubles, in milliseconds, without a browser.

The agent that quotes the FX rate is resolved at run time: the app asks the A2A gateway for the
capability it needs and calls whatever agent comes back, with no fixed URL or slug in the code and
with its own server side agent key. It is fail closed, so if the gateway does not answer the operation
stops instead of falling back to a direct call. That path sits behind a flag and ships off.

Identity verification and the payout are still integrated point to point rather than through the
gateway. Moving them onto the same rail is pending work, and the payout additionally has to preserve
the attestation that binds the deposit address to the remittance.

## Configuration

Every variable is documented in `.env.example`. The design rule is that **every default is the safe
one**: with an empty file the app comes up in demo mode and moves no funds.

| Variable | Default | Effect |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` | off | Enables the escrow deposit and gas sponsorship |
| `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` | `fallback` | `a2a` or `a2a-gateway` use the real agents |

The composition root guards are fail loud. Turning settlement on without a mint or without the
facilitator pubkey stops the app from starting at all. The point is that a configuration mistake shows
up at deploy time and not while money is in flight.

There is one more guard, and its scope is deliberate: the composition root refuses to start if it
finds environment variables belonging to a settlement path this code does not have. That configuration
lives outside the code, in the hosting provider's dashboard, which is the only place where it can be
left orphaned without anyone noticing.

Database migrations live in `supabase/migrations/`.

## Stack

Next 16 with the App Router, React 19, TypeScript in strict mode, Tailwind, Vitest. `@coral-xyz/anchor`,
`@solana/web3.js` and `@solana/wallet-adapter-*` for Solana, `tweetnacl` and `bs58` for the ed25519
proof of possession.

## License

MIT. See [LICENSE](LICENSE).
