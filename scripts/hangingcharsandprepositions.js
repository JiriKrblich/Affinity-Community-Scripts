/**

name: Hanging chars and prepositions
description: Replaces spaces after lone single characters or prepositions with non-breaking spaces (for slavic languages). Based on initial script by JiriKrblich
version: 1.0.0
author: nodeus
*/

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

// Строгие списки предлогов для русского и английского языков
const PREPOSITIONS_2 = new Set([
// Русские 2-буквенные предлоги
'во','на','не','ни','об','от','по','до','за','из','со','ко','ну','уж','вы',
// Английские 2-буквенные предлоги
'in','on','at','to','by','up','of','if','no','or','as','an','be','is','it',
'we','us','my','me','he','do','go','so','if','am'
]);

const PREPOSITIONS_3 = new Set([
// Русские 3-буквенные предлоги
'под','при','про','для','без','над','обо','изо','ото','меж',
// Английские 3-буквенные предлоги
'the','and','for','but','not','are','you','all','can','had','her','was',
'one','our','out','day','get','has','him','his','how','its','may','new',
'now','old','see','two','who','boy','did','she','use','her','way','many',
'oil','sit'
]);

function findOrphanSpacePositions(text) {
const positions = [];

// Паттерн 1: висячие буквы (одиночные символы перед пробелом)
const re1 = /(^|[ \t\n\r])(\S) (?=\S)/gm;
let m;
while ((m = re1.exec(text)) !== null) {
const spacePos = m.index + m[1].length + 1;
positions.push(spacePos);
re1.lastIndex = m.index + m[1].length + 1;
}

// Паттерн 2: 2-буквенные предлоги — проверяем по строгому списку
const re2 = /(^|[ \t\n\r])([a-zа-яё]{2}) (?=[a-zа-яё])/gim;
while ((m = re2.exec(text)) !== null) {
const word = m[2].toLowerCase();
if (PREPOSITIONS_2.has(word)) {
const spacePos = m.index + m[1].length + 2;
positions.push(spacePos);
}
re2.lastIndex = m.index + m[1].length + 2;
}

// Паттерн 3: 3-буквенные предлоги — проверяем по строгому списку
const re3 = /(^|[ \t\n\r])([a-zа-яё]{3}) (?=[a-zа-яё])/gim;
while ((m = re3.exec(text)) !== null) {
const word = m[2].toLowerCase();
if (PREPOSITIONS_3.has(word)) {
const spacePos = m.index + m[1].length + 3;
positions.push(spacePos);
}
re3.lastIndex = m.index + m[1].length + 3;
}

// Удалить дубликаты и отсортировать по возрастанию
return [...new Set(positions)].sort((a, b) => a - b);
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
msg = Fixed ${totalChanged} of ${totalNodes} text field(s).\n\nAll changes can be undone with Ctrl+Z.;
} else if (totalNodes > 0) {
msg = Checked ${totalNodes} text field(s).\n\nEverything already looks correct.;
} else {
msg = 'No text fields found.';
}
if (errors.length) msg += '\n\nErrors: ' + errors.join('; ');

showMessage(msg);