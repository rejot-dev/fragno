import { Input } from "./input";

export default { title: "Controls/Input" };

export function Types() {
  return (
    <div className="flex max-w-sm flex-col gap-3">
      <Input placeholder="Display name" />
      <Input type="email" placeholder="you@example.com" />
      <Input type="password" placeholder="••••••••" />
      <Input type="number" placeholder="15" />
    </div>
  );
}

export function States() {
  return (
    <div className="flex max-w-sm flex-col gap-3">
      <Input defaultValue="Valid value" />
      <Input defaultValue="not-an-email" aria-invalid />
      <Input defaultValue="Read only" disabled />
    </div>
  );
}
