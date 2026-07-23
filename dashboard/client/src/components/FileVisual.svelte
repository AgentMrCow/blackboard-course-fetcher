<script lang="ts">
  import { fileEndpoint, fileIconName } from "../lib/format";
  import type { ArchiveFile } from "../lib/types";
  import Icon from "./Icon.svelte";

  export let file: ArchiveFile;
  export let courseId = file.courseId || "";
  export let mini = false;
</script>

{#if file.preview === "image"}
  <span class={mini ? "file-mini-image" : "file-visual"}>
    <img src={fileEndpoint(courseId, file.path)} alt="" loading="lazy" />
  </span>
{:else}
  <span class={mini ? `file-icon ${file.preview}` : "file-visual"}>
    <Icon name={fileIconName(file.preview)} />
  </span>
{/if}
