import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("instances", "routes/instances.tsx"),
  route("create-instance", "routes/create-instance.tsx"),
  route("api/workflows/*", "routes/api/workflows.tsx"),
] satisfies RouteConfig;
