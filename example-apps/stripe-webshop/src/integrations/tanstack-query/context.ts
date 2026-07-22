import { QueryClient } from "@tanstack/react-query";

export function createTanstackQueryContext() {
  return {
    queryClient: new QueryClient(),
  };
}
