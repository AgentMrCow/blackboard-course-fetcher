<script lang="ts">
  import EmptyState from "../../components/EmptyState.svelte";
  import DiscussionForum from "../../components/DiscussionForum.svelte";
  import FileCollection from "../../components/FileCollection.svelte";
  import Icon from "../../components/Icon.svelte";
  import StatusBadge from "../../components/StatusBadge.svelte";
  import { appState, changeState, openAssignment, openFile, reportError } from "../../lib/controller";
  import { assessmentStatus, contentIcon, courseFileByPath, courseGradeSummary, fileMatchesScope, formatBytes, formatDate, formatDuration, initials, titleCase } from "../../lib/format";
  import type { CourseDetail, FileScope } from "../../lib/types";

  export let detail: CourseDetail;
  export let tab: string;

  $: course = detail.course;
  $: assessments = [...detail.assessments].sort((left, right) => String(left.dueDate || "9999").localeCompare(String(right.dueDate || "9999")));
  $: gradebook = detail.gradebook;
  $: gradeSummary = courseGradeSummary(detail);
  $: calendarItems = [...(detail.calendar?.items || [])].sort((left, right) => String(left.startDate || "").localeCompare(String(right.startDate || "")));
  $: discussions = detail.discussions || {};
  $: messages = detail.messages || {};
  $: forums = discussions.forums || discussions.boards || discussions.items || [];
  $: discussionMetric = discussions.messageCount == null
    ? `${forums.length} ${forums.length === 1 ? "forum" : "forums"}`
    : `${discussions.messageCount} ${discussions.messageCount === 1 ? "message" : "messages"}`;
  $: conversations = messages.conversations || [];
  $: groups = detail.groups || {};
  $: accessibleGroups = groups.accessibleGroups || [];
  $: achievements = detail.achievements?.items || detail.achievements?.achievements || [];
  $: fileQuery = $appState.fileFilters.courseId === course.id ? $appState.fileFilters.query.toLowerCase() : "";
  $: filePreview = $appState.fileFilters.courseId === course.id ? $appState.fileFilters.preview : "all";
  $: fileScope = $appState.fileFilters.courseId === course.id ? $appState.fileFilters.scope : "materials";
  $: filteredFiles = detail.files.filter((file) => fileMatchesScope(file, fileScope) && (!fileQuery || `${file.name} ${file.path}`.toLowerCase().includes(fileQuery)) && (filePreview === "all" || file.preview === filePreview));
  $: manifest = detail.manifest;
  $: coverage = manifest?.coverage || {};
  $: transfer = manifest?.transfer || {};
  $: errors = manifest?.errors || [];
  $: warnings = manifest?.warnings || [];
  $: coverageComplete = course.archive.coverageComplete === true;

  function updateCourseFileFilter(values: Partial<{ query: string; preview: string; scope: FileScope }>) {
    changeState((state) => {
      state.fileFilters.courseId = course.id;
      Object.assign(state.fileFilters, values);
    });
  }
</script>

{#if tab === "content"}
  {#if !detail.contents.length}
    <EmptyState icon="folder-open" title="No content tree" copy="The archive does not contain visible course content items." />
  {:else}
    <div class="section-heading"><h2>Course content</h2><span class="badge neutral">{detail.contents.length} items</span></div>
    <div class="content-list">
      {#each detail.contents as item}
        {@const depth = Math.max(0, String(item.path || "").split(" / ").length - 1)}
        {@const files = (item.files || []).map((filePath: string) => courseFileByPath(detail.files, filePath))}
        <div class="content-row" style={`padding-left:${Math.min(11 + depth * 18, 101)}px`}><span class="content-icon"><Icon name={contentIcon(item.handler, item.container)} /></span><span class="content-row-title"><strong>{item.title}</strong><small>{item.container ? `${item.path} · folder` : item.handler || "content item"}</small></span><span class="content-files">{#each files.slice(0, 3) as file}<button onclick={() => openFile(course.id, file.path).catch(reportError)} title={`Open ${file.name}`} aria-label={`Open ${file.name}`}><Icon name={file.preview === "pdf" ? "file-text" : file.preview === "image" ? "file-image" : "file"} /></button>{/each}{#if files.length > 3}<span class="badge neutral">+{files.length - 3}</span>{/if}</span></div>
      {/each}
    </div>
  {/if}
{:else if tab === "assignments"}
  {#if !assessments.length}
    <EmptyState icon="clipboard-list" title="No assessments" copy="No student-visible assessments were discovered in this course." />
  {:else}
    <div class="section-heading"><h2>Assignments and assessments</h2><span class="badge neutral">{assessments.length} items</span></div>
    <div class="data-surface"><div class="data-table-wrap"><table class="data-table assignment-table"><thead><tr><th>Assessment</th><th>Due</th><th>Type</th><th>Attempts</th><th>Status</th><th>Score</th></tr></thead><tbody>
      {#each assessments as assessment}<tr><td class="title-cell"><button class="table-link" onclick={() => openAssignment(course.id, assessment.contentId || assessment.columnId).catch(reportError)}>{assessment.title}</button><small>{assessment.directory || "Gradebook-only item"}</small></td><td data-label="Due">{assessment.dueDate ? formatDate(assessment.dueDate, { time: true }) : "-"}</td><td data-label="Type">{assessment.isGroup ? "Group" : "Individual"}</td><td data-label="Attempts">{assessment.attempts?.length || 0}{assessment.multipleAttempts ? ` / ${assessment.multipleAttempts}` : ""}</td><td data-label="Status"><StatusBadge status={assessmentStatus(assessment)} /></td><td data-label="Score">{assessment.grade?.score == null ? "-" : `${assessment.grade.score} / ${assessment.grade.pointsPossible ?? assessment.possiblePoints ?? "-"}`}</td></tr>{/each}
    </tbody></table></div></div>
  {/if}
{:else if tab === "grades"}
  {#if !gradebook?.items?.length}
    <EmptyState icon="chart-no-axes-column" title="No gradebook data" copy="No student-visible gradebook items were archived." />
  {:else}
    {#if gradeSummary}<div class="grade-summary" style="margin-bottom:20px"><div><span class="grade-value">{gradeSummary.percentage == null ? "-" : `${Number(gradeSummary.percentage).toFixed(2)}%`}</span><span class="grade-label">{gradeSummary.title || "Performance to date"} · {gradeSummary.earned ?? "-"} earned of {gradeSummary.possible ?? "-"}</span></div><span class="grade-ring">{gradeSummary.percentage == null ? "-" : Math.round(gradeSummary.percentage)}</span></div>{/if}
    <div class="section-heading"><h2>Gradebook</h2><span class="badge neutral">{gradebook.items.length} columns</span></div>
    <div class="data-surface"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Item</th><th>Category</th><th>Due</th><th>Status</th><th>Score</th><th>Percent</th></tr></thead><tbody>{#each gradebook.items as item}<tr><td class="title-cell"><strong>{item.effectiveTitle || item.title || item.columnId}</strong><small>{item.isGroup ? "Group" : item.calculationType === "CUSTOM" ? "Calculated" : "Individual"}</small></td><td>{String(item.category || "-").replace(/\.name$/, "")}</td><td>{item.dueDate ? formatDate(item.dueDate, { time: true }) : "-"}</td><td><StatusBadge status={item.status || item.grade?.status || item.grade?.submissionStatus} /></td><td>{item.grade?.score == null ? "-" : `${item.grade.score} / ${item.grade.pointsPossible ?? item.possiblePoints ?? "-"}`}</td><td>{item.grade?.percentage == null ? "-" : `${Number(item.grade.percentage).toFixed(1)}%`}</td></tr>{/each}</tbody></table></div></div>
  {/if}
{:else if tab === "announcements"}
  {#if !detail.announcements.length}
    <EmptyState icon="archive" title="No announcements" copy="No student-visible announcements were found." />
  {:else}
    <div class="section-heading"><h2>Announcements</h2><span class="badge neutral">{detail.announcements.length} posts</span></div>
    <div class="announcement-feed">{#each detail.announcements as announcement}<article class="announcement-article" id={`announcement-${announcement.id}`}><header><div><h3>{announcement.title}</h3>{#if announcement.read === false}<span class="badge warning" style="margin-top:6px">Unread when fetched</span>{/if}</div><time>{formatDate(announcement.postedAt || announcement.createdDate, { time: true })}</time></header><div class="announcement-body">{announcement.text || "The announcement body was not available as plain text."}</div>{#if announcement.htmlPath}<div style="margin-top:10px"><button class="button secondary small" onclick={() => openFile(course.id, announcement.htmlPath).catch(reportError)}><Icon name="panel-top-open" /><span>Open archived HTML</span></button></div>{/if}</article>{/each}</div>
  {/if}
{:else if tab === "calendar"}
  {#if !calendarItems.length}
    <EmptyState icon="calendar-x" title="No calendar items" copy="No course calendar events were archived." />
  {:else}
    <div class="section-heading"><h2>Course calendar</h2><span class="badge neutral">{calendarItems.length} events</span></div><div class="data-surface"><div class="data-table-wrap"><table class="data-table"><thead><tr><th>Event</th><th>Date</th><th>Type</th><th>Visibility</th></tr></thead><tbody>{#each calendarItems as item}<tr><td class="title-cell"><strong>{item.title}</strong><small>{item.location || course.code}</small></td><td>{formatDate(item.startDate, { time: true })}</td><td>{item.dynamicCalendarItemProps?.eventType || item.itemSourceType?.split(".").at(-1) || "Event"}</td><td><StatusBadge status={item.visibility === "VISIBLE" ? "complete" : "neutral"} label={item.visibility || "Unknown"} /></td></tr>{/each}</tbody></table></div></div>
  {/if}
{:else if tab === "communication"}
  <div class="communication-grid">
    <section class="section-block discussion-section">
      <div class="section-heading"><h2>Discussions</h2><span class="badge neutral">{discussionMetric}</span></div>
      {#if forums.length}
        <div class="discussion-list">
          {#each forums as forum, index (forum.forumId || forum.id || index)}
            <DiscussionForum {forum} initiallyOpen={index === 0} />
          {/each}
        </div>
      {:else}
        <div class="data-surface"><EmptyState icon="messages-square" title="No discussions" copy="No accessible discussion posts were found." /></div>
      {/if}
    </section>
    <section class="section-block"><div class="section-heading"><h2>Course messages</h2><span class="badge neutral">{messages.counts?.totalCount ?? conversations.length} conversations</span></div><div class="data-surface">{#if conversations.length}<ul class="announcement-list">{#each conversations as conversation}<li class="announcement-item"><span><strong>{conversation.subject || conversation.title || "Conversation"}</strong><small>{conversation.lastMessageDate ? formatDate(conversation.lastMessageDate, { time: true }) : `${conversation.messageCount || 0} messages`}</small></span></li>{/each}</ul>{:else}<EmptyState icon="mail" title="No course messages" copy="No accessible message conversations were found." />{/if}</div></section>
  </div>
{:else if tab === "people"}
  <div class="people-grid">
    <section class="section-block"><div class="section-heading"><h2>Accessible groups</h2><span class="badge neutral">{accessibleGroups.length} of {groups.totalGroups || accessibleGroups.length}</span></div>{#if accessibleGroups.length}{#each accessibleGroups as group}<div class="member-list" style="margin-bottom:12px"><div class="member-row"><span class="member-avatar">{initials(group.title)}</span><span><strong>{group.title}</strong><small>{group.studentCount || group.members?.length || 0} students{group.hasGrades ? " · graded group" : ""}</small></span>{#if group.hasSubmittedGroupAttempt}<StatusBadge status="submitted" />{/if}</div>{#each group.members || [] as member}<div class="member-row"><span class="member-avatar">{initials(member.displayName)}</span><span><strong>{member.displayName}</strong><small>{member.courseRole || "Member"}</small></span></div>{/each}</div>{/each}{:else}<div class="data-surface"><EmptyState icon="users" title="No accessible groups" copy="Blackboard may restrict other groups and their rosters." /></div>{/if}</section>
    <section class="section-block"><div class="section-heading"><h2>Achievements</h2><span class="badge neutral">{detail.achievements?.count ?? achievements.length}</span></div><div class="data-surface">{#if achievements.length}<ul class="announcement-list">{#each achievements as achievement}<li class="announcement-item"><span><strong>{achievement.title || achievement.name || "Achievement"}</strong><small>{achievement.description || achievement.status || "Archived"}</small></span></li>{/each}</ul>{:else}<EmptyState icon="award" title="No achievements" copy="No student-visible achievements were found." />{/if}</div></section>
  </div>
{:else if tab === "files"}
  <div class="file-toolbar"><div class="filter-input"><Icon name="search" /><input type="search" placeholder="Filter this course's files" value={fileQuery} oninput={(event) => updateCourseFileFilter({ query: event.currentTarget.value })} /></div><select class="select" value={fileScope} onchange={(event) => updateCourseFileFilter({ scope: event.currentTarget.value as FileScope })}><option value="materials">Course materials</option><option value="exports">Content exports</option><option value="records">Archive records</option><option value="all">All physical files</option></select><select class="select" value={filePreview} onchange={(event) => updateCourseFileFilter({ preview: event.currentTarget.value })}><option value="all">All file types</option>{#each ["pdf", "office", "image", "video", "audio", "html", "text", "json", "placeholder", "archive"] as value}<option {value}>{titleCase(value)}</option>{/each}</select><div class="segmented-control"><button class:active={$appState.fileView === "table"} onclick={() => changeState((state) => state.fileView = "table")} title="List view" aria-label="List view"><Icon name="list" /></button><button class:active={$appState.fileView === "grid"} onclick={() => changeState((state) => state.fileView = "grid")} title="Grid view" aria-label="Grid view"><Icon name="grid-2x2" /></button></div><span class="selection-count">{filteredFiles.length} files</span></div>
  {#if filteredFiles.length}<FileCollection files={filteredFiles} courseId={course.id} view={$appState.fileView} openFile={(id, path) => openFile(id, path).catch(reportError)} />{:else}<EmptyState icon="file-search" title="No matching files" copy="Change the file name or type filter." />{/if}
{:else if tab === "health"}
  {#if !manifest}
    <EmptyState icon="shield-question" title="No manifest" copy="Fetch this course to generate coverage and integrity records." />
  {:else}
    <div class="health-grid">
      <section class="section-block"><div class="section-heading"><h2>Coverage</h2><StatusBadge status={coverageComplete ? "complete" : "incomplete"} label={coverageComplete ? "Complete" : "Incomplete"} /></div>{#if course.archive.coverageIssue}<div class="coverage-warning"><Icon name="triangle-alert" /><span><strong>Attachment coverage needs verification</strong>{course.archive.coverageIssue}</span></div>{/if}<dl class="definition-list"><div class="definition-row"><dt>Generated</dt><dd>{formatDate(manifest.generatedAt, { time: true })}</dd></div><div class="definition-row"><dt>Download mode</dt><dd>{titleCase(manifest.downloadMode)}</dd></div><div class="definition-row"><dt>Visible content</dt><dd>{coverage.content?.discovered ?? manifest.contents?.length ?? 0}</dd></div><div class="definition-row"><dt>Course files covered</dt><dd>{coverage.courseFiles?.covered ?? 0} / {coverage.courseFiles?.expected ?? 0}</dd></div><div class="definition-row"><dt>Announcement attachments</dt><dd>{coverage.announcements ? `${coverage.announcements.covered ?? 0} / ${coverage.announcements.embeddedAttachmentExpected ?? 0}` : "Legacy manifest"}</dd></div><div class="definition-row"><dt>Assessments processed</dt><dd>{coverage.assessments?.processed ?? manifest.assessments?.length ?? 0} / {coverage.assessments?.expected ?? manifest.assessments?.length ?? 0}</dd></div><div class="definition-row"><dt>Quiz reviews</dt><dd>{manifest.quizReviews?.archived ?? 0} / {manifest.quizReviews?.expected ?? 0}</dd></div><div class="definition-row"><dt>Unresolved files</dt><dd>{transfer.unresolvedFiles ?? coverage.downloads?.unresolved ?? 0}</dd></div></dl></section>
      <section class="section-block"><div class="section-heading"><h2>Transfer and performance</h2></div><dl class="definition-list"><div class="definition-row"><dt>Total fetch time</dt><dd>{formatDuration(manifest.timings?.totalMs)}</dd></div><div class="definition-row"><dt>Network files</dt><dd>{transfer.networkFiles ?? "-"}</dd></div><div class="definition-row"><dt>Network bytes</dt><dd>{formatBytes(transfer.networkBytes)}</dd></div><div class="definition-row"><dt>Validated cache reuse</dt><dd>{transfer.reusedFiles ?? 0} files</dd></div><div class="definition-row"><dt>Placeholders</dt><dd>{transfer.placeholderFiles ?? manifest.downloads?.filter((item: any) => item.placeholder).length ?? 0}</dd></div>{#each Object.entries(manifest.timings?.phases || {}) as [phase, milliseconds]}<div class="definition-row"><dt>{titleCase(phase)}</dt><dd>{formatDuration(milliseconds)}</dd></div>{/each}</dl></section>
      <section class="section-block"><div class="section-heading"><h2>Warnings</h2><span class="badge" class:warning={warnings.length} class:success={!warnings.length}>{warnings.length}</span></div><div class="data-surface">{#if warnings.length}<ul class="issue-list">{#each warnings as item}<li><Icon name="triangle-alert" /><span><strong>{item.label || "Item"}</strong><br />{item.warning || item.message || JSON.stringify(item)}</span></li>{/each}</ul>{:else}<EmptyState icon="circle-check" title="No warnings" copy="The latest fetch did not record any warnings." />{/if}</div></section>
      <section class="section-block"><div class="section-heading"><h2>Errors</h2><span class="badge" class:error={errors.length} class:success={!errors.length}>{errors.length}</span></div><div class="data-surface">{#if errors.length}<ul class="issue-list error">{#each errors as item}<li><Icon name="circle-alert" /><span><strong>{item.label || item.fileName || "Item"}</strong><br />{item.error || item.message || JSON.stringify(item)}</span></li>{/each}</ul>{:else}<EmptyState icon="circle-check" title="No errors" copy="The latest fetch did not record any errors." />{/if}</div><div class="page-actions" style="margin-top:12px"><button class="button secondary small" onclick={() => openFile(course.id, "manifest.json").catch(reportError)}><Icon name="braces" /><span>Open manifest</span></button>{#if detail.files.some((file) => file.path === "CURRENT_STATUS.md")}<button class="button secondary small" onclick={() => openFile(course.id, "CURRENT_STATUS.md").catch(reportError)}><Icon name="clipboard-list" /><span>Current status</span></button>{/if}</div></section>
    </div>
  {/if}
{/if}
