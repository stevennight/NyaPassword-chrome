// Filling inputs in a way frameworks (React, Vue, Angular) notice.

const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

export function setValue(el: HTMLInputElement, value: string) {
  el.focus({ preventScroll: true });
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  // React tracks the value through the prototype setter
  if (valueSetter) valueSetter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
  el.blur();
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
}
