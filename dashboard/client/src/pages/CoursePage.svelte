<script lang="ts">
  import { onDestroy } from "svelte";
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
    ["health", "Archive health"],
  ];
  let loadingId = "";

  $: courseId = $appState.route.id || "";
  $: tab = tabs.some(([key]) => key === $appState.route.tab) ? $appState.route.tab || "overview" : "overview";
  $: detail = $appState.courseCache.get(courseId);
  $: if (courseId && !detail && loadingId !== courseId) load(courseId);
  $: if (detail) document.title = `${detail.course.code} · Blackboard Archive`;

  async function load(id: string) {
    loadingId = id;
    try {
      await ensureCourse(id);
    } catch (error) {
      reportError(error);
      navigate("courses");
    } finally {
      loadingId = "";
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
      <div class="page-actions"><button class="button secondary" onclick={() => openFetch([course.id])}><Icon name="refresh-cw" /><span>{course.archive.exists ? "Refresh archive" : "Fetch course"}</span></button>{#if externalUrl}<a class="button secondary" href={externalUrl} target="_blank" rel="noreferrer"><Icon name="external-link" /><span>Blackboard</span></a>{/if}</div>
    </div>
    <nav class="course-tabs" aria-label="Course sections">{#each tabs as [key, label]}<a href={`#/course/${encodeURIComponent(course.id)}/${key}`} class:active={tab === key}>{label}</a>{/each}</nav>
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
