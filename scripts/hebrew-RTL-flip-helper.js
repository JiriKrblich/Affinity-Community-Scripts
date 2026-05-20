/**
name: Hebrew RTL Flip Helper
description: Reverses Hebrew word order, letters, or both in all text fields.
version: 1.4.0
author: David + ChatGPT
*/

"use strict";

const { Document } = require("/document");
const { Selection, TextSelection } = require("/selections");
const { Dialog, DialogResult } = require("/dialog");
const { DocumentCommand } = require("/commands");

const doc = Document.current;

function showMessage(msg) {
  const dlg = Dialog.create("Hebrew RTL Flip Helper");
  dlg.addColumn().addGroup("").addStaticText("", msg);
  dlg.show();
}

if (!doc) {
  showMessage("Error: No document is open.");
  return;
}

function chooseMode() {
  const dlg = Dialog.create("Hebrew RTL Flip Helper");
  dlg.initialWidth = 460;

  const col = dlg.addColumn();
  const group = col.addGroup("Choose mode");

  dlg.mode = group.addButtonSet(
    "Flip",
    ["Words only", "Letters only", "Both"],
    2,
  );

  if (!dlg.runModal().equals(DialogResult.Ok)) {
    return null;
  }

  if (dlg.mode.selectedIndex === 0) return "words";
  if (dlg.mode.selectedIndex === 1) return "letters";
  return "both";
}

const MODE = chooseMode();

if (!MODE) {
  return;
}

function splitLinesKeepBreaks(text) {
  return text.split(/(\r\n|\n|\r)/);
}

function reverseWordsInLine(line) {
  return line.split(/(\s+)/).reverse().join("");
}

function reverseLettersPreserveHebrewMarks(word) {
  const units = [];
  const chars = Array.from(word);

  for (let i = 0; i < chars.length; i++) {
    let unit = chars[i];

    while (i + 1 < chars.length && /[\u0591-\u05C7]/.test(chars[i + 1])) {
      unit += chars[i + 1];
      i++;
    }

    units.push(unit);
  }

  return units.reverse().join("");
}

function reverseLettersInWords(line) {
  return line.replace(/\S+/g, (word) =>
    reverseLettersPreserveHebrewMarks(word),
  );
}

function fixLine(line) {
  if (MODE === "words") return reverseWordsInLine(line);
  if (MODE === "letters") return reverseLettersInWords(line);
  if (MODE === "both") return reverseLettersInWords(reverseWordsInLine(line));
  return line;
}

function fixRTL(text) {
  return splitLinesKeepBreaks(text)
    .map((part) => {
      if (part === "\r\n" || part === "\n" || part === "\r") return part;
      return fixLine(part);
    })
    .join("");
}

function replaceWholeStoryText(node, fixedText) {
  const si = node.storyInterface;
  const range = si.storyRange;

  const sel = Selection.create(doc, node);

  const textSel = TextSelection.create([
    {
      begin: range.begin,
      end: range.end,
    },
  ]);

  sel.addSubSelectionForNode(node, textSel);

  const cmd = DocumentCommand.createSetText(sel, fixedText);
  doc.executeCommand(cmd);
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

          const originalText = story.getText(
            range.begin,
            range.end - range.begin,
          );

          if (originalText && originalText.trim()) {
            totalNodes++;

            const fixedText = fixRTL(originalText);

            if (fixedText !== originalText) {
              replaceWholeStoryText(node, fixedText);
              totalChanged++;
            }
          }
        } catch (e) {
          errors.push(e.message || String(e));
        }
      }

      try {
        for (const c of node.children) {
          stack.push(c);
        }
      } catch (e) {}
    }
  }
}

let msg;

if (totalChanged > 0) {
  msg = `Fixed ${totalChanged} of ${totalNodes} text field(s).

Mode used: ${MODE}

All changes can be undone with Ctrl+Z.`;
} else if (totalNodes > 0) {
  msg = `Checked ${totalNodes} text field(s).

No changes were needed.`;
} else {
  msg = "No text fields found.";
}

if (errors.length) {
  msg += "\n\nErrors: " + errors.join("; ");
}

showMessage(msg);
