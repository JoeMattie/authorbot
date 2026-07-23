/** Stable fragment contract shared by static contributor links and History. */
const PREFIX = "#authorbot-history-revision-";

export function chapterHistoryHash(revision: number): string {
  return `${PREFIX}${String(revision)}`;
}

export function chapterHistoryRevisionFromHash(hash: string): number | null {
  if (!hash.startsWith(PREFIX)) return null;
  const revision = Number(hash.slice(PREFIX.length));
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}
