import { createFileRoute, Link } from "@tanstack/react-router";
import { formsClient } from "@/lib/forms.client";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/forms/")({
  component: FormsListPage,
});

function FormsListPage() {
  const { data: forms, loading, error } = formsClient.useForms();

  return (
    <div className="flex min-h-svh w-full flex-col gap-6 p-6 md:p-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Forms</h1>
        <Link to="/forms/new">
          <Button>New Form</Button>
        </Link>
      </div>

      {loading && <p className="text-muted-foreground">Loading forms...</p>}

      {error && (
        <div className="border-destructive bg-destructive/10 text-destructive rounded-lg border p-4">
          Error loading forms: {error.message}
        </div>
      )}

      {forms && Array.isArray(forms) && forms.length === 0 && (
        <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center">
          <p>No forms yet.</p>
          <p className="mt-2">
            <Link to="/forms/new" className="text-primary underline">
              Create your first form
            </Link>
          </p>
        </div>
      )}

      {forms && Array.isArray(forms) && forms.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forms.map(
                (form: {
                  id: string;
                  slug: string;
                  title: string;
                  status: string;
                  version: number;
                  createdAt: Date;
                }) => (
                  <TableRow key={form.id}>
                    <TableCell className="font-medium">
                      <Link
                        to="/form/$slug"
                        params={{ slug: form.slug }}
                        className="hover:underline"
                      >
                        {form.title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          form.status === "open"
                            ? "bg-green-100 text-green-700"
                            : form.status === "closed"
                              ? "bg-red-100 text-red-700"
                              : "bg-yellow-100 text-yellow-700"
                        }`}
                      >
                        {form.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">v{form.version}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(form.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Link to="/form/$slug" params={{ slug: form.slug }}>
                          <Button variant="outline" size="sm">
                            View
                          </Button>
                        </Link>
                        <Link to="/forms/$formId/edit" params={{ formId: form.id }}>
                          <Button variant="outline" size="sm">
                            Edit
                          </Button>
                        </Link>
                        <Link to="/forms/$formId/submissions" params={{ formId: form.id }}>
                          <Button variant="outline" size="sm">
                            Submissions
                          </Button>
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                ),
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
