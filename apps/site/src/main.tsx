import { Buffer } from "buffer";
(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;

import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

// Load the app only after Buffer exists (stellar-sdk reads it at import time).
const { default: App } = await import("./App");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
