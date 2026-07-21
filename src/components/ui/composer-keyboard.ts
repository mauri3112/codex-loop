interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export function shouldSubmitComposer(event: ComposerKeyEvent): boolean {
  return event.key === "Enter"
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey;
}
