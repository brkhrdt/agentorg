import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { OrganizationServer } from "./server.ts";
import { piPlugin } from "./plugins/pi.ts";
import type { ServerPlugin } from "./plugin.ts";
import { defaults, type Limits } from "./types.ts";

const { values } = parseArgs({
  options: {
    socket: { type: "string" },
    "data-dir": { type: "string", default: ".org" },
    config: { type: "string" },
    plugin: { type: "string", multiple: true },
    recover: { type: "boolean", default: false },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "bun src/cli.ts [--data-dir .org] [--socket PATH] [--config limits.json] [--recover] [--plugin ./plugin.ts]",
  );
  process.exit(0);
}
const dataDir = resolve(values["data-dir"]!);
let limits: Partial<Limits> = {};
if (values.config) {
  const schema = z
    .object(
      Object.fromEntries(
        Object.keys(defaults).map((key) => [
          key,
          z.number().int().positive().optional(),
        ]),
      ),
    )
    .strict();
  limits = schema.parse(
    JSON.parse(await readFile(values.config, "utf8")),
  ) as Partial<Limits>;
}
const plugins: ServerPlugin[] = [piPlugin];
for (const path of values.plugin ?? [])
  plugins.push((await import(pathToFileURL(resolve(path)).href)).default);
const server = await OrganizationServer.start({
  dataDir,
  socketPath: values.socket ?? join(dataDir, "server.sock"),
  limits,
  plugins,
  recover: values.recover,
});
console.error(
  `Organization server listening on ${server.organization.socketPath}`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void server.close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
