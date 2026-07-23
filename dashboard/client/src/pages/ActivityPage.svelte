<script lang="ts">
  import CourseAvatar from "../components/CourseAvatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import StatusBadge from "../components/StatusBadge.svelte";
  import { appState, cancelInventory, changeState, controlBatch, controlTask, navigate, openFetch, reportError } from "../lib/controller";
  import { formatDuration, formatDate, relativeTime, titleCase } from "../lib/format";
  import type { FetchBatch, FetchTask } from "../lib/types";

  $: jobs = $appState.bootstrap!.jobs || [];
  $: current = jobs[0] || null;
  $: inventory = $appState.bootstrap!.inventoryTask;
  $: if (current && !$appState.logTaskId) changeState((state) => state.logTaskId = current.tasks.find((task) => task.status === "running")?.id || current.tasks[0]?.id || null);
  $: logTask = jobs.flatMap((job) => job.tasks).find((task) => task.id === $appState.logTaskId) || null;
  $: logs = logTask?.logs || inventory?.logs || [];

  function taskCommand(event: MouseEvent, batch: FetchBatch, task: FetchTask, action: string) {
    event.stopPropagation();
    controlTask(batch.id, task.courseId, action).catch(reportError);
  }

  function openNewFetch() {
    navigate("courses");
  }
</script>

<div class="page">
  <header class="page-header"><div><span class="eyebrow">Live and historical operations</span><h1>Fetch activity</h1><p>Control each course independently and inspect the fetcher's current work.</p></div><div class="page-actions"><button class="button primary" onclick={openNewFetch}><Icon name="download" /><span>New fetch</span></button></div></header>
  <div class="activity-layout">
    <div>
      {#if current}
        <section>
          <div class="batch-header">
            <div><h2>{titleCase(current.status)} · {current.tasks.length} course{current.tasks.length === 1 ? "" : "s"}</h2><p>{titleCase(current.options.mode)} mode · {current.options.courseConcurrency} course and {current.options.attachmentConcurrency} attachment workers</p></div>
            <div class="batch-progress"><div class="progress-track"><span class="progress-bar" style={`width:${current.progress}%`}></span></div><div class="progress-meta"><span>{current.progress}% complete</span><span>{current.remainingMs == null ? "ETA paused" : current.remainingMs ? `Estimated ${formatDuration(current.remainingMs)} left` : "Finished"}</span></div></div>
            <div class="task-actions">
              {#if ["running", "queued"].includes(current.status)}<button class="icon-button" onclick={() => controlBatch(current.id, "pause").catch(reportError)} title="Pause batch" aria-label="Pause batch"><Icon name="pause" /></button>{:else if current.status === "paused"}<button class="icon-button" onclick={() => controlBatch(current.id, "resume").catch(reportError)} title="Resume batch" aria-label="Resume batch"><Icon name="play" /></button>{/if}
              {#if ["running", "queued", "paused"].includes(current.status)}<button class="icon-button danger" onclick={() => controlBatch(current.id, "cancel").catch(reportError)} title="Cancel batch" aria-label="Cancel batch"><Icon name="square" /></button>{/if}
            </div>
          </div>
          <div class="task-list">
            {#each current.tasks as task}
              <div class="task-row" class:active={$appState.logTaskId === task.id} role="button" tabindex="0" onclick={() => changeState((state) => state.logTaskId = task.id)} onkeydown={(event) => { if (event.key === "Enter") changeState((state) => state.logTaskId = task.id); }}>
                <CourseAvatar course={{ id: task.courseId, code: task.courseCode, name: task.courseName } as any} />
                <div class="task-title"><strong>{task.courseName}</strong><small>{task.currentPhase} · {task.currentItem}</small></div>
                <div class="task-progress"><div class="progress-track"><span class="progress-bar" style={`width:${task.progress}%`}></span></div><div class="progress-meta"><span>{task.progress}% · {titleCase(task.status)}</span><span>{task.remainingMs && !["completed", "incomplete", "failed", "cancelled"].includes(task.status) ? `${formatDuration(task.remainingMs)} remaining` : task.result ? `${task.result.fileCount || 0} files · ${task.result.errors || 0} errors` : ""}</span></div></div>
                <div class="task-actions">
                  {#if ["running", "queued"].includes(task.status)}
                    <button class="icon-button" onclick={(event) => taskCommand(event, current, task, "pause")} title="Pause course fetch" aria-label="Pause course fetch"><Icon name="pause" /></button><button class="icon-button danger" onclick={(event) => taskCommand(event, current, task, "cancel")} title="Cancel course fetch" aria-label="Cancel course fetch"><Icon name="x" /></button>
                  {:else if ["paused", "interrupted", "failed", "incomplete", "cancelled"].includes(task.status)}
                    <button class="icon-button" onclick={(event) => taskCommand(event, current, task, "resume")} title="Resume with validated cache" aria-label="Resume with validated cache"><Icon name="play" /></button>{#if task.status === "paused"}<button class="icon-button danger" onclick={(event) => taskCommand(event, current, task, "cancel")} title="Cancel course fetch" aria-label="Cancel course fetch"><Icon name="x" /></button>{/if}
                  {:else}<button class="icon-button" onclick={(event) => { event.stopPropagation(); openFetch([task.courseId]); }} title="Fetch again" aria-label="Fetch again"><Icon name="refresh-cw" /></button>{/if}
                </div>
              </div>
            {/each}
          </div>
        </section>
      {:else}
        <div class="data-surface"><EmptyState icon="activity" title="No fetch history" copy="Start a course fetch to see phase, file, transfer, and ETA updates here."><button class="button primary" onclick={openNewFetch}><Icon name="download" /><span>Start a fetch</span></button></EmptyState></div>
      {/if}
      {#if inventory?.status !== "idle"}
        <section class="term-section"><div class="section-heading"><h2>Course inventory</h2><StatusBadge status={inventory.status} /></div><div class="batch-header"><div><h2>{inventory.message || "Scanning memberships"}</h2><p>{inventory.startedAt ? `Started ${relativeTime(inventory.startedAt)}` : ""}</p></div><div class="batch-progress"><div class="progress-track"><span class="progress-bar" style={`width:${inventory.status === "completed" ? 100 : inventory.status === "running" ? 55 : 0}%`}></span></div><div class="progress-meta"><span>{titleCase(inventory.status)}</span><span>{formatDuration(inventory.elapsedMs)}</span></div></div>{#if inventory.status === "running"}<button class="icon-button danger" onclick={() => cancelInventory().catch(reportError)} title="Cancel inventory" aria-label="Cancel inventory"><Icon name="x" /></button>{/if}</div></section>
      {/if}
      {#if jobs.length > 1}
        <section class="term-section"><div class="section-heading"><h2>Earlier batches</h2></div><div class="data-surface"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Started</th><th>Mode</th><th>Courses</th><th>Status</th><th>Duration</th></tr></thead><tbody>{#each jobs.slice(1, 12) as job}<tr><td>{formatDate(job.startedAt || job.createdAt, { time: true })}</td><td>{titleCase(job.options.mode)}</td><td>{job.tasks.length}</td><td><StatusBadge status={job.status} /></td><td>{job.startedAt ? formatDuration(Date.parse(job.finishedAt || new Date().toISOString()) - Date.parse(job.startedAt)) : "-"}</td></tr>{/each}</tbody></table></div></div></section>
      {/if}
    </div>
    <aside class="log-panel"><header><strong>{logTask ? `${logTask.courseCode} output` : "Operation output"}</strong><span class="badge neutral">{logs.length}</span></header><div class="log-lines">{#each logs as entry}<div class="log-line" class:stderr={entry.stream === "stderr"}><time>{new Date(entry.at).toLocaleTimeString("en-HK", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>{entry.line}</div>{:else}<div class="log-line">Select a course task to inspect its recent output.</div>{/each}</div></aside>
  </div>
</div>
