import * as serverBuild from "virtual:backoffice/react-router-current-server-build";

import { createReactRouterRouteService } from "./create-react-router-worker-handler";

export default createReactRouterRouteService(serverBuild);
