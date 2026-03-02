export type BackofficeOrganisation = {
  id: string;
  name: string;
  plan: string;
  members: string;
  activity: string;
};

export const ORGANISATIONS: BackofficeOrganisation[] = [
  {
    id: "fragno-labs",
    name: "Fragno Labs",
    plan: "Studio",
    members: "18 members",
    activity: "Release train active",
  },
  {
    id: "docworks",
    name: "DocWorks",
    plan: "Workspace",
    members: "7 members",
    activity: "Docs refresh sprint",
  },
  {
    id: "orbit-partners",
    name: "Orbit Partners",
    plan: "Sandbox",
    members: "4 members",
    activity: "Integration prototyping",
  },
  {
    id: "cobalt-guild",
    name: "Cobalt Guild",
    plan: "Enterprise",
    members: "29 members",
    activity: "Compliance review",
  },
];

export const getOrganisation = (orgId: string | undefined | null) => {
  if (!orgId) {
    return null;
  }
  return ORGANISATIONS.find((org) => org.id === orgId) ?? null;
};
