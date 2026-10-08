import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;
import "./styles.css";
const React = await import("react");
const ReactDOM = await import("react-dom/client");
const { PolicyComposer } = await import("./PolicyComposer");
const { AgentChat } = await import("./AgentChat");
const which = new URLSearchParams(location.search).get("v");
function App() {
  if (which === "composer")
    return (
      <main style={{ maxWidth: 760, margin: "24px auto", padding: "0 16px" }}>
        <section className="card">
          <div className="step">2</div>
          <div className="body">
          <h2>Authorize an agent</h2>
          <PolicyComposer
            config={{ allowlistPolicy: "CA2PF5YGJZCI7JD2NVWROQ7TBHWVEE2P6MX5IYUQUMAYBM6LAWPZJ2FG", allowlistPolicyVersion: "0.3", agentAddress: null, recipients: [] }}
            disabled={false}
            run={() => {}}
            onGranted={() => {}}
          />
          </div>
        </section>
      </main>
    );
  return (
    <main style={{ maxWidth: 760, margin: "24px auto", padding: "0 16px" }}>
      <section className="card">
        <div className="step">AI</div>
        <div className="body">
          <h2>Talk to your agent</h2>
          <p className="muted">
            Ask in plain words. The agent compares the merchants and offers you choices. Nothing is paid until you tap one, and
            the smart account still checks every payment against the allowance above.
          </p>
          <AgentChat enabled />
        </div>
      </section>
    </main>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
