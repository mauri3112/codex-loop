import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Blocks, MonitorCog, Sparkles } from "lucide-react";
import { api } from "../../api/client";
import type { TaskCapability, TaskCapabilityKind } from "../../domain/task-capabilities";
import { applyTaskCapability, filterTaskCapabilities, findSlashQuery, type SlashQuery } from "./slash-autocomplete";

const groupLabels: Record<TaskCapabilityKind, string> = {
  "computer-use": "Computer use",
  skill: "Skills",
  mcp: "MCP servers",
  app: "Apps",
  cli: "Command-line tools",
  shell: "Shell",
};

const groupOrder: TaskCapabilityKind[] = ["computer-use", "skill", "mcp", "app", "cli", "shell"];

function CapabilityIcon({ kind }: { kind: TaskCapabilityKind }) {
  if (kind === "computer-use") return <MonitorCog size={14} aria-hidden="true" />;
  if (["mcp", "app", "cli", "shell"].includes(kind)) return <Blocks size={14} aria-hidden="true" />;
  return <Sparkles size={14} aria-hidden="true" />;
}

export function SlashAutocompleteTextArea({ value, onChange, rows = 5, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const listboxId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [slashQuery, setSlashQuery] = useState<SlashQuery | null>(null);
  const [capabilities, setCapabilities] = useState<TaskCapability[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const open = focused && slashQuery !== null;
  const filtered = useMemo(() => slashQuery && capabilities ? filterTaskCapabilities(capabilities, slashQuery.query) : [], [capabilities, slashQuery]);

  useEffect(() => {
    if (!open || capabilities) return;
    let active = true;
    setLoadError("");
    void api.taskCapabilities()
      .then((response) => { if (active) setCapabilities(response.items); })
      .catch((reason) => { if (active) setLoadError(reason instanceof Error ? reason.message : "Could not load Codex capabilities"); });
    return () => { active = false; };
  }, [capabilities, open]);

  useEffect(() => setActiveIndex(0), [slashQuery?.query, capabilities]);

  const updateQuery = (nextValue: string, caret: number | null) => {
    setSlashQuery(caret === null ? null : findSlashQuery(nextValue, caret));
  };

  const choose = (item: TaskCapability) => {
    if (!slashQuery) return;
    const next = applyTaskCapability(value, slashQuery, item);
    onChange(next.value);
    setSlashQuery(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setSlashQuery(null);
      return;
    }
    if (!filtered.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + filtered.length) % filtered.length);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choose(filtered[activeIndex] ?? filtered[0]);
    }
  };

  return (
    <div className="loop-slash-composer">
      <textarea
        ref={textareaRef}
        aria-label="Task"
        aria-autocomplete="list"
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-activedescendant={open && filtered[activeIndex] ? `${listboxId}-${filtered[activeIndex].id}` : undefined}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onFocus={(event) => { setFocused(true); updateQuery(event.currentTarget.value, event.currentTarget.selectionStart); }}
        onBlur={() => setFocused(false)}
        onClick={(event) => updateQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
        onSelect={(event) => updateQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
        onChange={(event) => {
          const nextValue = event.target.value;
          onChange(nextValue);
          updateQuery(nextValue, event.target.selectionStart);
        }}
        onKeyDown={handleKeyDown}
      />
      {open ? (
        <div className="loop-slash-menu" id={listboxId} role="listbox" aria-label="Task capabilities">
          {capabilities === null && !loadError ? <p className="loop-slash-state">Loading Codex capabilities…</p> : null}
          {loadError ? <p className="loop-slash-state is-error">{loadError}</p> : null}
          {capabilities && filtered.length === 0 ? <p className="loop-slash-state">No capabilities match “{slashQuery.query}”.</p> : null}
          {groupOrder.map((kind) => {
            const group = filtered.filter((item) => item.kind === kind);
            if (!group.length) return null;
            return (
              <section className="loop-slash-group" key={kind} aria-label={groupLabels[kind]}>
                <header>{groupLabels[kind]}</header>
                {group.map((item) => {
                  const index = filtered.indexOf(item);
                  return (
                    <button
                      id={`${listboxId}-${item.id}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      className={index === activeIndex ? "is-active" : ""}
                      key={item.id}
                      onMouseEnter={() => setActiveIndex(index)}
                      onMouseDown={(event) => { event.preventDefault(); choose(item); }}
                    >
                      <span className={`loop-slash-icon kind-${kind}`}><CapabilityIcon kind={kind} /></span>
                      <span className="loop-slash-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
                      <code>{item.invocation.trim()}</code>
                    </button>
                  );
                })}
              </section>
            );
          })}
          {filtered.length ? <footer><span>↑↓ Navigate</span><span>↵ Select</span><span>esc Close</span></footer> : null}
        </div>
      ) : null}
    </div>
  );
}
