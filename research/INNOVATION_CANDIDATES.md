# Innovation candidates (2026-10-09)

Twelve candidates follow. Each has ten parts:

- **A.** Thesis.
- **B.** The problem.
- **C.** Why current solutions fall short.
- **D.** Mechanism.
- **E.** Trust.
- **F.** Enforcement.
- **G.** Adversarial analysis.
- **H.** Feasibility.
- **I.** Differentiation.
- **J.** Research confidence.

Evidence for every competitor claim is in `COMPETITIVE_LANDSCAPE.md`. The problem numbers (P1–P10) refer to `UNSOLVED_PROBLEMS.md`.

These were rejected outright as defined by the brief, and are not counted:
- another limit or allowlist (ACAN has both);
- another approval screen (ACAN has approve-once);
- self-policy-modification protection (ACAN already has it through OZ; see P6);
- a generic reputation score;
- a "second AI reviews the first", because it depends on probabilistic judgment.

---

## C1. Provenance-gated payment authorization

**A. Thesis.** The smart account pays only when an independent, deterministic verifier has re-derived the payment's recipient, amount and the decision to pay from trusted sources. Trusted sources are the user's signed request and the guardian's pinned catalog. A prompt injection therefore cannot cause, steer or size a payment the account will accept, even inside every limit.

**B. Problem.** P1 (in-policy misuse) and P2 (a leaked agent key spends up to the limits).

**C. Why current solutions fall short.**
- CaMeL and FIDES enforce exactly this kind of policy, but inside the agent's process. A compromised runtime or a stolen key skips it, and the account knows nothing.
- Wallet co-signers and policy servers (Turnkey-style, PolicyLayer, Soneso HMAC approvals) check parameters or human approvals, not provenance.
- ERC-8273 gates an action on an attestor's per-transaction attestation, but leaves what is attested undefined.
- "Signed Words Only" requires trusted instructions at an off-chain gateway. It does not track argument data flow, and there is no account enforcement.
- Eunomia admits the gap.

**D. Mechanism.**
1. *Trusted inputs.*
   - The user's request is signed by a device key in the user's client (chat UI). The guardian's passkey registered that key, so the agent host cannot forge user intent.
   - The guardian pins a price book: merchant → product → price → payTo.
2. *Plan.*
   - A planner sees only the user's request (CaMeL's privileged planner) and emits a small plan in a deterministic language: fetch, extract, filter, choose, pay.
   - Untrusted content enters only as recorded tool outputs.
3. *Labels.*
   - Every value carries the set of sources it depends on: user, pinned, tool:host, planner.
   - Labels propagate through every operation: arithmetic, lookups (the index's labels are added to the result) and control flow (the labels of a branch condition attach to everything inside the branch).
4. *Co-signer.* A separate service with no LLM:
   - receives the case (signed request, plan, recorded tool transcript, the Soroban auth entry);
   - re-executes the plan itself;
   - requires recipient, amount and the control context of `pay` to depend only on {user, pinned};
   - decodes the auth entry itself and requires it to be exactly `token.transfer(account, recipient, amount)` with no sub-invocations;
   - computes the signature payload from the entry, and signs the OZ auth digest with its own ed25519 key.
5. *On-chain.*
   - The agent's context rule lists two signers, {agent, co-signer}, with OZ `simple_threshold(2)`, alongside `spending_limit` and the ACAN merchant budget policy.
   - `__check_auth` refuses unless both signed the same digest, and all policies still apply.
6. *Escalation.* A tainted payment is not co-signed. It goes to the guardian's passkey approve-once path (already in ACAN), together with the provenance explanation: "the choice of product depends on text from news.example".

**E. Trust.**
- *Trusted:* the co-signer's code and key; the user's client and device key; the guardian's pinned price book.
- *Not trusted:* the LLM(s), tools, merchants, web content, the agent host, the agent key.
- *Independently verifiable:* the co-signer's decision. It is a deterministic function of the case, so anyone holding the case can re-run it, and the case can be published with a receipt.
- *Not verifiable on-chain:* that the co-signer actually ran this policy. The chain only knows that it signed.

**F. Enforcement.**
- *Soroban:* two signers required, plus limits.
- *Cryptography:* ed25519 user request; co-signer signature bound to the exact auth digest, which includes the rule ids.
- *External service:* the provenance check itself.
- *Human:* tainted cases only.
- *AI:* nothing in the decision path. The planner's output is re-checked, not trusted for safety.

**G. Adversarial analysis.**
- *Injected text steering the choice* → the choice depends on tool:host → refused.
- *Laundering a value* through arithmetic, string formatting or a lookup into the pinned table → labels propagate → refused.
- *Implicit flow* `if (tool says X) pay(clean)` → control-context taint → refused.
- *Stolen agent key* → no co-signature → the chain refuses.
- *Stolen co-signer key alone* → no agent signature → refused.
- *Both stolen* → bounded by on-chain limits, as today.
- *Agent sends the co-signer a different auth entry from the plan's pay* → the co-signer decodes the entry → mismatch → refused.
- *Replaying a user request* → the request carries a nonce and a single-use budget → refused.
- *Compromised planner writing a malicious plan from clean inputs* (for example choosing the most expensive matching item): this is not caught by provenance. It is bounded by the request's structured constraints (product, budget) and by the limits. This residual risk is stated in the threat model.
- *Side channels and "data requires action" tasks:* refused or escalated by design. Utility cost as in CaMeL.

**H. Feasibility.**
- *Difficulty:* medium.
- *On-chain:* no new contract (OZ threshold policy). An optional v0.4 merchant policy could also require a specific co-signer.
- *Off-chain:* a mini-language interpreter with labels, the co-signer service, a two-signer `AuthPayload` builder, and device-key signing in the chat client.
- *Smallest credible demo:* about 2–3 days, comprising
  - the label interpreter and co-signer with adversarial tests;
  - a Soroban test-host proof that agent-only is refused and both signatures are accepted, using signatures produced by the TypeScript co-signer.

**I. Differentiation.**
- Eunomia stops payments to non-allowlisted payees. C1 stops manipulated payments to allowlisted payees, and makes a leaked agent key worthless on its own.
- No reviewed wallet, payment protocol or Stellar project enforces data-flow provenance at the account.

**J. Research confidence.**
- *Established:* IFC labels (CaMeL, FIDES); co-signing; OZ policies.
- *Novel combination:* runtime provenance policy re-executed by an independent verifier whose signature the account requires, bound to the exact auth entry.
- *Unproven:* utility on real tasks (CaMeL reported 77% versus 84% task success); planner-compromise residual.

## C2. Attenuating sub-delegation on Soroban

**A. Thesis.** An agent can hand a narrower allowance to another agent. Every descendant's spending is debited from all of its ancestors' budgets, and revoking any ancestor stops the whole subtree at once, enforced on-chain.

**B. Problem.** P4. A research agent hires sub-agents, and the user loses track of who can spend and revocation does not reach them.

**C. Why current solutions fall short.**
- No Stellar system was found with sub-delegation.
- AP2 puts it out of scope. Verifiable Intent forbids it.
- MetaMask ERC-7710 does it on EVM with per-link caveats and on-chain disabling (CODE), but has no depth bound and allows open delegations.

**D. Mechanism.**
1. A delegation-tree policy contract keeps nodes `{parent, key, budget, period, expiry, revoked}`.
2. The rule's policy, when a node's key signs, walks the node's ancestors and checks that none is revoked or expired and that each has budget left.
3. It then debits every ancestor.
4. Creating a child requires the parent node key's authorization, and a child's budget and expiry cannot exceed the parent's.
5. Depth is capped (for example 4).

**E. Trust.** Contract code only. Each node's key is trusted up to its own budget.

**F. Enforcement.** Soroban.

**G. Adversarial analysis.**
- *A child issues itself more* → bounded by the parent's remaining budget.
- *Cycles* → parent links are immutable and depth is capped.
- *Siblings collude* → they are bounded jointly by the parent.
- *Revoked parent* → checked on every payment.
- *Cost* grows with depth, which is a CPU-budget concern.

**H. Feasibility.** Medium. One new policy contract (Rust) plus tests. The demo is about 3–4 days. OZ allows at most 15 signers per rule, so nodes would sign through one tree-policy signer pattern, or one rule per node.

**I. Differentiation.** New on Stellar, not new in the industry (MetaMask). It is a strong port, not an invention.

**J. Research confidence.** Established engineering.

## C3. Plan-commitment authorization

**A. Thesis.** The user approves an exact plan of payments once, as a Merkle root. The account accepts only payments with a membership proof in that plan.

**B. Problem.** P1 for tasks whose payments can be known in advance.

**C. Why current solutions fall short.** AP2 human-present closed mandates are approved one at a time. Batch commitment on-chain was not found, but it is a simple extension.

**D. Mechanism.**
1. The plan lists `(to, amount, resource hash, nonce)` leaves.
2. The guardian signs the root into a policy.
3. Each transfer carries a proof. Because `transfer` arguments cannot carry a proof, the policy needs a side channel, for example a pre-registration call.

**E. Trust.** Contract; the user's review of the plan.

**F. Enforcement.** Soroban.

**G. Adversarial analysis.** Strong for fixed plans. Useless for data-dependent tasks. The user reviewing a long plan is approval fatigue.

**H. Feasibility.** Medium. Passing proofs through `transfer` is awkward. About 3 days.

**I. Differentiation.** Moderate. It is effectively batched closed mandates.

**J. Research confidence.** Established.

## C4. Delivery-bonded settlement

**A. Thesis.** The merchant posts a bond. The payer can dispute non-delivery, and the merchant answers with a signed delivery receipt over the response hash.

**B. Problem.** P3.

**C. Why current solutions fall short.** **Vellar already implements this on Stellar**: bond escrow, about 89 tests, partially integrated. It proves non-delivery, not content mismatch.

**D. Mechanism.** As in Vellar.

**E. Trust.** Contract; the merchant's delivery key.

**F. Enforcement.** Soroban.

**G. Adversarial analysis.** The merchant delivers garbage with a valid receipt and keeps its bond.

**H. Feasibility.** Medium.

**I. Differentiation.** Low (Vellar).

**J. Research confidence.** Established.

## C5. Verify-then-pay with zkTLS or a TEE

**A. Thesis.** Escrowed payment is released only on a proof that specific bytes came from the merchant's TLS server.

**B. Problem.** P3.

**C. Why current solutions fall short.** TessPay and A402 are papers. No implementation was found in payment settlement paths.

**D. Mechanism.** The merchant response is notarised with TLSNotary (MPC-TLS). The escrow verifies the notary signature and the commitment to the response hash.

**E. Trust.** The notary or TEE vendor; certificate authorities.

**F. Enforcement.** Soroban plus an external notary.

**G. Adversarial analysis.** Proves origin, not usefulness. Notary collusion. TLSNotary says it "should not be used in production".

**H. Feasibility.** Low in this project's time frame (no Soroban verifier). The smallest honest demo is a signed-notary stub, which would understate the trust.

**I. Differentiation.** Medium, but contested by papers.

**J. Research confidence.** Requires heavy integration. The cryptography exists.

## C6. Task-scoped budgets

**A. Thesis.** Payments name a registered task, and each task has its own cap and lifetime.

**B. Problem.** P7.

**C. Why current solutions fall short.** Eunomia's `task_id` is free and its spend is uncapped. REAPP has mandates.

**D. Mechanism.** The task registry lives in the policy. Because the transfer cannot carry a task id, it needs a pre-registration call.

**E. Trust.** Contract; whoever opens tasks (the guardian).

**F. Enforcement.** Soroban.

**G. Adversarial analysis.** The agent books spend against the wrong task, which is bounded per task.

**H. Feasibility.** High.

**I. Differentiation.** Low to moderate.

**J. Research confidence.** Established.

## C7. Account-wide aggregate budget

**A. Thesis.** One budget across all of an account's agent rules.

**B. Problem.** P5 across rules.

**C. Why current solutions fall short.** Absent in OZ, but trivial.

**D. Mechanism.** A shared-state policy keyed by account.

**E. Trust.** Contract.

**F. Enforcement.** Soroban.

**G. Adversarial analysis.** None new.

**H. Feasibility.** High.

**I. Differentiation.** Low.

**J. Research confidence.** Established.

## C8. Guardian-pinned price book on-chain

**A. Thesis.** The policy accepts only amounts in the pinned price list for that merchant.

**B. Problem.** P9 (upcharging).

**C. Why current solutions fall short.** The per-payment maximum is coarser.

**D. Mechanism.** A set of allowed amounts per recipient.

**E. Trust.** The guardian's pinning.

**F. Enforcement.** Soroban.

**G. Adversarial analysis.** An allowed price for the wrong product passes.

**H. Feasibility.** High.

**I. Differentiation.** Low. It is a finer limit.

**J. Research confidence.** Established. It is useful inside C1, where the price book is a trusted source.

## C9. Verifiable decision record

**A. Thesis.** Each payment comes with a case file showing why it was allowed. The file's hash is anchored, and it can be disclosed selectively.

**B. Problem.** P8.

**C. Why current solutions fall short.** Soneso hash-chains its log. Eunomia attests totals.

**D. Mechanism.** Hash the case and emit it in an event or receipt.

**E. Trust.** Whoever writes the record, unless the record is re-executable as in C1.

**F. Enforcement.** None on its own.

**G. Adversarial analysis.** A forged record from a compromised agent.

**H. Feasibility.** High.

**I. Differentiation.** Low alone. High as a by-product of C1, because the C1 case is re-executable.

**J. Research confidence.** Established.

## C10. Agent heartbeat or canary

**A. Thesis.** The agent rule freezes if heartbeats stop.

**B. Problem.** Partial cover for P2.

**C. Why current solutions fall short.** Agent Guard has a dead-man switch.

**D. Mechanism.** A heartbeat policy.

**E. Trust.** The contract.

**F. Enforcement.** Soroban.

**G. Adversarial analysis.** A stolen key also sends heartbeats.

**H. Feasibility.** High.

**I. Differentiation.** None.

**J. Research confidence.** Established.

## C11. Bonded refund SLA

**A. Thesis.** Merchants stake toward an SLA, and refunds are automatic on a provable SLA breach (timeout or no receipt).

**B. Problem.** P3.

**C. Why current solutions fall short.** It is close to Vellar's bond.

**D. Mechanism.** A bond plus a timeout claim.

**E. Trust.** The contract.

**F. Enforcement.** Soroban.

**G. Adversarial analysis.** Garbage that arrives on time.

**H. Feasibility.** Medium.

**I. Differentiation.** Low.

**J. Research confidence.** Established.

## C12. Provenance that survives delegation (C1 × C2)

**A. Thesis.** When an agent delegates to a sub-agent, the sub-agent's results come back carrying their labels, and its own payments are co-signed only if they trace to the root user's signed request.

**B. Problem.** P4 plus P1 in multi-agent systems. Multi-CaMeL (arXiv 2610.05640, 2026-10-05) shows that per-agent CaMeL fails across agent boundaries.

**C. Why current solutions fall short.** Multi-CaMeL is runtime-only and does not cover payments. MetaMask chains carry no provenance.

**D. Mechanism.** The co-signer's case includes the delegation chain and labelled inter-agent messages. A delegation-tree policy (C2) adds attenuation.

**E. Trust.** As C1, at each hop.

**F. Enforcement.** Soroban plus the co-signer.

**G. Adversarial analysis.** Collusion between sub-agents reduces to C1's planner residual. Complexity grows quickly.

**H. Feasibility.** Low for this project.

**I. Differentiation.** High.

**J. Research confidence.** Requires original research.

---

## Scores

Scores run from 1 to 10.

**Weights.** These follow the brief, which weights novelty, importance, credibility and differentiation most heavily:
- Novelty ×2.
- Importance ×2.
- Technical depth (credibility) ×1.5.
- Evidence of differentiation ×2.
- Every other criterion ×1.

**Total.** The weighted sum, normalised to 100.

**Column key** (in table order):
- **Nov**: novelty.
- **Imp**: importance.
- **Depth**: technical depth.
- **Def**: defensibility.
- **Sec**: security benefit.
- **Stellar**: fit with Stellar and Soroban.
- **Feas**: feasibility in this project.
- **Demo**: demonstrability to judges.
- **Product**: standalone product potential.
- **Evid**: evidence for the differentiation claim.

| Candidate | Nov | Imp | Depth | Def | Sec | Stellar | Feas | Demo | Product | Evid | **Total** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C1 Provenance-gated authorization | 7 | 9 | 8 | 6 | 8 | 8 | 7 | 9 | 8 | 7 | **77** |
| C12 Provenance across delegation | 8 | 6 | 9 | 7 | 7 | 6 | 3 | 5 | 7 | 5 | **64** |
| C2 Attenuating sub-delegation | 4 | 6 | 7 | 5 | 6 | 7 | 6 | 8 | 6 | 6 | **60** |
| C3 Plan-commitment authorization | 5 | 7 | 6 | 4 | 7 | 7 | 7 | 7 | 5 | 5 | **59** |
| C5 zkTLS / TEE verify-then-pay | 4 | 8 | 9 | 7 | 6 | 4 | 2 | 3 | 7 | 5 | **57** |
| C9 Verifiable decision record | 4 | 6 | 5 | 4 | 4 | 5 | 7 | 5 | 5 | 4 | **49** |
| C6 Task-scoped budgets | 3 | 6 | 4 | 3 | 5 | 6 | 8 | 6 | 4 | 4 | **47** |
| C8 Guardian-pinned price book | 4 | 5 | 4 | 3 | 5 | 6 | 8 | 6 | 4 | 4 | **47** |
| C4 Delivery-bonded settlement | 2 | 7 | 5 | 3 | 5 | 6 | 6 | 6 | 5 | 3 | **46** |
| C11 Bonded refund SLA | 3 | 6 | 5 | 3 | 5 | 6 | 5 | 5 | 5 | 3 | **45** |
| C7 Account-wide aggregate budget | 2 | 5 | 3 | 2 | 5 | 6 | 8 | 5 | 2 | 3 | **39** |
| C10 Agent heartbeat / canary | 2 | 4 | 3 | 2 | 4 | 6 | 9 | 6 | 2 | 3 | **38** |

Novelty scores were capped wherever a verified implementation exists:
- C4, because Vellar already does it on Stellar.
- C2, because MetaMask does it on EVM.
- C10, because Agent Guard has it.

---

## Category-level directions (Part 5 of the brief)

1. **Intent-to-outcome integrity.**
   - *What can be verified:* that a payment's parameters were derived from the user's signed request, which is C1, and that specific bytes were delivered (C5, with notary trust).
   - *What cannot be verified:* subjective quality or truth. No mechanism here proves it, and we do not claim one does.
   - C1 is the verifiable half of "intent".
2. **Compositional financial authority.** C2 on Stellar, and C12 for provenance across hops. Revocation is solved by checking ancestors on every payment. Collusion is bounded jointly by the parent's budget, not prevented.
3. **Economic outcome verification.** C4, C5 and C11. On Soroban this is credible only as bonds plus timeouts today. Evidence-gated release needs a verifier that does not exist on Soroban yet.
4. **Cross-transaction intent integrity.**
   - Rolling and per-recipient caps already stop splitting within a rule.
   - The request nonce plus single-use budget in C1 binds a set of payments to one signed request, which is a purpose-level aggregate.
   - Detecting that a sequence of individually valid payments defeats a user's purpose, in general, is an open problem and needs judgment we do not claim to have.
5. **Independent verification of agent actions.** C9 becomes meaningful only when the record is re-executable. C1's case file is: anyone can re-run the deterministic check.
6. **New directions found during research.**
   - **(a)** A key that is worthless on its own: split authority between an exposed agent key and a provenance verifier (C1).
   - **(b)** Provenance across agent boundaries (C12; prompted by multi-CaMeL, Oct 2026).
   - **(c)** The guardian's pinned price book as a *trusted data source* rather than a limit (C8 inside C1).
