import { sql } from "kysely";
import { db } from "./database";

async function printSettings() {
  console.log("Querying fragno_db_settings table...\n");

  try {
    const results = await sql`SELECT * FROM fragno_db_settings`.execute(db);

    if (results.rows.length === 0) {
      console.log("No settings found in the database.");
      return;
    }

    console.log(`Found ${results.rows.length} setting(s):\n`);

    for (const row of results.rows) {
      const r = row as Record<string, unknown>;
      console.log("─".repeat(60));
      console.log(`ID:    ${r["id"]}`);
      console.log(`Key:   ${r["key"]}`);
      console.log(`Value: ${r["value"]}`);
      console.log(`Version: ${r["_version"]}`);
      console.log(`Internal ID: ${r["_internalId"]}`);
    }
    console.log("─".repeat(60));
  } catch (error) {
    console.error("Error querying settings:", error);
    throw error;
  } finally {
    await db.destroy();
  }
}

printSettings();
