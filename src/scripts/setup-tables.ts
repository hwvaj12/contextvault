import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({
  region: "us-east-1",
  endpoint: process.env.DYNAMODB_ENDPOINT || "http://localhost:8000",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

async function setup() {
  const existing = await client.send(new ListTablesCommand({}));
  const tables = existing.TableNames || [];

  if (!tables.includes("ContextVault_Workspaces")) {
    await client.send(
      new CreateTableCommand({
        TableName: "ContextVault_Workspaces",
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          { AttributeName: "customerId", AttributeType: "S" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "customerId-index",
            KeySchema: [
              { AttributeName: "customerId", KeyType: "HASH" },
              { AttributeName: "PK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
            ProvisionedThroughput: {
              ReadCapacityUnits: 5,
              WriteCapacityUnits: 5,
            },
          },
        ],
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5,
        },
      })
    );
    console.log("Created ContextVault_Workspaces table");
  } else {
    console.log("ContextVault_Workspaces table already exists");
  }

  if (!tables.includes("ContextVault_Commits")) {
    await client.send(
      new CreateTableCommand({
        TableName: "ContextVault_Commits",
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ],
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5,
        },
      })
    );
    console.log("Created ContextVault_Commits table");
  } else {
    console.log("ContextVault_Commits table already exists");
  }

  console.log("Database setup complete!");
  process.exit(0);
}

setup().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
