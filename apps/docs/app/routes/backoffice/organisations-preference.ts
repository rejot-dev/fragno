export function sortOrganizationsByDefault<TOrganization extends { organization: { id: string } }>(
  organizations: TOrganization[],
  defaultOrganizationId: string | null,
) {
  if (!defaultOrganizationId) {
    return organizations;
  }

  return [
    ...organizations.filter((entry) => entry.organization.id === defaultOrganizationId),
    ...organizations.filter((entry) => entry.organization.id !== defaultOrganizationId),
  ];
}

export function getOrganizationPreferenceState(
  organizationId: string,
  defaultOrganizationId: string | null,
) {
  const isDefault = organizationId === defaultOrganizationId;
  return {
    isDefault,
    badgeLabel: isDefault ? "Default" : "Available",
    actionLabel: isDefault ? "Default org" : "Set default",
    canSetDefault: !isDefault,
  };
}
