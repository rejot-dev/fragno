import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("direct", "routes/direct.tsx"),
  route("proxy", "routes/proxy.tsx"),
  route("api/uploads-direct/*", "routes/api/uploads-direct.tsx"),
  route("api/uploads-proxy/*", "routes/api/uploads-proxy.tsx"),
] satisfies RouteConfig;
