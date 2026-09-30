import { FormField } from "@fragno-private/design-system/form-container";
import { Input } from "@fragno-private/design-system/input";

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
        <FormField label="To" hint="Comma or newline separated list.">
          <Input
            name="to"
            required
            placeholder="hello@resend.dev, ops@example.com"
            className="w-full"
          />
        </FormField>
        <FormField label="Subject" hint={subjectHint}>
          <Input name="subject" required placeholder={subjectPlaceholder} className="w-full" />
        </FormField>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <FormField
          label="From"
          hint={
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
        </FormField>
        <FormField
          label="Reply-to"
          hint={
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
        </FormField>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="CC" hint="Optional. Use commas for multiple addresses.">
          <Input name="cc" placeholder="finance@yourdomain.com" className="w-full" />
        </FormField>
        <FormField label="BCC" hint="Optional. Use commas for multiple addresses.">
          <Input name="bcc" placeholder="audit@yourdomain.com" className="w-full" />
        </FormField>
      </div>

      <FormField label="Schedule in" hint="Optional delay from now (uses database time).">
        <div className="flex flex-wrap gap-2">
          <Input
            name="scheduledInValue"
            type="number"
            min="1"
            step="1"
            placeholder="15"
            className="w-full md:w-36"
          />
          <select
            name="scheduledInUnit"
            defaultValue="minutes"
            className="bo-input px-3 py-2 text-sm"
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      </FormField>

      <div className={BODY_GRID[bodyColumnsFrom]}>
        <FormField label="Text" hint="Provide either text or HTML.">
          <textarea
            name="text"
            rows={6}
            placeholder={textPlaceholder}
            className="bo-input w-full px-3 py-2 text-sm"
          />
        </FormField>
        <FormField label="HTML" hint="Optional rich HTML body.">
          <textarea
            name="html"
            rows={6}
            placeholder="<p>Hello from Resend...</p>"
            className="bo-input w-full px-3 py-2 text-sm"
          />
        </FormField>
      </div>
    </>
  );
}
