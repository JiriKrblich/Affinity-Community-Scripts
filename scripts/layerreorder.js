// ════════════════════════════════════════════════════════════════
// Arrange Layers  v11
// 13 modes + option "swap object positions"
//
// New in v9:
//  - Single dialog (one runModal): "Preview" keeps the dialog open,
//    OK = Apply, Cancel/X/ESC = reset everything.
//  - OK recalculates if settings changed since the last preview. With unchanged
//    settings the preview is kept (important for mode 3, true random).
//
// New in v10:
//  - A complete pass is ONE command (CompoundCommand) instead of one step per move.
//
// New in v11:
//  - Native preview: doc.executeCommand(cmd,true) - the preview no longer creates
//    history entries and replaces the previous one; Cancel = doc.clearPreviews().
//  - No history position any more (v10 jumped back via doc.history.position, which no
//    longer counts reliably with a full history). Apply = exactly ONE entry.
//  - The plan (orders + centres) is calculated once from the start state; OK with
//    unchanged settings applies exactly the shown preview.
//  - Errors while calculating leave the document unchanged (nothing was executed).
// ════════════════════════════════════════════════════════════════

const { app }             = require('/application');
const { Document }        = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { NodeChildType }   = require('/nodes');
const { NodeMoveType }    = require('affinity:dom');
const { Transform }       = require('/geometry');

const doc = Document.current;

function getChildren(grp) {
    const arr = [];
    for (const ch of grp.children) arr.push(ch);
    return arr;
}
function getSpreadCenter(node) {
    const bb = node.getSpreadBaseBox(false);
    if (!bb) return { x: 0, y: 0 };
    return { x: bb.x + bb.width * 0.5, y: bb.y + bb.height * 0.5 };
}
function moveNodeByDelta(add, node, dx, dy) {
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;
    add(DocumentCommand.createTransform(
        node.selfSelection, new Transform(1, 0, dx, 0, 1, dy), { mergeable: false }));
}
function isPdName(node) {
    const name = (node.userDescription || node.defaultDescription || '').trim();
    return name === '_PD' || name === '_pd';
}
function findBasePoint(grp, children) {
    for (const ch of children) {
        if (isPdName(ch)) return { pivot: getSpreadCenter(ch), pdNode: ch };
    }
    const bb = grp.getSpreadBaseBox(false);
    if (bb) return { pivot: { x: bb.x + bb.width * 0.5, y: bb.y + bb.height * 0.5 }, pdNode: null };
    return { pivot: { x: 0, y: 0 }, pdNode: null };
}
function seededRandom(seed) {
    let s = seed >>> 0;
    return function () {
        s = (Math.imul(1664525, s) + 1013904223) >>> 0;
        return s / 0xFFFFFFFF;
    };
}
function bitReversalOrder(n) {
    let bits = 0;
    while ((1 << bits) < n) bits++;
    const result = [], seen = new Set();
    for (let i = 0; i < (1 << bits); i++) {
        let rev = 0;
        for (let b = 0; b < bits; b++)
            if (i & (1 << b)) rev |= (1 << (bits - 1 - b));
        if (rev < n && !seen.has(rev)) { seen.add(rev); result.push(rev); }
    }
    for (let i = 0; i < n; i++) if (!seen.has(i)) result.push(i);
    return result;
}
function stepNOrder(arr, step) {
    const pool = arr.slice(), res = [];
    let pos = 0;
    while (pool.length > 0) {
        pos = (pos + step - 1) % pool.length;
        res.push(pool.splice(pos, 1)[0]);
        if (pos >= pool.length) pos = 0;
    }
    return res;
}
function sortByDistance(grp, arr, nearFirst) {
    const { pivot, pdNode } = findBasePoint(grp, arr);
    const toSort = pdNode ? arr.filter(n => !n.isSameNode(pdNode)) : arr.slice();
    const tagged = toSort.map(node => {
        const c = getSpreadCenter(node);
        const dx = c.x - pivot.x, dy = c.y - pivot.y;
        return { node, dist: Math.sqrt(dx * dx + dy * dy) };
    });
    tagged.sort((a, b) => nearFirst ? a.dist - b.dist : b.dist - a.dist);
    const res = tagged.map(t => t.node);
    if (pdNode) res.push(pdNode);
    return res;
}
function computeOrder(arr, mode, p, grp) {
    const n = arr.length;
    if (n < 2) return arr.slice();
    switch (mode) {
        case 0: return arr.slice().reverse();
        case 1: {
            const res = arr.slice();
            for (let i = p.pairOffset; i + 1 < n; i += 2) {
                const t = res[i]; res[i] = res[i + 1]; res[i + 1] = t;
            }
            return res;
        }
        case 2: {
            const s = ((p.ringShift % n) + n) % n;
            return s === 0 ? arr.slice() : arr.slice(s).concat(arr.slice(0, s));
        }
        case 3: {
            const res = arr.slice();
            for (let i = n - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                const t = res[i]; res[i] = res[j]; res[j] = t;
            }
            return res;
        }
        case 4: {
            const half = Math.ceil(n / 2);
            const low = arr.slice(0, half), high = arr.slice(half), res = [];
            for (let i = 0; i < half; i++) {
                if (p.interleaveTopFirst) {
                    if (i < high.length) res.push(high[i]);
                    res.push(low[i]);
                } else {
                    res.push(low[i]);
                    if (i < high.length) res.push(high[i]);
                }
            }
            return res;
        }
        case 5: {
            const rng = seededRandom(p.seed), res = arr.slice();
            for (let i = n - 1; i > 0; i--) {
                const j = Math.floor(rng() * (i + 1));
                const t = res[i]; res[i] = res[j]; res[j] = t;
            }
            return res;
        }
        case 6: return bitReversalOrder(n).map(i => arr[i]);
        case 7: return stepNOrder(arr, Math.max(2, p.step));
        case 8: {
            const tagged = arr.map(node => ({ node, cx: getSpreadCenter(node).x }));
            tagged.sort((a, b) => p.xLeftToRight ? a.cx - b.cx : b.cx - a.cx);
            return tagged.map(t => t.node);
        }
        case 9: {
            const tagged = arr.map(node => ({ node, cy: getSpreadCenter(node).y }));
            tagged.sort((a, b) => p.yTopToBottom ? a.cy - b.cy : b.cy - a.cy);
            return tagged.map(t => t.node);
        }
        case 10: {
            const tol = p.rowTolerance;
            const tagged = arr.map(node => { const c = getSpreadCenter(node); return { node, cx: c.x, cy: c.y }; });
            const byY = tagged.slice().sort((a, b) => a.cy - b.cy);
            const rows = [];
            for (const item of byY) {
                let placed = false;
                for (const row of rows) {
                    if (Math.abs(item.cy - row.refY) <= tol) { row.items.push(item); placed = true; break; }
                }
                if (!placed) rows.push({ refY: item.cy, items: [item] });
            }
            rows.sort((a, b) => p.yTopToBottom ? a.refY - b.refY : b.refY - a.refY);
            for (const row of rows) row.items.sort((a, b) => p.xLeftToRight ? a.cx - b.cx : b.cx - a.cx);
            const res = [];
            for (const row of rows) res.push(...row.items.map(t => t.node));
            return res;
        }
        case 11: return sortByDistance(grp, arr, true);
        case 12: return sortByDistance(grp, arr, false);
        default: return arr.slice();
    }
}
function reorderGroup(add, grp, newOrder) {
    const n = newOrder.length;
    if (n < 2) return;
    let bottom = null;
    for (const ch of grp.children) { bottom = ch; break; }
    if (bottom && !bottom.isSameNode(newOrder[0])) {
        add(DocumentCommand.createMoveNodes(
            newOrder[0].selfSelection, bottom, NodeMoveType.Before, NodeChildType.Main));
    }
    for (let i = 1; i < n; i++) {
        add(DocumentCommand.createMoveNodes(
            newOrder[i].selfSelection, newOrder[i - 1], NodeMoveType.After, NodeChildType.Main));
    }
}
// v11: calculate the plan from the start state (orders + centres), no commands.
// Read slots and centres BEFORE any change (reordering does not move anything).
function buildPlan(groups, mode, params, doPos) {
    const plan = [];
    for (const grp of groups) {
        const arr = getChildren(grp);
        const newOrder = computeOrder(arr, mode, params, grp);
        const slots = doPos ? arr.map(n => getSpreadCenter(n)) : null;
        const centres = doPos ? newOrder.map(n => getSpreadCenter(n)) : null;
        plan.push({ grp, newOrder, slots, centres });
    }
    return plan;
}
// v11: plan -> ONE compound command for all groups (null if there is nothing to do;
// an empty compound throws INVALID_OP)
function makeCommand(plan, doStack, doPos) {
    const builder = CompoundCommandBuilder.create();
    let count = 0;
    const add = (cmd) => { builder.addCommand(cmd); count++; };
    for (const it of plan) {
        if (doStack) reorderGroup(add, it.grp, it.newOrder);
        if (doPos) {
            for (let i = 0; i < it.newOrder.length; i++) {
                moveNodeByDelta(add, it.newOrder[i], it.slots[i].x - it.centres[i].x, it.slots[i].y - it.centres[i].y);
            }
        }
    }
    return count > 0 ? builder.createCommand() : null;
}

function getSelectedGroups() {
    const groups = [];
    for (const item of doc.selection.items) {
        const node = item.node;
        let hasChildren = false;
        try { for (const _ch of node.children) { hasChildren = true; break; } } catch (e) {}
        if (hasChildren) groups.push(node);
    }
    return groups;
}

function main() {
    if (!doc) { app.alert('No document open.', 'Arrange Layers'); return; }

    // Snapshot the selection once, never read it again
    const groups = getSelectedGroups();
    if (groups.length === 0) {
        app.alert('Please select at least one group.', 'Arrange Layers');
        return;
    }

    // v11: plan and settings of the last shown preview
    let previewKey = null, previewPlan = null;

    const dlg = Dialog.create('Arrange Layers v11');
    dlg.initialWidth = 460;
    dlg.setIsResizable(true);
    const col = dlg.addColumn();

    col.addGroup('').addStaticText('',
        groups.length === 1 ? '1 group selected' : groups.length + ' groups selected');

    const grpMode = col.addGroup('Arrangement');
    const modeCombo = grpMode.addComboBox('Mode', [
        ' 0  Reverse order',
        ' 1  Swap pairs',
        ' 2  Ring shift',
        ' 3  Random order',
        ' 4  Interleave',
        ' 5  Seeded random',
        ' 6  Butterfly / Bit-Reversal',
        ' 7  Step-N rotation',
        ' 8  By X position (left/right)',
        ' 9  By Y position (top/bottom)',
        '10  Row by row (reading order)',
        '11  Explosion (inside → out)',
        '12  Implosion (outside → in)'
    ], 0);

    const grpOpt = col.addGroup('Action');
    const actionCombo = grpOpt.addComboBox('What should change?', [
        'Layer order in stack',
        'Object positions on spread',
        'Both (stack + positions)'
    ], 0);

    const grpParam = col.addGroup('Parameter');
    const pairCombo = grpParam.addComboBox('Pair offset', ['1↔2, 3↔4 …', '2↔3, 4↔5 …'], 0);
    const ringEditor = grpParam.addUnitValueEditor('Ring shift – offset', 'none', 'none', null, 1, 9999);
    ringEditor.value = 1;
    const interleaveCombo = grpParam.addComboBox('Interleave – start',
        ['Bottom first  1, n/2+1, 2, n/2+2 …', 'Top first   n/2+1, 1, n/2+2, 2 …'], 0);
    const seedEditor = grpParam.addUnitValueEditor('Seeded random – seed', 'none', 'none', null, 0, 999999);
    seedEditor.value = 42;
    const stepEditor = grpParam.addUnitValueEditor('Step-N – step size', 'none', 'none', null, 2, 9999);
    stepEditor.value = 3;
    const xDirCombo = grpParam.addComboBox('X direction', ['Left → Right', 'Right → Left'], 0);
    const yDirCombo = grpParam.addComboBox('Y direction', ['Top → Bottom', 'Bottom → Top'], 0);
    const tolEditor = grpParam.addUnitValueEditor('Row tolerance (points)', 'none', 'none', null, 1, 9999);
    tolEditor.value = 20;

    const grpStatus = col.addGroup('');
    const statusText = grpStatus.addStaticText('', '');
    const grpBtn = col.addGroup('');
    const btnPreview = grpBtn.addButton('Preview');
    grpBtn.addStaticText('', 'OK = Apply, Cancel = reset everything.');

    const modeHelp = [
        'Reverses the order of all objects.',
        'Swaps adjacent objects in pairs.',
        'Cyclic rotation. Offset 2, n=7 → 3,4,5,6,7,1,2',
        'Random order (not reproducible). OK keeps the shown preview.',
        'Interleaves lower and upper half. n=8 → 1,5,2,6,3,7,4,8',
        'Reproducible random – same seed, same order.',
        'Butterfly pattern (FFT). n=8 → 1,5,3,7,2,6,4,8',
        'Josephus selection. Step 3, n=9 → 3,6,9,4,8,5,2,7,1',
        'Sorted by X centre.',
        'Sorted by Y centre.',
        'Row by row like reading order (Y rows → X within).',
        'Explosion: nearest to centre → bottom, farthest → top.\n_PD object as base point (if present).',
        'Implosion: farthest from centre → bottom, nearest → top.\n_PD object as base point (if present).'
    ];

    function readSettings() {
        const actionIdx = actionCombo.selectedIndex;
        return {
            mode: modeCombo.selectedIndex,
            doStack: actionIdx !== 1,
            doPos: actionIdx >= 1,
            params: {
                pairOffset        : pairCombo.selectedIndex,
                ringShift         : Math.max(1, Math.round(ringEditor.value)),
                interleaveTopFirst: interleaveCombo.selectedIndex === 1,
                seed              : Math.round(seedEditor.value),
                step              : Math.max(2, Math.round(stepEditor.value)),
                xLeftToRight      : xDirCombo.selectedIndex === 0,
                yTopToBottom      : yDirCombo.selectedIndex === 0,
                rowTolerance      : Math.max(1, Math.round(tolEditor.value))
            }
        };
    }
    function settingsKey(s) { return JSON.stringify(s); }

    function refreshStatus() {
        const idx = modeCombo.selectedIndex;
        let txt = modeHelp[idx] || '';
        if (idx >= 11) {
            let pdFound = false;
            for (const grp of groups) {
                for (const ch of grp.children) { if (isPdName(ch)) { pdFound = true; break; } }
                if (pdFound) break;
            }
            txt += pdFound ? '\n→ _PD found – used as base point.'
                           : '\n→ No _PD – group centre used as base point.';
        }
        const actionIdx = actionCombo.selectedIndex;
        if (actionIdx === 1) txt += '\n→ Positions only, stack order unchanged.';
        else if (actionIdx === 2) txt += '\n→ Stack AND positions will change.';
        statusText.setText(txt);
    }
    modeCombo.setOnValueChangedHandler(refreshStatus);
    actionCombo.setOnValueChangedHandler(refreshStatus);
    refreshStatus();

    btnPreview.setOnClickHandler(function () {
        const s = readSettings();
        doc.clearPreviews();
        previewKey = null; previewPlan = null;
        try {
            const plan = buildPlan(groups, s.mode, s.params, s.doPos);
            const cmd = makeCommand(plan, s.doStack, s.doPos);
            if (cmd) doc.executeCommand(cmd, true);
            previewPlan = plan; previewKey = settingsKey(s);
            statusText.setText('Preview active. OK = Apply, Cancel = reset.');
        } catch (e) {
            doc.clearPreviews();
            app.alert('Error: ' + e.message + '\nPreview discarded, the document is unchanged.', 'Arrange Layers');
        }
    });

    const result = dlg.runModal();
    if (!result || result.value !== DialogResult.Ok.value) {
        // v11: discard the preview - nothing was executed
        doc.clearPreviews();
        return;
    }
    // v11: apply an unchanged preview exactly, otherwise recalculate; ONE entry
    const s = readSettings();
    doc.clearPreviews();
    try {
        const plan = (previewPlan && previewKey === settingsKey(s)) ? previewPlan : buildPlan(groups, s.mode, s.params, s.doPos);
        const cmd = makeCommand(plan, s.doStack, s.doPos);
        if (cmd) doc.executeCommand(cmd);
    } catch (e) {
        doc.clearPreviews();
        app.alert('Error: ' + e.message + '\nThe document is unchanged.', 'Arrange Layers');
    }
}

main();
