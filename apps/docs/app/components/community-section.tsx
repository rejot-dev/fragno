import { Form, useActionData, useNavigation } from "react-router";
import { MessageCircleMore, Mail } from "lucide-react";
import { Turnstile } from "@marsidev/react-turnstile";

type ActionData = {
  success?: boolean;
  message?: string;
};

export function CommunitySection({ turnstileSitekey }: { turnstileSitekey: string }) {
  const actionData = useActionData() as ActionData | undefined;
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <section className="w-full max-w-5xl space-y-8">
      <div className="space-y-4 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Join the Community</h2>
        <p className="text-fd-muted-foreground mx-auto max-w-prose text-lg">
          Connect with other developers and stay updated with the latest news
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <a
          href="https://discord.gg/jdXZxyGCnC"
          target="_blank"
          rel="noopener noreferrer"
          className="group relative overflow-hidden rounded-2xl bg-white/90 p-8 shadow-sm ring-1 ring-black/5 transition-all hover:-translate-y-1 hover:shadow-xl dark:bg-slate-950/60 dark:ring-white/10"
        >
          <span className="absolute inset-x-6 -top-16 h-28 rounded-full bg-blue-600/10 opacity-0 blur-3xl transition-opacity group-hover:opacity-80 dark:bg-blue-600/15" />
          <div className="relative">
            <div className="mb-4 flex items-center gap-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600/10 dark:bg-blue-600/20">
                <MessageCircleMore className="size-6 text-blue-600 dark:text-blue-400" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Discord</h3>
                <p className="text-fd-muted-foreground text-sm">Join the conversation</p>
              </div>
            </div>
            <p className="text-fd-muted-foreground mb-4 text-sm">
              Connect with the community, get help with your projects, and stay updated on the
              latest features and releases.
            </p>
            <span className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 transition-all group-hover:gap-2 dark:text-blue-400">
              Join Discord
              <span className="transition-transform group-hover:translate-x-0.5">→</span>
            </span>
          </div>
        </a>

        <div className="group relative overflow-hidden rounded-2xl bg-white/90 p-8 shadow-sm ring-1 ring-black/5 dark:bg-slate-950/60 dark:ring-white/10">
          <div className="relative">
            <div className="mb-4 flex items-center gap-4">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-600/10 dark:bg-blue-600/20">
                <Mail className="size-6 text-blue-600 dark:text-blue-400" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Newsletter</h3>
                <p className="text-fd-muted-foreground text-sm">Get email updates</p>
              </div>
            </div>
            <p className="text-fd-muted-foreground mb-4 text-sm">
              Receive notifications about new features, releases, and important announcements.
            </p>
            <Form method="post" className="flex flex-col gap-2">
              <div className="flex gap-2">
                <input
                  type="email"
                  name="email"
                  placeholder="your@email.com"
                  required
                  disabled={isSubmitting}
                  className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-600 focus:outline-none focus:ring-1 focus:ring-blue-600 disabled:opacity-50 dark:border-gray-600 dark:bg-slate-800/50 dark:text-white dark:placeholder:text-gray-400"
                />
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {isSubmitting ? "..." : "Subscribe"}
                </button>
              </div>
              {actionData?.message && (
                <p
                  className={`text-sm ${
                    actionData.success
                      ? "text-green-600 dark:text-green-400"
                      : "text-red-600 dark:text-red-400"
                  }`}
                >
                  {actionData.message}
                </p>
              )}
              <Turnstile siteKey={turnstileSitekey} options={{ appearance: "interaction-only" }} />
            </Form>
          </div>
        </div>
      </div>
    </section>
  );
}
