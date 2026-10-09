import { useEffect, useState } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import { signRequest, usdcToStroops } from "@acan/core/browser";
import { fetchTasks, postTask, type TaskToSign } from "./guardian";

const KEY = "acan-device-key";

/** This browser's request key: it signs tasks for the provenance co-signer. */
function deviceKey(): Keypair {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return Keypair.fromSecret(s);
    const k = Keypair.random();
    localStorage.setItem(KEY, k.secret());
    return k;
  } catch {
    return Keypair.random();
  }
}

/**
 * Tasks an agent on a provenance-gated rule asks you to sign. What you sign is
 * what the co-signer will let it pay for: this item (and merchant), at the
 * pinned price, up to this total.
 */
export function TasksPanel({ account }: { account?: string }) {
  const [tasks, setTasks] = useState<TaskToSign[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [device] = useState(deviceKey);

  useEffect(() => {
    let on = true;
    const tick = async () => on && setTasks(await fetchTasks().catch(() => []));
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, []);

  const sign = async (t: TaskToSign) => {
    setError(null);
    try {
      if (!account || t.account !== account) throw new Error("This task is for another smart account");
      const fields: Record<string, string> = { product: t.product, maxAmount: usdcToStroops(t.maxUsdc).toString() };
      if (t.merchant) fields.merchant = t.merchant;
      const signed = signRequest(device, { account, nonce: t.id, issuedAt: Math.floor(Date.now() / 1000), ttlSeconds: 3600, task: t.task, fields });
      await postTask(t.id, { signed });
      setTasks(await fetchTasks());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const pending = tasks.filter((t) => t.status === "pending");
  return (
    <div>
      <p className="muted small">
        This browser's request key: <code>{device.publicKey()}</code>. Put it in <code>.env</code> as <code>COSIGNER_DEVICE_KEYS</code> so the
        co-signer accepts what you sign here.
      </p>
      {pending.length === 0 && <p className="muted small">No tasks waiting. An agent on a gated rule asks here before it buys.</p>}
      {pending.map((t) => (
        <div key={t.id} className="request">
          <p>
            <b>“{t.task}”</b>
          </p>
          <p className="small">
            Item <code>{t.product}</code>
            {t.merchant ? <> at <code>{t.merchant}</code></> : " at the cheapest pinned merchant"} · up to <b>{t.maxUsdc} USDC</b> in total
          </p>
          <div className="row">
            <button onClick={() => void sign(t)}>Sign this task</button>
            <button className="secondary" onClick={() => void postTask(t.id, "reject").then(async () => setTasks(await fetchTasks()))}>
              Reject
            </button>
          </div>
        </div>
      ))}
      {tasks
        .filter((t) => t.status !== "pending")
        .slice(0, 5)
        .map((t) => (
          <p key={t.id} className="small muted">
            {t.status}: “{t.task}” ({t.maxUsdc} USDC)
          </p>
        ))}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
