import { AppAuthLayout } from "./app-auth-layout";
import { Button } from "./button";
import { Field } from "./field";
import { Input } from "./input";

export default { title: "Layout/App auth layout" };

const brand = {
  name: "Bookkeeping",
  logoUrl:
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><rect width='40' height='40' rx='8' fill='%232f6f4e'/></svg>",
  accentColor: "#2f6f4e",
  homeUrl: "https://bookkeeping.example",
  supportUrl: "https://bookkeeping.example/help",
};

export function Email() {
  return (
    <AppAuthLayout
      brand={brand}
      title="Continue to Bookkeeping"
      description="Enter your email. We'll send you a code, so there's no password to remember."
    >
      <form className="space-y-4">
        <Field label="Email">
          <Input type="email" placeholder="you@example.com" className="w-full" />
        </Field>
        <Button variant="solid" className="w-full">
          Continue
        </Button>
      </form>
    </AppAuthLayout>
  );
}
