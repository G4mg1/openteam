// Splits model output into "thinking" and "answer" parts.
// Works on streamed chunks, so a <thinking> tag split across two chunks is still caught.

const OPEN = '<thinking>';
const CLOSE = '</thinking>';

// How many trailing chars could be the start of `tag`? Hold them back until we know.
function partialTail(s, tag) {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
    if (s.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

export function createThinkSplitter() {
  let buf = '';
  let inThink = false;

  const drain = (emit, final) => {
    while (true) {
      const tag = inThink ? CLOSE : OPEN;
      const kind = inThink ? 'thinking' : 'answer';
      const i = buf.indexOf(tag);
      if (i !== -1) {
        if (i > 0) emit(kind, buf.slice(0, i));
        buf = buf.slice(i + tag.length);
        inThink = !inThink;
        continue;
      }
      const hold = final ? 0 : partialTail(buf, tag);
      const out = buf.length - hold;
      if (out > 0) emit(kind, buf.slice(0, out));
      buf = buf.slice(out);
      return;
    }
  };

  return {
    push(delta, emit) { buf += delta; drain(emit, false); },
    flush(emit) { drain(emit, true); },
  };
}

// Whole-string version, for non-streamed replies.
export function splitFull(text) {
  let thinking = '';
  let answer = '';
  const sink = (kind, t) => { if (kind === 'thinking') thinking += t; else answer += t; };
  const sp = createThinkSplitter();
  sp.push(String(text || ''), sink);
  sp.flush(sink);
  return { thinking: thinking.trim(), answer: answer.trim() };
}

// Reasoning models send thinking in a separate field.
export function reasoningFromDelta(delta) {
  return String(delta?.reasoning_content || delta?.reasoning || '');
}

export function contentFromDelta(delta) {
  const c = delta?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : (p?.text || ''))).join('');
  return '';
}
