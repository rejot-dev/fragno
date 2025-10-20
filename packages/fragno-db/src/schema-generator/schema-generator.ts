export interface GenerateSchemaOptions {
  path: string;
  toVersion?: number;
  fromVersion?: number;
}

export interface SchemaGenerator {
  generateSchema: (options?: GenerateSchemaOptions) => {
    schema: string;
    path: string;
  };
}
