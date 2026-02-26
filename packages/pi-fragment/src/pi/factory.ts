import { instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase } from "@fragno-dev/db";

import { piFragmentDefinition } from "./definition";
import { piRoutesFactory } from "../routes";
import type { PiFragmentConfig, PiWorkflowsService } from "./types";

type PiFragmentServices = {
  workflows: PiWorkflowsService;
};

export function createPiFragment(
  config: PiFragmentConfig,
  options: FragnoPublicConfigWithDatabase,
  services: PiFragmentServices,
) {
  return instantiate(piFragmentDefinition)
    .withConfig(config)
    .withRoutes([piRoutesFactory])
    .withOptions(options)
    .withServices(services)
    .build();
}
