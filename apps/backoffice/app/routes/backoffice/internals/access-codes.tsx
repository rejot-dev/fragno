import { Button, ButtonLink } from "@fragno-private/design-system/button";
import { Checkbox } from "@fragno-private/design-system/checkbox";
import { CopyButton } from "@fragno-private/design-system/copy-button";
import { Field } from "@fragno-private/design-system/field";
import { InlineAlert } from "@fragno-private/design-system/inline-alert";
import { Input } from "@fragno-private/design-system/input";
import { BackofficeStatusLight } from "@fragno-private/design-system/status-light";
import {
  SurfacePanel,
  SurfacePanelBody,
  SurfacePanelFooter,
  SurfaceTable,
  SurfaceTableRow,
  type SurfaceTableColumn,
} from "@fragno-private/design-system/surface-panel";
import { BackofficeSystemState } from "@fragno-private/design-system/system-state";
import { Form, useActionData, useLoaderData, useLocation, useNavigation } from "react-router";
import { z } from "zod";

import { buildAccessCodeSignUpUrl } from "@/fragno/access-codes/access-code";
import {
  createAccessCodeInputSchema,
  revokeAccessCodeInputSchema,
  type AccessCodeRecord,
} from "@/fragno/access-codes/contracts";
import { getBackofficeObjects } from "@/worker-runtime/durable-objects";

import type { Route } from "./+types/access-codes";
import { ACCESS_CODE_STATUS_DISPLAY, formatAccessCodeDate } from "./access-codes-shared";

const ACCESS_CODES_PAGE_SIZE = 50;

const ACCESS_CODE_COLUMNS: SurfaceTableColumn[] = [
  { label: "Label", align: "start" },
  { label: "Code", align: "start" },
  { label: "Status", align: "start" },
  { label: "Uses", align: "end" },
  { label: "Expires", align: "start" },
  { label: "Actions", align: "end" },
];

// An empty expiry arrives as "", which means the code never expires.
const optionalPositiveInteger = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : Number(value)));

const accessCodeActionInputSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("create"),
    label: z.string(),
    // The "By label" checkbox submits "label" only when checked.
    codeSource: z
      .string()
      .optional()
      .transform((value) => (value === "label" ? ("label" as const) : ("random" as const))),
    expiresInDays: optionalPositiveInteger,
  }),
  z.object({ intent: z.literal("revoke"), accessCodeId: z.string() }),
]);

type AccessCodesActionData =
  | { state: "created"; label: string; url: string }
  | { state: "revoked"; label: string }
  | { state: "error"; message: string };

export async function loader({ context, url }: Route.LoaderArgs) {
  const otp = getBackofficeObjects(context).otp.singleton().commands;
  const cursor = url.searchParams.get("cursor");
  const listing = await otp.listAccessCodes(
    cursor === null
      ? { page: "first", pageSize: ACCESS_CODES_PAGE_SIZE }
      : { page: "next", cursor },
  );
  if (!listing.ok) {
    throw new Response("Invalid access codes cursor.", { status: 400 });
  }
  // This page is served from the origin people sign up at.
  return { ...listing.page, signUpOrigin: url.origin };
}

export async function action({ request, context, url }: Route.ActionArgs) {
  const otp = getBackofficeObjects(context).otp.singleton().commands;
  const input = accessCodeActionInputSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!input.success) {
    return { state: "error", message: "The form is incomplete." } satisfies AccessCodesActionData;
  }

  if (input.data.intent === "revoke") {
    const { intent: _revoke, ...revocationFields } = input.data;
    const revocation = revokeAccessCodeInputSchema.safeParse(revocationFields);
    const accessCode = revocation.success ? await otp.revokeAccessCode(revocation.data) : null;
    return accessCode
      ? ({ state: "revoked", label: accessCode.label } satisfies AccessCodesActionData)
      : ({
          state: "error",
          message: "That access code no longer exists.",
        } satisfies AccessCodesActionData);
  }

  const { intent: _create, ...creationFields } = input.data;
  const creation = createAccessCodeInputSchema.safeParse(creationFields);
  if (!creation.success) {
    return {
      state: "error",
      message: "Give the code a label, and use whole days for its expiry.",
    } satisfies AccessCodesActionData;
  }
  const created = await otp.createAccessCode(creation.data);
  if (!created.ok) {
    return {
      state: "error",
      message: `The code ${created.code} already exists. Give this one another label.`,
    } satisfies AccessCodesActionData;
  }
  return {
    state: "created",
    label: created.accessCode.label,
    url: buildAccessCodeSignUpUrl(url.origin, created.accessCode.code),
  } satisfies AccessCodesActionData;
}

export function meta() {
  return [
    { title: "Access codes · Backoffice Internals" },
    {
      name: "description",
      content: "Create and revoke the access codes people sign up with.",
    },
  ];
}

export default function BackofficeInternalAccessCodes() {
  const { accessCodes, cursor, hasNextPage, signUpOrigin } = useLoaderData<typeof loader>();
  const actionData = useActionData<AccessCodesActionData>();
  const pathname = useLocation().pathname;
  const navigation = useNavigation();
  const creating =
    navigation.state === "submitting" && navigation.formData?.get("intent") === "create";

  return (
    <>
      <SurfacePanel caption="New access code" actions={null}>
        <SurfacePanelBody>
          <Form method="post" className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
            <input type="hidden" name="intent" value="create" />
            <div className="space-y-2">
              <Field label="Label" description="Who or what the code is for.">
                <Input name="label" required maxLength={100} placeholder="Design partners" />
              </Field>
              <Checkbox
                name="codeSource"
                value="label"
                density="compact"
                description="Design partners becomes DESIGN-PARTNERS. Easy to share, and to guess."
              >
                By label
              </Checkbox>
            </div>
            <Field label="Expires in days" description="Empty never expires.">
              <Input name="expiresInDays" type="number" min={1} step={1} placeholder="Never" />
            </Field>
            <Button type="submit" variant="accent" disabled={creating}>
              {creating ? "Creating…" : "Create code"}
            </Button>
          </Form>
          {actionData?.state === "created" ? (
            <div role="status" className="mt-4 space-y-1">
              <p className="text-xs text-[var(--bo-muted)]">
                Sign-up link for “{actionData.label}”.
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 truncate font-mono text-xs text-[var(--bo-fg)]">
                  {actionData.url}
                </code>
                <CopyButton value={actionData.url} label="Copy sign-up link" text="Copy" />
              </div>
            </div>
          ) : null}
          {actionData?.state === "revoked" ? (
            <p role="status" className="mt-4 text-xs text-[var(--bo-muted)]">
              Revoked “{actionData.label}”.
            </p>
          ) : null}
          {actionData?.state === "error" ? (
            <div className="mt-4">
              <InlineAlert>{actionData.message}</InlineAlert>
            </div>
          ) : null}
        </SurfacePanelBody>
      </SurfacePanel>

      <SurfacePanel caption="Access codes" actions={null}>
        {accessCodes.length === 0 ? (
          <BackofficeSystemState
            tone="empty"
            title="No access codes yet."
            description="People need an access code to create their own accounts. Codes created here appear newest first."
            flush
          />
        ) : (
          <SurfaceTable columns={ACCESS_CODE_COLUMNS}>
            {accessCodes.map((accessCode) => (
              <AccessCodeRow
                key={accessCode.id}
                accessCode={accessCode}
                signUpUrl={buildAccessCodeSignUpUrl(signUpOrigin, accessCode.code)}
              />
            ))}
          </SurfaceTable>
        )}
        {hasNextPage && cursor ? (
          <SurfacePanelFooter>
            <ButtonLink variant="secondary" to={`${pathname}?cursor=${encodeURIComponent(cursor)}`}>
              Older codes
            </ButtonLink>
          </SurfacePanelFooter>
        ) : null}
      </SurfacePanel>
    </>
  );
}

function AccessCodeRow({
  accessCode,
  signUpUrl,
}: {
  accessCode: AccessCodeRecord;
  signUpUrl: string;
}) {
  const status = ACCESS_CODE_STATUS_DISPLAY[accessCode.status];
  return (
    <SurfaceTableRow
      columns={ACCESS_CODE_COLUMNS}
      cells={[
        <div key="label" className="min-w-0">
          <div className="font-semibold text-[var(--bo-fg)]">{accessCode.label}</div>
          <div className="text-[11px] text-[var(--bo-muted-2)]">
            Created {formatAccessCodeDate(accessCode.createdAt)}
          </div>
        </div>,
        <div key="code" className="flex items-center gap-1">
          <code className="font-mono text-xs text-[var(--bo-fg)]">{accessCode.code}</code>
          {accessCode.status === "active" ? (
            <CopyButton
              value={signUpUrl}
              label={`Copy sign-up link for ${accessCode.label}`}
              text="Link"
            />
          ) : null}
        </div>,
        <BackofficeStatusLight key="status" tone={status.tone}>
          {status.label}
        </BackofficeStatusLight>,
        <span key="uses" className="tabular-nums">
          {accessCode.redemptionCount}
        </span>,
        <span key="expires" className="whitespace-nowrap">
          {accessCode.expiresAt === null ? "Never" : formatAccessCodeDate(accessCode.expiresAt)}
        </span>,
        <div key="actions" className="flex justify-end gap-2">
          <ButtonLink variant="secondary" to={encodeURIComponent(accessCode.code)}>
            View
          </ButtonLink>
          {accessCode.status === "revoked" ? null : (
            <Form method="post">
              <input type="hidden" name="intent" value="revoke" />
              <input type="hidden" name="accessCodeId" value={accessCode.id} />
              <Button type="submit" variant="secondary">
                Revoke
              </Button>
            </Form>
          )}
        </div>,
      ]}
    />
  );
}
