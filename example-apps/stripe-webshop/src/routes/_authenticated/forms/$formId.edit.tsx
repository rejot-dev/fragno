import { useState, useEffect } from "react";
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

export const Route = createFileRoute("/_authenticated/forms/$formId/edit")({
  component: EditFormPage,
});

function EditFormPage() {
  const { formId } = Route.useParams();
  const navigate = useNavigate();

  // Use useForms and find by ID since useForm now uses slugs
  const { data: forms, loading: formLoading, error: formError } = formsClient.useForms();
  const form = Array.isArray(forms) ? forms.find((f) => f.id === formId) : undefined;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [status, setStatus] = useState<"draft" | "open" | "closed">("draft");
  const [schemaText, setSchemaText] = useState("");
  const [uiSchemaText, setUiSchemaText] = useState("");
  const [previewData, setPreviewData] = useState<Record<string, unknown>>({});
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [uiSchemaError, setUiSchemaError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  const {
    mutate: updateForm,
    loading: updateLoading,
    error: updateError,
  } = formsClient.useUpdateForm();

  useEffect(() => {
    if (form && !initialized) {
      setTitle(form.title);
      setDescription(form.description ?? "");
      setFormSlug(form.slug);
      setStatus(form.status as "draft" | "open" | "closed");
      setSchemaText(JSON.stringify(form.dataSchema, null, 2));
      setUiSchemaText(
        form.uiSchema && Object.keys(form.uiSchema).length > 0
          ? JSON.stringify(form.uiSchema, null, 2)
          : "",
      );
      setInitialized(true);
    }
  }, [form, initialized]);

  let parsedSchema: JsonSchema | undefined;
  let parsedUiSchema: UISchemaElement | undefined = undefined;

  try {
    if (schemaText.trim()) {
      parsedSchema = JSON.parse(schemaText);
      if (schemaError) setSchemaError(null);
    }
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

      await updateForm({
        path: { id: formId },
        body: {
          title: title.trim(),
          description: description.trim() || null,
          slug: formSlug.trim(),
          status,
          dataSchema,
          uiSchema,
        },
      });

      navigate({ to: "/forms" });
    } catch {
      // Schema parse errors are already shown
    }
  };

  if (formLoading) {
    return (
      <div className="flex min-h-svh w-full flex-col items-center justify-center">
        <p className="text-muted-foreground">Loading form...</p>
      </div>
    );
  }

  if (formError || !form) {
    return (
      <div className="flex min-h-svh w-full flex-col items-center justify-center">
        <div className="border-destructive bg-destructive/10 text-destructive rounded-lg border p-4">
          {formError ? `Error: ${formError.message}` : "Form not found"}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Edit Form</h1>
          <span className="text-muted-foreground text-sm">v{form.version}</span>
        </div>
        <div className="flex gap-2">
          <Link to="/forms/$slug" params={{ slug: form?.slug ?? "" }}>
            <Button variant="outline">Cancel</Button>
          </Link>
          <Button onClick={handleSubmit} disabled={updateLoading || !title.trim() || !!schemaError}>
            {updateLoading ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>

      {updateError && (
        <div className="border-destructive bg-destructive/10 text-destructive mx-4 mt-4 rounded-lg border p-4">
          Error: {updateError.message}
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
              <Label htmlFor="slug">Slug</Label>
              <Input
                id="slug"
                value={formSlug}
                onChange={(e) => setFormSlug(e.target.value)}
                placeholder="my-form"
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
              {parsedSchema && (
                <JsonForms
                  schema={parsedSchema}
                  uischema={parsedUiSchema}
                  data={previewData}
                  renderers={shadcnRenderers}
                  cells={shadcnCells}
                  onChange={({ data }) => setPreviewData(data ?? {})}
                />
              )}
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
