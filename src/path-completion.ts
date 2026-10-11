import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

export interface PathCandidate { name: string; path: string; kind: "directory" | "file" }
export interface PathCompletion { path: string; isDirectory: boolean; entries: PathCandidate[] }

/** Subsequence matching, preferring prefixes, then contiguous/shorter matches. */
export function matchScore(name: string, query: string): number | undefined {
  const text = name.toLowerCase(), needle = query.toLowerCase();
  if (!needle) return 0;
  let first = -1, previous = -1, gaps = 0;
  for (const ch of needle) {
    const index = text.indexOf(ch, previous + 1);
    if (index < 0) return undefined;
    if (first < 0) first = index;
    else gaps += index - previous - 1;
    previous = index;
  }
  return (text.startsWith(needle) ? 0 : 1000) + first * 10 + gaps * 10 + text.length;
}

/** Filesystem-only service: reusable by directory pickers and future file insertion. */
export async function completePath(input: string, base: string, kind: "directory" | "any" = "directory", limit = 5): Promise<PathCompletion> {
  const expanded = input === "~" || input.startsWith("~/") ? homedir() + input.slice(1) : input;
  const path = resolve(base, expanded || ".");
  const browsing = !input || input === "~" || input.endsWith("/");
  const directory = browsing ? path : resolve(base, dirname(expanded));
  const query = browsing ? "" : basename(expanded);
  const listing = await readdir(directory, { withFileTypes: true });
  const names = listing.filter(entry => !entry.name.startsWith(".") || query.startsWith("."));
  const scored = names.map(entry => ({
    name: entry.name, score: matchScore(entry.name, query),
    directory: entry.isDirectory(), symlink: entry.isSymbolicLink(),
  })).filter(entry => entry.score !== undefined);
  const parentScore = query.startsWith(".") ? matchScore("..", query) : undefined;
  if (parentScore !== undefined) scored.push({ name: "..", score: parentScore, directory: true, symlink: false });
  scored.sort((a, b) => a.score! - b.score! || a.name.localeCompare(b.name));
  const entries: PathCandidate[] = [];
  // Only stat matching symlinks; never recursively traverse directories.
  for (const entry of scored) {
    const candidate = resolve(directory, entry.name);
    let isDirectory = entry.directory;
    if (entry.symlink) {
      try { isDirectory = (await stat(candidate)).isDirectory(); } catch { continue; }
    }
    if (kind === "directory" && !isDirectory) continue;
    entries.push({ name: entry.name, path: candidate, kind: isDirectory ? "directory" : "file" });
    if (entries.length >= limit) break;
  }
  let isDirectory = false;
  try { isDirectory = (await stat(path)).isDirectory(); } catch { /* incomplete path */ }
  return { path, isDirectory, entries };
}
