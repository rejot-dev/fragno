import { useState } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { JsonForms } from "@jsonforms/react";
import type { JsonSchema, UISchemaElement } from "@jsonforms/core";
import { shadcnRenderers, shadcnCells } from "@fragno-dev/jsonforms-shadcn-renderers";
import { formsClient } from "@/lib/forms.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export const Route = createFileRoute("/_authenticated/forms/new")({
  component: NewFormPage,
});

const defaultSchema: JsonSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      title: "Name",
    },
  },
};

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function NewFormPage() {
  const navigate = useNavigate();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [slug, setSlug] = useState("");
  const [status, setStatus] = useState<"draft" | "open" | "closed">("draft");
  const [schemaText, setSchemaText] = useState(JSON.stringify(defaultSchema, null, 2));
  const [uiSchemaText, setUiSchemaText] = useState("");
  const [previewData, setPreviewData] = useState<Record<string, unknown>>({});
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [uiSchemaError, setUiSchemaError] = useState<string | null>(null);

  const { mutate: createForm, loading, error } = formsClient.useCreateForm();

  let parsedSchema: JsonSchema = defaultSchema;
  let parsedUiSchema: UISchemaElement | undefined = undefined;

  try {
    parsedSchema = JSON.parse(schemaText);
    if (schemaError) setSchemaError(null);
  } catch (e) {
    if (!schemaError) setSchemaError((e as Error).message);
  }

  if (uiSchemaText.trim()) {
    try {
      parsedUiSchema = JSON.parse(uiSchemaText);
      if (uiSchemaError) setUiSchemaError(null);
    } catch (e) {
      if (!uiSchemaError) setUiSchemaError((e as Error).message);
    }
  } else if (uiSchemaError) {
    setUiSchemaError(null);
  }

  const handleSubmit = async () => {
    if (!title.trim()) {
      return;
    }

    try {
      const dataSchema = JSON.parse(schemaText);
      const uiSchema = uiSchemaText.trim() ? JSON.parse(uiSchemaText) : {};

      const formSlug = slug.trim() || generateSlug(title);
      await createForm({
        body: {
          title: title.trim(),
          description: description.trim() || null,
          slug: formSlug,
          status,
          dataSchema,
          uiSchema,
        },
      });

      navigate({ to: "/forms/$slug", params: { slug: formSlug } });
    } catch {
      // Schema parse errors are already shown
    }
  };

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b p-4">
        <h1 className="text-2xl font-bold">Create New Form</h1>
        <div className="flex gap-2">
          <Link to="/forms">
            <Button variant="outline">Cancel</Button>
          </Link>
          <Button onClick={handleSubmit} disabled={loading || !title.trim() || !!schemaError}>
            {loading ? "Creating..." : "Create Form"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="border-destructive bg-destructive/10 text-destructive mx-4 mt-4 rounded-lg border p-4">
          Error: {error.message}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-3 gap-4 p-4">
        <div className="flex flex-col gap-4 overflow-auto">
          <div className="space-y-4 rounded-lg border p-4">
            <h2 className="font-semibold">Form Details</h2>

            <div className="space-y-2">
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="My Form"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A brief description of this form"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">
                Slug{" "}
                <span className="text-muted-foreground text-xs">(auto-generated if empty)</span>
              </Label>
              <Input
                id="slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder={title ? generateSlug(title) : "my-form"}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <Label>Data Schema *</Label>
            {schemaError && <p className="text-destructive text-sm">{schemaError}</p>}
            <Textarea
              className="min-h-0 flex-1 font-mono text-sm"
              value={schemaText}
              onChange={(e) => setSchemaText(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label>
            UI Schema{" "}
            <span className="text-muted-foreground text-xs">(leave empty to auto-generate)</span>
          </Label>
          {uiSchemaError && <p className="text-destructive text-sm">{uiSchemaError}</p>}
          <Textarea
            className="min-h-0 flex-1 font-mono text-sm"
            value={uiSchemaText}
            onChange={(e) => setUiSchemaText(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2 overflow-auto">
          <Label>Preview</Label>
          <div className="flex-1 overflow-auto rounded-lg border p-4">
            <ErrorBoundary>
              <JsonForms
                schema={parsedSchema}
                uischema={parsedUiSchema}
                data={previewData}
                renderers={shadcnRenderers}
                cells={shadcnCells}
                onChange={({ data }) => setPreviewData(data ?? {})}
              />
            </ErrorBoundary>
          </div>
          <div className="bg-muted/50 rounded-lg border p-4">
            <h3 className="mb-2 font-semibold">Data:</h3>
            <pre className="overflow-auto text-sm">{JSON.stringify(previewData, null, 2)}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}
