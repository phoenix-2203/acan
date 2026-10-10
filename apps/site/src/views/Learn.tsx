import { hostedCosigner } from "../sandbox";
import { useMemo } from "react";
import { ASSETS } from "@acan/core/browser";
import { AccountView } from "../AccountView";
import { DEPLOYMENT, REPO_URL } from "../deployment";
import { Icon, Tx } from "../ui";
import { PrivateReplay } from "./PrivateReplay";

export function ProvenanceLearn() {
  return (
    <div className="prose stack">
      <section className="ap-card">
        <h3>The problem limits can't solve</h3>
        <p>
          Spending limits and allowlists stop an agent paying the wrong address or too much. They cannot tell whether a payment to an
          <em> allowed</em> shop, for an <em>allowed</em> amount, is one you wanted. If a web page, a shop's catalog or a tool tells the
          agent to buy the expensive dataset instead of the report you asked for, every limit passes. At least one competing agent wallet documents
          this gap itself, and ACAN's own limits had it too.
        </p>
      </section>
      <section className="ap-card">
        <h3>What ACAN does</h3>
        <ol className="numbered">
          <li>
            <b>You sign the request.</b> What you asked for (the task, the item, the most you allow) is signed by a key on your device,
            so the agent's host cannot forge it.
          </li>
          <li>
            <b>A planner writes a plan without seeing any fetched content.</b> It sees your words and the catalog you pinned. Web pages,
            shop text and tool output only enter as data while the plan runs (the CaMeL pattern from Google DeepMind's research).
          </li>
          <li>
            <b>Every value carries where it came from.</b> Values from your request or your pinned catalog are trusted. Anything read
            from a page or tool is labelled untrusted, and so is everything computed from it: through arithmetic, text, lookups and
            if-branches.
          </li>
          <li>
            <b>A co-signer with no AI re-runs the plan.</b> It decodes the exact Stellar authorization itself and signs only if the
            recipient, the amount and the decision to pay all trace back to you, and the payment fits your request's budget.
          </li>
          <li>
            <b>The smart account requires both signatures.</b> The agent's rule lists the agent and the co-signer, with OpenZeppelin's
            weighted-threshold policy (deployed unchanged). The agent's key alone is refused on-chain, and every other limit still
            applies.
          </li>
          <li>
            <b>Agents can hire agents, and authority only narrows.</b> Your agent can hand part of your request to a sub-agent with a
            signed sub-mandate, which can hand part of its share on. Each hand-off can only narrow (same item, smaller budget, shorter life),
            every payment counts against every budget back up to you, and cancelling one link stops everything below it. Sub-agents never
            get a key on your account.
          </li>
          <li>
            <b>Anything else comes to you.</b> A payment that does not trace back is held, with the reason in plain words, for you to
            approve once with your passkey or deny.
          </li>
        </ol>
      </section>
      <section className="ap-card">
        <h3>What it guarantees, and what it doesn't</h3>
        <div className="two-col">
          <div>
            <p className="label">Guaranteed</p>
            <ul className="ticks">
              <li><Icon name="check" size={16} /> Injected text cannot choose, steer or size a co-signed payment</li>
              <li><Icon name="check" size={16} /> A stolen agent key cannot pay anything on its own</li>
              <li><Icon name="check" size={16} /> A stolen co-signer key cannot pay anything on its own</li>
              <li><Icon name="check" size={16} /> The co-signature fits one exact transfer under one rule</li>
              <li><Icon name="check" size={16} /> Every decision can be re-run from its inputs</li>
            </ul>
          </div>
          <div>
            <p className="label">Not claimed</p>
            <ul className="ticks muted">
              <li>That a planner given only your words writes the plan you meant</li>
              <li>That you are not persuaded by something you read</li>
              <li>That a purchased result is good: only where the payment came from</li>
              <li>The chain checks that the co-signer signed, not what it checked</li>
              <li>
                {hostedCosigner()
                  ? "In this demo your device key lives in this browser; the co-signer runs on ACAN's server, apart from the agent's key"
                  : "In this demo, the co-signer and your device key live in this browser"}
              </li>
            </ul>
          </div>
        </div>
      </section>
      <section className="ap-card">
        <h3>Tested, adversarially</h3>
        <p className="muted">
          Steered choices, values laundered through arithmetic, text and lookups, hidden if-branches, forged and replayed requests,
          authorizations that don't match the plan, and a signer-count bypass (two agent keys standing in for the co-signer) found in
          our own review and closed with weights. The co-signer's real signatures are checked by OpenZeppelin's own authorization code
          in the Soroban test host. See <a href={`${REPO_URL}/tree/master/research`} target="_blank" rel="noreferrer">research/</a>.
        </p>
        <a className="button small" href="#/app/autopilot">Try it in Autopilot</a>
      </section>
    </div>
  );
}

export function HowLearn() {
  const cards = [
    ["The allowance", "The guardian's passkey adds a context rule to their OpenZeppelin smart account. It covers token transfers only and names the agent's Ed25519 key, plus the provenance co-signer when the gate is on. It carries policies: OpenZeppelin's spending limit (rolling window), ACAN's merchant budget policy (allowed shops, a cap per shop, payments per period, largest single payment) and, with the gate, OpenZeppelin's weighted threshold. The rule can expire on its own."],
    ["Paying over x402", "The agent calls a paid API, gets HTTP 402, and signs the smart account's authorization for that one transfer. The merchant's facilitator submits it, and the account runs every policy before any money moves. The merchant releases the response only after settlement."],
    ["Private tabs", "With ACAN's acan-tab scheme, each request is paid with a signed voucher: no transaction and no fee. Tabs settle in batches by confidential transfer, amounts hidden on-chain. The vault is topped up only through the same capped rule, and the guardian's auditor key decrypts everything."],
    ["Guardian in the loop", "When the account refuses something, or the co-signer holds it, the guardian sees why. The exact authorization is decoded, and the guardian can approve that one payment with a passkey; the agent's allowance is untouched."],
    ["Provenance gate", "The co-signer re-runs the agent's plan and signs only what traces back to the user's signed request and pinned catalog. The account needs both signatures."],
    ["Any agent", "The same guarded wallet works from the AI chat, from scripts, and from any MCP client through ACAN's MCP server (five tools: list merchants, check budget, buy, request approval, settle tabs)."],
  ];
  return (
    <div className="card-grid">
      {cards.map(([t, b], i) => (
        <section key={t} className="ap-card">
          <span className="mono muted">0{i + 1}</span>
          <h3>{t}</h3>
          <p className="muted">{b}</p>
        </section>
      ))}
    </div>
  );
}

export function SecurityLearn() {
  return (
    <div className="ap-card">
      <p className="muted">
            Each row is covered by a test in the repository (<code>packages/core/test/attacks.test.ts</code>,{" "}
            <code>apps/agent/test/wallet.test.ts</code>) or by an on-chain policy.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Attack</th>
                  <th>ACAN's defence</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Prompt injection steers the agent to pay an attacker</td>
                  <td>Allowed recipients, caps and expiry are enforced by the smart account. The model cannot reach them.</td>
                </tr>
                <tr>
                  <td>Injected content steers the agent to the wrong item at an allowed shop, inside every limit</td>
                  <td>Provenance gate: the co-signer signs only payments that trace back to the user's request, and the account needs its signature.</td>
                </tr>
                <tr>
                  <td>Malicious server swaps the payment address (dynamic payTo)</td>
                  <td>The agent pins each merchant's address and refuses to sign. The on-chain allowlist refuses it too.</td>
                </tr>
                <tr>
                  <td>
                    Payment for one resource reused for another of the same price{" "}
                    <a href="https://arxiv.org/abs/2605.30998" target="_blank" rel="noreferrer">
                      [1]
                    </a>
                  </td>
                  <td>Vouchers are signed for one URL, and the merchant refuses them anywhere else.</td>
                </tr>
                <tr>
                  <td>
                    Concurrent copies of one payment run the paid handler many times{" "}
                    <a href="https://arxiv.org/abs/2605.30998" target="_blank" rel="noreferrer">
                      [1]
                    </a>
                  </td>
                  <td>An atomic in-flight lock per payment. In our test, stock middleware ran the handler several times for one payment; with ACAN it runs once.</td>
                </tr>
                <tr>
                  <td>
                    Replay and lost responses across the HTTP–chain boundary{" "}
                    <a href="https://arxiv.org/abs/2605.11781" target="_blank" rel="noreferrer">
                      [2]
                    </a>
                  </td>
                  <td>
                    x402 <code>payment-identifier</code> plus a stored response. A retry is replayed, never charged twice or refused.
                    A reused identifier with a different payment gets 409.
                  </td>
                </tr>
                <tr>
                  <td>
                    Paid content leaking through shared caches{" "}
                    <a href="https://arxiv.org/abs/2605.11781" target="_blank" rel="noreferrer">
                      [2]
                    </a>
                  </td>
                  <td>Paid responses are <code>Cache-Control: private</code> (asserted in tests).</td>
                </tr>
                <tr>
                  <td>Delivering before settlement (free riding)</td>
                  <td>The response is buffered and released only after settlement succeeds. A failed settlement returns 402 with no data.</td>
                </tr>
                <tr>
                  <td>Allowance overdraft with dynamic pricing</td>
                  <td>
                    ACAN does not use open-ended authorizations. Tabs have a credit limit, and every top-up passes the on-chain
                    limit.
                  </td>
                </tr>
                <tr>
                  <td>Sybil merchants gaming discovery</td>
                  <td>The agent only buys from merchants the guardian listed, and the allowlist enforces it on-chain.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="muted small">
            [1] Free-Riding in the AI Economy: Demystifying Logic Flaws in x402-Enabled Payment Systems (arXiv 2605.30998). [2] Five
            Attacks on x402 (arXiv 2605.11781).
          </p>
    </div>
  );
}

export function ProofLearn() {
  return (
    <div className="stack">
    <div className="ap-card">
      <p className="muted">Runs of the full stack (AI agent, x402 merchants, guardian dashboard), with their transactions on Stellar testnet.</p>
      <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>What happened</th>
                  <th>Proof</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Provenance gate: Autopilot's “buy the cheapest ledger report” co-signed and paid; the injected Tidewire task held, and the agent's key alone refused by the smart account (#3213)</td>
                  <td>
                    <Tx hash="c73563358346d9464145afe3e416cdf2a76ab0aea2dfb36ee792d9d922ff0e5a" /> (the co-signed payment)
                  </td>
                </tr>
                <tr>
                  <td>Provenance gate for any AI client (MCP / CLI) on ACAN's USDC account: a guardian-signed task, the matching purchase co-signed and paid; a pricier merchant and an uncovered item refused by the co-signer; the agent's key alone refused by the smart account (#3213)</td>
                  <td>
                    <Tx hash="35cf78c654596891cba2df9936e404c2d0302eba421298b875720d3eb743290f" /> (<code>npm run demo:gate</code>)
                  </td>
                </tr>
                <tr>
                  <td>AI agent (Groq) compares two x402 merchants and buys each item from the cheaper one</td>
                  <td>
                    <Tx hash="4110196d891558c3fd6f64fb17cc81598e14c2075b751f3ee8a8ce080fe253ce" />{" "}
                    <Tx hash="d3d376f710a1a068d67693e1f74c795b797ea849937ebfd0c03ba4bbda7c8d62" />
                  </td>
                </tr>
                <tr>
                  <td>Allowance used up: the 6th payment is refused by the smart account (SpendingLimitExceeded)</td>
                  <td><Tx hash="505d1ca29d4c1427e20782a700dca548e4f0a6c90ce7312ba1269d92104378f4" /> (one of five that settled)</td>
                </tr>
                <tr>
                  <td>Over-limit purchase blocked, then approved once with the guardian's passkey; the allowance is unchanged</td>
                  <td><Tx hash="faf52259371a1f83487594e95a95d742073ab9ef7875908e4d9d631c37750b1d" /></td>
                </tr>
                <tr>
                  <td>Private mode: 7 paid requests, no per-request transactions, 3 confidential settlements (amounts hidden)</td>
                  <td>
                    <Tx hash="0f466ad20ddbaca87ccb7c953f0d74648c4ea32525a151307a18af9d3a96c7ec" />{" "}
                    <Tx hash="57924ba11591129f8cb3389a6d5eb538d1fa1cdbecd8d7e85a516afb2415ba96" />{" "}
                    <Tx hash="70b5dec854e3cf715041fa791fdcb2fae066ae7ea6a17ca9e1b7e8a1ad507014" />
                  </td>
                </tr>
                <tr>
                  <td>AI agent, private mode, two merchants: the guardian's audit matches each merchant's ledger</td>
                  <td>
                    <Tx hash="05ffdfc9824827bc371ad4379bb71aa4ca9f1554c2a6c38b7407d8d1689b5b4e" />{" "}
                    <Tx hash="02e6c2634346ebea5d7655022234f0439bd8aa6dc3189488272f2e49894b654d" />{" "}
                    <Tx hash="178e535825a1ab2c0f52ce3aa00c3e88b302c1c3cb4950114b782f7cf1761d7b" />
                  </td>
                </tr>
                <tr>
                  <td>Task budget: the agent asks for 0.03 USDC for 10 minutes, the guardian approves with a passkey, and the agent buys within it</td>
                  <td>
                    <Tx hash="00047ab14c4407b5555820975480b64d55851a0a939d7c0e33b0dfed3c20d0cc" />{" "}
                    <Tx hash="5e39e04507370bccd8382807135a7fb91b6e0e8e429df861ac4e0e65a5eb8748" />
                  </td>
                </tr>
                <tr>
                  <td>Unused private-vault funds returned to the guardian's smart account</td>
                  <td><Tx hash="ab1795bba99be1ae69c8fe3f7545dc5b35d2839a2f77feae3b8dfd4f0c152970" /></td>
                </tr>
                <tr>
                  <td>Paying a merchant beyond its own cap is refused even though the overall allowance has room (RecipientCapExceeded)</td>
                  <td>
                    <code>npm run demo:caps</code>
                  </td>
                </tr>
                <tr>
                  <td>Paying an address that is not on the allowlist is refused during authorization (RecipientNotAllowed)</td>
                  <td>
                    <code>npm run demo:allowlist</code>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
    </div>
    <LiveAccount />
    </div>
  );
}

export function RunLearn() {
  return (
    <div className="ap-card">
      <p className="muted">
        The sandbox shows the on-chain guard rails. The repository adds the rest: x402 merchants, the AI agent (Groq, Claude or Ollama),
        private tabs, guardian approvals, the dashboard and the MCP server. The README has the full steps.
      </p>
      <pre>
        <code>{`git clone ${REPO_URL}
cd acan && npm install
npm run setup          # testnet accounts for merchant, facilitator, treasury (.env)
npm run web            # dashboard: create the passkey smart account, authorize the agent
npm run merchant       # x402 merchant A   (and: npm run merchant:b)
npm run guardian       # approvals + audit service
npm run agent:ai       # the AI agent shops within its allowance
npm run mcp            # or: let any MCP client (Claude Desktop, Cursor) shop with it`}</code>
      </pre>
    </div>
  );
}

export function PrivacyLearn() {
  const steps: [string, string, string][] = [
    ["Top-up from the smart account, through the agent's capped rule", "3544896310c5f3600ddc3b086e25b0c8d09e086242e1d5c44d560f2a7870dd4a", "0.10 USDC (a fixed-size chunk)"],
    ["Deposit into the confidential balance", "17229ad5e96a4015c7d5c6fa486e1999e6f06ff4115885ddccfdd935e7754193", "0.10 USDC"],
    ["Settlement after requests 1–3", "0f466ad20ddbaca87ccb7c953f0d74648c4ea32525a151307a18af9d3a96c7ec", "vault → merchant, amount hidden"],
    ["Settlement after requests 4–6", "57924ba11591129f8cb3389a6d5eb538d1fa1cdbecd8d7e85a516afb2415ba96", "vault → merchant, amount hidden"],
    ["Tab closed after request 7", "70b5dec854e3cf715041fa791fdcb2fae066ae7ea6a17ca9e1b7e8a1ad507014", "vault → merchant, amount hidden"],
  ];
  return (
    <div className="stack">
      <PrivateReplay />
      <div className="card-grid">
        <section className="ap-card">
          <span className="mono muted">01</span>
          <h3>A voucher per request, not a transaction</h3>
          <p className="muted">
            In private mode the agent pays each request with a signed voucher. Vouchers are chained (each one states the running total), so the
            merchant always holds one signed statement of the debt. No transaction, no fee, nothing on-chain per request.
          </p>
        </section>
        <section className="ap-card">
          <span className="mono muted">02</span>
          <h3>Settled in confidential transfers</h3>
          <p className="muted">
            When the tab reaches its credit limit, the agent pays it in one confidential transfer. Balances are commitments and every transfer
            carries a zero-knowledge proof that is verified on-chain. The public sees “vault → merchant”, not how much.
          </p>
        </section>
        <section className="ap-card">
          <span className="mono muted">03</span>
          <h3>Still inside your limits, and you can audit it</h3>
          <p className="muted">
            The private vault can only be filled through the agent's capped rule, so privacy does not loosen your allowance. Every transfer
            also carries ciphertexts for your auditor key: you see exactly what was spent; the public does not.
          </p>
        </section>
      </div>
      <section className="ap-card">
        <h3>Run on Stellar testnet: 7 paid requests, 0 per-request transactions, 3 confidential settlements</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Transaction</th>
                <th>What the public sees</th>
              </tr>
            </thead>
            <tbody>
              {steps.map(([what, hash, seen]) => (
                <tr key={hash}>
                  <td>{what}</td>
                  <td>
                    <Tx hash={hash} />
                  </td>
                  <td>{seen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="label" style={{ marginTop: 16 }}>
          What the guardian sees (decrypted with the auditor key)
        </p>
        <pre>
          <code>{`transfer agent-vault → merchant  0.03 USDC   vault balance after: 0.07 USDC
transfer agent-vault → merchant  0.03 USDC   vault balance after: 0.04 USDC
transfer agent-vault → merchant  0.01 USDC   vault balance after: 0.03 USDC`}</code>
        </pre>
        <p className="muted small">
          Private mode runs from the full stack (<code>npm run agent:private</code>, then <code>npm run audit</code>), because the zero-knowledge
          proofs are made on the agent's machine; it is not part of this browser sandbox. What it does not hide: who pays whom, and the
          top-ups into the vault. The confidential token is built on an unaudited OpenZeppelin preview; testnet only.
        </p>
      </section>
    </div>
  );
}

export function LiveAccount() {
  const names = useMemo(() => {
    const n: Record<string, string> = { [DEPLOYMENT.agent]: "Agent" };
    for (const m of DEPLOYMENT.merchants) n[m.address] = m.name;
    if (DEPLOYMENT.agentVault) n[DEPLOYMENT.agentVault] = "Agent's private vault";
    return n;
  }, []);
  return (
    <section className="ap-card">
      <h3>ACAN's own wallet, live</h3>
      <p className="muted">
        The wallet behind the runs above: a passkey smart account whose rule #{DEPLOYMENT.agentRuleId} is the command-line AI agent's USDC
        allowance, with the merchant budget policy attached. It is read from testnet now; nothing here is staged.
      </p>
      <AccountView
        account={DEPLOYMENT.smartAccount}
        token={ASSETS.usdc.sac}
        tokenLabel="USDC"
        names={names}
        merchantPolicy={DEPLOYMENT.merchantPolicy}
        focusRule={DEPLOYMENT.agentRuleId}
        historyLedgers={120_000}
      />
    </section>
  );
}
