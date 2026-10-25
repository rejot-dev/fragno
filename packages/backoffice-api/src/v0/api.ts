import type { BackofficeApi } from "../api";
import { accountOperations } from "./account";
import { appsOperations } from "./apps";
import { artifactsOperations } from "./artifacts";
import { automationRouterOperations } from "./automation";
import { capabilitiesOperations } from "./capabilities";
import { eventsOperations } from "./events";
import { formsOperations } from "./forms";
import { hooksOperations } from "./hooks";
import { identityOperations } from "./identity";
import { integrationsOperations } from "./integrations";
import { javascriptOperations } from "./javascript";
import { marketplaceOperations } from "./marketplace";
import { packagesOperations } from "./marketplace";
import { modelsOperations } from "./models";
import { organizationOperations } from "./organization";
import { otpOperations } from "./otp";
import { piOperations } from "./pi";
import { projectsOperations } from "./projects";
import { reson8Operations } from "./reson8";
import { sandboxOperations } from "./sandbox";
import { stateOperations } from "./state";
import { storeOperations } from "./store";
import { webOperations } from "./web";
import { workflowOperations } from "./workflow";

/** v0 is unstable: operations and schemas may change without a new version. */
export const backofficeApiV0 = {
  version: "v0",
  operations: {
    ...accountOperations,
    ...appsOperations,
    ...artifactsOperations,
    ...automationRouterOperations,
    ...capabilitiesOperations,
    ...eventsOperations,
    ...formsOperations,
    ...hooksOperations,
    ...identityOperations,
    ...integrationsOperations,
    ...javascriptOperations,
    ...marketplaceOperations,
    ...modelsOperations,
    ...organizationOperations,
    ...otpOperations,
    ...packagesOperations,
    ...piOperations,
    ...projectsOperations,
    ...reson8Operations,
    ...sandboxOperations,
    ...stateOperations,
    ...storeOperations,
    ...webOperations,
    ...workflowOperations,
  },
} satisfies BackofficeApi;
