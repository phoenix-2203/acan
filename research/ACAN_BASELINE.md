# ACAN baseline (audit date: 2026-10-09)

What ACAN does today, classified by evidence. A README sentence is not counted as evidence on its own: every row points to code, a test, or a testnet transaction.

**How this was checked**
- Code was read in this repository at its current state.
- Tests were run on 2026-10-09:
  - `npm test`: **62 of 62 pass**. This covers packages/core, apps/agent, apps/web, apps/mcp, apps/site and apps/relay.
  - `cargo test` in `contracts/`: **10 of 10 pass**.
- Testnet transactions are the ones linked in `README.md` ("Verified on testnet"). They were not re-run today.
- Two live demo-site runs were confirmed by the project owner on 2026-10-08. One paid 0.8 XLM to Southgate Data. The other was a prompt-injected transfer refused with #3401.

**Classification key**
- **VERIFIED:** implemented and verified by tests and/or recorded testnet transactions.
- **PARTIAL:** implemented with a stated limit.
- **SIMULATED:** works only in a demo or simulated setting.
- **PLANNED:** not implemented.
- **UNKNOWN:** not established.

## 1. Architecture in one paragraph

The money sits in an OpenZeppelin `stellar-accounts` smart account on Stellar testnet, controlled by the guardian's passkey (WebAuthn signer).

The agent has its own ed25519 key. The account honours that key only under a **context rule** scoped to the token contract (`CallContract(USDC)`). Policies are attached to the rule:
- OZ `spending_limit`: a rolling amount per period;
- ACAN's own **merchant budget policy**: recipient allowlist, per-recipient caps, a payment count, and the largest single payment.

Every payment the agent signs is checked inside the account's `__check_auth` before the token moves. The agent pays merchants over x402 v2 with a custom smart-account scheme, or privately through signed vouchers settled in confidential transfers. An LLM chooses what to buy. By default the human picks among the options the LLM offers.

## 2. Capabilities

### Authority and enforcement

| Capability | Class | Evidence (paths, functions, tests, transactions) |
|---|---|---|
| Smart account holds funds, controlled by guardian passkey | VERIFIED | `contracts/Cargo.toml` (stellar-accounts =0.7.2); `apps/web/src/acan.ts`; `apps/site/src/sandbox.ts` `Sandbox.createWallet` (smart-account-kit) |
| Agent key honoured only under a context rule | VERIFIED | `packages/core/src/agent-signer.ts` `SmartAccountAgentSigner.signEntry` signs `sha256(signature_payload ‖ xdr(rule_ids))`. This matches OZ `do_check_auth` in `stellar-accounts-0.7.2/src/smart_account/storage.rs`, which binds `context_rule_ids` into the digest. `packages/core/test/agent-signer.test.ts` |
| Rolling spending limit (OZ `spending_limit`) | VERIFIED | `apps/web/src/acan.ts`. README "Public mode": 5 payments settled, the 6th refused `SpendingLimitExceeded` (tx `505d1ca2…`) |
| Recipient allowlist (#3401), per-recipient caps (#3406), payments per period (#3407), largest single payment (#3408) | VERIFIED | `contracts/merchant-allowlist-policy/src/lib.rs` `enforce`. 10 Rust tests in `src/test.rs`, including `smart_account_enforces_merchant_budgets_and_spending_limit_together`, which runs a real OZ `do_check_auth` in the Soroban test host. Policy v0.3 deployed at `CA2PF5YG…J2FG` (`deployments/testnet.json`) |
| Rule expiry (`valid_until`) | VERIFIED | `apps/web/src/acan.ts` `grantAgent`. Enforced by OZ `do_check_auth`, which rejects expired rules |
| Revocation (remove rule) | VERIFIED | `apps/site/src/sandbox.ts` `revoke`. Live demo: payments after revoke are refused |
| Emergency stop (revoke every agent rule) | Implemented; code reading only, no automated test or recorded transaction | `apps/web/src/App.tsx` "Emergency stop" |
| Guardian "approve once" for a refused payment | VERIFIED | README "Guardian approval", tx `faf52259…`. `apps/web/src/approval-check.ts` `checkRequest` decodes the auth entry XDR and refuses to let the guardian sign anything other than the claimed transfer. `apps/web/test/approval-check.test.ts` (3 tests) |
| Agent cannot change its own rule | VERIFIED (by OZ semantics) | The agent rule is `CallContract(token)`. Calls to the account itself (`add_context_rule` and so on) need a rule covering the account, which only the guardian holds. Enforced by `do_check_auth` rule-type matching. No dedicated ACAN test |
| AI drafts an allowance from plain English; only the passkey creates it | VERIFIED | `apps/agent/src/policy-draft.ts`; `apps/web/src/PolicyComposer.tsx`; `apps/agent/test/policy-draft.test.ts` |

### Payments

| Capability | Class | Evidence (paths, functions, tests, transactions) |
|---|---|---|
| x402 v2 payments from the smart account (USDC) | VERIFIED | `packages/core/src/x402-smart-account-scheme.ts`; `packages/core/src/facilitator.ts`. Tx `4394246d…` (0.01 USDC to Northwind) |
| Merchant delivers only after settlement | VERIFIED | `packages/core/test/attacks.test.ts` "[I1]" |
| Merchant hardening: request binding, exactly-once delivery, private caching, payTo pinning | VERIFIED | `packages/core/src/merchant-guards.ts`; `attacks.test.ts` [I3] [I4] [II] [III]; `apps/agent/src/wallet.ts` `payToMismatch` |
| Private mode: per-request vouchers, confidential settlement, auditor decryption | PARTIAL | `packages/core/src/tab/*`; `packages/confidential/src/audit.ts`. README: 7 requests, 0 per-request transactions, 3 confidential settlements. Stated limits: built on an unaudited OZ feature branch; the vault leftover after revoke is up to one chunk (README "Security model") |
| Signed task receipts, checkable against the chain | VERIFIED | `packages/core/src/receipt.ts`, `receipt-check.ts`; `packages/core/test/receipt*.test.ts`; `scripts/verify-receipt.ts`; `apps/site/src/ReceiptSection.tsx` |

### The AI agent and integrations

| Capability | Class | Evidence (paths, functions, tests, transactions) |
|---|---|---|
| LLM purchasing agent; the human picks among options (default) | VERIFIED | `apps/agent/src/chat-engine.ts` `offer_options` → `ChatEngine.choose`; `apps/agent/test/chat-engine.test.ts` |
| Prices on options come from the merchant catalog, not the model | VERIFIED | `chat-engine.ts` `priceOf`. The catalog is fetched from the merchant over HTTP, so it is merchant-supplied, not guardian-pinned |
| Merchant data marked as untrusted | PARTIAL (prompt-level only) | `chat-engine.ts` labels results `untrustedData` and the system prompt says to ignore instructions in them. This is a convention given to the model. **Nothing enforces it.** |
| Autopilot (model buys without a human pick) | VERIFIED, off by default | `chat-engine.ts` `autopilot` / `buy` tool |
| MCP server (5 tools) | VERIFIED | `apps/mcp/src/server.ts`: `acan_list_merchants`, `acan_check_budget`, `acan_buy`, `acan_request_approval`, `acan_settle_tabs`; `apps/mcp/test/mcp.test.ts`. An MCP client calls `acan_buy` directly with no human pick |
| Demo site AI: each visitor's sandbox wallet, XLM, direct transfers (not x402) | SIMULATED (testnet demo) | `apps/site/src/ai-agent.ts`, `SandboxSection.tsx`; relay `apps/relay/server.mjs`. Agent secret kept in browser `localStorage` (`sandbox.ts`) |
| Hosted LLM relay with per-visitor and global limits | VERIFIED | `apps/relay/server.mjs` `Limits`; `apps/relay/test/relay.test.mjs` |

### Roadmap and unknowns

| Capability | Class | Evidence (paths, functions, tests, transactions) |
|---|---|---|
| Agent-to-agent sub-delegation | PLANNED | None in code. Listed in `video/FACTS.md` R1 |
| Payment bound to a stated task or outcome; pay on verified delivery | PLANNED | `video/FACTS.md` R2. Receipts record what was paid, but nothing gates payment on the task |
| Backup signer / recovery | PLANNED | `video/FACTS.md` R3 |
| Mainnet, audit | PLANNED / none | Never claimed |
| Behaviour against adaptive prompt injection in autopilot | UNKNOWN | Not evaluated. The live #3401 block was against a non-listed recipient |

## 3. What ACAN guarantees today, stated precisely

Whatever the agent key signs, the smart account lets USDC leave only:
- under a live, unexpired rule;
- to an allowlisted recipient;
- within that recipient's cap, the number of payments, the per-payment maximum, and the rolling limit.

All of this is enforced on-chain in `__check_auth`.

**What ACAN does not guarantee today:**
1. That an in-limit payment to an allowlisted merchant is one the user wanted. A manipulated or compromised agent can spend the whole allowance on the wrong allowlisted merchant or product. Eunomia's own SECURITY.md lists the same gap ("in-policy misuse").
2. That a payment's recipient and amount did not come from untrusted content. In the default flow a human pick stands in for this. In autopilot and over MCP there is no such check.
3. That a leaked agent key spends nothing. A leaked key can spend up to the limits.
4. That the paid service was delivered or was correct, beyond settle-before-deliver ordering.
5. Bounded sub-delegation between agents.

These gaps are the starting point for `UNSOLVED_PROBLEMS.md`.
