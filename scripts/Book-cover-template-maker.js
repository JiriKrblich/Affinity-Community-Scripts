/**
 * name: Book_Cover_Master_Builder_Affinity3
 * description: book cover layout master maker
 */

/*
 * Book Cover Master Builder for Affinity 3 (Publisher / unified Affinity app)
 *
 * Builds native, non-printing guides for a one-piece book cover:
 *
 *     BACK COVER | SPINE | FRONT COVER
 *
 * PRINT-CRITICAL RULE
 *   Every guide is derived from ONE centre-anchored geometry object
 *   (calculateCoverGeometry). The spine centre is always totalWidth / 2, and
 *   the spine edges are pageCenterX -/+ spineWidth / 2. Nothing is measured by
 *   accumulating widths from the left edge.
 *
 *   Guide positions are computed in the spread's own pixel space, starting
 *   from the trim box that Affinity reports. The spine centre is the trim box
 *   centre exactly, with no unit conversion applied to the page width.
 *
 * API NOTES (checked against Affinity 3.3 JSLib, /Applications/Affinity.app/
 * Contents/Resources/JSLib):
 *   - Guides: DocumentCommand.createAddGuide(horizontal, at). Positions are in
 *     spread coordinates (document pixels), the same space as
 *     getSpreadExtents() and getSpreadBaseBox(); see examples/addGuides.js.
 *     Guides go on the CURRENT spread.
 *   - There is NO API to read or list existing guides. Guides can only be
 *     moved or removed by an index the script cannot find. So this script
 *     NEVER removes or moves guides, and it can't tell its own guides from
 *     yours. Remove old cover guides yourself in View > Guides Manager
 *     before running Update.
 *   - Bleed: spread.getSpreadExtents({ includeBleed }) exposes the document
 *     bleed, so the script reads it and checks it. The only way to write bleed
 *     is DocumentProperties.create() + setDocumentProperties(), and create()
 *     starts from defaults. That could reset the page size, DPI and other
 *     settings, so the script does NOT write bleed. It tells you to set it in
 *     Document Setup.
 *   - Spreads do not say whether they are masters. The script works on
 *     doc.currentSpread and shows its size in the dialog so you can check it
 *     is the cover master.
 *   - Only ONE dialog per run. A second dialog in the same run crashed
 *     Affinity 3.3.0 when it closed, so everything is in a single dialog.
 *   - Dialogs can't show images or drawings, so there is no picture preview.
 *     While the dialog is open, the guides are shown live on the spread as a
 *     temporary preview (executeCommand(..., preview = true)), which is
 *     cleared on Cancel.
 *
 * The geometry functions at the top are pure (no Affinity calls) and are
 * exported, so they can be checked outside Affinity.
 */

'use strict';

const SCRIPT_TITLE = 'Book Cover Master Builder';

// ============================================================================
// Units (pure). Settings are stored in points: 72 pt = 1 in, exactly.
// ============================================================================

const POINTS_PER_INCH = 72;

const UNITS = Object.freeze({
    mm: { key: 'mm', label: 'Millimetres (mm)', suffix: 'mm', perInch: 25.4, precision: 3, affinityName: 'Millimetre' },
    cm: { key: 'cm', label: 'Centimetres (cm)', suffix: 'cm', perInch: 2.54, precision: 4, affinityName: 'Centimetre' },
    in: { key: 'in', label: 'Inches (in)', suffix: 'in', perInch: 1, precision: 4, affinityName: 'Inch' },
    pt: { key: 'pt', label: 'Points (pt)', suffix: 'pt', perInch: 72, precision: 3, affinityName: 'Point' },
});
const UNIT_KEYS = Object.freeze(['mm', 'cm', 'in', 'pt']);

function toPoints(value, unitKey) {
    return value * POINTS_PER_INCH / UNITS[unitKey].perInch;
}

function fromPoints(points, unitKey) {
    return points * UNITS[unitKey].perInch / POINTS_PER_INCH;
}

function fromPixels(px, dpi) {
    return px * POINTS_PER_INCH / dpi;
}

function formatNumber(value, digits) {
    const s = value.toFixed(digits);
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function formatLength(points, unitKey, extraDigits = 0) {
    const unit = UNITS[unitKey];
    return `${formatNumber(fromPoints(points, unitKey), unit.precision + extraDigits)} ${unit.suffix}`;
}

const DEFAULTS = Object.freeze({
    coverWidth: toPoints(5.5, 'in'),   // ONE cover (back = front); used only if the open page is too small
    coverHeight: toPoints(8.5, 'in'),
    spineWidth: toPoints(10, 'mm'),
    bleed: toPoints(3, 'mm'),
    safeInset: toPoints(0.5, 'in'),
    safeFrom: 'bleed',                 // safe distance is measured from the bleed edge
    pageCount: 200,
    caliper: toPoints(0.10, 'mm'),     // ~80 gsm uncoated; starting point only
});

// ============================================================================
// Geometry (pure). All inputs and outputs are in ONE unit, whatever the caller
// uses (points in tests, document pixels when applying).
// ============================================================================

/** Spine width: manual, or an estimate from page count and caliper. */
function calculateSpine({ mode, manualWidth, pageCount, caliper }) {
    if (mode === 'manual') {
        return { width: manualWidth, isEstimate: false };
    }
    const leaves = pageCount / 2;
    return { width: leaves * caliper, isEstimate: true, leaves };
}

function describeSpineFormula(pageCount, caliper, unitKey) {
    const width = calculateSpine({ mode: 'calculated', pageCount, caliper }).width;
    return `${pageCount} ÷ 2 × ${formatLength(caliper, unitKey, 1)} = ${formatLength(width, unitKey)}`;
}

/** Page width for a cover: back + spine + front (back and front are always equal). */
function pageWidthFromCover(coverWidth, spineWidth) {
    return coverWidth * 2 + spineWidth;
}

/**
 * The single source of truth for every guide.
 * x = 0 is the left trim edge and y = 0 is the top trim edge.
 */
function calculateCoverGeometry({ totalWidth, totalHeight, spineWidth, bleed, safeInset, safeFrom = 'bleed' }) {
    const pageCenterX = totalWidth / 2;
    const spineLeft = pageCenterX - spineWidth / 2;
    const spineRight = pageCenterX + spineWidth / 2;

    // Distance from the outer trim edge to the safe line. When measured from
    // the bleed edge, the bleed eats into the safe distance.
    // There is no bleed at the spine folds, so the safe line there is just
    // safeInset from the spine edge.
    const outerSafe = safeFrom === 'trim' ? safeInset : safeInset - bleed;

    return Object.freeze({
        totalWidth,
        totalHeight,
        pageCenterX,
        spineWidth,
        spineLeft,
        spineRight,
        backLeft: 0,
        backRight: spineLeft,
        frontLeft: spineRight,
        frontRight: totalWidth,
        panelWidth: spineLeft,
        bleed,
        safeInset,
        safeFrom,
        bleedLeft: -bleed,
        bleedRight: totalWidth + bleed,
        bleedTop: -bleed,
        bleedBottom: totalHeight + bleed,
        safeTop: outerSafe,
        safeBottom: totalHeight - outerSafe,
        backSafeLeft: outerSafe,
        backSafeRight: spineLeft - safeInset,
        frontSafeLeft: spineRight + safeInset,
        frontSafeRight: totalWidth - outerSafe,
    });
}

// One switch per group. Every line belongs to exactly one group, so no switch
// repeats another. (The back/front cover edges are the trim and spine edges.)
const GUIDE_SETS = Object.freeze([
    { key: 'bleed', label: 'Bleed boundary' },
    { key: 'trim', label: 'Trim / outer boundary' },
    { key: 'spineEdges', label: 'Spine left & right edges' },
    { key: 'spineCentre', label: 'Spine centre (always on)', locked: true },
    { key: 'backSafe', label: 'Back cover safe margins (left & right)' },
    { key: 'frontSafe', label: 'Front cover safe margins (left & right)' },
    { key: 'safeTopBottom', label: 'Safe margins top & bottom' },
]);

function allGuideSetsEnabled() {
    return Object.fromEntries(GUIDE_SETS.map(s => [s.key, true]));
}

/**
 * Makes the guide list from the geometry. The spine centre is always added and
 * comes first, so it wins when guides are merged. Guides at the same position
 * are merged into one (for example, back cover left = trim left).
 */
function calculateGuides(g, enabled, epsilon = 1e-6) {
    const guides = [];
    const add = (set, label, orientation, position) => {
        if (set === 'spineCentre' || enabled[set]) {
            guides.push({ set, label, orientation, position });
        }
    };

    add('spineCentre', 'Spine centre', 'vertical', g.pageCenterX);
    add('spineEdges', 'Spine left', 'vertical', g.spineLeft);
    add('spineEdges', 'Spine right', 'vertical', g.spineRight);

    add('trim', 'Trim left', 'vertical', 0);
    add('trim', 'Trim right', 'vertical', g.totalWidth);
    add('trim', 'Trim top', 'horizontal', 0);
    add('trim', 'Trim bottom', 'horizontal', g.totalHeight);

    if (g.bleed > 0) {
        add('bleed', 'Bleed left', 'vertical', g.bleedLeft);
        add('bleed', 'Bleed right', 'vertical', g.bleedRight);
        add('bleed', 'Bleed top', 'horizontal', g.bleedTop);
        add('bleed', 'Bleed bottom', 'horizontal', g.bleedBottom);
    }

    add('backSafe', 'Back safe left', 'vertical', g.backSafeLeft);
    add('backSafe', 'Back safe right', 'vertical', g.backSafeRight);
    add('frontSafe', 'Front safe left', 'vertical', g.frontSafeLeft);
    add('frontSafe', 'Front safe right', 'vertical', g.frontSafeRight);
    add('safeTopBottom', 'Safe top', 'horizontal', g.safeTop);
    add('safeTopBottom', 'Safe bottom', 'horizontal', g.safeBottom);

    return dedupeGuides(guides, epsilon);
}

function dedupeGuides(guides, epsilon) {
    const result = [];
    for (const guide of guides) {
        const duplicate = result.some(r => r.orientation === guide.orientation && Math.abs(r.position - guide.position) <= epsilon);
        if (!duplicate) result.push(guide);
    }
    return result;
}

/** Returns { errors }. Nothing is applied until every error is fixed. */
function validateInputs(input, geometry) {
    const errors = [];
    const positive = (v, name) => {
        if (!(Number.isFinite(v) && v > 0)) errors.push(`${name} must be greater than zero.`);
    };
    const nonNegative = (v, name) => {
        if (!(Number.isFinite(v) && v >= 0)) errors.push(`${name} must be zero or more.`);
    };

    if (input.mode === 'new') {
        positive(input.coverWidth, 'Cover width');
        positive(input.coverHeight, 'Height');
    }
    if (input.spineMode === 'calculated') {
        if (!Number.isInteger(input.pageCount) || input.pageCount < 2) {
            errors.push('Page count must be a whole number of 2 or more.');
        } else if (input.pageCount % 2 !== 0 && !input.oddPageCountConfirmed) {
            errors.push(`Page count ${input.pageCount} is odd. Round it to an even number or confirm it.`);
        }
        positive(input.caliper, 'Page thickness (caliper)');
    }
    positive(input.spineWidth, 'Spine width');
    nonNegative(input.bleed, 'Bleed');
    nonNegative(input.safeInset, 'Safe distance');
    if (errors.length > 0 || !geometry) {
        return { errors };
    }

    if (!(geometry.panelWidth > 0)) {
        errors.push('The spine is as wide as the whole page or wider. There is no room for the front and back covers.');
    }
    if (input.safeFrom === 'bleed' && input.safeInset < input.bleed) {
        errors.push('The safe distance is smaller than the bleed, so the safe line would sit outside the trim.');
    }
    if (!(geometry.backSafeLeft < geometry.backSafeRight) || !(geometry.frontSafeLeft < geometry.frontSafeRight)) {
        errors.push('The safe area does not fit inside the front/back cover width. Reduce the safe distance or the spine.');
    }
    if (!(geometry.safeTop < geometry.safeBottom)) {
        errors.push('The safe area does not fit inside the cover height. Reduce the safe distance.');
    }
    return { errors };
}

/** Rounds an odd page count up. Printers add a blank page; they never remove one. */
function nextEvenPageCount(pageCount) {
    return pageCount % 2 === 0 ? pageCount : pageCount + 1;
}

/** Summary lines for the final report. Positions are relative to the left trim edge. */
function renderPreview(g, unitKey) {
    const f = v => formatLength(v, unitKey);
    return [
        `BACK ${f(g.panelWidth)}  |  SPINE ${f(g.spineWidth)}  |  FRONT ${f(g.totalWidth - g.spineRight)}`,
        `Assembled trim: ${f(g.totalWidth)} × ${f(g.totalHeight)}   (bleed outside: ${f(g.bleed)})`,
        `Page / spine centre: ${f(g.pageCenterX)} from the left trim edge`,
        `Spine edges: ${f(g.spineLeft)} → ${f(g.spineRight)}`,
        `Back safe x: ${f(g.backSafeLeft)} → ${f(g.backSafeRight)}   Front safe x: ${f(g.frontSafeLeft)} → ${f(g.frontSafeRight)}`,
        `Safe y: ${f(g.safeTop)} → ${f(g.safeBottom)}   (safe measured from ${g.safeFrom} edge)`,
    ];
}

// ============================================================================
// Affinity integration. Only runs inside Affinity; the modules load lazily so
// Node can require this file for tests.
// ============================================================================

function loadAffinityApi() {
    const { Document } = require('/document.js');
    const { Dialog, DialogResult } = require('/dialog.js');
    const { UnitType } = require('/units.js');
    const { DocumentCommand, CompoundCommandBuilder } = require('/commands.js');
    const { SpatialAnchor } = require('affinity:dom');
    return { Document, Dialog, DialogResult, UnitType, DocumentCommand, CompoundCommandBuilder, SpatialAnchor };
}

function enumEquals(a, b) {
    return (a?.value ?? a) === (b?.value ?? b);
}

function isOk(api, result) {
    return enumEquals(result, api.DialogResult.Ok);
}

function getSelectedUnit(api, doc) {
    const docUnit = doc.units;
    const match = UNIT_KEYS.find(k => enumEquals(api.UnitType[UNITS[k].affinityName], docUnit));
    return match ?? 'in';
}

function rectToPlain(rc) {
    return { x: rc.x, y: rc.y, width: rc.width, height: rc.height };
}

/** Reads the current spread's trim box and document bleed, in pixels and points. */
function getPageDimensions(doc, spread) {
    const trim = rectToPlain(spread.getSpreadExtents({ includeSpread: true, includeBleed: false, includeChildren: false }));
    const outer = rectToPlain(spread.getSpreadExtents({ includeSpread: true, includeBleed: true, includeChildren: false }));
    const ptPerPx = POINTS_PER_INCH / doc.dpi;
    const bleedPt = {
        left: (trim.x - outer.x) * ptPerPx,
        top: (trim.y - outer.y) * ptPerPx,
        right: (outer.x + outer.width - trim.x - trim.width) * ptPerPx,
        bottom: (outer.y + outer.height - trim.y - trim.height) * ptPerPx,
    };
    return {
        dpi: doc.dpi,
        trimPx: trim,
        widthPt: trim.width * ptPerPx,
        heightPt: trim.height * ptPerPx,
        bleedPt,
        pageCount: spread.pageCount,
    };
}

/**
 * Compares the requested bleed with the document bleed. Nothing is written;
 * see the API notes at the top of the file for why.
 */
function checkDocumentBleed(dims, requestedBleedPt, unitKey) {
    const tolerance = toPoints(0.001, 'mm');
    const sides = Object.entries(dims.bleedPt);
    const mismatched = sides.filter(([, v]) => Math.abs(v - requestedBleedPt) > tolerance);
    if (mismatched.length === 0) {
        return { matches: true, message: `Document bleed matches: ${formatLength(requestedBleedPt, unitKey)} on all four sides.` };
    }
    const actual = sides.map(([side, v]) => `${side} ${formatLength(v, unitKey)}`).join(', ');
    return {
        matches: false,
        short: `Document bleed is ${formatLength(sides[0][1], unitKey)}: set it in Document Setup`,
        message: `Document bleed (${actual}) does NOT match the ${formatLength(requestedBleedPt, unitKey)} you entered. ` +
            'Set it in File ▸ Document Setup ▸ Bleed. Only the guides use the value you entered.',
    };
}

function createGuideCommand(api, guidesPx, originPx) {
    const builder = api.CompoundCommandBuilder.create();
    for (const guide of guidesPx) {
        const horizontal = guide.orientation === 'horizontal';
        const at = (horizontal ? originPx.y : originPx.x) + guide.position;
        builder.addCommand(api.DocumentCommand.createAddGuide(horizontal, at));
    }
    return builder.createCommand();
}

/** Converts settings (points) to pixel-space geometry for a given trim size in pixels. */
function geometryInPixels(settings, trimWidthPx, trimHeightPx, dpi) {
    const k = dpi / POINTS_PER_INCH;
    return calculateCoverGeometry({
        totalWidth: trimWidthPx,
        totalHeight: trimHeightPx,
        spineWidth: settings.spineWidth * k,
        bleed: settings.bleed * k,
        safeInset: settings.safeInset * k,
        safeFrom: settings.safeFrom,
    });
}

/** Trim size (px) the guides will be built on: the target size in NEW + resize, else the current spread. */
function targetTrimPx(settings, dims) {
    if (settings.mode === 'new' && settings.resizeSpread) {
        const k = dims.dpi / POINTS_PER_INCH;
        return {
            width: pageWidthFromCover(settings.coverWidth, settings.spineWidth) * k,
            height: settings.coverHeight * k,
        };
    }
    return { width: dims.trimPx.width, height: dims.trimPx.height };
}

function createGuides(api, settings, dims) {
    const size = targetTrimPx(settings, dims);
    const g = geometryInPixels(settings, size.width, size.height, dims.dpi);
    const guides = calculateGuides(g, settings.enabled, 1e-6);
    return { command: createGuideCommand(api, guides, dims.trimPx), guides };
}

/**
 * Resizes the spread (NEW mode) and adds guides in ONE undoable command, then
 * checks that Affinity produced the expected trim box. If it didn't (for
 * example because it rounded the page size), the script undoes and redoes it in
 * two steps: resize first, then build guides from the real trim box. That way
 * the spine centre always matches the actual page centre.
 */
function applyNewWithResize(api, doc, spread, settings, dims) {
    const anchor = api.SpatialAnchor?.Centre ?? api.SpatialAnchor?.MiddleCentre ?? api.SpatialAnchor?.Center;
    if (anchor === undefined) {
        throw new Error('SpatialAnchor.Centre is not available in this Affinity version. Turn off "Resize page" and set the page size in Document Setup.');
    }
    const size = targetTrimPx(settings, dims);
    const pxTolerance = (0.0005 / 25.4) * dims.dpi;
    const matchesTarget = rc =>
        Math.abs(rc.width - size.width) <= pxTolerance &&
        Math.abs(rc.height - size.height) <= pxTolerance &&
        Math.abs(rc.x - dims.trimPx.x) <= pxTolerance &&
        Math.abs(rc.y - dims.trimPx.y) <= pxTolerance;

    const { command: guideCommand, guides } = createGuides(api, settings, dims);
    const resizeCommand = api.DocumentCommand.createSetSpreadSizeWithAnchor(spread, size.width, size.height, anchor);
    const compound = api.CompoundCommandBuilder.create();
    compound.addCommand(resizeCommand, true);
    compound.addCommand(guideCommand);
    doc.executeCommand(compound.createCommand());

    const after = getPageDimensions(doc, doc.currentSpread);
    if (matchesTarget(after.trimPx)) {
        return { dims: after, guideCount: guides.length, note: null };
    }

    // Fallback: Affinity chose a slightly different page box. Build guides on the real box.
    doc.undo();
    doc.executeCommand(api.DocumentCommand.createSetSpreadSizeWithAnchor(doc.currentSpread, size.width, size.height, anchor));
    const actual = getPageDimensions(doc, doc.currentSpread);
    const sizeErrorPt = Math.abs(actual.widthPt - fromPixels(size.width, dims.dpi));
    if (sizeErrorPt > toPoints(0.5, 'mm')) {
        doc.undo();
        throw new Error('The spread did not resize to the expected size, so it was undone. Set the page size in Document Setup, then run again with "Resize page" turned off.');
    }
    const fallback = createGuides(api, { ...settings, resizeSpread: false }, actual);
    doc.executeCommand(fallback.command);
    return {
        dims: actual,
        guideCount: fallback.guides.length,
        note: `Affinity set the trim width to ${formatLength(actual.widthPt, settings.unitKey)}. ` +
            'The guides are centred on that actual page. The page is split into two undo steps.',
    };
}

function updateGuides(api, doc, settings, dims) {
    const { command, guides } = createGuides(api, settings, dims);
    doc.executeCommand(command);
    return { dims, guideCount: guides.length, note: null };
}

// ---------------------------------------------------------------------------
// Dialog
//
// The script opens exactly ONE dialog per run, like Affinity's own examples.
// Opening a second dialog in the same run made Affinity crash when that
// dialog closed (seen on 3.3.0: ScriptedDialogController::Commit/Cancel ->
// EventLoop::PostNull). So the action choice, the target check and all the
// settings live in the same dialog.
// ---------------------------------------------------------------------------

const ACTIONS = Object.freeze(['— Choose an action —', 'Create / prepare new cover master', 'Update existing cover master']);

function buildDialog(api, unitKey, dims) {
    const unitType = api.UnitType[UNITS[unitKey].affinityName];
    const precision = UNITS[unitKey].precision;
    const lengthEditor = (group, label, initialPt, extraDigits = 0) =>
        group.addUnitValueEditor(label, api.UnitType.Point, unitType, initialPt, 0)
            .setNoMaxValue()
            .setPrecision(precision + extraDigits);

    const dlg = api.Dialog.create(SCRIPT_TITLE);
    const ui = { dlg };

    // Three columns that read like the cover: [Back & Front Cover] [Spine] [Guides].
    // Labels on the left, values and switches on the right, as in Document Setup.

    // --- Column 1: action, back & front cover, bleed/safe --------------------
    const col1 = dlg.addColumn();
    const startGroup = col1.addGroup('Cover Master');
    ui.action = startGroup.addComboBox('Action', ACTIONS, 0);
    startGroup.addStaticText('Target', `Spread on screen: ${dims.pageCount} page(s), ${formatLength(dims.widthPt, unitKey)} × ${formatLength(dims.heightPt, unitKey)}`);
    startGroup.addStaticText(null, 'This must be the cover Master (open it in the Pages panel first). Units follow Document Setup.').setIsFullWidth();

    const coverGroup = col1.addGroup('Back & Front Cover');
    // New: start from the open page, so an unchanged dialog keeps the page size.
    const fromPage = (dims.widthPt - DEFAULTS.spineWidth) / 2;
    ui.coverWidth = lengthEditor(coverGroup, 'Width (each)', fromPage > 0 ? fromPage : DEFAULTS.coverWidth);
    ui.coverHeight = lengthEditor(coverGroup, 'Height', dims.heightPt > 0 ? dims.heightPt : DEFAULTS.coverHeight);
    const canResize = dims.pageCount === 1;
    ui.resizeSpread = coverGroup.addSwitch(canResize ? 'Resize page (anchored to centre)' : `Resize needs a 1-page spread (has ${dims.pageCount})`, canResize);
    ui.resizeSpread.isEnabled = canResize;
    // Update: the width comes from the page, so it is shown, not edited.
    ui.coverInfo = coverGroup.addStaticText('Width (each)', '');

    const bleedValues = Object.values(dims.bleedPt);
    const docBleedUniform = bleedValues.every(v => Math.abs(v - bleedValues[0]) < 1e-6);
    const initialBleed = docBleedUniform && bleedValues[0] > 0 ? bleedValues[0] : DEFAULTS.bleed;
    const bleedGroup = col1.addGroup('Bleed & Safe Area');
    ui.bleed = lengthEditor(bleedGroup, 'Bleed', initialBleed);
    ui.safeInset = lengthEditor(bleedGroup, 'Safe distance', DEFAULTS.safeInset);
    ui.safeFrom = bleedGroup.addButtonSet('Safe from', ['Bleed edge', 'Trim edge'], DEFAULTS.safeFrom === 'trim' ? 1 : 0);

    // --- Column 2: spine + summary -------------------------------------------
    const col2 = dlg.addColumn();
    const spineGroup = col2.addGroup('Spine');
    ui.spineMode = spineGroup.addButtonSet('Width from', ['Manual', 'Page count'], 0);
    ui.manualSpine = lengthEditor(spineGroup, 'Spine width', DEFAULTS.spineWidth);
    ui.pageCount = spineGroup.addTextBox('Page count', String(DEFAULTS.pageCount));
    ui.caliper = lengthEditor(spineGroup, 'Paper caliper', DEFAULTS.caliper, 2);
    ui.spineFormula = spineGroup.addStaticText('Estimate', '');

    const summaryGroup = col2.addGroup('Summary');
    ui.summary = summaryGroup.addStaticText(null, '').setIsFullWidth();

    // --- Column 3: guides ----------------------------------------------------
    const col3 = dlg.addColumn();
    const guidesGroup = col3.addGroup('Guides');
    ui.guideSwitches = {};
    for (const set of GUIDE_SETS) {
        const control = guidesGroup.addSwitch(set.label, true);
        if (set.locked) {
            control.isEnabled = false; // the spine centre guide can't be turned off
        }
        ui.guideSwitches[set.key] = control;
    }
    ui.livePreview = guidesGroup.addSwitch('Show on spread while editing', true);

    dlg.initialWidth = 1080;
    return ui;
}

function parsePageCount(text) {
    const trimmed = String(text ?? '').trim();
    return /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
}

/** Reads the dialog into settings (lengths in points). mode is null until an action is chosen. */
function readSettings(ui, unitKey, dims, confirmedOddPageCount) {
    const mode = ui.action.selectedIndex === 1 ? 'new' : ui.action.selectedIndex === 2 ? 'update' : null;
    const spineMode = ui.spineMode.selectedIndex === 0 ? 'manual' : 'calculated';
    const pageCount = parsePageCount(ui.pageCount.text);
    const caliper = ui.caliper.value;
    const spine = calculateSpine({ mode: spineMode, manualWidth: ui.manualSpine.value, pageCount, caliper });
    const enabled = Object.fromEntries(GUIDE_SETS.map(s => [s.key, s.locked || ui.guideSwitches[s.key].value]));
    return {
        mode,
        unitKey,
        coverWidth: mode === 'update' ? (dims.widthPt - spine.width) / 2 : ui.coverWidth.value,
        coverHeight: mode === 'update' ? dims.heightPt : ui.coverHeight.value,
        resizeSpread: mode === 'new' && ui.resizeSpread.isEnabled && ui.resizeSpread.value,
        spineMode,
        spineWidth: spine.width,
        spineIsEstimate: spine.isEstimate,
        pageCount,
        caliper,
        oddPageCountConfirmed: pageCount === confirmedOddPageCount,
        bleed: ui.bleed.value,
        safeInset: ui.safeInset.value,
        safeFrom: ui.safeFrom.selectedIndex === 0 ? 'bleed' : 'trim',
        enabled,
        livePreview: ui.livePreview.value,
    };
}

/** Geometry in points, for the summary and for validation. */
function calculateGeometryPoints(settings, dims) {
    const useTarget = settings.mode === 'new' && settings.resizeSpread;
    return calculateCoverGeometry({
        totalWidth: useTarget ? pageWidthFromCover(settings.coverWidth, settings.spineWidth) : dims.widthPt,
        totalHeight: useTarget ? settings.coverHeight : dims.heightPt,
        spineWidth: settings.spineWidth,
        bleed: settings.bleed,
        safeInset: settings.safeInset,
        safeFrom: settings.safeFrom,
    });
}

/** The calculated values shown in the dialog, measured from the left/top trim edge. */
function renderSummary(g, settings, dims) {
    const u = settings.unitKey;
    const f = v => formatLength(v, u);
    const lines = [
        `Back ${f(g.panelWidth)} + spine ${f(g.spineWidth)} + front ${f(g.panelWidth)}`,
        `Page ${f(g.totalWidth)} × ${f(g.totalHeight)}`,
        `Spine centre ${f(g.pageCenterX)}  (spine ${f(g.spineLeft)} → ${f(g.spineRight)})`,
        `${calculateGuides(g, settings.enabled).length} guides will be added`,
    ];
    const bleed = checkDocumentBleed(dims, settings.bleed, u);
    if (!bleed.matches) lines.push(`⚠ ${bleed.short}`);
    if (settings.mode === 'new' && !settings.resizeSpread) lines.push('⚠ Resize is off: uses the current spread size');
    return lines;
}

function refreshDialog(api, doc, ui, settings, dims) {
    // New edits the cover size; Update reads it from the page.
    const isUpdate = settings.mode === 'update';
    ui.coverWidth.isVisible = !isUpdate;
    ui.coverHeight.isVisible = !isUpdate;
    ui.resizeSpread.isVisible = !isUpdate;
    ui.coverInfo.isVisible = isUpdate;

    // Show only the spine controls for the chosen method.
    const calculated = settings.spineMode === 'calculated';
    ui.manualSpine.isVisible = !calculated;
    ui.pageCount.isVisible = calculated;
    ui.caliper.isVisible = calculated;
    ui.spineFormula.isVisible = calculated;
    ui.spineFormula.text = Number.isFinite(settings.pageCount)
        ? describeSpineFormula(settings.pageCount, settings.caliper, settings.unitKey)
        : 'Enter a whole page count';

    const g = calculateGeometryPoints(settings, dims);
    ui.coverInfo.text = formatLength(g.panelWidth, settings.unitKey);
    const { errors } = validateInputs(settings, g);
    if (!settings.mode) {
        ui.summary.text = 'Choose an action to continue.';
    } else {
        ui.summary.text = errors.length > 0
            ? ['⚠ Cannot build guides:', ...errors].join('\n')
            : renderSummary(g, settings, dims).join('\n');
    }

    doc.clearPreviews();
    if (settings.mode && settings.livePreview && errors.length === 0) {
        doc.executeCommand(createGuides(api, settings, dims).command, true);
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    const api = loadAffinityApi();
    const doc = api.Document.current;
    if (!doc) {
        alert(`${SCRIPT_TITLE}\n\nOpen a document first, then show the cover Master in the Pages panel.`);
        return;
    }

    const unitKey = getSelectedUnit(api, doc);
    const spread = doc.currentSpread;
    const dims = getPageDimensions(doc, spread);
    const ui = buildDialog(api, unitKey, dims);
    let confirmedOddPageCount = null; // the odd page count the user chose to keep
    const current = () => readSettings(ui, unitKey, dims, confirmedOddPageCount);
    ui.dlg.onControlValueChangedHandler = () => {
        try {
            refreshDialog(api, doc, ui, current(), dims);
        } catch (err) {
            console.log(`${SCRIPT_TITLE}: refresh error: ${err}`);
        }
    };
    refreshDialog(api, doc, ui, current(), dims);

    try {
        while (isOk(api, ui.dlg.runModal())) {
            let settings = current();
            if (!settings.mode) {
                alert('Choose "Create / prepare new" or "Update existing" in Action, then press OK.');
                continue;
            }

            if (settings.spineMode === 'calculated' && Number.isInteger(settings.pageCount) &&
                settings.pageCount >= 2 && settings.pageCount % 2 !== 0 && !settings.oddPageCountConfirmed) {
                const even = nextEvenPageCount(settings.pageCount);
                if (confirm(`Page count ${settings.pageCount} is odd. A book always has an even number of pages.\n\n` +
                    `OK: round up to ${even}.\nCancel: keep ${settings.pageCount} anyway.`)) {
                    ui.pageCount.text = String(even);
                } else {
                    confirmedOddPageCount = settings.pageCount;
                }
                settings = current();
            }

            const g = calculateGeometryPoints(settings, dims);
            const { errors } = validateInputs(settings, g);
            if (errors.length > 0) {
                alert(`Please fix the following:\n\n• ${errors.join('\n• ')}`);
                continue;
            }

            const bleedCheck = checkDocumentBleed(dims, settings.bleed, unitKey);
            const cautions = [
                'Existing guides stay in place. Remove any old cover guides in View ▸ Guides Manager.',
            ];
            if (!bleedCheck.matches) cautions.push(bleedCheck.message);
            if (settings.spineIsEstimate) cautions.push('The spine width is an ESTIMATE from the page count. Check it with your printer.');
            if (!confirm(`Apply ${settings.mode === 'new' ? 'new cover master' : 'guide update'}?\n\n` +
                `Spine ${formatLength(settings.spineWidth, unitKey)}, centred at ${formatLength(g.pageCenterX, unitKey)}.\n\n` +
                `• ${cautions.join('\n• ')}`)) {
                continue;
            }

            doc.clearPreviews();
            const result = settings.mode === 'new' && settings.resizeSpread
                ? applyNewWithResize(api, doc, spread, settings, dims)
                : updateGuides(api, doc, settings, dims);

            const finalGeometry = calculateCoverGeometry({
                totalWidth: result.dims.widthPt,
                totalHeight: result.dims.heightPt,
                spineWidth: settings.spineWidth,
                bleed: settings.bleed,
                safeInset: settings.safeInset,
                safeFrom: settings.safeFrom,
            });
            const report = [
                `${result.guideCount} native guides added.`,
                ...renderPreview(finalGeometry, unitKey),
                checkDocumentBleed(result.dims, settings.bleed, unitKey).message,
            ];
            if (result.note) report.push(result.note);
            alert(`${SCRIPT_TITLE}: done\n\n${report.join('\n')}\n\nUse Edit ▸ Undo to reverse.`);
            return;
        }
    } catch (err) {
        alert(`${SCRIPT_TITLE}\n\nNothing more was changed. Error:\n${err?.message ?? err}`);
    } finally {
        doc.clearPreviews();
    }
}

// ============================================================================
// Entry point
// ============================================================================

const IS_NODE = typeof process !== 'undefined' && !!process.versions?.node;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        UNITS, UNIT_KEYS, DEFAULTS, GUIDE_SETS,
        toPoints, fromPoints, formatLength,
        calculateSpine, describeSpineFormula, pageWidthFromCover,
        calculateCoverGeometry, calculateGuides, dedupeGuides,
        validateInputs, nextEvenPageCount, renderPreview, allGuideSetsEnabled,
    };
}

if (!IS_NODE) {
    main();
}
