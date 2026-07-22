/**
 * Decorates every statically rendered chapter label on the page with the
 * caller-authorized activity returned by the shared chapter projection read.
 */
import type { ChapterActivity } from "./api.js";
import { el } from "./dom.js";
import type { ProjectStore, ProjectStoreState } from "./project-store.js";
import { loadProjectStore } from "./project-store-loader.js";

interface Config {
  apiBase: string;
  project: string;
}

type ActivityKey = keyof ChapterActivity;

interface BadgeDefinition {
  key: ActivityKey;
  shortLabel: string;
  accessibleLabel(count: number): string;
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const BADGES: readonly BadgeDefinition[] = [
  {
    key: "openSuggestions",
    shortLabel: "Suggestions",
    accessibleLabel: (count) => plural(count, "open suggestion", "open suggestions"),
  },
  {
    key: "openBlockComments",
    shortLabel: "Block",
    accessibleLabel: (count) => plural(count, "open block comment", "open block comments"),
  },
  {
    key: "openChapterComments",
    shortLabel: "Chapter",
    accessibleLabel: (count) =>
      plural(count, "open whole-chapter comment", "open whole-chapter comments"),
  },
  {
    key: "openReplies",
    shortLabel: "Replies",
    accessibleLabel: (count) => plural(count, "open reply", "open replies"),
  },
  {
    key: "openWorkItems",
    shortLabel: "Work",
    accessibleLabel: (count) => plural(count, "open work item", "open work items"),
  },
] as const;

function parseConfig(host: HTMLElement): Config | null {
  const { apiBase, project } = host.dataset;
  if (apiBase === undefined || project === undefined) {
    return null;
  }
  return { apiBase, project };
}

function visibleEntries(activity: ChapterActivity | undefined): Array<{
  definition: BadgeDefinition;
  count: number;
  label: string;
}> {
  if (activity === undefined) {
    return [];
  }
  return BADGES.flatMap((definition) => {
    const count = activity[definition.key];
    // Treat malformed, missing, unauthorized, and zero values as quiet. The
    // API is authoritative, but defensive rendering must never advertise a
    // negative or fractional count from a mixed-version deployment.
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) {
      return [];
    }
    return [
      {
        definition,
        count,
        label: definition.accessibleLabel(count),
      },
    ];
  });
}

export function createChapterActivityGroup(
  activity: ChapterActivity,
): HTMLSpanElement | null {
  const entries = visibleEntries(activity);
  if (entries.length === 0) {
    return null;
  }
  const group = el("span", "ab-chapter-activity");
  group.setAttribute("role", "list");
  group.setAttribute(
    "aria-label",
    `Chapter activity: ${entries.map((entry) => entry.label).join(", ")}`,
  );
  for (const { definition, count, label } of entries) {
    const badge = el(
      "span",
      `ab-chapter-activity-badge ab-chapter-activity-${definition.key}`,
    );
    badge.setAttribute("role", "listitem");
    badge.setAttribute("aria-label", label);
    const category = el("span", "ab-chapter-activity-label", definition.shortLabel);
    category.setAttribute("aria-hidden", "true");
    const value = el("span", "ab-chapter-activity-count", String(count));
    value.setAttribute("aria-hidden", "true");
    badge.append(category, value);
    group.append(badge);
  }
  return group;
}

export class AuthorbotChapterActivity extends HTMLElement {
  private store: ProjectStore | null = null;
  private unsubscribe: (() => void) | null = null;
  private releaseConnection: (() => void) | null = null;
  private started = false;
  private mountGeneration = 0;
  private renderedChapters: ProjectStoreState["chaptersById"] | null = null;

  connectedCallback(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    const generation = ++this.mountGeneration;
    const config = parseConfig(this);
    if (config === null) {
      return;
    }
    void this.connectStore(config, generation);
  }

  private async connectStore(config: Config, generation: number): Promise<void> {
    let store: ProjectStore;
    try {
      store = await loadProjectStore(config);
    } catch {
      // Leave the server-rendered chapter rows untouched when the shared
      // projection chunk remains unavailable after its bounded retry.
      return;
    }
    if (!this.isCurrentMount(generation)) return;
    this.store = store;
    this.unsubscribe = store.subscribe(() => {
      if (this.isCurrentMount(generation)) this.render();
    });
    this.render();
    await this.load(generation, store);
  }

  disconnectedCallback(): void {
    this.started = false;
    this.mountGeneration += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.releaseConnection?.();
    this.releaseConnection = null;
    this.renderedChapters = null;
  }

  private isCurrentMount(generation: number): boolean {
    return this.started && this.isConnected && this.mountGeneration === generation;
  }

  private async load(generation: number, store: ProjectStore): Promise<void> {
    await store.getState().ensureSession();
    if (!this.isCurrentMount(generation)) return;
    if (store.getState().session === null) {
      return;
    }
    await store.getState().ensureChapters();
    if (!this.isCurrentMount(generation)) return;
    this.releaseConnection = store.getState().retainConnection();
  }

  private render(): void {
    if (this.store === null) {
      return;
    }
    const { chaptersById } = this.store.getState();
    if (this.renderedChapters === chaptersById) return;
    this.renderedChapters = chaptersById;
    for (const row of document.querySelectorAll<HTMLElement>("[data-chapter-activity-id]")) {
      const slot = row.querySelector<HTMLElement>("[data-chapter-activity-slot]");
      if (slot === null) {
        continue;
      }
      slot.replaceChildren();
      const chapterId = row.dataset["chapterActivityId"];
      const activity = chapterId === undefined ? undefined : chaptersById[chapterId]?.activity;
      const group = activity === undefined ? null : createChapterActivityGroup(activity);
      slot.hidden = group === null;
      if (group !== null) {
        slot.append(group);
      }
    }
  }
}
