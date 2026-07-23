<script lang="ts">
  import type { Component } from "svelte";
  import Activity from "@lucide/svelte/icons/activity";
  import Archive from "@lucide/svelte/icons/archive";
  import ArrowRight from "@lucide/svelte/icons/arrow-right";
  import Award from "@lucide/svelte/icons/award";
  import BookCopy from "@lucide/svelte/icons/book-copy";
  import BookOpen from "@lucide/svelte/icons/book-open";
  import Braces from "@lucide/svelte/icons/braces";
  import CalendarCheck from "@lucide/svelte/icons/calendar-check";
  import CalendarClock from "@lucide/svelte/icons/calendar-clock";
  import CalendarDays from "@lucide/svelte/icons/calendar-days";
  import CalendarX from "@lucide/svelte/icons/calendar-x";
  import ChartNoAxesColumn from "@lucide/svelte/icons/chart-no-axes-column";
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronLeft from "@lucide/svelte/icons/chevron-left";
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import ClipboardCheck from "@lucide/svelte/icons/clipboard-check";
  import ClipboardList from "@lucide/svelte/icons/clipboard-list";
  import Copy from "@lucide/svelte/icons/copy";
  import Download from "@lucide/svelte/icons/download";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import File from "@lucide/svelte/icons/file";
  import FileArchive from "@lucide/svelte/icons/file-archive";
  import FileAudio from "@lucide/svelte/icons/file-audio";
  import FileCode from "@lucide/svelte/icons/file-code";
  import FileImage from "@lucide/svelte/icons/file-image";
  import FileQuestion from "@lucide/svelte/icons/file-question";
  import FileSearch from "@lucide/svelte/icons/file-search";
  import FileSpreadsheet from "@lucide/svelte/icons/file-spreadsheet";
  import FileText from "@lucide/svelte/icons/file-text";
  import FileType from "@lucide/svelte/icons/file-type";
  import FileVideo from "@lucide/svelte/icons/file-video";
  import FileWarning from "@lucide/svelte/icons/file-warning";
  import Files from "@lucide/svelte/icons/files";
  import Folder from "@lucide/svelte/icons/folder";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Grid2x2 from "@lucide/svelte/icons/grid-2x2";
  import HardDriveDownload from "@lucide/svelte/icons/hard-drive-download";
  import Info from "@lucide/svelte/icons/info";
  import LayoutDashboard from "@lucide/svelte/icons/layout-dashboard";
  import List from "@lucide/svelte/icons/list";
  import ListChecks from "@lucide/svelte/icons/list-checks";
  import LogIn from "@lucide/svelte/icons/log-in";
  import Mail from "@lucide/svelte/icons/mail";
  import Menu from "@lucide/svelte/icons/menu";
  import MessageSquareDashed from "@lucide/svelte/icons/message-square-dashed";
  import MessagesSquare from "@lucide/svelte/icons/messages-square";
  import Minus from "@lucide/svelte/icons/minus";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import PanelTopOpen from "@lucide/svelte/icons/panel-top-open";
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import Plus from "@lucide/svelte/icons/plus";
  import RefreshCw from "@lucide/svelte/icons/refresh-cw";
  import Save from "@lucide/svelte/icons/save";
  import ScanSearch from "@lucide/svelte/icons/scan-search";
  import Search from "@lucide/svelte/icons/search";
  import SearchX from "@lucide/svelte/icons/search-x";
  import ServerOff from "@lucide/svelte/icons/server-off";
  import Settings from "@lucide/svelte/icons/settings";
  import Settings2 from "@lucide/svelte/icons/settings-2";
  import ShieldAlert from "@lucide/svelte/icons/shield-alert";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import ShieldQuestionMark from "@lucide/svelte/icons/shield-question-mark";
  import Square from "@lucide/svelte/icons/square";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import Users from "@lucide/svelte/icons/users";
  import X from "@lucide/svelte/icons/x";

  export let name: string;
  export let size: number | string = 20;
  export let strokeWidth = 2;
  export let className = "";

  const icons: Record<string, Component<any>> = {
    activity: Activity,
    archive: Archive,
    "arrow-right": ArrowRight,
    award: Award,
    "book-copy": BookCopy,
    "book-open": BookOpen,
    braces: Braces,
    "calendar-check": CalendarCheck,
    "calendar-clock": CalendarClock,
    "calendar-days": CalendarDays,
    "calendar-x": CalendarX,
    "chart-no-axes-column": ChartNoAxesColumn,
    check: Check,
    "chevron-down": ChevronDown,
    "chevron-left": ChevronLeft,
    "chevron-right": ChevronRight,
    "circle-alert": CircleAlert,
    "circle-check": CircleCheck,
    "clipboard-check": ClipboardCheck,
    "clipboard-list": ClipboardList,
    copy: Copy,
    download: Download,
    ellipsis: Ellipsis,
    "external-link": ExternalLink,
    file: File,
    "file-archive": FileArchive,
    "file-audio": FileAudio,
    "file-code": FileCode,
    "file-image": FileImage,
    "file-question": FileQuestion,
    "file-search": FileSearch,
    "file-spreadsheet": FileSpreadsheet,
    "file-text": FileText,
    "file-type": FileType,
    "file-video": FileVideo,
    "file-warning": FileWarning,
    files: Files,
    folder: Folder,
    "folder-open": FolderOpen,
    "grid-2x2": Grid2x2,
    "hard-drive-download": HardDriveDownload,
    info: Info,
    "layout-dashboard": LayoutDashboard,
    list: List,
    "list-checks": ListChecks,
    "log-in": LogIn,
    mail: Mail,
    menu: Menu,
    "message-square-dashed": MessageSquareDashed,
    "messages-square": MessagesSquare,
    minus: Minus,
    paperclip: Paperclip,
    "panel-top-open": PanelTopOpen,
    pause: Pause,
    play: Play,
    plus: Plus,
    "refresh-cw": RefreshCw,
    save: Save,
    "scan-search": ScanSearch,
    search: Search,
    "search-x": SearchX,
    "server-off": ServerOff,
    settings: Settings,
    "settings-2": Settings2,
    "shield-alert": ShieldAlert,
    "shield-check": ShieldCheck,
    "shield-question": ShieldQuestionMark,
    square: Square,
    "triangle-alert": TriangleAlert,
    users: Users,
    x: X,
  };

  $: SelectedIcon = icons[name] || File;
</script>

<svelte:component this={SelectedIcon} {size} {strokeWidth} class={className} aria-hidden="true" />
