<script lang="ts">
  import { onDestroy } from "svelte";
  import EmptyState from "../../components/EmptyState.svelte";
  import Icon from "../../components/Icon.svelte";
  import HistoryComparison from "./HistoryComparison.svelte";
  import { api } from "../../lib/api";
  import { openFile, reportError } from "../../lib/controller";
  import { fileEndpoint, formatBytes, formatDate, relativeTime } from "../../lib/format";
  import type { ArchiveFile, ArchiveHistoryDetail, ArchiveHistoryFile, ArchiveHistoryList } from "../../lib/types";

  export let courseId: string;

  let loadedFor = "";
  let listing: ArchiveHistoryList | null = null;
  let selectedId = "";
  let selected: ArchiveHistoryDetail | null = null;
  let loading = false;
  let loadingRun = false;
  let error = "";
  let runError = "";
  let query = "";
  let requestedOffset = 0;
  let requestedQuery = "";
  let queryTimer: ReturnType<typeof setTimeout>;
  let comparing = "";
  let listRequest: AbortController | undefined;
  let runRequest: AbortController | undefined;

  $: if (courseId && courseId !== loadedFor) loadRuns(courseId);

  async function loadRuns(id: string) {
    listRequest?.abort();
    runRequest?.abort();
    clearTimeout(queryTimer);
    comparing = "";
    const request = new AbortController();
    listRequest = request;
    loadedFor = id;
    loading = true;
    error = "";
    listing = null;
    selected = null;
    selectedId = "";
    try {
      const result = await api<ArchiveHistoryList>(`/api/courses/${encodeURIComponent(id)}/history`, { signal: request.signal });
      if (request.signal.aborted || listRequest !== request) return;
      listing = result;
      if (result.runs.length) selectRun(result.runs[0].id, id);
    } catch (cause) {
      if (!request.signal.aborted && listRequest === request) error = cause instanceof Error ? cause.message : "Backup history could not be loaded.";
    } finally {
      if (listRequest === request) loading = false;
    }
  }

  async function selectRun(id: string, currentCourse = courseId) {
    clearTimeout(queryTimer);
    query = "";
    comparing = "";
    selected = null;
    return loadPage(id, currentCourse, 0, "");
  }

  async function loadPage(id = selectedId, currentCourse = courseId, offset = requestedOffset, search = requestedQuery) {
    runRequest?.abort();
    const request = new AbortController();
    runRequest = request;
    selectedId = id;
    requestedOffset = offset;
    requestedQuery = search;
    loadingRun = true;
    runError = "";
    try {
      const parameters = new URLSearchParams({ offset: String(offset), limit: "100", q: search });
      const result = await api<ArchiveHistoryDetail>(`/api/courses/${encodeURIComponent(currentCourse)}/history/${encodeURIComponent(id)}?${parameters}`, { signal: request.signal });
      if (!request.signal.aborted && runRequest === request) selected = result;
    } catch (cause) {
      if (!request.signal.aborted && runRequest === request) runError = cause instanceof Error ? cause.message : "This backup could not be opened.";
    } finally {
      if (runRequest === request) loadingRun = false;
    }
  }

  function filterFiles(value: string) {
    query = value;
    clearTimeout(queryTimer);
    // Cancel a previous page immediately, before the next debounced query starts.
    runRequest?.abort();
    queryTimer = setTimeout(() => loadPage(selectedId, courseId, 0, value.trim()), 250);
  }

  function previewMetadata(file: ArchiveHistoryFile): ArchiveFile {
    const filePath = file.backupPath!;
    const extension = file.path.split(".").at(-1)?.toLowerCase();
    const preview = file.size > 2_000_000 || file.status === "changed" ? "download"
      : extension === "json" ? "json"
      : ["html", "htm"].includes(extension || "") ? "html"
      : extension === "pdf" ? "pdf"
      : ["png", "jpg", "jpeg", "gif", "webp"].includes(extension || "") ? "image"
      : ["txt", "md", "csv", "ics", "vtt", "srt", "xml", "css", "js"].includes(extension || "") ? "text" : "download";
    return {
      path: filePath, name: file.path.split("/").at(-1) || file.path, size: file.size,
      preview, category: "Backup history", origin: "fetcher-record", role: "preserved-original",
      hiddenByDefault: true, searchable: false, primaryPath: filePath, groupKey: filePath,
    };
  }

  onDestroy(() => { listRequest?.abort(); runRequest?.abort(); clearTimeout(queryTimer); });
</script>

<section class="history-section" aria-labelledby="history-title">
  <div class="section-heading history-heading">
    <div><span class="eyebrow">Preserved before replacement</span><h2 id="history-title">Backup history</h2><p>Browse earlier versions of your course records and exports.</p></div>
    <button class="button secondary small" disabled={loading} onclick={() => loadRuns(courseId)}><Icon name="refresh-cw" /><span>Refresh history</span></button>
  </div>

  {#if loading}
    <div class="page-loading" role="status"><span class="spinner"></span><span>Reading backup history</span></div>
  {:else if error}
    <EmptyState icon="server-off" title="History could not be loaded" copy={error}><button class="button secondary" onclick={() => loadRuns(courseId)}>Try again</button></EmptyState>
  {:else if listing}
    <div class="history-summary" aria-label="Backup storage summary"><div><span>Saved refreshes listed</span><strong>{listing.runs.length}</strong></div><div><span>Preserved files recorded</span><strong>{listing.recordedFiles.toLocaleString()}</strong></div><div><span>Recorded backup size</span><strong>{listing.recordedBytes === null ? "Size unavailable" : formatBytes(listing.recordedBytes)}</strong></div></div>
    <p class="history-summary-note">Totals cover the listed journals, including repeated versions. Actual disk use may differ if files changed or were removed.</p>
    {#if listing.warnings.length || listing.truncated}
      <div class="history-notice" role="status"><Icon name="info" /><div>{#if listing.truncated}<p>Only part of the history is shown. The remaining backups are still stored in the course folder.</p>{/if}{#each listing.warnings as warning}<p>{warning}</p>{/each}</div></div>
    {/if}
    {#if !listing.runs.length}
      <div class="data-surface"><EmptyState icon="history" title="No previous versions yet" copy="The next refresh saves existing records here before replacing them. A first fetch or unchanged file may have nothing to back up." /></div>
    {:else}
      <div class="history-layout">
        <nav class="history-runs data-surface" aria-label="Saved refreshes">
          <div class="history-list-heading">Saved refreshes <span>{listing.runs.length}</span></div>
          {#each listing.runs as run}
            <button class="history-run" class:chosen={selectedId === run.id} aria-current={selectedId === run.id ? "true" : undefined} onclick={() => selectRun(run.id)}>
              <span class="run-icon"><Icon name={run.status === "available" ? "history" : "triangle-alert"} /></span>
              <span><strong>{run.createdAt ? formatDate(run.createdAt, { time: true }) : "Undated backup"}</strong><small>{run.fileCount} files · {formatBytes(run.totalBytes)}</small><small>{run.status === "unreadable" ? "Index could not be read" : run.createdAt ? relativeTime(run.createdAt) : run.id}</small></span>
              <Icon name="chevron-right" size={16} />
            </button>
          {/each}
        </nav>
        <div class="history-detail data-surface" aria-live="polite" aria-busy={loadingRun}>
          {#if loadingRun && !selected}
            <div class="page-loading"><span class="spinner"></span><span>Opening saved refresh</span></div>
          {:else if runError}
            <EmptyState icon="file-warning" title="Backup unavailable" copy={runError}><button class="button secondary small" onclick={() => loadPage()}>Try again</button></EmptyState>
          {:else if selected}
            <div class="history-detail-heading"><div><h3>Files preserved in this refresh</h3><p>These are the originals saved before they were replaced.</p></div><span class="badge neutral">{selected.fileCount} files</span></div>
            {#if selected.warnings.length || selected.truncated}
              <div class="history-notice"><Icon name="triangle-alert" /><div>{#each selected.warnings as warning}<p>{warning}</p>{/each}{#if selected.truncated}<p>This backup has more records than can be displayed here.</p>{/if}</div></div>
            {/if}
            <div class="history-filter"><div class="filter-input"><Icon name="search" /><input aria-label="Filter backup files" type="search" placeholder="Find an original filename or path" value={query} oninput={(event) => filterFiles(event.currentTarget.value)} /></div><span role="status">{loadingRun ? "Updating…" : `${selected.total} matches`}</span></div>
            {#if selected.files.length}
              <ul class="history-files" class:updating={loadingRun}>
                {#each selected.files as file}
                  <li><span class="history-file-icon"><Icon name={file.status === "available" ? "file-text" : "file-warning"} /></span><div class="history-file-copy"><strong>{file.path.split("/").at(-1)}</strong><small>{file.path}</small><span>{formatBytes(file.size)}{file.status !== "available" ? ` · ${file.status === "changed" ? "Size differs from saved record" : file.status === "missing" ? "Backup file missing" : "Cannot safely open this file"}` : ""}</span></div><div class="history-file-actions"><button class="button secondary small" disabled={loadingRun} onclick={() => comparing = file.path} aria-label={`Compare saved ${file.path}`}><Icon name="files" /><span>Compare</span></button>{#if file.backupPath}<button class="icon-button" disabled={loadingRun} onclick={() => openFile(courseId, file.backupPath!, previewMetadata(file)).catch(reportError)} title={`View saved ${file.path}`} aria-label={`View saved ${file.path}`}><Icon name="panel-top-open" /></button><a class="icon-button" href={fileEndpoint(courseId, file.backupPath, true)} title={`Download saved ${file.path}`} aria-label={`Download saved ${file.path}`}><Icon name="download" /></a>{/if}</div></li>
                {/each}
              </ul>
            {:else}<EmptyState icon="file-search" title={query ? "No matching backup files" : "No readable records"} copy={query ? "Try a different filename or path." : "Review the index warnings for this saved refresh."} />{/if}
            {#if selected.total > selected.limit}<nav class="history-more" aria-label="Backup file pages"><span>{selected.offset + 1}–{selected.offset + selected.files.length} of {selected.total}</span><div><button class="button secondary small" disabled={loadingRun || selected.offset === 0} onclick={() => loadPage(selectedId, courseId, Math.max(0, selected!.offset - selected!.limit))}><Icon name="chevron-left" />Previous</button><button class="button secondary small" disabled={loadingRun || !selected.hasMore} onclick={() => loadPage(selectedId, courseId, selected!.offset + selected!.limit)}>Next<Icon name="chevron-right" /></button></div></nav>{/if}
          {/if}
        </div>
      </div>
    {/if}
    <details class="history-help"><summary><Icon name="info" /><span>How to use these backups</span></summary><div><p>Viewing or downloading a backup leaves your current archive unchanged. To recover a file, stop fetching this course, make a copy of the course folder, then copy the saved file back to its original path.</p><p>Each refresh preserves replaced files, not a complete course snapshot. New files are not removed during manual recovery. Backups are kept locally until you remove them; they use additional disk space.</p><p>Availability checks the path, presence and size of each backup. It does not recheck every file's saved SHA-256 hash. Legacy folder migrations may also need their paths reconciled before restoring an old manifest.</p></div></details>
  {/if}
</section>

<HistoryComparison open={Boolean(comparing)} {courseId} runId={selectedId} originalPath={comparing} close={() => comparing = ""} />

<style>
  .history-heading { align-items: flex-start; gap: 16px; }
  .history-heading h2 { margin-top: 5px; font-size: 24px; letter-spacing: -.6px; }
  .history-heading p, .history-detail-heading p { margin: 7px 0 0; color: var(--ink-soft); font-size: 13px; }
  .history-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 20px 0 10px; }
  .history-summary > div { padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
  .history-summary span { display: block; color: var(--ink-soft); font-size: 12px; }
  .history-summary strong { display: block; font-size: 24px; margin-top: 7px; font-variant-numeric: tabular-nums; }
  .history-summary-note { margin: 0 0 22px; color: var(--ink-soft); font-size: 11px; line-height: 1.5; }
  .history-layout { display: grid; grid-template-columns: minmax(230px, 300px) minmax(0, 1fr); gap: 20px; align-items: start; }
  .history-runs { max-height: 650px; overflow-y: auto; }
  .history-list-heading { display: flex; justify-content: space-between; padding: 18px; border-bottom: 1px solid var(--line); font-size: 12px; font-weight: 700; color: var(--ink-soft); }
  .history-list-heading span { font-variant-numeric: tabular-nums; }
  .history-run { display: grid; width: 100%; grid-template-columns: 30px minmax(0, 1fr) 16px; gap: 10px; padding: 18px 14px; text-align: left; align-items: start; background: transparent; border: 0; border-bottom: 1px solid var(--line); border-left: 3px solid transparent; }
  .history-run:last-child { border-bottom: 0; }
  .history-run:hover { background: var(--surface-subtle); }
  .history-run.chosen { background: var(--green-soft); border-left-color: var(--green); }
  .history-run strong, .history-run small { display: block; }
  .history-run strong { font-size: 12px; }
  .history-run small { margin-top: 5px; color: var(--ink-soft); font-size: 11px; overflow-wrap: anywhere; }
  .run-icon { color: var(--green); padding-top: 1px; }
  .history-detail { min-width: 0; }
  .history-detail-heading { display: flex; align-items: start; justify-content: space-between; padding: 21px; gap: 12px; }
  .history-detail-heading h3 { margin: 0; font-size: 15px; }
  .history-filter { display: flex; align-items: center; gap: 12px; padding: 0 20px 16px; }
  .history-filter .filter-input { flex: 1; min-width: 0; }
  .history-filter > span { color: var(--ink-soft); font-size: 11px; white-space: nowrap; }
  .history-files { margin: 0; padding: 0; list-style: none; }
  .history-files li { display: flex; gap: 12px; align-items: center; padding: 15px 20px; border-top: 1px solid var(--line); }
  .history-file-icon { display: grid; place-items: center; width: 34px; height: 38px; flex-shrink: 0; color: var(--blue); background: var(--blue-soft); border-radius: 6px; }
  .history-file-copy { min-width: 0; flex: 1; }
  .history-file-copy strong { display: block; font-size: 13px; overflow-wrap: anywhere; }
  .history-file-copy small { display: block; color: var(--ink-soft); margin-top: 3px; font-size: 11px; overflow-wrap: anywhere; }
  .history-file-copy > span { display: block; color: var(--ink-soft); margin-top: 4px; font-size: 11px; }
  .history-file-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .history-more { display: flex; justify-content: center; align-items: center; gap: 14px; border-top: 1px solid var(--line); padding: 15px; font-size: 12px; color: var(--ink-soft); }
  .history-more > div { display: flex; gap: 8px; }
  .history-files.updating { opacity: .65; }
  .history-notice { display: flex; gap: 10px; padding: 13px 16px; margin-bottom: 16px; color: var(--amber); background: var(--amber-soft); border: 1px solid var(--line); border-radius: var(--radius); }
  .history-detail .history-notice { margin: 0 20px 16px; }
  .history-notice p { margin: 0; font-size: 12px; }
  .history-notice p + p { margin-top: 7px; }
  .history-help { margin-top: 20px; color: var(--ink-soft); font-size: 12px; }
  .history-help summary { display: flex; align-items: center; gap: 8px; width: fit-content; cursor: pointer; font-weight: 600; padding: 8px 0; }
  .history-help div { max-width: 820px; padding: 0 0 4px 26px; line-height: 1.7; }
  @media (max-width: 850px) { .history-layout { grid-template-columns: 1fr; } .history-runs { max-height: 240px; } .history-heading { flex-wrap: wrap; } }
  @media (max-width: 480px) { .history-files li { flex-wrap: wrap; padding: 14px; } .history-file-copy { flex-basis: calc(100% - 48px); } .history-file-actions { margin-left: 46px; } .history-filter { flex-wrap: wrap; } .history-filter .filter-input { flex-basis: 100%; } .history-summary { gap: 8px; } .history-summary > div { padding: 12px 10px; } .history-summary strong { font-size: 19px; } .history-summary span { font-size: 11px; } .history-more { flex-wrap: wrap; } }
</style>
