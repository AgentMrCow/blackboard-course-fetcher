<script lang="ts">
  import { colorFor, initials } from "../lib/format";
  import type { Course } from "../lib/types";

  export let course: Pick<Course, "id" | "code" | "name">;
</script>

<span class="course-avatar {colorFor(course.id)}">{initials(course.code || course.name)}</span>
