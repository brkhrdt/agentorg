import { structuredPatch, formatPatch, OMIT_HEADERS } from "diff";

export interface EditDiff {
  text: string;
  before: string[];
  after: string[];
  regions: number;
  relative: boolean;
  incomplete: boolean;
}
const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const lines = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");

/** Render retained text only; never read the current filesystem to reconstruct history. */
export function editDiff(input: Record<string, any>, details: Record<string, any>): EditDiff | undefined {
  const supplied = typeof details.patch === "string" ? details.patch : typeof details.diff === "string" ? details.diff : undefined;
  const rawEdits = (Array.isArray(input.edits) ? input.edits : [input]).map(object);
  const edits = rawEdits.filter((edit): edit is { oldText: string; newText: string } => typeof edit.oldText === "string" && typeof edit.newText === "string");
  if (supplied === undefined && !edits.length) return;
  let text = supplied ?? "", incomplete = supplied === undefined && edits.length !== rawEdits.length;
  if (supplied === undefined) {
    // Bound quadratic diff work. Large replacements degrade to an explicit replacement diff.
    text = edits.slice(0, 64).map((edit, index) => {
      const oldText = edit.oldText.replace(/\r\n?/g, "\n"), newText = edit.newText.replace(/\r\n?/g, "\n");
      const patch = structuredPatch("", "", oldText, newText, undefined, undefined, { context: 3, maxEditLength: 256 });
      const body = patch ? formatPatch(patch, OMIT_HEADERS).replace(/\n$/, "") || "(no text changes)" : [
        "(large replacement; simplified diff)",
        ...(oldText ? lines(oldText).map(line => `-${line}`) : []),
        ...(newText ? lines(newText).map(line => `+${line}`) : []),
      ].join("\n");
      return `${edits.length > 1 ? `Replacement ${index + 1}\n` : ""}${body}`;
    }).join("\n\n");
    if (edits.length > 64) { text += "\n[Additional regions omitted; see raw event]"; incomplete = true; }
  }
  const numbered = supplied !== undefined && details.patch === undefined && typeof details.firstChangedLine === "number";
  const before: string[] = [], after: string[] = [];
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    if (supplied !== undefined && !inHunk && /^(--- |\+\+\+ )/.test(line)) continue;
    if (!line.startsWith("-") && !line.startsWith("+")) continue;
    const value = numbered ? line.slice(1).replace(/^\s*\d+ /, "") : line.slice(1);
    (line.startsWith("-") ? before : after).push(value);
  }
  return { text, before, after, regions: edits.length || Math.max(1, (text.match(/^@@ /gm) ?? []).length), relative: supplied === undefined, incomplete };
}
