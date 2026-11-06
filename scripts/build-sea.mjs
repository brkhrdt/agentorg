import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const seaFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
if (!(await readFile(process.execPath)).includes(Buffer.from(seaFuse))) {
  throw new Error(`Node ${process.version} has no SEA fuse sentinel; build standalone binaries with a Node 22.14+ executable that supports SEA injection.`);
}
const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });
const entry = resolve(dist, "agentorg.cjs");
await build({ entryPoints: [resolve(root, "src/standalone.ts")], outfile: entry, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["node:*"], banner: { js: "globalThis.require ??= process.getBuiltinModule('node:module').createRequire(process.cwd() + '/');" } });
const config = resolve(dist, "sea-config.json");
await writeFile(config, JSON.stringify({ main: entry, output: resolve(dist, "sea-prep.blob"), useSnapshot: false, useCodeCache: false }));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
};
run(process.execPath, ["--experimental-sea-config", config]);
const binary = resolve(dist, "agentorg");
await copyFile(process.execPath, binary);
const injection = spawnSync("npx", ["--no-install", "postject", binary, "NODE_SEA_BLOB", resolve(dist, "sea-prep.blob"), "--sentinel-fuse", seaFuse], { cwd: root, stdio: "inherit" });
if (injection.status !== 0) {
  throw new Error("SEA injection failed; refusing to produce a non-standalone launcher fallback.");
}
