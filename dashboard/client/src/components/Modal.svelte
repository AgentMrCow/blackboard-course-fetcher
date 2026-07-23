<script lang="ts">
  import { tick } from "svelte";

  export let open: boolean;
  export let className = "";
  export let close: () => void;
  export let labelledby: string | undefined = undefined;
  let dialog: HTMLDialogElement;

  $: sync(open, dialog);

  async function sync(shouldOpen: boolean, element: HTMLDialogElement) {
    if (!element) return;
    await tick();
    if (shouldOpen && !element.open) element.showModal();
    if (!shouldOpen && element.open) element.close();
  }
</script>

<dialog bind:this={dialog} class={className} aria-labelledby={labelledby} onclose={close}>
  <slot />
</dialog>
