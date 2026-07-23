<script lang="ts">
  import Icon from "./Icon.svelte";

  export let icon = "archive";
  export let title: string;
  export let copy: string;
</script>

<div class="empty-state">
  <Icon name={icon} />
  <h3>{title}</h3>
  <p>{copy}</p>
  <slot />
</div>
