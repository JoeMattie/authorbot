/**
 * Project-scoped browser state shared by collaboration islands.
 *
 * This is intentionally the vanilla Zustand store: Authorbot remains a
 * framework-free custom-element site. Existing islands can continue using
 * CollabApi while they are migrated one at a time; the chapter activity rail
 * is the first consumer. Nothing in this store is persisted, which keeps
 * credentials and future lease tokens out of browser storage.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  CollabApi,
  type ApiResult,
  type ChapterProjection,
  type Me,
} from "./api.js";

export type ResourceStatus = "idle" | "loading" | "ready" | "error";

export interface ProjectStoreConfig {
  apiBase: string;
  project: string;
}

/** The narrow API seam keeps the store independently testable. */
export interface ProjectStoreApi {
  meResult(): Promise<ApiResult<Me | null>>;
  chapters(): Promise<ApiResult<ChapterProjection[]>>;
}

export interface ProjectStoreState {
  session: Me | null;
  sessionStatus: ResourceStatus;
  sessionError: string | null;
  chaptersById: Readonly<Record<string, ChapterProjection>>;
  chapterIds: readonly string[];
  chaptersStatus: ResourceStatus;
  chaptersError: string | null;
  ensureSession(): Promise<void>;
  refreshSession(): Promise<void>;
  ensureChapters(): Promise<void>;
  refreshChapters(): Promise<void>;
}

export type ProjectStore = StoreApi<ProjectStoreState>;

export function createProjectStore(
  config: ProjectStoreConfig,
  api: ProjectStoreApi = new CollabApi(config.apiBase, config.project),
): ProjectStore {
  let sessionRequest: Promise<void> | null = null;
  let chaptersRequest: Promise<void> | null = null;
  let store!: ProjectStore;

  const loadSession = (force: boolean): Promise<void> => {
    const current = store.getState();
    if (!force && current.sessionStatus === "ready") {
      return Promise.resolve();
    }
    if (sessionRequest !== null) {
      return sessionRequest;
    }
    store.setState({ sessionStatus: "loading", sessionError: null });
    sessionRequest = (async () => {
      const result = await api.meResult();
      if (result.ok) {
        store.setState({
          session: result.value,
          sessionStatus: "ready",
          sessionError: null,
        });
      } else {
        store.setState({
          session: null,
          sessionStatus: "error",
          sessionError: result.message,
        });
      }
    })().finally(() => {
      sessionRequest = null;
    });
    return sessionRequest;
  };

  const loadChapters = (force: boolean): Promise<void> => {
    const current = store.getState();
    if (!force && current.chaptersStatus === "ready") {
      return Promise.resolve();
    }
    if (chaptersRequest !== null) {
      return chaptersRequest;
    }
    store.setState({ chaptersStatus: "loading", chaptersError: null });
    chaptersRequest = (async () => {
      const result = await api.chapters();
      if (!result.ok) {
        store.setState({
          chaptersStatus: "error",
          chaptersError: result.message,
        });
        return;
      }
      const chaptersById: Record<string, ChapterProjection> = {};
      for (const chapter of result.value) {
        chaptersById[chapter.id] = chapter;
      }
      store.setState({
        chaptersById,
        chapterIds: result.value.map((chapter) => chapter.id),
        chaptersStatus: "ready",
        chaptersError: null,
      });
    })().finally(() => {
      chaptersRequest = null;
    });
    return chaptersRequest;
  };

  store = createStore<ProjectStoreState>()(() => ({
    session: null,
    sessionStatus: "idle",
    sessionError: null,
    chaptersById: {},
    chapterIds: [],
    chaptersStatus: "idle",
    chaptersError: null,
    ensureSession: () => loadSession(false),
    refreshSession: () => loadSession(true),
    ensureChapters: () => loadChapters(false),
    refreshChapters: () => loadChapters(true),
  }));
  return store;
}

const projectStores = new Map<string, ProjectStore>();

/** One in-memory store per API base and project for the lifetime of the page. */
export function getProjectStore(config: ProjectStoreConfig): ProjectStore {
  const key = JSON.stringify([config.apiBase, config.project]);
  const existing = projectStores.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = createProjectStore(config);
  projectStores.set(key, created);
  return created;
}

/** Test isolation for the module-level page registry. */
export function resetProjectStoresForTests(): void {
  projectStores.clear();
}
