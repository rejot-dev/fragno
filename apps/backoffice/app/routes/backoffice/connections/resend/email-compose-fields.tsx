import { Field } from "@fragno-private/design-system/field";
import { Input } from "@fragno-private/design-system/input";
import { Select } from "@fragno-private/design-system/select";
import { TextArea } from "@fragno-private/design-system/text-area";

const SCHEDULE_UNIT_OPTIONS = [
  { label: "minutes", value: "minutes" },
  { label: "hours", value: "hours" },
  { label: "days", value: "days" },
];

const BODY_GRID = {
  md: "grid gap-3 md:grid-cols-2",
  lg: "grid gap-3 lg:grid-cols-2",
};

// The fields every outgoing Resend message shares, whether it is a one-off email or the first
// message of a thread. Field names are the contract with the routes' actions.
export function EmailComposeFields({
  defaultFrom,
  defaultReplyTo,
  subjectHint,
  subjectPlaceholder,
  textPlaceholder,
  bodyColumnsFrom,
}: {
  defaultFrom: string;
  defaultReplyTo: string;
  subjectHint: string;
  subjectPlaceholder: string;
  textPlaceholder: string;
  // The breakpoint from which the text and HTML bodies sit side by side.
  bodyColumnsFrom: keyof typeof BODY_GRID;
}) {
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="To" description="Comma or newline separated list.">
          <Input
            name="to"
            required
            placeholder="hello@resend.dev, ops@example.com"
            className="w-full"
          />
        </Field>
        <Field label="Subject" description={subjectHint}>
          <Input name="subject" required placeholder={subjectPlaceholder} className="w-full" />
        </Field>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label="From"
          description={
            defaultFrom
              ? `Defaults to ${defaultFrom}.`
              : "Leave blank to use the configured default."
          }
        >
          <Input
            name="from"
            defaultValue={defaultFrom}
            placeholder={defaultFrom || "onboarding@yourdomain.com"}
            className="w-full"
          />
        </Field>
        <Field
          label="Reply-to"
          description={
            defaultReplyTo
              ? `Defaults to ${defaultReplyTo}.`
              : "Optional. Use commas for multiple addresses."
          }
        >
          <Input
            name="replyTo"
            defaultValue={defaultReplyTo}
            placeholder={defaultReplyTo || "support@yourdomain.com"}
            className="w-full"
          />
        </Field>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="CC" description="Optional. Use commas for multiple addresses.">
          <Input name="cc" placeholder="finance@yourdomain.com" className="w-full" />
        </Field>
        <Field label="BCC" description="Optional. Use commas for multiple addresses.">
          <Input name="bcc" placeholder="audit@yourdomain.com" className="w-full" />
        </Field>
      </div>

      {/* The unit picker sits beside the field so the field's label names only the number. */}
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Schedule in"
          description="Optional delay from now (uses database time)."
          className="w-full md:w-auto"
        >
          <Input
            name="scheduledInValue"
            type="number"
            min="1"
            step="1"
            placeholder="15"
            className="w-full md:w-36"
          />
        </Field>
        <Select
          name="scheduledInUnit"
          aria-label="Schedule unit"
          defaultValue="minutes"
          options={SCHEDULE_UNIT_OPTIONS}
          className="w-full md:w-36"
        />
      </div>

      <div className={BODY_GRID[bodyColumnsFrom]}>
        <Field label="Text" description="Provide either text or HTML.">
          <TextArea name="text" rows={6} placeholder={textPlaceholder} />
        </Field>
        <Field label="HTML" description="Optional rich HTML body.">
          <TextArea
            name="html"
            rows={6}
            placeholder="<p>Hello from Resend...</p>"
            className="bo-input w-full px-3 py-2 text-sm"
          />
        </Field>
      </div>
    </>
  );
}
