import type { Command } from "gunshi";
import * as repo from "../repository";

const userCreateCommand: Command = {
  name: "create",
  description: "Create a new user",
  args: {
    email: {
      type: "string" as const,
      description: "User email address",
      required: true as const,
    },
    name: {
      type: "string" as const,
      description: "User name",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const user = await repo.createUser({
      email: ctx.values["email"] as string,
      name: ctx.values["name"] as string,
    });
    console.log("Created user:");
    console.log(JSON.stringify(user, null, 2));
  },
};

const userListCommand: Command = {
  name: "list",
  description: "List all users",
  run: async () => {
    const users = await repo.findUsers({});
    console.log("Users:");
    console.log(JSON.stringify(users, null, 2));
  },
};

const userGetCommand: Command = {
  name: "get",
  description: "Get a user by ID",
  args: {
    id: {
      type: "number" as const,
      description: "User ID",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const id = ctx.values["id"] as number;
    const user = await repo.findUserById(id);
    if (user) {
      console.log("User:");
      console.log(JSON.stringify(user, null, 2));
    } else {
      console.log(`User with ID ${id} not found.`);
    }
  },
};

const userGetByEmailCommand: Command = {
  name: "get-by-email",
  description: "Get a user by email",
  args: {
    email: {
      type: "string" as const,
      description: "User email address",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const email = ctx.values["email"] as string;
    const user = await repo.findUserByEmail(email);
    if (user) {
      console.log("User:");
      console.log(JSON.stringify(user, null, 2));
    } else {
      console.log(`User with email ${email} not found.`);
    }
  },
};

const userUpdateCommand: Command = {
  name: "update",
  description: "Update a user",
  args: {
    id: {
      type: "number" as const,
      description: "User ID",
      required: true as const,
    },
    email: {
      type: "string" as const,
      description: "New email address",
    },
    name: {
      type: "string" as const,
      description: "New name",
    },
  },
  run: async (ctx) => {
    const id = ctx.values["id"] as number;
    const updates: { email?: string; name?: string } = {};

    if (ctx.values["email"] !== undefined) {
      updates.email = ctx.values["email"] as string;
    }
    if (ctx.values["name"] !== undefined) {
      updates.name = ctx.values["name"] as string;
    }

    if (Object.keys(updates).length === 0) {
      console.log("No updates provided.");
      return;
    }

    try {
      await repo.updateUser(id, updates);
    } catch (_error) {
      console.log(`User with ID ${id} not found.`);
      return;
    }

    const user = await repo.findUserById(id);
    if (!user) {
      console.log(`User with ID ${id} not found.`);
      return;
    }

    console.log(`User ${id} updated successfully.`);
    console.log(JSON.stringify(user, null, 2));
  },
};

const userDeleteCommand: Command = {
  name: "delete",
  description: "Delete a user",
  args: {
    id: {
      type: "number" as const,
      description: "User ID",
      required: true as const,
    },
  },
  run: async (ctx) => {
    const id = ctx.values["id"] as number;
    const deletedUser = await repo.deleteUser(id);
    if (deletedUser) {
      console.log("Deleted user:");
      console.log(JSON.stringify(deletedUser, null, 2));
    } else {
      console.log(`User with ID ${id} not found.`);
    }
  },
};

export const userSubCommands = new Map<string, Command>();
userSubCommands.set("create", userCreateCommand);
userSubCommands.set("list", userListCommand);
userSubCommands.set("get", userGetCommand);
userSubCommands.set("get-by-email", userGetByEmailCommand);
userSubCommands.set("update", userUpdateCommand);
userSubCommands.set("delete", userDeleteCommand);

export const userCommand: Command = {
  name: "user",
  description: "User management commands",
  run: () => {
    console.log("User management commands");
    console.log("");
    console.log("Usage: node --import tsx src/mod.ts user <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  create         Create a new user");
    console.log("  list           List all users");
    console.log("  get            Get a user by ID");
    console.log("  get-by-email   Get a user by email");
    console.log("  update         Update a user");
    console.log("  delete         Delete a user");
    console.log("");
    console.log("Run 'node --import tsx src/mod.ts user <command> --help' for more information.");
  },
};
