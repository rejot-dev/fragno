import { defineFragment } from "@fragno-dev/core";
import { withDatabase } from "@fragno-dev/db";

import { calendarServices } from "./calendar";
import { chartServices } from "./chart";
import { postingServices } from "./posting";
import { readServices } from "./reads";
import { ledgerSchema } from "./schema";
import { settlementServices } from "./settlement";

export const ledgerFragmentDefinition = defineFragment("ledger")
  .extend(withDatabase(ledgerSchema))
  .providesBaseService(({ defineService }) =>
    defineService({
      ...calendarServices,
      ...chartServices,
      ...postingServices,
      ...settlementServices,
      ...readServices,
    }),
  )
  .build();
