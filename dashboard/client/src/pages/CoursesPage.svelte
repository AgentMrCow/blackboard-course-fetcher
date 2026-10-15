<script lang="ts">
  import CourseAvatar from "../components/CourseAvatar.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import StatusBadge from "../components/StatusBadge.svelte";
  import { appState, changeState, navigate, openCourseDetails, openFetch, reportError, runInventory } from "../lib/controller";
  import { relativeTime } from "../lib/format";
  import type { Course } from "../lib/types";

  let catalogScope: "all" | "enrolled" | "local" = "all";

  function localOnly(course: Course) {
    return course.archiveOnly || course.membershipPresent === false;
  }

  $: inventory = $appState.bootstrap!.inventory;
  $: filters = $appState.courseFilters;
  $: courses = inventory.courses.filter((course) => {
    if (catalogScope === "local" && !localOnly(course)) return false;
    if (catalogScope === "enrolled" && localOnly(course)) return false;
    if (filters.query && !`${course.name} ${course.code} ${course.termName}`.toLowerCase().includes(filters.query.toLowerCase())) return false;
    if (filters.term !== "all" && course.termName !== filters.term) return false;
    if (filters.status === "attention" && !["incomplete", "failed"].includes(course.archive.status)) return false;
    if (!["all", "attention"].includes(filters.status) && course.archive.status !== filters.status) return false;
    if (filters.view !== "all" && String(course.view).toLowerCase() !== filters.view) return false;
    return true;
  });
  $: terms = [...new Set(inventory.courses.map((course) => course.termName))];
  $: grouped = terms.map((term) => [term, courses.filter((course) => course.termName === term)] as [string, Course[]]).filter(([, items]) => items.length);
  $: localCount = inventory.courses.filter(localOnly).length;
  $: archivedCount = inventory.courses.filter((course) => course.archive.exists).length;
  $: eligible = courses.filter((course) => !localOnly(course));
  $: allVisibleSelected = eligible.length > 0 && eligible.every((course) => $appState.selectedCourses.has(course.id));
  $: hiddenSelectedCount = [...$appState.selectedCourses].filter((id) => !courses.some((course) => course.id === id)).length;
  $: filtersActive = Boolean(filters.query || filters.term !== "all" || filters.status !== "all" || filters.view !== "all" || catalogScope !== "all");

  function updateFilter(key: "query" | "term" | "status" | "view", value: string) {
    changeState((state) => state.courseFilters[key] = value);
  }

  function clearFilters() {
    catalogScope = "all";
    changeState((state) => state.courseFilters = { query: "", term: "all", status: "all", view: "all" });
  }

  function toggle(courseId: string, checked: boolean) {
    changeState((state) => checked ? state.selectedCourses.add(courseId) : state.selectedCourses.delete(courseId));
  }

  function selectVisible() {
    changeState((state) => eligible.forEach((course) => allVisibleSelected ? state.selectedCourses.delete(course.id) : state.selectedCourses.add(course.id)));
  }
</script>

<div class="page courses-page">
  <header class="page-header">
    <div><span class="eyebrow">Your course library</span><h1>Courses</h1><p>Browse what you have saved and choose what to fetch next.</p></div>
    <div class="page-actions">
      <button class="button secondary" onclick={() => runInventory().catch(reportError)}><Icon name="scan-search" /><span>Refresh inventory</span></button>
      <button class="button primary" disabled={!$appState.selectedCourses.size} onclick={() => openFetch([...$appState.selectedCourses])}><Icon name="download" /><span>Fetch selected{#if $appState.selectedCourses.size}<span class="button-count">{$appState.selectedCourses.size}</span>{/if}</span></button>
    </div>
  </header>

  <div class="catalog-summary"><span><Icon name="book-copy" /><strong>{archivedCount}</strong> archived on this device</span><span>Last scanned {inventory.generatedAt ? relativeTime(inventory.generatedAt) : "never"}</span></div>
  <div class="catalog-controls">
    <div class="catalog-scopes" role="group" aria-label="Course catalog scope">
      <button class:active={catalogScope === "all"} aria-pressed={catalogScope === "all"} onclick={() => catalogScope = "all"}>All courses <span>{inventory.courses.length}</span></button>
      <button class:active={catalogScope === "enrolled"} aria-pressed={catalogScope === "enrolled"} onclick={() => catalogScope = "enrolled"}>In Blackboard <span>{inventory.courses.length - localCount}</span></button>
      <button class:active={catalogScope === "local"} aria-pressed={catalogScope === "local"} onclick={() => catalogScope = "local"}>Local only <span>{localCount}</span></button>
    </div>
    <div class="course-toolbar">
      <div class="filter-input"><Icon name="search" /><input type="search" aria-label="Filter courses" placeholder="Find a course by name or code…" value={filters.query} oninput={(event) => updateFilter("query", event.currentTarget.value)} /></div>
      <select class="select" aria-label="Filter by term" value={filters.term} onchange={(event) => updateFilter("term", event.currentTarget.value)}><option value="all">All terms</option>{#each terms as term}<option value={term}>{term}</option>{/each}</select>
      <select class="select" aria-label="Filter by archive status" value={filters.status} onchange={(event) => updateFilter("status", event.currentTarget.value)}><option value="all">All archive states</option><option value="attention">Needs attention</option><option value="complete">Complete</option><option value="incomplete">Incomplete</option><option value="failed">Failed</option><option value="not_fetched">Not fetched</option></select>
      <select class="select" aria-label="Filter by course view" value={filters.view} onchange={(event) => updateFilter("view", event.currentTarget.value)}><option value="all">All course views</option><option value="ultra">Ultra</option><option value="classic">Classic</option></select>
    </div>
    <div class="catalog-result-bar"><span role="status">Showing <strong>{courses.length}</strong> of {inventory.courses.length} courses{#if filtersActive}<button class="text-action" onclick={clearFilters}>Clear filters</button>{/if}</span><button class="text-action select-visible" disabled={!eligible.length} onclick={selectVisible}><Icon name={allVisibleSelected ? "square" : "list-checks"} />{allVisibleSelected ? "Deselect visible" : "Select visible"}</button></div>
  </div>

  {#if catalogScope === "local"}
    <div class="catalog-note"><Icon name="archive" /><span>These courses are kept on your device but are absent from the latest Blackboard inventory. You can browse their archives; fetching is disabled.</span></div>
  {/if}

  {#if grouped.length}
    {#each grouped as [term, items]}
      <section class="term-section">
        <div class="term-header"><Icon name="folder-open" /><h2>{term || "Other courses"}</h2><span>{items.length} course{items.length === 1 ? "" : "s"}</span><div class="term-rule"></div></div>
        <div class="data-surface">
          {#each items as course}
            <div class="course-row" class:selected={$appState.selectedCourses.has(course.id)} class:archive-only={localOnly(course)}>
              <label class="course-select-target" title={localOnly(course) ? "Local archive only; fetching is unavailable" : `Select ${course.code}`}><input type="checkbox" disabled={localOnly(course)} checked={$appState.selectedCourses.has(course.id)} onchange={(event) => toggle(course.id, event.currentTarget.checked)} aria-label={`Select ${course.name}`} /></label>
              <CourseAvatar {course} />
              <button class="course-name-button" onclick={() => navigate(`course/${encodeURIComponent(course.id)}/overview`)}><strong>{course.name}</strong><small>{course.code} <span class="course-inline-view">· {course.view}</span>{#if localOnly(course)}<span class="local-only-label">Local only</span>{/if}</small><span class="course-mobile-status"><StatusBadge status={course.archive.status} />{course.archive.exists ? `${course.archive.fileCount} tracked files` : "No local archive"}</span></button>
              <div class="course-meta-cell course-availability"><strong>{course.view}</strong><span>{localOnly(course) ? "Local archive only" : course.available ? "Available in Blackboard" : "Unavailable in Blackboard"}</span></div>
              <div class="course-meta-cell course-archive-state"><StatusBadge status={course.archive.status} /><span>{course.archive.exists ? `${course.archive.fileCount} tracked files · ${relativeTime(course.archive.generatedAt)}` : "No local archive"}</span></div>
              <button class="icon-button" onclick={() => openCourseDetails(course.id)} title={`Actions for ${course.code}`} aria-label={`Actions for ${course.name}`}><Icon name="ellipsis" /></button>
            </div>
          {/each}
        </div>
      </section>
    {/each}
  {:else if !inventory.courses.length}
    <div class="data-surface catalog-empty"><EmptyState icon="book-open" title="Your course library starts here" copy="Scan Blackboard to see your enrolled courses and choose what to save." /><button class="button primary" onclick={() => runInventory().catch(reportError)}><Icon name="scan-search" /> Scan courses</button></div>
  {:else}
    <div class="data-surface catalog-empty"><EmptyState icon="search-x" title="No matching courses" copy="Try a different search or clear the filters to see more of your library." /><button class="button secondary" onclick={clearFilters}>Clear filters</button></div>
  {/if}

  {#if $appState.selectedCourses.size}
    <div class="course-selection-bar" role="region" aria-label="Selected courses"><span><span class="selection-check"><Icon name="check" /></span><strong>{$appState.selectedCourses.size} course{$appState.selectedCourses.size === 1 ? "" : "s"} selected</strong>{#if hiddenSelectedCount}<small>{hiddenSelectedCount} outside the current filters</small>{/if}</span><div><button class="text-action" onclick={() => changeState((state) => state.selectedCourses.clear())}>Clear selection</button><button class="button primary" onclick={() => openFetch([...$appState.selectedCourses])}>Choose fetch options <Icon name="arrow-right" /></button></div></div>
  {/if}
</div>
