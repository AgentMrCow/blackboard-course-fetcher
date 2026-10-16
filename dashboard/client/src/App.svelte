<script lang="ts">
  import { onMount, tick } from "svelte";
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
  let mobileViewport = window.matchMedia("(max-width: 900px)").matches;
  let navigation: HTMLElement;
  let navigationTrigger: HTMLButtonElement;
  let navigationWasOpen = false;
  let restoreNavigationFocus = true;
  let navigationRevision = 0;
  let previousBodyOverflow = "";

  $: drawerOpen = mobileViewport && $appState.mobileNavOpen;
  $: synchronizeNavigation(drawerOpen, mobileViewport, navigation);

  $: bootstrap = $appState.bootstrap;
  $: auth = bootstrap?.auth;
  $: summary = bootstrap?.summary;
  $: system = bootstrap?.system;
  $: sessionValid = auth?.validation?.valid === true || auth?.status === "connected";
  $: hasState = auth?.exists;
  $: batch = activeBatch(bootstrap);
  $: free = Number(system?.disk?.freeBytes);
  $: total = Number(system?.disk?.totalBytes);
  $: usedPercent = Number.isFinite(free) && Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(100, ((total - free) / total) * 100)) : 0;
  $: if (!$appState.loading && !validPages.has($appState.route.page)) navigate("home");

  function closeNavigation(restoreFocus = true) {
    restoreNavigationFocus = restoreFocus;
    changeState((state) => state.mobileNavOpen = false);
  }

  async function synchronizeNavigation(open: boolean, mobile: boolean, sidebar?: HTMLElement) {
    if (!sidebar || open === navigationWasOpen) return;
    navigationWasOpen = open;
    const revision = ++navigationRevision;
    if (open) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = previousBodyOverflow;
    }
    await tick();
    if (revision !== navigationRevision) return;
    if (open) {
      sidebar.scrollTop = 0;
      sidebar.querySelector<HTMLElement>(".mobile-nav-close")?.focus({ preventScroll: true });
    } else if (mobile && restoreNavigationFocus) navigationTrigger?.focus({ preventScroll: true });
    else if (!mobile && document.activeElement?.classList.contains("mobile-nav-close")) sidebar.querySelector<HTMLElement>("a[aria-current='page']")?.focus({ preventScroll: true });
    restoreNavigationFocus = true;
  }

  async function openFromNavigation(action: () => void) {
    if (drawerOpen) {
      closeNavigation(false);
      await tick();
      // Native dialogs should return focus to a visible control when they close.
      navigationTrigger?.focus({ preventScroll: true });
    }
    action();
  }

  onMount(() => {
    let disposed = false;
    initialize().then((dispose) => {
      if (disposed) dispose();
      else cleanup = dispose;
    });
    const media = window.matchMedia("(max-width: 900px)");
    const resizeNavigation = () => {
      const focusWasInNavigation = navigation?.contains(document.activeElement);
      mobileViewport = media.matches;
      if (!mobileViewport) closeNavigation(false);
      else if (!$appState.mobileNavOpen && focusWasInNavigation) tick().then(() => navigationTrigger?.focus({ preventScroll: true }));
    };
    media.addEventListener("change", resizeNavigation);
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openFromNavigation(openSearch);
        return;
      }
      if (!drawerOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeNavigation();
      } else if (event.key === "Tab") {
        const items = [...navigation.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), [tabindex='0']")].filter((item) => item.getClientRects().length);
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && (document.activeElement === first || !navigation.contains(document.activeElement))) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !navigation.contains(document.activeElement))) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      disposed = true;
      cleanup?.();
      navigationRevision++;
      if (navigationWasOpen) document.body.style.overflow = previousBodyOverflow;
      media.removeEventListener("change", resizeNavigation);
      window.removeEventListener("keydown", keydown);
    };
  });
</script>

<svelte:head><title>Blackboard Archive</title></svelte:head>

<a class="skip-link" inert={drawerOpen} href="#main-content" onclick={(event) => { event.preventDefault(); const main = document.getElementById("main-content"); main?.focus(); main?.scrollIntoView({ block: "start" }); }}>Skip to content</a>
<div class="app-shell" class:nav-open={drawerOpen}>
  <aside bind:this={navigation} id="primary-navigation" class="sidebar" inert={mobileViewport && !drawerOpen} aria-hidden={mobileViewport && !drawerOpen ? true : undefined} role={drawerOpen ? "dialog" : undefined} aria-modal={drawerOpen ? true : undefined} aria-label="Primary navigation">
    <button class="icon-button mobile-nav-close" type="button" aria-label="Close navigation" onclick={() => closeNavigation()}><Icon name="x" /></button>
    <a class="brand" href="#/home" onclick={() => closeNavigation()} aria-label="Blackboard Archive home"><div class="brand-mark" aria-hidden="true"><Icon name="book-open" /></div><div><strong>Blackboard Archive</strong><small>Your local learning library</small></div></a>
    <div class="nav-label">Workspace</div>
    <nav class="primary-nav">
      <a href="#/home" onclick={() => closeNavigation()} aria-current={$appState.route.page === "home" ? "page" : undefined} class:active={$appState.route.page === "home"}><Icon name="layout-dashboard" /><span>Overview</span></a>
      <a href="#/courses" onclick={() => closeNavigation()} aria-current={["courses", "course"].includes($appState.route.page) ? "page" : undefined} class:active={["courses", "course"].includes($appState.route.page)}><Icon name="book-open" /><span>Courses</span>{#if bootstrap?.inventory?.courses?.length}<span class="nav-count">{bootstrap.inventory.courses.length}</span>{/if}</a>
      <a href="#/calendar" onclick={() => closeNavigation()} aria-current={$appState.route.page === "calendar" ? "page" : undefined} class:active={$appState.route.page === "calendar"}><Icon name="calendar-days" /><span>Calendar</span></a>
      <a href="#/files" onclick={() => closeNavigation()} aria-current={$appState.route.page === "files" ? "page" : undefined} class:active={$appState.route.page === "files"}><Icon name="files" /><span>Files</span></a>
      <a href="#/activity" onclick={() => closeNavigation()} aria-current={$appState.route.page === "activity" ? "page" : undefined} class:active={$appState.route.page === "activity"}><Icon name="activity" /><span>Fetch activity</span>{#if batch}<span class="activity-dot" aria-label="Fetch active"></span>{/if}</a>
    </nav>
    <div class="sidebar-spacer"></div>
    {#if bootstrap}
      <div class="sidebar-status"><span class="sidebar-storage-label"><Icon name="hard-drive-download" /> On this device</span><strong>{summary?.archivedCount || 0} of {summary?.courseCount || 0} courses local</strong><span>{Number(summary?.materialFiles ?? summary?.files ?? 0).toLocaleString()} materials · {Number(summary?.recordFiles || 0).toLocaleString()} records</span>{#if Number.isFinite(free) && Number.isFinite(total) && total > 0}<div class="mini-meter" title={`${usedPercent.toFixed(1)}% of disk used`}><span style={`width:${usedPercent.toFixed(1)}%`}></span></div><span>{formatBytes(free)} disk space free</span>{/if}</div>
    {/if}
    <nav class="secondary-nav"><button type="button" onclick={() => openFromNavigation(() => openSetup())}><Icon name="list-checks" /><span>Setup guide</span></button><a href="#/settings" onclick={() => closeNavigation()} aria-current={$appState.route.page === "settings" ? "page" : undefined} class:active={$appState.route.page === "settings"}><Icon name="settings" /><span>Settings</span></a></nav>
  </aside>

  {#if drawerOpen}<button class="mobile-scrim" tabindex="-1" aria-label="Dismiss navigation backdrop" onclick={() => closeNavigation()}></button>{/if}

  <div class="workspace" inert={drawerOpen}>
    <header class="topbar">
      <button bind:this={navigationTrigger} class="icon-button mobile-menu-button" type="button" aria-controls="primary-navigation" aria-expanded={drawerOpen} onclick={() => changeState((state) => state.mobileNavOpen = true)} title="Open navigation" aria-label="Open navigation"><Icon name="menu" /></button>
      <button class="global-search" type="button" onclick={openSearch}><Icon name="search" /><span>Search courses and archived files</span><kbd>Ctrl K</kbd></button>
      <div class="topbar-actions"><button class="icon-button" type="button" onclick={() => refreshBootstrap(true).catch(reportError)} title="Refresh local data" aria-label="Refresh local data"><Icon name="refresh-cw" /></button><button class="connection-pill" class:connected={sessionValid} class:warning={!sessionValid && hasState} class:error={!sessionValid && !hasState} type="button" title="Blackboard session settings" aria-label={`Blackboard session: ${sessionValid ? "ready" : hasState ? "needs checking" : "sign in required"}`} onclick={() => openSetup(1)}><span class="status-dot"></span><span>{sessionValid ? "Session ready" : hasState ? "Check session" : "Sign in"}</span></button></div>
    </header>
    {#if $appState.connectionStatus === "reconnecting" || $appState.connectionStatus === "offline"}
      <div class="connection-notice" role="status"><Icon name={$appState.connectionStatus === "offline" ? "server-off" : "refresh-cw"} /><span>{$appState.connectionStatus === "offline" ? "Local server disconnected. Displayed data may be out of date." : "Reconnecting to the local server. Live updates will resume automatically."}</span><button class="text-action" onclick={() => refreshBootstrap(true).catch(reportError)}>Refresh</button></div>
    {/if}
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
