// Standalone check of the cleanup algorithm in
// src/lib/revoice/cleanTranscript.ts (same rules, plain JS so it
// runs with plain `node` and no build step). This file is OURS,
// not Recordly code — safe to run here.
const FILLER_RE = /\b(um+|uh+|er+|erm+|ah+|hmm+)\b/gi;
function countWords(t) { return t.trim() ? t.trim().split(/\s+/).length : 0; }
function dropRepeats(text) {
  return text.replace(/\b(\w+)(\s+\1\b)+/gi, (_m, w) => w);
}
function tidy(text) {
  let out = text.replace(/\s+([,.!?;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
  if (out && !/[.!?]$/.test(out)) out += ".";
  return out.replace(/(^\s*\w|[.!?]\s+\w)/g, (c) => c.toUpperCase());
}
function clean(raw) {
  let text = raw.trim();
  for (const f of ["you know", "i mean", "sort of", "kind of", "okay so", "so yeah"]) {
    text = text.replace(new RegExp(`\\b${f}\\b[,]?`, "gi"), "");
  }
  text = text.replace(FILLER_RE, "");
  text = text.replace(/,\s*like\s*,/gi, ",");
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/,\s*,/g, ",").replace(/^[,\s]+/, "").replace(/,\s*$/, "");
  text = text.replace(/^so\s+/i, "");
  text = text.replace(/,\s*so\s*,/gi, ",").replace(/,\s*,/g, ",");
  text = text.replace(/\s+/g, " ").trim().replace(/^[,\s]+/, "");
  text = dropRepeats(text);
  text = text.replace(/\.{3,}/g, ",").replace(/\s+,/g, ",");
  return tidy(text);
}
const cases = [
  ["Um, so uh, click the record button.", "Click the record button."],
  ["I I want to to show you the the timeline.", "I want to show you the timeline."],
  ["You know, it sort of just works.", "It just works."],
  ["Um, open Recordly 2.0 and press Cmd Shift 5.", "Open Recordly 2.0 and press Cmd Shift 5."],
];
let pass = 0;
for (const [input, expected] of cases) {
  const got = clean(input);
  const ok = got === expected;
  console.log(ok ? "PASS" : "FAIL", JSON.stringify(input), "=>", JSON.stringify(got), ok ? "" : `(expected ${JSON.stringify(expected)})`);
  if (ok) pass += 1;
}
console.log(`${pass}/${cases.length} cleanup cases passed`);
if (pass !== cases.length) process.exit(1);
