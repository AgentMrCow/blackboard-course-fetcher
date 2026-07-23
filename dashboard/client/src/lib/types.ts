export type JsonRecord = Record<string, any>;

export interface ArchiveStatus extends JsonRecord {
  exists: boolean;
  status: string;
  generatedAt: string | null;
  fileCount: number;
  bytes: number | null;
}

export interface Course extends JsonRecord {
  id: string;
  externalId?: string;
  name: string;
  code: string;
  termName: string;
  view: string;
  available: boolean;
  outputDirectory: string;
  archive: ArchiveStatus;
}

export interface ArchiveFile extends JsonRecord {
  courseId?: string;
  courseCode?: string;
  courseName?: string;
  path: string;
  name: string;
  category: string;
  preview: string;
  size: number | null;
  modifiedAt?: string;
  origin: "blackboard-original" | "blackboard-content-export" | "derived-search-text" | "external-resource" | "fetcher-record" | "local-file";
  role: string;
  hiddenByDefault: boolean;
  searchable: boolean;
  primaryPath: string;
  groupKey: string;
  logicalItemTitle?: string | null;
}

export interface CourseDetail extends JsonRecord {
  course: Course;
  assessments: JsonRecord[];
  announcements: JsonRecord[];
  contents: JsonRecord[];
  files: ArchiveFile[];
  gradebook?: JsonRecord;
  calendar?: JsonRecord;
  discussions?: JsonRecord;
  messages?: JsonRecord;
  groups?: JsonRecord;
  achievements?: JsonRecord;
  manifest?: JsonRecord;
}

export interface FetchTask extends JsonRecord {
  id: string;
  courseId: string;
  courseCode: string;
  courseName: string;
  status: string;
  progress: number;
  currentPhase?: string;
  currentItem?: string;
  logs: JsonRecord[];
}

export interface FetchBatch extends JsonRecord {
  id: string;
  status: string;
  progress: number;
  tasks: FetchTask[];
  options: JsonRecord;
}

export interface FilePage extends JsonRecord {
  files: ArchiveFile[];
  total: number;
  offset: number;
  limit: number;
  scope: FileScope;
  counts?: Record<FileScope, { files: number; bytes: number }>;
  indexing?: boolean;
  status?: JsonRecord;
}

export type FileScope = "materials" | "exports" | "records" | "all";

export interface Bootstrap extends JsonRecord {
  app: JsonRecord;
  settings: JsonRecord;
  auth: JsonRecord;
  inventoryTask: JsonRecord;
  inventory: JsonRecord & { courses: Course[] };
  summary: JsonRecord;
  jobs: FetchBatch[];
  fileIndex: JsonRecord;
  system: JsonRecord;
}

export interface RouteState {
  page: string;
  id?: string;
  tab?: string;
}

export interface SearchResult extends JsonRecord {
  type: "course" | "file";
  courseId: string;
  courseCode: string;
  title: string;
  path?: string;
  name?: string;
  category?: string;
  preview?: string;
  size?: number | null;
  modifiedAt?: string;
  origin?: ArchiveFile["origin"];
  role?: string;
  hiddenByDefault?: boolean;
  searchable?: boolean;
  primaryPath?: string;
  groupKey?: string;
  snippet?: string;
}

export interface ToastMessage {
  id: number;
  message: string;
  type: "info" | "success" | "error";
}

export interface DetailDialogState {
  open: boolean;
  kind: "course" | "assignment" | "announcement" | null;
  eyebrow: string;
  title: string;
  course?: Course;
  courseDetail?: CourseDetail;
  item?: JsonRecord;
  files?: ArchiveFile[];
  instructions?: string;
  instructionHtmlPath?: string;
}

export interface FileDialogState {
  open: boolean;
  loading: boolean;
  courseId: string;
  file: ArchiveFile | null;
  text: string;
  parsed: JsonRecord | null;
  link: string;
  error: string;
}

export interface AppState {
  bootstrap: Bootstrap | null;
  loading: boolean;
  fatalError: string;
  route: RouteState;
  courseCache: Map<string, CourseDetail>;
  selectedCourses: Set<string>;
  courseFilters: { query: string; term: string; status: string; view: string };
  fileFilters: { query: string; preview: string; courseId: string; scope: FileScope };
  allFiles: FilePage | null;
  filesLoading: boolean;
  filePage: number;
  filePageSize: number;
  fileView: "table" | "grid";
  calendarCursor: Date;
  logTaskId: string | null;
  mobileNavOpen: boolean;
  setupOpen: boolean;
  setupStep: number;
  fetchOpen: boolean;
  fetchCourseIds: string[];
  searchOpen: boolean;
  searchQuery: string;
  searchLoading: boolean;
  searchResults: SearchResult[];
  fileDialog: FileDialogState;
  detailDialog: DetailDialogState;
  toasts: ToastMessage[];
}
