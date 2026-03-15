import "./app.css";

import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";

import { MetaProvider, Title } from "@solidjs/meta";
import { Router } from "@solidjs/router";

export default function App() {
  return (
    <Router
      root={(props) => (
        <MetaProvider>
          <Title>SolidStart - Chatno</Title>
          <Suspense>{props.children}</Suspense>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
