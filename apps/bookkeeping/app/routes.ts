import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  layout("public/layout.tsx", [
    index("public/home.tsx"),
    route("signup", "public/signup.tsx"),
    route("login", "public/login.tsx"),
    route("help", "public/help.tsx"),
    route("welcome", "welcome/welcome.tsx"),
    route("invitations/:invitationId", "invitations/invitation.tsx"),
  ]),
  route("start", "workspace/start.tsx"),
  route("w/:slug", "workspace/layout.tsx", [
    index("workspace/overview.tsx"),
    route("members", "workspace/members.tsx"),
    route("account", "workspace/account.tsx"),
  ]),
] satisfies RouteConfig;
