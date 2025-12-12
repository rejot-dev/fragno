import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { formsClient } from "@/lib/forms.client";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/forms/$formId/submissions")({
  component: SubmissionsPage,
});

function SubmissionsPage() {
  const { formId } = Route.useParams();
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Use useForms and find by ID since useForm now uses slugs
  const { data: forms, loading: formsLoading } = formsClient.useForms();
  const form = Array.isArray(forms) ? forms.find((f) => f.id === formId) : undefined;

  const {
    data: submissions,
    loading: submissionsLoading,
    error: submissionsError,
  } = formsClient.useSubmissions({
    path: { id: formId },
    query: { sortOrder },
  });

  return (
    <div className="flex min-h-svh w-full flex-col gap-6 p-6 md:p-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Submissions</h1>
          {formsLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : form ? (
            <p className="text-muted-foreground">for {form.title}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-4">
          <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as "asc" | "desc")}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desc">Newest first</SelectItem>
              <SelectItem value="asc">Oldest first</SelectItem>
            </SelectContent>
          </Select>
          {form && (
            <Link to="/forms">
              <Button variant="outline">Back to Overview</Button>
            </Link>
          )}
        </div>
      </div>

      {submissionsError && (
        <div className="border-destructive bg-destructive/10 text-destructive rounded-lg border p-4">
          Error loading submissions: {submissionsError.message}
        </div>
      )}

      {submissionsLoading && <p className="text-muted-foreground">Loading submissions...</p>}

      {submissions && submissions.length === 0 && (
        <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">
          <p>No submissions yet.</p>
          <p className="mt-2">Share your form link to start collecting responses.</p>
        </div>
      )}

      {submissions && submissions.length > 0 && (
        <div className="space-y-4">
          <p className="text-muted-foreground text-sm">
            {submissions.length} submission{submissions.length !== 1 ? "s" : ""}
          </p>
          <div className="space-y-3">
            {submissions.map((submission) => (
              <div key={submission.id} className="rounded-lg border p-4">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-muted-foreground text-sm">
                    {new Date(submission.submittedAt).toLocaleString()}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    Form v{submission.formVersion}
                  </span>
                </div>
                <pre className="bg-muted overflow-auto rounded p-3 text-sm">
                  {JSON.stringify(submission.data, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
