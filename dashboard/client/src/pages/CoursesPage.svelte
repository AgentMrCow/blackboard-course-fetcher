<script lang="ts">
  import CourseAvatar from "../components/CourseAvatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import StatusBadge from "../components/StatusBadge.svelte";
  import { appState, changeState, navigate, openCourseDetails, openFetch, reportError, runInventory } from "../lib/controller";
  import { relativeTime } from "../lib/format";
  import type { Course } from "../lib/types";

  $: inventory = $appState.bootstrap!.inventory;
  $: filters = $appState.courseFilters;
  $: courses = inventory.courses.filter((course) => {
    if (filters.query && !`${course.name} ${course.code} ${course.termName}`.toLowerCase().includes(filters.query.toLowerCase())) return false;
    if (filters.term !== "all" && course.termName !== filters.term) return false;
    if (filters.status !== "all" && course.archive.status !== filters.status) return false;
    if (filters.view !== "all" && String(course.view).toLowerCase() !== filters.view) return false;
    return true;
  });
  $: terms = [...new Set(inventory.courses.map((course) => course.termName))];
  $: grouped = terms.map((term) => [term, courses.filter((course) => course.termName === term)] as [string, Course[]]).filter(([, items]) => items.length);

  function updateFilter(key: "query" | "term" | "status" | "view", value: string) {
    changeState((state) => state.courseFilters[key] = value);
  }

  function toggle(courseId: string, checked: boolean) {
    changeState((state) => checked ? state.selectedCourses.add(courseId) : state.selectedCourses.delete(courseId));
  }

  function selectVisible() {
    const allSelected = courses.every((course) => $appState.selectedCourses.has(course.id));
    changeState((state) => courses.forEach((course) => allSelected ? state.selectedCourses.delete(course.id) : state.selectedCourses.add(course.id)));
  }
</script>

<div class="page">
  <header class="page-header">
    <div><span class="eyebrow">{inventory.courses.length} memberships</span><h1>Courses</h1><p>Review the catalog first, then fetch only the courses and file bodies you need.</p></div>
    <div class="page-actions">
      <button class="button secondary" onclick={() => runInventory().catch(reportError)}><Icon name="scan-search" /><span>Refresh inventory</span></button>
      <button class="button primary" disabled={!$appState.selectedCourses.size} onclick={() => openFetch([...$appState.selectedCourses])}><Icon name="download" /><span>Fetch selected</span></button>
    </div>
  </header>
  <div class="course-toolbar">
    <div class="filter-input"><Icon name="search" /><input type="search" placeholder="Filter courses" value={filters.query} oninput={(event) => updateFilter("query", event.currentTarget.value)} /></div>
    <select class="select" aria-label="Filter by term" value={filters.term} onchange={(event) => updateFilter("term", event.currentTarget.value)}><option value="all">All terms</option>{#each terms as term}<option value={term}>{term}</option>{/each}</select>
    <select class="select" aria-label="Filter by archive status" value={filters.status} onchange={(event) => updateFilter("status", event.currentTarget.value)}><option value="all">All archive states</option><option value="complete">Complete</option><option value="incomplete">Incomplete</option><option value="failed">Failed</option><option value="not_fetched">Not Fetched</option></select>
    <select class="select" aria-label="Filter by course view" value={filters.view} onchange={(event) => updateFilter("view", event.currentTarget.value)}><option value="all">All course views</option><option value="ultra">Ultra</option><option value="classic">Classic</option></select>
    <span class="selection-count">{$appState.selectedCourses.size} selected</span>
    <button class="icon-button" onclick={selectVisible} title="Select all visible courses" aria-label="Select all visible courses"><Icon name="list-checks" /></button>
  </div>
  {#if grouped.length}
    {#each grouped as [term, items]}
      <section class="term-section">
        <div class="term-header"><h2>{term}</h2><span>{items.length} course{items.length === 1 ? "" : "s"}</span></div>
        <div class="data-surface">
          {#each items as course}
            <div class="course-row">
              <input type="checkbox" checked={$appState.selectedCourses.has(course.id)} onchange={(event) => toggle(course.id, event.currentTarget.checked)} aria-label={`Select ${course.name}`} />
              <CourseAvatar {course} />
              <button class="course-name-button" onclick={() => navigate(`course/${encodeURIComponent(course.id)}/overview`)}><strong>{course.name}</strong><small>{course.code} · {course.id}</small></button>
              <div class="course-meta-cell"><strong>{course.view}</strong><span>{course.available ? "Available" : "Unavailable"}</span></div>
              <div class="course-meta-cell"><StatusBadge status={course.archive.status} /><span>{course.archive.exists ? `${course.archive.fileCount} tracked files · ${relativeTime(course.archive.generatedAt)}` : course.available ? "Not fetched" : "Unavailable in Blackboard"}</span></div>
              <button class="icon-button" onclick={() => openCourseDetails(course.id)} title="Course actions" aria-label="Course actions"><Icon name="ellipsis" /></button>
            </div>
          {/each}
        </div>
      </section>
    {/each}
  {:else}
    <EmptyState icon="search-x" title="No matching courses" copy="Clear one or more filters to see the course catalog." />
  {/if}
</div>
