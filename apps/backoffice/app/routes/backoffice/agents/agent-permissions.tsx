/** A turn runs as its prompter, so the definition's grants are a ceiling rather than a gift. */
const PERMISSIONS_EXPLANATION =
  "Each turn runs with its prompter's permissions, narrowed to these.";

function formatPiAgentPermissions(permissions: readonly string[]) {
  if (permissions.includes("*")) {
    return "All";
  }
  return permissions.length === 0 ? "None" : permissions.join(", ");
}

export function AgentPermissions({
  permissions,
  className,
}: {
  permissions: readonly string[];
  className: string;
}) {
  return (
    <p title={PERMISSIONS_EXPLANATION} className={className}>
      <span className="text-[var(--bo-muted-2)]">Permissions: </span>
      <span className="text-[var(--bo-fg)]">{formatPiAgentPermissions(permissions)}</span>
    </p>
  );
}
