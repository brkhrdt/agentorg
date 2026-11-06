import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { createRequire } from "node:module";

export const tsxImport = createRequire(import.meta.url).resolve("tsx");

export function spawn(command: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdout?: "pipe" | "ignore"; stderr?: "pipe" | "ignore" }) {
  const child = nodeSpawn(command[0], command.slice(1), { ...options, stdio: ["ignore", options.stdout ?? "pipe", options.stderr ?? "pipe"] });
  return {
    stdout: child.stdout ? Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array> : null,
    stderr: child.stderr ? Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array> : null,
    get exitCode() { return child.exitCode; },
    exited: new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); }),
    kill: (signal?: NodeJS.Signals) => child.kill(signal),
  };
}
