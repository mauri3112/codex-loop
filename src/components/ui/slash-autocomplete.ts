import type { TaskCapability, TaskCapabilityKind } from "../../domain/task-capabilities";

export interface SlashQuery {
  start: number;
  end: number;
  query: string;
}

const kindOrder: Record<TaskCapabilityKind, number> = {
  "computer-use": 0,
  skill: 1,
  mcp: 2,
};

export function findSlashQuery(value: string, caret: number): SlashQuery | null {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)\/([^\s/]*)$/);
  if (!match) return null;
  const query = match[1] ?? "";
  return { start: caret - query.length - 1, end: caret, query };
}

export function filterTaskCapabilities(items: TaskCapability[], query: string): TaskCapability[] {
  const normalized = query.trim().toLocaleLowerCase();
  return [...items.filter((item) => !normalized || `${item.label} ${item.description} ${item.kind}`.toLocaleLowerCase().includes(normalized))]
    .sort((left, right) => kindOrder[left.kind] - kindOrder[right.kind] || left.label.localeCompare(right.label));
}

export function applyTaskCapability(value: string, slashQuery: SlashQuery, item: TaskCapability): { value: string; caret: number } {
  const nextValue = `${value.slice(0, slashQuery.start)}${item.invocation}${value.slice(slashQuery.end)}`;
  return { value: nextValue, caret: slashQuery.start + item.invocation.length };
}
