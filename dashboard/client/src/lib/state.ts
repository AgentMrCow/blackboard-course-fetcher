import { get, writable } from "svelte/store";
import type { AppState, RouteState, ToastMessage } from "./types";

export function routeFromHash(hash = window.location.hash): RouteState {
  const parts = (hash.replace(/^#\/?/, "") || "home").split("/").map(decodeURIComponent);
  return { page: parts[0] || "home", id: parts[1], tab: parts[2] || "overview" };
}

const initialState: AppState = {
  bootstrap: null,
  loading: true,
  fatalError: "",
  route: typeof window === "undefined" ? { page: "home" } : routeFromHash(),
  courseCache: new Map(),
  selectedCourses: new Set(),
  courseFilters: { query: "", term: "all", status: "all", view: "all" },
  fileFilters: { query: "", preview: "all", courseId: "", scope: "materials" },
  allFiles: null,
  filesLoading: false,
  filePage: 0,
  filePageSize: 250,
  fileView: "table",
  calendarCursor: new Date(),
  logTaskId: null,
  mobileNavOpen: false,
  setupOpen: false,
  setupStep: 0,
  fetchOpen: false,
  fetchCourseIds: [],
  searchOpen: false,
  searchQuery: "",
  searchLoading: false,
  searchResults: [],
  fileDialog: {
    open: false,
    loading: false,
    courseId: "",
    file: null,
    text: "",
    parsed: null,
    link: "",
    error: "",
  },
  detailDialog: {
    open: false,
    kind: null,
    eyebrow: "Details",
    title: "Item details",
  },
  toasts: [],
};

export const appState = writable<AppState>(initialState);

export function readState(): AppState {
  return get(appState);
}

export function changeState(change: (state: AppState) => void): void {
  appState.update((state) => {
    change(state);
    return { ...state };
  });
}

let toastSequence = 0;

export function showToast(message: string, type: ToastMessage["type"] = "info"): void {
  const toast: ToastMessage = { id: ++toastSequence, message, type };
  changeState((state) => state.toasts.push(toast));
  window.setTimeout(() => {
    changeState((state) => {
      state.toasts = state.toasts.filter((item) => item.id !== toast.id);
    });
  }, 4_500);
}

export function navigate(path: string): void {
  const normalized = path.startsWith("#/") ? path : `#/${path.replace(/^\/?/, "")}`;
  if (window.location.hash === normalized) {
    changeState((state) => {
      state.route = routeFromHash(normalized);
      state.mobileNavOpen = false;
    });
    return;
  }
  window.location.hash = normalized;
}
