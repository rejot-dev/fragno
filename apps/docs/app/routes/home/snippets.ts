export const fragmentSnippet = `import { createStripeFragment } from "@fragno-dev/stripe";
/* These imports are illustrative and application specific */
import { updateEntity } from "@/db/repo";
import { getSession } from "@/lib/auth";

export const stripeFragment = createStripeFragment({
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,

  onStripeCustomerCreated: async (stripeCustomerId, referenceId) => {
    await updateEntity(referenceId, { stripeCustomerId });
  },

  resolveEntityFromRequest: async (context) => {
    const session = getSession(context.headers);

    return {
      referenceId: session.user.id,
      customerEmail: session.user.email,
      stripeCustomerId: session.user.stripeCustomerId || undefined,
      stripeMetadata: {},
    };
  },

  enableAdminRoutes: false,
});`;

export const mountSnippet = `import type { Route } from "./+types/example-fragment";
import { createExampleFragmentInstance } from "@/lib/example-fragment-server";

export async function loader({ request }: Route.LoaderArgs) {
  return await createExampleFragmentInstance().handler(request);
}

export async function action({ request }: Route.ActionArgs) {
  return await createExampleFragmentInstance().handler(request);
}`;

export type ShowcaseTab = {
  id: string;
  label: string;
  color: "primary" | "secondary" | "tertiary";
  headline: string;
  description: string;
  snippets: { label: string; code: string; lang: string }[];
  figCaption: string;
};

export const showcaseTabs: ShowcaseTab[] = [
  {
    id: "pi",
    label: "01_PI_AGENT",
    color: "primary",
    headline: "AI agents with durable sessions",
    description:
      "This is from our backoffice. A Pi agent is defined with a system prompt, a model, " +
      "and tools. The fragment creates durable " +
      "workflow-backed sessions, so agent state survives restarts and tool calls are " +
      "replayed rather than re-executed. The React client gets typed hooks for sessions " +
      "and messages with zero glue code.",
    snippets: [
      {
        label: "Define the agent runtime",
        lang: "ts",
        code: `import { createPi, createPiFragment, defineAgent } from "@fragno-dev/pi-fragment";
import { createWorkflowsFragment } from "@fragno-dev/workflows";

const pi = createPi()
  .agent(
    defineAgent("support-agent", {
      systemPrompt: "You are a helpful support agent.",
      model,
      tools: ["bash"],
    }),
  )
  .tool("bash", async ({ session }) => {
    const fs = await getSessionFs(session.id);
    return createBashTool(fs, session.id);
  })
  .build();

// Fragment = server routes + DB schema + client hooks in one object
const workflowsFragment = createWorkflowsFragment(
  { workflows: pi.workflows, runtime: defaultFragnoRuntime },
  { databaseAdapter: adapter, mountRoute: "/api/workflows" },
);

export const piFragment = createPiFragment(
  pi.config,
  { databaseAdapter: adapter, mountRoute: "/api/pi" },
  { workflows: workflowsFragment.services },
);`,
      },
      {
        label: "Use it from React",
        lang: "ts",
        code: `import { createPiFragmentClient } from "@fragno-dev/pi-fragment/react";

const pi = createPiFragmentClient({ mountRoute: "/api/pi" });

// Typed hooks — derived from the fragment definition
const { data: sessions } = pi.useSessions();
const createSession = pi.useCreateSession();
const sendMessage = pi.useSendMessage();

// Create a session, send a message — the fragment handles the rest
const session = await createSession.mutate({
  body: { agent: "support-agent", title: "Customer issue" },
});

await sendMessage.mutate({
  path: { sessionId: session.id },
  body: { text: "Summarize the bug report and propose next steps." },
});`,
      },
    ],
    figCaption:
      "Fig 02. The Pi agent fragment from the backoffice. Agent definition, tool registry, durable sessions, and typed React hooks — all from one fragment declaration.",
  },
  {
    id: "forms",
    label: "02_FORMS",
    color: "secondary",
    headline: "Forms on a Durable Object with embedded SQLite",
    description:
      "This is how the Fragno docs site runs its own Forms fragment. The fragment carries " +
      "its own database schema, service layer, and HTTP handler. You create it, wrap it " +
      "in a Cloudflare Durable Object, call migrate() in the constructor, and delegate " +
      "fetch().",
    snippets: [
      {
        label: "Create the fragment server",
        lang: "ts",
        code: `import { createFormsFragment } from "@fragno-dev/forms";
import { SqlAdapter } from "@fragno-dev/db/adapters/sql";
import { DurableObjectDialect } from "@fragno-dev/db/dialects/durable-object";
import { CloudflareDurableObjectsDriverConfig } from "@fragno-dev/db/drivers";

export function createFormsServer(init: FormsInit) {
  const adapter = new SqlAdapter({
    dialect: new DurableObjectDialect({ ctx: init.state }),
    driverConfig: new CloudflareDurableObjectsDriverConfig(),
  });

  return createFormsFragment({}, { databaseAdapter: adapter });
}`,
      },
      {
        label: "Durable Object with auto-migration",
        lang: "ts",
        code: `import { DurableObject } from "cloudflare:workers";
import { migrate } from "@fragno-dev/db";
import { createFormsServer } from "./fragno/forms";

export class Forms extends DurableObject<CloudflareEnv> {
  #fragment: ReturnType<typeof createFormsServer>;

  constructor(state: DurableObjectState, env: CloudflareEnv) {
    super(state, env);

    this.#fragment = createFormsServer({ env, state, type: "live" });

    // Schema is ready before the first request
    state.blockConcurrencyWhile(() => migrate(this.#fragment));
  }

  async fetch(request: Request): Promise<Response> {
    return this.#fragment.handler(request);
  }
}`,
      },
      {
        label: "Mount via Hono — one catch-all route",
        lang: "ts",
        code: `import { Hono } from "hono";
export { Forms } from "./forms.do";

const app = new Hono<{ Bindings: CloudflareEnv }>()
  .all("/api/forms/*", (c) => {
    const stub = c.env.FORMS.get(c.env.FORMS.idFromName("default"));
    return stub.fetch(c.req.raw);
  });

export default app;`,
      },
    ],
    figCaption:
      "Fig 02. The Forms fragment running on a Cloudflare Durable Object. Schema, migration, and HTTP handler live inside the fragment — the DO just delegates.",
  },
  {
    id: "telegram",
    label: "03_TELEGRAM",
    color: "tertiary",
    headline: "Telegram bots with typed commands and replies",
    description:
      "This is the Telegram integration pattern we use in Fragno apps. You define commands " +
      "with scopes and typed handlers, then let the fragment process incoming webhooks and " +
      "persist chats/messages. Handlers can reply through the Telegram API wrapper without " +
      "building custom routing glue.",
    snippets: [
      {
        label: "Define commands in the fragment config",
        lang: "ts",
        code: `import {
  createTelegram,
  createTelegramFragment,
  defineCommand,
} from "@fragno-dev/telegram-fragment";

const telegramConfig = createTelegram({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecretToken: process.env.TELEGRAM_WEBHOOK_SECRET!,
  botUsername: "my_bot",
})
  .command(
    defineCommand("ping", {
      description: "Health check command",
      scopes: ["private", "group", "supergroup"],
      handler: async ({ api, chat }) => {
        await api.sendMessage({ chat_id: chat.id, text: "pong" });
      },
    }),
  )
  .command(
    defineCommand("status", {
      description: "Show service status",
      scopes: ["private"],
      handler: async ({ api, chat }) => {
        await api.sendMessage({ chat_id: chat.id, text: "All systems operational." });
      },
    }),
  )
  .build();

export const telegramFragment = createTelegramFragment(telegramConfig, {
  databaseAdapter: adapter,
  mountRoute: "/api/telegram",
});`,
      },
    ],
    figCaption: "Fig. Telegram fragment setup with command definitions and message reply handlers.",
  },
];

export const dataLayerTabs: ShowcaseTab[] = [
  {
    id: "occ",
    label: "01_OCC",
    color: "primary",
    headline: "Two-phase optimistic concurrency control",
    description:
      "Instead of interactive transactions that hold locks, Fragno uses a retrieve → mutate " +
      "pattern. Services read first, then schedule mutations. The .check() call pins version " +
      "numbers — on conflict the entire transaction retries automatically with exponential backoff.",
    snippets: [
      {
        label: "Service: soft-delete with version check and hook",
        lang: "ts",
        code: `markFileDeleted({ provider, fileKey }: FileByKeyInput) {
  return this.serviceTx(uploadSchema)
    .retrieve((uow) =>
      uow.findFirst("file", (b) =>
        b.whereIndex("idx_file_provider_key", (eb) =>
          eb.and(
            eb("provider", "=", provider),
            eb("key", "=", fileKey),
          )),
      ),
    )
    .mutate(({ uow, retrieveResult: [file] }) => {
      if (!file) throw new Error("FILE_NOT_FOUND");
      if (file.status === "deleted") return file;

      // .check() pins the row version — retries on conflict
      uow.update("file", file.id, (b) =>
        b.set({ status: "deleted", updatedAt: uow.now(), deletedAt: uow.now() }).check(),
      );
      // Persisted in the same transaction. See Durable Hooks tab
      uow.triggerHook("onFileDeleted", { ...buildFileHookPayload(file) });

      return { ...file, status: "deleted" };
    })
    .build();
}`,
      },
      {
        label: "Handler executes the service transaction",
        lang: "ts",
        code: `handler: async function ({ input }, { json }) {
  const data = await input.valid();
  await this.handlerTx()
    .withServiceCalls(() => [
      services.markFileDeleted({ provider: data.provider, fileKey: data.key }),
    ])
    .execute();
  return json({ ok: true });
}`,
      },
    ],
    figCaption:
      "Fig. Upload fragment: the service defines OCC logic with a hook trigger, the route handler executes it.",
  },
  {
    id: "durable-hooks",
    label: "02_DURABLE_HOOKS",
    color: "secondary",
    headline: "Transactional side effects with at-least-once delivery",
    description:
      "Hook triggers are written to the database in the same transaction as your mutations. " +
      "After commit, a background dispatcher executes them with retry and backoff. " +
      "Hooks can schedule future execution with processAt, and can themselves " +
      "run full OCC transactions via handlerTx.",
    snippets: [
      {
        label: "Define hooks on the OTP fragment",
        lang: "ts",
        code: `.provideHooks<OtpHooksMap>(({ defineHook, config }) => ({
  onOtpIssued: defineHook(async function (payload) {
    await config.hooks?.onOtpIssued?.(payload, this.idempotencyKey);
  }),
  expireOtp: defineHook(async function ({ otpId }) {
    // Hooks can run their own OCC transactions
    await this.handlerTx()
      .retrieve(({ forSchema }) =>
        forSchema(otpSchema).findFirst("otp", (b) =>
          b.whereIndex("idx_otp_id_status_expiresAt", (eb) =>
            eb.and(
              eb("id", "=", otpId), eb("status", "=", "pending"),
              eb("expiresAt", "<=", eb.now()),
            )),
        ),
      )
      .mutate(({ forSchema, retrieveResult: [otp] }) => {
        if (!otp) return;
        const uow = forSchema(otpSchema);
        uow.update("otp", otp.id, (b) =>
          b.set({ status: "expired", expiredAt: uow.now() }).check(),
        );
        uow.triggerHook("onOtpExpired", { ...otp, expiredAt: uow.now() });
      })
      .execute();
  }),
}))`,
      },
      {
        label: "Schedule hooks from a mutation",
        lang: "ts",
        code: `.mutate(({ uow }) => {
  const expiresAt = uow.now().plus({ minutes: expiryMinutes });
  const otpId = uow.create("otp", {
    externalId, type, code, status: "pending", expiresAt,
  });

  // Fires after the transaction commits
  uow.triggerHook("onOtpIssued", { id: otpId.valueOf(), code, expiresAt });

  // Scheduled: runs when the OTP expires
  uow.triggerHook("expireOtp", { otpId: otpId.valueOf() }, { processAt: expiresAt });

  return { id: otpId.valueOf(), code };
})`,
      },
    ],
    figCaption:
      "Fig. OTP fragment: hooks define side effects, mutations schedule them — including future-dated expiry.",
  },
  {
    id: "schema",
    label: "03_SCHEMA",
    color: "tertiary",
    headline: "Versioned, dialect-agnostic table definitions",
    description:
      "Fragment authors declare their data model in a single fluent builder. " +
      "Schemas are versioned so migrations are deterministic across environments.",
    snippets: [
      {
        label: "Comment schema with self-referencing parent",
        lang: "ts",
        code: `import { column, idColumn, referenceColumn, schema } from "@fragno-dev/db/schema";

export const commentSchema = schema("comment", (s) => {
  return s
    .addTable("comment", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("title", column("string"))
        .addColumn("content", column("string"))
        .addColumn("createdAt", column("timestamp").defaultTo((b) => b.now()))
        .addColumn("postReference", column("string"))
        .addColumn("parentId", referenceColumn().nullable())
        .createIndex("idx_comment_post", ["postReference"]);
    })
    .addTable("upvote_total", (t) => {
      return t
        .addColumn("id", idColumn())
        .addColumn("reference", column("string"))
        .addColumn("total", column("integer").defaultTo(0))
        .createIndex("idx_upvote_total_reference", ["reference"], { unique: true });
    })
    .addReference("parent", {
      type: "one",
      from: { table: "comment", column: "parentId" },
      to: { table: "comment", column: "id" },
    });
});`,
      },
    ],
    figCaption:
      "Fig. Two tables with a self-referencing foreign key — column types, defaults, indexes, and relations in one builder.",
  },
];
