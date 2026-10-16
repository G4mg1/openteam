/* Thinking-tag splitter used by both the streaming path (server -> browser)
   and the tool loop (server -> tools). Keeps <thinking>…</thinking> content
   separate from the answer so the UI can render it as a status pill only. */

export function createThinkSplitter() {
  let buf = '';
  let inThink = false;
  let seenThinkOpen = false;
  const OPEN = '<thinking>';
  const CLOSE = '</thinking>';

  const scan = (emit) => {
    while (buf.length) {
      if (!inThink) {
        const i = buf.indexOf(OPEN);
        if (i === -1) {
          // Emit safe prefix, keep last few chars in case an open tag is split.
          const keep = Math.max(0, buf.length - OPEN.length + 1);
          if (keep > 0) emit('answer', buf.slice(0, keep));
          buf = buf.slice(keep);
          break;
        }
        if (i > 0) emit('answer', buf.slice(0, i));
        buf = buf.slice(i + OPEN.length);
        inThink = true;
        seenThinkOpen = true;
      } else {
        const j = buf.indexOf(CLOSE);
        if (j === -1) {
          const keep = Math.max(0, buf.length - CLOSE.length + 1);
          if (keep > 0) emit('thinking', buf.slice(0, keep));
          buf = buf.slice(keep);
          break;
        }
        if (j > 0) emit('thinking', buf.slice(0, j));
        buf = buf.slice(j + CLOSE.length);
        inThink = false;
      }
    }
  };

  return {
    push(chunk, emit) { buf += chunk; scan(emit); },
    flush(emit) {
      if (!buf) return;
      if (inThink) emit('thinking', buf);
      else emit('answer', buf);
      buf = '';
    },
    hasSeenThink() { return seenThinkOpen; },
  };
}

/* Reasoning fields from providers (OpenRouter-style). */
export function reasoningFromDelta(delta) {
  if (!delta || typeof delta !== 'object') return '';
  return String(delta.reasoning_content || delta.reasoning || '');
}

/* Answer content from delta. */
export function contentFromDelta(delta) {
  if (!delta || typeof delta !== 'object') return '';
  let c = delta.content;
  if (Array.isArray(c)) c = c.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('');
  return String(c || '');
}

/* Split a complete string into { thinking, answer }. */
export function splitFull(text) {
  const s = String(text || '');
  const open = s.indexOf('<thinking>');
  if (open === -1) return { thinking: '', answer: s };
  const close = s.indexOf('</thinking>', open);
  if (close === -1) return { thinking: s.slice(open + 10), answer: s.slice(0, open) };
  return { thinking: s.slice(open + 10, close), answer: s.slice(0, open) + s.slice(close + 11) };
}
