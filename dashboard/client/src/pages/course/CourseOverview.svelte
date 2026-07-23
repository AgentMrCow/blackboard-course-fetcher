<script lang="ts">
  import CourseAvatar from "../../components/CourseAvatar.svelte";
  import EmptyState from "../../components/EmptyState.svelte";
  import StatusBadge from "../../components/StatusBadge.svelte";
  import { openAnnouncement, openAssignment, openFile, reportError } from "../../lib/controller";
  import { assessmentStatus, courseGradeSummary, formatBytes, formatDate, initials, relativeTime } from "../../lib/format";
  import type { CourseDetail } from "../../lib/types";

  export let detail: CourseDetail;

  $: ({ course, assessments, announcements, files, groups } = detail);
  $: grade = courseGradeSummary(detail);
  $: upcoming = assessments.filter((assessment) => assessment.dueDate && new Date(assessment.dueDate).valueOf() >= Date.now() - 86_400_000).sort((left, right) => new Date(left.dueDate).valueOf() - new Date(right.dueDate).valueOf()).slice(0, 6);
  $: recentFiles = files.filter((file) => file.hiddenByDefault !== true).sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt))).slice(0, 6);
  $: group = groups?.accessibleGroups?.[0];
</script>

<div class="course-overview-grid">
  <div class="dashboard-column">
    <section class="section-block">
      <div class="section-heading"><h2>Upcoming work</h2><a href={`#/course/${encodeURIComponent(course.id)}/assignments`}>All assignments</a></div>
      <div class="data-surface">
        {#if upcoming.length}
          <div class="data-table-wrap"><table class="data-table"><thead><tr><th>Assessment</th><th>Due</th><th>Status</th><th>Score</th></tr></thead><tbody>
            {#each upcoming as assessment}
              <tr><td class="title-cell"><button class="table-link" onclick={() => openAssignment(course.id, assessment.contentId || assessment.columnId).catch(reportError)}>{assessment.title}</button><small>{assessment.isGroup ? `Group · ${(assessment.assignedGroups || []).join(", ") || "team"}` : "Individual"}</small></td><td>{formatDate(assessment.dueDate, { time: true })}</td><td><StatusBadge status={assessmentStatus(assessment)} /></td><td>{assessment.grade?.score == null ? "-" : `${assessment.grade.score}/${assessment.grade.pointsPossible ?? assessment.possiblePoints ?? "-"}`}</td></tr>
            {/each}
          </tbody></table></div>
        {:else}<EmptyState icon="calendar-check" title="No upcoming work" copy="No future due dates were found in this archive." />{/if}
      </div>
    </section>
    <section class="section-block">
      <div class="section-heading"><h2>Recent announcements</h2><a href={`#/course/${encodeURIComponent(course.id)}/announcements`}>View all</a></div>
      <div class="data-surface"><ul class="announcement-list">
        {#each announcements.slice(0, 5) as announcement}
          <li class="announcement-item"><button onclick={() => openAnnouncement(course.id, announcement.id).catch(reportError)}><strong>{announcement.title}</strong><small>{relativeTime(announcement.postedAt || announcement.createdDate)}{announcement.text ? ` · ${announcement.text.slice(0, 90).replace(/\s+/g, " ")}` : ""}</small></button>{#if announcement.read === false}<span class="status-dot warning"></span>{/if}</li>
        {:else}<li><EmptyState icon="archive" title="No announcements" copy="This fetch did not find any student-visible announcements." /></li>{/each}
      </ul></div>
    </section>
  </div>
  <div class="dashboard-column">
    <section class="section-block">
      <div class="section-heading"><h2>Grade snapshot</h2><a href={`#/course/${encodeURIComponent(course.id)}/grades`}>Gradebook</a></div>
      {#if grade}<div class="grade-summary"><div><span class="grade-value">{grade.percentage == null ? "-" : `${Number(grade.percentage).toFixed(1)}%`}</span><span class="grade-label">{grade.title || "Performance to date"} · {grade.earned ?? "-"}/{grade.possible ?? "-"}</span></div><span class="grade-ring">{grade.percentage == null ? "-" : Math.round(grade.percentage)}</span></div>{:else}<div class="data-surface"><EmptyState icon="chart-no-axes-column" title="No grade summary" copy="The course gradebook has no visible summary yet." /></div>{/if}
    </section>
    {#if group}
      <section class="section-block"><div class="section-heading"><h2>Your group</h2><a href={`#/course/${encodeURIComponent(course.id)}/people`}>People</a></div><div class="member-list"><div class="member-row"><span class="member-avatar">{initials(group.title)}</span><span><strong>{group.title}</strong><small>{group.members?.length || group.studentCount || 0} accessible members</small></span><StatusBadge status={group.hasSubmittedGroupAttempt ? "submitted" : "neutral"} label={group.hasSubmittedGroupAttempt ? "Submitted" : "Active"} /></div>{#each (group.members || []).slice(0, 4) as member}<div class="member-row"><span class="member-avatar">{initials(member.displayName)}</span><span><strong>{member.displayName}</strong><small>{member.courseRole || "Member"}</small></span></div>{/each}</div></section>
    {/if}
    <section class="section-block"><div class="section-heading"><h2>Recent files</h2><a href={`#/course/${encodeURIComponent(course.id)}/files`}>Browse files</a></div><div class="data-surface"><ul class="recent-file-list">{#each recentFiles as file}<li class="recent-file-item"><button onclick={() => openFile(course.id, file.path).catch(reportError)}><strong>{file.name}</strong><small>{file.category} · {formatBytes(file.size)}</small></button></li>{:else}<li><EmptyState icon="files" title="No files" copy="No local files are present for this course." /></li>{/each}</ul></div></section>
  </div>
</div>
