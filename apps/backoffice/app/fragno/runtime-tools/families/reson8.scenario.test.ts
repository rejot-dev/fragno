import { expect, test, vi, assert } from "vitest";

const workers = vi.hoisted(() => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("cloudflare:workers", () => workers);

import { createBackofficeServiceExecution } from "@/backoffice-runtime/context";
import type { InMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";
import { BackofficeKernel } from "@/backoffice-runtime/kernel";
import type { LocalBackofficeObjects } from "@/backoffice-runtime/local-object-factory";
import { defineBackofficeScenario, runBackofficeScenario } from "@/fragno/automation/scenario";
import { usageBillingForScope } from "@/fragno/billing/usage-billing";
import { createReson8Server } from "@/fragno/reson8";
import { createInteractiveBashHost } from "@/fragno/runtime-tools/automation-host";
import { createCodemodeRouteBackedRuntimeContext } from "@/fragno/runtime-tools/route-backed-runtime-context";

import { InMemoryApiObject } from "../../../../workers/api.do";
import { InMemoryAuthObject } from "../../../../workers/auth.do";
import { InMemoryAutomationsObject } from "../../../../workers/automations.do";
import { InMemoryBillingObject } from "../../../../workers/billing.do";
import { InMemoryCodemodeObject } from "../../../../workers/codemode.do";
import { InMemoryFormsObject } from "../../../../workers/forms.do";
import { InMemoryUploadObject } from "../../../../workers/upload.do";
import { createReson8Runtime } from "./reson8-runtime";

const scenarioObjects = {
  AUTH: (input) => new InMemoryAuthObject({ ...input, database: input.getAuthDatabase() }),
  AUTOMATIONS: (input) => new InMemoryAutomationsObject(input),
  BILLING: (input) => new InMemoryBillingObject(input),
  UPLOAD: (input) => new InMemoryUploadObject(input),
  CODEMODE: (input) => new InMemoryCodemodeObject(input),
  API: (input) => new InMemoryApiObject(input),
  FORMS: (input) => new InMemoryFormsObject(input),
} satisfies LocalBackofficeObjects;

const orgId = "org-1";
const scope = { kind: "org", orgId } as const;
const platformApiKey = "platform-reson8-key";
// The provider must receive the file's bytes unchanged; their content does not matter.
const recording = "raw pcm samples";

/** Reson8's token and prerecorded endpoints, recording what each request carried. */
function createReson8Provider() {
  const requests: {
    endpoint: string;
    authorization: string | null;
    bytes: number[];
    query: object;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const endpoint = `${request.method} ${url.origin}${url.pathname}`;
    requests.push({
      endpoint,
      authorization: request.headers.get("authorization"),
      bytes: [...new Uint8Array(await request.arrayBuffer())],
      query: Object.fromEntries(url.searchParams),
    });
    if (endpoint === "POST https://api.reson8.dev/v1/auth/token") {
      return Response.json({
        access_token: "realtime-token",
        token_type: "Bearer",
        expires_in: 60,
      });
    }
    assert(endpoint === "POST https://api.reson8.dev/v1/speech-to-text/prerecorded");
    return Response.json({ text: "Hello from Reson8", start_ms: 0, duration_ms: 1500 });
  };
  return { requests, fetch };
}

async function terminal(runtime: InMemoryBackofficeRuntime, reson8Fetch: typeof fetch) {
  const services = { ...runtime.services, reson8: createReson8Server(platformApiKey, reson8Fetch) };
  const { bash } = await createInteractiveBashHost({
    context: createCodemodeRouteBackedRuntimeContext({
      emitter: { kind: "caller" },
      runtime: services,
      kernel: new BackofficeKernel(services),
      execution: createBackofficeServiceExecution({
        scope,
        service: { type: "automation", id: "transcriber" },
      }),
    }),
  });
  return bash;
}

test("an organization is billed for prerecorded transcription but not for realtime tokens", async () => {
  const provider = createReson8Provider();
  const period = new Date().toISOString().slice(0, 7);
  await runBackofficeScenario(
    defineBackofficeScenario({
      name: "Reson8 prerecorded transcription",
      objects: scenarioObjects,
      setup: ({ given }) => [
        given.organization.exists({ id: orgId }),
        given.codemode.writeFile({ orgId, path: "/workspace/voice.raw", content: recording }),
      ],
      steps: ({ then }) => [
        then.assert("the terminal prints the transcript", async ({ runtime }) => {
          const bash = await terminal(runtime, provider.fetch);
          const result = await bash.exec(
            "reson8.prerecorded.transcribe --input voice.raw --encoding pcm_s16le --sample-rate 16000 --channels 1",
            { cwd: "/workspace" },
          );
          assert(result.stderr === "");
          expect(result).toMatchObject({ exitCode: 0, stdout: "Hello from Reson8\n" });
          expect(provider.requests).toEqual([
            {
              endpoint: "POST https://api.reson8.dev/v1/speech-to-text/prerecorded",
              authorization: `ApiKey ${platformApiKey}`,
              bytes: [...new TextEncoder().encode(recording)],
              query: { encoding: "pcm_s16le", sample_rate: "16000", channels: "1" },
            },
          ]);
        }),
        then.assert("a realtime token is minted under the platform key", async ({ runtime }) => {
          const bash = await terminal(runtime, provider.fetch);
          const result = await bash.exec("reson8.realtime.token --format json");
          assert(result.exitCode === 0, result.stderr);
          expect(JSON.parse(result.stdout)).toEqual({
            accessToken: "realtime-token",
            expiresIn: 60,
            url: "wss://api.reson8.dev/v1/speech-to-text/realtime",
          });
          expect(provider.requests.at(-1)).toMatchObject({
            endpoint: "POST https://api.reson8.dev/v1/auth/token",
            authorization: `ApiKey ${platformApiKey}`,
          });
        }),
        // The token is unmetered, so only the transcription counts.
        then.billing.tracker({
          scope,
          period,
          meter: "transcription.audio",
          quantity: "1500",
          eventCount: "1",
        }),
        then.billing.tracker({
          scope,
          period,
          meter: "transcription.requests",
          quantity: "1",
          eventCount: "1",
        }),
        then.assert(
          "personal transcription belongs to the user, not an organization",
          async ({ runtime }) => {
            const owner = { kind: "user", userId: "transcriber" } as const;
            const personal = createReson8Runtime({
              reson8: createReson8Server(platformApiKey, provider.fetch),
              scope: owner,
              billing: usageBillingForScope(runtime.services, owner),
              nowEpochMs: () => Date.now(),
            });
            const transcription = await personal.transcribePrerecorded({
              audio: new TextEncoder().encode(recording),
              query: {},
            });
            assert.equal(transcription.text, "Hello from Reson8");
            const statement = await runtime.objects.billing
              .for(owner)
              .commands.getStatement({ period });
            expect(statement.trackers).toContainEqual(
              expect.objectContaining({
                meter: "transcription.audio",
                quantity: "1500",
                eventCount: "1",
              }),
            );
            expect(
              (await runtime.objects.billing.forOrg(orgId).commands.getStatement({ period }))
                .trackers,
            ).toContainEqual(
              expect.objectContaining({
                meter: "transcription.requests",
                quantity: "1",
                eventCount: "1",
              }),
            );
          },
        ),
      ],
    }),
  );
});
