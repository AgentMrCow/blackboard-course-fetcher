<script lang="ts">
  import CourseAvatar from "../components/CourseAvatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import FileVisual from "../components/FileVisual.svelte";
  import Icon from "../components/Icon.svelte";
  import StatusBadge from "../components/StatusBadge.svelte";
  import { activeBatch, appState, changeState, navigate, openAnnouncement, openCalendarItem, openFile, openSetup, reportError, runInventory } from "../lib/controller";
  import { formatBytes, formatDate, relativeTime } from "../lib/format";

  $: bootstrap = $appState.bootstrap!;
  $: summary = bootstrap.summary;
  $: inventory = bootstrap.inventory;
  $: upcomingDeadlines = summary.deadlines
    .filter((item: any) => new Date(item.dueDate).valueOf() >= Date.now())
    .sort((left: any, right: any) => new Date(left.dueDate).valueOf() - new Date(right.dueDate).valueOf());
  $: upcoming = upcomingDeadlines.slice(0, 5);
  $: recentCourses = inventory.courses
    .filter((course) => course.archive.exists && course.archive.status !== "not_fetched")
    .sort((left, right) => String(right.archive.generatedAt || "").localeCompare(String(left.archive.generatedAt || "")))
    .slice(0, 4);
  $: recentFiles = summary.recentFiles.slice(0, 4);
  $: sessionReady = bootstrap.auth?.validation?.valid === true || bootstrap.auth?.status === "connected";
  $: sessionChecking = bootstrap.auth?.status === "checking";
  $: inventoryReady = Boolean(inventory?.generatedAt && inventory?.courses?.length);
  $: archiveReady = Boolean(summary?.archivedCount);
  $: archiveIssues = inventory.courses.filter((course) => ["incomplete", "failed"].includes(course.archive.status));
  $: archiveOnlyCount = inventory.courses.filter((course) => course.archiveOnly || course.membershipPresent === false).length;
  $: batch = activeBatch(bootstrap);

  function safe(action: Promise<unknown>) {
    action.catch(reportError);
  }

  function reviewArchives() {
    changeState((state) => {
      state.courseFilters = { query: "", term: "all", view: "all", status: archiveIssues.length ? "attention" : "all" };
    });
    navigate("courses");
  }

  function dateParts(value: string) {
    const date = new Date(value);
    return {
      day: new Intl.DateTimeFormat("en", { day: "2-digit" }).format(date),
      month: new Intl.DateTimeFormat("en", { month: "short" }).format(date),
    };
  }
</script>

<div class="page overview-page">
  <header class="page-header">
    <div>
      <span class="eyebrow">Your learning library</span>
      <h1>Overview</h1>
      <p>Course materials, deadlines, and feedback. Together on your device.</p>
    </div>
    <div class="page-actions">
      <button class="button secondary" onclick={() => safe(runInventory())}><Icon name="scan-search" /><span>Scan courses</span></button>
      <button class="button primary" onclick={() => navigate("courses")}><Icon name="download" /><span>Fetch courses</span></button>
    </div>
  </header>

  {#if batch}
    {@const running = batch.tasks.find((task) => task.status === "running") || batch.tasks.find((task) => task.status === "paused") || batch.tasks[0]}
    <section class="active-fetch" aria-label="Current fetch">
      <div><span class="active-fetch-label"><span class="activity-dot"></span> Fetch activity</span><h3>{batch.status === "paused" ? "Your fetch is paused" : "Adding to your archive"}</h3><p>{running?.courseCode || "Preparing"} · {running?.currentItem || "Waiting"}</p></div>
      <div><div class="progress-track dark" role="progressbar" aria-label="Fetch progress" aria-valuenow={batch.progress} aria-valuemin="0" aria-valuemax="100"><span class="progress-bar" style={`width:${batch.progress}%`}></span></div><div class="progress-meta"><span>{batch.progress}% complete</span><span>{batch.remainingMs == null ? "ETA unavailable" : `About ${Math.max(1, Math.round(batch.remainingMs / 60_000))} mins left`}</span></div></div>
      <a class="button secondary" href="#/activity">Open activity <Icon name="arrow-right" /></a>
    </section>
  {/if}

  <section class="overview-stats" aria-label="Archive summary">
    <div class="overview-stat"><span class="stat-label"><Icon name="book-open" /> Courses archived</span><strong>{Number(summary.archivedCount || 0).toLocaleString()}<small>/ {inventory.courses.length}</small></strong><span>{summary.completeCount || 0} passed the latest coverage audit</span></div>
    <div class="overview-stat"><span class="stat-label"><Icon name="files" /> Course materials</span><strong>{Number(summary.materialFiles ?? summary.files ?? 0).toLocaleString()}</strong><span>{Number(summary.recordFiles || 0).toLocaleString()} additional archive records</span></div>
    <div class="overview-stat"><span class="stat-label"><Icon name="hard-drive-download" /> Stored locally</span><strong>{formatBytes(summary.bytes || 0)}</strong><span>{archiveOnlyCount ? `${archiveOnlyCount} historical course${archiveOnlyCount === 1 ? "" : "s"} kept locally` : "Browse your fetched files offline"}</span></div>
    <div class="overview-stat"><span class="stat-label"><Icon name="calendar-clock" /> Upcoming deadlines</span><strong>{upcomingDeadlines.length}</strong><span>From your latest course archives</span></div>
  </section>

  <section class="workspace-health" aria-label="Workspace readiness">
    <button class="health-action" class:needs-attention={!sessionReady && !sessionChecking} onclick={() => openSetup(1)}>
      <span class="health-action-icon"><Icon name={sessionReady ? "shield-check" : sessionChecking ? "refresh-cw" : "shield-alert"} /></span>
      <span><strong>{sessionReady ? "Session ready" : sessionChecking ? "Checking session" : "Check your session"}</strong><small>{sessionReady ? "Ready to fetch from Blackboard" : sessionChecking ? "Validating saved sign-in" : bootstrap.auth?.exists ? "Verify your Blackboard sign-in" : "Sign in to start fetching"}</small></span><Icon name="chevron-right" />
    </button>
    <button class="health-action" class:needs-attention={!inventoryReady} onclick={() => inventoryReady ? navigate("courses") : openSetup()}>
      <span class="health-action-icon"><Icon name="list-checks" /></span>
      <span><strong>{inventoryReady ? "Course catalog" : "Build your catalog"}</strong><small>{inventoryReady ? `Last scanned ${relativeTime(inventory.generatedAt)}` : "Scan your enrolled courses"}</small></span><Icon name="chevron-right" />
    </button>
    <button class="health-action" class:needs-attention={archiveIssues.length > 0} onclick={reviewArchives}>
      <span class="health-action-icon"><Icon name={archiveIssues.length ? "circle-alert" : "archive"} /></span>
      <span><strong>{archiveIssues.length ? `${archiveIssues.length} archive${archiveIssues.length === 1 ? "" : "s"} to review` : archiveReady ? "Your archives are ready" : "Make your first archive"}</strong><small>{archiveIssues.length ? "Review incomplete or failed fetches" : archiveReady ? "Open a course to explore its contents" : "Choose what to keep on this device"}</small></span><Icon name="chevron-right" />
    </button>
  </section>

  <div class="dashboard-grid overview-grid">
    <div class="dashboard-column">
      <section class="section-block">
        <div class="section-heading"><div><h2>Continue browsing</h2><p>Your most recently archived courses</p></div><a href="#/courses">All courses <Icon name="arrow-right" /></a></div>
        <div class="data-surface"><ul class="continue-course-list">
          {#each recentCourses as course}
            <li><a class="continue-course" href={`#/course/${encodeURIComponent(course.id)}/overview`}><CourseAvatar {course} /><span class="continue-course-copy"><small>{course.code} <span>· {course.termName}</span></small><strong>{course.name}</strong><span>{course.archive.fileCount} tracked files · {course.archive.generatedAt ? `Fetched ${relativeTime(course.archive.generatedAt)}` : "Fetch date unavailable"}</span></span><StatusBadge status={course.archive.status} /><Icon name="chevron-right" /></a></li>
          {:else}<li><EmptyState icon="book-open" title="A home for your courses" copy="Scan your course catalog, then choose a course to archive." /><div class="empty-state-action"><button class="button secondary" onclick={() => openSetup()}>Open setup guide <Icon name="arrow-right" /></button></div></li>{/each}
        </ul></div>
      </section>
      <section class="section-block">
        <div class="section-heading"><div><h2>Next deadlines</h2><p>Dates saved in your fetched courses</p></div><a href="#/calendar">Full calendar <Icon name="arrow-right" /></a></div>
        <div class="data-surface"><ul class="upcoming-list">
          {#each upcoming as item}
            {@const date = dateParts(item.dueDate)}
            <li><button class="upcoming-row" onclick={() => safe(openCalendarItem(item.courseId, item.title))}><span class="deadline-date" aria-hidden="true"><small>{date.month}</small><strong>{date.day}</strong></span><span class="upcoming-copy"><strong>{item.title}</strong><small>{item.courseCode} · {formatDate(item.dueDate, { time: true })}</small></span><StatusBadge status={item.status} /><Icon name="chevron-right" /></button></li>
          {:else}<li><EmptyState icon="calendar-check" title="No upcoming deadlines saved" copy="This schedule reflects your last fetch. Refresh a current course to check for new dates." /></li>{/each}
        </ul></div>
      </section>
    </div>
    <div class="dashboard-column">
      <section class="section-block">
        <div class="section-heading"><div><h2>Latest announcements</h2><p>Updates from your archived courses</p></div><span class="section-icon"><Icon name="messages-square" /></span></div>
        <div class="data-surface"><ul class="announcement-list">
          {#each summary.announcements.slice(0, 4) as item}
            <li class="announcement-item"><button onclick={() => safe(openAnnouncement(item.courseId, item.id))}><small class="announcement-course">{item.courseCode}</small><strong>{item.title}</strong><small>{relativeTime(item.postedAt || item.createdDate)}</small></button>{#if item.read === false}<span class="status-dot warning" title="Unread" aria-label="Unread"></span>{/if}</li>
          {:else}<li><EmptyState icon="messages-square" title="No announcements saved" copy="Course announcements will appear here after a fetch." /></li>{/each}
        </ul></div>
      </section>
      <section class="section-block">
        <div class="section-heading"><div><h2>Recent files</h2><p>Ready to open from your device</p></div><a href="#/files">Browse all <Icon name="arrow-right" /></a></div>
        <div class="data-surface"><ul class="recent-file-list">
          {#each recentFiles as file}
            <li class="recent-file-item"><button onclick={() => safe(openFile(file.courseId, file.path))}><FileVisual {file} courseId={file.courseId} mini /><span><strong>{file.name}</strong><small>{file.courseCode} · {formatBytes(file.size)}</small></span><Icon name="chevron-right" /></button></li>
          {:else}<li><EmptyState icon="files" title="No local files yet" copy="Fetched course materials will be collected here." /></li>{/each}
        </ul></div>
      </section>
    </div>
  </div>
</div>
