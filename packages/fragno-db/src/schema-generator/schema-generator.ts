export interface GenerateSchemaOptions {
  path: string;
}

export interface SchemaGenerator {
  generateSchema: (options?: GenerateSchemaOptions) => {
    schema: string;
    path: string;
  };
}
