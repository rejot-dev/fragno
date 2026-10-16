import { AuthorizationScreen } from "./authorization-screen";
import { Button } from "./button";
import { Checkbox } from "./checkbox";

export default { title: "Layout/Authorization screen" };

export function Default() {
  return (
    <AuthorizationScreen
      eyebrow="Install app"
      title="Install Bookkeeping"
      description="Bookkeeping asks to act in Acme Inc. within the access below."
    >
      <form className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-[var(--bo-fg)]">Permissions</legend>
          <Checkbox name="permission" value="files.read" defaultChecked>
            <span className="font-mono">files.read</span>
          </Checkbox>
          <Checkbox name="permission" value="workflows.run" defaultChecked>
            <span className="font-mono">workflows.run</span>
          </Checkbox>
        </fieldset>
        <div className="flex gap-2">
          <Button variant="accent" type="submit">
            Install
          </Button>
          <Button variant="secondary">Cancel</Button>
        </div>
      </form>
    </AuthorizationScreen>
  );
}
