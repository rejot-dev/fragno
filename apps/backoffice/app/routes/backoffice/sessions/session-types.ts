import type { ReactNode } from "react";

import type { PiHarnessConfig } from "@/fragno/pi/pi-shared";

import type { PiLayoutContext } from "./shared";

export type PiCreateSessionActionData = {
  intent: "create-session";
  ok: boolean;
  message?: string;
};

export type PiSessionsOutletContext = {
  scope: PiLayoutContext["scope"];
  persistenceSource: NonNullable<PiLayoutContext["persistenceSource"]>;
  harnesses: PiHarnessConfig[];
  basePath: string;
  createSessionPanel?: ReactNode;
};
