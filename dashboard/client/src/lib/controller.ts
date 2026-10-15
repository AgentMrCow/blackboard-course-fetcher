import { api, requestText } from "./api";
import { fileEndpoint } from "./format";
import { appState, changeState, navigate as navigateTo, readState, routeFromHash, showToast } from "./state";
import type { AppState, ArchiveFile, Bootstrap, CourseDetail, DetailDialogState, FetchBatch, FileDialogState, FilePage, FileScope, JsonRecord, SearchResult } from "./types";

let events: EventSource | null = null;
let fileLoadSequence = 0;
let searchSequence = 0;
let bootstrapSequence = 0;
let detailOpenSequence = 0;
const courseRequests = new Map<string, { token: symbol; request: Promise<CourseDetail> }>();
const liveRevisions = new Map<keyof Bootstrap, number>();

export function closeDetails(): void {
  detailOpenSequence += 1;
  changeState((state) => state.detailDialog.open = false);
}

function navigate(path: string): void {
  closeDetails();
  navigateTo(path);
}

function beginDetailOpen(): () => boolean {
  const sequence = ++detailOpenSequence;
  const route = readState().route;
  const hash = window.location?.hash;
  return () => sequence === detailOpenSequence && readState().route === route && window.location?.hash === hash;
}

async function detailCourse(courseId: string, isCurrent: () => boolean): Promise<CourseDetail | null> {
  try {
    const detail = await ensureCourse(courseId);
    return isCurrent() ? detail : null;
  } catch (error) {
    if (isCurrent()) throw error;
    return null;
  }
}

function markLiveUpdate(key: keyof Bootstrap): void {
  liveRevisions.set(key, (liveRevisions.get(key) || 0) + 1);
}

function invalidateArchiveViews(state: AppState): void {
  courseRequests.clear();
  state.courseCache.clear();
  fileLoadSequence += 1;
  state.allFiles = null;
  state.filesLoading = false;
  state.filesError = "";
}

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
  const pending = courseRequests.get(courseId);
  if (!force && pending) return pending.request;
  const token = Symbol(courseId);
  const request: Promise<CourseDetail> = (async () => {
    try {
      const detail = await api<CourseDetail>(`/api/courses/${encodeURIComponent(courseId)}`);
      if (courseRequests.get(courseId)?.token !== token) return courseRequests.get(courseId)?.request || ensureCourse(courseId);
      changeState((state) => state.courseCache.set(courseId, detail));
      return detail;
    } catch (error) {
      if (courseRequests.get(courseId)?.token !== token) return courseRequests.get(courseId)?.request || ensureCourse(courseId);
      throw error;
    } finally {
      if (courseRequests.get(courseId)?.token === token) courseRequests.delete(courseId);
    }
  })();
  courseRequests.set(courseId, { token, request });
  return request;
}

function pruneCourseSelection(state: AppState): void {
  const eligible = new Set((state.bootstrap?.inventory.courses || [])
    .filter((course) => !course.archiveOnly && course.membershipPresent !== false)
    .map((course) => course.id));
  for (const id of state.selectedCourses) {
    if (!eligible.has(id)) state.selectedCourses.delete(id);
  }
}

export async function refreshBootstrap(showSuccess = false): Promise<void> {
  const sequence = ++bootstrapSequence;
  const revisions = new Map(liveRevisions);
  let bootstrap: Bootstrap;
  try {
    bootstrap = await api<Bootstrap>(`/api/bootstrap${showSuccess ? "?refresh=1" : ""}`);
  } catch (error) {
    if (sequence !== bootstrapSequence) return;
    throw error;
  }
  if (sequence !== bootstrapSequence) return;
  if (!bootstrap || typeof bootstrap !== "object" || !Array.isArray(bootstrap.inventory?.courses)) {
    throw new Error("The dashboard returned an invalid workspace response. Check the local dashboard server and refresh the page.");
  }
  changeState((state) => {
    // A live event received after this request began is newer than its snapshot.
    for (const [key, revision] of liveRevisions) {
      if (state.bootstrap && revision !== revisions.get(key)) bootstrap[key] = state.bootstrap[key];
    }
    state.bootstrap = bootstrap;
    pruneCourseSelection(state);
    invalidateArchiveViews(state);
    state.loading = false;
    state.fatalError = "";
  });
  if (readState().connectionStatus === "offline" && (!events || events.readyState === EventSource.CLOSED)) connectEvents();
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
  changeState((current) => { current.filesLoading = true; current.filesError = ""; });
  try {
    while (sequence === fileLoadSequence) {
      const params = fileListParameters().toString();
      let page: FilePage;
      try {
        page = await api<FilePage>(`/api/files?${params}`);
      } catch (error) {
        if (sequence !== fileLoadSequence) return;
        if (params !== fileListParameters().toString()) continue;
        changeState((current) => current.filesError = error instanceof Error ? error.message : String(error));
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
    state.filesError = "";
  });
}

export function openSetup(step: number | null = null): void {
  closeDetails();
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
  closeDetails();
  const state = readState();
  const unique = [...new Set(courseIds)].filter((id) => state.bootstrap?.inventory.courses.some((course) => course.id === id));
  if (!unique.length) {
    navigate("courses");
    showToast("Select one or more courses before starting a fetch.");
    return;
  }
  if (state.bootstrap?.inventory.courses.some((course) => unique.includes(course.id)
    && (course.archiveOnly || course.membershipPresent === false))) {
    showToast("A selected course has no current Blackboard membership. Its local archive is still available. Refresh inventory after membership is restored.", "error");
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
  markLiveUpdate("jobs");
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
  markLiveUpdate("settings");
  changeState((state) => {
    if (state.bootstrap) state.bootstrap.settings = settings;
  });
  await refreshBootstrap();
  showToast("Dashboard settings saved.", "success");
}

export async function checkAuth(): Promise<void> {
  const auth = await api<JsonRecord>("/api/auth/check", { method: "POST", timeoutMs: 90_000 });
  markLiveUpdate("auth");
  changeState((state) => {
    if (state.bootstrap) state.bootstrap.auth = auth;
  });
  showToast(auth.validation?.valid ? "Blackboard session is valid." : auth.message || "Session check failed.", auth.validation?.valid ? "success" : "error");
}

export async function authAction(action: "start" | "save" | "cancel"): Promise<void> {
  const auth = await api<JsonRecord>(`/api/auth/${action}`, { method: "POST" });
  markLiveUpdate("auth");
  changeState((state) => {
    if (state.bootstrap) state.bootstrap.auth = auth;
  });
}

export async function runInventory(): Promise<void> {
  const task = await api<JsonRecord>("/api/inventory", { method: "POST" });
  markLiveUpdate("inventoryTask");
  changeState((state) => {
    if (state.bootstrap) state.bootstrap.inventoryTask = task;
  });
  showToast("Course inventory started.");
}

export async function cancelInventory(): Promise<void> {
  const task = await api<JsonRecord>("/api/inventory/cancel", { method: "POST" });
  markLiveUpdate("inventoryTask");
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
  markLiveUpdate("jobs");
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

export async function openFile(courseId: string, filePath: string, metadata?: ArchiveFile): Promise<void> {
  closeDetails();
  const file = metadata?.path === filePath ? metadata : fileMeta(courseId, filePath);
  const dialog: FileDialogState = { open: true, loading: true, courseId, file, text: "", parsed: null, link: "", error: "" };
  changeState((state) => {
    state.fileDialog = dialog;
  });
  if (!["text", "json", "link", "placeholder", "unresolved"].includes(file.preview)) {
    changeState((state) => state.fileDialog.loading = false);
    return;
  }
  try {
    let text = await requestText(fileEndpoint(courseId, filePath));
    if (readState().fileDialog !== dialog || !dialog.open) return;
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
  const isCurrent = beginDetailOpen();
  const detail = await detailCourse(courseId, isCurrent);
  if (!detail || !isCurrent()) return;
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
  const dialog: DetailDialogState = {
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
  changeState((state) => { state.detailDialog = dialog; });
  if (instructionFile) {
    requestText(fileEndpoint(courseId, instructionFile.path))
      .then((text) => changeState((state) => {
        if (isCurrent() && state.detailDialog === dialog && dialog.open) {
          state.detailDialog.instructions = text.trim() || "The archived instructions file is empty.";
        }
      }))
      .catch((error) => changeState((state) => {
        if (isCurrent() && state.detailDialog === dialog && dialog.open) {
          state.detailDialog.instructions = `Unable to load archived instructions: ${error instanceof Error ? error.message : String(error)}`;
        }
      }));
  }
}

export async function openAnnouncement(courseId: string, announcementId: string): Promise<void> {
  const isCurrent = beginDetailOpen();
  const detail = await detailCourse(courseId, isCurrent);
  if (!detail || !isCurrent()) return;
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
  closeDetails();
  const course = readState().bootstrap?.inventory.courses.find((item) => item.id === courseId);
  if (!course) return;
  changeState((state) => {
    state.detailDialog = { open: true, kind: "course", eyebrow: course.termName, title: course.name, course };
  });
}

export async function openCalendarItem(courseId: string, title: string): Promise<void> {
  const isCurrent = beginDetailOpen();
  const detail = await detailCourse(courseId, isCurrent);
  if (!detail || !isCurrent()) return;
  const assessment = detail.assessments.find((item) => item.title === title || item.effectiveTitle === title);
  if (assessment) {
    await openAssignment(courseId, assessment.contentId || assessment.columnId);
    return;
  }
  navigate(`course/${encodeURIComponent(courseId)}/calendar`);
}

export async function searchArchive(query: string): Promise<void> {
  const sequence = ++searchSequence;
  changeState((state) => {
    state.searchQuery = query;
    state.searchLoading = query.trim().length >= 2;
    if (query.trim().length < 2) state.searchResults = [];
  });
  if (query.trim().length < 2) return;
  try {
    const response = await api<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(query)}&limit=80`);
    if (sequence !== searchSequence || readState().searchQuery !== query) return;
    changeState((state) => {
      state.searchResults = response.results;
      state.searchLoading = false;
    });
  } catch (error) {
    if (sequence !== searchSequence || readState().searchQuery !== query) return;
    changeState((state) => state.searchLoading = false);
    throw error;
  }
}

export function openSearch(): void {
  closeDetails();
  searchSequence += 1;
  changeState((state) => {
    state.searchOpen = true;
    state.searchQuery = "";
    state.searchResults = [];
    state.searchLoading = false;
  });
}

function connectEvents(): void {
  events?.close();
  const source = new EventSource("/api/events");
  events = source;
  changeState((state) => state.connectionStatus = "connecting");
  const listen = <T>(name: string, handle: (payload: T) => void | Promise<void>) => {
    source.addEventListener(name, (event) => {
      if (events !== source) return;
      let payload: T;
      try {
        payload = JSON.parse((event as MessageEvent).data);
        const valid = name === "jobs" ? Array.isArray(payload)
          : payload !== null && typeof payload === "object" && !Array.isArray(payload)
            && (name !== "inventory" || Array.isArray((payload as JsonRecord).courses));
        if (!valid) throw new Error("Invalid event payload");
      }
      catch {
        showToast("A dashboard update could not be read. Refresh local data to resync.", "error");
        return;
      }
      Promise.resolve().then(() => {
        if (events === source) return handle(payload);
      }).catch((error) => {
        if (events === source) reportError(error);
      });
    });
  };
  source.addEventListener("open", () => {
    if (events !== source) return;
    changeState((state) => state.connectionStatus = "connected");
    // The event stream does not replay missed updates, including the startup gap.
    refreshBootstrap().catch((error) => {
      if (events === source) reportError(error);
    });
  });
  source.addEventListener("error", () => {
    if (events !== source) return;
    changeState((state) => state.connectionStatus = source.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
  });
  listen<FetchBatch[]>("jobs", async (jobs) => {
    const hadActive = Boolean(activeBatch());
    markLiveUpdate("jobs");
    changeState((state) => {
      if (state.bootstrap) state.bootstrap.jobs = jobs;
    });
    if (hadActive && !activeBatch()) await refreshBootstrap();
  });
  listen<JsonRecord>("auth", (auth) => {
    markLiveUpdate("auth");
    changeState((state) => { if (state.bootstrap) state.bootstrap.auth = auth; });
  });
  listen<JsonRecord>("inventory-task", (task) => {
    markLiveUpdate("inventoryTask");
    changeState((state) => { if (state.bootstrap) state.bootstrap.inventoryTask = task; });
  });
  listen<Bootstrap["inventory"]>("inventory", async (inventory) => {
    markLiveUpdate("inventory");
    const revision = liveRevisions.get("inventory");
    const summaryRevision = liveRevisions.get("summary");
    changeState((state) => {
      if (!state.bootstrap) return;
      state.bootstrap.inventory = inventory;
      pruneCourseSelection(state);
      invalidateArchiveViews(state);
    });
    let summary: JsonRecord;
    try { summary = await api<JsonRecord>("/api/summary"); }
    catch (error) {
      if (events !== source || revision !== liveRevisions.get("inventory") || summaryRevision !== liveRevisions.get("summary")) return;
      throw error;
    }
    if (events !== source || revision !== liveRevisions.get("inventory") || summaryRevision !== liveRevisions.get("summary")) return;
    markLiveUpdate("summary");
    changeState((state) => { if (state.bootstrap) state.bootstrap.summary = summary; });
  });
  listen<JsonRecord>("file-index", (index) => {
    markLiveUpdate("fileIndex");
    changeState((state) => {
      if (!state.bootstrap) return;
      state.bootstrap.fileIndex = index;
      if (index.status === "complete") {
        fileLoadSequence += 1;
        state.allFiles = null;
        state.filesLoading = false;
        state.filesError = "";
      }
    });
  });
  listen<JsonRecord>("summary", (summary) => {
    markLiveUpdate("summary");
    changeState((state) => { if (state.bootstrap) state.bootstrap.summary = summary; });
  });
}

export async function initialize(): Promise<() => void> {
  const onHashChange = () => {
    closeDetails();
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
      state.connectionStatus = "offline";
    });
  }
  return () => {
    events?.close();
    events = null;
    bootstrapSequence += 1;
    window.removeEventListener("hashchange", onHashChange);
  };
}

export function reportError(error: unknown): void {
  showToast(error instanceof Error ? error.message : String(error), "error");
}

export { appState, changeState, navigate, showToast };
