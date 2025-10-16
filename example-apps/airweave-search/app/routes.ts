import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/search.tsx"),
  route("sources", "routes/sources.tsx"),
  route("connections", "routes/connections.tsx"),
  route("api/airweave-fragment/*", "routes/api.airweave-fragment.$.tsx"),
] satisfies RouteConfig;
