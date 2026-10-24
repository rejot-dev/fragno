// Vendored from rocicorp/mono@945ce619249e63381fb51d46c12f0d9e80024860 packages/zqlite/src/internal/sql.ts. Do not edit; run scripts/vendor-zql.mjs.
// @ts-nocheck
import {escapeSQLiteIdentifier} from '@databases/escape-identifier';
import type {FormatConfig, SQLQuery} from '@databases/sql';
import sql from '@databases/sql';

const sqliteFormat: FormatConfig = {
  escapeIdentifier: str => escapeSQLiteIdentifier(str),
  formatValue: value => ({placeholder: '?', value}),
};

export function compile(sql: SQLQuery): string {
  return sql.format(sqliteFormat).text;
}

export function format(sql: SQLQuery) {
  return sql.format(sqliteFormat);
}

export {sql};
