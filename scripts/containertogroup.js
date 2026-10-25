
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  Container Layer to Group  –  v6 (English)
//
//  New in v6 (vs. v5):
//   • Safeguard for the duplicate (mode A): the script reads the new duplicate
//     from doc.selection. If what it reads is not plausible (the template
//     itself, the container itself, not a real non-symbol GroupNode), NOTHING
//     is deleted: the duplicate is rolled back via the history position and
//     the run is aborted cleanly. (v5 would have deleted the children of the
//     wrong node in that case.)
//   • The original selection is saved before the run and restored afterwards
//     (nodes that were converted/deleted in the meantime are skipped).
//   • The completion message reports the number actually converted.
//
//  Mode A – real group (if at least one NON-symbol GroupNode exists):
//    Duplicates an existing, normal GroupNode as a template, empties the
//    duplicate, moves the container's children into it
//    → can be ungrouped with Ctrl+Shift+G
//
//  Mode B – clipping rectangle (fallback):
//    Creates a rectangle (page size, no fill/stroke) and attaches the
//    children as clipping masks → release via right-click → Release Clipping Mask
//
//  IMPORTANT: Affinity symbols are GroupNodes (defaultDescription="Symbol").
//  They are NEVER used as a duplicate template (linked instances, conflict /
//  deadlock risk when emptying) and NEVER searched recursively (their internal
//  structure belongs to the master). As CHILDREN of a container, symbol
//  instances are moved along normally (pure position change).
// ═══════════════════════════════════════════════════════════════════════════

const { app }                     = require('/application');
require('/document');                       // import order: /document before /selections
const { Selection }               = require('/selections');
const { Dialog, DialogResult,
        HorizontalAlignment }     = require('/dialog');
const { AddChildNodesCommandBuilder,
        DocumentCommand,
        NodeChildType,
        NodeMoveType }            = require('/commands');
const { ShapeNodeDefinition }     = require('/nodes');
const { Shape, ShapeType }        = require('/shapes');
const { FillDescriptor }          = require('/fills');

// ── Symbol detection ───────────────────────────────────────────────────────
function isSymbolGroup(node) {
    return !!node.isGroupNode && node.defaultDescription === 'Symbol';
}

// ── Document ──────────────────────────────────────────────────────────────
const doc = app.documents.current;
if (!doc) {
    app.alert('No document open.', 'Container Layer to Group');
    throw new Error('Abort');
}

// ── Selection helpers ─────────────────────────────────────────────────────
function snapshotSelectionNodes() {
    try { return doc.selection.nodes.toArray(); } catch (e) { return []; }
}

// Restores the selection. Nodes that no longer exist (e.g. deleted
// containers) are skipped.
function restoreSelection(nodes) {
    if (!nodes || nodes.length === 0) return;
    try {
        doc.selection = Selection.create(doc, nodes);
        return;
    } catch (e) { /* at least one node invalid → check individually */ }
    const valid = [];
    for (const n of nodes) {
        try { Selection.create(doc, n); valid.push(n); } catch (e) { /* skipped */ }
    }
    if (valid.length > 0) {
        try { doc.selection = Selection.create(doc, valid); } catch (e) { /* ignore */ }
    }
}

// ── Spread size (for mode B) ──────────────────────────────────────────────
const spreads = [];
for (const s of doc.spreads) spreads.push(s);
const ext  = spreads[0].getSpreadExtents({ includeSpread: true });
const RECT = { x: ext.x, y: ext.y, width: ext.width, height: ext.height };

// ── Find template GroupNode (for mode A) — symbols excluded ───────────────
let templateGroup = null;
for (const l of doc.layers.all) {
    if (l.isGroupNode && !isSymbolGroup(l)) { templateGroup = l; break; }
}

// ── Collect all ContainerNodes (recursive, top-down) ──────────────────────
// Do not descend into symbol instances — their structure belongs to the master.
function collectContainers(layersColl, result) {
    for (const node of layersColl) {
        if (node.isContainerNode) result.push(node);
        if (isSymbolGroup(node)) continue; // symbol: treat as leaf, no recursion
        if (node.children) collectContainers(node.children, result);
    }
}
const allContainers = [];
collectContainers(doc.layers, allContainers);

const modeA = templateGroup !== null;

// ── Helper: left-aligned static text ──────────────────────────────────────
function addLeft(grp, text) {
    const st = grp.addStaticText('', text);
    st.setIsFullWidth(true);
    st.setTextHorizontalAlignment(HorizontalAlignment.Left);
    return st;
}

// ── Dialog: two columns, compact ──────────────────────────────────────────
const dlg = Dialog.create('Container Layer to Group');
dlg.initialWidth = 500;

// Left column: container list
const colL = dlg.addColumn();
colL.paddingFactor = 0.3;

const grpList = colL.addGroup('Container layers');
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

// Right column: mode + hint + buttons
const colR = dlg.addColumn();
colR.paddingFactor = 0.3;
colR.widthProportion = 1.1;

const grpMode = colR.addGroup('Mode');
if (modeA) {
    addLeft(grpMode, 'Real group');
    addLeft(grpMode, 'Ungroup: Ctrl+Shift+G');
} else {
    addLeft(grpMode, 'Clipping rectangle');
    addLeft(grpMode, 'Release: right-click →');
    addLeft(grpMode, 'Release Clipping Mask');
    addLeft(grpMode, '');
    addLeft(grpMode, 'For real groups:');
    addLeft(grpMode, 'Layer → New Group,');
    addLeft(grpMode, 'then restart the script.');
}

const grpBtn = colR.addGroup('');
const btn = grpBtn.addButtonSet('', ['Cancel', 'Apply'], 0);

const dlgResult = dlg.runModal();

const userAborted = !dlgResult
    || dlgResult.value === DialogResult.Cancel.value
    || btn.selectedIndex !== 1;

if (userAborted || allContainers.length === 0) {
    // do nothing
} else {

    const noFill           = FillDescriptor.createNone();
    const containersToConv = [...allContainers].reverse();  // bottom-up

    // v6: save the original selection (before any edit)
    const originalSelNodes = snapshotSelectionNodes();

    let converted = 0;
    let abortReason = null;

    for (const container of containersToConv) {

        const children = [];
        for (const ch of container.children) children.push(ch);

        const nextSib    = container.nextSibling;
        const parentNode = container.parent;
        const name       = container.userDescription || container.defaultDescription;

        let targetNode = null;

        if (modeA) {
            // ── Mode A: real GroupNode via duplicate trick ───────────────
            // (templateGroup is guaranteed NOT a symbol, see search above)

            const posBeforeDup = doc.history.position;

            doc.executeCommand(
                DocumentCommand.createTransform(
                    templateGroup.selfSelection, null, { duplicateNodes: true }
                )
            );

            // The duplicate is read as the new selection (duplicating sets the
            // selection to the duplicate — confirmed by test).
            let dup = null;
            try { dup = doc.selection.at(0).node; } catch (e) { dup = null; }

            // v6 safeguard: plausibility check BEFORE anything is deleted.
            let plausible = !!dup && !!dup.isGroupNode && !isSymbolGroup(dup);
            if (plausible) {
                try { if (dup.isSameNode(templateGroup)) plausible = false; } catch (e) { plausible = false; }
            }
            if (plausible) {
                try { if (dup.isSameNode(container)) plausible = false; } catch (e) { plausible = false; }
            }

            if (!plausible) {
                // Roll back the duplicate, delete nothing, abort cleanly.
                try { doc.history.position = posBeforeDup; } catch (e) { /* ignore */ }
                abortReason = `The duplicate for "${name}" could not be identified unambiguously (unexpected selection after duplicating).`;
                break;
            }

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

        // ── Move children into target node ───────────────────────────────
        // (symbol instances among the children are only POSITIONED here,
        //  not duplicated/emptied — harmless)
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

        // ── Put target node at the correct stacking position ─────────────
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

        // ── Delete the now-empty container ────────────────────────────────
        doc.executeCommand(
            DocumentCommand.createDeleteSelection(container.selfSelection, false)
        );

        converted++;
    }

    // v6: restore the selection (also after an abort)
    restoreSelection(originalSelNodes);

    const total = containersToConv.length;
    if (abortReason) {
        app.alert(
            `Aborted after ${converted} of ${total} container layer(s).\n${abortReason}\n` +
            'Nothing unrelated was deleted; the faulty duplicate was rolled back.',
            'Container Layer to Group – Aborted'
        );
    } else {
        app.alert(
            modeA
                ? `${converted} container layer(s) converted to real group(s).\nUngroup: Ctrl+Shift+G`
                : `${converted} container layer(s) converted to clipping rectangles.\nRelease clip: right-click → Release Clipping Mask`,
            'Container Layer to Group – Done'
        );
    }
}
