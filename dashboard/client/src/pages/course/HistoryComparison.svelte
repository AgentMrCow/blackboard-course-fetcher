<script lang="ts">
  import { onDestroy } from "svelte";
  import EmptyState from "../../components/EmptyState.svelte";
  import Icon from "../../components/Icon.svelte";
  import Modal from "../../components/Modal.svelte";
  import { api } from "../../lib/api";
  import { fileEndpoint, formatBytes, formatDate } from "../../lib/format";
  import { buildRecoveryDiff, formatComparisonText } from "../../lib/history-diff";
  import type { ArchiveComparison } from "../../lib/types";

  export let open = false;
  export let courseId: string;
  export let runId: string;
  export let originalPath: string;
  export let close: () => void;

  let loadedKey = "";
  let result: ArchiveComparison | null = null;
  let loading = false;
  let error = "";
  let request: AbortController | undefined;

  $: key = JSON.stringify([courseId, runId, originalPath]);
  $: if (open && key !== loadedKey) load();
  $: if (!open) { request?.abort(); loadedKey = ""; }
  $: canCompareText = result && result.saved.text !== null && (result.current.text !== null || result.current.status === "missing");
  $: diff = result && canCompareText ? buildRecoveryDiff(
    formatComparisonText(result.path, result.current.text || ""),
    formatComparisonText(result.path, result.saved.text || ""),
  ) : null;
  $: limitedText = Boolean(result?.saved.textTruncated || result?.current.textTruncated || diff?.truncated);
  $: usableSaved = result?.saved.status === "available" && Boolean(result.backupPath);
  $: usableTarget = result?.current.status === "available" || result?.current.status === "missing";
  $: labels = {
    identical: "Already matches the saved version",
    different: "The current and saved versions differ",
    "missing-current": "The original path is currently missing",
    unavailable: "This comparison could not be completed",
    "metadata-only": "File information is available; content comparison is limited",
  };

  async function load() {
    request?.abort();
    const active = new AbortController();
    request = active;
    loadedKey = key;
    loading = true;
    error = "";
    result = null;
    const parameters = new URLSearchParams({ path: originalPath });
    try {
      const response = await api<ArchiveComparison>(`/api/courses/${encodeURIComponent(courseId)}/history/${encodeURIComponent(runId)}/compare?${parameters}`, { signal: active.signal });
      if (!active.signal.aborted && request === active) result = response;
    } catch (cause) {
      if (!active.signal.aborted && request === active) error = cause instanceof Error ? cause.message : "The saved version could not be compared.";
    } finally {
      if (request === active) loading = false;
    }
  }

  onDestroy(() => request?.abort());
</script>

<Modal {open} className="history-comparison-dialog" labelledby="history-comparison-title" {close}>
  <div class="dialog-header"><div><span class="eyebrow">Before you recover a file</span><h2 id="history-comparison-title">Compare &amp; recovery preview</h2></div><button class="icon-button" onclick={close} aria-label="Close" title="Close"><Icon name="x" /></button></div>
  <div class="comparison-body">
    <p class="comparison-path">{originalPath}</p>
    {#if loading}
      <div class="page-loading" role="status"><span class="spinner"></span><span>Comparing the saved and current files</span></div>
    {:else if error}
      <EmptyState icon="file-warning" title="Comparison unavailable" copy={error}><button class="button secondary" onclick={load}>Try again</button></EmptyState>
    {:else if result}
      <div class="comparison-status" class:warning={result.comparison === "unavailable" || result.saved.status === "changed"}><Icon name={result.comparison === "identical" ? "circle-check" : "info"} /><strong>{labels[result.comparison]}</strong></div>
      {#if result.warnings.length}<ul class="comparison-warnings">{#each result.warnings as warning}<li>{warning}</li>{/each}</ul>{/if}
      <div class="comparison-versions">
        {#each [{ title: "Current file", file: result.current }, { title: "Saved version", file: result.saved }] as version}
          <section><h3>{version.title}</h3><strong>{version.file.status === "available" ? "Available" : version.file.status === "changed" ? version.title === "Current file" ? "Changed while being read" : "Changed since it was saved" : version.file.status === "missing" ? "Missing" : "Cannot safely read"}</strong><span>{version.file.size === null ? "Size unavailable" : formatBytes(version.file.size)}</span><small>{version.file.modifiedAt ? formatDate(version.file.modifiedAt, { time: true }) : "No file timestamp"}</small><small>{version.file.sha256 ? "Content hash computed" : "Content hash not computed"}</small></section>
        {/each}
      </div>

      {#if diff}
        <section class="comparison-diff-section" aria-labelledby="recovery-diff-title">
          <h3 id="recovery-diff-title">Changes if you restore the saved version</h3>
          <p><span class="diff-legend removed">− Remove from current file</span><span class="diff-legend added">+ Recover from saved version</span></p>
          {#if limitedText}<p class="comparison-limit">Only part of the text is shown. Download both files to compare the full contents.</p>{/if}
          {#if diff.simplified}<p class="comparison-limit">Large edits are grouped into changed blocks to keep this preview responsive.</p>{/if}
          {#if result.path.toLowerCase().endsWith(".json")}<p class="comparison-format">JSON may be spaced for readability. Values and repeated fields are preserved; the saved file is unchanged.</p>{/if}
          <p class="comparison-format">Line endings are normalized in this preview.</p>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (This bounded read-only region needs focus for keyboard scrolling.) -->
          <div class="recovery-diff" tabindex="0" role="region" aria-label="Current to saved text differences">
            {#each diff.rows as row}<div class={`diff-line ${row.kind}`}><span class="diff-line-number" aria-hidden="true">{row.currentLine ?? ""}</span><span class="diff-line-number" aria-hidden="true">{row.savedLine ?? ""}</span><span class="diff-symbol" aria-hidden="true">{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "}</span><span class="sr-only">{row.kind === "added" ? "Recover: " : row.kind === "removed" ? "Remove: " : ""}</span><code>{row.text || " "}</code></div>{:else}<p class="empty-diff">Both files are empty.</p>{/each}
          </div>
        </section>
      {:else if result.comparison !== "identical"}
        <p class="comparison-limit">A text difference is not available for this file. Compare the downloaded versions in an application that supports its format.</p>
      {/if}

      <section class="recovery-plan" aria-labelledby="recovery-plan-title">
        <h3 id="recovery-plan-title">Recovery preview</h3>
        <p>{!usableSaved || !usableTarget ? "This file needs review before recovery; a source or destination is missing, changed, unsafe, or unreadable." : result.comparison === "identical" ? "No replacement is needed: the current file matches this backup." : result.current.status === "missing" ? "Copying this saved version back would create the missing file at its original path." : "Copying this saved version back would replace the current file. Other files would remain as they are."}</p>
        <dl><div><dt>Saved source</dt><dd>{result.backupPath || "Unavailable"}</dd></div><div><dt>Destination in the course folder</dt><dd>{result.path}</dd></div><div><dt>Saved before replacement</dt><dd>{result.recorded.preservedAt ? formatDate(result.recorded.preservedAt, { time: true }) : "Date unavailable"}</dd></div></dl>
        {#if usableSaved && usableTarget}
          <p class="recovery-manual">This is a read-only preview. To recover manually, stop the course's fetch, make a separate copy of its folder, then copy the saved file to the destination above. For an older folder layout, check the journal's migration mappings first.</p>
        {:else}
          <p class="recovery-manual">This is a read-only preview. Resolve the file warnings and compare again before copying anything to the destination.</p>
        {/if}
      </section>
      <div class="comparison-actions">{#if result.backupPath && (result.saved.status === "available" || result.saved.status === "changed")}<a class="button secondary" href={fileEndpoint(courseId, result.backupPath, true)}><Icon name="download" />Download saved version</a>{/if}{#if result.current.status === "available"}<a class="button secondary" href={fileEndpoint(courseId, result.path, true)}><Icon name="download" />Download current file</a>{/if}</div>
    {/if}
  </div>
</Modal>

<style>
  :global(dialog.history-comparison-dialog) { width: min(980px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; }
  .comparison-body { padding: 24px; overflow-y: auto; max-height: calc(100dvh - 130px); }
  .comparison-path { margin: 0 0 18px; color: var(--ink-soft); font-size: 13px; overflow-wrap: anywhere; }
  .comparison-status { display: flex; gap: 10px; align-items: center; color: var(--green-dark); font-size: 14px; }
  .comparison-status.warning { color: var(--amber); }
  .comparison-warnings { padding-left: 20px; color: var(--amber); font-size: 12px; line-height: 1.65; }
  .comparison-versions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 20px 0 26px; }
  .comparison-versions section { padding: 16px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface-subtle); }
  h3 { margin: 0 0 10px; font-size: 14px; }
  .comparison-versions strong, .comparison-versions span, .comparison-versions small { display: block; margin-top: 5px; }
  .comparison-versions strong { font-size: 13px; }
  .comparison-versions span, .comparison-versions small { font-size: 12px; color: var(--ink-soft); }
  .comparison-diff-section > p { margin: 8px 0; }
  .diff-legend { display: inline-block; margin: 0 12px 3px 0; font-size: 12px; }
  .diff-legend.removed { color: #973d36; }
  .diff-legend.added { color: #17644d; }
  .comparison-limit { color: var(--amber); font-size: 12px; line-height: 1.6; }
  .comparison-format { color: var(--ink-soft); font-size: 11px; }
  .recovery-diff { max-height: 350px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; margin-top: 14px; }
  .diff-line { display: grid; grid-template-columns: 35px 35px 24px minmax(0, 1fr); min-height: 23px; padding-right: 12px; align-items: start; }
  .diff-line code { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 23px; }
  .diff-line.removed { background: #fff0ed; color: #823c37; }
  .diff-line.added { background: #edf8ee; color: #205b44; }
  .diff-line-number, .diff-symbol { font: 11px/23px monospace; text-align: center; color: var(--ink-soft); user-select: none; }
  .empty-diff { padding: 8px 16px; color: var(--ink-soft); font-size: 12px; }
  .recovery-plan { margin-top: 24px; padding: 18px; border: 1px solid var(--line); border-radius: var(--radius); }
  .recovery-plan p { font-size: 13px; line-height: 1.6; }
  .recovery-plan dl { margin: 16px 0; }
  .recovery-plan dl > div { margin-top: 12px; }
  .recovery-plan dt { color: var(--ink-soft); font-size: 11px; }
  .recovery-plan dd { margin: 4px 0 0; font-size: 12px; overflow-wrap: anywhere; }
  .recovery-plan .recovery-manual { color: var(--ink-soft); font-size: 12px; }
  .comparison-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
  @media (max-width: 550px) {
    .comparison-body { padding: 16px; }
    .comparison-versions { gap: 10px; }
    .comparison-versions section { padding: 12px; }
    .diff-line { grid-template-columns: 25px 25px 18px minmax(0, 1fr); }
    :global(.history-comparison-dialog .dialog-header h2) { font-size: 16px; }
    .comparison-actions .button { width: 100%; }
  }
</style>
