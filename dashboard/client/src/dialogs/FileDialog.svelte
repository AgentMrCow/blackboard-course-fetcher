<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import Modal from "../components/Modal.svelte";
  import { appState, changeState, openFetch, showToast } from "../lib/controller";
  import { artifactOriginLabel, fileEndpoint, fileIconName, formatBytes } from "../lib/format";

  $: dialog = $appState.fileDialog;
  $: file = dialog.file;
  $: url = file ? fileEndpoint(dialog.courseId, file.path) : "";
  $: downloadUrl = file ? fileEndpoint(dialog.courseId, file.path, true) : "#";

  function close() {
    changeState((state) => state.fileDialog.open = false);
  }

  async function copyPath() {
    if (!file) return;
    await navigator.clipboard.writeText(file.path);
    showToast("Archive path copied.", "success");
  }

  function fetchFull() {
    close();
    openFetch([dialog.courseId]);
  }
</script>

<Modal open={dialog.open} className="file-dialog" labelledby="file-title" {close}>
  {#if file}
    <div class="file-dialog-header"><div class="file-dialog-title"><span class="file-type-icon"><Icon name={fileIconName(file.preview)} /></span><div><h2 id="file-title">{file.name}</h2><p>{artifactOriginLabel(file.origin)} · {file.path} · {formatBytes(file.size)}</p></div></div><div class="dialog-header-actions"><a class="icon-button" href={downloadUrl} title="Download file" aria-label="Download file"><Icon name="download" /></a><button class="icon-button" onclick={() => copyPath().catch(() => showToast("Unable to copy the archive path.", "error"))} title="Copy archive path" aria-label="Copy archive path"><Icon name="copy" /></button><button class="icon-button" onclick={close} title="Close" aria-label="Close"><Icon name="x" /></button></div></div>
    <div class="file-preview">
      {#if dialog.loading}<div class="page-loading"><span class="spinner"></span><span>Opening local file</span></div>
      {:else if dialog.error}<div class="empty-state"><Icon name="file-warning" /><h3>Preview unavailable</h3><p>{dialog.error}</p><a class="button secondary" href={downloadUrl}>Download file</a></div>
      {:else if file.preview === "pdf"}<iframe src={url} title={file.name}></iframe>
      {:else if file.preview === "image"}<img src={url} alt={file.name} />
      {:else if file.preview === "video"}<video src={url} controls preload="metadata"><track kind="captions" /></video>
      {:else if file.preview === "audio"}<audio src={url} controls preload="metadata"><track kind="captions" /></audio>
      {:else if file.preview === "html"}<iframe src={url} sandbox="" title={file.name}></iframe>
      {:else if file.preview === "link"}<div class="file-info-preview"><Icon name="external-link" /><h3>{file.name}</h3><p>{dialog.link || dialog.text.trim()}</p>{#if dialog.link}<a class="button primary" href={dialog.link} target="_blank" rel="noreferrer"><Icon name="external-link" /><span>Open destination</span></a>{/if}</div>
      {:else if file.preview === "placeholder"}<div class="file-info-preview"><Icon name="file-question" /><h3>{dialog.parsed?.originalFileName || file.name}</h3><p>This binary body was intentionally omitted in placeholder mode.</p><dl class="definition-list"><div class="definition-row"><dt>Type</dt><dd>{dialog.parsed?.mimeType || "Unknown"}</dd></div><div class="definition-row"><dt>Remote size</dt><dd>{formatBytes(dialog.parsed?.remoteSize)}</dd></div><div class="definition-row"><dt>Reason</dt><dd>{dialog.parsed?.reason || "Placeholder mode"}</dd></div></dl><button class="button primary" onclick={fetchFull}><Icon name="hard-drive-download" /><span>Fetch course in full mode</span></button></div>
      {:else if ["text", "json", "unresolved"].includes(file.preview)}<pre class="text-preview">{dialog.text}</pre>
      {:else}<div class="file-info-preview"><Icon name={fileIconName(file.preview)} /><h3>{file.name}</h3><p>This file is indexed and available locally. Use the download button to open it with the installed desktop application.</p><dl class="definition-list"><div class="definition-row"><dt>Archive area</dt><dd>{file.category || "Course records"}</dd></div><div class="definition-row"><dt>Size</dt><dd>{formatBytes(file.size)}</dd></div><div class="definition-row"><dt>Path</dt><dd>{file.path}</dd></div></dl><a class="button primary" href={downloadUrl}><Icon name="download" /><span>Open or download file</span></a></div>{/if}
    </div>
  {/if}
</Modal>
