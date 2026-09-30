import { FormContainer, FormField } from "./form-container";
import { Input } from "./input";

export default { title: "Forms/Form container" };

export function Default() {
  return (
    <FormContainer
      eyebrow="Connection"
      title="Resend"
      description="Send transactional email from automations."
      actions={
        <button
          type="button"
          className="inline-flex min-h-10 items-center bg-[var(--bo-btn-bg)] px-4 text-xs font-semibold text-[var(--bo-btn-fg)]"
        >
          Save
        </button>
      }
    >
      <FormField label="API key" hint="Stored encrypted in the organization vault.">
        <Input className="h-10 w-full" placeholder="re_..." />
      </FormField>
      <FormField label="From address">
        <Input className="h-10 w-full" placeholder="ops@example.com" />
      </FormField>
    </FormContainer>
  );
}
