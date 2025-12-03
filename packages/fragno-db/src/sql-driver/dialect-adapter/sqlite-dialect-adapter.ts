import { DialectAdapterBase } from "./dialect-adapter";

export class SqliteDialectAdapter extends DialectAdapterBase {
  override get supportsReturning(): boolean {
    return true;
  }
}
