import "./index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { createLocalDatabase } from "./database";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element");
}

const root = createRoot(rootElement);

try {
  const database = await createLocalDatabase();

  root.render(
    <StrictMode>
      <App database={database} />
    </StrictMode>,
  );

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      void database.dispose();
    });
  }
} catch (error) {
  root.render(<StartupError error={error} />);
}

function StartupError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    <main className="startup-error">
      <p className="eyebrow">Local database unavailable</p>
      <h1>TanStack DB could not open browser SQLite.</h1>
      <p>{message}</p>
      <p>Use a modern browser with OPFS and Web Worker support, then reload the page.</p>
    </main>
  );
}
