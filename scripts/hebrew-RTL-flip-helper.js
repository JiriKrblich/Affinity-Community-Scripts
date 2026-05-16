"use strict";

const { Document } = require("/document");
const { Selection, TextSelection } = require("/selections");
const { Dialog } = require("/dialog");
const { DocumentCommand } = require("/commands");

const doc = Document.current;

if (!doc) {
  const dlg = Dialog.create("Hebrew RTL Flip Helper");
  dlg.addColumn().addGroup("").addStaticText("", "No document is open.");
  dlg.show();
  return;
}

/* -------------------- RTL FUNCTIONS -------------------- */

function reverseWords(text) {
  return text.split(/(\s+)/).reverse().join("");
}

function reverseLettersInWords(text) {
  return text.replace(/\S+/g, (word) => [...word].reverse().join(""));
}

function fixRTL(text, mode) {
  if (mode === "words") {
    return reverseWords(text);
  }

  if (mode === "letters") {
    return reverseLettersInWords(text);
  }

  if (mode === "both") {
    return reverseLettersInWords(reverseWords(text));
  }

  return text;
}

/* -------------------- DIALOG -------------------- */

const dlg = Dialog.create("Hebrew RTL Flip Helper");

const col = dlg.addColumn();

col.addStaticText("", "Choose RTL Fix Mode");

const modeDropdown = col.addDropdown(
  "",
  ["Reverse Words", "Reverse Letters", "Reverse Both"],
  2, // default = Both
);

const result = dlg.show();

if (!result) {
  return;
}

/* -------------------- MODE SELECTION -------------------- */

let MODE = "both";

switch (modeDropdown.value) {
  case 0:
    MODE = "words";
    break;

  case 1:
    MODE = "letters";
    break;

  case 2:
    MODE = "both";
    break;
}

/* -------------------- PROCESS TEXT -------------------- */

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

            const fixedText = fixRTL(originalText, MODE);

            if (fixedText !== originalText) {
              replaceWholeStoryText(node, fixedText);

              totalChanged++;
            }
          }
        } catch (e) {
          errors.push(e.message);
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

/* -------------------- RESULTS -------------------- */

const doneDlg = Dialog.create("RTL Fix Complete");

let msg = "";

if (totalChanged > 0) {
  msg =
    `Updated ${totalChanged} of ${totalNodes} text field(s).\n\n` +
    `Mode used: ${MODE}\n\n` +
    `Undo available with Ctrl+Z.`;
} else if (totalNodes > 0) {
  msg = `Checked ${totalNodes} text field(s).\n\n` + `No changes were needed.`;
} else {
  msg = "No text fields found.";
}

if (errors.length) {
  msg += "\n\nErrors:\n" + errors.join("\n");
}

doneDlg.addColumn().addGroup("").addStaticText("", msg);

doneDlg.show();
