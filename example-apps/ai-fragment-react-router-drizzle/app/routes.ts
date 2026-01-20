import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("threads", "routes/threads.tsx"),
  route("api/ai/*", "routes/api/ai.tsx"),
] satisfies RouteConfig;
