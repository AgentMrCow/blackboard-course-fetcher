<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import CourseAvatar from "../components/CourseAvatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import StatusBadge from "../components/StatusBadge.svelte";
  import { appState, ensureCourse, navigate, openFetch, reportError } from "../lib/controller";
  import CourseOverview from "./course/CourseOverview.svelte";
  import CourseSection from "./course/CourseSection.svelte";

  const tabs = [
    ["overview", "Overview"],
    ["content", "Content"],
    ["assignments", "Assignments"],
    ["grades", "Grades"],
    ["announcements", "Announcements"],
    ["calendar", "Calendar"],
    ["communication", "Communication"],
    ["people", "People"],
    ["files", "Files"],
    ["history", "Backup history"],
    ["health", "Archive health"],
  ];
  let loadingId = "";
  let tabNavigation: HTMLElement;
  let tabNavigationWidth = 0;

  $: courseId = $appState.route.id || "";
  $: tab = tabs.some(([key]) => key === $appState.route.tab) ? $appState.route.tab || "overview" : "overview";
  $: detail = $appState.courseCache.get(courseId);
  $: if (courseId && !detail && loadingId !== courseId) load(courseId);
  $: if (detail) document.title = `${detail.course.code} · Blackboard Archive`;
  $: if (tabNavigation && detail && tabNavigationWidth) revealActiveTab(tab, courseId, tabNavigationWidth);

  async function revealActiveTab(_tab: string, _courseId: string, _width: number) {
    await tick();
    const active = tabNavigation?.querySelector<HTMLElement>("[aria-current='page']");
    if (!active) return;
    const container = tabNavigation.getBoundingClientRect();
    const target = active.getBoundingClientRect();
    if (target.left < container.left || target.right > container.right) tabNavigation.scrollLeft += target.left - container.left - (container.width - target.width) / 2;
  }

  async function load(id: string) {
    loadingId = id;
    try {
      await ensureCourse(id);
    } catch (error) {
      if ($appState.route.id === id) {
        reportError(error);
        navigate("courses");
      }
    } finally {
      if (loadingId === id) loadingId = "";
    }
  }

  onDestroy(() => document.title = "Blackboard Archive");
</script>

{#if !detail}
  <div class="page-loading"><span class="spinner"></span><span>Loading local course workspace</span></div>
{:else}
  {@const course = detail.course}
  {@const externalUrl = detail.manifest?.course?.externalAccessUrl}
  <div class="course-header">
    <div class="course-header-inner">
      <CourseAvatar {course} />
      <div class="course-heading"><h1>{course.name}</h1><div class="meta-line"><strong>{course.code}</strong><span>{course.termName}</span><span>{course.view}</span><StatusBadge status={course.archive.status} /></div></div>
      <div class="page-actions"><button class="button secondary" disabled={course.archiveOnly || course.membershipPresent === false} title={course.archiveOnly || course.membershipPresent === false ? "No current Blackboard membership; local archive remains available" : undefined} onclick={() => openFetch([course.id])}><Icon name="refresh-cw" /><span>{course.archive.exists ? "Refresh archive" : "Fetch course"}</span></button>{#if externalUrl}<a class="button secondary" href={externalUrl} target="_blank" rel="noreferrer"><Icon name="external-link" /><span>Blackboard</span></a>{/if}</div>
    </div>
    <div class="course-section-picker"><label for="course-section">Course section</label><select id="course-section" class="select" value={tab} onchange={(event) => navigate(`course/${encodeURIComponent(course.id)}/${event.currentTarget.value}`)}>{#each tabs as [key, label]}<option value={key}>{label}</option>{/each}</select></div>
    <nav bind:this={tabNavigation} bind:clientWidth={tabNavigationWidth} class="course-tabs" aria-label="Course sections">{#each tabs as [key, label]}<a href={`#/course/${encodeURIComponent(course.id)}/${key}`} class:active={tab === key} aria-current={tab === key ? "page" : undefined}>{label}</a>{/each}</nav>
  </div>
  <div class="course-content">
    {#if !course.archive.exists}
      <EmptyState icon="archive" title="This course has not been fetched" copy="Start with placeholder mode to inspect the structure without downloading binary file bodies."><button class="button primary" onclick={() => openFetch([course.id])}><Icon name="download" /><span>Fetch this course</span></button></EmptyState>
    {:else if tab === "overview"}
      <CourseOverview {detail} />
    {:else}
      <CourseSection {detail} {tab} />
    {/if}
  </div>
{/if}
