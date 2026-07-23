<script lang="ts">
  import CourseAvatar from "../components/CourseAvatar.svelte";
  import Icon from "../components/Icon.svelte";
  import Modal from "../components/Modal.svelte";
  import StatusBadge from "../components/StatusBadge.svelte";
  import { appState, changeState, reportError, startFetch } from "../lib/controller";
  import { formatBytes } from "../lib/format";

  let mode = "full";
  let courseConcurrency = 1;
  let attachmentConcurrency = 2;
  let reuseValidatedCache = false;
  let confirmFull = false;
  let submitting = false;
  let previousIds = "";

  $: settings = $appState.bootstrap?.settings || {};
  $: courses = ($appState.bootstrap?.inventory.courses || []).filter((course) => $appState.fetchCourseIds.includes(course.id));
  $: ids = $appState.fetchCourseIds.join(",");
  $: if (!$appState.fetchOpen) previousIds = "";
  $: if ($appState.fetchOpen && ids !== previousIds) {
    previousIds = ids;
    mode = "full";
    courseConcurrency = settings.courseConcurrency || 1;
    attachmentConcurrency = settings.attachmentConcurrency || 2;
    reuseValidatedCache = Boolean(settings.reuseValidatedCache || courses.some((course) => course.archive.exists));
    confirmFull = false;
    submitting = false;
  }
  $: freeBytes = Number($appState.bootstrap?.system?.disk?.freeBytes);
  $: hasDiskReading = Number.isFinite(freeBytes);
  $: lowStorage = hasDiskReading && freeBytes < 5 * 1024 ** 3;
  $: requiresFullConfirmation = mode === "full" && courses.length > 1;
  $: submitDisabled = !courses.length || submitting || (requiresFullConfirmation && !confirmFull);

  function adjustCourseConcurrency(change: number) {
    courseConcurrency = Math.max(1, Math.min(4, courseConcurrency + change));
  }

  function adjustAttachmentConcurrency(change: number) {
    attachmentConcurrency = Math.max(1, Math.min(8, attachmentConcurrency + change));
  }

  async function submit() {
    if (submitDisabled) return;
    submitting = true;
    try {
      await startFetch({ mode, courseConcurrency, attachmentConcurrency, reuseValidatedCache, confirmFull });
    } catch (error) {
      reportError(error);
    } finally {
      submitting = false;
    }
  }
</script>

<Modal open={$appState.fetchOpen} className="fetch-dialog" labelledby="fetch-title" close={() => changeState((state) => state.fetchOpen = false)}>
  <form onsubmit={(event) => { event.preventDefault(); submit(); }}>
    <div class="dialog-header fetch-dialog-header">
      <div class="fetch-dialog-title"><span class="fetch-title-icon"><Icon name="hard-drive-download" /></span><span><span class="eyebrow">Archive operation</span><h2 id="fetch-title">Start fetch</h2><small>{courses.length} {courses.length === 1 ? "course" : "courses"} selected</small></span></div>
      <button class="icon-button" type="button" onclick={() => changeState((state) => state.fetchOpen = false)} title="Close" aria-label="Close"><Icon name="x" /></button>
    </div>
    <div id="fetch-dialog-body">
      <section class="fetch-section" aria-labelledby="fetch-courses-title">
        <div class="fetch-section-heading"><div><h3 id="fetch-courses-title">Courses</h3><p>Included in this operation</p></div><span class="badge neutral">{courses.length}</span></div>
        <div class="selected-courses">
          {#each courses as course}
            <div class="selected-course"><CourseAvatar {course} /><span class="selected-course-name"><strong>{course.name}</strong><small>{course.code} · {course.termName}</small></span><StatusBadge status={course.archive.status} /></div>
          {/each}
        </div>
      </section>

      <fieldset class="fetch-section fetch-mode">
        <legend class="sr-only">Download mode</legend>
        <div class="fetch-section-heading"><div><h3>Download mode</h3><p>Choose the archive depth</p></div></div>
        <div class="fetch-mode-control">
          <label class:selected={mode === "placeholder"}>
            <input type="radio" bind:group={mode} value="placeholder" />
            <span class="fetch-mode-icon"><Icon name="file-question" /></span>
            <span class="fetch-mode-copy"><strong>Placeholder</strong><small>Text, structure, and file metadata</small></span>
            <span class="fetch-mode-check"><Icon name="check" /></span>
          </label>
          <label class:selected={mode === "full"}>
            <input type="radio" bind:group={mode} value="full" />
            <span class="fetch-mode-icon"><Icon name="hard-drive-download" /></span>
            <span class="fetch-mode-copy"><strong>Full archive</strong><small>All accessible file bodies</small></span>
            <span class="fetch-mode-check"><Icon name="check" /></span>
          </label>
        </div>
      </fieldset>

      <section class="fetch-section" aria-labelledby="fetch-performance-title">
        <div class="fetch-section-heading"><div><h3 id="fetch-performance-title">Performance</h3><p>Blackboard request concurrency</p></div></div>
        <div class="fetch-settings">
          <div class="fetch-setting-row">
            <span><label for="fetch-course-concurrency">Concurrent courses</label><small>Course workers in this batch</small></span>
            <div class="number-stepper"><button type="button" onclick={() => adjustCourseConcurrency(-1)} disabled={courseConcurrency <= 1} title="Decrease concurrent courses" aria-label="Decrease concurrent courses"><Icon name="minus" /></button><output id="fetch-course-concurrency" aria-live="polite">{courseConcurrency}</output><button type="button" onclick={() => adjustCourseConcurrency(1)} disabled={courseConcurrency >= 4} title="Increase concurrent courses" aria-label="Increase concurrent courses"><Icon name="plus" /></button></div>
          </div>
          <div class="fetch-setting-row">
            <span><label for="fetch-attachment-concurrency">Attachments per course</label><small>Parallel file transfers for each course</small></span>
            <div class="number-stepper"><button type="button" onclick={() => adjustAttachmentConcurrency(-1)} disabled={attachmentConcurrency <= 1} title="Decrease attachment workers" aria-label="Decrease attachment workers"><Icon name="minus" /></button><output id="fetch-attachment-concurrency" aria-live="polite">{attachmentConcurrency}</output><button type="button" onclick={() => adjustAttachmentConcurrency(1)} disabled={attachmentConcurrency >= 8} title="Increase attachment workers" aria-label="Increase attachment workers"><Icon name="plus" /></button></div>
          </div>
          <label class="fetch-toggle-row"><input type="checkbox" bind:checked={reuseValidatedCache} /><span class="fetch-switch" aria-hidden="true"><span></span></span><span><strong>Validate and reuse local files</strong><small>Avoid downloading unchanged files again</small></span></label>
        </div>
      </section>

      {#if requiresFullConfirmation}
        <label class="fetch-confirmation"><input type="checkbox" bind:checked={confirmFull} /><span><strong>Confirm full download for {courses.length} courses</strong><small>This batch can use substantial bandwidth and storage.</small></span></label>
      {/if}

      <div class="fetch-notice" class:warning={mode === "full"} class:info={mode !== "full"}>
        <Icon name={mode === "full" ? "triangle-alert" : "info"} />
        <span>
          <strong>{mode === "full" ? (lowStorage ? "Low archive storage" : "Full file download") : "Metadata-only archive"}</strong>
          <small>{mode === "full" ? `${hasDiskReading ? `${formatBytes(freeBytes)} free. ` : ""}Accessible documents, media, submissions, and feedback files will be downloaded.` : "Binary attachments will be represented by local metadata placeholders."}</small>
        </span>
      </div>
    </div>
    <div class="dialog-footer fetch-dialog-footer"><span class="fetch-footer-summary"><strong>{courses.length}</strong> {courses.length === 1 ? "course" : "courses"} · {mode === "full" ? "Full archive" : "Placeholder"}</span><span class="fetch-footer-actions"><button class="button secondary" type="button" onclick={() => changeState((state) => state.fetchOpen = false)}>Cancel</button><button class="button primary" type="submit" disabled={submitDisabled}><Icon name={submitting ? "refresh-cw" : "download"} /><span>{submitting ? "Starting" : courses.length > 1 ? "Start batch" : "Start fetch"}</span></button></span></div>
  </form>
</Modal>
