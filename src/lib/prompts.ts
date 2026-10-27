// Closing the prompts / menus the content scripts show (`close` messages).

/** A context's tab and the frame that shows its iframe. */
export interface Shown {
  tabId: number;
  frameId: number;
}

/**
 * Where a `close` for a prompt / menu goes: the frame that shows it, or, its
 * context gone (expired, already answered, the service worker lost it), every
 * frame of the tab the iframe is in, so 取消 always closes it.
 */
export function closeTarget(shown: Shown | undefined, senderTab: number | undefined): { tabId: number; frameId?: number } | null {
  if (shown) return { tabId: shown.tabId, frameId: shown.frameId };
  return senderTab === undefined ? null : { tabId: senderTab };
}

/** The save offers on a tab that a newer one replaces, so save prompts never stack (only the latest login is offered). */
export function replacedSaves(contexts: Iterable<[string, { kind: string; tabId: number }]>, tabId: number): string[] {
  const out: string[] = [];
  for (const [n, c] of contexts) if (c.kind === 'save' && c.tabId === tabId) out.push(n);
  return out;
}
