import { Landing } from "./Landing";
import { Shell } from "./Shell";
import { SandboxProvider } from "./store";
import { useRoute } from "./ui";

export default function App() {
  const route = useRoute();
  const m = route.match(/^\/app\/([\w-]+)/);
  // Old in-page anchors (#try, #receipt, …) still land somewhere sensible.
  const legacy: Record<string, string> = { "/try": "wallet", "/receipt": "receipts", "/live": "live", "/how": "how", "/security": "security", "/verified": "proof", "/run": "run" };
  const view = m?.[1] ?? legacy[route.replace(/^#?/, "/").replace(/^\/+/, "/")];
  return <SandboxProvider>{view ? <Shell view={view} /> : <Landing />}</SandboxProvider>;
}
