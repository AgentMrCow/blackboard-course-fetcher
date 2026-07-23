<script lang="ts">
  import { tick } from "svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import Modal from "../components/Modal.svelte";
  import { appState, changeState, navigate, openFile, reportError, searchArchive } from "../lib/controller";
  import { fileIconName } from "../lib/format";

  let timer: number;
  let input: HTMLInputElement;
  let wasOpen = false;
  $: if ($appState.searchOpen && !wasOpen) { wasOpen = true; tick().then(() => input?.focus()); }
  $: if (!$appState.searchOpen) wasOpen = false;

  function query(value: string) {
    changeState((state) => state.searchQuery = value);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => searchArchive(value).catch(reportError), 280);
  }

  function choose(result: any) {
    changeState((state) => state.searchOpen = false);
    if (result.type === "course") navigate(`course/${encodeURIComponent(result.courseId)}/overview`);
    else openFile(result.courseId, result.path).catch(reportError);
  }
</script>

<Modal open={$appState.searchOpen} className="command-dialog" labelledby="search-title" close={() => changeState((state) => state.searchOpen = false)}>
  <div class="dialog-header compact"><div class="search-input-wrap"><Icon name="search" /><input bind:this={input} type="search" autocomplete="off" placeholder="Search titles, paths, and text content" value={$appState.searchQuery} oninput={(event) => query(event.currentTarget.value)} aria-labelledby="search-title" /></div><button class="icon-button" onclick={() => changeState((state) => state.searchOpen = false)} title="Close" aria-label="Close"><Icon name="x" /></button></div>
  <h2 class="sr-only" id="search-title">Archive search</h2>
  <div class="command-results">
    {#if $appState.searchLoading}<div class="page-loading" style="min-height:150px"><span class="spinner"></span><span>Searching local files</span></div>
    {:else if $appState.searchQuery.trim().length < 2}<EmptyState icon="search" title={$appState.searchQuery ? "Enter at least two characters" : "Search the local archive"} copy={$appState.searchQuery ? "Search runs entirely against files in the configured archive directory." : "Matches include course names, file paths, and the content of archived text and JSON files."} />
    {:else if !$appState.searchResults.length}<EmptyState icon="search-x" title="No local matches" copy="Try a course code, file name, or phrase from an archived text document." />
    {:else}{#each $appState.searchResults as result}<button class="command-result" onclick={() => choose(result)}><span class="file-icon {result.preview || "course"}"><Icon name={result.type === "course" ? "book-open" : fileIconName(result.preview || "file")} /></span><span><strong>{result.title}</strong><small>{result.snippet || result.courseCode}</small></span><span class="badge neutral">{result.courseCode}</span></button>{/each}{/if}
  </div>
</Modal>
