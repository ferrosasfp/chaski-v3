[Español](README.es.md)

# Chaski

Chaski is a crypto to fiat remittance app that never takes custody of the money. The sender connects a
wallet and the principal is locked in an escrow account on Solana. A release authority can move it only
to the beneficiary that was fixed at deposit time, and only once the payout in the destination country
is confirmed. If that never happens, the sender signs a refund and takes their own funds back without
anyone's permission. The escrow is an Anchor program on devnet, with no real money involved.

The part worth reading twice is the next section: **the remittance logic does not live in Chaski, it
lives in the agents that make up the pipeline.** Chaski orchestrates and consumes. The agents implement.

This is a project under construction. What follows describes what is being built, how a remittance is
composed, and where the work stands today, including the two places where the chain of steps is still
open and why.

> **A note on the name.** The hosting project was created as `chaski-v2` and cannot be renamed from
> here, so the deployed site is served from `chaski-v2.vercel.app`. The same string survives on purpose
> in the `id` field of `public/manifest.json`: changing a PWA manifest `id` orphans existing installs.

## A remittance is assembled, not hardcoded

A remittance is a chain of steps: verify who is sending, price the currency pair, take custody free
delivery of the principal, and pay out in the destination country. Chaski owns none of those steps as
business logic. It owns the order, the invariants and the money's escape hatch.

Each step is a capability, and a capability is fulfilled by whichever agent can fulfill it. The code
asks for `remittance-fx-quote` and for `remittance-payout`. It does not name an agent, and it does not
hold a URL for one. The A2A gateway resolves who answers, and the answer is validated against the shape
the use case expects before it can turn into money moving.

The consequence is the design goal: **the machine can be reassembled on every call.** A better FX agent
replaces the current one without a deploy of this repo. An agent that covers two steps at once collapses
two calls into one. A new destination country is a new agent that declares the payout capability, not a
branch in a switch statement here.

Where that stands today, in present tense:

- **The active path is point to point.** With the default configuration, the quote and the payout leg
  call a known base URL. It works, and it is the transport the flow runs on.
- **The by capability path exists and ships off.** It is real code, not a plan:
  `app/api/a2a/quote/route.ts:46-64` and `app/api/payout/prepare/route.ts:194-213` send a `capability`
  to the gateway and let it choose the agent. The payout leg additionally carries a reputation floor as
  a constraint. Both branches are behind `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER=a2a-gateway`, which is not
  the default.
- **It is fail closed on purpose.** If the gateway does not answer, the operation stops. It never falls
  back to a direct call, because a silent fallback would create the payout order with a different agent
  than the one the rest of the flow was built around.
- **Identity is not on this rail yet.** KYC is still a direct integration with a provider
  (`src/infrastructure/didit/kyc-gateway.ts`), with no capability declared for it. Moving it onto the
  same rail is open work.

## Where this is today

The escrow is deployed on devnet and its three money instructions have executed on chain. Anyone can
check these against the public devnet RPC without asking permission:

| Instruction | Signature | What the balances show |
|---|---|---|
| `deposit` | [`22A61Cync…`](https://explorer.solana.com/tx/22A61CyncHSGGHHDujNVJUvrgx8wxETSaGzPFdHrE9WMxatsxr4vNTg6JFesBQdBdbycTj6iF3gX2eoRY65JcFnN?cluster=devnet) | principal leaves the sender and lands in the escrow vault |
| `release` | [`2opxzWsKCB…`](https://explorer.solana.com/tx/2opxzWsKCBCTXugexSPTBFnvvjYmunH9Z6KS1SCRToR6g3RaBZ5tFjqEqc6Eq2WHf4eabFGiEeHKs5tKY21iRs9a?cluster=devnet) | vault goes to zero, the beneficiary receives |
| `refund` | [`4GDwrHgsu2…`](https://explorer.solana.com/tx/4GDwrHgsu2kcJub8A2r8Nh5oRU5uA6DYqXgGoFKG1H9Nw9oYyPC5ooYWR9AAusLjhG1u4tCp5fSWo5DSgkkhyikk?cluster=devnet) | vault goes to zero, the sender gets the principal back |

Those three moved an SPL token minted for testing
(`8yRX3fZ2hFtTFdBhUBG7jZwnNEwYUFhMFsDP7vzWwz3Q`, six decimals), not Circle's devnet USDC. The mint the
app is configured against is Circle's (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), and it is a
single environment variable, never a hardcode. Saying "USDC moved" about those signatures would be
false, so it is not said here.

**The deposit is the strongest piece, and the caveat matters.** The instruction lands on chain, the
sender's wallet is the only signer of the transfer, and a sponsoring fee payer covers the fees so the
user never needs SOL. What the signature above proves is that this works when the smoke script drives
it. From the browser it does not land today, for the reason in the next paragraph: the wallet only
partial signs, and the deposit does not exist on chain until somebody broadcasts it.

**The confirmation from the browser does not complete the broadcast.** The first half of this was
fixed: the client now signs a proof of possession before asking the server to create the payout order,
so the flow no longer dies before the wallet is ever prompted. The second half is still cut, and it is
the same transaction as the deposit, which is why the two are one problem and not two. To broadcast it,
the facilitator requires a `popProof` that is mandatory in its schema
([`solana-sponsor.ts:59`](https://github.com/ferrosasfp/wasiai-facilitator/blob/main/src/routes/solana-sponsor.ts))
and is an HMAC over a secret shared between servers. Chaski's client path does not compute it: the call
at `src/application/use-cases/confirm-and-send.ts:156-161` sends four fields and `popProof` is not one
of them, and the forwarding route only passes it along if it arrived
(`app/api/settle/solana-sponsor/route.ts:57`). The reason it cannot simply be added is the interesting
part: a browser cannot hold a server to server shared secret without leaking it. So the fix is a change
of protocol rather than a missing line, replacing that HMAC with a signature from the same wallet that
is already signing the deposit one step earlier. That replacement is the open work on this leg, and it
is not in this branch.

**The release runs, but nothing decides when to run it.** The instruction is implemented, constrained
and proven on chain, as the table above shows. What does not exist, in any of the three repos, is a
component that observes a confirmed fiat payout and calls the release. Today a person does it by hand,
and the devnet smoke stands in for that absent actor. The consequence is concrete and worth stating
plainly: a remittance reaches `payout_submitted` with the money still sitting in the escrow vault. The
missing piece is not the on chain call, it is the thing that decides. Until it exists, the sender's
guarantee is the refund, which needs nobody's cooperation.

Two more things that are off by choice rather than unfinished:

- The fiat payout runs against a mock adapter by default. The real adapter exists and is wired, and it
  needs provider credentials that are not in this repo.
- Nothing points at mainnet. The cluster is a constant in the smoke script, not a variable.

## The money path

The escrow is an Anchor program deployed on devnet:

```
DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x
```

Six instructions: `deposit`, `release`, `refund`, `close`, `register_escrow`, `deregister_escrow`.

**That program's source is not in this repo.** There is no `.rs`, no `Anchor.toml` and no `Cargo.toml`
here, and `contracts/` holds TypeScript contract tests, not Rust. The Anchor program lives in
[`ferrosasfp/solana-programs`](https://github.com/ferrosasfp/solana-programs), at
`programs/escrow/src/lib.rs`, and it is public. What this repo holds is the consumer side: the program's
IDL, vendored and pinned by canonical hash, described below.

Per remittance state lives in a PDA derived from `[b"escrow", sender, remittance_id]`, where
`remittance_id` is a 16 byte array. The funds live in the associated token account of that PDA for the
mint, so the vault address is a function of the escrow account and cannot be pointed elsewhere.

The cycle:

1. The app asks the server for the deposit parameters. If the release authority pubkey is not
   configured, the server answers 503 instead of continuing.
2. The sender's wallet signs `deposit`, which takes `beneficiary`, `authority`, `amount` and `deadline`
   as arguments. The principal leaves the sender's account and lands in the escrow vault. The operator
   never touches it.
3. The facilitator co-signs as fee payer and broadcasts, so the user needs no SOL. This is the step that
   is currently cut from the browser, for the reason described above.
4. Once the payout in the destination country is confirmed, the release authority signs `release`.
   `sender`, `beneficiary` and `mint` are `has_one` constrained against the escrow account, so the
   destination is the one fixed at deposit time and the authority cannot redirect the funds. Nothing
   automatic decides to take this step yet.
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
[`wasiai-facilitator`](https://github.com/ferrosasfp/wasiai-facilitator).

### Devnet smoke

`npm run smoke:solana` drives the full on chain cycle against already deployed services: healthchecks,
proof of possession, `/api/payout/prepare`, the `deposit` instruction signed by the sender, the gasless
broadcast through the facilitator, the escrow verification (status, vault balance and beneficiary), the
release against the facilitator, and re-reading the chain until the escrow is released and the vault is
empty. It is deliberately uncomfortable to run:

- It aborts before any call unless `SMOKE_ALLOW_REAL=true`. It does not run in CI.
- Service URLs, keys, identifiers, amount, mint and the facilitator pubkey are all environment
  variables: thirteen required ones, listed and validated one by one in
  `scripts/smoke-solana-e2e.ts:55-69`. If one is missing the script aborts and prints the variable's
  name, never its value.
- Two inputs are not variables, and that is the point of each. The cluster is the constant
  `CLUSTER = "devnet"` (`:46`): there is no environment variable that can aim this script at mainnet.
  The RPC endpoint does have a default, `clusterApiUrl("devnet")` (`:108`), which is the public devnet
  endpoint.
- **What the smoke does not prove, printed on every run.** The attestation that authorizes the release
  is computed by the script itself from the shared secret. By design that attestation certifies that
  KYC was approved and that the fiat order completed, so a script that signs it for itself proves the on
  chain leg and proves nothing about the fiat leg. And it is standing in for the absent decider
  described above: the smoke shows that the on chain pieces work when somebody calls them in order, not
  that the system calls them on its own.
- The payout provenance is printed as part of the result. Only one value means a real fiat payout, and
  if it shows up the script aborts, because the authorized scope is devnet with no real money.

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

**750 cases across 59 files**, all green. They break down as:

- Domain and application with test doubles, no network, wallet or browser. That is where the money path
  invariants live: nothing is confirmed without a verified identity and a live quote, an expired quote
  fails closed, the state machine admits no jumps.
- API routes, infrastructure adapters and components with Testing Library.
- Contract tests against pinned copies of two external services' output, the quote and the KYC
  (`contracts/`). If a provider changes the shape of its response and someone re vendors the copy, the
  consumer's test goes red instead of breaking in production. The third one, the payout, was retired:
  its consumer validator lived inside a method that pointed at a deleted route, so its green proved
  nothing. The reason and the follow up are in `contracts/CONTRACT-VERSIONS.md`.
- The escrow IDL pinned by canonical hash (`contracts/idl/escrow-idl.hash.test.ts`), described above.
- A guard against the return of the EVM path this repo used to have
  (`src/composition/no-evm-surface.test.ts`). It walks the tree on every run and fails on a closed,
  enumerated list of imports, switches and hex address patterns, and it asserts that the deleted routes
  are absent as directories rather than as handlers returning 404. Its scope is exactly that: it closes
  the doors the EVM path left by. It is not a universal ban on every Ethereum library in existence, and
  covering a new name means adding it to the list, with its reason.

```bash
npm test          # 750 tests across 59 files
npm run qa        # lint + both typechecks + tests
```

### CI

`.github/workflows/ci.yml` runs `npm run lint`, `npm run typecheck`, `npm run typecheck:scripts`,
`npm test` and `npm run build` on Node 22, on every push to `main` and on every pull request. The smoke
script is deliberately not part of it: it is opt in and it moves tokens on devnet.

## Architecture

Layer by layer detail and the full list of API routes: [`docs/architecture.md`](docs/architecture.md).

Clean Architecture, with the dependency rule pointing inward.

```
presentation   ->  application (use cases + ports)  ->  domain
infrastructure ->  implements the ports, injected at the composition root
```

- **`src/domain/`** is pure, with no dependencies. `Money` in minor units, zero floats. `Remittance`
  with the state machine (`created`, `kyc_pending`, `kyc_passed`, `quoted`, `confirmed`, `principal_in`,
  `payout_submitted`, `settled`, `refunded`, plus the failure states) and the business invariants.
- **`src/application/`** holds the use cases and the ports they need. They depend on interfaces only,
  never on a concrete adapter. This is where the agent boundary lives: a use case asks a port for a
  quote, and whether that resolves to a mock, a known URL or an agent picked by capability is a wiring
  decision it never sees.
- **`src/infrastructure/`** holds the adapters: wallet, escrow, settlement, attestations, Postgres
  ledger, identity, rate limiting, agent clients.
- **`src/composition/container.ts`** is the only place that knows concrete classes. That is where the
  guards live that make an incoherent configuration break at startup rather than mid transfer.
- **`app/`** is the Next shell and the server only API routes, the ones that talk to external services
  with server side keys.

The domain knowing nothing about React or `@solana/web3.js` is what makes it possible to test the money
path with doubles, in milliseconds, without a browser. It is also what makes the agents replaceable:
the thing being swapped is an adapter behind a port, not a branch in the business logic.

## Configuration

`.env.example` documents the variables read by `src/` and `app/`, plus the sixteen the devnet smoke
script reads, in a section of its own at the end. It does not cover what the hosting platform injects by
itself. The design rule is that **every default is the safe one**: with an empty file the app comes up
in demo mode and moves no funds.

| Variable | Default | Effect |
|---|---|---|
| `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` | off | Enables the escrow deposit and gas sponsorship |
| `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` | `fallback` | `a2a` uses the real agents point to point, `a2a-gateway` resolves them by capability |

The composition root guards are fail loud. Turning settlement on without a mint or without the
facilitator pubkey stops the app from starting at all. The point is that a configuration mistake shows
up at deploy time and not while money is in flight.

There is one more guard, and its scope is deliberate: the composition root refuses to start if it finds
environment variables belonging to a settlement path this code does not have. That configuration lives
outside the code, in the hosting provider's dashboard, which is the only place where it can be left
orphaned without anyone noticing.

Database migrations live in `supabase/migrations/`.

## Stack

Next 16 with the App Router, React 19, TypeScript in strict mode, Tailwind, Vitest. `@coral-xyz/anchor`,
`@solana/web3.js` and `@solana/wallet-adapter-*` for Solana, `tweetnacl` and `bs58` for the ed25519
proof of possession.

## License

MIT. See [LICENSE](LICENSE).
