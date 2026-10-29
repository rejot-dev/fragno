import { useState } from "react";

import { Button } from "../button";
import { Checkbox } from "../checkbox";
import { Icon } from "../icon";
import { RadioCards } from "../radio-cards";
import { LandingSection } from "./landing-section";

const PERMISSIONS = [
  { value: "organization.get", description: "Read the organization's name and members" },
  { value: "projects.provision", description: "Create a project for each set of books" },
  { value: "events.fire", description: "Tell your automations when an entry is posted" },
] as const;

const ACTIONS = ["entries.post", "documents.propose", "reports.trial-balance"] as const;

type Access = "workspace" | "projects";

/** Shows an app's install screen: the owner reviews what the app may do before it gets anything. */
export function LandingAppsPlatform() {
  const [granted, setGranted] = useState<ReadonlySet<string>>(
    new Set(PERMISSIONS.map((permission) => permission.value)),
  );
  const [access, setAccess] = useState<Access>("projects");

  return (
    <LandingSection
      id="landing-apps-platform"
      title="Build apps on Backoffice."
      visual={
        <div className="grid gap-px border border-[color:var(--bo-border)] bg-[var(--bo-border)] lg:grid-cols-[0.45fr_0.55fr]">
          <div className="flex flex-col justify-between gap-8 bg-[var(--bo-panel-2)] p-6 sm:p-8">
            <ol className="space-y-5">
              <AppStep icon="log-in" title="People sign in with Backoffice">
                No second account. The app gets who they are and which organizations they belong to.
              </AppStep>
              <AppStep icon="check-square" title="Owners install it for their organization">
                They approve each permission and choose which projects the app can reach.
              </AppStep>
              <AppStep icon="message-circle" title="Agents can use what the app does">
                Its actions become tools in Backoffice, within the access the owner approved.
              </AppStep>
            </ol>
            <p className="text-xs leading-5 text-[var(--bo-muted)]">
              Bookkeeping, our accounting app, is built this way.
            </p>
          </div>

          <form
            className="bg-[var(--bo-panel)] p-6 sm:p-8"
            onSubmit={(event) => {
              event.preventDefault();
            }}
          >
            <h3 className="text-xl font-semibold tracking-[-0.02em]">Install Bookkeeping</h3>
            <p className="mt-1 text-sm text-[var(--bo-muted)]">
              For <span className="font-semibold text-[var(--bo-fg)]">Harbor Booking</span> · signed
              in as ada@harbor.test
            </p>

            <fieldset className="mt-6 space-y-2">
              <legend className="mb-2 text-sm font-semibold">It may</legend>
              {PERMISSIONS.map((permission) => (
                <Checkbox
                  key={permission.value}
                  checked={granted.has(permission.value)}
                  description={permission.description}
                  onCheckedChange={() => {
                    setGranted((current) => {
                      const next = new Set(current);
                      if (!next.delete(permission.value)) {
                        next.add(permission.value);
                      }
                      return next;
                    });
                  }}
                >
                  <span className="font-mono text-xs">{permission.value}</span>
                </Checkbox>
              ))}
            </fieldset>

            <div className="mt-6">
              <p className="mb-2 text-sm font-semibold">Actions it adds for agents</p>
              <p className="flex flex-wrap gap-1.5">
                {ACTIONS.map((action) => (
                  <code
                    key={action}
                    className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-2 py-1 font-mono text-[11px]"
                  >
                    {action}
                  </code>
                ))}
              </p>
            </div>

            <div className="mt-6">
              <RadioCards
                label="What it can reach"
                name="landing-app-access"
                value={access}
                onValueChange={setAccess}
                options={[
                  {
                    value: "workspace",
                    label: "The whole organization",
                    description: "Every project in Harbor Booking.",
                  },
                  {
                    value: "projects",
                    label: "Selected projects",
                    description: "Only Billing.",
                  },
                ]}
              />
            </div>

            <div className="mt-6 flex gap-2">
              <Button variant="accent" type="submit">
                Install
              </Button>
              <Button variant="secondary">Cancel</Button>
            </div>
          </form>
        </div>
      }
    >
      Build your own product on Backoffice&rsquo;s accounts, organizations, and permissions. People
      sign in with Backoffice, owners decide what your app may do, and your app&rsquo;s actions
      become tools their agents can use.
    </LandingSection>
  );
}

function AppStep({
  icon,
  title,
  children,
}: {
  icon: "log-in" | "check-square" | "message-circle";
  title: string;
  children: string;
}) {
  return (
    <li className="flex gap-4">
      <span className="grid size-9 shrink-0 place-items-center border border-[color:var(--bo-border)] bg-[var(--bo-panel)] text-[var(--bo-muted)]">
        <Icon name={icon} className="size-4" strokeWidth={1.8} />
      </span>
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-pretty text-[var(--bo-muted)]">
          {children}
        </span>
      </span>
    </li>
  );
}
