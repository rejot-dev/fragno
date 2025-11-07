import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("api/chatno/*", "routes/api/chatno.tsx"),
  route("api/comments/*", "routes/api/comments.tsx"),
] satisfies RouteConfig;
