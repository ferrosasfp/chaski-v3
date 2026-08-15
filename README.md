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

- **There is no point to point path any more.** This bullet said it was the active one, calling a known
  base URL. WKH-332 deleted that rail: by default the app wires the demo gateways and calls no agent.
- **By capability is the only transport, and this flag does not switch it off.**
  `app/api/a2a/quote/route.ts:91-96` and `app/api/payout/prepare/route.ts:391-395` send a `capability`,
  plus a reputation floor on each leg, and let the gateway choose. `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`
  picks ONE client adapter, the quote; the payout STATUS no longer hangs off it (WKH-337 reads it from the ledger);
  these routes never read it. Drop the gateway URL or key and both answer 501 with no fetch.
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
it. Whether it lands from a browser is **not yet verified in the custody window with a real wallet
extension**: the protocol blocker described in the next paragraph was removed, and the implementation
is complete. That end-to-end browser round trip is W7 of SDD 038 and it is still pending, so the
honest statement is "unverified by the full-cycle test", not "it works" and not "it does not work".

**Chaski now emits ComputeBudget instructions on deposit (WKH-321).** The `deposit` transaction
carries two instructions before the escrow call: `setComputeUnitLimit` and `setComputeUnitPrice`,
computed by resolvers in `src/infrastructure/solana-wallet.ts:82-95`. This reduces the probability
that a wallet such as Phantom adds conflicting priority fees that exceed the facilitator's allowance
(measured on devnet at 50,000 units): if a wallet attempts to prepend its own ComputeBudget and
Phantom rejects the duplicate after already signing (as the code assumes), the deposit fails with
clear evidence. That assumption is not contractual: the behavior is observed on third-party wallets,
not guaranteed. The deposit has never landed on chain with these instructions yet; the path they
unblock is not exercised in production.

**The blocker on the confirmation leg was a shared secret, and it is gone.** The first half was fixed
earlier: the client signs a proof of possession before asking the server to create the payout order, so
the flow no longer dies before the wallet is ever prompted. The second half was the broadcast of the
deposit, and it was blocked by design rather than by a missing line: the facilitator authorized
sponsorship with an HMAC over a secret shared between servers, and a browser cannot hold a server to
server secret without leaking it. Whoever held that secret could also mint a valid proof for any
wallet, which is the worse half of the same problem.

SDD 037 replaced that HMAC with a signature from the wallet itself. The person signs a readable message
that names the remittance, the amount, the token and the network, plus the signature of the very
transaction being sponsored; the facilitator rebuilds that message line by line from the transaction
and its own configuration, and verifies it with ed25519. There is no shared secret left: the key that
validates is the sender's own public key, read out of the deposit instruction rather than out of the
request body. Concretely, the facilitator's schema now requires `popSignature`
([`solana-sponsor.ts`](https://github.com/ferrosasfp/wasiai-facilitator/blob/main/src/routes/solana-sponsor.ts)),
a request carrying the old `popProof` gets a 400 with nothing signed, the client sends `popSignature`
in `settle()` (`src/application/use-cases/confirm-and-send.ts`), and the forwarding route
(`app/api/settle/solana-sponsor/route.ts`) rejects a missing or malformed one with a 400 before
spending the forward. That replacement is this branch, not open work.

**Two security gaps were closed in the confirmation flow (2026-08-04).** The KYC flow could open a
session without a binding to the sender's wallet address; `/api/payout/validate` would then authorize
any address presented by an unauthenticated caller. This was reproduced in production: a public POST
with an empty body created a session with no `vendor_data`, the mock approved it, and three unrelated
addresses each passed validation. The endpoint now fails closed: `vendor_data` must match the address
or the authorization is refused (WKH-180, reviewed in `app/api/payout/validate/route.test.ts:156-180`).
The second fix: the confirmation endpoint now verifies that the wallet address exists before querying
the payout authority. If the KYC session has no address, `confirm-and-send` returns `wallet_address_unavailable`
instead of letting an empty address travel to the authority, which would convert a trivial local state
error into a false 502 ("identity provider failed"). The guard of ownership remains: the authority
still fail-closes and still rejects exactly what it did before.

What stays open on this leg is the browser round trip itself (W7 above), and one piece of configuration:
the facilitator needs `SOLANA_SPONSOR_NETWORK_ID` set, and while it is unset every sponsorship request
is refused. The order in which the two repos deploy does not matter, because the path is dead today in
either direction: an old client sends `popProof` and gets a 400 without anything being signed, and a new
client sends a signature to a server that ignores it and dies on the same 400.

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
3. The facilitator co-signs as fee payer and broadcasts, so the user's wallet does not need SOL for
   network fees. The account rent for the escrow PDA and its token vault (approximately 0.004 SOL per
   remittance, measured on devnet) is paid from the deposit. This is the step that is currently cut
   from the browser, for the reason described above.
4. Once the payout in the destination country is confirmed, the release authority signs `release`.
   `sender`, `beneficiary` and `mint` are `has_one` constrained against the escrow account, so the
   destination is the one fixed at deposit time and the authority cannot redirect the funds. Nothing
   automatic decides to take this step yet.
5. If something fails, the sender signs `refund` and the principal goes back to whoever deposited it,
   with no other signature required. The program rejects it unless the escrow is in the `Deposited`
   state and the deadline has passed (`EscrowNotDeposited` 6002, `DeadlineNotReached` 6003).

### The IDL is pinned by hash

The program IDL is vendored at `src/infrastructure/solana/escrow-idl.ts` and its canonical SHA-256 is
fixed in `contracts/idl/escrow-idl.hash.test.ts`, which runs on every `npm test`. **"Canonical" here
just means: sort every key first, then hash.** That way two copies that differ only in the order their
keys were written still come out equal, while a real change to the contract does not. The same test also
pins the program id and the positional account order of `deposit`, `refund` and `register_escrow`. If
someone hand edits the vendored IDL, or the deployed program reorders its accounts, the suite goes red
before a transaction gets rejected in production. Re pinning is an explicit decision with its entry in
`contracts/CONTRACT-VERSIONS.md`, never a silent drift. The pinned value matches the one held by
[`wasiai-facilitator`](https://github.com/ferrosasfp/wasiai-facilitator). Measured 2026-08-11 across
four independent artifacts, this tree, the chain, the facilitator and `solana-programs`, all four
come out to the same hash, `cc2761266dcf8335a17562129de040805f37f69cfe654f5be472045ba7bfcd51`, over the
same 16,020 bytes.

### Security headers, and what they still do not protect

The app serves `Content-Security-Policy` in **blocking** mode (`next.config.mjs`, policy built in
`src/infrastructure/security/csp-policy.mjs`). A wrong CSP here does not show up as a broken page: it
shows up **at signing time**, because the wallet adapter tree, the RPC and its WebSocket all open
connections an incomplete policy blocks, and the person finds out with the transaction already built.

So `connect-src` is **derived** from `NEXT_PUBLIC_SOLANA_RPC_URL`, the same variable the browser builds
its `Connection` from, and it yields **two** origins from one URL: the `https://` for the JSON-RPC calls
and the `wss://` for subscriptions. Omitting the second does not break sending, it breaks
*confirmation*, which is the more confusing failure. `csp-policy.test.ts` greps the policy module's own
text to forbid any hardcoded Solana hostname, so the two lists cannot drift apart.

**How it was validated, because a passing test cannot answer this one.** The policy ran a first round in
`Report-Only`, blocking nothing while the browser reported what it *would* have blocked, and the person
who signs walked the whole app three times on 2026-08-11 (5, 12 and 11 dollars, deposit confirmed on
chain each time). Result: **zero violations attributable to this app**, including zero on `connect-src`.

Five violations did occur and **none were authorized**. All five come from the toolbar Vercel injects,
which loads its own typeface from Google and needs `eval`. That they are not ours was measured, not
assumed: `DM Sans`, `gstatic` and `eval(` appear nowhere in the repo, the served HTML or the client JS.
Authorizing them would cost `'unsafe-eval'` plus three domains for every visitor, to accommodate a tool
only a logged-in Vercel user sees. A test (`T-CSP-10`) forbids adding those four permissions, because
"add the domain until it stops complaining" is the path of least resistance.

⚠️ **What this does not protect.** `script-src` still carries `'unsafe-inline'`, because Next injects
inline scripts to hydrate. With that permission present, `script-src` does **not** protect against
injected-HTML XSS: it is the most important directive in the policy and today it is the weakest. Fixing
it properly needs a per-request nonce, which needs the headers to move into middleware. It is declared in
the code, not hidden, and it is queued work rather than a detail.

### The RPC provider, and why its credential is public

Since 2026-08-11 the app talks to a dedicated provider instead of the public devnet endpoint, which was
returning HTTP 429 in bursts during a real walkthrough. The credential is **visible in the page by
design**: `NEXT_PUBLIC_*` variables are inlined into the bundle at build time, so every visitor's browser
must be able to use it and there is no way to hide it on a free tier. The control that does exist is a
**domain allowlist** on the provider side, verified 2026-08-11 in both channels: the JSON-RPC calls and
the WebSocket handshake each accept this app's origin and reject a foreign origin and an origin-less
request. Its honest limit: it stops another *website* from using the key, not a script that sets the
header by hand.

⚠️ One consequence worth knowing before you reach for tooling: `getProgramAccounts` is **not available on
that provider's free tier**, and the public endpoint rate-limits it. The app never calls it (its five
methods are `getAccountInfo`, `getLatestBlockhash`, `getBalance`, `sendRawTransaction` and
`confirmTransaction`, all verified working), but any script that enumerates program accounts has no
endpoint to run against today.

### Devnet smoke

`npm run smoke:solana` drives the full on chain cycle against already deployed services: healthchecks,
proof of possession, `/api/payout/prepare`, the `deposit` instruction signed by the sender, the
broadcast through the facilitator (network fees paid by facilitator, account rent paid by sender), the
escrow verification (status, vault balance and beneficiary), the release against the facilitator, and
re-reading the chain until the escrow is released and the vault is empty. It is deliberately
uncomfortable to run:

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

**129 test files**, all green. That number is not a claim anyone has to trust:
`src/composition/readme-test-count.test.ts` counts the tree on every run and turns the suite red if this
line drifts from it. For the number of individual cases, run `npm test`, which prints it. They break
down as:

- Domain and application with test doubles, no network, wallet or browser. That is where the money path
  invariants live: nothing is confirmed without a verified identity and a live quote, an expired quote
  fails closed, the state machine admits no jumps.
- API routes, infrastructure adapters and components with Testing Library.
- Contract tests against pinned copies of what external services return (`contracts/`): the quote, the
  KYC, and the three sponsor limits of the Solana facilitator, pinned on 2026-08-03 by WKH-321. If a
  provider changes the shape of its response and someone re vendors the copy, the
  consumer's test goes red instead of breaking in production. A fourth one, the payout, was retired:
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
npm test          # vitest run, the whole suite. It prints files and cases
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
| `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` | off | Three effects, not one. It enables the escrow deposit and the gas sponsorship, and since WKH-336 it also decides what the preview card claims about the delivery step: the "Send the money" row derives its transport from this flag, not from `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER`. So with the adapter on `fallback` and this one on `"true"` the two rows say different things, which is correct: the payout does go through the gateway. When it is off the delivery does not run and is not simulated either, it fails closed with `settlement_unavailable` |
| `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` | `fallback` | Two legal values, and nothing else: `fallback` (demo gateways: a simulated quote; the payout STATUS is no longer decided by this flag, WKH-337 reads it from the ledger, and it is not the flag that keeps funds still either, `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` is) and `a2a-gateway` (asks the gateway for a capability and it resolves the agent). Any other value throws at startup, `a2a` included: that was the point to point rail and WKH-332 deleted it, so an environment still set to it fails loud instead of quietly wiring the simulators |

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
