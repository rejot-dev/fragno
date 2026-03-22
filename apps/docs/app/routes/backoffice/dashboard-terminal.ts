const DASHBOARD_CWD_MARKER = "__FRAGNO_BACKOFFICE_CWD__";

const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const extractNextCwd = (
  stderr: string | undefined,
  fallbackCwd: string,
): { stderr: string | undefined; nextCwd: string } => {
  const normalizedStderr = stderr ?? "";
  const markerPattern = new RegExp(
    `(?:\\n|^)${escapeForRegExp(DASHBOARD_CWD_MARKER)}([^\\n]*)\\n?$`,
  );
  const match = markerPattern.exec(normalizedStderr);

  if (!match) {
    return {
      stderr,
      nextCwd: fallbackCwd,
    };
  }

  const nextCwd = match[1]?.trim() || fallbackCwd;
  const cleanedStderr = normalizedStderr.slice(0, match.index) || undefined;

  return {
    stderr: cleanedStderr,
    nextCwd,
  };
};

export const wrapDashboardCommand = (command: string) => `${command}
__fragno_dashboard_exit=$?
printf '\\n%s%s\\n' '${DASHBOARD_CWD_MARKER}' "$PWD" >&2
exit "$__fragno_dashboard_exit"`;
