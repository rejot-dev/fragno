import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  layout("public/layout.tsx", [
    index("public/home.tsx"),
    route("signup", "public/signup.tsx"),
    route("login", "public/login.tsx"),
    route("help", "public/help.tsx"),
    route("name", "public/name.tsx"),
    route("account", "public/account.tsx"),
    route("start", "organizations/start.tsx"),
    route("invitations/:invitationId", "invitations/invitation.tsx"),
  ]),
  // Operators run Bookkeeping and create firms; they are the operator organization's members.
  route("operator", "operator/layout.tsx", [
    index("operator/firms.tsx"),
    route("firms/new", "operator/new-firm.tsx"),
    route("members", "operator/members.tsx"),
  ]),
  // An accounting firm: its clients and its team.
  route("f/:slug", "firms/layout.tsx", [
    index("firms/dashboard.tsx"),
    route("clients/new", "firms/new-client.tsx"),
    route("members", "firms/members.tsx"),
  ]),
  // A client's workspace: the administrations a firm keeps for it, and its team.
  route("w/:slug", "clients/layout.tsx", [
    index("clients/overview.tsx"),
    route("administrations/new", "administrations/new.tsx"),
    // One administration's books.
    route("a/:administration", "books/layout.tsx", [
      index("books/journal.tsx"),
      route("entries/new", "books/new-entry.tsx"),
      route("accounts", "books/accounts.tsx"),
      route("accounts/:accountId", "books/account.tsx"),
      route("trial-balance", "books/trial-balance.tsx"),
      route("parties", "books/parties.tsx"),
      route("parties/:partyAccountId", "books/party-account.tsx"),
      route("settings", "books/settings.tsx"),
    ]),
    route("members", "clients/members.tsx"),
  ]),
] satisfies RouteConfig;
