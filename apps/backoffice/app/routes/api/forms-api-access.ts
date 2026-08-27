const FORMS_API_MOUNT_PATH = "/api/forms";

/** Admin fragment routes require Backoffice authorization; public form routes do not. */
export function requiresFormsAdminAuthorization(requestUrl: string) {
  const pathname = new URL(requestUrl).pathname;
  const fragmentPath = pathname.startsWith(FORMS_API_MOUNT_PATH)
    ? pathname.slice(FORMS_API_MOUNT_PATH.length)
    : pathname;
  return (
    fragmentPath === "/admin/forms" ||
    fragmentPath.startsWith("/admin/forms/") ||
    fragmentPath === "/admin/submissions" ||
    fragmentPath.startsWith("/admin/submissions/")
  );
}
