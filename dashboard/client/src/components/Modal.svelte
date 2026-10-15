<script lang="ts">
  import { tick } from "svelte";

  export let open: boolean;
  export let className = "";
  export let close: () => void;
  export let labelledby: string | undefined = undefined;
  let dialog: HTMLDialogElement;
  let syncSequence = 0;
  let pendingCloseEvents = 0;

  $: sync(open, dialog);

  async function sync(shouldOpen: boolean, element: HTMLDialogElement) {
    const sequence = ++syncSequence;
    if (!element) return;
    await tick();
    if (sequence !== syncSequence || element !== dialog || !element.isConnected) return;
    if (shouldOpen && !element.open) element.showModal();
    if (!shouldOpen && element.open) {
      // close() queues its event; it may arrive after the next showModal().
      pendingCloseEvents += 1;
      element.close();
    }
  }

  function nativeClose() {
    if (pendingCloseEvents) {
      pendingCloseEvents -= 1;
      return;
    }
    if (!dialog.open) close();
  }

  function cancel(event: Event) {
    event.preventDefault();
    close();
  }
</script>

<dialog bind:this={dialog} class={className} aria-labelledby={labelledby} onclose={nativeClose} oncancel={cancel}>
  <slot />
</dialog>
