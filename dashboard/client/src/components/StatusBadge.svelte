<script lang="ts">
  import { statusInfo } from "../lib/format";

  export let status: unknown;
  export let label: string | null = null;

  $: info = statusInfo(status);
</script>

<span class="status-badge {info.className}">{label || info.label}</span>
