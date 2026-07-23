<script lang="ts">
  import type { JsonRecord } from "../lib/types";
  import Icon from "./Icon.svelte";

  export let settings: JsonRecord;
  export let id = "settings-form";
  export let submit: (form: HTMLFormElement) => void;
</script>

<form {id} onsubmit={(event) => { event.preventDefault(); submit(event.currentTarget); }}>
  <div class="form-grid">
    <div class="field full"><label for={`${id}-base`}>Blackboard URL</label><input id={`${id}-base`} name="blackboardBase" type="url" required placeholder="https://blackboard.example.edu" value={settings.blackboardBase} /><small>The institution's Blackboard origin. Course paths are discovered from the API.</small></div>
    <div class="field full"><label for={`${id}-archive`}>Archive directory</label><input id={`${id}-archive`} name="archiveRoot" type="text" required value={settings.archiveRoot} /><small>All inventory, manifests, and course files are read directly from this directory.</small></div>
    <div class="field full"><label for={`${id}-state`}>Session state file</label><input id={`${id}-state`} name="stateFile" type="text" required value={settings.stateFile} /><small>This private file contains the authenticated browser session used by local fetch jobs.</small></div>
    <div class="field"><label for={`${id}-courses`}>Concurrent courses</label><select id={`${id}-courses`} name="courseConcurrency" value={settings.courseConcurrency}>{#each [1, 2, 3, 4] as number}<option value={number}>{number}</option>{/each}</select></div>
    <div class="field"><label for={`${id}-attachments`}>Attachments per course</label><select id={`${id}-attachments`} name="attachmentConcurrency" value={settings.attachmentConcurrency}>{#each [1, 2, 3, 4, 5, 6, 7, 8] as number}<option value={number}>{number}</option>{/each}</select></div>
  </div>
  <div class="setup-actions"><button class="button primary" type="submit"><Icon name="save" /><span>Save settings</span></button></div>
</form>
