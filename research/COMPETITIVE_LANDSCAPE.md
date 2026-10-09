# Competitive landscape (research date: 2026-10-09)

**Method**
- Repositories were cloned at HEAD on 2026-10-09 and their code read. Commits are given below.
- Specifications and papers were read on their primary pages.
- GitHub's search API was blocked in this environment, so repositories were found through web search, npm and links between repositories.

**Rules used in this document**
- "Not found" means not found in the files and pages read. It never means "proven absent".
- **CODE** means verified in source. **DOCS** means stated in the project's own documentation. **INFERENCE** means our reading.

**Confidence levels**
- **High:** code read at a pinned commit.
- **Medium:** documentation, or partial code.
- **Low:** README only, or the project's identity is uncertain.

## 1. Eunomia (primary competitor)

`github.com/eunomia-finance/eunomia`, main @ `a01bfa3` (2026-10-09). The npm package `eunomia-mcp` is at 0.2.1. **Confidence: High.** Links below are relative to `blob/main/`.

**1. Problem.** Give agents "a budget, not the keys" (README L31-40).

**2. Architecture (CODE).**
- A separate **treasury contract that holds the funds** and pays out with `token.transfer(current_contract, to, amount)` (`contracts/treasury/src/lib.rs` L406-410).
- No `__check_auth` / custom account anywhere in the repo. The agent is authorized with `require_auth()` (L361, L699-704).
- A passkey-kit wallet is the treasury admin.
- Factory, registry, ZK compliance verifier, reputation oracle stand-in, and a payee-gate for OZ confidential tokens.

**3. On-chain enforcement (CODE).**
- Payee allowlist or reputation gate (L767-789).
- Per-payment cap (L373). Despite the name `per_task_limit`, it is per payment, and task spend "is NOT capped" (L44-48).
- Rolling 24h window of hourly buckets (L714-751).
- One "Leash" session: cap + deadline (L51-62, L238-273).
- Escrow: `create_escrow` by the agent; `release_escrow` **admin only**, with no evidence input (L571-578).
- Pause and withdraw.
- ZK "Sealed Receipt": a Groth16 proof, after the day closes, that the day's total equals the sum of 16 committed payments to allowlisted payees within limits. The proof is about the total, not the per-payment breakdown (`circuits/circuits/compliance.circom` L57-128; SECURITY L154-175).

**4. Application-level.**
- MCP pre-flight mirrors.
- Event-rebuilt payee list.
- localStorage "decision ledger".
- Anon-insertable telemetry ("not proof", SECURITY D1).
- Agent key as a JSON file at mode 0600.
- Off-chain x402 gate for allowance-account spending (`packages/x402/src/gate.ts` L4-9).

**5. Compromised agent.** Bounded by the payee gate, caps, window, session and balance. SECURITY: "no path was found … to drain a treasury" (L87-91). **In-policy misuse remains:** paying an allowlisted payee for the wrong reason, up to the limits. No purpose check was found in code.

**6. Malicious payee or tool.** An allowlisted payee gets paid; there is no clawback on `pay`. No dispute mechanism was found.

**7. Service fails after payment.** `pay` is final. Escrow release is a manual admin decision. No delivery attestation was found.

**8. Delegation.** Not found. There is a single session, and the factory panics on more than one Leash. Revocation falls back to the root agent.

**9. Does it verify what the agent accomplishes?** No. `task_id` is an unconstrained `u64`; it defaults to 0 in MCP and is a fixed 403 for x402 top-ups (`packages/mcp/src/tools.ts` L245, `packages/x402/src/e2e-interop.ts` L35).

**10. Missing or trusted.**
- Reputation controller and admin-set oracle.
- Owner-published ZK payee root.
- Single-party Groth16 setup.
- Web app passkey prompt "shows no transaction detail" (SECURITY L140-147).
- No independent audit.

## 2. Stellar projects

| Project (source) | Architecture | On-chain | Compromised agent | Recourse after a failed service | Delegation | Task binding | Conf. |
|---|---|---|---|---|---|---|---|
| **Soneso Stellar Agent Wallet** ([repo](https://github.com/Soneso/stellar-agent-wallet) e7d02da) | Rust CLI + MCP. OZ smart account path: `CallContract` rule + External ed25519 + `spending_limit` | Rule + spending limit (smart-account path); digest binds rule ids | Key limited to one contract and cap; no MCP tool for agent `execute` | MPP reconciles authorized / observed / settled; no refund | Rule and signer removal, expiry; sub-delegation not found | MPP binds the credential to the exact HTTP request; **task binding not found** | High |
| **Stellar-402-SpendGuard** ([repo](https://github.com/deegalabs/stellar-402-spendguard) cc24e79) | Vault contract (custodial), `authorize_payment` | max_tx, merchant whitelist, daily limit | Bounded by whitelist and caps | None; "proof" is any successful tx hash (amount and recipient not checked) | One agent | None | High |
| **Nodal AI** ([repo](https://github.com/Nodal-stellar/Nodal-AI) 5603990) | TS agent kit (~40 tools); arbiter escrow | Escrow only, not tied to x402 | **Key in process env**: limits bypassable | Arbiter escrow (manual) | Not found | None | High (repo identity: likely) |
| **Proxima** ([repo](https://github.com/Plain-labs/Proxima) 34aa7d8) | Registry + policy contract | Caps, but `create_policy` has no auth check (drain) | Model bypassable | None | Revoke appears unusable (owner is the contract itself; not tested) | None | High (repo identity: likely) |
| **Stellar Agent Guard** ([repo](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts) 9599013) | Custom account; `__check_auth` runs policy | Caps, rolling window, allowlists and blocklists, dead-man switch | Bounded on SAC transfers; other calls only window, pause and allowlist | None | Single key | None | Medium (README spec read; engine not line-audited) |
| **stellar-agent-pay** ([repo](https://github.com/JosueBrenes/stellar-agent-pay) 6edfea8) | CLI paying standard x402 | **None** (local policy) | Out of scope; plaintext key | "Does not verify that the seller delivered anything useful" | Not found | None | High |
| **Vellar** ([sdk](https://github.com/Vellar-Wallet/vellar-sdk) 91eca2a, [facilitator](https://github.com/Vellar-Wallet/vellar-facilitator) f13f310) | passkey-kit wallet; agent session keys; policy contracts co-approve in `__check_auth`; community x402 facilitator | Spending limit (tumbling window, up to 2× at the edge; recipient-agnostic, their V-1), verified-only, expiry | Up to the cap until revoke or expiry | **Bond escrow:** seller bond, payer dispute, signed delivery receipt `(paymentId, responseHash, ts)`; proves non-delivery, **not content mismatch**; integration partial | Revoke and expiry; sub-delegation not found | Response hash only | Medium |
| **AgentAllowance** ([repo](https://github.com/karagozemin/AgentAllowance) 5b9fcac) | OZ smart account + spending limit + recipient policy; policy-aware facilitator | Spending limit, recipient policy (DOCS) | Per docs, bounded | Not found | Not found | Not found | Low (README and architecture grep) |
| **Mooring** ([repo](https://github.com/berkay1532/mooring)) | Custom-account "cards" | Budget, per-tx cap, allowlist, expiry (DOCS) | n/a | n/a | n/a | n/a | Low (README only) |
| **REAPP** ([SCF #43](https://communityfund.stellar.org/submissions/recrWPt0QGLHnbv5Z)) | Soroban MandateRegistry + AP2 mandate engine | `register_mandate` / `validate_and_consume` / `revoke_mandate` (DOCS) | n/a | n/a | n/a | AP2-style mandates (structured) | Low (repo not read) |
| **"Agent Card"** | **Not found** under that name. AgentAllowance and Mooring are the closest | | | | | | — |

**Official Stellar x402 / MPP** ([stellar-docs](https://github.com/stellar/stellar-docs) 2efd1d5; [coinbase/x402 Stellar mechanism](https://github.com/x402-foundation/x402); [stellar-mpp-sdk](https://github.com/stellar/stellar-mpp-sdk) 21a55a3). **Confidence: High.**
- The facilitator checks the transfer's asset, recipient and amount against the requirements (CODE).
- `@x402/express` skips settlement when the handler returns ≥400. The seller controls that status code.
- Spending controls are recommended (OZ smart accounts), not part of the protocol.
- MPP one-way channels let the funder reclaim unspent deposit; there is no delivery check.

**OZ stellar-accounts 0.7.x** ([repo](https://github.com/OpenZeppelin/stellar-contracts) 3710163). **Confidence: High.**
- Three policies: `spending_limit`, `simple_threshold`, `weighted_threshold`.
- When a rule has policies, signer sufficiency is left to them, and all policies must pass.
- `spending_limit` does not look at the recipient.

## 3. Outside Stellar

| System (source) | What it binds | Enforced where | Delegation / revocation | Delivery | Conf. |
|---|---|---|---|---|---|
| **AP2 v0.2** ([spec](https://github.com/google-agentic-commerce/AP2/blob/main/docs/ap2/specification.md)) | Closed payment ← user-signed open mandate (SD-JWT, `cnf`, `sd_hash`); constraints: amount range, payees, merchants, line items, budget | Verifiers' code (credential provider, network, processor); off-chain | A2A delegation "outside the scope"; no revocation protocol found | Mandates are dispute evidence only | High |
| **Mastercard Verifiable Intent v0.1** ([spec](https://github.com/agent-intent/verifiable-intent)) | SD-JWT chain L1→L2(user, `cnf`)→L3(agent) | Verifiers; off-chain | **Sub-delegation forbidden** (L3 has no `cnf`); no revocation protocol | — | High |
| **x402 v2** ([spec](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)) | Exact amount and recipient; `upto` (server meters, capped); `auth-capture` (operator captures); Offer/Receipt extension (server-signed, **no body hash**) | Facilitator + chain | — | Open proposals only: #1195, #3720 | High |
| **MPP** ([draft](https://github.com/tempoxyz/mpp-specs)) | HMAC challenge binding; request digest; session vouchers | Server + channel contract | Session signer key can drain the channel deposit (stated) | Receipt = settled, not delivered | High |
| **MetaMask Delegation Framework / ERC-7710** ([DelegationManager.sol](https://github.com/MetaMask/delegation-framework/blob/main/src/DelegationManager.sol)) | Delegation chains with caveat enforcers on every link | On-chain | **Arbitrary-depth chains; disabling any ancestor invalidates descendants at next redemption (CODE)**; no depth bound; `ANY_DELEGATE` open delegations | "doesn't validate execution outputs" | High |
| **Coinbase Spend Permissions, Zodiac Roles, SmartSessions, Kernel** ([spend-permissions](https://github.com/coinbase/spend-permissions), [roles](https://github.com/gnosisguild/zodiac-modifier-roles), [smartsessions](https://github.com/erc7579/smartsessions)) | Flat scoped permissions with caps and conditions | On-chain | Flat; no redelegation | — | High |
| **ERC-8004** ([spec](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8004.md)) | Identity, reputation, validation scores | Registry | — | "Payments are orthogonal" | High |
| **ERC-8183 Agentic Commerce** ([spec](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8183.md)) | Job escrow; provider submits deliverable hash; **evaluator decides** | On-chain escrow; trusted evaluator | — | Evaluator-trusted; no dispute | High |
| **ERC-8273 Attestation-Gated Agentic Actions** ([spec](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8273.md)) | An attestor's per-transaction attestation over `actionDigest` (target, selector, args, nonce) gates the call | On-chain registry, transient storage | — | — | High (spec read) |
| **ERC-8354 Confidential Agent Policy Verdicts** ([spec](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8354.md)) | ZK proof that an interpreter evaluated a secret policy over an action → ALLOW | On-chain verifier | — | — | High (spec read) |
| **Visa Intelligent Commerce / TAP; Mastercard Agent Pay; ACP; KYAPay; Crossmint; Nevermined** | Network- or PSP-enforced instructions and tokens; agent HTTP signatures; allowances | Off-chain networks / PSPs (Crossmint: on-chain caps per its docs) | Varies; none with cascading revocation found | Dispute signals only | Medium |

## 4. Research literature (relevant to the gaps)

- **CaMeL** ([arXiv 2503.18813](https://arxiv.org/abs/2503.18813)).
  - A privileged planner sees only the user's query; a quarantined LLM parses untrusted data. An interpreter tracks data flow and capabilities.
  - Its banking policy requires the payment recipient and amount to come from the user.
  - Enforced **inside the agent runtime**. Simulated banking, nothing on-chain.
- **FIDES** ([arXiv 2505.23643](https://arxiv.org/abs/2505.23643)): integrity and confidentiality labels; noninterference for consequential actions; runtime only.
- **Multi-CaMeL**, "Can CaMeLs Talk?" ([arXiv 2610.05640](https://arxiv.org/abs/2610.05640), 2026-10-05): provenance across agent-to-agent calls. Payments and wallets are not mentioned.
- **"Signed Words Only"** ([post](https://payloadpolitics.substack.com/p/signed-words-only), undated): content fragments signed with origin and trust tier; a policy gateway requires a "trusted instruction or step-up" for `transfer_funds`. **Off-chain gateway; tracks instruction origin, not argument data flow; no blockchain.**
- **PolicyLayer two-gate** ([dev.to](https://dev.to/l_x_1/how-to-prevent-ai-agents-from-draining-crypto-wallets-3cci)): limits plus an intent fingerprint; the agent signs locally. Origin of arguments is not checked.
- **A402** ([2603.01179](https://arxiv.org/abs/2603.01179)): TEE plus adaptor signatures make payment atomic with attested execution. Simulated execution; no code published.
- **TessPay** ([2602.00213](https://arxiv.org/abs/2602.00213)): verify-then-pay escrow on TLSNotary or TEE evidence. No deployed implementation seen.
- **Formal analysis of agent payment protocols** ([2609.00060](https://arxiv.org/abs/2609.00060)): 40 new findings. Prompt injection is abstracted as "valid actions that deviate from user intent", i.e. out of the protocol's reach.
- **AP2 analyses** ([2608.23858](https://arxiv.org/abs/2608.23858), [2601.22569](https://arxiv.org/abs/2601.22569)): "valid mandate signatures alone do not ensure" the transaction reflects intent, because manipulation happens before signing.
- **Proof-Gated Signing** ([2610.00354](https://arxiv.org/abs/2610.00354)): wallet-enforced post-conditions on effects. No provenance.
- **x402 issue #2641**: a ZK proof that a payment satisfies a user-signed policy and quote, checked in an escrow wallet. Binds to values the user signed, not to argument provenance. Date and author could not be verified.
- **Delegation:** CAPMAS ([2609.06500](https://arxiv.org/abs/2609.06500)), AIP ([2603.24775](https://arxiv.org/abs/2603.24775)), Biscuit, UCAN revocation, Macaroons. None is applied to payments.

## 5. Feature matrix

✓ = present (verified at the stated confidence) · ◐ = partial · ✗ = not found · — = not applicable.

| | ACAN today | Eunomia | Soneso | Vellar | Agent Guard | AP2 / VI | MetaMask 7710 | CaMeL |
|---|---|---|---|---|---|---|---|---|
| Funds stay in the user's account (non-custodial; no vault contract) | ✓ | ✗ (treasury) | ✓ | ✓ | ✓ | — | ✓ | — |
| On-chain amount limit, rolling | ✓ | ✓ | ✓ | ◐ (tumbling) | ✓ | — | ✓ | ✗ |
| On-chain recipient allowlist | ✓ | ✓ | ◐ (local engine) | ✗ (V-1) | ✓ | — | ✓ (enforcers) | ✗ |
| On-chain per-recipient caps | ✓ | ✗ | ✗ | ✗ | ✓ (overrides) | — | ◐ (by combining enforcers; inference) | ✗ |
| Rule or session expiry | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (`exp`) | ✓ | — |
| Human approval bound to the exact transaction | ✓ | ◐ | ✓ (HMAC) | ✗ | ✗ | ✓ (trusted surface) | — | ✓ (runtime) |
| x402 straight from the smart account | ✓ | ◐ (`pay()` / allowance account) | ✓ | ✓ | ✗ | — | ✓ (EVM, ERC-7710 method) | — |
| Private amounts on-chain | ◐ | ◐ (ZK totals; transfers public) | ✗ | ✗ | ✗ | — | ✗ | — |
| Signed receipts checkable against the chain | ✓ | ◐ (events, ZK) | ◐ (hash-chained log) | ◐ | ✗ (events, `policy_hash`) | ✓ (verifier receipts) | ✗ | — |
| Sub-delegation with cascading revocation | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ (out of scope / forbidden) | ✓ | ✗ (multi-CaMeL: runtime) |
| Settlement conditioned on delivery evidence | ✗ | ✗ (manual escrow) | ✗ | ◐ (bond; non-delivery only) | ✗ | ✗ | ✗ | — |
| Payment bound to the user's task | ✗ | ✗ (`task_id` free) | ◐ (request binding) | ✗ | ✗ | ◐ (structured constraints) | ✗ | ◐ (runtime) |
| **Payment refused unless its parameters and decision come from trusted sources** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ **runtime only, not at the signer** |
| Leaked agent key alone can spend | Yes, up to limits | Yes, up to limits | Yes, up to cap | Yes, up to cap | Yes, up to limits | n/a | Yes, within caveats | n/a |

## 6. Gaps shared by everything read

1. **In-policy misuse.** No system that holds or authorizes funds stops a manipulated agent from paying an allowed recipient an allowed amount for the wrong reason. Eunomia's SECURITY.md states this. AP2's own threat model assumes prompt injection cannot be prevented and only bounds its impact.
2. **Provenance at the signer.** The only systems that check where payment arguments came from (CaMeL, FIDES and their follow-ups) do it inside the agent's own process. If that process or its key is compromised, the check is gone, and the account that holds the money knows nothing about it.
3. **Delivery-conditioned settlement** exists only as papers (TessPay, A402), manual or evaluator escrows (Eunomia, ERC-8183, Nodal), or partial integrations (Vellar bond: non-delivery only).
4. **Sub-delegation** with cascading revocation exists on EVM (MetaMask) but was not found on Stellar.
