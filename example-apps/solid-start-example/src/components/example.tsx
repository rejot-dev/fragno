import { createExampleFragmentClient } from "@fragno-dev/example-fragment/solid";
import { createSignal, createResource, Show, Suspense } from "solid-js";

const { useData, useSampleMutator } = createExampleFragmentClient();

export function Example() {
  const [refreshKey, setRefreshKey] = createSignal(0);

  const { data, loading, error } = useData({
    query: {
      name: () => refreshKey().toString(),
    },
  });

  const [testData] = createResource(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return "Solid Resource";
  });

  const { mutate, error: mutateError, loading: mutateLoading } = useSampleMutator();

  const handleMutate = async (message: string) => {
    await mutate({ body: { message } });
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <div class="space-y-6 rounded-lg bg-white p-6 shadow">
      <div>
        Cannot use Suspend in Solid with Fragno hooks at the moment. Both of these signals should
        resolve at the same time:
        <Suspense fallback={<div>Loading...</div>}>
          <div class="flex flex-row space-x-2">
            <span class="text-green-500">1: {testData()}</span>
            <span class="text-blue-500">2: {data()}</span>
          </div>
        </Suspense>
      </div>

      <Show when={loading()}>
        <div class="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <p class="text-sm text-gray-600">Loading fragment data...</p>
        </div>
      </Show>

      <Show when={error()}>
        <div class="rounded-lg border border-red-200 bg-red-50 p-4">
          <p class="text-sm text-red-700">Error loading fragment data: {error()?.message}</p>
        </div>
      </Show>

      <Show when={data()}>
        <div class="rounded-lg border border-green-200 bg-green-50 p-4">
          <p class="mb-2 text-xs font-medium uppercase tracking-wide text-green-700">
            Example Fragment Data
          </p>
          <div class="text-green-900">{data()}</div>
        </div>
      </Show>

      <Show when={mutateError()}>
        <div class="rounded-lg border border-red-200 bg-red-50 p-4">
          <p class="text-sm text-red-700">Error mutating fragment data: {mutateError()?.message}</p>
        </div>
      </Show>
      <button
        class="w-full rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => handleMutate("1")}
        disabled={mutateLoading()}
      >
        Trigger Error
      </button>

      <button
        class="w-full rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => handleMutate((data() || "") + "!")}
        disabled={mutateLoading()}
      >
        Change data
      </button>
    </div>
  );
}
