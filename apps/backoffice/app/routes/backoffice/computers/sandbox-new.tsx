import {
  SANDBOX_IMAGES,
  SANDBOX_INSTANCE_TYPES,
  type SandboxImage,
  type SandboxInstanceType,
} from "@fragno-apps/cf-sandbox-bridge/sandbox/sandbox-container-contract";
import { Button } from "@fragno-private/design-system/button";
import { Checkbox } from "@fragno-private/design-system/checkbox";
import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { TimeUnitField } from "@fragno-private/design-system/unit-fields";
import { useState, type ReactNode } from "react";
import { Form, Link, redirect, useNavigation, useOutletContext } from "react-router";

import type { Route } from "./+types/sandbox-new";
import type { SandboxesLayoutContext } from "./layout-context";
import { sandboxPath, sandboxesPath } from "./paths";
import { DEFAULT_NEW_SANDBOX_VALUES } from "./sandbox-model";
import { requireScopedSandboxRuntime, startSandboxFromForm } from "./sandboxes.server";

const IMAGE_DESCRIPTIONS: Record<SandboxImage, { label: string; description: string }> = {
  workspace: { label: "Workspace", description: "Node.js, Python, git, ripgrep, and jq" },
  debian: { label: "Debian", description: "Debian with Node.js; starts fastest" },
};

const INSTANCE_TYPE_DESCRIPTIONS: Record<SandboxInstanceType, string> = {
  lite: "1/16 vCPU · 256 MiB",
  "standard-1": "1/2 vCPU · 4 GiB",
  "standard-2": "1 vCPU · 6 GiB",
  "standard-3": "2 vCPU · 8 GiB",
  "standard-4": "4 vCPU · 12 GiB",
};

export function meta() {
  return [{ title: "New sandbox" }];
}

export async function action({ request, context }: Route.ActionArgs) {
  const { sandboxRuntime, routeScope } = await requireScopedSandboxRuntime(context);
  const result = await startSandboxFromForm(sandboxRuntime, await request.formData());
  if (!result.ok) {
    return result;
  }
  return redirect(sandboxPath(routeScope, result.sandboxId));
}

export default function BackofficeNewSandbox({ actionData }: Route.ComponentProps) {
  const { routeScope } = useOutletContext<SandboxesLayoutContext>();
  const navigation = useNavigation();
  const values = actionData?.values ?? DEFAULT_NEW_SANDBOX_VALUES;
  const [keepAlive, setKeepAlive] = useState(values.keepAlive);
  const [sleepAfter, setSleepAfter] = useState(values.sleepAfter);
  const [startupTimeoutSeconds, setStartupTimeoutSeconds] = useState(values.startupTimeoutSeconds);

  return (
    <section className="bo-panel-surface w-full max-w-3xl bg-[var(--bo-panel)] p-4">
      <Link
        to={sandboxesPath(routeScope)}
        className="text-xs text-[var(--bo-muted)] hover:text-[var(--bo-fg)]"
      >
        ← Sandboxes
      </Link>
      <h2 className="mt-2 text-xl font-semibold text-[var(--bo-fg)]">New sandbox</h2>

      <Form method="post" className="mt-5 space-y-6">
        <div className="md:w-1/2">
          <Field
            label="Sandbox id"
            description="Leave blank to generate one. An existing id resumes its saved workspace."
          >
            <Input
              name="id"
              defaultValue={values.id}
              placeholder="auto-generated"
              autoComplete="off"
              className="w-full font-mono"
            />
          </Field>
        </div>

        <ChoiceGroup legend="Image" columns="sm:grid-cols-2">
          {SANDBOX_IMAGES.map((image) => (
            <ChoiceCard
              key={image}
              name="image"
              value={image}
              defaultChecked={values.image === image}
              label={IMAGE_DESCRIPTIONS[image].label}
              description={IMAGE_DESCRIPTIONS[image].description}
            />
          ))}
        </ChoiceGroup>

        <ChoiceGroup legend="Size" columns="sm:grid-cols-3 md:grid-cols-5">
          {SANDBOX_INSTANCE_TYPES.map((instanceType) => (
            <ChoiceCard
              key={instanceType}
              name="instanceType"
              value={instanceType}
              defaultChecked={values.instanceType === instanceType}
              label={instanceType}
              description={INSTANCE_TYPE_DESCRIPTIONS[instanceType]}
            />
          ))}
        </ChoiceGroup>

        <details
          // A refused start may come from an advanced field, so keep them visible to fix.
          open={actionData !== undefined}
          className="border-t border-[color:var(--bo-border)] pt-4"
        >
          <summary className="cursor-pointer text-sm font-semibold text-[var(--bo-fg)] select-none">
            Advanced
          </summary>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Field label="Startup command" description="Must succeed before the sandbox is ready.">
              <Input
                name="startupCommand"
                defaultValue={values.startupCommand}
                autoComplete="off"
                className="w-full font-mono"
              />
            </Field>
            <TimeUnitField
              label="Sleep after"
              hint="Saves the workspace and stops the sandbox after this long."
              name="sleepAfter"
              value={keepAlive ? "" : sleepAfter}
              onChange={setSleepAfter}
              disabled={keepAlive}
            />
            <TimeUnitField
              label="Startup timeout"
              hint="How long the startup command may run before the start fails."
              name="startupTimeoutSeconds"
              value={startupTimeoutSeconds}
              onChange={setStartupTimeoutSeconds}
              defaultDisplayUnit="seconds"
            />
            <Checkbox
              name="keepAlive"
              checked={keepAlive}
              onCheckedChange={setKeepAlive}
              description="Run until stopped instead of sleeping."
              className="md:col-span-2"
            >
              <span className="font-semibold text-[var(--bo-fg)]">Keep alive</span>
            </Checkbox>
          </div>
        </details>

        {actionData ? (
          <p role="alert" className="text-sm text-[var(--bo-failed)]">
            {actionData.message}
          </p>
        ) : null}

        <Button variant="accent" type="submit" disabled={navigation.state === "submitting"}>
          {navigation.state === "submitting" ? "Starting…" : "Start sandbox"}
        </Button>
      </Form>
    </section>
  );
}

function ChoiceGroup({
  legend,
  columns,
  children,
}: {
  legend: string;
  columns: string;
  children: ReactNode;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-semibold text-[var(--bo-fg)]">{legend}</legend>
      <div className={`mt-2 grid gap-2 ${columns}`}>{children}</div>
    </fieldset>
  );
}

function ChoiceCard({
  name,
  value,
  defaultChecked,
  label,
  description,
}: {
  name: string;
  value: string;
  defaultChecked: boolean;
  label: string;
  description: string;
}) {
  return (
    <label className="cursor-pointer border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2.5 transition-colors hover:border-[color:var(--bo-border-strong)] has-[:checked]:border-[color:var(--bo-accent)] has-[:checked]:bg-[var(--bo-accent-bg)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--bo-accent)]">
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="sr-only"
      />
      <span className="block text-sm font-semibold text-[var(--bo-fg)]">{label}</span>
      <span className="mt-0.5 block text-xs text-[var(--bo-muted)]">{description}</span>
    </label>
  );
}
