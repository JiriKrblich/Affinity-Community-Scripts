const { Document } = require("/document");
const { DocumentCommand, CompoundCommandBuilder } = require("/commands");
const { Selection } = require("/selections");
const { Transform } = require("/geometry");
const { Dialog, DialogResult } = require("/dialog");
const { UnitType } = require("/units");

const doc = Document.current;
if (!doc) {
  alert("No document is open.");
} else {
  const textNodes = doc.selection.nodes
    .filter(function (n) {
      return n.isArtTextNode;
    })
    .toArray();

  if (textNodes.length < 2) {
    alert("Select at least 2 art text objects.\nFound: " + textNodes.length);
  } else {
    const dlg = Dialog.create("Block Text");
    const col = dlg.addColumn();

    const grpScale = col.addGroup("Scaling");
    const scaleSwitch = grpScale.addSwitch(
      "Match width to the widest object",
      true,
    );

    const grpAlign = col.addGroup("Horizontal alignment");
    const alignSwitch = grpAlign.addSwitch(
      "Align left edge of all objects",
      true,
    );

    const grpSpacing = col.addGroup("Vertical distribution");
    const spacingSwitch = grpSpacing.addSwitch(
      "Set equal spacing between objects",
      true,
    );
    const spacingEditor = grpSpacing.addUnitValueEditor(
      "Spacing (pt)",
      UnitType.Point,
      UnitType.Point,
      10,
      0,
      500,
    );

    if (dlg.runModal().value === DialogResult.Ok.value) {
      const doScale = scaleSwitch.value;
      const doAlign = alignSwitch.value;
      const doSpacing = spacingSwitch.value;
      const spacingPx = spacingEditor.value * (96 / 72);

      const items = textNodes
        .map(function (n) {
          return { node: n, bb: n.getSpreadBaseBox(false) };
        })
        .sort(function (a, b) {
          return a.bb.y - b.bb.y;
        });

      var maxWidth = items[0].bb.width;
      var leftX = items[0].bb.x;
      for (var k = 1; k < items.length; k++) {
        if (items[k].bb.width > maxWidth) maxWidth = items[k].bb.width;
        if (items[k].bb.x < leftX) leftX = items[k].bb.x;
      }

      const scaled = items.map(function (e) {
        var factor = doScale ? maxWidth / e.bb.width : 1;
        var newW = e.bb.width * factor;
        var newH = e.bb.height * factor;
        var cx = e.bb.x + e.bb.width / 2;
        var cy = e.bb.y + e.bb.height / 2;
        return {
          node: e.node,
          factor: factor,
          newW: newW,
          newH: newH,
          cx: cx,
          cy: cy,
          newTopY: cy - newH / 2,
        };
      });

      const cmds = [];
      var cursorY = scaled[0].newTopY;

      for (var i = 0; i < scaled.length; i++) {
        var e = scaled[i];

        var targetCX = doAlign ? leftX + e.newW / 2 : e.cx;
        var targetCY = e.cy;
        if (doSpacing) {
          targetCY = cursorY + e.newH / 2;
          cursorY = targetCY + e.newH / 2 + spacingPx;
        }

        var xf = Transform.createIdentity();
        if (Math.abs(e.factor - 1) > 0.0001) {
          xf = Transform.createTranslate(e.cx, e.cy)
            .multiply(Transform.createScale(e.factor, e.factor))
            .multiply(Transform.createTranslate(-e.cx, -e.cy));
        }

        var dx = targetCX - e.cx;
        var dy = targetCY - e.cy;
        if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
          xf = Transform.createTranslate(dx, dy).multiply(xf);
        }

        cmds.push(
          DocumentCommand.createTransform(Selection.create(doc, e.node), xf),
        );
      }

      if (cmds.length > 0) {
        var builder = CompoundCommandBuilder.create();
        for (var j = 0; j < cmds.length; j++) builder.addCommand(cmds[j]);
        doc.executeCommand(builder.createCommand());
      }
    }
  }
}
