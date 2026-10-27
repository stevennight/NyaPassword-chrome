import { describe, expect, it } from 'vitest';
import { closeTarget, replacedSaves } from './prompts';

describe('closing a prompt', () => {
  it('goes to the frame that shows it', () => {
    expect(closeTarget({ tabId: 3, frameId: 0 }, 3)).toEqual({ tabId: 3, frameId: 0 });
    expect(closeTarget({ tabId: 3, frameId: 7 }, 3)).toEqual({ tabId: 3, frameId: 7 });
  });

  it('its context gone (e.g. a locked prompt left open): every frame of the iframe’s tab', () => {
    expect(closeTarget(undefined, 5)).toEqual({ tabId: 5 });
  });

  it('nowhere without a context or a tab', () => {
    expect(closeTarget(undefined, undefined)).toBeNull();
  });
});

describe('a newer save offer', () => {
  it('replaces the save offers of the same tab only', () => {
    const contexts = new Map([
      ['a', { kind: 'save', tabId: 1 }],
      ['b', { kind: 'fill', tabId: 1 }],
      ['c', { kind: 'passkey', tabId: 1 }],
      ['d', { kind: 'save', tabId: 2 }],
      ['e', { kind: 'save', tabId: 1 }],
    ]);
    expect(replacedSaves(contexts, 1)).toEqual(['a', 'e']);
    expect(replacedSaves(contexts, 9)).toEqual([]);
  });
});
