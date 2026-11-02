import { Button } from "../controls/button";
import { Field } from "../controls/field";
import { Input } from "../controls/input";
import { FormContainer } from "./form-container";

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
