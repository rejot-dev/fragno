import type { AnySchema } from "../schema/create";
import type { SyncCommandDefinition, SyncCommandRegistry } from "./types";

type DefineSyncCommandsContext = {
  defineCommand: <TInput, TContext>(
    definition: SyncCommandDefinition<TInput, TContext>,
  ) => SyncCommandDefinition<TInput, TContext>;
};

const createRegistry = (
  schemaName: string,
  commandList: readonly SyncCommandDefinition[],
): SyncCommandRegistry => {
  const commands = new Map<string, SyncCommandDefinition>();

  for (const command of commandList) {
    if (!command || typeof command !== "object") {
      throw new Error("Sync commands must be objects.");
    }

    const name = command.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("Sync command name must be a non-empty string.");
    }

    const existing = commands.get(name);
    if (existing && existing !== command) {
      throw new Error(`Sync command "${name}" is already defined for schema "${schemaName}".`);
    }

    commands.set(name, command);
  }

  return {
    schemaName,
    commands,
    getCommand: (name) => commands.get(name),
  };
};

export const defineSyncCommands = <TSchema extends AnySchema>(options: { schema: TSchema }) => {
  const schemaName = options.schema.name;
  return {
    create: <const TCommands extends readonly SyncCommandDefinition[]>(
      factory: (context: DefineSyncCommandsContext) => TCommands,
    ): SyncCommandRegistry => {
      const commands = factory({ defineCommand: (definition) => definition });
      return createRegistry(schemaName, commands);
    },
  };
};
