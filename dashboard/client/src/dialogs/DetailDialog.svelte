<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import Modal from "../components/Modal.svelte";
  import StatusBadge from "../components/StatusBadge.svelte";
  import { appState, changeState, navigate, openFile, openFetch, reportError } from "../lib/controller";
  import { assessmentStatus, fileIconName, formatBytes, formatDate, relativeTime, titleCase } from "../lib/format";

  $: dialog = $appState.detailDialog;
  $: assessment = dialog.kind === "assignment" ? dialog.item : null;
  $: announcement = dialog.kind === "announcement" ? dialog.item : null;

  function close() {
    changeState((state) => state.detailDialog.open = false);
  }

  function openCourse(courseId: string) {
    close();
    navigate(`course/${encodeURIComponent(courseId)}/overview`);
  }

  function fetchCourse(courseId: string) {
    close();
    openFetch([courseId]);
  }
</script>

<Modal open={dialog.open} className="detail-dialog" labelledby="detail-title" {close}>
  <div class="dialog-header"><div><span class="eyebrow">{dialog.eyebrow}</span><h2 id="detail-title">{dialog.title}</h2></div><button class="icon-button" onclick={close} title="Close" aria-label="Close"><Icon name="x" /></button></div>
  <div id="detail-body">
    {#if dialog.kind === "course" && dialog.course}
      {@const course = dialog.course}
      <dl class="definition-list"><div class="definition-row"><dt>Course ID</dt><dd>{course.id}</dd></div><div class="definition-row"><dt>External ID</dt><dd>{course.externalId || "Not available"}</dd></div><div class="definition-row"><dt>Course view</dt><dd>{course.view}</dd></div><div class="definition-row"><dt>Blackboard availability</dt><dd>{course.available ? "Available" : "Unavailable"}</dd></div><div class="definition-row"><dt>Archive status</dt><dd>{titleCase(course.archive.status)}</dd></div><div class="definition-row"><dt>Local directory</dt><dd>{course.outputDirectory}</dd></div></dl><div class="setup-actions"><button class="button primary" onclick={() => openCourse(course.id)}><Icon name="book-open" /><span>Open course</span></button><button class="button secondary" onclick={() => fetchCourse(course.id)}><Icon name="refresh-cw" /><span>{course.archive.exists ? "Refresh archive" : "Fetch course"}</span></button>{#if course.archive.exists}<a class="button secondary" href={`#/course/${encodeURIComponent(course.id)}/health`} onclick={close}><Icon name="shield-check" /><span>Archive health</span></a>{/if}</div>
    {:else if assessment && dialog.courseDetail}
      {@const courseId = dialog.courseDetail.course.id}
      <div class="metric-grid detail-metrics" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="metric"><span class="metric-label">Due</span><strong>{assessment.dueDate ? formatDate(assessment.dueDate, { time: true }) : "Not set"}</strong><small>{assessment.dueDate ? relativeTime(assessment.dueDate) : "No deadline"}</small></div><div class="metric"><span class="metric-label">Status</span><strong>{titleCase(assessmentStatus(assessment))}</strong><small>{assessment.attempts?.length || 0} archived attempts</small></div><div class="metric"><span class="metric-label">Score</span><strong>{assessment.grade?.score == null ? "-" : `${assessment.grade.score} / ${assessment.grade.pointsPossible ?? assessment.possiblePoints ?? "-"}`}</strong><small>{assessment.grade?.percentage == null ? "Not graded" : `${Number(assessment.grade.percentage).toFixed(1)}%`}</small></div></div>
      <section class="detail-section"><h3>Instructions</h3><div class="detail-copy">{dialog.instructions}</div>{#if dialog.instructionHtmlPath}<div class="setup-actions"><button class="button secondary small" onclick={() => openFile(courseId, dialog.instructionHtmlPath!).catch(reportError)}><Icon name="panel-top-open" /><span>Open formatted instructions</span></button></div>{/if}</section>
      {#each assessment.attempts || [] as attempt, index}<section class="detail-section"><h3>Attempt {index + 1} · {titleCase(attempt.status)}</h3><dl class="definition-list"><div class="definition-row"><dt>Submitted</dt><dd>{formatDate(attempt.attemptDate, { time: true })}</dd></div><div class="definition-row"><dt>Receipt</dt><dd>{attempt.receipt || "Not available"}</dd></div><div class="definition-row"><dt>Score</dt><dd>{attempt.grade?.score == null ? "Not graded" : `${attempt.grade.score} / ${attempt.grade.pointsPossible ?? assessment.possiblePoints ?? "-"}`}</dd></div><div class="definition-row"><dt>Group</dt><dd>{attempt.groupName || "Individual"}</dd></div></dl>{#if attempt.feedback?.text}<div class="detail-copy" style="margin-top:10px"><strong>Feedback</strong>
{attempt.feedback.text}</div>{/if}</section>{/each}
      {#if dialog.files?.length}<section class="detail-section"><h3>Archived files ({dialog.files.length})</h3>{#each dialog.files as file}<button class="detail-file" onclick={() => openFile(courseId, file.path).catch(reportError)}><span class="file-icon {file.preview}"><Icon name={fileIconName(file.preview)} /></span><span><strong>{file.name}</strong><small>{file.path}</small></span><span>{formatBytes(file.size)}</span></button>{/each}</section>{/if}
    {:else if announcement && dialog.courseDetail}
      <div class="detail-copy">{announcement.text || "No plain-text announcement body was archived."}</div>{#if announcement.htmlPath}<div class="setup-actions"><button class="button secondary" onclick={() => openFile(dialog.courseDetail!.course.id, announcement.htmlPath).catch(reportError)}><Icon name="panel-top-open" /><span>Open archived HTML</span></button></div>{/if}
    {/if}
  </div>
</Modal>
