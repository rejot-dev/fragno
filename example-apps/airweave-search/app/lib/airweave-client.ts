import { createAirweaveFragmentClient } from "@fragno-dev/airweave-fragment/react";

export const { useSearch, useStreamSearch, useCollections, useSources, useSourceConnections } =
  createAirweaveFragmentClient();
