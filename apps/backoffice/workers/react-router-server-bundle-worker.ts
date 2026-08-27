import * as serverBuild from "virtual:react-router/server-build";

import { createReactRouterRouteService } from "./create-react-router-worker-handler";

// Route modules and their Worker runtime must share one build graph so identity-sensitive
// application modules are not compiled once into the server build and again into the Worker shell.
export default createReactRouterRouteService(serverBuild);
