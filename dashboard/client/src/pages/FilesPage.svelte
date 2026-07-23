<script lang="ts">
  import EmptyState from "../components/EmptyState.svelte";
  import FileCollection from "../components/FileCollection.svelte";
  import Icon from "../components/Icon.svelte";
  import { appState, changeState, loadAllFiles, openFile, reportError, setFileFilters } from "../lib/controller";
  import type { FileScope } from "../lib/types";

  let queryTimer: number;
  $: result = $appState.allFiles;
  $: filters = $appState.fileFilters;
  $: archivedCourses = $appState.bootstrap!.inventory.courses.filter((course) => course.archive.exists);
  $: if (!$appState.allFiles && !$appState.filesLoading) loadAllFiles().catch(reportError);
  $: pageCount = result ? Math.ceil(result.total / result.limit) : 0;
  $: currentPage = result ? Math.min(pageCount - 1, Math.floor(result.offset / result.limit)) : 0;

  function updateQuery(value: string) {
    window.clearTimeout(queryTimer);
    queryTimer = window.setTimeout(() => setFileFilters({ query: value }), 250);
  }

  function setPage(page: number) {
    changeState((state) => {
      state.filePage = Math.max(0, page);
      state.allFiles = null;
    });
  }

  function refresh() {
    changeState((state) => {
      state.filePage = 0;
      state.allFiles = null;
    });
  }
</script>

<div class="page">
  <header class="page-header">
    <div><span class="eyebrow">Course materials and archive records</span><h1>Files</h1><p>Preview, search, and download course files without navigating Blackboard folders.</p></div>
    <div class="page-actions"><button class="button secondary" onclick={refresh}><Icon name="refresh-cw" /><span>Refresh index</span></button></div>
  </header>
  <div class="file-toolbar">
    <div class="filter-input"><Icon name="search" /><input type="search" placeholder="Filter file names and paths" value={filters.query} oninput={(event) => updateQuery(event.currentTarget.value)} /></div>
    <select class="select" value={filters.scope} onchange={(event) => setFileFilters({ scope: event.currentTarget.value as FileScope })}>
      <option value="materials">Course materials{result?.counts ? ` (${result.counts.materials.files})` : ""}</option>
      <option value="exports">Content exports{result?.counts ? ` (${result.counts.exports.files})` : ""}</option>
      <option value="records">Archive records{result?.counts ? ` (${result.counts.records.files})` : ""}</option>
      <option value="all">All physical files{result?.counts ? ` (${result.counts.all.files})` : ""}</option>
    </select>
    <select class="select" value={filters.courseId} onchange={(event) => setFileFilters({ courseId: event.currentTarget.value })}><option value="">All courses</option>{#each archivedCourses as course}<option value={course.id}>{course.code} · {course.name}</option>{/each}</select>
    <select class="select" value={filters.preview} onchange={(event) => setFileFilters({ preview: event.currentTarget.value })}><option value="all">All file types</option>{#each ["pdf", "office", "image", "video", "audio", "html", "text", "json", "placeholder", "archive"] as value}<option {value}>{value[0].toUpperCase() + value.slice(1)}</option>{/each}</select>
    <div class="segmented-control"><button class:active={$appState.fileView === "table"} onclick={() => changeState((state) => state.fileView = "table")} title="List view" aria-label="List view"><Icon name="list" /></button><button class:active={$appState.fileView === "grid"} onclick={() => changeState((state) => state.fileView = "grid")} title="Grid view" aria-label="Grid view"><Icon name="grid-2x2" /></button></div>
    <span class="selection-count">{result?.indexing ? `${result.status?.fileCount || 0} indexed` : result ? `${result.total} files` : "Loading"}</span>
  </div>
  {#if $appState.filesLoading || !result}
    <div class="page-loading"><span class="spinner"></span><span>Reading local file indexes</span></div>
  {:else if result.indexing}
    <div class="page-loading"><span class="spinner"></span><span>Indexing course {result.status?.scannedCourses || 0} of {result.status?.totalCourses || "..."} in the background</span></div>
  {:else if !result.files.length}
    <EmptyState icon="file-search" title="No matching files" copy="Change the course, file type, or search filter." />
  {:else}
    <FileCollection files={result.files} view={$appState.fileView} openFile={(id, path) => openFile(id, path).catch(reportError)} />
  {/if}
  {#if result?.files.length && result.total > result.limit}
    <nav class="file-pager" aria-label="File pages">
      <span>Showing {(result.offset + 1).toLocaleString()}-{Math.min(result.total, result.offset + result.files.length).toLocaleString()} of {result.total.toLocaleString()}</span>
      <div><button class="button secondary small" disabled={currentPage === 0} onclick={() => setPage(currentPage - 1)}><Icon name="chevron-left" /><span>Previous</span></button><span>Page {(currentPage + 1).toLocaleString()} of {pageCount.toLocaleString()}</span><button class="button secondary small" disabled={currentPage >= pageCount - 1} onclick={() => setPage(currentPage + 1)}><span>Next</span><Icon name="chevron-right" /></button></div>
    </nav>
  {/if}
</div>
