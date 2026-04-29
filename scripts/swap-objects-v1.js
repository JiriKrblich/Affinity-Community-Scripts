'use strict';

const { Document }                                          = require('/document');
const { DocumentCommand, CompoundCommandBuilder,
        NodeMoveType, NodeChildType }                       = require('/commands');
const { Dialog, DialogResult }                              = require('/dialog');
const { TransformBuilder }                                  = require('/geometry');

const APP_NAME  = 'Swap Objects v5';
const PAGE_SIZE = 7;

const doc = Document.current;
if (!doc) { console.log('No document open.'); return; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getVisualRotation(node) {
    if (node[Symbol.toStringTag] === 'GroupNode') {
        for (const child of node.children)
            return child.baseToSpreadTransform.decompose().rotation;
    }
    return node.baseToSpreadTransform.decompose().rotation;
}

function getIntrinsicSize(node) {
    let d, bb;
    if (node[Symbol.toStringTag] === 'GroupNode') {
        for (const child of node.children) {
            d = child.baseToSpreadTransform.decompose();
            bb = child.baseBox;
            return { w: Math.abs(d.scaleX) * bb.width, h: Math.abs(d.scaleY) * bb.height };
        }
    }
    d = node.baseToSpreadTransform.decompose();
    bb = node.baseBox;
    return { w: Math.abs(d.scaleX) * bb.width, h: Math.abs(d.scaleY) * bb.height };
}

// ─── Capture selection BEFORE dialog (dialog clears it) ───────────────────────

const allNodes = [], seen = [];
for (const n of doc.selection.nodes) {
    if (!seen.some(s => s.isSameNode(n))) { seen.push(n); allNodes.push(n); }
}
const topLevel = allNodes.filter(n => {
    let p = n.parent;
    while (p) { if (allNodes.some(s => s.isSameNode(p))) return false; p = p.parent; }
    return true;
});

if (topLevel.length < 2) { console.log('Select at least 2 objects.'); return; }

// ─── Labels ───────────────────────────────────────────────────────────────────

const dropLabels = topLevel.map((n, i) => {
    const b   = n.getSpreadBaseBox(false);
    const raw = n.userDescription || n.defaultDescription || '?';
    const nm  = raw.length > 22 ? raw.slice(0, 21) + '…' : raw;
    const tag = n[Symbol.toStringTag].replace('Node', '');
    return `[${i+1}] ${nm}  ${b.width.toFixed(0)}×${b.height.toFixed(0)}  (${tag})`;
});

const rowLabels = topLevel.map((n, i) => {
    const b   = n.getSpreadBaseBox(false);
    const raw = n.userDescription || n.defaultDescription || '?';
    const nm  = raw.length > 16 ? raw.slice(0, 15) + '…' : raw;
    return `[${i+1}] ${nm}  ${b.width.toFixed(0)}×${b.height.toFixed(0)}`;
});

// ─── Smart defaults ───────────────────────────────────────────────────────────

function defaultFor(i) {
    if (topLevel.length === 2) return i === 0 ? 1 : 0;
    return i;
}

// ─── Sync: close open chains into cycles ──────────────────────────────────────

function syncCycles(combos) {
    const mapping   = combos.map(c => c.selectedIndex);
    const processed = new Array(combos.length).fill(false);
    for (let start = 0; start < combos.length; start++) {
        if (processed[start] || mapping[start] === start) { processed[start] = true; continue; }
        let cur = start;
        while (!processed[cur]) {
            processed[cur] = true;
            const next = mapping[cur];
            if (next === start) break;
            if (next === cur || processed[next]) {
                combos[cur].selectedIndex = start;
                mapping[cur] = start;
                break;
            }
            cur = next;
        }
    }
}

// ─── Swap engine ──────────────────────────────────────────────────────────────

function doSwap(mapping, adoptDims, adoptOrient) {
    const active = [];
    for (let i = 0; i < mapping.length; i++) if (mapping[i] !== i) active.push(i);
    if (active.length === 0) return 0;

    // Snapshot BEFORE any mutation
    const snap = topLevel.map(n => {
        const bb = n.getSpreadBaseBox(false);
        return {
            node : n,
            cx   : bb.x + bb.width  / 2,
            cy   : bb.y + bb.height / 2,
            rot  : getVisualRotation(n),
            sz   : getIntrinsicSize(n)
        };
    });

    // Duplicate each active node (each is its own undo step)
    const dups = [];
    for (const i of active) {
        const dup = snap[i].node.duplicate(null);
        if (dup) dups.push({ i, dup });
    }
    if (dups.length === 0) return 0;

    const cb = CompoundCommandBuilder.create();

    for (const { i, dup } of dups) {
        const j   = mapping[i];
        const src = snap[i];
        const dst = snap[j];

        // 1. Translate to destination centre
        const t1 = new TransformBuilder();
        t1.translate(dst.cx - src.cx, dst.cy - src.cy);
        cb.addCommand(DocumentCommand.createTransform(dup.selfSelection, t1.transform));

        // 2. Scale to destination size
        if (adoptDims && src.sz.w > 0 && dst.sz.w > 0) {
            const sx = dst.sz.w / src.sz.w;
            const sy = dst.sz.h / src.sz.h;
            if (Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01) {
                const t2 = new TransformBuilder();
                t2.translate(-dst.cx, -dst.cy);
                t2.scale(sx, sy);
                t2.translate(dst.cx, dst.cy);
                cb.addCommand(DocumentCommand.createTransform(dup.selfSelection, t2.transform));
            }
        }

        // 3. Rotate to destination orientation
        if (adoptOrient) {
            const delta = dst.rot - src.rot;
            if (Math.abs(delta) > 0.001) {
                const t3 = new TransformBuilder();
                t3.translate(-dst.cx, -dst.cy);
                t3.rotate(delta);
                t3.translate(dst.cx, dst.cy);
                cb.addCommand(DocumentCommand.createTransform(dup.selfSelection, t3.transform));
            }
        }

        // 4. Z-order: beside destination
        cb.addCommand(DocumentCommand.createMoveNodes(
            dup.selfSelection, dst.node, NodeMoveType.After, NodeChildType.Main
        ));
    }

    // 5. Delete originals
    for (const i of active) {
        cb.addCommand(DocumentCommand.createDeleteSelection(snap[i].node.selfSelection, true));
    }

    // 6. Re-select: all dups + all unchanged nodes → restores full selection
    const activeSet = new Set(active);
    const newSel    = dups[0].dup.selfSelection;
    for (let k = 1; k < dups.length; k++) newSel.addNode(dups[k].dup);
    for (let i = 0; i < topLevel.length; i++) {
        if (!activeSet.has(i)) newSel.addNode(topLevel[i]);
    }
    cb.addCommand(DocumentCommand.createSetSelection(newSel));

    doc.executeCommand(cb.createCommand());
    return dups.length + 1;   // N dup steps + 1 compound
}

// ─── Build dialogs ────────────────────────────────────────────────────────────

const totalPages  = Math.ceil(topLevel.length / PAGE_SIZE);
const pageDialogs = [];

for (let p = 0; p < totalPages; p++) {
    const hasPrev     = p > 0;
    const hasNext     = p < totalPages - 1;
    const pageEntries = topLevel.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
    const pageStart   = p * PAGE_SIZE;

    const title = totalPages > 1 ? `${APP_NAME}  (${p+1} / ${totalPages})` : APP_NAME;
    const dlg   = Dialog.create(title);
    dlg.initialWidth = 540;
    const col   = dlg.addColumn();

    const combos = [];
    for (let i = 0; i < pageEntries.length; i++) {
        const globalIdx = pageStart + i;
        const g         = col.addGroup('');
        if (i > 0) g.enableSeparator = true;
        const combo       = g.addComboBox(rowLabels[globalIdx], dropLabels, defaultFor(globalIdx));
        combo.isFullWidth = true;
        combos.push({ idx: globalIdx, combo });
    }

    const foot = col.addGroup('Options');
    foot.enableSeparator = true;
    const ckOrient = foot.addCheckBox('Swap orientation', true);  ckOrient.isFullWidth = true;
    const ckDims   = foot.addCheckBox('Swap dimensions',  false); ckDims.isFullWidth   = true;

    let prevCk = null, nextCk = null;
    if (hasPrev) { prevCk = foot.addCheckBox('◀  Prev page', false); prevCk.isFullWidth = true; }
    if (hasNext) { nextCk = foot.addCheckBox('▶  Next page', false); nextCk.isFullWidth = true; }

    const btns = foot.addButtonSet('', ['Preview', 'Apply'], 0);
    btns.isFullWidth = true;

    pageDialogs.push({ dlg, combos, btns, prevCk, nextCk, ckOrient, ckDims });
}

function allCombos() {
    const flat = [];
    for (const pd of pageDialogs) for (const c of pd.combos) flat.push(c.combo);
    return flat;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

let undoCount = 0, previewActive = false, running = true, currentPage = 0;

while (running) {
    const pd = pageDialogs[currentPage];
    if (pd.prevCk) pd.prevCk.value = false;
    if (pd.nextCk) pd.nextCk.value = false;
    pd.btns.selectedIndex = 0;

    const r = pd.dlg.show();

    if (r.value !== DialogResult.Ok.value) {
        // Cancel — undo preview
        if (previewActive) for (let i = 0; i < undoCount; i++) doc.executeCommand(DocumentCommand.createUndo());
        break;
    }

    if (pd.prevCk && pd.prevCk.value) { currentPage--; continue; }
    if (pd.nextCk && pd.nextCk.value) { currentPage++; continue; }

    const flat        = allCombos();
    syncCycles(flat);
    const mapping     = flat.map(c => c.selectedIndex);
    const adoptOrient = pd.ckOrient.value;
    const adoptDims   = pd.ckDims.value;

    // Undo previous preview
    if (previewActive) {
        for (let i = 0; i < undoCount; i++) doc.executeCommand(DocumentCommand.createUndo());
        previewActive = false;
        undoCount     = 0;
    }

    undoCount     = doSwap(mapping, adoptDims, adoptOrient);
    previewActive = undoCount > 0;

    if (pd.btns.selectedIndex === 1) {
        // Apply — keep, close
        undoCount     = 0;
        previewActive = false;
        running       = false;
    }
    // Preview — loop continues, dialog reopens
}
