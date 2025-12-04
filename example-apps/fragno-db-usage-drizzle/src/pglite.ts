import { getPGLiteClient } from "./database";

const client = getPGLiteClient();

const res = await client.query(`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
`);

console.dir(res.rows, { depth: null });

const res2 = await client.query(`select * from fragno_db_settings;`);

console.dir(res2.rows, { depth: null });
