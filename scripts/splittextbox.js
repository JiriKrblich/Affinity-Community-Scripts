/**
 * name: Split Textbox Characters
 * version: 1.4.5
 * description: Splits selected Art Text and Frame Text into character or line textboxes in one named Layer per source. Uses native command previews with explicit targets and a 250 ms trailing-edge debounce.
 */
'use strict';

const { app } = require('/application');
const { Document } = require('/document');
const { Selection } = require('/selections');
const { StoryBuilder } = require('/storybuilder');
const { GlyphAttDoubleType } = require('/glyphatts');
const { DocumentCommand, AddChildNodesCommandBuilder, CompoundCommandBuilder, InsertionMode } = require('/commands');
const { Dialog, DialogResult } = require('/dialog.js');
const { Timer } = require('/timers.js');
const { ArtTextNodeDefinition, FrameTextNodeDefinition, ContainerNodeDefinition, NodeChildType } = require('/nodes');
const { ParagraphLeadingType } = require('/paragraphatts');
const { Transform, Vector } = require('/geometry');
const { UnitType } = require('/units.js');

const SCRIPT_TITLE = 'Split Textbox Characters';
const MIN_ADVANCE = 0.25;
const PREVIEW_DEBOUNCE_MS = 250;

function buildSpacingDialog(doc, initialSpaceDistance) {
    const dialog = Dialog.create('Split Textbox Characters v1.4.5');
    const column = dialog.addColumn();
    const mode = column.addGroup('Mode');
    dialog.mode = mode.addButtonSet('', ['chars', 'lines'], 0);
    const spacing = column.addGroup('Spacing');
    dialog.characterSpacing = spacing
        .addUnitValueEditor('Character spacing (horizontal)', UnitType.Pixel, doc.units, 0)
        .setPrecision(2);
    dialog.lineSpacing = spacing
        .addUnitValueEditor('Line spacing (vertical)', UnitType.Pixel, doc.units, 0)
        .setPrecision(2);
    const spaces = column.addGroup('Space Characters');
    dialog.spaceChars = spaces.addSwitch('Space Chars', true);
    dialog.spaceDistance = spaces
        .addUnitValueEditor('Space distance', UnitType.Pixel, doc.units, initialSpaceDistance)
        .setPrecision(2);
    const output = column.addGroup('Output');
    dialog.outputType = output.addButtonSet('Textbox type', ['ArtText', 'FrameText'], 0);
    const preview = column.addGroup('Preview');
    dialog.preview = preview.addSwitch('Preview', true);
    dialog.previewStatus = preview.addStaticText(
        null,
        'Live preview updates the canvas as you change spacing.'
    ).setIsFullWidth();
    dialog.initialWidth = 410;
    return dialog;
}

function updateSpaceControls(dialog) {
    const charsMode = dialog.mode.selectedIndex === 0;
    dialog.characterSpacing.isEnabled = charsMode;
    dialog.spaceChars.isEnabled = charsMode;
    dialog.spaceDistance.isEnabled = charsMode && !dialog.spaceChars.value;
}

function readOptions(dialog) {
    return {
        mode: dialog.mode.selectedIndex === 1 ? 'lines' : 'chars',
        characterSpacing: dialog.characterSpacing.value,
        lineSpacing: dialog.lineSpacing.value,
        spaceChars: dialog.spaceChars.value,
        spaceDistance: dialog.spaceDistance.value,
        outputType: dialog.outputType.selectedIndex === 1 ? 'FrameText' : 'ArtText'
    };
}

function selectNode(doc, node) {
    return Selection.create(doc, node);
}

function getCharacterSpacing(glyphAtts) {
    const value = glyphAtts.getDoubleValue(GlyphAttDoubleType.CharacterSpacing);
    return Number.isFinite(value) ? value : 0;
}

function getInitialSpaceDistance(captured) {
    for (const item of captured) {
        for (const row of item.rows) {
            for (const cluster of row.clusters) {
                if (cluster.glyphs.length) {
                    return getCharacterSpacing(cluster.glyphs[0].glyphAtts);
                }
            }
        }
    }
    return 0;
}

function isCombiningCodePoint(text) {
    const cp = text.codePointAt(0);
    return (cp >= 0x0300 && cp <= 0x036F)
        || (cp >= 0x1AB0 && cp <= 0x1AFF)
        || (cp >= 0x1DC0 && cp <= 0x1DFF)
        || (cp >= 0x20D0 && cp <= 0x20FF)
        || (cp >= 0xFE20 && cp <= 0xFE2F)
        || (cp >= 0xFE00 && cp <= 0xFE0F)
        || (cp >= 0xE0100 && cp <= 0xE01EF)
        || (cp >= 0x1F3FB && cp <= 0x1F3FF);
}

function isRegionalIndicator(text) {
    const cp = text.codePointAt(0);
    return cp >= 0x1F1E6 && cp <= 0x1F1FF;
}

function appendGlyphToCluster(clusters, glyphInfo) {
    const current = glyphInfo.text;
    if (!clusters.length) {
        clusters.push({ text: current, glyphs: [glyphInfo] });
        return;
    }

    const previous = clusters[clusters.length - 1];
    const previousEndsWithJoiner = previous.text.endsWith('\u200D');
    const currentIsJoiner = current === '\u200D';
    const regionalCount = Array.from(previous.text).filter(isRegionalIndicator).length;
    const joinsRegionalPair = isRegionalIndicator(current)
        && isRegionalIndicator(previous.text.slice(-2))
        && regionalCount % 2 === 1;

    if (glyphInfo.glyph.isCombining || isCombiningCodePoint(current)
        || previousEndsWithJoiner || currentIsJoiner || joinsRegionalPair) {
        previous.text += current;
        previous.glyphs.push(glyphInfo);
    } else {
        clusters.push({ text: current, glyphs: [glyphInfo] });
    }
}

function captureText(node) {
    const story = node.story;
    const range = node.storyRange;
    if (!story || !range || range.begin < 0 || range.end < range.begin) {
        throw new Error('Could not read the selected text story.');
    }
    if (node.isFrameTextNode && node.textFrameInterface.isMultiFrameTextFlow) {
        throw new Error('Linked Frame Text stories are not supported; unlink the text frames first.');
    }

    const rows = [{ clusters: [], paragraphAtts: null }];
    const unsupported = [];
    for (let pos = range.begin; pos < range.end; pos++) {
        const glyph = story.getGlyph(pos);
        const text = glyph && glyph.isCharGlyph ? glyph.string : '';
        const isBreak = story.isParagraphBreak(pos) || text === '\n' || text === '\r' || text === '\r\n';
        if (isBreak) {
            rows.push({ clusters: [], paragraphAtts: null });
            continue;
        }
        if (!glyph || !glyph.isCharGlyph) {
            unsupported.push(pos + 1);
            continue;
        }
        const info = {
            text,
            glyph,
            glyphAtts: story.getGlyphAtts(pos).clone(),
            paragraphAtts: story.getParagraphAtts(pos).clone(),
            position: pos
        };
        const row = rows[rows.length - 1];
        if (!row.paragraphAtts) row.paragraphAtts = info.paragraphAtts.clone();
        appendGlyphToCluster(row.clusters, info);
    }
    if (unsupported.length) {
        throw new Error('The text contains fields or special glyphs that cannot be split safely (story positions: '
            + unsupported.join(', ') + ').');
    }

    return rows;
}

function getFontHeight(cluster) {
    if (!cluster || !cluster.glyphs.length) return 16;
    const value = cluster.glyphs[0].glyphAtts.height;
    return Number.isFinite(value) && value > 0 ? value : 16;
}

function getLineAdvance(row, previousRow) {
    const sample = row.clusters.length ? row.clusters[0]
        : (previousRow && previousRow.clusters.length ? previousRow.clusters[previousRow.clusters.length - 1] : null);
    const first = sample && sample.glyphs.length ? sample.glyphs[0] : null;
    const paragraphAtts = row.paragraphAtts || (first && first.paragraphAtts)
        || (previousRow && previousRow.paragraphAtts);
    const height = getFontHeight(sample);
    if (!paragraphAtts) return Math.max(1, height * 1.2);

    const relative = ParagraphLeadingType.RelativeToHeight;
    if (paragraphAtts.leadingType && relative
        && paragraphAtts.leadingType.value === relative.value) {
        const factor = paragraphAtts.relativeLeading;
        if (Number.isFinite(factor) && factor > 0) {
            return Math.max(1, height * factor / 100);
        }
    }
    const absolute = paragraphAtts.absoluteLeading;
    if (Number.isFinite(absolute) && absolute > 0) return absolute;
    return Math.max(1, height * 1.2);
}

function estimateWhitespaceAdvance(cluster) {
    const height = getFontHeight(cluster);
    if (cluster.text === '\t') return height * 1.32;
    if (cluster.text === ' ' || cluster.text === '\u00A0' || cluster.text === '\u2009') return height * 0.33;
    return height * 0.25;
}

function isSpaceCluster(cluster) {
    return !!cluster && /^[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+$/u.test(cluster.text);
}

function createTextBuilder(doc, clusters, outputType) {
    const builder = StoryBuilder.create();
    if (outputType === 'FrameText') builder.setToFrameTextDefaultStyle(doc.dpi, doc.rasterFormat);
    else builder.setToArtisticTextDefaultStyle(doc.dpi, doc.rasterFormat);
    const firstCluster = clusters.find(cluster => cluster.glyphs.length);
    if (!firstCluster) return builder;
    const firstGlyph = firstCluster.glyphs[0];
    builder.setParagraphAtts(firstGlyph.paragraphAtts.clone());
    for (const cluster of clusters) {
        for (let glyphIndex = 0; glyphIndex < cluster.glyphs.length; glyphIndex++) {
            const glyph = cluster.glyphs[glyphIndex];
            const glyphAtts = glyph.glyphAtts.clone();
            builder.setGlyphAtts(glyphAtts);
            builder.addText(glyph.text);
        }
    }
    return builder;
}

function estimateLineWidth(row) {
    let width = 0;
    for (const cluster of row.clusters) {
        const firstGlyph = cluster.glyphs[0];
        const glyphWidth = isSpaceCluster(cluster) || cluster.text === '\t'
            ? estimateWhitespaceAdvance(cluster) : getFontHeight(cluster) * 0.55;
        const tracking = getCharacterSpacing(firstGlyph.glyphAtts);
        const manualKern = Number.isFinite(firstGlyph.glyphAtts.manualKerning)
            ? firstGlyph.glyphAtts.manualKerning : 0;
        width += Math.max(MIN_ADVANCE, glyphWidth + tracking + manualKern);
    }
    return Math.max(MIN_ADVANCE, width);
}

function validBox(box) {
    return box && Number.isFinite(box.x) && Number.isFinite(box.y)
        && Number.isFinite(box.width) && Number.isFinite(box.height);
}

function transformedRect(rect, transform) {
    const points = [
        new Vector(rect.x, rect.y),
        new Vector(rect.x + rect.width, rect.y),
        new Vector(rect.x, rect.y + rect.height),
        new Vector(rect.x + rect.width, rect.y + rect.height)
    ].map(point => transform.applyToPoint(point));
    const xs = points.map(point => point.x);
    const ys = points.map(point => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function unionRects(rects) {
    if (!rects.length) return null;
    const minX = Math.min(...rects.map(rect => rect.x));
    const minY = Math.min(...rects.map(rect => rect.y));
    const maxX = Math.max(...rects.map(rect => rect.x + rect.width));
    const maxY = Math.max(...rects.map(rect => rect.y + rect.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function createCompoundCommand(commands) {
    if (!commands.length) return null;
    if (commands.length === 1) return commands[0];
    const builder = CompoundCommandBuilder.create();
    for (const command of commands) builder.addCommand(command);
    return builder.createCommand();
}

function makeArtTextDefinition(doc, clusters, transform, description) {
    const builder = createTextBuilder(doc, clusters, 'ArtText');
    const definition = ArtTextNodeDefinition.createFromStoryBuilder({ x: 0, y: 0 }, builder);
    definition.transform = transform;
    definition.userDescription = description;
    return definition;
}

function collectMeasurementJobs(captured, options) {
    const jobs = [];
    let index = 0;
    for (const item of captured) {
        if (options.mode === 'lines') {
            for (const row of item.rows) {
                if (!row.clusters.length) continue;
                jobs.push({ id: '__STC_MEASURE_' + index++, item, kind: 'row', target: row, clusters: row.clusters });
            }
        } else {
            for (const row of item.rows) {
                for (const cluster of row.clusters) {
                    if (!options.spaceChars && isSpaceCluster(cluster)) continue;
                    jobs.push({ id: '__STC_MEASURE_' + index++, item, kind: 'cluster', target: cluster, clusters: [cluster] });
                }
            }
        }
    }
    return jobs;
}

function measureTextboxes(doc, captured, options) {
    const jobs = collectMeasurementJobs(captured, options);
    const groups = [];
    for (const job of jobs) {
        const parent = job.item.source.parent;
        let group = groups.find(candidate => candidate.parent.isSameNode(parent));
        if (!group) {
            group = { parent, jobs: [] };
            groups.push(group);
        }
        group.jobs.push(job);
    }

    const commands = [];
    let placementIndex = 0;
    for (const group of groups) {
        const builder = AddChildNodesCommandBuilder.create();
        builder.setInsertionTarget(group.parent);
        builder.setInsertionMode(InsertionMode.Inside_AtFront);
        for (const job of group.jobs) {
            const transform = Transform.createTranslate(1000000 + placementIndex * 1000, 1000000);
            builder.addNode(makeArtTextDefinition(doc, job.clusters, transform, job.id));
            placementIndex++;
        }
        commands.push(builder.createCommand(false, NodeChildType.Main));
    }
    const command = createCompoundCommand(commands);
    const metrics = { clusters: new Map(), rows: new Map() };
    if (!command) return metrics;

    try {
        doc.executeCommand(command, true);
        const byId = new Map(command.newNodes.map(node => [node.userDescription, node]));
        for (const job of jobs) {
            const node = byId.get(job.id);
            if (!node) throw new Error('Affinity did not return native preview geometry for text measurement.');
            let baseBox = null;
            let visibleBox = null;
            try { baseBox = node.baseBoxInterface.baseBox; } catch (_) { /* use visible bounds below */ }
            try { visibleBox = node.getLocalVisibleBox(); } catch (_) { /* whitespace may have no outline */ }
            const fallbackWidth = job.kind === 'cluster'
                ? estimateWhitespaceAdvance(job.target)
                : estimateLineWidth(job.target);
            const width = validBox(baseBox) && baseBox.width > MIN_ADVANCE
                ? baseBox.width
                : (validBox(visibleBox) && visibleBox.width > MIN_ADVANCE ? visibleBox.width : fallbackWidth);
            const metric = {
                width,
                baseBox: validBox(baseBox) ? baseBox : (validBox(visibleBox) ? visibleBox : null)
            };
            (job.kind === 'cluster' ? metrics.clusters : metrics.rows).set(job.target, metric);
        }
    } finally {
        doc.clearPreviews();
    }
    return metrics;
}

function clusterMetric(metrics, cluster) {
    return metrics.clusters.get(cluster) || {
        width: estimateWhitespaceAdvance(cluster),
        baseBox: null
    };
}

function rowMetric(metrics, row) {
    return metrics.rows.get(row) || { width: estimateLineWidth(row), baseBox: null };
}

function buildOutputPlan(doc, item, options, metrics) {
    const source = item.source;
    if (!source.parent || !Array.from(source.parent.children).some(node => node.isSameNode(source))) {
        throw new Error('The selected textbox must be a normal child of a Layer or Group.');
    }
    const sourceTransform = source.localToSpreadTransform;
    const outputIsFrameText = options.outputType === 'FrameText';
    const sourceBox = outputIsFrameText ? source.getSpreadVisibleBox(false) : source.getSpreadBaseBox();
    const sourceFrame = source.isFrameTextNode;
    const frameBox = sourceFrame ? source.baseBoxInterface.baseBox : null;
    const plans = [];
    const fallbackLeading = item.rows.find(row => row.clusters.length) || item.rows[0];
    let localY = sourceFrame && fallbackLeading && fallbackLeading.clusters.length
        ? getFontHeight(fallbackLeading.clusters[0]) * 0.85 : 0;

    for (let rowIndex = 0; rowIndex < item.rows.length; rowIndex++) {
        const row = item.rows[rowIndex];
        if (rowIndex > 0) localY += getLineAdvance(row, item.rows[rowIndex - 1]) + options.lineSpacing;
        const lineHeight = getLineAdvance(row, item.rows[rowIndex - 1] || row);

        if (options.mode === 'lines') {
            if (!row.clusters.length) continue;
            const text = row.clusters.map(cluster => cluster.text).join('');
            const metric = rowMetric(metrics, row);
            const firstCluster = row.clusters[0];
            const width = Math.max(metric.width, estimateLineWidth(row)) + 1;
            const height = Math.max(getFontHeight(firstCluster) * 1.25, lineHeight * 1.25, 1);
            plans.push({
                kind: 'line', text, clusters: row.clusters, x: 0, y: localY,
                width, height,
                localBox: outputIsFrameText ? { x: 0, y: 0, width, height } : metric.baseBox
            });
            continue;
        }

        let localX = 0;
        for (let charIndex = 0; charIndex < row.clusters.length; charIndex++) {
            const cluster = row.clusters[charIndex];
            if (!options.spaceChars && isSpaceCluster(cluster)) {
                localX += options.spaceDistance;
                continue;
            }
            const metric = clusterMetric(metrics, cluster);
            const firstGlyph = cluster.glyphs[0];
            const tracking = Number.isFinite(firstGlyph.glyphAtts.characterSpacing)
                ? firstGlyph.glyphAtts.characterSpacing : 0;
            const manualKern = Number.isFinite(firstGlyph.glyphAtts.manualKerning)
                ? firstGlyph.glyphAtts.manualKerning : 0;
            const advance = Math.max(MIN_ADVANCE, metric.width + tracking + manualKern);
            if (sourceFrame && frameBox && Number.isFinite(frameBox.width)
                && frameBox.width > 0 && localX > 0 && localX + advance > frameBox.width) {
                localY += lineHeight + options.lineSpacing;
                localX = 0;
            }

            const frameWidth = Math.max(
                MIN_ADVANCE,
                metric.width + Math.max(0, tracking + manualKern),
                getFontHeight(cluster) * 0.5
            ) + 0.5;
            const frameHeight = Math.max(getFontHeight(cluster) * 1.25, lineHeight || 0, 1);
            plans.push({
                kind: 'cluster', text: cluster.text, clusters: [cluster], x: localX, y: localY,
                width: frameWidth, height: frameHeight,
                localBox: outputIsFrameText ? { x: 0, y: 0, width: frameWidth, height: frameHeight } : metric.baseBox
            });
            localX += advance;
            if (charIndex < row.clusters.length - 1) localX += options.characterSpacing;
        }
    }

    if (!plans.length) throw new Error('The selected textbox has no output textboxes to create.');
    const layoutRects = [];
    for (const plan of plans) {
        const rect = plan.localBox;
        if (!validBox(rect)) continue;
        layoutRects.push(transformedRect(rect,
            sourceTransform.multiply(Transform.createTranslate(plan.x, plan.y))));
    }
    const generatedBox = unionRects(layoutRects);
    const dx = generatedBox && validBox(sourceBox) ? sourceBox.x - generatedBox.x : 0;
    const dy = generatedBox && validBox(sourceBox) ? sourceBox.y - generatedBox.y : 0;
    return { source, plans, dx, dy };
}

function makeOutputDefinition(doc, source, output, options, target) {
    const spreadTransform = Transform.createTranslate(output.dx, output.dy)
        .multiply(source.localToSpreadTransform)
        .multiply(Transform.createTranslate(output.x, output.y));
    const localTransform = target.spreadToBaseTransform.multiply(spreadTransform);
    let definition;
    if (options.outputType === 'FrameText') {
        const story = createTextBuilder(doc, output.clusters, 'FrameText');
        definition = FrameTextNodeDefinition.createFromStoryBuilder(
            { x: 0, y: 0, width: output.width, height: output.height }, story
        );
    } else {
        definition = makeArtTextDefinition(doc, output.clusters, localTransform, output.text);
    }
    definition.transform = localTransform;
    definition.userDescription = output.text;
    return definition;
}

function addPlannedTextNodes(builder, doc, plan, options, target) {
    for (const output of plan.plans) {
        builder.addNode(makeOutputDefinition(doc, plan.source,
            { ...output, dx: plan.dx, dy: plan.dy }, options, target));
    }
}

function buildPreviewCommand(doc, captured, options, metrics) {
    const commands = [];
    const errors = [];
    for (const item of captured) {
        try {
            const plan = buildOutputPlan(doc, item, options, metrics);
            const childBuilder = AddChildNodesCommandBuilder.create();
            // The native preview draws text beside the source. Its placement is explicit;
            // it does not depend on a preceding command changing the current selection.
            childBuilder.setInsertionTarget(plan.source);
            childBuilder.setInsertionMode(InsertionMode.Behind);
            addPlannedTextNodes(childBuilder, doc, plan, options, plan.source.parent);
            commands.push(childBuilder.createCommand(false, NodeChildType.Main));
            commands.push(DocumentCommand.createDeleteSelection(selectNode(doc, plan.source), true));
        } catch (error) {
            errors.push(item.name + ': ' + String(error.message || error));
        }
    }
    return { command: createCompoundCommand(commands), errors };
}

function commitSplit(doc, captured, options, metrics) {
    const allCreated = [];
    const errors = [];
    for (const item of captured) {
        let layer = null;
        try {
            const plan = buildOutputPlan(doc, item, options, metrics);
            const layerBuilder = AddChildNodesCommandBuilder.create();
            layerBuilder.setInsertionTarget(plan.source);
            layerBuilder.setInsertionMode(InsertionMode.Behind);
            layerBuilder.addNode(ContainerNodeDefinition.create(item.name));
            const layerCommand = layerBuilder.createCommand(false, NodeChildType.Main);
            doc.executeCommand(layerCommand, false);
            layer = layerCommand.newNodes[0];
            if (!layer || !layer.isContainerNode) {
                throw new Error('Affinity did not create the output Layer.');
            }

            const childBuilder = AddChildNodesCommandBuilder.create();
            childBuilder.setInsertionTarget(layer);
            childBuilder.setInsertionMode(InsertionMode.Inside_AtFront);
            addPlannedTextNodes(childBuilder, doc, plan, options, layer);
            const childCommand = childBuilder.createCommand(false, NodeChildType.Main);
            doc.executeCommand(childCommand, false);
            const nodes = childCommand.newNodes.filter(node => node.isArtTextNode || node.isFrameTextNode);
            if (nodes.length !== plan.plans.length) {
                throw new Error('Affinity created fewer textboxes than the split requires.');
            }

            doc.executeCommand(DocumentCommand.createDeleteSelection(
                selectNode(doc, plan.source), true), false);
            allCreated.push(...nodes);
        } catch (error) {
            if (layer && layer.parent) {
                try {
                    doc.executeCommand(DocumentCommand.createDeleteSelection(
                        selectNode(doc, layer), true), false);
                } catch (_) { /* report the original split error below */ }
            }
            errors.push(item.name + ': ' + String(error.message || error));
        }
    }
    return { allCreated, errors };
}

function runNativePreview(doc, captured, options) {
    doc.clearPreviews();
    const metrics = measureTextboxes(doc, captured, options);
    const built = buildPreviewCommand(doc, captured, options, metrics);
    if (!built.command) {
        throw new Error(built.errors.join('\n') || 'No output textboxes could be created.');
    }
    doc.executeCommand(built.command, true);
    const allCreated = built.command.newNodes.filter(node => node.isArtTextNode || node.isFrameTextNode);
    if (!allCreated.length) {
        doc.clearPreviews();
        throw new Error('Affinity did not expose the text nodes created by the preview command.');
    }
    return { allCreated, errors: built.errors, command: built.command };
}

function getSelectedTextboxes(doc) {
    const result = [];
    for (let i = 0; i < doc.selection.length; i++) {
        const node = doc.selection.at(i).node;
        if (node && (node.isArtTextNode || node.isFrameTextNode)) result.push(node);
    }
    return result;
}

function rejectNestedSelection(nodes) {
    for (const node of nodes) {
        let parent = node.parent;
        while (parent) {
            if (nodes.some(other => other.isSameNode(parent))) {
                throw new Error('Select either a text container or its text children, not both.');
            }
            parent = parent.parent;
        }
    }
}

function compactError(error) {
    return String(error && error.message ? error.message : error).replace(/\s+/g, ' ').trim();
}

function main() {
    const doc = Document.current;
    if (!doc) {
        app.alert('Please open a document first.', SCRIPT_TITLE);
        return;
    }

    try {
        const sources = getSelectedTextboxes(doc);
        if (!sources.length) throw new Error('Select at least one Art Text or Frame Text object.');
        rejectNestedSelection(sources);

        const captured = [];
        const errors = [];
        for (const source of sources) {
            const name = source.userDescription || source.defaultDescription || 'Textbox';
            try {
                captured.push({ source, name, rows: captureText(source) });
            } catch (error) {
                errors.push(name + ': ' + compactError(error));
            }
        }
        if (!captured.length) {
            app.alert('Created 0 textbox(es).' + (errors.length ? '\n\nSkipped:\n' + errors.join('\n') : ''), SCRIPT_TITLE);
            return;
        }

        const dialog = buildSpacingDialog(doc, getInitialSpaceDistance(captured));
        let pendingPreviewTimer = null;
        let previewScheduleGeneration = 0;
        let dialogIsClosing = false;
        let lastPreviewSignature = null;

        const cancelPendingPreviewRefresh = () => {
            previewScheduleGeneration += 1;
            const timer = pendingPreviewTimer;
            pendingPreviewTimer = null;
            if (!timer) return;
            try { timer.cancel(); } catch (_) { /* already fired */ }
            try { timer.dispose(); } catch (_) { /* already disposed */ }
        };

        const clearNativePreview = () => {
            try { doc.clearPreviews(); } catch (_) { /* no active native preview */ }
        };

        const refreshPreview = () => {
            if (dialogIsClosing) return;
            const options = readOptions(dialog);
            const previewEnabled = dialog.preview.value;
            const signature = JSON.stringify({ options, previewEnabled });
            if (signature === lastPreviewSignature) return;
            clearNativePreview();
            if (!previewEnabled) {
                dialog.previewStatus.text = 'Preview is off.';
                lastPreviewSignature = signature;
                return;
            }
            try {
                const result = runNativePreview(doc, captured, options);
                const skipped = result.errors.length;
                dialog.previewStatus.text = 'Live preview: ' + result.allCreated.length
                    + ' textbox(es)' + (skipped ? '; ' + skipped + ' source(s) skipped.' : '.');
                lastPreviewSignature = signature;
            } catch (error) {
                clearNativePreview();
                lastPreviewSignature = null;
                dialog.previewStatus.text = 'Preview failed: ' + compactError(error);
            }
        };

        const schedulePreviewRefresh = () => {
            if (dialogIsClosing) return;
            updateSpaceControls(dialog);
            cancelPendingPreviewRefresh();
            const generation = previewScheduleGeneration;
            const timer = Timer.create();
            pendingPreviewTimer = timer;
            dialog.previewStatus.text = 'Updating preview…';
            try {
                timer.expiryFromNow = PREVIEW_DEBOUNCE_MS;
                timer.waitAsync(errorCode => {
                    if (pendingPreviewTimer === timer) pendingPreviewTimer = null;
                    try { timer.dispose(); } catch (_) { /* disposed during close */ }
                    if (errorCode || dialogIsClosing || generation !== previewScheduleGeneration) return;
                    refreshPreview();
                });
            } catch (error) {
                if (pendingPreviewTimer === timer) pendingPreviewTimer = null;
                try { timer.cancel(); timer.dispose(); } catch (_) { /* cleanup */ }
                dialog.previewStatus.text = 'Preview could not be scheduled: ' + compactError(error);
            }
        };

        dialog.onControlValueChangedHandler = schedulePreviewRefresh;
        updateSpaceControls(dialog);
        schedulePreviewRefresh();

        let dialogResult;
        try {
            dialogResult = dialog.runModal();
        } catch (error) {
            dialogIsClosing = true;
            cancelPendingPreviewRefresh();
            clearNativePreview();
            throw error;
        }

        dialogIsClosing = true;
        cancelPendingPreviewRefresh();
        clearNativePreview();
        if ((dialogResult?.value ?? dialogResult) !== DialogResult.Ok.value) return;

        const finalOptions = readOptions(dialog);
        const metrics = measureTextboxes(doc, captured, finalOptions);
        const finalResult = commitSplit(doc, captured, finalOptions, metrics);
        const allCreated = finalResult.allCreated;
        if (allCreated.length) doc.selection = allCreated;
        errors.push(...finalResult.errors);
        const outputDescription = finalOptions.mode === 'lines' ? 'line' : 'single-character';
        app.alert('Created ' + allCreated.length + ' ' + outputDescription
            + ' textbox(es) inside named Layers.'
            + (errors.length ? '\n\nSkipped:\n' + errors.join('\n') : ''), SCRIPT_TITLE);
    } catch (error) {
        try { doc.clearPreviews(); } catch (_) { /* no native preview to clear */ }
        app.alert(compactError(error), SCRIPT_TITLE);
    }
}

main();
