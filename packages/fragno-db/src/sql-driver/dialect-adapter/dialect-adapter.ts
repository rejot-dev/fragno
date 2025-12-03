export interface DialectAdapter {
  readonly supportsReturning: boolean;
}

export abstract class DialectAdapterBase implements DialectAdapter {
  get supportsReturning(): boolean {
    return false;
  }
}
