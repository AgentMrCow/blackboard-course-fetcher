<script lang="ts">
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import { appState, changeState, openCalendarItem, reportError } from "../lib/controller";
  import { dateKey, formatDate, titleCase } from "../lib/format";

  $: deadlines = $appState.bootstrap!.summary.deadlines;
  $: cursor = new Date($appState.calendarCursor.getFullYear(), $appState.calendarCursor.getMonth(), 1);
  $: monthName = new Intl.DateTimeFormat("en-HK", { month: "long", year: "numeric" }).format(cursor);
  $: gridStart = (() => { const date = new Date(cursor); date.setDate(1 - date.getDay()); return date; })();
  $: eventsByDay = deadlines.reduce((map: Map<string, any[]>, item: any) => {
    const key = dateKey(item.dueDate);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
    return map;
  }, new Map<string, any[]>());
  $: days = Array.from({ length: 42 }, (_, index) => { const date = new Date(gridStart); date.setDate(gridStart.getDate() + index); return { date, key: dateKey(date), events: eventsByDay.get(dateKey(date)) || [] }; });
  $: agenda = deadlines.filter((item: any) => new Date(item.dueDate).valueOf() >= Date.now() - 86_400_000).sort((left: any, right: any) => new Date(left.dueDate).valueOf() - new Date(right.dueDate).valueOf()).slice(0, 12);
  const todayKey = dateKey(new Date());

  function moveMonth(offset: number) {
    changeState((state) => state.calendarCursor = new Date(cursor.getFullYear(), cursor.getMonth() + offset, 1));
  }
</script>

<div class="page">
  <header class="page-header"><div><span class="eyebrow">Across archived courses</span><h1>Calendar</h1><p>Due dates from every locally fetched course in one schedule.</p></div><div class="page-actions"><button class="button secondary" onclick={() => changeState((state) => state.calendarCursor = new Date())}><Icon name="calendar-check" /><span>Today</span></button></div></header>
  <div class="calendar-layout">
    <section class="calendar-shell">
      <header class="calendar-header"><h2>{monthName}</h2><div class="calendar-controls"><button class="icon-button" onclick={() => moveMonth(-1)} title="Previous month" aria-label="Previous month"><Icon name="chevron-left" /></button><button class="icon-button" onclick={() => moveMonth(1)} title="Next month" aria-label="Next month"><Icon name="chevron-right" /></button></div></header>
      <div class="calendar-grid">
        {#each ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as day}<div class="calendar-weekday">{day}</div>{/each}
        {#each days as day}
          <div class="calendar-day" class:other-month={day.date.getMonth() !== cursor.getMonth()} class:today={day.key === todayKey}>
            <span class="day-number">{day.date.getDate()}</span>
            {#each day.events.slice(0, 3) as item}
              <button class="calendar-event" class:overdue={new Date(item.dueDate).valueOf() < Date.now() && !/graded|submitted|complete/i.test(item.status)} onclick={() => openCalendarItem(item.courseId, item.title).catch(reportError)} title={item.title}>{item.courseCode} · {item.title}</button>
            {/each}
            {#if day.events.length > 3}<span class="badge neutral">+{day.events.length - 3}</span>{/if}
          </div>
        {/each}
      </div>
    </section>
    <aside class="section-block"><div class="section-heading"><h2>Upcoming</h2><span class="badge neutral">{agenda.length}</span></div><div class="agenda-list">
      {#each agenda as item}
        {@const due = new Date(item.dueDate)}
        <button class="agenda-item" onclick={() => openCalendarItem(item.courseId, item.title).catch(reportError)}><span class="agenda-date">{new Intl.DateTimeFormat("en", { month: "short" }).format(due)}<strong>{due.getDate()}</strong></span><span class="agenda-info"><strong>{item.title}</strong><small>{item.courseCode} · {formatDate(item.dueDate, { time: true })} · {titleCase(item.status)}</small></span></button>
      {:else}<EmptyState icon="calendar-check" title="No upcoming items" copy="No future due dates are present in the local archive." />{/each}
    </div></aside>
  </div>
</div>
