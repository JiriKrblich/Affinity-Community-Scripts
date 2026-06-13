"use strict";

/**
 * Export Selected Layer(s) as CMYK PSD
 *
 * - Shows a dialog to type the filename before saving
 * - Single layer  → exports it directly
 * - Multiple layers → groups them into a Group layer (ContainerNode),
 *   exports it, then undoes so the document is left unchanged
 *
 * NOTE on "Group layer": The Affinity scripting API does not expose a way to
 * create the same GroupNode that Ctrl+G produces (that is a UI-only operation).
 * The script uses a ContainerNode, which is the API equivalent — it appears as
 * a collapsible group folder in the Layers panel and behaves identically for
 * export purposes.
 *
 * REQUIREMENT: Affinity Preferences → General →
 *   enable "Allow scripts to access the filesystem"
 *
 * Output: Desktop/<your filename>.psd  (CMYK, PSD preserve-editability)
 */

const { Document, FileExportOptions, FileExportArea } = require("/document");
const { RasterFormat } = require("/rasterobject");
const {
  AddChildNodesCommandBuilder,
  DocumentCommand,
  NodeMoveType,
  NodeChildType,
} = require("/commands");
const { ContainerNodeDefinition } = require("/nodes");
const { Selection } = require("/selections");
const { Dialog } = require("/dialog");
const { app } = require("/application");

// ── 1. Validate ───────────────────────────────────────────────────────────────
const doc = Document.current;
if (!doc) {
  app.alert("No document is currently open.", "Export Error");
  return;
}

const sel = doc.selection;
const selectedNodes = [];
for (const item of sel.items) {
  if (item.node) selectedNodes.push(item.node);
}

if (selectedNodes.length === 0) {
  app.alert(
    "Please select one or more layers before running this script.",
    "Export Error",
  );
  return;
}

// ── 2. Filename dialog ────────────────────────────────────────────────────────
const defaultName =
  (selectedNodes[0].userDescription || "Exported Layer")
    .replace(/[/\\:*?"<>|]/g, "_")
    .trim() || "exported_layer";

const dlg = Dialog.create("Export as CMYK PSD");
dlg.initialWidth = 420;
const col = dlg.addColumn();
const grp = col.addGroup("");
grp.addStaticText(
  "hint",
  selectedNodes.length > 1
    ? selectedNodes.length +
        " layers selected — they will be grouped for export."
    : "1 layer selected.",
);
grp.addStaticText("label", "Enter filename (without extension):");
const textBox = grp.addTextBox("Filename", defaultName);
textBox.isFullWidth = true;

let dlgResult;
try {
  dlgResult = dlg.show();
} catch (e) {
  app.alert(
    "Could not open the filename dialog.\n\n" +
      "If this keeps happening, restart Affinity once to clear dialog state.\n\nError: " +
      e.message,
    "Dialog Error",
  );
  return;
}

if (!dlgResult || dlgResult.value !== 1) {
  return;
} // user cancelled

const userFileName =
  (textBox.text || defaultName).replace(/[/\\:*?"<>|]/g, "_").trim() ||
  "exported_layer";

// ── 3. Build export path (Desktop) ────────────────────────────────────────────
const desktop = app.userDesktopPath;
const sep = desktop.includes("\\") ? "\\" : "/";
const exportPath = desktop + sep + userFileName + ".psd";

// ── 4. Convert document colour format to CMYK ─────────────────────────────────
try {
  doc.format = RasterFormat.CMYKA8;
} catch (e) {
  app.alert(
    "Failed to convert colour format to CMYK:\n" + e.message,
    "Export Error",
  );
  return;
}

// ── 5. Group multiple layers ──────────────────────────────────────────────────
// The Affinity scripting API cannot create the UI-level GroupNode (Ctrl+G);
// ContainerNode is the programmatic equivalent — same folder appearance in
// the Layers panel, same export behaviour.
const isMulti = selectedNodes.length > 1;

if (isMulti) {
  const groupDef = ContainerNodeDefinition.create(userFileName);
  const builder = AddChildNodesCommandBuilder.create();
  builder.addContainerNode(groupDef);
  builder.setInsertionTargetSelection(sel);
  const addCmd = builder.createCommand(false);
  doc.executeCommand(addCmd);

  const groupNode = addCmd.newNodes[0];

  const moveSel = Selection.create(doc, selectedNodes);
  const moveCmd = DocumentCommand.createMoveNodes(
    moveSel,
    groupNode,
    NodeMoveType.Inside,
    NodeChildType.Main,
  );
  doc.executeCommand(moveCmd);

  sel.clear();
  sel.addNode(groupNode);
}

// ── 6. Export as PSD ──────────────────────────────────────────────────────────
let exportSuccess = false;
let exportError = "";
let permDenied = false;

try {
  const exportOptions = FileExportOptions.createWithPresetName(
    "PSD (preserve editability)",
  );
  const exportArea = FileExportArea.createForSelection(sel);
  const records = doc.export(exportPath, exportOptions, exportArea);

  records.enumerate((record) => {
    if (record.isSuccess) {
      exportSuccess = true;
    } else {
      exportError = record.errorMessage || "Unknown export error";
      if (
        exportError.toUpperCase().includes("PERMISSION") ||
        exportError.toUpperCase().includes("DENIED")
      ) {
        permDenied = true;
      }
    }
  });
} catch (e) {
  exportError = e.message;
  if (
    exportError.toUpperCase().includes("PERMISSION") ||
    exportError.toUpperCase().includes("DENIED")
  ) {
    permDenied = true;
  }
}

// ── 7. Undo grouping — document left exactly as before ────────────────────────
if (isMulti) {
  doc.undo(); // undo move-into-group
  doc.undo(); // undo group creation
}

// ── 8. Result alert — user must click OK to dismiss ──────────────────────────
if (exportSuccess) {
  app.alert(
    "✅ Export successful!\n\n" +
      (isMulti ? "Grouped: " + selectedNodes.length + " layers\n" : "") +
      "File:    " +
      userFileName +
      ".psd\n" +
      "Format: CMYK PSD\n" +
      "Saved to:\n" +
      exportPath,
    "Export Complete",
  );
} else if (permDenied) {
  app.alert(
    "🔒 Permission Denied\n\n" +
      "Affinity scripts need filesystem access to export files.\n\n" +
      "To fix this:\n" +
      "1. Open Affinity Preferences\n" +
      "2. Go to the General tab\n" +
      '3. Enable "Allow scripts to access the filesystem"\n' +
      "4. Re-run this script",
    "Filesystem Access Required",
  );
} else {
  app.alert("❌ Export failed.\n\n" + exportError, "Export Error");
}
