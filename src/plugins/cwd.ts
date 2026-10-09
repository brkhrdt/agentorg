import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { PluginHost, ServerPlugin } from "../plugin.ts";
import { ApiError, type AgentRecord, type Settings } from "../types.ts";

async function directory(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("Not a directory");
    return canonical;
  } catch {
    throw new ApiError(
      "INVALID_PARAMS",
      `cwd must be an existing directory: ${path}`,
    );
  }
}

function requireChild(parent: string, child: string) {
  const path = relative(parent, child);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new ApiError(
      "INVALID_PARAMS",
      "cwd must be a strict subdirectory of the parent's cwd (after resolving symlinks)",
    );
}

export const cwdPlugin: ServerPlugin = {
  apiVersion: 1,
  name: "cwd",
  setup(host: PluginHost) {
    host.transformTool("child_create", (tool) => {
      const properties = { ...tool.inputSchema.properties };
      // cwd has one unambiguous location in this tool: the required top-level argument.
      const settings = properties.settings as {
        properties: Record<string, unknown>;
      };
      const { cwd: _cwd, ...settingsProperties } = settings.properties;
      properties.settings = { ...settings, properties: settingsProperties };
      properties.cwd = {
        type: "string",
        minLength: 1,
        description:
          "Existing strict subdirectory of your cwd; relative paths resolve from your cwd. Symlinks are resolved.",
      };
      return {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties,
          required: [...new Set([...(tool.inputSchema.required ?? []), "cwd"])],
        },
        execute(args, caller, api) {
          const { cwd, settings, ...rest } = z
            .object({
              cwd: z.string().min(1),
              settings: z.record(z.string(), z.unknown()),
            })
            .passthrough()
            .parse(args);
          if ("cwd" in settings)
            throw new ApiError(
              "INVALID_PARAMS",
              "Use the top-level cwd argument, not settings.cwd",
            );
          return tool.execute(
            { ...rest, settings: { ...settings, cwd } },
            caller,
            api,
          );
        },
      };
    });

    const caller = { kind: "server", id: "cwd" } as const;
    async function validate(
      settings: Settings,
      agent: Readonly<AgentRecord>,
      checkChildren = true,
    ) {
      let parentCwd: string | undefined;
      if (agent.parentId) {
        const parent = await host.request(
          "agent.get",
          { agentId: agent.parentId },
          caller,
        ) as AgentRecord;
        parentCwd = await directory(parent.settings.cwd ?? process.cwd());
        if (!settings.cwd)
          throw new ApiError("INVALID_PARAMS", "Child agents require cwd");
      }
      const cwd = await directory(
        resolve(parentCwd ?? process.cwd(), settings.cwd ?? "."),
      );
      if (parentCwd) requireChild(parentCwd, cwd);
      // Changing a parent's cwd must not invalidate any existing child's containment.
      if (checkChildren) {
        const snapshot = await host.request(
          "organization.snapshot", {}, caller,
        ) as { agents: AgentRecord[] };
        for (const child of snapshot.agents) {
          if (!child.removedAt && child.parentId === agent.id)
            requireChild(
              cwd,
              await directory(child.settings.cwd ?? process.cwd()),
            );
        }
      }
      return { ...settings, cwd };
    }

    host.beforeSettings(validate);
    host.beforeLaunch(async (spec, { agent }) => {
      // Recheck at every startup/recovery in case the filesystem changed since persistence.
      const settings = await validate(agent.settings, agent, false);
      return { ...spec, cwd: settings.cwd };
    });
  },
};

export default cwdPlugin;
