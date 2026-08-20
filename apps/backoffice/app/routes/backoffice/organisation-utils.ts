export type OrganisationTab = "overview" | "members" | "invites" | "billing";

export const ROLE_OPTIONS = ["member", "admin", "owner"] as const;

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

export type ActionNotice = {
  type: "success" | "error";
  message: string;
} | null;

export function formatDate(value?: string | Date | null) {
  if (!value) {
    return "--";
  }
  return DATE_FORMATTER.format(new Date(value));
}

export function formatDateTime(value?: string | Date | null) {
  if (!value) {
    return "--";
  }
  return DATE_TIME_FORMATTER.format(new Date(value));
}

export function formatRoles(roles?: string[]) {
  if (!roles || roles.length === 0) {
    return "member";
  }
  return roles.join(", ");
}

export function getErrorMessage(error: unknown) {
  if (!error) {
    return "Something went wrong.";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && "message" in error) {
    const message = (error as { message?: string }).message;
    if (message) {
      return message;
    }
  }
  return "Something went wrong.";
}
