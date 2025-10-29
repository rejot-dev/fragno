import { PGlite } from "@electric-sql/pglite";
const db = new PGlite(process.env["DATABASE_URL"]);

const ret = await db.query(`
  SELECT * from subscription;
`);
console.log(ret.rows);
