import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Organization } from "../src/organization.ts";
import { completePath, matchScore } from "../src/path-completion.ts";

test("path discovery lists five directories, fuzzy filters, hides dotfiles and follows directory symlinks", async () => {
  const base = await mkdtemp(join(tmpdir(), "path-completion-"));
  try {
    for (const name of ["alpha", "beta", "charlie", "delta", "echo", "foxtrot", "scripts", "src", ".hidden", "with spaces"])
      await mkdir(join(base, name));
    await mkdir(join(base, "src", "nested"));
    await writeFile(join(base, "source.ts"), "");
    await symlink(join(base, "src"), join(base, "linked"));
    await symlink(join(base, "source.ts"), join(base, "linked-file"));
    await symlink(join(base, "missing"), join(base, "broken"));
    const defaults = await completePath("./", base);
    expect(defaults.path).toBe(base);
    expect(defaults.isDirectory).toBe(true);
    expect(defaults.entries.map(e => e.name)).toEqual(["alpha", "beta", "charlie", "delta", "echo"]);
    expect((await completePath("sr", base)).entries.map(e => e.name)).toEqual(["src", "scripts"]);
    expect((await completePath("scpt", base)).entries[0].name).toBe("scripts");
    expect((await completePath("./src/", base)).entries).toEqual([{ name: "nested", path: join(base, "src", "nested"), kind: "directory" }]);
    expect((await completePath(join(base, "src") + "/", "/")).entries[0].name).toBe("nested");
    expect((await completePath("../", join(base, "src"))).path).toBe(base);
    expect((await completePath("..", join(base, "src"))).entries[0].path).toBe(base);
    expect((await completePath(".", base)).entries.map(e => e.name)).toContain(".hidden");
    expect((await completePath(".h", base)).entries.map(e => e.name)).toEqual([".hidden"]);
    expect((await completePath("lnk", base)).entries.map(e => e.name)).toEqual(["linked"]);
    expect((await completePath("linked/", base)).entries[0].name).toBe("nested");
    expect((await completePath("with spaces", base)).isDirectory).toBe(true);
    expect((await completePath("not-found", base)).isDirectory).toBe(false);
    expect((await completePath("source", base, "any")).entries[0].kind).toBe("file");
    expect((await completePath("~/", base)).path).toBe(homedir());
    expect((await completePath("~", base)).isDirectory).toBe(true);
    expect(matchScore("SRC", "sr")).toBe(matchScore("src", "SR"));
    expect(matchScore("scripts", "xyz")).toBeUndefined();
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("path endpoint advertises startup cwd, validates requests and allows explicit client directory creation", async () => {
  const base = await mkdtemp(join(tmpdir(), "path-endpoint-"));
  const org = new Organization(join(base, "server.sock"), base);
  try {
    await mkdir(join(base, "child"));
    const capabilities = (await org.request("organization.snapshot") as any).capabilities;
    expect(capabilities.cwd).toBe(process.cwd());
    expect(capabilities.pathCompletion).toBe(true);
    expect(await org.request("organization.paths", { base, input: "./" })).toMatchObject({ path: base, isDirectory: true, entries: [{ name: "child" }] });
    expect((await org.request("organization.paths") as any).path).toBe(resolve("."));
    await expect(org.request("organization.paths", { base, input: "missing/" })).rejects.toMatchObject({ code: "INVALID_PATH" });
    const created = await org.request("organization.paths", { base, input: "new/nested", create: true }) as any;
    expect(created).toMatchObject({ path: join(base, "new/nested"), isDirectory: true });
    expect((await stat(join(base, "new/nested"))).isDirectory()).toBe(true);
    for (const params of [{ limit: 0 }, { limit: 51 }, { kind: "invalid" }, { input: 4 }, { input: "\0" }, { base: "" }, { create: "yes" }])
      await expect(org.request("organization.paths", params)).rejects.toThrow();
    await expect(org.request("organization.paths", { base }, { kind: "agent", id: "agent" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(org.agents.size).toBe(0);
    expect(org.operations.size).toBe(0);
  } finally { await org.close(); await rm(base, { recursive: true, force: true }); }
});
