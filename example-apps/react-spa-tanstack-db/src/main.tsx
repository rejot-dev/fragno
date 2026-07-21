import "./index.css";

import { createRoot } from "react-dom/client";

import App from "./App";
import { createDemoRuntime } from "./runtime";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element");
}

const root = createRoot(rootElement);

try {
  const runtime = await createDemoRuntime();
  root.render(<App runtime={runtime} />);

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      void runtime.close();
    });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  root.render(
    <main className="fatal-shell">
      <p className="kicker">Persistence unavailable</p>
      <h1>The local desk could not open.</h1>
      <p>{message}</p>
      <p className="fine-print">
        This example requires a secure browser context with OPFS support. Use localhost or HTTPS.
      </p>
    </main>,
  );
}
