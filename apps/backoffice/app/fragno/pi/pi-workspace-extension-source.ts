import { PI_WORKSPACE_EXTENSION_HOOKS } from "./pi-workspace-extension-metadata";

/** Discovers native registrations and invokes their callbacks without loading workspace code on the host. */
export function createPiWorkspaceExtensionInvocation(providerNames: readonly string[]): string {
  return `async (module, input) => {
    const extension = module.default;
    if (!extension || typeof extension !== "object" || Array.isArray(extension) || typeof extension.name !== "string") throw new Error("PI_EXTENSION_INVALID_EXPORT: expected a named default extension.");
    const assertMembers = (value, allowed, error) => {
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).some(key => !allowed.includes(key))) throw new Error(error);
    };
    assertMembers(extension, ["name", "sections", "tools", "hooks"], "PI_EXTENSION_UNSUPPORTED_MEMBER: supported members are name, sections, tools, and built-in hooks.");
    const registrations = (name) => {
      const values = extension[name] === undefined ? [] : extension[name];
      if (!Array.isArray(values) || values.length > 16) throw new Error("PI_EXTENSION_INVALID_REGISTRATIONS: " + name);
      return values;
    };
    const sections = registrations("sections").map(section => {
      assertMembers(section, ["key", "render", "tag"], "PI_EXTENSION_INVALID_SECTION");
      if (typeof section.key !== "string" || typeof section.render !== "function" ||
          (section.tag !== undefined && typeof section.tag !== "boolean")) throw new Error("PI_EXTENSION_INVALID_SECTION");
      return { key: section.key, tag: section.tag === undefined ? true : section.tag };
    });
    const tools = registrations("tools").map(tool => {
      assertMembers(tool, ["name", "description", "parameters", "execute", "replay", "executionMode", "outputLimits"], "PI_EXTENSION_UNSUPPORTED_TOOL_MEMBER: prepareArguments and constrainedSampling are not supported.");
      if (typeof tool.execute !== "function") throw new Error("PI_EXTENSION_INVALID_TOOL");
      if (tool.outputLimits !== undefined) assertMembers(tool.outputLimits, ["maxBytes", "maxLines", "retain"], "PI_EXTENSION_INVALID_OUTPUT_LIMITS");
      return {
        name: tool.name, description: tool.description, parameters: tool.parameters,
        replay: tool.replay === undefined ? "unsafe" : tool.replay,
        executionMode: tool.executionMode === undefined ? null : tool.executionMode,
        outputLimits: tool.outputLimits === undefined ? null : {
          maxBytes: tool.outputLimits.maxBytes === undefined ? null : tool.outputLimits.maxBytes,
          maxLines: tool.outputLimits.maxLines === undefined ? null : tool.outputLimits.maxLines,
          retain: tool.outputLimits.retain === undefined ? null : tool.outputLimits.retain,
        },
      };
    });
    const supportedHooks = ${JSON.stringify(PI_WORKSPACE_EXTENSION_HOOKS)};
    const hooks = registrations("hooks").map(hook => {
      assertMembers(hook, ["task", "handlers"], "PI_EXTENSION_INVALID_HOOK");
      if (!Object.hasOwn(supportedHooks, hook.task)) throw new Error("PI_EXTENSION_UNSUPPORTED_HOOK_TASK");
      assertMembers(hook.handlers, supportedHooks[hook.task], "PI_EXTENSION_UNSUPPORTED_HOOK");
      if (Object.values(hook.handlers).some(handler => typeof handler !== "function")) throw new Error("PI_EXTENSION_INVALID_HOOK");
      return { task: hook.task, handlers: Object.keys(hook.handlers) };
    });
    if (input.operation === "inspect") return { name: extension.name, sections, tools, hooks };

    const unsupported = (member) => { throw new Error("PI_EXTENSION_UNSUPPORTED_API: " + member); };
    const context = Object.freeze({ abortSignal: undefined, value: () => undefined, toString: () => "Pi workspace extension" });
    const env = Object.freeze({
      id: input.environmentId, cwd: "/workspace",
      readTextFile: async path => await __piWorkspace.readTextFile(path),
      exists: async path => await __piWorkspace.exists(path),
    });
    if (input.operation === "render") {
      const selected = extension.sections?.find(section => section.key === input.key);
      if (!selected) throw new Error("PI_EXTENSION_SECTION_MISSING");
      const rendered = await selected.render({
        conversationId: input.conversationId, env, shown: input.shown,
        get agent() { return unsupported("prompt.agent"); },
        get read() { return unsupported("prompt.read"); },
      }, context);
      if (rendered !== undefined && typeof rendered !== "string") throw new Error("PI_EXTENSION_INVALID_RENDER_RESULT: expected string or undefined.");
      return rendered === undefined ? null : rendered;
    }
    const api = {
      taskId: input.taskId, conversationId: input.conversationId, env,
      memo: async (...args) => {
        const name = args[0];
        return args.length === 2
          ? await __piInvocation.readMemo(name)
          : await __piInvocation.writeMemo(name, args[1]);
      },
      snapshot: () => unsupported("snapshot"), snapshotAsOf: () => unsupported("snapshotAsOf"),
    };
    if (input.operation === "hook") {
      const registration = extension.hooks?.[input.index];
      const handler = registration?.handlers[input.key];
      if (typeof handler !== "function") throw new Error("PI_EXTENSION_HOOK_MISSING");
      const result = await handler.call(registration.handlers, ...input.arguments, Object.freeze(api), context);
      if (result === null) throw new Error("PI_EXTENSION_INVALID_HOOK_RESULT: use undefined to leave behavior unchanged.");
      return result === undefined ? null : result;
    }
    if (input.operation !== "tool") throw new Error("PI_EXTENSION_UNKNOWN_OPERATION");
    const selected = extension.tools?.find(tool => tool.name === input.key);
    if (!selected) throw new Error("PI_EXTENSION_TOOL_MISSING");
    // Native output/diagnostic are synchronous. Serialize RPC reports and join them before ending the guest.
    let reporting = Promise.resolve();
    let reports = 0;
    const report = (operation) => {
      if (++reports > 512) throw new Error("PI_EXTENSION_REPORT_LIMIT_EXCEEDED");
      reporting = reporting.then(operation);
      // The callback may still be running when RPC fails; finally joins and rethrows every reporting failure.
      reporting.catch(() => {});
    };
    Object.assign(api, {
      callId: input.callId, providers: Object.freeze({ ${providerNames.map((name) => `${JSON.stringify(name)}: ${name}`).join(", ")} }),
      output: chunk => {
        if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) throw new Error("PI_EXTENSION_INVALID_OUTPUT");
        report(() => __piInvocation.output(chunk));
      },
      diagnostic: diagnostic => report(() => __piInvocation.diagnostic(diagnostic)),
      details: async value => { await reporting; await __piInvocation.details(value); },
      agent: () => unsupported("agent"), commit: () => unsupported("commit"),
      watchDoc: () => unsupported("watchDoc"), createTask: () => unsupported("createTask"),
      getTask: () => unsupported("getTask"), waitForTask: () => unsupported("waitForTask"),
      conversation: () => unsupported("conversation"),
    });
    Object.defineProperty(api, "registry", { get: () => unsupported("registry") });
    try { return await selected.execute(input.arguments, Object.freeze(api), context); }
    finally { await reporting; }
  }`;
}
