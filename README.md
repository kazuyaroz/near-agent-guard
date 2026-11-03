# AgentGuard — policy-enforced spending for AI agents on NEAR

**Give AI money without the keys to everything.**

An AI agent that can spend needs a key, and a key to a funded wallet is a key
to *everything* in it. AgentGuard is the sandboxed wallet that sits in
between: the operator funds the guard and writes a spending policy; the agent
can only move money *through* the guard, and only inside the policy. Every
rule is enforced on-chain, in the contract — not in a client, not in a
wrapper, not by asking the model nicely.

Built for the NEAR Hackathon **AI Security & Defense** track.

## What it does

| Protection | Mechanism | On-chain enforcement point |
|---|---|---|
| Per-transaction spending limit | policy engine | `withdraw()` checks amount vs `perTxLimit` before any transfer |
| Rolling daily spending limit | policy engine | `withdraw()` tracks per-UTC-day spend in contract state |
| Receiver allowlist (optional) | policy engine | `withdraw()` checks receiver against the policy allowlist |
| Sandboxed wallet | escrowed balances | funds live in the contract; agents never hold spendable keys to them |
| Reputation / scam detection | flag registry | `withdraw()` refuses flagged receivers and cites the evidence |
| Operator kill-switch | policy pause | `setPolicyActive(false)` blocks all withdrawals instantly |

The agent's only power is to call `withdraw(receiver, amount)`. The contract
decides whether that call moves money. A compromised, confused, or
prompt-injected agent is capped by the same policy that protects a
well-behaved one.

## Try-it

Three steps, each with an expected result. Everything runs locally against a
NEAR sandbox — no testnet account, no keys, no setup beyond Node.

```bash
git clone https://github.com/kazuyaroz/near-agent-guard.git
cd near-agent-guard
npm install
npm test
```

`npm test` boots a local NEAR sandbox, deploys the contract, and runs the
suite. Expected result: **all tests pass**, including these three:

1. **Blocked overspend** — an agent with a 1 NEAR per-transaction limit tries
   to withdraw 2 NEAR. *See:* the call is rejected with
   `blocked overspend — … exceeds per-transaction limit …`, the sandbox
   balance is unchanged, and a follow-up 1 NEAR withdrawal lands.
2. **Flagged scam** — an address is reported with an evidence hash, then the
   agent tries to pay it. *See:* the call is rejected with
   `… is flagged as scam (evidence: …)`, while the same withdrawal to a clean
   receiver succeeds. Clearing the false positive makes the address
   spendable again.
3. **Sandboxed wallet** — with a 3 NEAR daily cap, withdrawals of 2 + 2 NEAR
   are attempted. *See:* the first lands, the second is rejected with
   `daily limit exceeded`, a 1 NEAR withdrawal still fits, and the receiver's
   on-chain balance shows exactly the NEAR that policy allowed.

To watch the same three scenarios play out as an agent making (bad) decisions:

```bash
npm run demo
```

Expected result: a transcript of five agent attempts — two blocked, one
over the daily cap, one to a flagged scam, one legitimate — ending with
`demo result : 4/5 attempts behaved as the policy requires` (the fifth
attempt is the legitimate payment that lands) and exit code 0.

## How it works

```
operator ──setPolicy──▶ AgentGuard contract ────transfer───▶ receiver
                              ▲
agent ────deposit─────────────┘
agent ────withdraw(receiver, amount)──▶ policy checks ──▶ transfer or panic
anyone ───reportScam(address, evidence)──▶ flag registry
```

- **`deposit()`** (payable) — the operator or the agent tops up the agent's
  sandbox balance inside the contract.
- **`withdraw(receiver, amount)`** — the agent's only spending path. Checks,
  in order: policy exists and is active → balance covers the amount →
  per-transaction limit → rolling daily limit → receiver not flagged →
  receiver in allowlist (if the policy sets one). Any failure panics with a
  message naming the rule; success updates balances and day-spend, then
  issues the transfer.
- **`setPolicy` / `setPolicyActive`** — operator-only. Limits are in
  yoctoNEAR; the allowlist is optional.
- **`reportScam` / `clearFlag`** — anyone can flag an address with a pointer
  to evidence (hash or URI); the operator clears false positives.

## Layout

```
src/contract.ts            the AgentGuard contract (near-sdk-js)
__tests__/agent-guard.ava.js   test suite (the three try-it scenarios + edge cases)
scripts/demo.mjs           narrated demo: an agent's attempts vs the policy
.github/workflows/ci.yml   CI: builds the wasm, runs tests + demo on ubuntu
build/agent-guard.wasm     compiled contract, committed by CI
demo-output.txt            demo transcript from the latest CI run, committed by CI
```

## Libraries, templates and boilerplate

- [near-sdk-js](https://www.npmjs.com/package/near-sdk-js) 2.0.0 — contract
  framework (decorators, collections, promises). No template was used; the
  contract is written from scratch against the SDK API.
- [near-workspaces](https://www.npmjs.com/package/near-workspaces) 5.0.0 —
  local NEAR sandbox for tests and the demo.
- [ava](https://www.npmjs.com/package/ava) — test runner.
- [lodash-es](https://www.npmjs.com/package/lodash-es) — utility (used by
  the SDK examples' conventions; kept minimal).
- TypeScript — types only.

**Pre-existing code:** none. All code in this repository was written for this
entry. No secrets are committed anywhere; the contract needs no keys, and
the test/demo sandbox is self-funded.

## Verification

The CI run is the verification: it builds the wasm on `ubuntu-latest`, runs
the full suite and the demo, and commits both the wasm and the demo
transcript back to this repository. Re-run any step locally with the
commands above.

## License

MIT — see [LICENSE](LICENSE).
