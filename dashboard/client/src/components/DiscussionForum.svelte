<script lang="ts">
  import { formatDate, initials } from "../lib/format";
  import type { JsonRecord } from "../lib/types";
  import Icon from "./Icon.svelte";

  export let forum: JsonRecord;
  export let initiallyOpen = false;

  interface FlatMessage {
    depth: number;
    message: JsonRecord;
  }

  function flattenMessages(messages: JsonRecord[] = [], depth = 0, result: FlatMessage[] = []): FlatMessage[] {
    for (const message of messages) {
      result.push({ depth, message });
      flattenMessages(message.replies || [], depth + 1, result);
    }
    return result;
  }

  function htmlToText(value: unknown): string {
    const html = String(value || "").trim();
    if (!html) return "";
    if (typeof DOMParser === "undefined") return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const document = new DOMParser().parseFromString(html, "text/html");
    const blockTags = new Set(["ADDRESS", "BLOCKQUOTE", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "P", "PRE", "TR"]);

    function nodeText(node: Node): string {
      if (node.nodeType === 3) return String(node.textContent || "").replace(/\s+/g, " ");
      if (node.nodeType !== 1) return "";
      const element = node as Element;
      const tag = element.tagName.toUpperCase();
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(tag)) return "";
      if (tag === "BR") return "\n";
      if (tag === "IMG") return element.getAttribute("alt") ? `[Image: ${element.getAttribute("alt")}]` : "[Image]";
      if (tag === "MATH") {
        const annotation = element.querySelector("annotation[encoding*='tex' i], annotation");
        if (annotation?.textContent?.trim()) return ` ${annotation.textContent.trim()} `;
      }
      if (tag === "ANNOTATION") return "";
      const content = [...node.childNodes].map(nodeText).join("");
      if (tag === "LI") return `\n- ${content}\n`;
      if (["TD", "TH"].includes(tag)) return `${content} `;
      return blockTags.has(tag) ? `\n${content}\n` : content;
    }

    return nodeText(document.body)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .trim();
  }

  function messageBody(message: JsonRecord): string {
    if (typeof message.body === "string") return htmlToText(message.body);
    return htmlToText(
      message.body?.displayText
      || message.body?.rawText
      || message.description?.displayText
      || message.description?.rawText
    );
  }

  function forumDescription(value: JsonRecord): string {
    return htmlToText(
      value.detail?.description?.displayText
      || value.detail?.description?.rawText
      || value.summary?.description?.displayText
      || value.summary?.description?.rawText
      || value.description
    );
  }

  $: title = forum.title || forum.name || forum.subject || forum.detail?.title || forum.summary?.title || "Discussion";
  $: messages = flattenMessages(forum.messages || []);
  $: preview = messages.map(({ message }) => messageBody(message)).find(Boolean) || forumDescription(forum);
  $: firstMessage = messages[0]?.message;
  $: forumDate = firstMessage?.postDate || firstMessage?.createdDate || forum.detail?.modifiedDate || forum.summary?.modifiedDate;
</script>

<details class="discussion-forum" open={initiallyOpen}>
  <summary>
    <span class="discussion-summary-icon"><Icon name="messages-square" /></span>
    <span class="discussion-summary-copy">
      <strong>{title}</strong>
      <small>{preview || (messages.length ? "The archived post has no text body." : "No message bodies were archived for this forum.")}</small>
    </span>
    <span class="discussion-summary-meta">
      <strong>{messages.length} {messages.length === 1 ? "message" : "messages"}</strong>
      {#if forumDate}<small>{formatDate(forumDate, { time: true })}</small>{/if}
    </span>
    <span class="discussion-chevron"><Icon name="chevron-down" /></span>
  </summary>

  <div class="discussion-thread">
    {#if messages.length}
      {#each messages as entry, index (`${entry.message.id || "message"}-${index}`)}
        <article class="discussion-message" class:discussion-reply={entry.depth > 0} style={`--reply-depth:${Math.min(entry.depth, 6)}`}>
          <header>
            <span class="discussion-avatar">{initials(entry.message.postedName || `${entry.message.givenName || ""} ${entry.message.familyName || ""}`)}</span>
            <span class="discussion-author">
              <strong>{entry.message.postedName || `${entry.message.givenName || ""} ${entry.message.familyName || ""}`.trim() || "Unknown author"}</strong>
              <small>{entry.message.postDate || entry.message.createdDate ? formatDate(entry.message.postDate || entry.message.createdDate, { time: true }) : "Archived message"}</small>
            </span>
            {#if entry.depth > 0}<span class="badge neutral">Reply</span>{/if}
          </header>
          {#if entry.message.subject && entry.message.subject !== title}<h4>{entry.message.subject}</h4>{/if}
          <div class="discussion-body">{messageBody(entry.message) || "No text body was archived for this message."}</div>
          {#if entry.message.messageStatus?.hasAttachment}
            <div class="discussion-attachment"><Icon name="paperclip" /><span>This post references an attachment that may not be present in the archive.</span></div>
          {/if}
        </article>
      {/each}
    {:else}
      <div class="discussion-empty">
        <Icon name="message-square-dashed" />
        <span>{forumDescription(forum) || "Blackboard exposed this forum record without accessible message bodies."}</span>
      </div>
    {/if}
  </div>
</details>
