import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/uploads/*", "routes/api/uploads.tsx"),
] satisfies RouteConfig;
