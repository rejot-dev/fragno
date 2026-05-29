import { describe } from "vitest";

import { randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface DynamoDBLocalTestContext {
  client: DynamoDBDocumentClient;
  tablePrefix: string;
  endpoint: string;
}

export function getDynamoDBLocalTestContext(): DynamoDBLocalTestContext | null {
  const endpoint = process.env["FRAGNO_DYNAMODB_ENDPOINT"];
  if (!endpoint) {
    return null;
  }

  const lowLevelClient = new DynamoDBClient({
    endpoint,
    region: process.env["AWS_REGION"] ?? "us-east-1",
    credentials: {
      accessKeyId: process.env["AWS_ACCESS_KEY_ID"] ?? "local",
      secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"] ?? "local",
    },
  });

  return {
    client: DynamoDBDocumentClient.from(lowLevelClient),
    tablePrefix: `fragno_test_${randomUUID().replace(/-/g, "_")}`,
    endpoint,
  };
}

export function describeDynamoDBLocal(name: string, fn: () => void): void {
  const runner = process.env["FRAGNO_DYNAMODB_ENDPOINT"] ? describe : describe.skip;
  runner(name, fn);
}
