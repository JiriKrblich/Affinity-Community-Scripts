const { Document, FileExportOptions, FileExportArea } = require("/document");
const { Selection } = require("/selections");
const { DocumentCommand } = require("/commands");
const { app } = require("/application");
const { Dialog, DialogResult } = require("/dialog");

// ── Build the dialog ──────────────────────────────────────────────
const desktop = app.userDesktopPath;

const dlg = Dialog.create("Group Exporter");
dlg.initialWidth = 420;

const col = dlg.addColumn();

// Parent group name
const grpName = col.addGroup("Parent Group");
const txtGroup = grpName.addTextBox("Group name", "lorem ipsum");
txtGroup.setIsFullWidth(true);

// Sub group range — plain text, works with any name/symbol
const grpRange = col.addGroup("Sub Groups to Export");
grpRange.enableSeparator = true;
const txtFrom = grpRange.addTextBox("From", "1");
const txtTo = grpRange.addTextBox("To", "10");

// Output — Desktop is locked; optional sub-folder only
const grpDest = col.addGroup("Output Folder");
grpDest.enableSeparator = true;
grpDest.addStaticText("Save location", "Desktop (locked)");
const txtSub = grpDest.addTextBox("Sub-folder (optional)", "");
txtSub.setIsFullWidth(true);

// ── Show dialog ───────────────────────────────────────────────────
const result = dlg.runModal();

if (result.value !== DialogResult.Ok.value) {
  console.log("Cancelled by user.");
} else {
  const parentName = txtGroup.text.trim();
  const fromName = txtFrom.text.trim();
  const toName = txtTo.text.trim();
  const subFolder = txtSub.text.trim();

  // Build destination — always rooted on Desktop
  const destFolder = subFolder ? desktop + "/" + subFolder : desktop;

  if (!parentName) {
    console.log("ERROR: group name is empty");
  } else if (!fromName || !toName) {
    console.log("ERROR: From and To fields cannot be empty");
  } else {
    // Find the parent group
    const doc = Document.current;
    const spread = doc.currentSpread || doc.spreads.first;
    let parent = null;

    for (const layer of spread.layers) {
      const n = layer.userDescription || layer.defaultDescription;
      if (n === parentName) {
        parent = layer;
        break;
      }
    }

    if (!parent) {
      console.log(
        "ERROR: parent group '" + parentName + "' not found in document",
      );
    } else {
      // Collect all children in order, then slice between fromName and toName
      const allChildren = [];
      for (const child of parent.children) {
        allChildren.push({
          node: child,
          name: child.userDescription || child.defaultDescription,
        });
      }

      const fromIdx = allChildren.findIndex((c) => c.name === fromName);
      const toIdx = allChildren.findIndex((c) => c.name === toName);

      if (fromIdx === -1) {
        console.log(
          "ERROR: sub group '" +
            fromName +
            "' not found inside '" +
            parentName +
            "'",
        );
      } else if (toIdx === -1) {
        console.log(
          "ERROR: sub group '" +
            toName +
            "' not found inside '" +
            parentName +
            "'",
        );
      } else if (fromIdx > toIdx) {
        console.log(
          "ERROR: 'From' group comes after 'To' group in the layer order",
        );
      } else {
        const toExport = allChildren.slice(fromIdx, toIdx + 1);
        console.log(
          "Exporting '" +
            parentName +
            "' sub groups '" +
            fromName +
            "' → '" +
            toName +
            "' (" +
            toExport.length +
            " groups)",
        );
        console.log("Output → " + destFolder);

        for (const item of toExport) {
          // Ensure visibility ON
          if (!item.node.isVisibleInDomain) {
            doc.executeCommand(
              DocumentCommand.createSetVisibility(
                Selection.create(doc, item.node),
                true,
              ),
            );
          }

          // Export parent group as PNG
          doc.selection = Selection.create(doc, parent);
          const opts = FileExportOptions.createWithPresetName("PNG");
          const area = FileExportArea.createForSelection(doc.selection);
          const path = destFolder + "/" + parentName + " " + item.name + ".png";
          doc.export(path, opts, area, null);
          console.log("Exported: " + path);

          // Turn visibility back OFF
          doc.executeCommand(
            DocumentCommand.createSetVisibility(
              Selection.create(doc, item.node),
              false,
            ),
          );
        }

        console.log("DONE – " + toExport.length + " exports completed");
      }
    }
  }
}
