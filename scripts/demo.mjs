/**
 * AgentGuard demo — an AI agent with a spending budget, and the guard that
 * enforces the operator's policy no matter what the agent decides to do.
 *
 * Run: npm run demo
 * (boots a local NEAR sandbox via near-workspaces; first run downloads nearcore)
 */
import { Worker } from "near-workspaces";

const NEAR = (n) => (BigInt(n) * 10n ** 24n).toString();

const line = (s = "") => console.log(s);

async function main() {
  const worker = await Worker.init();
  const root = worker.rootAccount;

  const guard = await root.devDeploy("./build/agent-guard.wasm");
  const operator = await root.createSubAccount("operator");
  const agent = await root.createSubAccount("agent");
  const merchant = await root.createSubAccount("merchant");
  const scammer = await root.createSubAccount("scammer");

  await root.call(guard, "initialize", { owner: operator.accountId });

  line("AgentGuard demo — policy-enforced spending for AI agents on NEAR");
  line("================================================================");
  line(`guard contract : ${guard.accountId}`);
  line(`operator       : ${operator.accountId}`);
  line(`AI agent       : ${agent.accountId}`);
  line(`merchant       : ${merchant.accountId}`);
  line(`scam address   : ${scammer.accountId}`);
  line();

  // The operator funds the agent's sandbox and writes the policy.
  await agent.call(guard, "deposit", {}, { attachedDeposit: NEAR(10) });
  await operator.call(guard, "setPolicy", {
    agent: agent.accountId,
    perTxLimit: NEAR(1),
    dailyLimit: NEAR(3),
    allowlist: [],
  });
  line("Operator: funded the agent's sandbox with 10 NEAR.");
  line("Operator: policy = 1 NEAR per transaction, 3 NEAR per day, any receiver.");
  line();

  // A stand-in for the agent's planner: what the "AI" decides to try next.
  const attempts = [
    { do: "pay merchant 2 NEAR (over the per-transaction limit)", expect: "blocked overspend" },
    { do: "pay merchant 1 NEAR (inside policy)", expect: "lands" },
    { do: "pay merchant 1 NEAR (inside policy)", expect: "lands" },
    { do: "pay merchant 1 NEAR (2+1+1 would exceed the 3 NEAR daily cap)", expect: "daily limit exceeded" },
    { do: "pay scam address 1 NEAR", expect: "flagged scam" },
  ];

  // Before the scam step, someone reports the scam address.
  line("A user reports the scam address with evidence.");
  await operator.call(guard, "reportScam", {
    address: scammer.accountId,
    evidence: "sha256:9f2c1a0d3e4b5f6a7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
  });
  line();

  let pass = 0;
  for (const [i, a] of attempts.entries()) {
    const receiver = a.expect === "flagged scam" ? scammer.accountId : merchant.accountId;
    const amount = a.do.match(/(\d+) NEAR/)[1];
    line(`--- attempt ${i + 1}: agent decides to ${a.do}`);
    let outcome;
    try {
      await agent.call(guard, "withdraw", { receiver, amount: NEAR(amount) });
      outcome = "lands";
    } catch (e) {
      const m = String(e.message || e);
      if (m.includes("blocked overspend")) outcome = "blocked overspend";
      else if (m.includes("daily limit exceeded")) outcome = "daily limit exceeded";
      else if (m.includes("flagged as scam")) outcome = "flagged scam";
      else outcome = `unexpected error: ${m.slice(0, 120)}`;
    }
    const ok = outcome === a.expect;
    pass += ok ? 1 : 0;
    line(`    guard says : ${outcome}`);
    line(`    expected   : ${a.expect}`);
    line(`    result     : ${ok ? "PASS" : "FAIL"}`);
    line();
  }

  const balance = await guard.view("getBalance", { agent: agent.accountId });
  const spent = await guard.view("getSpentToday", { agent: agent.accountId });
  line("Final sandbox state");
  line("-------------------");
  line(`agent sandbox balance : ${Number(balance) / 1e24} NEAR`);
  line(`agent spent today     : ${Number(spent) / 1e24} NEAR`);
  line(`demo result           : ${pass}/${attempts.length} attempts behaved as the policy requires`);
  line();

  await worker.tearDown();
  if (pass !== attempts.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
