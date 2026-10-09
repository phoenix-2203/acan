import { DEPLOYMENT, REPO_URL } from "./deployment";
import { MERCHANTS } from "./merchants";
import { Icon, Tx, VIEWS } from "./ui";

const FEATURES = [
  {
    tag: "New",
    title: "A tricked agent can't pay, even inside its limits.",
    body:
      "Limits stop the wrong shop. They can't stop a manipulated agent buying the wrong thing from the right shop. ACAN's provenance gate can: every payment needs a second signature from a co-signer with no AI in it. It re-runs the agent's plan and signs only if who gets paid, how much, and the decision to pay all trace back to your own request. The agent's key alone is refused by the smart account.",
    go: "autopilot",
    cta: "Watch it refuse an injection",
    icon: "trace",
  },
  {
    tag: "On-chain",
    title: "The AI said yes. The wallet said no.",
    body:
      "The agent's allowance lives in your OpenZeppelin smart account on Stellar: allowed shops, a cap per shop, a largest single payment, a rolling limit and an expiry. Policy contracts check every payment. You grant, approve once and revoke with a passkey.",
    go: "wallet",
    cta: "Give an agent an allowance",
    icon: "wallet",
  },
  {
    tag: "Payments",
    title: "x402 straight from the smart account, or private.",
    body:
      "The agent pays any x402 merchant in USDC under its rule. In private mode it pays with signed vouchers and settles in confidential transfers whose amounts are hidden on-chain; your auditor key reads them.",
    go: "how",
    cta: "How payments work",
    icon: "layers",
  },
  {
    tag: "Audit",
    title: "Receipts anyone can check.",
    body: "After a task the agent signs a receipt of what it paid and what was blocked. Anyone can verify the signature and every payment against the chain.",
    go: "receipts",
    cta: "Check a receipt",
    icon: "receipt",
  },
  {
    tag: "Agents",
    title: "Works with any MCP client.",
    body: "Claude Desktop, Cursor or your own agent can shop through ACAN's MCP server, inside the same guarded wallet.",
    go: "run",
    cta: "Run it yourself",
    icon: "bot",
  },
];

const PROOF = [
  { what: "x402 payment in USDC from the smart account", hash: "4394246d34c0d491671d9c76ba78f8785c0c377054d62f6038ce0456a13aaf6a" },
  { what: "Allowance used up: the next payment refused on-chain", hash: "505d1ca29d4c1427e20782a700dca548e4f0a6c90ce7312ba1269d92104378f4" },
  { what: "Blocked payment approved once with a passkey", hash: "faf52259371a1f83487594e95a95d742073ab9ef7875908e4d9d631c37750b1d" },
  { what: "Private mode: confidential settlement, amount hidden", hash: "0f466ad20ddbaca87ccb7c953f0d74648c4ea32525a151307a18af9d3a96c7ec" },
];

export function Landing() {
  const groups = ["Try", "Learn"] as const;
  return (
    <div className="landing">
      <header className="topbar">
        <a className="wordmark" href="#/">
          ACAN
        </a>
        <div className="topbar-right">
          <span className="net">
            <i /> Stellar testnet · live
          </span>
          <a className="button small" href="#/app/autopilot">
            Launch app <Icon name="arrow" size={16} />
          </a>
        </div>
      </header>

      <section className="hero-grid">
        <div className="hero-copy rise">
          <p className="eyebrow">Authorization for AI-agent payments</p>
          <h1>
            AI agents don't get your money. They get <em>spending authority.</em>
          </h1>
          <p className="lede">
            ACAN puts an agent's limits inside your Stellar smart account, approved with your passkey and checked by policy
            contracts on every payment. And now a payment the agent was tricked into making is refused too, even when it is
            within every limit.
          </p>
          <div className="cta">
            <a className="button" href="#/app/autopilot">
              Launch app
            </a>
            <a className="button secondary" href="#/app/provenance">
              What's new: the provenance gate
            </a>
          </div>
          <dl className="spec">
            <dt>Enforced</dt>
            <dd>Soroban policies on an OpenZeppelin smart account</dd>
            <dt>Controlled</dt>
            <dd>Passkey to grant, approve once, or revoke</dd>
            <dt>Traced</dt>
            <dd>Every payment co-signed only if it traces back to you</dd>
            <dt>Paid over</dt>
            <dd>x402 in USDC · private mode with hidden amounts</dd>
          </dl>
        </div>

        <div className="launcher rise delay">
          {groups.map((g) => (
            <div key={g}>
              <div className="launcher-head">
                <span>{g}</span>
                <span className="mono muted">{VIEWS.filter((v) => v.group === g).length}</span>
              </div>
              <div className="tiles">
                {VIEWS.filter((v) => v.group === g).map((v) => (
                  <a key={v.id} className={`tile ${v.isNew ? "featured" : ""}`} href={`#/app/${v.id}`}>
                    <span className="tile-icon">
                      <Icon name={v.icon} />
                    </span>
                    <b>
                      {v.title}
                      {v.isNew && <span className="new">New</span>}
                    </b>
                    <span>{v.blurb}</span>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="features">
        <p className="eyebrow">What ACAN does</p>
        <div className="feature-list">
          {FEATURES.map((f, i) => (
            <article key={f.title} className={`feature ${i === 0 ? "lead" : ""}`}>
              <div className="feature-meta">
                <span className="mono muted">0{i + 1}</span>
                <span className={`chip ${i === 0 ? "chip-new" : ""}`}>{f.tag}</span>
              </div>
              <h2>{f.title}</h2>
              <p>{f.body}</p>
              {i === 0 && <TraceDiagram />}
              <a className="more" href={`#/app/${f.go}`}>
                {f.cta} <Icon name="arrow" size={16} />
              </a>
            </article>
          ))}
        </div>
      </section>

      <section className="merchants-strip">
        <p className="eyebrow">The demo's shops: what an agent pays for</p>
        <div className="merchant-row">
          {MERCHANTS.map((m) => (
            <div key={m.address} className="merchant">
              <span className="mono-badge" style={{ background: `hsl(${m.hue} 32% 88%)`, color: `hsl(${m.hue} 45% 26%)` }}>
                {m.name.split(" ").map((w) => w[0]).join("")}
              </span>
              <span>
                <b>{m.name}</b>
                <span className="muted small">{m.kind}</span>
              </span>
            </div>
          ))}
        </div>
        <p className="muted small">Invented names. Testnet payments only; nothing is delivered.</p>
      </section>

      <section className="proof-strip">
        <p className="eyebrow">Proof, not promises: transactions on Stellar testnet</p>
        <div className="proof-row">
          {PROOF.map((p) => (
            <div key={p.hash} className="proof">
              <Icon name="check" size={16} />
              <span>{p.what}</span>
              <Tx hash={p.hash} />
            </div>
          ))}
        </div>
        <a className="more" href="#/app/proof">
          All evidence <Icon name="arrow" size={16} />
        </a>
      </section>

      <footer className="landing-foot">
        <span className="mono">
          Rule #{DEPLOYMENT.agentRuleId} · ACAN's own agent · USDC on testnet
        </span>
        <span>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Source
          </a>{" "}
          · MIT · Stellar “Find Your Way” hackathon
        </span>
      </footer>
    </div>
  );
}

/** Request → plan → co-signer → smart account, drawn as a ledger of hops. */
function TraceDiagram() {
  const hops = [
    { k: "You", v: "“Buy the cheapest ledger report”", s: "signed on your device" },
    { k: "Planner", v: "writes a plan", s: "never sees fetched content" },
    { k: "Co-signer", v: "re-runs the plan, traces every value", s: "no AI · signs or refuses" },
    { k: "Smart account", v: "needs agent + co-signer", s: "plus every limit" },
  ];
  return (
    <ol className="trace">
      {hops.map((h, i) => (
        <li key={h.k} style={{ animationDelay: `${0.15 + i * 0.12}s` }}>
          <span className="trace-k">{h.k}</span>
          <span className="trace-v">{h.v}</span>
          <span className="trace-s muted">{h.s}</span>
        </li>
      ))}
    </ol>
  );
}
