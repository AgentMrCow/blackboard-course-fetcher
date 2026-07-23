<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import Modal from "../components/Modal.svelte";
  import SettingsForm from "../components/SettingsForm.svelte";
  import { appState, authAction, cancelInventory, changeState, checkAuth, navigate, reportError, runInventory, saveSettings, setupCompletion } from "../lib/controller";
  import { formatBytes, formatDate, relativeTime } from "../lib/format";

  const steps = [
    ["Configure", "Blackboard and storage"],
    ["Sign in", "Official login and MFA"],
    ["Inventory", "Review the course catalog"],
    ["Fetch", "Build and use the archive"],
  ];
  $: bootstrap = $appState.bootstrap!;
  $: completion = setupCompletion(bootstrap);
  $: ({ settings, auth, system, inventory, summary, inventoryTask } = bootstrap);
  $: valid = auth.validation?.valid === true || auth.status === "connected";
  $: waiting = ["starting", "waiting", "saving"].includes(auth.status);
  $: inventoryRunning = ["running", "cancelling"].includes(inventoryTask.status);

  function close() {
    changeState((state) => state.setupOpen = false);
  }

  function next() {
    changeState((state) => state.setupStep = Math.min(3, state.setupStep + 1));
  }

  function chooseCourses() {
    close();
    navigate("courses");
  }
</script>

<Modal open={$appState.setupOpen} className="setup-dialog" labelledby="setup-title" {close}>
  <div class="dialog-header"><div><span class="eyebrow">First run and maintenance</span><h2 id="setup-title">Connect and build your archive</h2></div><button class="icon-button" onclick={close} title="Close" aria-label="Close"><Icon name="x" /></button></div>
  <div class="setup-layout">
    <ol class="setup-steps">
      {#each steps as [title, subtitle], index}
        <li><button class="setup-step" class:complete={completion[index]} class:active={$appState.setupStep === index} onclick={() => changeState((state) => state.setupStep = index)}><span class="setup-step-index">{#if completion[index]}<Icon name="check" />{:else}{index + 1}{/if}</span><span><strong>{title}</strong><small>{subtitle}</small></span></button></li>
      {/each}
    </ol>
    <section class="setup-panel">
      {#if $appState.setupStep === 0}
        <h3>Choose the Blackboard site and local archive</h3><p>The dashboard uses the same paths as the command-line fetcher. Relative paths are resolved from the fetcher directory.</p><SettingsForm {settings} id="setup-settings-form" submit={(form) => saveSettings(form).catch(reportError)} /><div class="setup-actions"><button class="button secondary" onclick={next}>Next: sign in <Icon name="arrow-right" /></button></div>
      {:else if $appState.setupStep === 1}
        <h3>Sign in through the official Blackboard window</h3><p>Playwright opens the institution's login page and saves the resulting browser session state after sign-in.</p>
        <ol class="instruction-list"><li><span>1</span><span>Select <strong>Open sign-in browser</strong>. A separate Chromium window opens at {settings.blackboardBase || "your Blackboard URL"}.</span></li><li><span>2</span><span>Enter your institutional credentials in that official window and complete the multi-factor prompt.</span></li><li><span>3</span><span>Wait until Blackboard's course page is visible. Keep the browser open and return to this dashboard.</span></li><li><span>4</span><span>Select <strong>Save and verify session</strong>. The dashboard checks the student API before closing the sign-in window.</span></li></ol>
        {#if !system.chromiumInstalled}<div class="setup-status error"><Icon name="circle-alert" /><span><strong>Playwright Chromium is not installed</strong><small>Run npx playwright install chromium in the blackboard-fetcher directory, then refresh this page.</small></span></div>{:else}<div class="setup-status" class:success={valid} class:warning={!valid && (waiting || auth.exists)} class:error={!valid && !waiting && !auth.exists}><Icon name={valid ? "shield-check" : waiting ? "refresh-cw" : "shield-alert"} /><span><strong>{auth.message || (valid ? "Session is ready" : auth.exists ? "A saved session is available but has not been verified" : "No Blackboard session has been saved")}</strong><small>{auth.modifiedAt ? `State updated ${relativeTime(auth.modifiedAt)} · ${auth.cookieCount} cookies` : auth.stateFile}</small></span></div>{/if}
        <div class="setup-actions">
          {#if waiting}<button class="button primary" disabled={auth.status === "starting" || auth.status === "saving"} onclick={() => authAction("save").catch(reportError)}><Icon name="shield-check" /><span>{auth.status === "saving" ? "Verifying" : "Save and verify session"}</span></button><button class="button secondary" onclick={() => authAction("cancel").catch(reportError)}>Cancel sign-in</button>
          {:else}<button class="button primary" disabled={!system.chromiumInstalled} onclick={() => authAction("start").catch(reportError)}><Icon name="log-in" /><span>Open sign-in browser</span></button><button class="button secondary" disabled={!auth.exists} onclick={() => checkAuth().catch(reportError)}><Icon name="shield-check" /><span>Check saved session</span></button>{/if}
          <button class="button secondary" disabled={!valid} onclick={next}>Next: inventory <Icon name="arrow-right" /></button>
        </div>
      {:else if $appState.setupStep === 2}
        <h3>Read the course catalog before downloading content</h3><p>Inventory calls the Blackboard memberships API and writes <code>courses.json</code>. It does not fetch course content or binary files.</p>
        <ol class="instruction-list"><li><span>1</span><span>Run the inventory after the session check succeeds.</span></li><li><span>2</span><span>Review term names, Ultra or Classic view, availability, and existing archive coverage.</span></li><li><span>3</span><span>Select a small course set for the first fetch. Placeholder mode is the low-bandwidth starting point.</span></li></ol>
        <div class="setup-status" class:success={inventory.courses.length} class:warning={!inventory.courses.length && inventoryRunning} class:error={!inventory.courses.length && !inventoryRunning}><Icon name={inventory.courses.length ? "list-checks" : inventoryRunning ? "refresh-cw" : "refresh-cw"} /><span><strong>{inventoryRunning ? inventoryTask.message || "Scanning course memberships" : inventory.courses.length ? `${inventory.courses.length} courses found` : "No course inventory yet"}</strong><small>{inventory.generatedAt ? `Last scanned ${formatDate(inventory.generatedAt, { time: true })}` : "No course bodies will be downloaded during this step"}</small></span></div>
        {#if inventoryTask.logs?.length}<div class="log-panel" style="position:static;max-height:170px"><header><strong>Inventory output</strong></header><div class="log-lines" style="max-height:125px">{#each inventoryTask.logs.slice(-20) as entry}<div class="log-line">{entry.line}</div>{/each}</div></div>{/if}
        <div class="setup-actions">{#if inventoryRunning}<button class="button danger" onclick={() => cancelInventory().catch(reportError)}><Icon name="x" /><span>Cancel inventory</span></button>{:else}<button class="button primary" onclick={() => runInventory().catch(reportError)}><Icon name="scan-search" /><span>{inventory.courses.length ? "Refresh inventory" : "Scan courses"}</span></button>{/if}<button class="button secondary" disabled={!inventory.courses.length} onclick={next}>Next: fetch <Icon name="arrow-right" /></button></div>
      {:else}
        <h3>Fetch a small scope, inspect it, then expand</h3><p>Placeholder mode stores text, HTML, JSON, source code, calendar data, and metadata for binary files. Full mode retrieves the binary bodies too.</p>
        <div class="metric-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="metric"><span class="metric-label"><span>Catalog</span><Icon name="book-open" /></span><strong>{inventory.courses.length}</strong><small>Known memberships</small></div><div class="metric"><span class="metric-label"><span>Archived</span><Icon name="archive" /></span><strong>{summary.archivedCount}</strong><small>Locally browsable courses</small></div><div class="metric"><span class="metric-label"><span>Coverage issues</span><Icon name="triangle-alert" /></span><strong>{summary.issueCount}</strong><small>Repairable fetches</small></div></div>
        <ol class="instruction-list"><li><span>1</span><span>Open Courses and select one or more available memberships.</span></li><li><span>2</span><span>Choose placeholder or full mode, set conservative concurrency, and start the batch.</span></li><li><span>3</span><span>Use Fetch activity to inspect the current phase and file, ETA, logs, pause, resume, or cancel controls.</span></li><li><span>4</span><span>After completion, open the course workspace. Every archived artifact remains available under Files even when it has no specialized view.</span></li></ol>
        <div class="setup-actions"><button class="button primary" onclick={chooseCourses}><Icon name="book-open" /><span>Choose courses</span></button>{#if summary.archivedCount}<button class="button secondary" onclick={close}><Icon name="layout-dashboard" /><span>Use the archive</span></button>{/if}</div>
      {/if}
    </section>
  </div>
</Modal>
