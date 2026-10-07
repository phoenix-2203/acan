import { useMemo } from "react";
import { ASSETS } from "@acan/core/browser";
import { AccountView } from "./AccountView";
import { explorer } from "./chain";
import { DEPLOYMENT, REPO_URL } from "./deployment";
import { SandboxSection } from "./SandboxSection";

const tx = (hash: string) => (
  <a className="mono" href={explorer("tx", hash)} target="_blank" rel="noreferrer">
    {hash.slice(0, 8)}…
  </a>
);

export default function App() {
  const liveNames = useMemo(() => {
    const n: Record<string, string> = { [DEPLOYMENT.agent]: "Agent" };
    for (const m of DEPLOYMENT.merchants) n[m.address] = m.name;
    if (DEPLOYMENT.agentVault) n[DEPLOYMENT.agentVault] = "Agent's private vault";
    return n;
  }, []);

  return (
    <>
      <header className="nav">
        <a className="wordmark" href="#top">
          ACAN
        </a>
        <nav>
          <a href="#try">Try it</a>
          <a href="#live">Live</a>
          <a href="#how">How it works</a>
          <a href="#security">Security</a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </header>

      <main id="top">
        <section className="hero">
          <p className="eyebrow">Agent payments on Stellar · x402 · passkeys</p>
          <h1>Give an AI agent a budget it can't exceed.</h1>
          <p className="lede">
            ACAN puts an agent's spending limits inside your Stellar smart account. You approve them with a passkey. The agent pays
            merchants over x402 with its own key, and the account itself refuses anything over budget, to a shop you didn't
            allow, or after the deadline. A prompt injection can't talk its way past a contract.
          </p>
          <div className="cta">
            <a className="button" href="#try">
              Try it in your browser
            </a>
            <a className="button secondary" href={REPO_URL} target="_blank" rel="noreferrer">
              Read the code
            </a>
          </div>
          <ul className="facts">
            <li>
              <b>Enforced on-chain.</b> Spending limit, allowed shops, per-shop caps and expiry are policy contracts checked on every
              payment.
            </li>
            <li>
              <b>Passkey in, passkey out.</b> Granting and revoking take one Face ID or fingerprint approval. The agent never holds
              your keys.
            </li>
            <li>
              <b>Private when it matters.</b> In private mode the agent pays with signed vouchers. It settles in confidential
              transfers whose amounts are hidden on-chain, and only you can audit them.
            </li>
          </ul>
        </section>

        <section className="why">
          <h2>Why this matters</h2>
          <p>
            In May 2026 an attacker hid an instruction in a social-media reply, written in Morse code. An AI agent with wallet access
            decoded it and sent roughly $150,000–200,000 in tokens to the attacker. No key was stolen and no contract was exploited.
            The agent simply had the authority to do it (
            <a href="https://dev.to/sagaratalatti/what-the-grok-wallet-drain-teaches-us-about-ai-agent-permissions-3mpf" target="_blank" rel="noreferrer">
              analysis
            </a>
            ,{" "}
            <a href="https://oecd.ai/en/incidents/2026-05-04-4a73" target="_blank" rel="noreferrer">
              OECD incident record
            </a>
            ). Content filters will always lag behind new tricks. The fix is limits the model cannot reach: value caps, allowed
            destinations and expiry, checked by something other than the model.
          </p>
          <p>
            That is what ACAN does with OpenZeppelin smart accounts on Stellar. The agent proposes a payment, deterministic policy
            contracts decide, and the account executes only what the guardian allowed.
          </p>
        </section>

        <section id="try" className="panel">
          <h2>Try it: two minutes, testnet, no install</h2>
          <p className="muted">
            Everything below runs in your browser against Stellar testnet. The refusals you will see are real contract errors, not
            checks in this page.
          </p>
          <SandboxSection />
        </section>

        <section id="live" className="panel">
          <h2>Live: ACAN's own deployment</h2>
          <p className="muted">
            The guardian account used in our demo video and README, read from testnet right now. Rule #{DEPLOYMENT.agentRuleId}{" "}
            is the AI agent's allowance. It pays in USDC, with the merchant {DEPLOYMENT.merchantPolicy?.version === "0.1" ? "allowlist" : "budget"}{" "}
            policy attached.
          </p>
          <AccountView
            account={DEPLOYMENT.smartAccount}
            token={ASSETS.usdc.sac}
            tokenLabel="USDC"
            names={liveNames}
            merchantPolicy={DEPLOYMENT.merchantPolicy}
            focusRule={DEPLOYMENT.agentRuleId}
          />
        </section>

        <section id="verified" className="panel">
          <h2>Verified on testnet</h2>
          <p className="muted">Runs of the full stack (AI agent, x402 merchants, guardian dashboard), with their transactions.</p>
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
                  <td>AI agent (Groq) compares two x402 merchants and buys each item from the cheaper one</td>
                  <td>
                    {tx("4110196d891558c3fd6f64fb17cc81598e14c2075b751f3ee8a8ce080fe253ce")}{" "}
                    {tx("d3d376f710a1a068d67693e1f74c795b797ea849937ebfd0c03ba4bbda7c8d62")}
                  </td>
                </tr>
                <tr>
                  <td>Allowance used up: the 6th payment is refused by the smart account (SpendingLimitExceeded)</td>
                  <td>{tx("505d1ca29d4c1427e20782a700dca548e4f0a6c90ce7312ba1269d92104378f4")} (one of five that settled)</td>
                </tr>
                <tr>
                  <td>Over-limit purchase blocked, then approved once with the guardian's passkey; the allowance is unchanged</td>
                  <td>{tx("faf52259371a1f83487594e95a95d742073ab9ef7875908e4d9d631c37750b1d")}</td>
                </tr>
                <tr>
                  <td>Private mode: 7 paid requests, no per-request transactions, 3 confidential settlements (amounts hidden)</td>
                  <td>
                    {tx("0f466ad20ddbaca87ccb7c953f0d74648c4ea32525a151307a18af9d3a96c7ec")}{" "}
                    {tx("57924ba11591129f8cb3389a6d5eb538d1fa1cdbecd8d7e85a516afb2415ba96")}{" "}
                    {tx("70b5dec854e3cf715041fa791fdcb2fae066ae7ea6a17ca9e1b7e8a1ad507014")}
                  </td>
                </tr>
                <tr>
                  <td>AI agent, private mode, two merchants: the guardian's audit matches each merchant's ledger</td>
                  <td>
                    {tx("05ffdfc9824827bc371ad4379bb71aa4ca9f1554c2a6c38b7407d8d1689b5b4e")}{" "}
                    {tx("02e6c2634346ebea5d7655022234f0439bd8aa6dc3189488272f2e49894b654d")}{" "}
                    {tx("178e535825a1ab2c0f52ce3aa00c3e88b302c1c3cb4950114b782f7cf1761d7b")}
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
        </section>

        <section id="how" className="panel">
          <h2>How it works</h2>
          <div className="how">
            <div>
              <h3>1 · The allowance</h3>
              <p>
                The guardian's passkey adds a <em>context rule</em> to their OpenZeppelin smart account. It covers USDC transfers
                only, its single signer is the agent's Ed25519 key, and it carries policies: OpenZeppelin's spending limit
                (rolling window) and ACAN's merchant budget policy (allowed shops, per-shop caps, payments per period). The
                rule can expire on its own (<code>valid_until</code>).
              </p>
            </div>
            <div>
              <h3>2 · Paying over x402</h3>
              <p>
                The agent calls a paid API, gets HTTP 402, and signs the smart account's authorization for that one transfer. The
                merchant's facilitator submits it, and the account runs every policy before any money moves. Any standard x402
                Stellar merchant can be paid this way.
              </p>
            </div>
            <div>
              <h3>3 · Private tabs</h3>
              <p>
                With ACAN's <code>acan-tab</code> scheme, each request is paid with a signed voucher: no transaction and no fee.
                The tab is settled in batches by confidential transfer (zero-knowledge proofs, amounts hidden). The vault is
                topped up only through the same capped rule, and the guardian's auditor key decrypts everything.
              </p>
            </div>
            <div>
              <h3>4 · Guardian in the loop</h3>
              <p>
                When the allowance refuses something essential, the agent asks. The dashboard decodes the exact authorization,
                and the guardian signs that one payment with their passkey. Agents can also request a time-boxed task budget,
                which becomes a temporary rule.
              </p>
            </div>
          </div>
        </section>

        <section id="security" className="panel">
          <h2>Security: checked against published attacks on x402</h2>
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
        </section>

        <section id="run" className="panel">
          <h2>Run the full stack</h2>
          <p className="muted">
            The sandbox shows the on-chain guard rails. The repository adds the rest: x402 merchants, the AI agent (Groq, Claude or
            Ollama), private tabs, guardian approvals and the dashboard.
          </p>
          <pre>
            <code>{`git clone ${REPO_URL}
cd acan && npm install
npm run setup          # testnet accounts, USDC, smart account
npm run merchant       # x402 merchant A   (and: npm run merchant:b)
npm run guardian       # approvals + audit service
npm run web            # guardian dashboard (passkey)
npm run agent:ai       # the AI agent shops within its allowance`}</code>
          </pre>
        </section>
      </main>

      <footer className="foot">
        <span>ACAN · built for Stellar's “Find Your Way” hackathon · MIT licensed · testnet only</span>
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          github.com/phoenix-2203/acan
        </a>
      </footer>
    </>
  );
}
