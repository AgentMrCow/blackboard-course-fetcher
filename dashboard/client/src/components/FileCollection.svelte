<script lang="ts">
  import { artifactOriginLabel, formatBytes, formatDate } from "../lib/format";
  import type { ArchiveFile } from "../lib/types";
  import FileVisual from "./FileVisual.svelte";
  import Icon from "./Icon.svelte";

  export let files: ArchiveFile[];
  export let courseId = "";
  export let view: "table" | "grid" = "table";
  export let openFile: (courseId: string, path: string) => void;

  const idFor = (file: ArchiveFile) => courseId || file.courseId || "";
</script>

{#if view === "grid"}
  <div class="file-grid">
    {#each files as file}
      <button class="file-tile" onclick={() => openFile(idFor(file), file.path)}>
        <FileVisual {file} courseId={idFor(file)} />
        <strong>{file.name}</strong>
        <small>{courseId ? file.category : file.courseCode} · {formatBytes(file.size)}</small>
        <span class="badge neutral">{artifactOriginLabel(file.origin)}</span>
      </button>
    {/each}
  </div>
{:else}
  <div class="data-surface file-table-surface"><div class="data-table-wrap file-table-wrap"><table class="data-table file-table">
    <thead><tr><th>File</th>{#if !courseId}<th class="course-cell">Course</th>{/if}<th class="origin-cell">Origin</th><th class="area-cell">Area</th><th class="size-cell">Size</th><th class="modified-cell">Modified</th></tr></thead>
    <tbody>
      {#each files as file}
        <tr class="file-table-row">
          <td class="title-cell"><div class="file-name"><span class="file-icon {file.preview}"><Icon name={file.preview === "image" ? "file-image" : file.preview === "pdf" ? "file-text" : file.preview === "office" ? "file-spreadsheet" : file.preview === "placeholder" ? "file-question" : "file"} /></span><span><button class="table-link" onclick={() => openFile(idFor(file), file.path)}>{file.name}</button><small>{file.path}</small></span></div></td>
          {#if !courseId}<td class="course-cell">{file.courseCode}</td>{/if}
          <td class="origin-cell"><span class="badge neutral" title={file.role}>{artifactOriginLabel(file.origin)}</span></td><td class="area-cell">{file.category}</td><td class="size-cell">{formatBytes(file.size)}</td><td class="modified-cell">{formatDate(file.modifiedAt, { time: true })}</td>
        </tr>
      {/each}
    </tbody>
  </table></div></div>
{/if}
