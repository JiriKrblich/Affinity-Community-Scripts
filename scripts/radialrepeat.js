"use strict";

const { Document } = require("/document");
const {
  DocumentCommand,
  AddChildNodesCommandBuilder,
  CompoundCommandBuilder,
  NodeChildType,
  NodeMoveType,
} = require("/commands");
const { TransformBuilder } = require("/geometry");
const { ContainerNodeDefinition } = require("/nodes");
const { Dialog, DialogResult } = require("/dialog");
const { Selection } = require("/selections");

const doc = Document.current;
if (!doc) {
  alert("Open a document first.");
} else {
  function undoN(n) { for (let i = 0; i < n; i++) doc.undo(); }
  function validBB(b) {
    return b && isFinite(b.x) && isFinite(b.y) && isFinite(b.width) && isFinite(b.height) && (b.width > 0 || b.height > 0);
  }
  function nodeBBOrFallback(n) {
    const b = n.getSpreadBaseBox(false); if (validBB(b)) return b;
    const b2 = n.getSpreadBaseBox(true); if (validBB(b2)) return b2;
    return null;
  }
  function getZRank(node) {
    let rank = 0, sib = node.previousSibling;
    while (sib) { rank++; sib = sib.previousSibling; }
    return rank;
  }

  const rawNodes = doc.selection.nodes.toArray().filter(Boolean);
  if (rawNodes.length === 0) { alert("Select one or more objects first."); }
  else {
    let origNodes, initSteps = 0;
    if (rawNodes.length === 1) {
      origNodes = [rawNodes[0]];
    } else {
      const fp = rawNodes[0].parent;
      const groupEditMode = fp && !fp.isSpreadNode && !fp.isDocumentNode
        && rawNodes.every(n => n.parent && n.parent.isSameNode(fp));
      origNodes = groupEditMode ? [fp] : rawNodes;
    }

    const revealCb = CompoundCommandBuilder.create();
    let anyHidden = false;
    for (const n of origNodes) {
      const vi = n.visibilityInterface;
      if (vi && !vi.isVisibleInDomain) {
        revealCb.addCommand(DocumentCommand.createSetVisibility(Selection.create(doc, n), true));
        anyHidden = true;
      }
    }
    if (anyHidden) { doc.executeCommand(revealCb.createCommand()); initSteps++; }

    const validSrcs = origNodes.filter(n => nodeBBOrFallback(n) !== null);
    if (validSrcs.length === 0) { alert("No visible content to array."); }
    else {
      origNodes = validSrcs;
      const K = origNodes.length;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of origNodes) {
        const b = nodeBBOrFallback(n);
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const KEEP_ORIGIN = false;

      function buildXforms(p) {
        const xforms = [];
        const rotRad = (p.rotDeg * Math.PI) / 180;
        const rowShiftRad = (p.radialShiftDeg * Math.PI) / 180;
        let count = 0;
        for (let r = 0; r < p.radialRows; r++) {
          const ci = p.instances + r * p.instancesIncrement;
          if (ci <= 0) break;
          const step = (2 * Math.PI) / ci;
          const curRadius = p.radius + r * p.radialSpacing;
          const curShift = r * rowShiftRad;
          const ringScStart = p.scaleStart * Math.pow(p.rowScale, r);
          const ringScEnd   = p.scaleEnd   * Math.pow(p.rowScale, r);
          for (let i = 0; i < ci; i++) {
            const src = origNodes[count % K];
            const bb = nodeBBOrFallback(src);
            const sox = bb.x + bb.width / 2, soy = bb.y + bb.height / 2;
            const a = -Math.PI / 2 + i * step + curShift;
            const rot = p.rotEnabled ? rotRad : i * step + curShift;
            const sc = ringScStart + (ringScEnd - ringScStart) * (ci > 1 ? i / (ci - 1) : 0);
            const tb = new TransformBuilder();
            tb.translate(-sox, -soy);
            if (Math.abs(sc - 1) > 0.0001) tb.scale(sc, sc);
            if (Math.abs(rot) > 0.0001) tb.rotate(rot);
            tb.translate(cx + curRadius * Math.cos(a), cy + curRadius * Math.sin(a));
            xforms.push({ src, xf: tb.transform });
            count++;
          }
        }
        return xforms;
      }

      // Compound PUR de Above — fara alte tipuri de comenzi mixate
      function execAboveReorder(ordered) {
        if (ordered.length < 2) return false;
        const cb = CompoundCommandBuilder.create();
        for (let i = 1; i < ordered.length; i++) {
          cb.addCommand(DocumentCommand.createMoveNodes(
            Selection.create(doc, ordered[i]),
            ordered[i - 1],
            NodeMoveType.Above,
            NodeChildType.Main,
          ));
        }
        doc.executeCommand(cb.createCommand());
        return true;
      }

      // ── doPreview ─────────────────────────────────────────────────
      // OFF (Woven): z natural dupa dup, fara reorder explicit
      // ON (Sequential): reorder explicit in ordinea xforms = placement order
      function doPreview(p) {
        const xforms = buildXforms(p);

        // Pas 1: dup batch
        const dupCb = CompoundCommandBuilder.create();
        for (const { src, xf } of xforms)
          dupCb.addCommand(DocumentCommand.createTransform(Selection.create(doc, src), xf, { duplicateNodes: true }));
        const dupCmd = dupCb.createCommand();
        doc.executeCommand(dupCmd);
        const dupNodes = dupCmd.newNodes;

        // Pas 2: hide sources
        const hideCb = CompoundCommandBuilder.create();
        for (const src of origNodes)
          hideCb.addCommand(DocumentCommand.createSetVisibility(Selection.create(doc, src), false));
        doc.executeCommand(hideCb.createCommand());

        // Pas 3: doar pt Sequential Stack ON — reorder explicit
        if (p.sequentialStack && K > 1) {
          const did = execAboveReorder(Array.from(dupNodes));
          if (did) return 3;
        }
        return 2;
      }

      // ── doApply — identic cu v6b ──────────────────────────────────
      function doApply(p) {
        // 1 — Container
        const cndB = AddChildNodesCommandBuilder.create();
        cndB.addContainerNode(ContainerNodeDefinition.createDefault());
        const cCmd = cndB.createCommand(false, NodeChildType.Main);
        doc.executeCommand(cCmd);
        const containerNode = cCmd.newNodes[0];

        // 2 — Batch dup (dupNodes e in ordinea xforms/creare — verificat empiric)
        const xforms = buildXforms(p);
        const dupCb = CompoundCommandBuilder.create();
        for (const { src, xf } of xforms)
          dupCb.addCommand(DocumentCommand.createTransform(Selection.create(doc, src), xf, { duplicateNodes: true }));
        const dupCmd = dupCb.createCommand();
        doc.executeCommand(dupCmd);
        const dupNodes = dupCmd.newNodes;

        // 3 — Muta tot Inside container (reverse loop) + show
        const moveCb = CompoundCommandBuilder.create();
        for (let i = dupNodes.length - 1; i >= 0; i--) {
          moveCb.addCommand(DocumentCommand.createMoveNodes(
            Selection.create(doc, dupNodes[i]), containerNode, NodeMoveType.Inside, NodeChildType.Main));
          moveCb.addCommand(DocumentCommand.createSetVisibility(Selection.create(doc, dupNodes[i]), true));
        }
        doc.executeCommand(moveCb.createCommand());

        // 4 — Reordonare cu Above (compound PUR, calculat DUPA Inside)
        let ordered;
        if (p.sequentialStack && K > 1) {
          ordered = Array.from(dupNodes); // ordinea plasarii pe inel
        } else {
          // Woven: sortat dupa zRank din container (ascending)
          ordered = Array.from(dupNodes).sort((a, b) => getZRank(a) - getZRank(b));
        }
        execAboveReorder(ordered);

        // 5 — Hide sources (compound separat)
        if (!KEEP_ORIGIN) {
          const hideCb = CompoundCommandBuilder.create();
          for (const src of origNodes)
            hideCb.addCommand(DocumentCommand.createSetVisibility(Selection.create(doc, src), false));
          doc.executeCommand(hideCb.createCommand());
        }
      }

      // ── Dialog ────────────────────────────────────────────────────
      const multiSrc = K > 1;
      const srcLabel = multiSrc ? ` — ${K} Alternating` : "";
      const dlg = Dialog.create(`Radial Repeat${srcLabel}`);
      const col = dlg.addColumn();

      const grpDist = col.addGroup("Instances & Rows");
      const instEd    = grpDist.addUnitValueEditor("Instances", "", "", 6, 1, 500);            instEd.precision = 0;
      const radEd     = grpDist.addUnitValueEditor("Radius (px)", "px", "px", 50, 0.1, 99999); radEd.precision = 1;
      const radRowsEd = grpDist.addUnitValueEditor("Rows", "", "", 1, 1, 100);                 radRowsEd.precision = 0;
      const radSpcEd  = grpDist.addUnitValueEditor("Row Spacing (px)", "px", "px", 50, 0, 99999); radSpcEd.precision = 1;
      const instIncEd = grpDist.addUnitValueEditor("Added Instances Per Row", "", "", 0, -100, 500); instIncEd.precision = 0;
      const radShiftEd= grpDist.addUnitValueEditor("Row Rotation", "deg", "deg", 0, -360, 360); radShiftEd.precision = 1;

      const grpRot = col.addGroup("Rotation");
      const rotSw = grpRot.addSwitch("Enable Custom Rotation", false);
      const rotEd = grpRot.addUnitValueEditor("Angle (deg)", "deg", "deg", 0, -3600, 3600); rotEd.precision = 1;

      const grpScl = col.addGroup("Scaling");
      const scStEd = grpScl.addUnitValueEditor("Instances Start Scale (%)", "%", "%", 100, 1, 1000); scStEd.precision = 1;
      const scEnEd = grpScl.addUnitValueEditor("Instances End Scale (%)", "%", "%", 100, 1, 1000); scEnEd.precision = 1;
      const scRowEd= grpScl.addUnitValueEditor("Row Scaling (%)", "%", "%", 100, 1, 1000);           scRowEd.precision = 1;

      let seqStackSw = null;
      if (multiSrc) {
        const grpStack = col.addGroup("Layer Order");
        seqStackSw = grpStack.addSwitch("Sequential Stack", false);
      }

      const sepGrp = col.addGroup("");
      sepGrp.enableSeparator = true;
      const btns = sepGrp.addButtonSet("", ["Preview", "Apply"], 0);

      function getParams() {
        return {
          instances:          Math.max(1, Math.round(instEd.value)),
          instancesIncrement: Math.round(instIncEd.value),
          radius:             Math.max(0.1, radEd.value),
          radialRows:         Math.max(1, Math.round(radRowsEd.value)),
          radialSpacing:      Math.max(0, radSpcEd.value),
          radialShiftDeg:     radShiftEd.value,
          rotEnabled:         rotSw.value,
          rotDeg:             rotEd.value,
          scaleStart:         Math.max(0.01, scStEd.value / 100),
          scaleEnd:           Math.max(0.01, scEnEd.value / 100),
          rowScale:           Math.max(0.01, scRowEd.value / 100),
          sequentialStack:    seqStackSw ? seqStackSw.value : false,
        };
      }

      let previewSteps = doPreview(getParams());
      let running = true;
      while (running) {
        btns.selectedIndex = 0;
        const r = dlg.show();
        const p = getParams();
        const mode = btns.selectedIndex;
        if (r.value === DialogResult.Ok.value) {
          undoN(previewSteps);
          if (mode === 1) { doApply(p); running = false; }
          else { previewSteps = doPreview(p); }
        } else {
          undoN(previewSteps); undoN(initSteps); running = false;
        }
      }
    }
  }
}
