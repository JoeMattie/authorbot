import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Read a UTF-8 text file, or undefined when absent/unreadable. */
export async function readTextIfExists(absPath: string): Promise<string | undefined> {
  try {
    return await readFile(absPath, "utf8");
  } catch {
    return undefined;
  }
}

export async function isDirectory(absPath: string): Promise<boolean> {
  try {
    return (await stat(absPath)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirEntries(absPath: string): Promise<Dirent[]> {
  try {
    return await readdir(absPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Minimal glob for repo-relative patterns like `chapters/*.md`
 * (`/`-separated segments, `*` within one segment, no `**`), mirroring the
 * validator's matcher so build and validate agree on which files exist.
 * Returns absolute file paths, sorted.
 */
export async function expandGlob(root: string, pattern: string): Promise<string[]> {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  let matches: string[] = [root];
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    const next: string[] = [];
    if (!segment.includes("*")) {
      for (const base of matches) {
        const candidate = path.join(base, segment);
        try {
          const stats = await stat(candidate);
          if (last ? stats.isFile() : stats.isDirectory()) {
            next.push(candidate);
          }
        } catch {
          // absent: no match
        }
      }
    } else {
      const regex = new RegExp(`^${segment.split("*").map(escapeRegExp).join("[^/]*")}$`);
      for (const base of matches) {
        for (const entry of await listDirEntries(base)) {
          if (!regex.test(entry.name)) {
            continue;
          }
          const candidate = path.join(base, entry.name);
          let isFile = entry.isFile();
          let isDir = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            try {
              const stats = await stat(candidate);
              isFile = stats.isFile();
              isDir = stats.isDirectory();
            } catch {
              continue; // dangling symlink
            }
          }
          if (last ? isFile : isDir) {
            next.push(candidate);
          }
        }
      }
    }
    matches = next;
  }
  return matches.sort();
}
