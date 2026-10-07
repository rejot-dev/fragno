import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  layout("routes/public-layout.tsx", [
    index("routes/home.tsx"),
    route("signup", "routes/signup.tsx"),
    route("login", "routes/login.tsx"),
  ]),
  route("dashboard", "routes/dashboard-layout.tsx", [
    index("routes/dashboard.tsx"),
    route("account", "routes/account.tsx"),
  ]),
] satisfies RouteConfig;
