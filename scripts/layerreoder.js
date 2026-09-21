// ════════════════════════════════════════════════════════════════
// Layer Reorder  v8-EN  – English GUI
// 13 modes + "What to change" option:
//   Stack order only | Object positions only | Both
// ════════════════════════════════════════════════════════════════

const { app }             = require('/application');
const { Document }        = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { DocumentCommand } = require('/commands');
const { NodeChildType }   = require('/nodes');
const { NodeMoveType }    = require('affinity:dom');
const { Transform }       = require('/geometry');

const doc = Document.current;
if (!doc) { app.alert('No document open.', 'Layer Reorder'); return; }

// ── Children as array  [0]=bottom, [last]=top ───────────────────
function getChildren(grp) {
    const arr = [];
    for (const ch of grp.children) arr.push(ch);
    return arr;
}

// ── Spread-space centre of a node ───────────────────────────────
function getSpreadCenter(node) {
    const bb = node.getSpreadBaseBox(false);
    if (!bb) return { x: 0, y: 0 };
    return { x: bb.x + bb.width * 0.5, y: bb.y + bb.height * 0.5 };
}

// ── Translate node by (dx, dy) in spread coordinates ────────────
function moveNodeByDelta(node, dx, dy) {
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;
    const xf = new Transform(1, 0, dx, 0, 1, dy);
    doc.executeCommand(DocumentCommand.createTransform(
        node.selfSelection, xf, { mergeable: false }));
}

// ── Base point for Explosion / Implosion ────────────────────────
function findBasePoint(grp, children) {
    for (const ch of children) {
        const name = (ch.userDescription || ch.defaultDescription || '').trim();
        if (name === '_PD' || name === '_pd') {
            return { pivot: getSpreadCenter(ch), pdNode: ch };
        }
    }
    const bb = grp.getSpreadBaseBox(false);
    if (bb) return { pivot: { x: bb.x + bb.width * 0.5, y: bb.y + bb.height * 0.5 }, pdNode: null };
    return { pivot: { x: 0, y: 0 }, pdNode: null };
}

// ── LCG random generator with seed ──────────────────────────────
function seededRandom(seed) {
    let s = seed >>> 0;
    return function () {
        s = (Math.imul(1664525, s) + 1013904223) >>> 0;
        return s / 0xFFFFFFFF;
    };
}

// ── Bit-reversal permutation ─────────────────────────────────────
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

// ── Step-N rotation ──────────────────────────────────────────────
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

// ── Compute new order ────────────────────────────────────────────
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

        case 6:
            return bitReversalOrder(n).map(i => arr[i]);

        case 7:
            return stepNOrder(arr, Math.max(2, p.step));

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
            const tagged = arr.map(node => {
                const c = getSpreadCenter(node);
                return { node, cx: c.x, cy: c.y };
            });
            const byY = tagged.slice().sort((a, b) => a.cy - b.cy);
            const rows = [];
            for (const item of byY) {
                let placed = false;
                for (const row of rows) {
                    if (Math.abs(item.cy - row.refY) <= tol) {
                        row.items.push(item);
                        placed = true;
                        break;
                    }
                }
                if (!placed) rows.push({ refY: item.cy, items: [item] });
            }
            rows.sort((a, b) => p.yTopToBottom ? a.refY - b.refY : b.refY - a.refY);
            for (const row of rows) {
                row.items.sort((a, b) => p.xLeftToRight ? a.cx - b.cx : b.cx - a.cx);
            }
            const res = [];
            for (const row of rows) res.push(...row.items.map(t => t.node));
            return res;
        }

        case 11: {
            const { pivot, pdNode } = findBasePoint(grp, arr);
            const toSort = pdNode ? arr.filter(n => !n.isSameNode(pdNode)) : arr.slice();
            const tagged = toSort.map(node => {
                const c = getSpreadCenter(node);
                const dx = c.x - pivot.x, dy = c.y - pivot.y;
                return { node, dist: Math.sqrt(dx * dx + dy * dy) };
            });
            tagged.sort((a, b) => a.dist - b.dist);
            const res = tagged.map(t => t.node);
            if (pdNode) res.push(pdNode);
            return res;
        }

        case 12: {
            const { pivot, pdNode } = findBasePoint(grp, arr);
            const toSort = pdNode ? arr.filter(n => !n.isSameNode(pdNode)) : arr.slice();
            const tagged = toSort.map(node => {
                const c = getSpreadCenter(node);
                const dx = c.x - pivot.x, dy = c.y - pivot.y;
                return { node, dist: Math.sqrt(dx * dx + dy * dy) };
            });
            tagged.sort((a, b) => b.dist - a.dist);
            const res = tagged.map(t => t.node);
            if (pdNode) res.push(pdNode);
            return res;
        }

        default: return arr.slice();
    }
}

// ── Reorder stack ────────────────────────────────────────────────
function reorderGroup(grp, newOrder) {
    const n = newOrder.length;
    if (n < 2) return 0;
    let steps = 0;
    let bottom = null;
    for (const ch of grp.children) { bottom = ch; break; }
    if (bottom && !bottom.isSameNode(newOrder[0])) {
        doc.executeCommand(DocumentCommand.createMoveNodes(
            newOrder[0].selfSelection, bottom, NodeMoveType.Before, NodeChildType.Main));
        steps++;
    }
    for (let i = 1; i < n; i++) {
        doc.executeCommand(DocumentCommand.createMoveNodes(
            newOrder[i].selfSelection, newOrder[i - 1], NodeMoveType.After, NodeChildType.Main));
        steps++;
    }
    return steps;
}

// ── Collect selected groups ──────────────────────────────────────
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

// ── Preview management ───────────────────────────────────────────
let previewSteps = 0;
function undoPreview() {
    for (let i = 0; i < previewSteps; i++) doc.undo();
    previewSteps = 0;
}

function runAction(groups, mode, params, doStack, doPos) {
    let total = 0;
    for (const grp of groups) {
        const arr      = getChildren(grp);
        const newOrder = computeOrder(arr, mode, params, grp);

        if (doPos) {
            const slots = arr.map(n => getSpreadCenter(n));
            if (doStack) total += reorderGroup(grp, newOrder);
            for (let i = 0; i < newOrder.length; i++) {
                const node   = newOrder[i];
                const target = slots[i];
                const cur    = getSpreadCenter(node);
                const dx = target.x - cur.x, dy = target.y - cur.y;
                if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
                    moveNodeByDelta(node, dx, dy);
                    total++;
                }
            }
        } else {
            total += reorderGroup(grp, newOrder);
        }
    }
    return total;
}

// ════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════
const groups = getSelectedGroups();
if (groups.length === 0) {
    app.alert('Please select at least one group.', 'Layer Reorder');
    return;
}

// ── Dialog ──────────────────────────────────────────────────────
const dlg = Dialog.create('Layer Reorder');
dlg.initialWidth = 460;
dlg.setIsResizable(true);

const col = dlg.addColumn();

col.addGroup('').addStaticText('',
    groups.length === 1 ? '1 group selected' : groups.length + ' groups selected');

const grpMode = col.addGroup('Sorting Mode');
const modeCombo = grpMode.addComboBox('Mode', [
    ' 0  Reverse Order',
    ' 1  Pairwise Swap',
    ' 2  Ring Shift',
    ' 3  Random Order',
    ' 4  Interleave',
    ' 5  Seeded Random',
    ' 6  Butterfly / Bit-Reversal',
    ' 7  Step-N Rotation',
    ' 8  By X-Position (left/right)',
    ' 9  By Y-Position (top/bottom)',
    '10  Reading Order (row by row)',
    '11  Explosion (inside → outside)',
    '12  Implosion (outside → inside)'
], 0);

// ── Action option ────────────────────────────────────────────────
const grpOpt = col.addGroup('Action');
const actionCombo = grpOpt.addComboBox('What should change?', [
    'Layer stack order only',
    'Object positions only',
    'Both (stack + positions)'
], 0);

// ── Parameters ───────────────────────────────────────────────────
const grpParam = col.addGroup('Parameters');

const pairCombo = grpParam.addComboBox('Pair Offset',
    ['1↔2, 3↔4 …  (start at obj. 1)', '2↔3, 4↔5 …  (start at obj. 2)'], 0);

const ringEditor = grpParam.addUnitValueEditor('Ring Shift – Offset',
    'none', 'none', null, 1, 9999);
ringEditor.value = 1;

const interleaveCombo = grpParam.addComboBox('Interleave – Start',
    ['Bottom first  1, n/2+1, 2, n/2+2 …',
     'Top first     n/2+1, 1, n/2+2, 2 …'], 0);

const seedEditor = grpParam.addUnitValueEditor('Seeded Random – Seed',
    'none', 'none', null, 0, 999999);
seedEditor.value = 42;

const stepEditor = grpParam.addUnitValueEditor('Step-N – Step Size',
    'none', 'none', null, 2, 9999);
stepEditor.value = 3;

const xDirCombo = grpParam.addComboBox('X Direction',
    ['Left → Right', 'Right → Left'], 0);

const yDirCombo = grpParam.addComboBox('Y Direction',
    ['Top → Bottom', 'Bottom → Top'], 0);

const tolEditor = grpParam.addUnitValueEditor('Row Tolerance (pt)',
    'none', 'none', null, 1, 9999);
tolEditor.value = 20;

// ── Status + Buttons ─────────────────────────────────────────────
const grpStatus = col.addGroup('');
const statusText = grpStatus.addStaticText('', '');

const grpBtn = col.addGroup('');
const btnSet = grpBtn.addButtonSet('', ['Preview', 'Apply'], 0);

const modeHelp = [
    'Reverses the order of all objects completely.',
    'Swaps each pair of adjacent objects.',
    'Cyclic rotation upward. Offset 2, n=7 → 3,4,5,6,7,1,2',
    'Random order (not reproducible).',
    'Interweaves lower and upper halves. n=8 → 1,5,2,6,3,7,4,8',
    'Reproducible random – same seed, same sequence.',
    'Butterfly pattern (FFT). n=8 → 1,5,3,7,2,6,4,8',
    'Josephus pick. Step 3, n=9 → 3,6,9,4,8,5,2,7,1',
    'Sorts by X centre. Bottommost layer = leftmost object.',
    'Sorts by Y centre. Bottommost layer = topmost object on canvas.',
    'Row-by-row reading order (Y rows, then X within each row).',
    'Explosion: closest to centre → bottom, furthest → top.\n_PD object used as base point if present.',
    'Implosion: furthest from centre → bottom, closest → top.\n_PD object used as base point if present.'
];

function refreshStatus() {
    let pdFound = false;
    if (modeCombo.selectedIndex >= 11) {
        for (const grp of groups) {
            for (const ch of grp.children) {
                const name = (ch.userDescription || ch.defaultDescription || '').trim();
                if (name === '_PD' || name === '_pd') { pdFound = true; break; }
            }
            if (pdFound) break;
        }
    }
    let txt = modeHelp[modeCombo.selectedIndex] || '';
    if (modeCombo.selectedIndex >= 11) {
        txt += pdFound
            ? '\n→ _PD object detected – used as base point.'
            : '\n→ No _PD object – group centre used as base point.';
    }
    const ai = actionCombo.selectedIndex;
    if (ai === 1) txt += '\n→ Positions only – stack order unchanged.';
    else if (ai === 2) txt += '\n→ Both stack order and positions will change.';
    statusText.setText(txt);
}

modeCombo.setOnValueChangedHandler(refreshStatus);
actionCombo.setOnValueChangedHandler(refreshStatus);
refreshStatus();

// ── Dialog loop ──────────────────────────────────────────────────
while (true) {
    const result = dlg.runModal();
    if (!result || result.value === DialogResult.Cancel.value) {
        undoPreview();
        break;
    }

    const action    = btnSet.selectedIndex;
    const mode      = modeCombo.selectedIndex;
    const actionIdx = actionCombo.selectedIndex;
    const doStack   = actionIdx !== 1;
    const doPos     = actionIdx >= 1;

    const params = {
        pairOffset        : pairCombo.selectedIndex,
        ringShift         : Math.max(1, Math.round(ringEditor.value)),
        interleaveTopFirst: interleaveCombo.selectedIndex === 1,
        seed              : Math.round(seedEditor.value),
        step              : Math.max(2, Math.round(stepEditor.value)),
        xLeftToRight      : xDirCombo.selectedIndex === 0,
        yTopToBottom      : yDirCombo.selectedIndex === 0,
        rowTolerance      : Math.max(1, Math.round(tolEditor.value))
    };

    if (action === 0) {
        undoPreview();
        previewSteps = runAction(groups, mode, params, doStack, doPos);
        statusText.setText('Preview: ' + previewSteps + ' steps applied. Apply or Cancel.');
    } else {
        if (previewSteps === 0) runAction(groups, mode, params, doStack, doPos);
        previewSteps = 0;
        break;
    }
}
