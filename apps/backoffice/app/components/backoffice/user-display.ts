// Backoffice names people by their email handle, so every user has a name before they set one.

export function userDisplayName(email: string) {
  const handle = email.split("@")[0] ?? email;
  return handle
    .split(/[._-]+/)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function userInitials(email: string) {
  const handle = email.split("@")[0] ?? email;
  const parts = handle.split(/[._-]+/).filter(Boolean);
  return (parts.length > 0 ? parts : [handle])
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join("");
}
