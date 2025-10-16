import { Title } from "@solidjs/meta";
import { createSignal, Show } from "solid-js";
import { Chat } from "~/components/chat";
import { Example } from "~/components/example";

export default function Home() {
  const [showExample, setShowExample] = createSignal(true);

  return (
    <main class="min-h-screen bg-gray-50 p-8">
      <Title>Solid Start + Fragno</Title>

      <div class="mx-auto max-w-3xl space-y-4">
        <h1 class="mb-8 text-center text-3xl font-bold text-gray-900">Solid Start + Fragno</h1>
        <div class="flex items-center space-x-2">
          <input
            class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
            type="checkbox"
            name="show-example"
            checked={showExample()}
            onChange={() => setShowExample(!showExample())}
          />
          <label for="show-example" class="text-gray-700">
            Show Example Fragment
          </label>
        </div>
        <Show when={showExample()}>
          <Example />
        </Show>
        <Chat />
      </div>
    </main>
  );
}
