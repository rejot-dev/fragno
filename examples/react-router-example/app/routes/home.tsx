import type { Route } from "./+types/home";
import { Welcome } from "../welcome/welcome";
import { createChatnoClient } from "@rejot-dev/chatno";
import { useStore } from "@nanostores/react";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

const chatnoClient = createChatnoClient({});

export default function Home() {
  const { data, loading } = useStore(chatnoClient.useAiConfig.store);

  console.log({
    data,
    loading,
  });

  return (
    <div>
      <Welcome />
      <div style={{ marginTop: "2rem", padding: "1rem", border: "1px solid #ccc" }}>
        <h2>AI Configuration</h2>
        {loading ? <p>Loading...</p> : <p>AI Model: {data?.model}</p>}
      </div>
    </div>
  );
}
