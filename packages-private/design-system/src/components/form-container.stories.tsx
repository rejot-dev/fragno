import { Button } from "./button";
import { Field } from "./field";
import { FormContainer } from "./form-container";
import { Input } from "./input";

export default { title: "Forms/Form container" };

export function Default() {
  return (
    <FormContainer
      eyebrow="Connection"
      title="Resend"
      description="Send transactional email from automations."
      actions={<Button variant="accent">Save</Button>}
    >
      <Field label="API key" description="Stored encrypted in the organization vault.">
        <Input className="w-full" placeholder="re_..." />
      </Field>
      <Field label="From address">
        <Input className="w-full" placeholder="ops@example.com" />
      </Field>
    </FormContainer>
  );
}
