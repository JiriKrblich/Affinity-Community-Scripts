
'use strict';
// === Replace All with Key Object v19 ===
// Preview is the default button throughout.

const { Document }                                          = require('/document');
const { DocumentCommand, CompoundCommandBuilder,
        NodeMoveType, NodeChildType }                       = require('/commands');
const { Dialog, DialogResult }                              = require('/dialog');
const { TransformBuilder }                                  = require('/geometry');

const APP_NAME = 'Replace All with Key Object';
const doc      = Document.current;

if (!doc) { console.log('Error: No document open.'); return; }

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getVisualRotation(node) {
    if (node[Symbol.toStringTag] === 'GroupNode') {
        for (const child of node.children) {
            return child.baseToSpreadTransform.decompose().rotation;
        }
    }
    return node.baseToSpreadTransform.decompose().rotation;
}

function getIntrinsicSize(node) {
    let d, bb;
    if (node[Symbol.toStringTag] === 'GroupNode') {
        for (const child of node.children) {
            d  = child.baseToSpreadTransform.decompose();
            bb = child.baseBox;
            return { w: Math.abs(d.scaleX) * bb.width, h: Math.abs(d.scaleY) * bb.height };
        }
    }
    d  = node.baseToSpreadTransform.decompose();
    bb = node.baseBox;
    return { w: Math.abs(d.scaleX) * bb.width, h: Math.abs(d.scaleY) * bb.height };
}

// ─── Capture selection ────────────────────────────────────────────────────────
const allNodes = [], seen = [];
for (const n of doc.selection.nodes) {
    if (!seen.some(s => s.isSameNode(n))) { seen.push(n); allNodes.push(n); }
}
const topLevel = allNodes.filter(n => {
    let p = n.parent;
    while (p) { if (allNodes.some(s => s.isSameNode(p))) return false; p = p.parent; }
    return true;
});

if (topLevel.length < 2) {
    console.log('Error: Select at least 2 objects (key + targets) and run again.');
    return;
}

// ─── Replace engine ───────────────────────────────────────────────────────────
function doReplace(keyNode, targets, ignoreSize) {
    const eligible = targets.filter(t => t.isEditable);
    if (eligible.length === 0) return 0;

    const kBB   = keyNode.getSpreadBaseBox(false);
    const k_cx  = kBB.x + kBB.width  / 2;
    const k_cy  = kBB.y + kBB.height / 2;
    const kRot  = getVisualRotation(keyNode);
    const kSize = getIntrinsicSize(keyNode);

    const pairs = [];
    for (const target of eligible) {
        const dup = keyNode.duplicate(null);
        if (dup) pairs.push({ dup, target });
    }
    if (pairs.length === 0) return 0;

    const cb = CompoundCommandBuilder.create();

    for (const { dup, target } of pairs) {
        const tBB      = target.getSpreadBaseBox(false);
        const t_cx     = tBB.x + tBB.width  / 2;
        const t_cy     = tBB.y + tBB.height / 2;
        const tRot     = getVisualRotation(target);
        const tSize    = getIntrinsicSize(target);
        const deltaRot = tRot - kRot;
        const sx       = ignoreSize ? 1 : tSize.w / kSize.w;
        const sy       = ignoreSize ? 1 : tSize.h / kSize.h;

        const tb1 = new TransformBuilder();
        tb1.translate(t_cx - k_cx, t_cy - k_cy);
        cb.addCommand(DocumentCommand.createTransform(dup.selfSelection, tb1.transform));

        if (!ignoreSize && (Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01)) {
            const tb2 = new TransformBuilder();
            tb2.translate(-t_cx, -t_cy);
            tb2.scale(sx, sy);
            tb2.translate(t_cx, t_cy);
            cb.addCommand(DocumentCommand.createTransform(dup.selfSelection, tb2.transform));
        }

        if (Math.abs(deltaRot) > 0.001) {
            const tb3 = new TransformBuilder();
            tb3.translate(-t_cx, -t_cy);
            tb3.rotate(deltaRot);
            tb3.translate(t_cx, t_cy);
            cb.addCommand(DocumentCommand.createTransform(dup.selfSelection, tb3.transform));
        }

        cb.addCommand(DocumentCommand.createMoveNodes(
            dup.selfSelection, target, NodeMoveType.After, NodeChildType.Main
        ));
        cb.addCommand(DocumentCommand.createDeleteSelection(target.selfSelection, true));
    }

    doc.executeCommand(cb.createCommand());
    return pairs.length + 1;   // N dups + 1 compound
}

// ─── Undo helper ─────────────────────────────────────────────────────────────
let undoCount = 0;

function undoAll() {
    for (let i = 0; i < undoCount; i++) {
        doc.executeCommand(DocumentCommand.createUndo());
    }
    undoCount = 0;
}

// ─── Labels ──────────────────────────────────────────────────────────────────
const labels = topLevel.map((n, i) => {
    const b    = n.getSpreadBaseBox(false);
    const desc = n.userDescription || n.defaultDescription;
    const tag  = n[Symbol.toStringTag].replace('Node', '');
    return `[${i + 1}]  ${desc}   ${b.width.toFixed(0)} × ${b.height.toFixed(0)}  (${tag})`;
});

// ─── Dialog ───────────────────────────────────────────────────────────────────
const dlg        = Dialog.create(APP_NAME);
dlg.initialWidth = 420;
const col        = dlg.addColumn();

const grpKey = col.addGroup('Key Object');
grpKey.addStaticText('', 'Template object — replaces all other selected objects:');
const keyCombo       = grpKey.addComboBox('', labels, 0);
keyCombo.isFullWidth = true;

const grpOpts     = col.addGroup('Options');
const matchSizeCk = grpOpts.addCheckBox('Adopt target dimensions (override key size)', false);
matchSizeCk.isFullWidth = true;

const grpInfo = col.addGroup('');
grpInfo.enableSeparator = true;
grpInfo.addStaticText('', `${topLevel.length} objects  ·  1 key  ·  ${topLevel.length - 1} target(s)`).isFullWidth = true;
grpInfo.addStaticText('', 'Preview — re-runs replace with current settings.').isFullWidth = true;
grpInfo.addStaticText('', 'Apply — keeps result and closes.').isFullWidth = true;
grpInfo.addStaticText('', 'Cancel — reverts all changes.').isFullWidth = true;

const grpBtns = col.addGroup('');
grpBtns.enableSeparator = true;
const btns            = grpBtns.addButtonSet('', ['Preview', 'Apply'], 0);  // ← 0 = Preview default
btns.isFullWidth      = true;

const grpSpacer = col.addGroup('');
grpSpacer.addStaticText('', '').isFullWidth = true;
grpSpacer.addStaticText('', '').isFullWidth = true;

// ─── Auto-replace on open ─────────────────────────────────────────────────────
{
    const targets = topLevel.filter((_, i) => i !== 0);
    undoCount = doReplace(topLevel[0], targets, true);
    console.log(`Auto-replace: ${targets.length} object(s) replaced (${undoCount} undo step(s)).`);
}

// ─── Main loop ────────────────────────────────────────────────────────────────
let running = true;

while (running) {
    btns.selectedIndex = 0;          // ← Preview stays default each iteration
    const r = dlg.show();

    if (r.value !== DialogResult.Ok.value) {
        undoAll();
        console.log('Cancelled — all changes reverted.');
        break;
    }

    const keyIdx  = keyCombo.selectedIndex;
    const keyNode = topLevel[keyIdx];
    const targets = topLevel.filter((_, i) => i !== keyIdx);
    const ignSize = !matchSizeCk.value;

    if (btns.selectedIndex === 0) {
        // Preview
        undoAll();
        undoCount = doReplace(keyNode, targets, ignSize);
        console.log(`Preview: ${targets.length} object(s) replaced.`);

    } else {
        // Apply
        console.log(`Applied: ${targets.length} object(s) replaced.`);
        undoCount = 0;
        running   = false;
    }
}
