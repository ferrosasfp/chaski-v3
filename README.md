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

## Try it on devnet

The deployed app is `https://chaski-v2.vercel.app`. Everything below happens on Solana devnet, with
Circle's devnet USDC. No real money moves, and nobody is asked for a real identity document.

**On a phone, open the app from inside Phantom's own browser.** A normal mobile browser has no wallet
in it, and that is the first wall a tester hits. The screen says so and offers the way through: a
button that reopens the same URL inside Phantom, built as
`https://phantom.app/ul/browse/<url>?ref=<origin>` (`src/presentation/wallet-availability.ts:26-28`,
screen copy at `src/presentation/flow.tsx:1311-1329`). On a computer the path is the other one:
install the Phantom or Solflare extension and reload. Those two are the only wallets the app wires
(`src/presentation/solana/solana-providers.tsx:228`).

**Do the whole run in that same browser.** The remittance in progress is kept in the browser's
`localStorage` (`src/infrastructure/persistence.ts:86`), so starting in one browser and jumping to
another loses it.

### What to get before you start

- **Circle's devnet USDC**, mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Ask for it at
  <https://faucet.circle.com>, choosing the network `Solana Devnet` and pasting the wallet address.
  Both the page and that network option answered on 2026-08-16. You need **at least 5 USDC**: under
  that the app does not quote, because `MIN_SEND_USD = 5` (`src/domain/remittance.ts:209`).
  ⚠️ It is not the `8yRX3fZ2…` mint of the three signatures in the table below. That one is a test
  token and the app is not configured against it.
- **About 0.009 devnet SOL** in the same wallet. Ask for it at <https://faucet.solana.com> (it
  answered on 2026-08-16), or run `solana airdrop 1 <your pubkey> --url devnet` if you have the CLI.

**Why SOL is needed when the fee is sponsored.** A Solana transaction pays two different things and
only one of them is sponsored. The network fee is paid by the facilitator, which signs as fee payer.
The rent of the accounts the deposit creates is paid by whoever sends, because the program names the
sender as their payer. Measured on each of the three deposits quoted below: the fee payer paid 11,200
lamports of fee and the sender's wallet paid 4,002,000 lamports of rent. The app checks this before
asking for any signature and stops with "Te falta SOL en la wallet" under 0.0089 SOL
(`SENDER_MIN_LAMPORTS_FOR_DEPOSIT`, `src/application/solana-escrow-rent.ts:187`, with its derivation
in the same file).

### The run

1. Connect the wallet.
2. Amount of 5 USDC or more, the recipient's name, and a destination account of 20 digits, the length
   of a Peruvian CCI. The form checks the length, not that the account exists
   (`src/domain/remittance.ts:31` and `:44`), so an invented number gets you through.
3. Identity. **In this deployment it is simulated**: the screen states that it verifies nothing and
   asks for no data. That screen only exists when the operator declares the mock
   (`src/infrastructure/didit/mock-surface-enabled.ts:26`), and the deployed app served it with a 200
   on 2026-08-16.
4. Confirm. **The wallet asks to sign twice, and that is deliberate**: first the deposit transaction,
   then a readable message naming this remittance, so that a captured transaction signature is not
   enough for somebody else to get a deposit sponsored (`src/infrastructure/solana-wallet.ts:781-799`).
5. The deposit lands on chain and the screen links the transaction to the explorer
   (`src/presentation/flow.tsx:3582`). The USDC are in the escrow vault, and the operator cannot
   redirect them.

### What will not happen, said before you start and not after

- **Nobody pays out soles.** The fiat leg runs against a mock agent by default. There is no bank
  transfer at the end of this.
- **The USDC stay in the escrow vault.** Taking them out to the beneficiary is the `release`, and
  today the trigger is a person. The code says so where the payout provider's webhook lands, in
  Spanish: *"the on chain verification of the release is done by a person; this is the request that
  they do it"* (`app/api/webhooks/transfi/route.ts:94-97`). The deposit is non custodial and
  automatic; the fiat delivery is confirmed by the operator.
- **You take your own money back.** Two hours after the deposit the custody window closes
  (`CUSTODY_WINDOW_SECS`, `src/infrastructure/solana-wallet.ts:100`) and the app lets you sign the
  refund, which needs nobody's cooperation. Before that deadline the program rejects it
  (`DeadlineNotReached` 6003), so the two hours are a wait, not a failure. It has been done on chain:
  the `Refund` in the section below, with the sender as the only signer.

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
  `app/api/a2a/quote/route.ts:91-96` and `app/api/payout/prepare/route.ts:392-396` send a `capability`,
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

**The deposit is the strongest piece, and it lands from a browser.** The instruction enters the
chain, the sender's wallet is the only signer of the transfer, and a sponsoring fee payer covers the
network fee. It does not cover everything, and the difference is not a detail: the rent of the
accounts the deposit creates comes out of the sender's wallet, so "the user needs no SOL" would be
false and is not said here. The section "Try it on devnet" has the numbers.

Two runs of 2026-08-16, from Phantom's in-app browser on an Android phone, both landed:

| Signature | Time (UTC) | What moved |
|---|---|---|
| [`59XvDKhAJD…`](https://explorer.solana.com/tx/59XvDKhAJD5tbdzYeRQWWhNsi5Ac5ppSwu8xM3rHwVCRUVhvZPBcPnUtucU3F5o53VjaM8H9KAWG3zWSq5Waii8K?cluster=devnet) | 2026-08-16T06:17:19Z | 7 USDC out of the sender, into the vault `GppYQSnQ…` |
| [`2MUbUgJWSh…`](https://explorer.solana.com/tx/2MUbUgJWSh9kVPz5JKAEC7PYw8gNAMjLsqR1fJ3iZ18CtYZCdTEULxNRojmdxinTrCWcBkjMi9HNiTBRGpoPYYo5?cluster=devnet) | 2026-08-16T07:40:14Z | 6 USDC into the vault `HcsP8afr…`, the sender from 56 to 50 |

Both come with `err: null`, a fee of 11,200 lamports paid by the sponsor `4wPhH4dC…`, the sender
`4AvAjtPg…` as the other signer, and the four instruction shape of the app's deposit path. Read back
from the public devnet RPC, no permission needed. What the chain proves is the transaction; that the
client was a phone browser is the report of whoever ran it, the same kind of evidence as the CSP
walkthrough further down.

**What is not proven is the full cycle, and the reason is not the deposit.** The 13 USDC of those two
runs are still in custody: the two vaults held 7 and 6 USDC on 2026-08-16, and a
`getTokenAccountBalance` on each says whether that is still true when you read this. Nothing failed
there. The run ends where the system ends today, because the release is triggered by a person.

**The way out was exercised too, and by the sender alone.** The escrow of 2026-08-15 passed its
deadline and whoever deposited took the money back without anyone's cooperation:
[`3dYjRE7u8b…`](https://explorer.solana.com/tx/3dYjRE7u8bzBKZD9PKci3oJ5X98J8jku65kK9T8GwEZ4hLZ2h9rwWt49ibqgEngSrAiNiA3F5gTN13cZroF2ywDj?cluster=devnet),
2026-08-16T06:17:49Z, an instruction the logs name `Refund`, with the vault `7piawXnH…` going from
13.5 USDC to zero and the sender's wallet from 42.5 to 56. There is one signer, the sender, and the
80,000 lamports of fee came out of their own wallet. Nobody was asked.

**Chaski emits ComputeBudget instructions on deposit (WKH-321), and that path has now landed on
chain.** The `deposit` transaction carries two instructions before the escrow calls,
`setComputeUnitLimit` and `setComputeUnitPrice`, from the resolvers in `src/infrastructure/chain.ts:93`
and `:124`, added to the transaction at `src/infrastructure/solana-wallet.ts:675-678`. This reduces
the probability that a wallet such as Phantom adds conflicting priority fees that exceed the
facilitator's allowance (measured on devnet at 50,000 units).

**The transaction that proves it** is
[`38PyBoVizf…`](https://explorer.solana.com/tx/38PyBoVizfhVLxm217QzeWP3JPYqGxJUC6vzuxh9xxv9FJdMquQ6BUFyUsma1ePiWK59qCQweFNNony1MJ7UReLV?cluster=devnet),
of 2026-08-15T08:36:12Z, with `err: null`, a fee of 11,200 lamports and 54,600 compute units
consumed. It carries four instructions, in this order: two of
`ComputeBudget111111111111111111111111111111`, then two of the escrow program
`DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`, which its own logs name `Deposit` and
`RegisterEscrow`. And it moved money: the escrow vault `7piawXnH…` did not exist before it and ended
holding 13.5 USDC, while the sender's token account went from 48 to 34.5, in Circle's devnet USDC
(mint `4zMMC9…`), which is the mint the app is configured against. Anyone can read it back from the
public devnet RPC with `getTransaction`, without asking us for anything.

⚠️ **The chain does not record which client built a transaction.** A signature carries instructions
and signers, never the program that assembled them. For the two runs above, the phone browser is the
report of whoever ran them. For this one there is no such report, and what can be said is narrower:
the four instruction shape `[limit, price, deposit, register]` is built only by the app's deposit
path (`src/infrastructure/solana-wallet.ts:769-771`), while the smoke script builds three, with no
`register_escrow` (`scripts/smoke-solana-e2e.ts:455`), and its signer is not the sender those smoke
runs were measured on (`src/application/solana-escrow-rent.ts:14`). So it is not a run of the smoke
as this tree has it, and further than that the chain does not go.

⚠️ The caveat about wallets stays as it was: if a wallet attempts to prepend its own ComputeBudget and
rejects the duplicate after already signing (as the code assumes), the deposit fails with clear
evidence. That assumption is not contractual, it is behavior observed on third-party wallets.

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

What used to stay open on this leg was the browser round trip and one piece of configuration, and
neither is open now. The two deposits of 2026-08-16 were broadcast with the facilitator signing as fee
payer, which is what its sponsorship endpoint does. An unset `SOLANA_SPONSOR_NETWORK_ID` refuses every
sponsorship request, and these two were not refused, so that variable is set on the deployed
facilitator and the `popSignature` path works against a real wallet. What was written here, that the
path was dead in either direction because an old client sends `popProof` and gets a 400 while a new one
signs for a server that ignores it, described the window between the two deploys and closed with them.

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
3. The facilitator co-signs as fee payer and broadcasts, so the sender pays no network fee. The rent
   of the escrow PDA and its token vault, 4,002,000 lamports (about 0.004 SOL per remittance, measured
   on devnet), does come out of the sender's wallet, which is why the app looks at their SOL balance
   first. This step has landed from a browser: the two runs of 2026-08-16 above.
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

**160 test files**, all green. That number is not a claim anyone has to trust:
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

There is a second workflow, `.github/workflows/reconcile-orphans.yml`, and it is scheduled rather than
triggered by a push. Once an hour (`23 * * * *`) it is meant to call the admin reconciliation route in
production with the secret in a header, and to go red if the transport fails or if the response reports
rows that a person has to look at. It prints only the aggregate counters, never the correlation ids: the
logs of a public repository are public.

⛔ Status as of 2026-08-19, measured and not assumed: **that workflow has never run.** GitHub lists only
`ci.yml` under `gh api repos/ferrosasfp/chaski-v3/actions/workflows`,
`gh run list --workflow=reconcile-orphans.yml` answers HTTP 404, and the repository has zero Actions
secrets (`{"total_count":0}`). Merging the file registers the schedule, which is the easy half. The
other half is not: with no secret loaded, the job fails on its first step without calling the route, so
every hourly run is red and nothing gets reconciled, until someone runs
`gh secret set RECONCILE_ADMIN_SECRET`. The measured status table is at the top of
[`docs/runbook-reconcile-orphans.md`](docs/runbook-reconcile-orphans.md). Read it before you conclude
that an hourly check is watching the ledger, because right now none is.

What it does not do, once it does run, is stand guard. If GitHub delays or skips a scheduled tick there
is no run, and therefore nothing turns red. That gap is written down rather than implied, in the header
of the workflow and in `docs/runbook-reconcile-orphans.md`, which also says what to do about each red.

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
