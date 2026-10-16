<script lang="ts">
  import { tick } from "svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import Icon from "../components/Icon.svelte";
  import { appState, changeState, openCalendarItem, reportError } from "../lib/controller";
  import { dateKey, formatDate, titleCase } from "../lib/format";

  type CalendarItem = { dueDate: string; status: string; courseId: string; courseCode: string; title: string };
  const todayKey = dateKey(new Date());
  const agendaPageSize = 12;
  let selectedDay = todayKey;
  let agendaScope: "upcoming" | "overdue" | "all" = "upcoming";
  let agendaLimit = agendaPageSize;
  let selectedDayHeading: HTMLHeadingElement;

  $: deadlines = ($appState.bootstrap!.summary.deadlines as CalendarItem[])
    .filter((item) => Number.isFinite(new Date(item.dueDate).valueOf()))
    .slice().sort((left, right) => new Date(left.dueDate).valueOf() - new Date(right.dueDate).valueOf());
  $: cursor = new Date($appState.calendarCursor.getFullYear(), $appState.calendarCursor.getMonth(), 1);
  $: monthName = new Intl.DateTimeFormat("en-HK", { month: "long", year: "numeric" }).format(cursor);
  $: gridStart = (() => { const date = new Date(cursor); date.setDate(1 - date.getDay()); return date; })();
  $: eventsByDay = deadlines.reduce((map, item) => {
    const key = dateKey(item.dueDate);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
    return map;
  }, new Map<string, CalendarItem[]>());
  $: days = Array.from({ length: 42 }, (_, index) => { const date = new Date(gridStart); date.setDate(gridStart.getDate() + index); return { date, key: dateKey(date), events: eventsByDay.get(dateKey(date)) || [] }; });
  $: selectedEvents = eventsByDay.get(selectedDay) || [];
  $: selectedDateLabel = dayLabel(new Date(`${selectedDay}T12:00:00`));
  $: agenda = deadlines.filter((item) => agendaScope === "all" || (agendaScope === "overdue" ? isOverdue(item) : new Date(item.dueDate).valueOf() >= Date.now()));
  $: agendaHeading = agendaScope === "all" ? "All archived dates" : agendaScope === "overdue" ? "Overdue" : "Upcoming";

  function dayLabel(date: Date) {
    return new Intl.DateTimeFormat("en-HK", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
  }

  function isOverdue(item: CalendarItem) {
    return new Date(item.dueDate).valueOf() < Date.now() && !/^(graded|submitted|complete|completed)$/i.test(item.status || "");
  }

  async function selectDay(key: string, focusDetails = false) {
    selectedDay = key;
    if (focusDetails) {
      await tick();
      selectedDayHeading?.focus({ preventScroll: true });
      selectedDayHeading?.scrollIntoView({ block: "nearest" });
    }
  }

  function moveMonth(offset: number) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + offset, 1);
    selectedDay = dateKey(next);
    changeState((state) => state.calendarCursor = next);
  }

  function goToToday() {
    selectedDay = dateKey(new Date());
    changeState((state) => state.calendarCursor = new Date());
  }
</script>

<div class="page">
  <header class="page-header"><div><span class="eyebrow">Across archived courses</span><h1>Calendar</h1><p>Due dates from every locally fetched course in one schedule.</p></div><div class="page-actions"><button class="button secondary" onclick={goToToday}><Icon name="calendar-check" /><span>Today</span></button></div></header>
  <div class="calendar-layout">
    <section class="calendar-shell" aria-label="Month calendar">
      <header class="calendar-header"><h2 aria-live="polite">{monthName}</h2><div class="calendar-controls"><button class="icon-button" onclick={() => moveMonth(-1)} title="Previous month" aria-label="Previous month"><Icon name="chevron-left" /></button><button class="icon-button" onclick={() => moveMonth(1)} title="Next month" aria-label="Next month"><Icon name="chevron-right" /></button></div></header>
      <p class="calendar-hint">Choose a day to see every saved item.</p>
      <div class="calendar-grid">
        {#each ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as day}<div class="calendar-weekday">{day}</div>{/each}
        {#each days as day}
          <div class="calendar-day" class:other-month={day.date.getMonth() !== cursor.getMonth()} class:today={day.key === todayKey} class:selected={day.key === selectedDay}>
            <button class="day-number" aria-label={`${dayLabel(day.date)}, ${day.events.length} saved items`} aria-pressed={day.key === selectedDay} aria-controls="calendar-day-details" onclick={() => selectDay(day.key)}>{day.date.getDate()}</button>
            {#each day.events.slice(0, 3) as item}
              <button class="calendar-event" class:overdue={isOverdue(item)} onclick={() => openCalendarItem(item.courseId, item.title).catch(reportError)} title={item.title}>{item.courseCode} · {item.title}</button>
            {/each}
            {#if day.events.length > 3}<button class="calendar-more" aria-label={`Show all ${day.events.length} items for ${dayLabel(day.date)}`} aria-controls="calendar-day-details" aria-expanded={day.key === selectedDay} onclick={() => selectDay(day.key, true)}>+{day.events.length - 3} more</button>{/if}
            {#if day.events.length}<button class="calendar-day-count" aria-label={`Show all ${day.events.length} items for ${dayLabel(day.date)}`} aria-controls="calendar-day-details" onclick={() => selectDay(day.key, true)}>{day.events.length} {day.events.length === 1 ? "item" : "items"}</button>{/if}
          </div>
        {/each}
      </div>
    </section>
    <div class="calendar-agenda">
      <section id="calendar-day-details" class="section-block selected-day-details" aria-labelledby="selected-day-heading">
        <div class="section-heading"><div><span class="eyebrow">Selected day</span><h2 bind:this={selectedDayHeading} id="selected-day-heading" tabindex="-1">{selectedDateLabel}</h2></div><span class="badge neutral">{selectedEvents.length}</span></div>
        <div class="agenda-list">
          {#each selectedEvents as item}
            <button class="selected-day-item" onclick={() => openCalendarItem(item.courseId, item.title).catch(reportError)}><strong>{item.title}</strong><small>{item.courseCode} · {formatDate(item.dueDate, { time: true })}</small><span class:overdue-label={isOverdue(item)}>{isOverdue(item) ? "Overdue" : titleCase(item.status || "Scheduled")}</span></button>
          {:else}<p class="calendar-empty-day">No saved items for this day.</p>{/each}
        </div>
      </section>
      <section class="section-block" aria-labelledby="calendar-agenda-heading">
        <div class="section-heading"><h2 id="calendar-agenda-heading">{agendaHeading}</h2><span class="badge neutral">{agenda.length}</span></div>
        <label class="calendar-agenda-filter" for="calendar-agenda-scope">Agenda range<select id="calendar-agenda-scope" class="select" bind:value={agendaScope} onchange={() => agendaLimit = agendaPageSize}><option value="upcoming">Upcoming</option><option value="overdue">Overdue</option><option value="all">All archived dates</option></select></label>
        <div class="agenda-list">
          {#each agenda.slice(0, agendaLimit) as item}
            {@const due = new Date(item.dueDate)}
            <button class="agenda-item" onclick={() => openCalendarItem(item.courseId, item.title).catch(reportError)}><span class="agenda-date">{new Intl.DateTimeFormat("en", { month: "short" }).format(due)}<strong>{due.getDate()}</strong></span><span class="agenda-info"><strong>{item.title}</strong><small>{item.courseCode} · {formatDate(item.dueDate, { time: true })} · {isOverdue(item) ? "Overdue" : titleCase(item.status || "Scheduled")}</small></span></button>
          {:else}<EmptyState icon="calendar-check" title={agendaScope === "overdue" ? "No overdue items" : agendaScope === "all" ? "No saved dates" : "No upcoming items"} copy={agendaScope === "overdue" ? "No past due items with an unfinished status are present in the local archive." : agendaScope === "all" ? "Fetch your courses to save their due dates here." : "No future due dates are present in the local archive."} />{/each}
        </div>
        {#if agenda.length}<div class="agenda-pagination"><span role="status">Showing {Math.min(agendaLimit, agenda.length)} of {agenda.length} items</span>{#if agendaLimit < agenda.length}<button class="button secondary" onclick={() => agendaLimit += agendaPageSize}>Show {Math.min(agendaPageSize, agenda.length - agendaLimit)} more</button>{/if}</div>{/if}
      </section>
    </div>
  </div>
</div>
