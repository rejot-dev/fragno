import type { BackofficeApi } from "../api";
import { accountOperations } from "./account";
import { appsOperations } from "./apps";
import { automationRouterOperations } from "./automation";
import { capabilitiesOperations } from "./capabilities";
import { connectorOperations } from "./connector";
import { eventsOperations } from "./events";
import { formsOperations } from "./forms";
import { githubOperations } from "./github";
import { hooksOperations } from "./hooks";
import { httpApiOperations } from "./http-api";
import { identityOperations } from "./identity";
import { integrationsOperations } from "./integrations";
import { javascriptOperations } from "./javascript";
import { marketplaceOperations } from "./marketplace";
import { packagesOperations } from "./marketplace";
import { mcpOperations } from "./mcp";
import { organizationOperations } from "./organization";
import { otpOperations } from "./otp";
import { piOperations } from "./pi";
import { resendOperations } from "./resend";
import { sandboxOperations } from "./sandbox";
import { stateOperations } from "./state";
import { storeOperations } from "./store";
import { telegramOperations } from "./telegram";
import { uploadOperations } from "./upload";
import { webOperations } from "./web";
import { workflowOperations } from "./workflow";

/** v0 is unstable: operations and schemas may change without a new version. */
export const backofficeApiV0 = {
  version: "v0",
  operations: {
    ...accountOperations,
    ...appsOperations,
    ...automationRouterOperations,
    ...capabilitiesOperations,
    ...connectorOperations,
    ...eventsOperations,
    ...formsOperations,
    ...githubOperations,
    ...hooksOperations,
    ...httpApiOperations,
    ...identityOperations,
    ...integrationsOperations,
    ...javascriptOperations,
    ...marketplaceOperations,
    ...mcpOperations,
    ...organizationOperations,
    ...otpOperations,
    ...packagesOperations,
    ...piOperations,
    ...resendOperations,
    ...sandboxOperations,
    ...stateOperations,
    ...storeOperations,
    ...telegramOperations,
    ...uploadOperations,
    ...webOperations,
    ...workflowOperations,
  },
} satisfies BackofficeApi;
