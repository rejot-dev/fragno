export function sortOrganizationsByPreference<
  TOrganization extends { organization: { id: string } },
>(organizations: TOrganization[], preferredOrganizationId: string | null) {
  if (!preferredOrganizationId) {
    return organizations;
  }

  return [
    ...organizations.filter((entry) => entry.organization.id === preferredOrganizationId),
    ...organizations.filter((entry) => entry.organization.id !== preferredOrganizationId),
  ];
}

export function getOrganizationPreferenceState(
  organizationId: string,
  preferredOrganizationId: string | null,
) {
  const isPreferred = organizationId === preferredOrganizationId;
  return {
    isPreferred,
    badgeLabel: isPreferred ? "Preferred" : "Available",
    actionLabel: isPreferred ? "Preferred org" : "Switch here",
    canSwitch: !isPreferred,
  };
}
