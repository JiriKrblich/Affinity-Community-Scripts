/**
 * name: Smart Exporter
 * description: Export the selected artboard or selected objects to multiple formats in one run.
 * version: 1.4.0
 * author: JiriKrblich / Codex
 */

'use strict';

const { app } = require('/application');
const { Document, FileExportArea, FileExportOptions } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { DocumentCommand } = require('/commands');
const { Size } = require('/geometry');
const { Selection } = require('/selections');
const { EnumerationResult } = require('affinity:common');

const FORMATS = [
    { key: 'pdf', label: 'PDF', extension: 'pdf', raster: false, candidates: ['PDF', 'PDF (for export)', 'PDF/X-4', 'PDF/X-3', 'PDF/X-1a'] },
    { key: 'eps', label: 'EPS', extension: 'eps', raster: false, candidates: ['EPS'] },
    { key: 'svg', label: 'SVG', extension: 'svg', raster: false, candidates: ['SVG'] },
    { key: 'png', label: 'PNG', extension: 'png', raster: true, candidates: ['PNG'] },
    { key: 'jpg', label: 'JPG', extension: 'jpg', raster: true, candidates: ['JPEG', 'JPG'] }
];

function trim(text) {
    return String(text == null ? '' : text).replace(/^\s+|\s+$/g, '');
}

function norm(text) {
    return trim(text).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function pathJoin(folder, fileName) {
    const sep = folder.indexOf('\\') >= 0 ? '\\' : '/';
    return folder.replace(/[\\\/]+$/, '') + sep + fileName;
}

function sanitizeFileName(text) {
    const cleaned = trim(text || 'artboard')
        .replace(/[\\\/:*?"<>|#%{}$!'@+`=]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/^\.+|\.+$/g, '')
        .replace(/-+/g, '-');
    return cleaned || 'artboard';
}

function nodeLabel(node) {
    try {
        if (node.userDescription) return node.userDescription;
    } catch (e) {}
    try {
        if (node.description) return node.description;
    } catch (e2) {}
    try {
        if (node.name) return node.name;
    } catch (e3) {}
    return 'artboard';
}

function showMessage(title, message) {
    app.alert(message, title);
}

function selectedNodes(doc) {
    try {
        const sel = doc.selection;
        if (!sel || sel.length === 0) return [];
        return sel.nodes || [];
    } catch (e) {
        return [];
    }
}

function exactArtboardFromNode(node) {
    if (!node) return null;
    try {
        const abi = node.artboardInterface;
        if (abi && abi.isArtboardEnabled) {
            try {
                if (abi.node && node.isSameNode && node.isSameNode(abi.node)) return abi;
            } catch (sameError) {}
        }
    } catch (e) {}
    return null;
}

function findExportTarget(doc) {
    const nodes = selectedNodes(doc);
    if (nodes.length === 1) {
        const artboard = exactArtboardFromNode(nodes[0]);
        if (artboard) {
            return {
                type: 'artboard',
                label: sanitizeFileName(nodeLabel(artboard.node)),
                artboard,
                nodes: [artboard.node]
            };
        }
    }

    if (nodes.length > 0) {
        return {
            type: 'selection',
            label: nodes.length === 1 ? sanitizeFileName(nodeLabel(nodes[0])) : 'selection',
            artboard: null,
            nodes
        };
    }

    try {
        const artboards = doc.currentSpread.artboards;
        if (artboards.length === 1) {
            return {
                type: 'artboard',
                label: sanitizeFileName(nodeLabel(artboards[0].node)),
                artboard: artboards[0],
                nodes: [artboards[0].node]
            };
        }
    } catch (e) {}

    return null;
}

function allPresetNames() {
    const names = [];
    try {
        FileExportOptions.enumeratePresetNames(name => {
            names.push(String(name));
            return EnumerationResult.Continue;
        });
    } catch (e) {
        try {
            return FileExportOptions.allPresetNames || [];
        } catch (e2) {}
    }
    return names;
}

function findPreset(format, presets) {
    const normalized = presets.map(name => ({ name, key: norm(name) }));

    for (const candidate of format.candidates) {
        const exact = normalized.find(item => item.key === norm(candidate));
        if (exact) return exact.name;
    }

    for (const candidate of format.candidates) {
        const candidateKey = norm(candidate);
        const starts = normalized.find(item => item.key.indexOf(candidateKey) === 0);
        if (starts) return starts.name;
    }

    for (const candidate of format.candidates) {
        const candidateKey = norm(candidate);
        const contains = normalized.find(item => item.key.indexOf(candidateKey) >= 0);
        if (contains) return contains.name;
    }

    return null;
}

function showOptionsDialog(target, presets) {
    const dialog = Dialog.create('Smart Exporter v1.4');
    dialog.initialWidth = 520;

    const left = dialog.addColumn();
    const right = dialog.addColumn();
    const formatGroup = left.addGroup('Formats');
    const scaleGroup = right.addGroup('Scale');
    const textGroup = right.addGroup('Text');
    const infoGroup = right.addGroup('Target');

    const checks = {};
    for (const format of FORMATS) {
        const preset = findPreset(format, presets);
        checks[format.key] = formatGroup.addCheckBox(format.label, Boolean(preset));
        checks[format.key].isEnabled = Boolean(preset);
        if (!preset) checks[format.key].description = 'No matching export preset found in this Affinity installation.';
    }

    const scaleText = scaleGroup.addTextBox('Scale ratio', '1');
    scaleText.description = 'Safe mode applies scale to PNG/JPG only. Vector formats export at native artboard size.';

    const nameText = scaleGroup.addTextBox('File name', target.label);
    nameText.description = 'Extension is added automatically for each selected format.';

    const vectorizeText = textGroup.addCheckBox('Vectorize texts', false);
    vectorizeText.description = 'Duplicates the export target, converts the duplicate to curves, exports it, then removes the duplicate.';

    infoGroup.addStaticText('', target.type === 'artboard'
        ? 'Target: selected artboard. If there is only one artboard, it can be exported even when nothing is selected.'
        : 'Target: selected object/group/layer area.').isFullWidth = true;

    const result = dialog.runModal();
    if (result.value !== DialogResult.Ok.value) return null;

    const selected = FORMATS.filter(format => checks[format.key].value);
    const scale = Number(trim(scaleText.value || scaleText.text || '1'));
    const fileName = sanitizeFileName(nameText.value || nameText.text || target.label);

    if (!selected.length) throw new Error('Select at least one export format.');
    if (!isFinite(scale) || scale <= 0) throw new Error('Scale ratio must be a positive number.');

    return { formats: selected, scale, fileName, vectorizeTexts: vectorizeText.value };
}

function chooseOutputFolder() {
    const fallback = trim(app.userDesktopPath || app.getUserDesktopPath || '');
    const entered = app.prompt(
        'Output folder path. Affinity scripting may only have write permission to Desktop folders.',
        'Smart Exporter - Output Folder',
        fallback
    );
    return trim(entered);
}

function unionBoxes(boxes) {
    const valid = boxes.filter(box => box && isFinite(box.x) && isFinite(box.y) && isFinite(box.width) && isFinite(box.height));
    if (!valid.length) return null;
    let left = valid[0].x;
    let top = valid[0].y;
    let right = valid[0].x + valid[0].width;
    let bottom = valid[0].y + valid[0].height;
    for (const box of valid.slice(1)) {
        left = Math.min(left, box.x);
        top = Math.min(top, box.y);
        right = Math.max(right, box.x + box.width);
        bottom = Math.max(bottom, box.y + box.height);
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function targetBounds(target, nodesOverride) {
    if (target.type === 'artboard' && !nodesOverride) {
        try {
            return target.artboard.spreadBaseBox || target.artboard.baseBox;
        } catch (e) {}
    }

    const nodes = nodesOverride || target.nodes || [];
    const boxes = [];
    for (const node of nodes) {
        try {
            boxes.push(node.getSpreadVisibleBox(true));
        } catch (e) {
            try {
                boxes.push(node.spreadVisibleBox);
            } catch (e2) {}
        }
    }
    return unionBoxes(boxes);
}

function exportSizeForScale(target, nodesOverride, scale, format) {
    if (!format.raster) return null;
    if (Math.abs(scale - 1) < 0.0001) return null;
    const box = targetBounds(target, nodesOverride);
    if (!box || !box.width || !box.height) return null;
    return new Size(Math.max(1, Math.round(box.width * scale)), Math.max(1, Math.round(box.height * scale)));
}

function describeError(errorMessage) {
    if (!errorMessage) return '';
    if (typeof errorMessage === 'string') return errorMessage;
    const parts = [];
    try {
        if (errorMessage.title) parts.push(errorMessage.title);
    } catch (e) {}
    try {
        if (errorMessage.reason) parts.push(errorMessage.reason);
    } catch (e2) {}
    return parts.join(': ') || String(errorMessage);
}

function collectExportRecords(records) {
    const out = [];
    if (!records) return out;
    try {
        records.enumerate(record => {
            out.push({
                path: record.path,
                ok: record.isSuccess,
                warning: record.hasWarnings ? record.warningMessage : '',
                error: describeError(record.errorMessage)
            });
            return EnumerationResult.Continue;
        });
    } catch (e) {
        out.push({ path: '', ok: false, warning: '', error: e.message || String(e) });
    }
    return out;
}

function createArea(doc, target, nodesOverride) {
    if (target.type === 'artboard' && !nodesOverride) {
        return FileExportArea.createForArtboard(target.artboard);
    }
    return FileExportArea.createForSelection(Selection.create(doc, nodesOverride || target.nodes, true));
}

function duplicateTargetForVectorExport(doc, target) {
    const sourceSelection = Selection.create(doc, target.nodes, true);
    const duplicateCommand = DocumentCommand.createTransform(
        sourceSelection,
        null,
        { duplicateNodes: true }
    );
    doc.executeCommand(duplicateCommand);

    const duplicateNodes = duplicateCommand.newNodes || [];
    if (!duplicateNodes.length) throw new Error('Could not create temporary vectorized copy.');

    try {
        const duplicateSelection = Selection.create(doc, duplicateNodes, true);
        doc.executeCommand(DocumentCommand.createConvertToCurves(duplicateSelection));
    } catch (e) {
        deleteTempNodes(doc, duplicateNodes);
        throw e;
    }

    const convertedNodes = selectedNodes(doc);
    if (!convertedNodes.length) return duplicateNodes;
    return convertedNodes;
}

function deleteTempNodes(doc, nodes) {
    if (!nodes || !nodes.length) return;
    try {
        doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, nodes, true), false));
    } catch (e) {}
}

function runExports(doc, target, options, folder, presets) {
    let exportNodes = null;
    const exported = [];
    const failed = [];

    if (options.vectorizeTexts) {
        exportNodes = duplicateTargetForVectorExport(doc, target);
    }

    for (const format of options.formats) {
        const presetName = findPreset(format, presets);
        if (!presetName) {
            failed.push(format.label + ': export preset not found.');
            continue;
        }

        const path = pathJoin(folder, options.fileName + '.' + format.extension);
        try {
            const exportOptions = FileExportOptions.createWithPresetName(presetName);
            const area = createArea(doc, target, exportNodes);
            const size = exportSizeForScale(target, exportNodes, options.scale, format);
            const records = doc.export(path, exportOptions, area, size);
            const collected = collectExportRecords(records);
            if (!collected.length) {
                exported.push(path);
                continue;
            }
            for (const record of collected) {
                if (record.ok) {
                    exported.push(record.path || path);
                    if (record.warning) failed.push(format.label + ' warning: ' + record.warning);
                } else {
                    failed.push(format.label + ': ' + (record.error || 'Export failed.'));
                }
            }
        } catch (e) {
            failed.push(format.label + ': ' + (e.message || String(e)));
        }
    }

    deleteTempNodes(doc, exportNodes);
    return { exported, failed };
}

function main() {
    const doc = Document.current;
    let originalSelection = null;
    if (!doc) {
        showMessage('Smart Exporter', 'Open a document first.');
        return;
    }

    try {
        originalSelection = doc.selection;
        const target = findExportTarget(doc);
        if (!target) {
            throw new Error('Select an artboard, object, group, or layer first. If the document has only one artboard, the script can use it without selection.');
        }

        const presets = allPresetNames();
        const options = showOptionsDialog(target, presets);
        if (!options) return;

        const folder = chooseOutputFolder();
        if (!folder) return;

        const result = runExports(doc, target, options, folder, presets);
        try { doc.selection = originalSelection; } catch (restoreError) {}
        const lines = [];
        lines.push('Finished exporting "' + target.label + '".');
        lines.push('');
        lines.push(result.exported.length ? 'Exported files:' : 'No files were exported.');
        for (const path of result.exported) lines.push(path);
        if (result.failed.length) {
            lines.push('');
            lines.push('Warnings / failed exports:');
            for (const item of result.failed) lines.push(item);
        }
        showMessage('Smart Exporter', lines.join('\n'));
    } catch (e) {
        try {
            if (originalSelection) doc.selection = originalSelection;
        } catch (restoreError) {}
        showMessage('Smart Exporter - Error', e.message || String(e));
    }
}

main();
