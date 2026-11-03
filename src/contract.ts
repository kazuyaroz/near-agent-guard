import {
  NearBindgen,
  near,
  call,
  view,
  initialize,
  LookupMap,
  NearPromise,
} from "near-sdk-js";

/**
 * AgentGuard — policy-enforced spending for AI agents on NEAR.
 *
 * The problem: an AI agent that can spend needs keys, and keys to a funded
 * wallet are keys to everything. AgentGuard is the sandboxed wallet in
 * between: the operator funds the guard and writes a spending policy; the
 * agent can only move money through the guard, and only inside the policy.
 *
 * Enforcement points (all on-chain, none client-side):
 *   1. per-transaction limit   -> "blocked overspend"
 *   2. rolling daily limit
 *   3. receiver allowlist (optional)
 *   4. scam registry           -> "flagged scam"
 */

/** Spending policy for one AI agent, written by the operator. */
export type Policy = {
  /** Max yoctoNEAR per single withdrawal. */
  perTxLimit: bigint;
  /** Max yoctoNEAR per rolling UTC day. */
  dailyLimit: bigint;
  /** Allowed receivers; empty = any receiver that is not flagged. */
  allowlist: string[];
  /** false = policy paused; every withdrawal is blocked. */
  active: boolean;
};

/** A scam report against an address, with citable evidence. */
export type ScamFlag = {
  reporter: string;
  /** Hash or URI of the off-chain evidence for the report. */
  evidence: string;
};

/** Per-day spend record. day = block timestamp / 86_400_000. */
type DaySpend = {
  day: bigint;
  amount: bigint;
};

const DAY_MS = 86_400_000n;

@NearBindgen({})
class AgentGuard {
  private owner!: string;
  private policies = new LookupMap<Policy>("p:");
  private balances = new LookupMap<bigint>("b:");
  private spent = new LookupMap<DaySpend>("s:");
  private flags = new LookupMap<ScamFlag>("f:");

  @initialize({})
  initialize({ owner }: { owner: string }): void {
    this.owner = owner;
  }

  // ------------------------------------------------------------------
  // Policy engine (operator side)
  // ------------------------------------------------------------------

  @call({})
  setPolicy({
    agent,
    perTxLimit,
    dailyLimit,
    allowlist = [],
  }: {
    agent: string;
    perTxLimit: string;
    dailyLimit: string;
    allowlist?: string[];
  }): void {
    this.onlyOwner();
    this.policies.set(agent, {
      perTxLimit: BigInt(perTxLimit),
      dailyLimit: BigInt(dailyLimit),
      allowlist,
      active: true,
    });
    near.log(`AgentGuard: policy set for ${agent}`);
  }

  @call({})
  setPolicyActive({ agent, active }: { agent: string; active: boolean }): void {
    this.onlyOwner();
    const policy = this.policies.get(agent);
    if (!policy) throw new Error("AgentGuard: no policy for this agent");
    policy.active = active;
    this.policies.set(agent, policy);
    near.log(`AgentGuard: policy for ${agent} active=${active}`);
  }

  // ------------------------------------------------------------------
  // Sandboxed wallet (agent side)
  // ------------------------------------------------------------------

  /** Anyone (operator or agent) tops up their sandbox balance. */
  @call({ payableFunction: true })
  deposit(): void {
    const who = near.predecessorAccountId();
    const amount = near.attachedDeposit();
    if (amount <= 0n) throw new Error("AgentGuard: deposit must be > 0");
    const balance = (this.balances.get(who) ?? 0n) + amount;
    this.balances.set(who, balance);
    near.log(`AgentGuard: ${who} deposited ${amount} yoctoNEAR`);
  }

  /**
   * Agent-initiated withdrawal. Every policy rule is checked here, on-chain,
   * before a single yoctoNEAR leaves the contract.
   */
  @call({})
  withdraw({ receiver, amount }: { receiver: string; amount: string }): NearPromise {
    const agent = near.predecessorAccountId();
    const amt = BigInt(amount);

    const policy = this.policies.get(agent);
    if (!policy) throw new Error("AgentGuard: no policy for this agent");
    if (!policy.active) throw new Error("AgentGuard: policy is paused");

    const balance = this.balances.get(agent) ?? 0n;
    if (amt > balance) throw new Error("AgentGuard: insufficient sandbox balance");

    if (amt > policy.perTxLimit) {
      throw new Error(
        `AgentGuard: blocked overspend — ${amt} yoctoNEAR exceeds per-transaction limit ${policy.perTxLimit}`
      );
    }

    const day = near.blockTimestamp() / DAY_MS;
    const spend = this.spent.get(agent);
    const spentToday = spend && spend.day === day ? spend.amount : 0n;
    if (spentToday + amt > policy.dailyLimit) {
      throw new Error(
        `AgentGuard: daily limit exceeded — ${spentToday}+${amt} exceeds ${policy.dailyLimit}`
      );
    }

    const flag = this.flags.get(receiver);
    if (flag) {
      throw new Error(
        `AgentGuard: receiver ${receiver} is flagged as scam (evidence: ${flag.evidence})`
      );
    }

    if (policy.allowlist.length > 0 && !policy.allowlist.includes(receiver)) {
      throw new Error("AgentGuard: receiver not in allowlist");
    }

    this.balances.set(agent, balance - amt);
    this.spent.set(agent, { day, amount: spentToday + amt });
    near.log(`AgentGuard: ${agent} withdrew ${amt} yoctoNEAR to ${receiver}`);
    return NearPromise.new(receiver).transfer(amt);
  }

  // ------------------------------------------------------------------
  // Reputation / scam detection
  // ------------------------------------------------------------------

  /** Anyone can flag an address with a pointer to evidence. */
  @call({})
  reportScam({ address, evidence }: { address: string; evidence: string }): void {
    const reporter = near.predecessorAccountId();
    if (this.flags.get(address)) {
      throw new Error("AgentGuard: address already flagged");
    }
    this.flags.set(address, { reporter, evidence });
    near.log(`AgentGuard: ${address} flagged by ${reporter} (evidence: ${evidence})`);
  }

  /** Operator clears a false positive. */
  @call({})
  clearFlag({ address }: { address: string }): void {
    this.onlyOwner();
    this.flags.remove(address);
    near.log(`AgentGuard: flag cleared for ${address}`);
  }

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------

  @view({})
  getOwner(): string {
    return this.owner;
  }

  @view({})
  getPolicy({ agent }: { agent: string }): Policy | null {
    return this.policies.get(agent) ?? null;
  }

  @view({})
  getBalance({ agent }: { agent: string }): bigint {
    return this.balances.get(agent) ?? 0n;
  }

  @view({})
  getSpentToday({ agent }: { agent: string }): bigint {
    const spend = this.spent.get(agent);
    if (!spend) return 0n;
    const day = near.blockTimestamp() / DAY_MS;
    return spend.day === day ? spend.amount : 0n;
  }

  @view({})
  isFlagged({ address }: { address: string }): boolean {
    return this.flags.get(address) !== null;
  }

  @view({})
  getFlag({ address }: { address: string }): ScamFlag | null {
    return this.flags.get(address) ?? null;
  }

  private onlyOwner(): void {
    if (near.predecessorAccountId() !== this.owner) {
      throw new Error("AgentGuard: owner only");
    }
  }
}

export default AgentGuard;
