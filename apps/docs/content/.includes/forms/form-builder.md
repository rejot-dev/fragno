Install it using the shadcn CLI:

```npm
pnpm dlx shadcn@latest add https://fragno.dev/forms/form-builder.json
```

The components will be installed to `components/ui/form-builder`.

```tsx title="components/admin/create-form.tsx"
import { FormBuilder, type GeneratedSchemas } from "@/components/ui/form-builder";

export function CreateForm() {
  const [schemas, setSchemas] = useState<GeneratedSchemas | null>(null);

  return <FormBuilder onChange={setSchemas} />;
}
```
