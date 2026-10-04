// Clears the clipboard 90 s after a secret was copied (MV3 service workers have no clipboard).
chrome.runtime.onMessage.addListener((msg: { t: string }) => {
  if (msg.t !== 'offscreen:clear') return false;
  const ta = document.createElement('textarea');
  document.body.appendChild(ta);
  ta.select();
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', '');
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  document.execCommand('copy');
  document.removeEventListener('copy', onCopy);
  ta.remove();
  return false;
});
