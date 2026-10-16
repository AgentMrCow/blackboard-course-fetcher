<script lang="ts">
  import Icon from "../components/Icon.svelte";
  import SettingsForm from "../components/SettingsForm.svelte";
  import { appState, checkAuth, openSetup, reportError, saveSettings } from "../lib/controller";
  import { formatBytes, relativeTime } from "../lib/format";

  $: bootstrap = $appState.bootstrap!;
  $: ({ settings, system, auth, summary } = bootstrap);
  $: waiting = ["starting", "waiting", "saving"].includes(auth.status);
</script>

<div class="page">
  <header class="page-header"><div><span class="eyebrow">Local configuration</span><h1>Settings</h1><p>Paths and fetch limits apply to both the dashboard and new course jobs.</p></div></header>
  <div class="settings-layout">
    <div>
      <section class="settings-section"><h2>Blackboard and storage</h2><p>Changing the archive directory immediately reloads the local course catalog.</p><SettingsForm {settings} submit={(form) => saveSettings(form).catch(reportError)} /></section>
      <section class="settings-section"><h2>Session</h2><p>Sign in through the official Blackboard window, then use the saved browser state for local fetch jobs.</p><div class="setup-status" class:success={auth.validation?.valid} class:warning={!auth.validation?.valid && auth.exists} class:error={!auth.exists}><Icon name={auth.validation?.valid ? "shield-check" : "shield-alert"} /><span><strong>{auth.message || auth.validation?.message || (auth.exists ? "Saved session has not been checked" : "No saved session")}</strong><small>{auth.modifiedAt ? `State updated ${relativeTime(auth.modifiedAt)} · ${auth.cookieCount} cookies` : auth.stateFile}</small></span></div><div class="setup-actions"><button class="button secondary" disabled={!auth.exists || waiting} onclick={() => checkAuth().catch(reportError)}><Icon name="shield-check" /><span>Check session</span></button><button class="button primary" onclick={() => openSetup(1)}><Icon name="log-in" /><span>{waiting ? "Continue sign-in" : "Manage sign-in"}</span></button></div></section>
    </div>
    <aside><div class="system-card"><h3>Local environment</h3><dl class="definition-list"><div class="definition-row"><dt>Node.js</dt><dd>{system.node}</dd></div><div class="definition-row"><dt>Platform</dt><dd>{system.platform} {system.architecture}</dd></div><div class="definition-row"><dt>Chromium</dt><dd>{system.chromiumInstalled ? "Installed" : "Not installed"}</dd></div><div class="definition-row"><dt>Live process pause</dt><dd>{system.liveProcessPause ? "Supported" : "Restart-on-resume"}</dd></div><div class="definition-row"><dt>Archive</dt><dd>{formatBytes(summary.bytes)}</dd></div><div class="definition-row"><dt>Disk free</dt><dd>{formatBytes(system.disk?.freeBytes)}</dd></div></dl></div></aside>
  </div>
</div>
