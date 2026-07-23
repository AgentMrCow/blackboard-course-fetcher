<script lang="ts">
  import { onMount } from "svelte";
  import Icon from "./components/Icon.svelte";
  import DetailDialog from "./dialogs/DetailDialog.svelte";
  import FetchDialog from "./dialogs/FetchDialog.svelte";
  import FileDialog from "./dialogs/FileDialog.svelte";
  import SearchDialog from "./dialogs/SearchDialog.svelte";
  import SetupDialog from "./dialogs/SetupDialog.svelte";
  import { activeBatch, appState, changeState, initialize, navigate, openSearch, openSetup, refreshBootstrap, reportError } from "./lib/controller";
  import { formatBytes } from "./lib/format";
  import ActivityPage from "./pages/ActivityPage.svelte";
  import CalendarPage from "./pages/CalendarPage.svelte";
  import CoursePage from "./pages/CoursePage.svelte";
  import CoursesPage from "./pages/CoursesPage.svelte";
  import FilesPage from "./pages/FilesPage.svelte";
  import HomePage from "./pages/HomePage.svelte";
  import SettingsPage from "./pages/SettingsPage.svelte";

  const validPages = new Set(["home", "courses", "course", "calendar", "files", "activity", "settings"]);
  let cleanup: (() => void) | undefined;

  $: bootstrap = $appState.bootstrap;
  $: auth = bootstrap?.auth;
  $: summary = bootstrap?.summary;
  $: system = bootstrap?.system;
  $: sessionValid = auth?.validation?.valid === true || auth?.status === "connected";
  $: hasState = auth?.exists;
  $: batch = activeBatch(bootstrap);
  $: free = Number(system?.disk?.freeBytes);
  $: total = Number(system?.disk?.totalBytes);
  $: usedPercent = free && total ? Math.max(0, Math.min(100, ((total - free) / total) * 100)) : 0;
  $: if (!$appState.loading && !validPages.has($appState.route.page)) navigate("home");

  onMount(() => {
    initialize().then((dispose) => cleanup = dispose);
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      cleanup?.();
      window.removeEventListener("keydown", keydown);
    };
  });
</script>

<svelte:head><title>Blackboard Archive</title></svelte:head>

<a class="skip-link" href="#main-content">Skip to content</a>
<div class="app-shell" class:nav-open={$appState.mobileNavOpen}>
  <aside class="sidebar" aria-label="Primary navigation">
    <div class="brand"><div class="brand-mark" aria-hidden="true"><span>BA</span></div><div><strong>Blackboard Archive</strong><small>Local course workspace</small></div></div>
    <nav class="primary-nav">
      <a href="#/home" class:active={$appState.route.page === "home"}><Icon name="layout-dashboard" /><span>Overview</span></a>
      <a href="#/courses" class:active={["courses", "course"].includes($appState.route.page)}><Icon name="book-open" /><span>Courses</span>{#if bootstrap?.inventory?.courses?.length}<span class="nav-count">{bootstrap.inventory.courses.length}</span>{/if}</a>
      <a href="#/calendar" class:active={$appState.route.page === "calendar"}><Icon name="calendar-days" /><span>Calendar</span></a>
      <a href="#/files" class:active={$appState.route.page === "files"}><Icon name="files" /><span>Files</span></a>
      <a href="#/activity" class:active={$appState.route.page === "activity"}><Icon name="activity" /><span>Fetch activity</span>{#if batch}<span class="activity-dot"></span>{/if}</a>
    </nav>
    <div class="sidebar-spacer"></div>
    {#if bootstrap}
      <div class="sidebar-status"><strong>{summary?.archivedCount || 0} of {summary?.courseCount || 0} courses local</strong><span>{Number(summary?.materialFiles ?? summary?.files ?? 0).toLocaleString()} materials · {Number(summary?.recordFiles || 0).toLocaleString()} records</span><div class="mini-meter"><span style={`width:${usedPercent.toFixed(1)}%`}></span></div><span>{free ? `${formatBytes(free)} disk space free` : "Archive storage ready"}</span></div>
    {/if}
    <nav class="secondary-nav"><button type="button" onclick={() => openSetup()}><Icon name="list-checks" /><span>Setup guide</span></button><a href="#/settings" class:active={$appState.route.page === "settings"}><Icon name="settings" /><span>Settings</span></a></nav>
  </aside>

  {#if $appState.mobileNavOpen}<button class="mobile-scrim" aria-label="Close navigation" onclick={() => changeState((state) => state.mobileNavOpen = false)}></button>{/if}

  <div class="workspace">
    <header class="topbar">
      <button class="icon-button mobile-menu-button" type="button" onclick={() => changeState((state) => state.mobileNavOpen = true)} title="Open navigation" aria-label="Open navigation"><Icon name="menu" /></button>
      <button class="global-search" type="button" onclick={openSearch}><Icon name="search" /><span>Search courses and archived files</span><kbd>Ctrl K</kbd></button>
      <div class="topbar-actions"><button class="icon-button" type="button" onclick={() => refreshBootstrap(true).catch(reportError)} title="Refresh local data" aria-label="Refresh local data"><Icon name="refresh-cw" /></button><button class="connection-pill" class:connected={sessionValid} class:warning={!sessionValid && hasState} class:error={!sessionValid && !hasState} type="button" onclick={() => openSetup(1)}><span class="status-dot"></span><span>{sessionValid ? "Session ready" : hasState ? "Check session" : "Sign in"}</span></button></div>
    </header>
    <main id="main-content" tabindex="-1">
      {#if $appState.loading}<div class="page-loading"><span class="spinner"></span><span>Loading your local archive</span></div>
      {:else if $appState.fatalError}<div class="empty-state"><Icon name="server-off" /><h3>Dashboard server unavailable</h3><p>{$appState.fatalError}</p></div>
      {:else if bootstrap}
        {#if $appState.route.page === "home"}<HomePage />
        {:else if $appState.route.page === "courses"}<CoursesPage />
        {:else if $appState.route.page === "course"}<CoursePage />
        {:else if $appState.route.page === "calendar"}<CalendarPage />
        {:else if $appState.route.page === "files"}<FilesPage />
        {:else if $appState.route.page === "activity"}<ActivityPage />
        {:else if $appState.route.page === "settings"}<SettingsPage />{/if}
      {/if}
    </main>
  </div>
</div>

<SearchDialog />
{#if bootstrap}
  <SetupDialog />
  <FetchDialog />
{/if}
<FileDialog />
<DetailDialog />

<div class="toast-region" aria-live="polite" aria-atomic="true">
  {#each $appState.toasts as toast (toast.id)}<div class="toast {toast.type}"><Icon name={toast.type === "error" ? "circle-alert" : toast.type === "success" ? "circle-check" : "info"} /><span>{toast.message}</span></div>{/each}
</div>
