import type { Route } from "./+types/home";
import { WelcomeShell, WelcomeHero, WelcomeExperiments } from "../welcome/welcome";
import { createChatnoClient } from "@rejot-dev/chatno";
// import { useStore } from "@rejot-dev/fragno/client/react";

export function meta(_: Route.MetaArgs) {
  return [
    { title: "Fragno • Experimental" },
    { name: "description", content: "A beautiful experimental page for the Fragno library." },
  ];
}

const chatnoClient = createChatnoClient({});

export default function Home() {
  // const { data: aiConfig, loading: aiConfigLoading } = useStore(
  //   chatnoClient.useAiConfig.store,
  // );
  // const { data: helloWorld } = useStore(chatnoClient.useHelloWorld.store);
  // const { data: thing } = useStore(chatnoClient.useThing.store);

  // useEffect(() => {
  //   chatnoClient.useAiConfig.query().then((result) => {
  //     console.log("aiConfig", result);
  //   });
  // }, []);

  // const { data: aiConfig, loading: aiConfigLoading } = useStore(
  //   chatnoClient.useAiConfig.store,
  // );

  chatnoClient.useEcho
    .query({
      pathParams: {
        message: "asd",
      },
      queryParams: {
        capital: "true",
      },
    })
    .then((result) => {
      console.log("xecho", result);
    });

  // const echoStore = chatnoClient.useEcho.store({
  //   pathParams: {
  //     message: "asd"
  //   },
  //   queryParams: {
  //     capital: "true"
  //   }
  // });

  // const { data: echo, loading: echoLoading } = useStore(echoStore);
  // console.log("echo store", {
  //   echo,
  //   echoLoading,
  // });

  chatnoClient.useThing
    .query({
      pathParams: {
        path: "asd",
      },
    })
    .then((result) => {
      console.log("xthing", result);
    });

  const aiConfigLoading = true;
  const aiConfig = undefined;
  const helloWorld = undefined;
  const thing = undefined;

  return (
    <WelcomeShell>
      <WelcomeHero />

      <section className="mx-auto max-w-5xl px-6 pb-16">
        <h2 className="mb-4 text-xl font-semibold">Live data</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl border border-gray-200 bg-white/60 p-4 dark:border-gray-800 dark:bg-gray-900/60">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">AI Config</h3>
            <div className="mt-2">
              {aiConfigLoading ? (
                <p className="text-sm text-gray-600 dark:text-gray-300">Loading…</p>
              ) : (
                <pre className="max-h-60 overflow-auto rounded bg-gray-50 p-3 text-xs dark:bg-gray-950">
                  {JSON.stringify(aiConfig, null, 2)}
                </pre>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white/60 p-4 dark:border-gray-800 dark:bg-gray-900/60">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Hello World</h3>
            <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">
              {helloWorld === undefined ? "—" : String(helloWorld)}
            </p>
          </div>

          <div className="rounded-2xl border border-gray-200 bg-white/60 p-4 dark:border-gray-800 dark:bg-gray-900/60">
            <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">Thing</h3>
            <pre className="mt-2 max-h-60 overflow-auto rounded bg-gray-50 p-3 text-xs dark:bg-gray-950">
              {JSON.stringify(thing, null, 2)}
            </pre>
          </div>
        </div>
      </section>

      <WelcomeExperiments />
    </WelcomeShell>
  );
}
