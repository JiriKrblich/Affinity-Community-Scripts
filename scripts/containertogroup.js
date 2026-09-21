'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  Container Layer to Group  –  v5-EN
//
//  Mode A – real group (if at least one NON-Symbol GroupNode exists):
//    Duplicates an existing, normal GroupNode as template, empties the
//    duplicate, moves the container's children into it
//    → ungroup via Ctrl+Shift+G
//
//  Mode B – clipping rectangle (fallback):
//    Creates a rectangle (page size, no fill/stroke), clips the children
//    into it → release via right-click → Release Clipping Mask
//
//  IMPORTANT: Affinity Symbols are GroupNodes (defaultDescription="Symbol").
//  They are NEVER used as a duplicate template (linked instances, risk of
//  conflict/deadlock when emptied) and NEVER recursed into (their internal
//  structure belongs to the master). As CHILDREN of a container, symbol
//  instances are simply moved along (pure repositioning, unaffected).
// ═══════════════════════════════════════════════════════════════════════════

const { app }                     = require('/application');
const { Dialog, DialogResult,
        HorizontalAlignment }     = require('/dialog');
const { AddChildNodesCommandBuilder,
        DocumentCommand,
        NodeChildType,
        NodeMoveType }            = require('/commands');
const { ShapeNodeDefinition }     = require('/nodes');
const { Shape, ShapeType }        = require('/shapes');
const { FillDescriptor }          = require('/fills');

// ── Symbol detection ─────────────────────────────────────────────────────
function isSymbolGroup(node) {
    return !!node.isGroupNode && node.defaultDescription === 'Symbol';
}

// ── Document ──────────────────────────────────────────────────────────────
const doc = app.documents.current;
if (!doc) {
    app.alert('No document open.', 'Container Layer to Group');
    throw new Error('Abort');
}

// ── Spread size (for Mode B) ──────────────────────────────────────────────
const spreads = [];
for (const s of doc.spreads) spreads.push(s);
const ext  = spreads[0].getSpreadExtents({ includeSpread: true });
const RECT = { x: ext.x, y: ext.y, width: ext.width, height: ext.height };

// ── Find template GroupNode (for Mode A) — Symbols excluded ─────────────
let templateGroup = null;
for (const l of doc.layers.all) {
    if (l.isGroupNode && !isSymbolGroup(l)) { templateGroup = l; break; }
}

// ── Collect all ContainerNodes (recursive, top-down) ─────────────────────
// Do not descend into symbol instances — their structure belongs to the master.
function collectContainers(layersColl, result) {
    for (const node of layersColl) {
        if (node.isContainerNode) result.push(node);
        if (isSymbolGroup(node)) continue; // symbol: treat as leaf, don't recurse
        if (node.children) collectContainers(node.children, result);
    }
}
const allContainers = [];
collectContainers(doc.layers, allContainers);

const modeA = templateGroup !== null;

// ── Helper: left-aligned static text ─────────────────────────────────────
function addLeft(grp, text) {
    const st = grp.addStaticText('', text);
    st.setIsFullWidth(true);
    st.setTextHorizontalAlignment(HorizontalAlignment.Left);
    return st;
}

// ── Dialog: two columns, compact ─────────────────────────────────────────
const dlg = Dialog.create('Container Layer to Group');
dlg.initialWidth = 500;

// Left column: container list
const colL = dlg.addColumn();
colL.paddingFactor = 0.3;

const grpList = colL.addGroup('Container Layers');
if (allContainers.length === 0) {
    addLeft(grpList, 'None found.');
} else {
    const maxShow = Math.min(allContainers.length, 16);
    for (let i = 0; i < maxShow; i++) {
        const c  = allContainers[i];
        const nm = c.userDescription || c.defaultDescription;
        let cnt  = 0;
        for (const _ of c.children) cnt++;
        addLeft(grpList, `${nm}  (${cnt})`);
    }
    if (allContainers.length > 16)
        addLeft(grpList, `… +${allContainers.length - 16} more`);
}

// Right column: mode info + button
const colR = dlg.addColumn();
colR.paddingFactor = 0.3;
colR.widthProportion = 1.1;

const grpMode = colR.addGroup('Mode');
if (modeA) {
    addLeft(grpMode, 'Real Group');
    addLeft(grpMode, 'Ungroup: Ctrl+Shift+G');
} else {
    addLeft(grpMode, 'Clipping Rectangle');
    addLeft(grpMode, 'Release: Right-click →');
    addLeft(grpMode, 'Release Clipping Mask');
    addLeft(grpMode, '');
    addLeft(grpMode, 'For real groups:');
    addLeft(grpMode, 'Layer → New Group,');
    addLeft(grpMode, 'then re-run script.');
}

const grpBtn = colR.addGroup('');
const btn = grpBtn.addButtonSet('', ['Cancel', 'Apply'], 0);

// ── Show dialog ───────────────────────────────────────────────────────────
const dlgResult = dlg.runModal();

const userAborted = !dlgResult
    || dlgResult.value === DialogResult.Cancel.value
    || btn.selectedIndex !== 1;

if (userAborted || allContainers.length === 0) {
  // nothing to do
} else {

  const noFill = FillDescriptor.createNone();
  const containersToConv = [...allContainers].reverse();  // bottom-up

  for (const container of containersToConv) {

    const children = [];
    for (const ch of container.children) children.push(ch);

    const nextSib = container.nextSibling;
    const parentNode = container.parent;
    const name = container.userDescription || container.defaultDescription;

    let targetNode = null;

    if (modeA) {
      // ── Mode A: real GroupNode via duplicate trick ────────────────
      // (templateGroup is guaranteed NOT a symbol, see search above)

      doc.executeCommand(
        DocumentCommand.createTransform(
          templateGroup.selfSelection, null, { duplicateNodes: true }
        )
      );
      const dup = doc.selection.at(0).node;

      const dupKids = [];
      for (const ch of dup.children) dupKids.push(ch);
      for (const ch of dupKids) {
        doc.executeCommand(
          DocumentCommand.createDeleteSelection(ch.selfSelection, false)
        );
      }

      doc.executeCommand(
        DocumentCommand.createSetDescription(dup.selfSelection, name)
      );

      targetNode = dup;

    } else {
      // ── Mode B: clipping rectangle ───────────────────────────────
      const rectDef = ShapeNodeDefinition.create(
        Shape.create(ShapeType.Rectangle),
        RECT,
        noFill, noFill, null, null
      );
      rectDef.userDescription = name;

      const bldr = AddChildNodesCommandBuilder.create();
      bldr.addShapeNode(rectDef);
      bldr.setInsertionTarget(container);
      doc.executeCommand(bldr.createCommand(false, NodeChildType.Main));

      for (const ch of container.children) targetNode = ch;
    }

    // ── Move children into target node ────────────────────────────────
    // (any symbol instances among the children are only REPOSITIONED
    //  here, never duplicated/emptied — safe)
    const childType = modeA ? NodeChildType.Main : NodeChildType.Enclosure;

    for (let i = children.length - 1; i >= 0; i--) {
      doc.executeCommand(
        DocumentCommand.createMoveNodes(
          children[i].selfSelection,
          targetNode,
          NodeMoveType.Inside,
          childType
        )
      );
    }

    // ── Place target node at correct stack position ───────────────────
    const targetSel = targetNode.selfSelection;

    if (nextSib) {
      doc.executeCommand(
        DocumentCommand.createMoveNodes(
          targetSel, nextSib, NodeMoveType.Before, NodeChildType.Main
        )
      );
    } else if (parentNode && !parentNode.isSpreadNode) {
      doc.executeCommand(
        DocumentCommand.createMoveNodes(
          targetSel, parentNode, NodeMoveType.Inside, NodeChildType.Main
        )
      );
    } else {
      let lastLayer = null;
      for (const l of doc.layers) lastLayer = l;
      if (lastLayer && !lastLayer.isSameNode(targetNode)) {
        doc.executeCommand(
          DocumentCommand.createMoveNodes(
            targetSel, lastLayer, NodeMoveType.After, NodeChildType.Main
          )
        );
      }
    }

    // ── Delete empty container ────────────────────────────────────────
    doc.executeCommand(
      DocumentCommand.createDeleteSelection(container.selfSelection, false)
    );
  }

  const n = containersToConv.length;
  app.alert(
    modeA
      ? `${n} container layer(s) converted to real group(s).\nUngroup: Ctrl+Shift+G`
      : `${n} container layer(s) converted to clipping rectangle(s).\nRelease clip: Right-click → Release Clipping Mask`,
    'Container Layer to Group – Done'
  );
}
