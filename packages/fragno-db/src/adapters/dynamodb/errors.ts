export class DynamoDBAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class DynamoDBTransactionLimitError extends DynamoDBAdapterError {}

export class DynamoDBItemSizeError extends DynamoDBAdapterError {}

export class DynamoDBUnsupportedQueryError extends DynamoDBAdapterError {}

export class DynamoDBReadLimitError extends DynamoDBAdapterError {}
