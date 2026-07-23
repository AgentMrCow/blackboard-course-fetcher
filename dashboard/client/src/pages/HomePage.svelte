<script lang="ts">
  import CourseAvatar from "../components/CourseAvatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import FileVisual from "../components/FileVisual.svelte";
  import Icon from "../components/Icon.svelte";
  import StatusBadge from "../components/StatusBadge.svelte";
  import { activeBatch, openAnnouncement, openCalendarItem, openFile, openSetup, runInventory } from "../lib/controller";
  import { formatBytes, formatDate, relativeTime } from "../lib/format";
  import { appState, navigate, reportError } from "../lib/controller";

  $: bootstrap = $appState.bootstrap!;
  $: summary = bootstrap.summary;
  $: inventory = bootstrap.inventory;
  $: upcoming = summary.deadlines
    .filter((item: any) => new Date(item.dueDate).valueOf() >= Date.now() - 86_400_000)
    .sort((left: any, right: any) => new Date(left.dueDate).valueOf() - new Date(right.dueDate).valueOf())
    .slice(0, 7);
  $: recentCourses = inventory.courses
    .filter((course) => course.archive.exists)
    .sort((left, right) => String(right.archive.generatedAt || "").localeCompare(String(left.archive.generatedAt || "")))
    .slice(0, 5);
  $: recentFiles = summary.recentFiles.slice(0, 5);
  $: sessionReady = bootstrap.auth?.validation?.valid === true || bootstrap.auth?.status === "connected";
  $: sessionChecking = bootstrap.auth?.status === "checking";
  $: inventoryReady = Boolean(inventory?.generatedAt && inventory?.courses?.length);
  $: archiveReady = Boolean(summary?.archivedCount);
  $: batch = activeBatch(bootstrap);

  function safe(action: Promise<unknown>) {
    action.catch(reportError);
  }
</script>

<div class="page">
  <header class="page-header">
    <div>
      <span class="eyebrow">Local workspace</span>
      <h1>Overview</h1>
      <p>Your course data remains available even when Blackboard is not.</p>
    </div>
    <div class="page-actions">
      <button class="button secondary" onclick={() => safe(runInventory())}><Icon name="scan-search" /><span>Scan courses</span></button>
      <button class="button primary" onclick={() => { navigate("courses"); }}><Icon name="download" /><span>Fetch courses</span></button>
    </div>
  </header>

  <div class="readiness-strip">
    <div class="readiness-item" class:ready={sessionReady} class:warning={!sessionReady}>
      <span class="readiness-icon"><Icon name={sessionReady ? "shield-check" : sessionChecking ? "refresh-cw" : "shield-alert"} /></span>
      <span>
        <strong>{sessionReady ? "Blackboard session ready" : sessionChecking ? "Checking Blackboard session" : "Session needs attention"}</strong>
        <span>{sessionReady ? bootstrap.auth.validation?.user?.userName || "Authenticated locally" : sessionChecking ? "Validating the saved browser state" : bootstrap.auth?.exists ? "Verify or sign in again" : "No session has been saved"}</span>
      </span>
    </div>
    <div class="readiness-item" class:ready={inventoryReady} class:warning={!inventoryReady}>
      <span class="readiness-icon"><Icon name={inventoryReady ? "list-checks" : "refresh-cw"} /></span>
      <span><strong>{inventoryReady ? `${inventory.courses.length} courses inventoried` : "Course inventory missing"}</strong><span>{inventoryReady ? `Scanned ${relativeTime(inventory.generatedAt)}` : "Scan before choosing courses"}</span></span>
    </div>
    <div class="readiness-item" class:ready={archiveReady} class:warning={!archiveReady}>
      <span class="readiness-icon"><Icon name="archive" /></span>
      <span><strong>{archiveReady ? `${summary.archivedCount} course archives available` : "No course archive yet"}</strong><span>{formatBytes(summary?.bytes || 0)} stored locally</span></span>
    </div>
    <div class="readiness-action"><button class="button secondary" onclick={() => openSetup()}><Icon name="settings-2" /><span>Review setup</span></button></div>
  </div>

  {#if batch}
    {@const running = batch.tasks.find((task) => task.status === "running") || batch.tasks.find((task) => task.status === "paused") || batch.tasks[0]}
    <section class="active-fetch">
      <div><h3>{batch.status === "paused" ? "Fetch paused" : "Archive fetch in progress"}</h3><p>{running?.courseCode || "Preparing"} · {running?.currentItem || "Waiting"}</p></div>
      <div><div class="progress-track dark"><span class="progress-bar" style={`width:${batch.progress}%`}></span></div><div class="progress-meta"><span>{batch.progress}% complete</span><span>{batch.remainingMs == null ? "ETA paused" : `About ${Math.max(1, Math.round(batch.remainingMs / 60_000))} mins left`}</span></div></div>
      <a class="button secondary" href="#/activity">Open activity</a>
    </section>
  {/if}

  <section class="metric-grid" aria-label="Archive summary">
    <div class="metric metric-courses"><span class="metric-label"><span>Courses archived</span><Icon name="book-copy" /></span><strong>{summary.archivedCount}</strong><small>{summary.completeCount} passed the latest coverage audit</small></div>
    <div class="metric metric-materials"><span class="metric-label"><span>Course materials</span><Icon name="files" /></span><strong>{Number(summary.materialFiles ?? summary.files).toLocaleString()}</strong><small>{formatBytes(summary.materialBytes ?? summary.bytes)} · {Number(summary.recordFiles || 0).toLocaleString()} archive records</small></div>
    <div class="metric metric-upcoming"><span class="metric-label"><span>Upcoming work</span><Icon name="calendar-clock" /></span><strong>{upcoming.length}</strong><small>Deadlines visible in fetched courses</small></div>
    <div class="metric metric-inventory"><span class="metric-label"><span>Inventory</span><Icon name="refresh-cw" /></span><strong>{inventory.courses.length}</strong><small>Last scanned {inventory.generatedAt ? relativeTime(inventory.generatedAt) : "Not scanned"}</small></div>
  </section>

  <div class="dashboard-grid">
    <div class="dashboard-column">
      <section class="section-block">
        <div class="section-heading"><h2>Next deadlines</h2><a href="#/calendar">Full calendar</a></div>
        <div class="data-surface">
          {#if upcoming.length}
            <div class="data-table-wrap"><table class="data-table"><thead><tr><th>Assessment</th><th>Due</th><th>Status</th><th>Score</th></tr></thead><tbody>
              {#each upcoming as item}
                <tr><td class="title-cell"><button class="table-link" onclick={() => safe(openCalendarItem(item.courseId, item.title))}>{item.title}</button><small>{item.courseCode}</small></td><td>{formatDate(item.dueDate, { time: true })}</td><td><StatusBadge status={item.status} /></td><td>{item.score == null ? "-" : `${item.score}/${item.pointsPossible ?? "-"}`}</td></tr>
              {/each}
            </tbody></table></div>
          {:else}<EmptyState icon="calendar-check" title="No upcoming deadlines" copy="Fetch a current course to populate this schedule." />{/if}
        </div>
      </section>
      <section class="section-block">
        <div class="section-heading"><h2>Recently archived courses</h2><a href="#/courses">All courses</a></div>
        <div class="data-surface"><div class="data-table-wrap"><table class="data-table"><tbody>
          {#each recentCourses as course}
            <tr><td><div class="file-name recent-course-name"><CourseAvatar {course} /><div class="title-cell"><button class="table-link" onclick={() => navigate(`course/${encodeURIComponent(course.id)}/overview`)}>{course.name}</button><small>{course.termName}</small></div></div></td><td><StatusBadge status={course.archive.status} /></td><td>{relativeTime(course.archive.generatedAt)}</td></tr>
          {:else}<tr><td><EmptyState icon="archive" title="No archived courses" copy="Choose a course and start a placeholder or full fetch." /></td></tr>{/each}
        </tbody></table></div></div>
      </section>
    </div>
    <div class="dashboard-column">
      <section class="section-block">
        <div class="section-heading"><h2>Latest announcements</h2></div>
        <div class="data-surface"><ul class="announcement-list">
          {#each summary.announcements.slice(0, 6) as item}
            <li class="announcement-item"><button onclick={() => safe(openAnnouncement(item.courseId, item.id))}><strong>{item.title}</strong><small>{item.courseCode} · {relativeTime(item.postedAt || item.createdDate)}</small></button>{#if item.read === false}<span class="status-dot warning" title="Unread"></span>{/if}</li>
          {:else}<li><EmptyState icon="archive" title="No announcements" copy="Announcements appear after a course fetch." /></li>{/each}
        </ul></div>
      </section>
      <section class="section-block">
        <div class="section-heading"><h2>Recent files</h2><a href="#/files">Browse all</a></div>
        <div class="data-surface"><ul class="recent-file-list">
          {#each recentFiles as file}
            <li class="recent-file-item"><button onclick={() => safe(openFile(file.courseId, file.path))}><FileVisual {file} courseId={file.courseId} mini /><span><strong>{file.name}</strong><small>{file.courseCode} · {formatBytes(file.size)}</small></span></button></li>
          {:else}<li><EmptyState icon="files" title="No local files" copy="Fetched files will appear here." /></li>{/each}
        </ul></div>
      </section>
    </div>
  </div>
</div>
