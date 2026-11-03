import { Worker } from "near-workspaces";
import test from "ava";

/** yoctoNEAR helper: NEAR(1) -> "1000000000000000000000000" */
const NEAR = (n) => (BigInt(n) * 10n ** 24n).toString();

test.beforeEach(async (t) => {
  // Boot a local NEAR sandbox (near-workspaces downloads nearcore on first run).
  const worker = await Worker.init();

  const root = worker.rootAccount;

  // Deploy the AgentGuard contract.
  const guard = await root.devDeploy("./build/agent-guard.wasm");

  // The operator who owns the guard and writes policies.
  const ali = await root.createSubAccount("ali");
  // The AI agent that spends from its sandbox.
  const agent = await root.createSubAccount("agent");
  // A legitimate merchant.
  const merchant = await root.createSubAccount("merchant");
  // A known scam address.
  const scammer = await root.createSubAccount("scammer");

  await root.call(guard, "initialize", { owner: ali.accountId });

  t.context.worker = worker;
  t.context.accounts = { root, guard, ali, agent, merchant, scammer };
});

test.afterEach.always(async (t) => {
  await t.context.worker.tearDown().catch((error) => {
    console.log("Failed to tear down the worker:", error);
  });
});

// ----------------------------------------------------------------------
// TRY-IT 1: blocked overspend
// ----------------------------------------------------------------------

test("TRY-IT 1: an over-limit withdrawal is blocked, an in-policy one lands", async (t) => {
  const { guard, ali, agent, merchant } = t.context.accounts;

  // Operator funds the agent's sandbox with 10 NEAR and writes a policy:
  // max 1 NEAR per transaction, 5 NEAR per day, any receiver allowed.
  await agent.call(guard, "deposit", {}, { attachedDeposit: NEAR(10) });
  await ali.call(guard, "setPolicy", {
    agent: agent.accountId,
    perTxLimit: NEAR(1),
    dailyLimit: NEAR(5),
    allowlist: [],
  });

  // The agent (or whatever prompts it) tries to move 2 NEAR at once.
  await t.throwsAsync(
    () => agent.call(guard, "withdraw", { receiver: merchant.accountId, amount: NEAR(2) }),
    { message: /blocked overspend/ }
  );

  // Sandbox balance is untouched by the blocked attempt.
  t.is((await guard.view("getBalance", { agent: agent.accountId })).toString(), NEAR(10));

  // An in-policy withdrawal of exactly 1 NEAR goes through.
  await agent.call(guard, "withdraw", { receiver: merchant.accountId, amount: NEAR(1) });

  t.is((await guard.view("getBalance", { agent: agent.accountId })).toString(), NEAR(9));
  t.is((await guard.view("getSpentToday", { agent: agent.accountId })).toString(), NEAR(1));
});

// ----------------------------------------------------------------------
// TRY-IT 2: flagged scam
// ----------------------------------------------------------------------

test("TRY-IT 2: a flagged scam receiver is blocked, a clean one is not", async (t) => {
  const { guard, ali, agent, merchant, scammer } = t.context.accounts;

  await agent.call(guard, "deposit", {}, { attachedDeposit: NEAR(10) });
  await ali.call(guard, "setPolicy", {
    agent: agent.accountId,
    perTxLimit: NEAR(5),
    dailyLimit: NEAR(50),
    allowlist: [],
  });

  // Anyone can report a scam address with citable evidence.
  await ali.call(guard, "reportScam", {
    address: scammer.accountId,
    evidence: "sha256:9f2c1a0d3e4b5f6a7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
  });
  t.true(await guard.view("isFlagged", { address: scammer.accountId }));

  // A withdrawal to the flagged address is refused, with the evidence cited.
  await t.throwsAsync(
    () => agent.call(guard, "withdraw", { receiver: scammer.accountId, amount: NEAR(1) }),
    { message: /flagged as scam/ }
  );

  // The same withdrawal to a clean receiver succeeds.
  await agent.call(guard, "withdraw", { receiver: merchant.accountId, amount: NEAR(1) });
  t.is((await guard.view("getBalance", { agent: agent.accountId })).toString(), NEAR(9));

  // The operator can clear a false positive; the address is spendable again.
  await ali.call(guard, "clearFlag", { address: scammer.accountId });
  t.false(await guard.view("isFlagged", { address: scammer.accountId }));
  await agent.call(guard, "withdraw", { receiver: scammer.accountId, amount: NEAR(1) });
  t.is((await guard.view("getBalance", { agent: agent.accountId })).toString(), NEAR(8));
});

// ----------------------------------------------------------------------
// TRY-IT 3: sandboxed wallet (daily limit + accounting)
// ----------------------------------------------------------------------

test("TRY-IT 3: the daily limit caps total spend and balances stay exact", async (t) => {
  const { guard, ali, agent, merchant } = t.context.accounts;

  await agent.call(guard, "deposit", {}, { attachedDeposit: NEAR(10) });
  await ali.call(guard, "setPolicy", {
    agent: agent.accountId,
    perTxLimit: NEAR(5),
    dailyLimit: NEAR(3),
    allowlist: [],
  });

  // First 2 NEAR withdrawal: inside the daily budget.
  await agent.call(guard, "withdraw", { receiver: merchant.accountId, amount: NEAR(2) });
  t.is((await guard.view("getSpentToday", { agent: agent.accountId })).toString(), NEAR(2));

  // Second 2 NEAR withdrawal: 2+2 exceeds the 3 NEAR daily cap.
  await t.throwsAsync(
    () => agent.call(guard, "withdraw", { receiver: merchant.accountId, amount: NEAR(2) }),
    { message: /daily limit exceeded/ }
  );

  // A 1 NEAR withdrawal still fits (2+1 <= 3).
  await agent.call(guard, "withdraw", { receiver: merchant.accountId, amount: NEAR(1) });
  t.is((await guard.view("getSpentToday", { agent: agent.accountId })).toString(), NEAR(3));
  t.is((await guard.view("getBalance", { agent: agent.accountId })).toString(), NEAR(7));

  // The merchant really received 3 NEAR on-chain.
  const merchantBalance = await merchant.balance();
  t.assert(merchantBalance >= NEAR(103), "merchant holds initial 100 NEAR + 3 NEAR received");
});

// ----------------------------------------------------------------------
// Extra: allowlist, paused policy, no-policy, owner-only
// ----------------------------------------------------------------------

test("allowlist restricts receivers when set", async (t) => {
  const { guard, ali, agent, merchant, scammer } = t.context.accounts;

  await agent.call(guard, "deposit", {}, { attachedDeposit: NEAR(5) });
  await ali.call(guard, "setPolicy", {
    agent: agent.accountId,
    perTxLimit: NEAR(5),
    dailyLimit: NEAR(50),
    allowlist: [merchant.accountId],
  });

  await agent.call(guard, "withdraw", { receiver: merchant.accountId, amount: NEAR(1) });
  await t.throwsAsync(
    () => agent.call(guard, "withdraw", { receiver: scammer.accountId, amount: NEAR(1) }),
    { message: /not in allowlist/ }
  );
});

test("a paused policy blocks everything; no policy blocks everything", async (t) => {
  const { guard, ali, agent, merchant } = t.context.accounts;

  // No policy yet: every withdrawal is refused.
  await agent.call(guard, "deposit", {}, { attachedDeposit: NEAR(5) });
  await t.throwsAsync(
    () => agent.call(guard, "withdraw", { receiver: merchant.accountId, amount: NEAR(1) }),
    { message: /no policy/ }
  );

  await ali.call(guard, "setPolicy", {
    agent: agent.accountId,
    perTxLimit: NEAR(5),
    dailyLimit: NEAR(50),
    allowlist: [],
  });
  await agent.call(guard, "withdraw", { receiver: merchant.accountId, amount: NEAR(1) });

  // Operator pauses the agent.
  await ali.call(guard, "setPolicyActive", { agent: agent.accountId, active: false });
  await t.throwsAsync(
    () => agent.call(guard, "withdraw", { receiver: merchant.accountId, amount: NEAR(1) }),
    { message: /paused/ }
  );
});

test("only the operator can write policies or clear flags", async (t) => {
  const { guard, agent } = t.context.accounts;

  await t.throwsAsync(
    () =>
      agent.call(guard, "setPolicy", {
        agent: agent.accountId,
        perTxLimit: NEAR(100),
        dailyLimit: NEAR(100),
        allowlist: [],
      }),
    { message: /owner only/ }
  );

  await t.throwsAsync(
    () => agent.call(guard, "clearFlag", { address: agent.accountId }),
    { message: /owner only/ }
  );
});
