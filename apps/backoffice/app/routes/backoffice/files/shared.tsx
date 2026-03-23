import { Link, isRouteErrorResponse } from "react-router";

import { BackofficePageHeader } from "@/components/backoffice";
import type { FileMountMetadata } from "@/files";
import type { AuthMeData } from "@/fragno/auth/auth-client";

type BackofficeOrganisation = AuthMeData["organizations"][number]["organization"];

export type FilesLayoutContext = {
  orgId: string;
  origin: string;
  organisation: BackofficeOrganisation;
  mountCount: number;
};

export function FilesHeader({
  orgId,
  organisationName,
  mountCount,
}: {
  orgId: string;
  organisationName?: string | null;
  mountCount: number;
}) {
  return (
    <BackofficePageHeader
      breadcrumbs={[
        { label: "Backoffice", to: "/backoffice" },
        { label: "Files", to: "/backoffice/files" },
        { label: organisationName ?? orgId },
      ]}
      eyebrow="Workspace"
      title={`Files for ${organisationName ?? orgId}`}
      description={`Browse the combined filesystem mounted for this organisation. ${mountCount} mount${mountCount === 1 ? "" : "s"} currently available.`}
      actions={
        <Link
          to="/backoffice/files"
          className="border border-[color:var(--bo-border)] bg-[var(--bo-panel-2)] px-3 py-2 text-[10px] font-semibold tracking-[0.22em] text-[var(--bo-muted)] uppercase transition-colors hover:border-[color:var(--bo-border-strong)] hover:text-[var(--bo-fg)]"
        >
          Back to Files
        </Link>
      }
    />
  );
}

export function formatFileRootKind(kind: FileMountMetadata["kind"]) {
  switch (kind) {
    case "static": {
      return "Static";
    }
    case "starter": {
      return "Starter";
    }
    case "upload": {
      return "Upload";
    }
    case "custom": {
      return "Custom";
    }
  }
}

export function formatFileRootPersistence(persistence: FileMountMetadata["persistence"]) {
  switch (persistence) {
    case "ephemeral": {
      return "Ephemeral";
    }
    case "persistent": {
      return "Persistent";
    }
    case "session": {
      return "Session";
    }
  }
}

export function formatFileRootMutability(readOnly: boolean) {
  return readOnly ? "Read-only" : "Writable";
}

export function FilesErrorBoundary({
  error,
  params,
}: {
  error: unknown;
  params: { orgId?: string };
}) {
  let statusCode = 500;
  let message = "An unexpected error occurred.";
  let statusText = "Error";

  if (isRouteErrorResponse(error)) {
    statusCode = error.status;
    statusText = error.statusText || "Error";
    message = typeof error.data === "string" ? error.data : message;
  } else if (error instanceof Error) {
    message = error.message;
  }

  if (statusCode === 404 && params.orgId) {
    message = `Organisation '${params.orgId}' could not be found.`;
  }

  return (
    <div className="space-y-4">
      <FilesHeader orgId={params.orgId ?? "organisation"} organisationName="Error" mountCount={0} />
      <div className="border border-[color:var(--bo-border)] bg-[var(--bo-panel)] p-4 text-sm text-[var(--bo-muted)]">
        <p className="text-[10px] tracking-[0.22em] text-[var(--bo-muted-2)] uppercase">
          {statusCode} · {statusText}
        </p>
        <p className="mt-2 text-[var(--bo-fg)]">{message}</p>
      </div>
    </div>
  );
}
