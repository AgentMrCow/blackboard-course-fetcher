import { api } from "./api";
import { fileEndpoint } from "./format";
import { appState, changeState, navigate, readState, routeFromHash, showToast } from "./state";
import type { ArchiveFile, Bootstrap, CourseDetail, FetchBatch, FileDialogState, FilePage, FileScope, JsonRecord, SearchResult } from "./types";

let events: EventSource | null = null;
let fileLoadSequence = 0;

export function activeBatch(bootstrap = readState().bootstrap): FetchBatch | null {
  return bootstrap?.jobs?.find((job) => ["queued", "running", "paused"].includes(job.status)) || null;
}

export function filteredCourses() {
  const state = readState();
  const { query, term, status, view } = state.courseFilters;
  return (state.bootstrap?.inventory.courses || []).filter((course) => {
    if (query && !`${course.name} ${course.code} ${course.termName}`.toLowerCase().includes(query.toLowerCase())) return false;
    if (term !== "all" && course.termName !== term) return false;
    if (status !== "all" && course.archive.status !== status) return false;
    if (view !== "all" && String(course.view).toLowerCase() !== view) return false;
    return true;
  });
}

export async function ensureCourse(courseId: string, force = false): Promise<CourseDetail> {
  const cached = readState().courseCache.get(courseId);
  if (!force && cached) return cached;
  const detail = await api<CourseDetail>(`/api/courses/${encodeURIComponent(courseId)}`);
  changeState((state) => state.courseCache.set(courseId, detail));
  return detail;
}

export async function refreshBootstrap(showSuccess = false): Promise<void> {
  const bootstrap = await api<Bootstrap>(`/api/bootstrap${showSuccess ? "?refresh=1" : ""}`);
  changeState((state) => {
    state.bootstrap = bootstrap;
    state.courseCache.clear();
    state.allFiles = null;
    state.loading = false;
    state.fatalError = "";
  });
  if (showSuccess) showToast("Local archive data refreshed.", "success");
}

function fileListParameters(): URLSearchParams {
  const state = readState();
  const params = new URLSearchParams({
    offset: String(state.filePage * state.filePageSize),
    limit: String(state.filePageSize),
  });
  if (state.fileFilters.query) params.set("q", state.fileFilters.query);
  if (state.fileFilters.preview !== "all") params.set("preview", state.fileFilters.preview);
  if (state.fileFilters.courseId) params.set("courseId", state.fileFilters.courseId);
  params.set("scope", state.fileFilters.scope);
  return params;
}

export async function loadAllFiles(force = false): Promise<void> {
  const state = readState();
  if (!force && (state.filesLoading || state.allFiles)) return;
  const sequence = ++fileLoadSequence;
  changeState((current) => current.filesLoading = true);
  try {
    while (sequence === fileLoadSequence) {
      const params = fileListParameters().toString();
      let page: FilePage;
      try {
        page = await api<FilePage>(`/api/files?${params}`);
      } catch (error) {
        if (sequence !== fileLoadSequence) return;
        if (params !== fileListParameters().toString()) continue;
        throw error;
      }
      if (sequence !== fileLoadSequence) return;
      if (params !== fileListParameters().toString()) continue;
      changeState((current) => current.allFiles = page);
      return;
    }
  } finally {
    if (sequence === fileLoadSequence) changeState((current) => current.filesLoading = false);
  }
}

export function setFileFilters(values: Partial<{ query: string; preview: string; courseId: string; scope: FileScope }>): void {
  changeState((state) => {
    Object.assign(state.fileFilters, values);
    state.filePage = 0;
    state.allFiles = null;
  });
}

export function openSetup(step: number | null = null): void {
  const state = readState();
  if (!state.bootstrap) return;
  const completion = setupCompletion(state.bootstrap);
  changeState((current) => {
    current.setupStep = step == null ? Math.max(0, completion.findIndex((complete) => !complete)) : step;
    if (step == null && completion.every(Boolean)) current.setupStep = 3;
    current.setupOpen = true;
  });
}

export function setupCompletion(bootstrap: Bootstrap): boolean[] {
  const { settings, auth, inventory, summary } = bootstrap;
  return [
    Boolean(settings.blackboardBase && settings.archiveRoot && settings.stateFile),
    auth.validation?.valid === true || auth.status === "connected",
    Boolean(inventory.generatedAt && inventory.courses.length),
    Boolean(summary.archivedCount),
  ];
}

export function openFetch(courseIds: string[]): void {
  const state = readState();
  const unique = [...new Set(courseIds)].filter((id) => state.bootstrap?.inventory.courses.some((course) => course.id === id));
  if (!unique.length) {
    navigate("courses");
    showToast("Select one or more courses before starting a fetch.");
    return;
  }
  if (!(state.bootstrap?.auth?.validation?.valid || state.bootstrap?.auth?.status === "connected")) {
    openSetup(1);
    showToast("Verify the Blackboard session before fetching.", "error");
    return;
  }
  changeState((current) => {
    current.fetchCourseIds = unique;
    current.fetchOpen = true;
  });
}

export async function startFetch(payload: JsonRecord): Promise<void> {
  const state = readState();
  const batch = await api<FetchBatch>("/api/fetch", {
    method: "POST",
    body: { ...payload, courseIds: state.fetchCourseIds },
  });
  changeState((current) => {
    if (current.bootstrap && !current.bootstrap.jobs.some((job) => job.id === batch.id)) {
      current.bootstrap.jobs.unshift(batch);
    }
    current.selectedCourses.clear();
    current.fetchOpen = false;
  });
  navigate("activity");
  showToast("Fetch batch started.", "success");
}

export async function saveSettings(form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const settings = await api<JsonRecord>("/api/settings", {
    method: "POST",
    body: {
      blackboardBase: data.get("blackboardBase"),
      archiveRoot: data.get("archiveRoot"),
      stateFile: data.get("stateFile"),
      courseConcurrency: Number(data.get("courseConcurrency")),
      attachmentConcurrency: Number(data.get("attachmentConcurrency")),
    },
  });
  changeState((state) => {
    if (state.bootstrap) state.bootstrap.settings = settings;
  });
  await refreshBootstrap();
  showToast("Dashboard settings saved.", "success");
}

export async function checkAuth(): Promise<void> {
  const auth = await api<JsonRecord>("/api/auth/check", { method: "POST" });
  changeState((state) => {
    if (state.bootstrap) state.bootstrap.auth = auth;
  });
  showToast(auth.validation?.valid ? "Blackboard session is valid." : auth.message || "Session check failed.", auth.validation?.valid ? "success" : "error");
}

export async function authAction(action: "start" | "save" | "cancel"): Promise<void> {
  const auth = await api<JsonRecord>(`/api/auth/${action}`, { method: "POST" });
  changeState((state) => {
    if (state.bootstrap) state.bootstrap.auth = auth;
  });
}

export async function runInventory(): Promise<void> {
  const task = await api<JsonRecord>("/api/inventory", { method: "POST" });
  changeState((state) => {
    if (state.bootstrap) state.bootstrap.inventoryTask = task;
  });
  showToast("Course inventory started.");
}

export async function cancelInventory(): Promise<void> {
  const task = await api<JsonRecord>("/api/inventory/cancel", { method: "POST" });
  changeState((state) => {
    if (state.bootstrap) state.bootstrap.inventoryTask = task;
  });
}

export async function controlBatch(batchId: string, action: string): Promise<void> {
  const batch = await api<FetchBatch>(`/api/jobs/${encodeURIComponent(batchId)}/${action}`, { method: "POST" });
  replaceBatch(batch);
}

export async function controlTask(batchId: string, courseId: string, action: string): Promise<void> {
  const batch = await api<FetchBatch>(`/api/jobs/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(courseId)}/${action}`, { method: "POST" });
  replaceBatch(batch);
}

function replaceBatch(batch: FetchBatch): void {
  changeState((state) => {
    if (!state.bootstrap) return;
    const index = state.bootstrap.jobs.findIndex((item) => item.id === batch.id);
    if (index >= 0) state.bootstrap.jobs[index] = batch;
  });
}

function fileMeta(courseId: string, filePath: string): ArchiveFile {
  const state = readState();
  const searchResult = state.searchResults.find(
    (result) => result.type === "file" && result.courseId === courseId && result.path === filePath
  );
  return state.courseCache.get(courseId)?.files.find((file) => file.path === filePath)
    || state.allFiles?.files.find((file) => file.courseId === courseId && file.path === filePath)
    || state.bootstrap?.summary.recentFiles?.find((file: ArchiveFile) => file.courseId === courseId && file.path === filePath)
    || (searchResult?.name && searchResult.preview && searchResult.origin && searchResult.role
      && searchResult.primaryPath && searchResult.groupKey
      && searchResult.hiddenByDefault !== undefined && searchResult.searchable !== undefined
      ? searchResult as ArchiveFile
      : null)
    || {
      path: filePath,
      name: filePath.split("/").at(-1) || filePath,
      preview: "download",
      size: null,
      category: "Course records",
      origin: "local-file",
      role: "local-file",
      hiddenByDefault: false,
      searchable: true,
      primaryPath: filePath,
      groupKey: filePath,
    };
}

export async function openFile(courseId: string, filePath: string): Promise<void> {
  const file = fileMeta(courseId, filePath);
  const dialog: FileDialogState = { open: true, loading: true, courseId, file, text: "", parsed: null, link: "", error: "" };
  changeState((state) => {
    state.fileDialog = dialog;
    state.detailDialog.open = false;
  });
  if (!["text", "json", "link", "placeholder", "unresolved"].includes(file.preview)) {
    changeState((state) => state.fileDialog.loading = false);
    return;
  }
  try {
    const response = await fetch(fileEndpoint(courseId, filePath));
    if (readState().fileDialog !== dialog || !dialog.open) return;
    if (!response.ok) throw new Error(`Unable to read file: HTTP ${response.status}`);
    let text = await response.text();
    let parsed: JsonRecord | null = null;
    if (["json", "placeholder", "unresolved"].includes(file.preview)) {
      try {
        parsed = JSON.parse(text);
        text = JSON.stringify(parsed, null, 2);
      } catch {
        parsed = null;
      }
    }
    const link = file.preview === "link" ? text.match(/^URL=(.+)$/im)?.[1]?.trim() || "" : "";
    changeState((state) => {
      if (state.fileDialog === dialog && dialog.open) Object.assign(dialog, { loading: false, text, parsed, link });
    });
  } catch (error) {
    changeState((state) => {
      if (state.fileDialog === dialog && dialog.open) {
        Object.assign(dialog, { loading: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}

export async function openAssignment(courseId: string, contentId: string): Promise<void> {
  const detail = await ensureCourse(courseId);
  const assessment = detail.assessments.find((item) => String(item.contentId || item.columnId) === String(contentId));
  if (!assessment) throw new Error("Assessment details were not found in the local manifest");
  const relatedFiles = detail.files.filter((file) => assessment.directory && (file.path === assessment.directory || file.path.startsWith(`${assessment.directory}/`)));
  const files = relatedFiles.filter((file) => file.hiddenByDefault !== true);
  const instructionFile = relatedFiles.find((file) => file.path === assessment.instructions?.textPath)
    || relatedFiles.find((file) => file.role === "instructions-search-text")
    || relatedFiles.find((file) => /\/instructions\.txt$/i.test(file.path));
  const instructionHtmlPath = assessment.instructions?.htmlPath
    || instructionFile?.primaryPath
    || relatedFiles.find((file) => file.role === "instructions-rendered")?.path;
  changeState((state) => {
    state.detailDialog = {
      open: true,
      kind: "assignment",
      eyebrow: `${detail.course.code} · ${assessment.isGroup ? "Group" : "Individual"} assessment`,
      title: assessment.title,
      courseDetail: detail,
      item: assessment,
      files,
      instructions: instructionFile ? "Loading archived instructions..." : "No plain-text instructions file was found.",
      instructionHtmlPath,
    };
  });
  if (instructionFile) {
    fetch(fileEndpoint(courseId, instructionFile.path))
      .then((response) => response.text())
      .then((text) => changeState((state) => {
        if (state.detailDialog.kind === "assignment" && state.detailDialog.item === assessment) {
          state.detailDialog.instructions = text.trim() || "The archived instructions file is empty.";
        }
      }))
      .catch(() => undefined);
  }
}

export async function openAnnouncement(courseId: string, announcementId: string): Promise<void> {
  const detail = await ensureCourse(courseId);
  const announcement = detail.announcements.find((item) => String(item.id) === String(announcementId));
  if (!announcement) throw new Error("Announcement was not found in the local manifest");
  changeState((state) => {
    state.detailDialog = {
      open: true,
      kind: "announcement",
      eyebrow: `${detail.course.code} · ${new Date(announcement.postedAt || announcement.createdDate).toLocaleString("en-HK")}`,
      title: announcement.title,
      courseDetail: detail,
      item: announcement,
    };
  });
}

export function openCourseDetails(courseId: string): void {
  const course = readState().bootstrap?.inventory.courses.find((item) => item.id === courseId);
  if (!course) return;
  changeState((state) => {
    state.detailDialog = { open: true, kind: "course", eyebrow: course.termName, title: course.name, course };
  });
}

export async function openCalendarItem(courseId: string, title: string): Promise<void> {
  const detail = await ensureCourse(courseId);
  const assessment = detail.assessments.find((item) => item.title === title || item.effectiveTitle === title);
  if (assessment) {
    await openAssignment(courseId, assessment.contentId || assessment.columnId);
    return;
  }
  navigate(`course/${encodeURIComponent(courseId)}/calendar`);
}

export async function searchArchive(query: string): Promise<void> {
  changeState((state) => {
    state.searchQuery = query;
    state.searchLoading = query.trim().length >= 2;
    if (query.trim().length < 2) state.searchResults = [];
  });
  if (query.trim().length < 2) return;
  try {
    const response = await api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(query)}&limit=80`);
    if (readState().searchQuery !== query) return;
    changeState((state) => {
      state.searchResults = response.results;
      state.searchLoading = false;
    });
  } catch (error) {
    changeState((state) => state.searchLoading = false);
    throw error;
  }
}

export function openSearch(): void {
  changeState((state) => {
    state.searchOpen = true;
    state.searchQuery = "";
    state.searchResults = [];
    state.searchLoading = false;
  });
}

function connectEvents(): void {
  events?.close();
  events = new EventSource("/api/events");
  events.addEventListener("jobs", async (event) => {
    const hadActive = Boolean(activeBatch());
    const jobs = JSON.parse(event.data) as FetchBatch[];
    changeState((state) => {
      if (state.bootstrap) state.bootstrap.jobs = jobs;
    });
    if (hadActive && !activeBatch()) {
      const [inventory, summary] = await Promise.all([
        api<JsonRecord>("/api/courses").catch(() => null),
        api<JsonRecord>("/api/summary").catch(() => null),
      ]);
      changeState((state) => {
        if (!state.bootstrap) return;
        if (inventory) state.bootstrap.inventory = inventory as Bootstrap["inventory"];
        if (summary) state.bootstrap.summary = summary;
        state.courseCache.clear();
        state.allFiles = null;
      });
    }
  });
  events.addEventListener("auth", (event) => changeState((state) => {
    if (state.bootstrap) state.bootstrap.auth = JSON.parse(event.data);
  }));
  events.addEventListener("inventory-task", (event) => changeState((state) => {
    if (state.bootstrap) state.bootstrap.inventoryTask = JSON.parse(event.data);
  }));
  events.addEventListener("inventory", async (event) => {
    const inventory = JSON.parse(event.data);
    const summary = await api<JsonRecord>("/api/summary").catch(() => null);
    changeState((state) => {
      if (!state.bootstrap) return;
      state.bootstrap.inventory = inventory;
      if (summary) state.bootstrap.summary = summary;
      state.courseCache.clear();
      state.allFiles = null;
    });
  });
  events.addEventListener("file-index", (event) => changeState((state) => {
    if (!state.bootstrap) return;
    state.bootstrap.fileIndex = JSON.parse(event.data);
    if (state.bootstrap.fileIndex.status === "complete") state.allFiles = null;
  }));
  events.addEventListener("summary", (event) => changeState((state) => {
    if (state.bootstrap) state.bootstrap.summary = JSON.parse(event.data);
  }));
}

export async function initialize(): Promise<() => void> {
  const onHashChange = () => {
    changeState((state) => {
      state.route = routeFromHash();
      state.mobileNavOpen = false;
    });
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  window.addEventListener("hashchange", onHashChange);
  try {
    await refreshBootstrap();
    const state = readState();
    if (state.bootstrap?.auth.exists && state.bootstrap.auth.validation == null) {
      changeState((current) => { if (current.bootstrap) current.bootstrap.auth.status = "checking"; });
    }
    connectEvents();
    if (!state.bootstrap?.auth.exists || !state.bootstrap.inventory.courses.length) openSetup();
    else checkAuth().catch(() => undefined);
  } catch (error) {
    changeState((state) => {
      state.loading = false;
      state.fatalError = error instanceof Error ? error.message : String(error);
    });
  }
  return () => {
    events?.close();
    window.removeEventListener("hashchange", onHashChange);
  };
}

export function reportError(error: unknown): void {
  showToast(error instanceof Error ? error.message : String(error), "error");
}

export { appState, changeState, navigate, showToast };
