/** Agent names are lowercase file stems such as `code-reviewer`; people read them as "Code Reviewer". */
export function formatPiAgentName(agentName: string) {
  return agentName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
