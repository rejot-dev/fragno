import { defineConfig } from "kysely-ctl";
import { getDialect } from "./src/kysely/dialect";

const dialect = await getDialect();

export default defineConfig({
  dialect,
  migrations: {
    migrationFolder: "src/kysely/migrations",
  },

  //   plugins: [],
  //   seeds: {
  //     seedFolder: "seeds",
  //   }
});
