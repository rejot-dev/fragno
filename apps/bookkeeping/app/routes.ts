import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  layout("routes/public-layout.tsx", [
    index("routes/home.tsx"),
    route("signup", "routes/signup.tsx"),
    route("login", "routes/login.tsx"),
    route("help", "routes/help.tsx"),
    route("welcome", "routes/welcome.tsx"),
    route("invitations/:invitationId", "routes/invitation.tsx"),
  ]),
  route("start", "routes/start.tsx"),
  route("w/:slug", "routes/workspace-layout.tsx", [
    index("routes/workspace.tsx"),
    route("members", "routes/members.tsx"),
    route("account", "routes/account.tsx"),
  ]),
] satisfies RouteConfig;
