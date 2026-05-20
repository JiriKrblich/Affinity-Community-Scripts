// SMART QUOTES CONVERTER v4
// Converts " and ' to typographic smart quotes throughout the document.
//
// Approach:
// - Reads each character individually via getText(pos, 1) to avoid stale bulk-read cache
// - After replacing each frame, re-scans and retries up to 5 passes to catch edge cases
// - Processes replacements in reverse order to preserve story positions
//
// IMPORTANT: Run only once on a document with straight quotes.
// Do NOT run on a document that already has smart quotes — it will double them.

const { Document } = require("/document");
const Nodes = require("/nodes");
const { Selection, TextSelection } = require("/selections");
const Commands = require("/commands");

const doc = Document.current;
const root = doc.rootNode;

const OPEN_BEFORE = new Set([
  " ",
  "\n",
  "\r",
  "\t",
  "(",
  "[",
  "{",
  "\u2014",
  "\u2013",
  "-",
  "\u201C",
  "\u2018",
  "\u00AB",
]);

function isOpening(prevChar) {
  return !prevChar || OPEN_BEFORE.has(prevChar);
}

function replaceInFrame(typed) {
  const si = typed.storyInterface;
  const range = si.storyRange;
  if (range.end <= range.begin) return 0;

  const story = si.story;
  let replaced = 0;
  let maxPasses = 5;

  while (maxPasses-- > 0) {
    const replacements = [];
    for (let storyPos = range.begin; storyPos < range.end; storyPos++) {
      const ch = story.getText(storyPos, 1);
      if (ch === '"' || ch === "'") {
        const prevCh =
          storyPos > range.begin ? story.getText(storyPos - 1, 1) : "";
        const r =
          ch === '"'
            ? isOpening(prevCh)
              ? "\u201C"
              : "\u201D"
            : isOpening(prevCh)
              ? "\u2018"
              : "\u2019";
        replacements.push({ storyPos, r });
      }
    }

    if (replacements.length === 0) break;

    for (let i = replacements.length - 1; i >= 0; i--) {
      const { storyPos, r } = replacements[i];
      const sel = Selection.create(doc, typed);
      const ts = TextSelection.create([{ begin: storyPos, end: storyPos + 1 }]);
      sel.addSubSelectionForNode(typed, ts);
      doc.executeCommand(Commands.DocumentCommand.createSetText(sel, r));
      replaced++;
    }
  }

  return replaced;
}

let totalReplaced = 0;
let spreadIndex = 0;

for (const spreadNode of Nodes.getNodeChildren(
  root.handle,
  Nodes.NodeChildType.Main,
  false,
)) {
  let needsSpreadSwitch = true;

  for (const child of Nodes.getNodeChildrenRecursive(
    spreadNode.handle,
    Nodes.NodeChildType.Main,
    false,
  )) {
    const typed = Nodes.createTypedNode(child.handle);
    if (!typed || !typed.storyInterface) continue;
    const si = typed.storyInterface;
    const range = si.storyRange;
    if (range.end <= range.begin) continue;

    // Quick check — skip frames with no straight quotes
    let hasQuotes = false;
    for (let p = range.begin; p < range.end; p++) {
      const ch = si.story.getText(p, 1);
      if (ch === '"' || ch === "'") {
        hasQuotes = true;
        break;
      }
    }
    if (!hasQuotes) continue;

    if (needsSpreadSwitch) {
      doc.executeCommand(
        Commands.DocumentCommand.createSetCurrentSpread(spreadNode),
      );
      needsSpreadSwitch = false;
    }

    totalReplaced += replaceInFrame(typed);
  }
  spreadIndex++;
}

console.log(
  "Smart quotes done: " +
    totalReplaced +
    " replacements across " +
    spreadIndex +
    " spreads.",
);
