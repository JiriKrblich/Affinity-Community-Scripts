'use strict';
const { Document } = require('/document');
const { Selection, TextSelection } = require('/selections');
const { Dialog } = require('/dialog');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');

const doc = Document.current;

function showMessage(msg) {
  const dlg = Dialog.create('No-Orphan Fix');
  dlg.addColumn().addGroup('').addStaticText('', msg);
  dlg.show();
}

if (!doc) { showMessage('Error: No document is open.'); return; }

const NBSP = '\u00A0';

function findOrphanSpacePositions(text) {
  const positions = [];
  const re = /(^|[ \t\n\r])(\S) (?=\S)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const spacePos = m.index + m[1].length + 1;
    positions.push(spacePos);
    re.lastIndex = m.index + m[1].length + 1;
  }
  return positions;
}

let totalNodes = 0;
let totalChanged = 0;
const errors = [];

for (const spread of doc.spreads) {
  for (const child of spread.children) {
    const stack = [child];
    while (stack.length > 0) {
      const node = stack.pop();

      if (node.isTextNode) {
        try {
          const si = node.storyInterface;
          const story = si.story;
          const range = si.storyRange;
          const originalText = story.getText(range.begin, range.end - range.begin);

          if (originalText && originalText.trim()) {
            const positions = findOrphanSpacePositions(originalText);

            if (positions.length > 0) {
              const compound = CompoundCommandBuilder.create();

              for (const pos of positions) {
                const storyPos = range.begin + pos;
                const textSel = TextSelection.create([{ begin: storyPos, end: storyPos + 1 }]);
                const sel = Selection.create(doc, node);
                sel.addSubSelectionForNode(node, textSel);
                compound.addCommand(DocumentCommand.createSetText(sel, NBSP));
              }

              doc.executeCommand(compound.createCommand());
              totalChanged++;
            }
            totalNodes++;
          }
        } catch (e) {
          errors.push(e.message);
        }
      }

      try { for (const c of node.children) stack.push(c); } catch (e) {}
    }
  }
}

let msg;
if (totalChanged > 0) {
  msg = `Fixed ${totalChanged} of ${totalNodes} text field(s).\n\nAll changes can be undone with Ctrl+Z.`;
} else if (totalNodes > 0) {
  msg = `Checked ${totalNodes} text field(s).\n\nEverything already looks correct.`;
} else {
  msg = 'No text fields found.';
}
if (errors.length) msg += '\n\nErrors: ' + errors.join('; ');

showMessage(msg);
