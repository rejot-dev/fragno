// store tools
type StoreCodemodeProvider = {
  /** Get an automation store entry by key. */
  get(input: StoreGetInput): Promise<StoreGetOutput>;
  /** Create or update an automation store entry. */
  set(input: StoreSetInput): Promise<StoreSetOutput>;
  /** Delete an automation store entry by key. */
  delete(input: StoreDeleteInput): Promise<StoreDeleteOutput>;
  /** List automation store entries, optionally filtered by key prefix. */
  list(input: StoreListInput): Promise<StoreListOutput>;
};
declare const store: StoreCodemodeProvider;

type StoreGetInput = {
  key: string;
};
type StoreGetOutput = {
  id?: string;
  key: string;
  value: string;
  description?: string | null;
  category: string[];
  /** ISO 8601 datetime string. */
  createdAt?: string;
  /** ISO 8601 datetime string. */
  updatedAt?: string;
} | null;
type StoreSetInput = {
  key: string;
  value: string;
  description?: string | null;
  category?: string[];
  verification?: {
    type: "json-schema";
    schema: unknown;
  }[];
};
type StoreSetOutput = {
  id: string;
  key: string;
  value: string;
  description?: string | null;
  category: string[];
};
type StoreDeleteInput = {
  key: string;
};
type StoreDeleteOutput = {
  ok: true;
  key: string;
} | null;
type StoreListInput = {
  prefix?: string;
  limit?: number;
};
type StoreListOutput = {
  id?: string;
  key: string;
  value: string;
  description?: string | null;
  category: string[];
  /** ISO 8601 datetime string. */
  createdAt?: string;
  /** ISO 8601 datetime string. */
  updatedAt?: string;
}[];
