'use strict';

const { Document } = require('/document');
const { DocumentCommand, CompoundCommandBuilder } = require('/commands');
const { Dialog, DialogResult, HorizontalAlignment } = require('/dialog');
const { RGBA8, Colour } = require('/colours');
const { FillType, SolidFill, GradientFill, FillDescriptor } = require('/fills');
const { Selection } = require('/selections');
const { TransformBuilder } = require('/geometry');
const { app } = require('/application');

const APP_NAME = 'ReplaceColorFill';
const PAGE_SIZE = 9;

// Transform in LOCAL space
function makeGradientTransform(node) {
    try {
        const bbox = node.baseBox;
        if (!bbox || bbox.width <= 0) return null;

        const tb = new TransformBuilder();
        tb.scale(bbox.width, bbox.width);
        tb.translate(bbox.x, bbox.y + bbox.height / 2);

        return tb.transform;
    } catch (_) {
        return null;
    }
}

function getNodeFillInfo(node) {
    try {
        const fd = node.brushFillDescriptor;
        if (!fd) return null;

        const fill = fd.fill;
        if (!fill) return null;

        if (fill.fillType.value === FillType.Solid.value) {
            const { r, g, b } = fill.colour.rgba8;
            return {
                type: 'solid',
                key: 's:' + r + ',' + g + ',' + b,
                initFill: fill,
                origFd: fd
            };
        }

        if (fill.fillType.value === FillType.Gradient.value) {
            const grad = fill.gradient;

            const stopKey = grad.stops.map(function (s) {
                try {
                    const c = new Colour(s.colour).rgba8;
                    return c.r + ',' + c.g + ',' + c.b + '@' + s.position.toFixed(3);
                } catch (_) {
                    return '?';
                }
            }).join('|');

            return {
                type: 'gradient',
                key: 'g:' + stopKey,
                initFill: fill,
                origFd: fd
            };
        }

        return null;
    } catch (_) {
        return null;
    }
}

function applyAllPicks(doc, pageDialogs) {
    const cb = CompoundCommandBuilder.create();
    let count = 0;
    let firstErr = null;

    for (const pd of pageDialogs) {
        for (const { e, fe } of pd.pickers) {

            let rawFill;
            try {
                rawFill = fe.fill;
            } catch (err) {
                firstErr = firstErr || ('fe.fill threw: ' + err.message);
                continue;
            }

            if (!rawFill) {
                firstErr = firstErr || 'fe.fill returned null';
                continue;
            }

            const ftv = rawFill.fillType ? rawFill.fillType.value : null;
            const ofd = e.origFd;

            for (const n of e.nodes) {
                try {
                    let newFd;

                    if (ftv === FillType.Gradient.value) {

                        const freshGrad = rawFill.gradient.clone();
                        const applyFill = GradientFill.create(freshGrad, rawFill.gradientFillType);

                        const gradTransform = makeGradientTransform(n) || ofd.transform;

                        newFd = FillDescriptor.create(
                            applyFill,
                            true,
                            gradTransform,
                            ofd.blendMode,
                            false
                        );

                    } else if (ftv === FillType.Solid.value) {

                        newFd = FillDescriptor.createSolid(rawFill.colour, ofd.blendMode);

                    } else {
                        firstErr = firstErr || ('Unknown fillType: ' + ftv);
                        continue;
                    }

                    cb.addCommand(
                        DocumentCommand.createSetBrushFill(
                            Selection.create(doc, n),
                            newFd
                        )
                    );

                    count++;

                } catch (err) {
                    firstErr = firstErr || ('apply threw: ' + err.message);
                }
            }
        }
    }

    if (count > 0) doc.executeCommand(cb.createCommand());
    if (firstErr) app.alert('Apply error (debug):\n' + firstErr, APP_NAME);

    return count;
}

// ── Validation ─────────────────────────────

const doc = Document.current;

if (!doc) {
    app.alert('No document open.', APP_NAME);
    return;
}

const selNodes = [];
for (const n of doc.selection.nodes) selNodes.push(n);

if (selNodes.length === 0) {
    app.alert('No objects selected.\nSelect at least one and run again.', APP_NAME);
    return;
}

const colorMap = new Map();

for (const n of selNodes) {
    const info = getNodeFillInfo(n);
    if (!info) continue;

    if (!colorMap.has(info.key)) {
        colorMap.set(info.key, {
            type: info.type,
            initFill: info.initFill,
            origFd: info.origFd,
            nodes: []
        });
    }

    colorMap.get(info.key).nodes.push(n);
}

if (colorMap.size === 0) {
    app.alert('No solid or gradient fills found.', APP_NAME);
    return;
}

const entries = Array.from(colorMap.values());
const totalPages = Math.ceil(entries.length / PAGE_SIZE);
const pageDialogs = [];

for (let p = 0; p < totalPages; p++) {

    const hasPrev = p > 0;
    const hasNext = p < totalPages - 1;
    const pageEntries = entries.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);

    const title = totalPages > 1
        ? APP_NAME + ' (' + (p + 1) + ' / ' + totalPages + ')'
        : APP_NAME;

    const dlg = Dialog.create(title);
    dlg.initialWidth = 360;

    const colSrc = dlg.addColumn(); colSrc.widthProportion = 1;
    const colDst = dlg.addColumn(); colDst.widthProportion = 1;

    const hdrS = colSrc.addGroup('');
    hdrS.addStaticText('', 'Colour').isFullWidth = true;

    const hdrD = colDst.addGroup('');
    hdrD.addStaticText('', 'Replace with').isFullWidth = true;

    const pickers = [];

    for (let i = 0; i < pageEntries.length; i++) {
        const e = pageEntries[i];

        const gS = colSrc.addGroup('');
        if (i > 0) gS.enableSeparator = true;

        const gD = colDst.addGroup('');
        if (i > 0) gD.enableSeparator = true;

        const srcFe = gS.addFillEditor('', e.initFill);
        srcFe.isFullWidth = true;

        const fe = gD.addFillEditor('', e.initFill);
        fe.isFullWidth = true;

        pickers.push({ e, fe });
    }

    const footS = colSrc.addGroup('');
    footS.enableSeparator = true;

    const footD = colDst.addGroup('');
    footD.enableSeparator = true;

    let prevCk = null;
    if (hasPrev) {
        prevCk = footS.addCheckBox('◀ Prev page', false);
        prevCk.isFullWidth = true;
    }

    let nextCk = null;
    if (hasNext) {
        nextCk = footS.addCheckBox('▶ Next page', false);
        nextCk.isFullWidth = true;
    }

    if (totalPages > 1) {
        const hint = footD.addStaticText('', 'Tick ▶/◀ + OK to navigate');
        hint.isFullWidth = true;
        hint.textHorizontalAlignment = HorizontalAlignment.Right;
    }

    const btns = footD.addButtonSet('', ['Preview', 'Apply'], 0);
    btns.isFullWidth = true;

    pageDialogs.push({ dlg, pickers, btns, prevCk, nextCk });
}

// ── Main loop ─────────────────────────────

let previewActive = false;
let running = true;
let currentPage = 0;

while (running) {

    const pd = pageDialogs[currentPage];

    if (pd.prevCk) pd.prevCk.value = false;
    if (pd.nextCk) pd.nextCk.value = false;

    pd.btns.selectedIndex = 0;

    const r = pd.dlg.show();

    if (r.value !== DialogResult.Ok.value) {
        if (previewActive) doc.executeCommand(DocumentCommand.createUndo());
        break;
    }

    if (pd.prevCk && pd.prevCk.value) {
        currentPage--;
    } else if (pd.nextCk && pd.nextCk.value) {
        currentPage++;
    } else {

        if (previewActive)
            doc.executeCommand(DocumentCommand.createUndo());

        const changed = applyAllPicks(doc, pageDialogs);
        previewActive = changed > 0;

        if (pd.btns.selectedIndex === 1)
            running = false;
    }
}