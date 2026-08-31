/**
 * name: Advanced Frame Builder
 * description: Generate up to 5 concentric frames. Stable geometry for ultra-thick strokes.
 * version: 2.10.0
 * author: sort0m
 */

const { Document } = require("/document");
const { PolyCurveNodeDefinition, ContainerNodeDefinition, NodeChildType } = require("/nodes");
const { AddChildNodesCommandBuilder } = require("/commands");
const { CurveBuilder, PolyCurve } = require("/geometry");
const { FillDescriptor } = require("/fills");
const { LineStyle, LineStyleDescriptor } = require("/linestyle");
const { RGBA8 } = require("/colours");
const { BlendMode } = require("affinity:common");
const { Dialog, DialogResult } = require("/dialog.js");
const { UnitType } = require("/units");

// --- Helper Functions ---
function solid(r, g, b, a) { return FillDescriptor.createSolid(RGBA8(r, g, b, a == null ? 255 : a), BlendMode.Normal); }
function noFill() { return FillDescriptor.createNone(); }

function customLineStyle(width) {
    try {
        const ls = LineStyle.createDefaultWithWeight(width);
        ls.join = 0;
        return LineStyleDescriptor.create(ls);
    } catch (e) {
        return LineStyleDescriptor.createDefault(width);
    }
}

// Yhdistetty, vakaa ja turvallinen kaarigeneraattori kaikille muodoille
function getSimpleArc(cx, cy, r, aStart, aEnd, steps) {
    let pts = [];
    for (let i = 0; i <= steps; i++) {
        let a = aStart + (aEnd - aStart) * (i / steps);
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    return pts;
}

function buildPolyForStyle(style, cx, cy, W, H, rArr, S) {
    let w2 = W/2 - S;
    let h2 = H/2 - S;
    let pts = [];
    let steps = 16;

    let r0 = rArr[0], r1 = rArr[1], r2 = rArr[2], r3 = rArr[3];

    if (style === 0) { // Standard
        pts.push({x: cx - w2, y: cy - h2});
        pts.push({x: cx + w2, y: cy - h2});
        pts.push({x: cx + w2, y: cy + h2});
        pts.push({x: cx - w2, y: cy + h2});
    }
    else if (style === 1) { // Concave (BUG FIX: Käytetään vakaata getSimpleArc -funktiota ilman kiertolooppeja)
        let calc = (R, S) => {
            let effR = Math.max(2, R + S);
            let D = Math.sqrt(Math.pow(effR, 2) - Math.pow(S, 2));
            return { effR, D: isNaN(D) ? effR : D };
        };

        if (r0 > 0) { let c = calc(r0,S); pts.push(...getSimpleArc(cx - W/2, cy - H/2, c.effR, Math.atan2(c.D, S), Math.atan2(S, c.D), steps)); }
        else { pts.push({x: cx - w2, y: cy - h2}); }

        if (r1 > 0) { let c = calc(r1,S); pts.push(...getSimpleArc(cx + W/2, cy - H/2, c.effR, Math.atan2(S, -c.D), Math.atan2(c.D, -S), steps)); }
        else { pts.push({x: cx + w2, y: cy - h2}); }

        if (r2 > 0) { let c = calc(r2,S); pts.push(...getSimpleArc(cx + W/2, cy + H/2, c.effR, Math.atan2(-c.D, -S), Math.atan2(-S, -c.D), steps)); }
        else { pts.push({x: cx + w2, y: cy + h2}); }

        if (r3 > 0) { let c = calc(r3,S); pts.push(...getSimpleArc(cx - W/2, cy + H/2, c.effR, Math.atan2(-S, c.D), Math.atan2(-c.D, S), steps)); }
        else { pts.push({x: cx - w2, y: cy + h2}); }
    }
    else if (style === 2) { // Bevel
        let calc = (R, S) => Math.max(0, R - S * (2 - Math.sqrt(2)));
        let b0 = calc(r0,S), b1 = calc(r1,S), b2 = calc(r2,S), b3 = calc(r3,S);

        if (r0 > 0) { pts.push({x: cx - w2 + b0, y: cy - h2}); } else { pts.push({x: cx - w2, y: cy - h2}); }
        if (r1 > 0) { pts.push({x: cx + w2 - b1, y: cy - h2}, {x: cx + w2, y: cy - h2 + b1}); } else { pts.push({x: cx + w2, y: cy - h2}); }
        if (r2 > 0) { pts.push({x: cx + w2, y: cy + h2 - b2}, {x: cx + w2 - b2, y: cy + h2}); } else { pts.push({x: cx + w2, y: cy + h2}); }
        if (r3 > 0) { pts.push({x: cx - w2 + b3, y: cy + h2}, {x: cx - w2, y: cy + h2 - b3}); } else { pts.push({x: cx - w2, y: cy + h2}); }
        if (r0 > 0) { pts.push({x: cx - w2, y: cy - h2 + b0}); }
    }
    else if (style === 3) { // Rounded
        let calc = (R, S) => Math.max(0, R - S);
        let b0 = calc(r0,S), b1 = calc(r1,S), b2 = calc(r2,S), b3 = calc(r3,S);

        if (r0 > 0 && b0 > 0) pts.push(...getSimpleArc(cx - w2 + b0, cy - h2 + b0, b0, Math.PI, Math.PI * 1.5, steps));
        else pts.push({x: cx - w2, y: cy - h2});

        if (r1 > 0 && b1 > 0) pts.push(...getSimpleArc(cx + w2 - b1, cy - h2 + b1, b1, Math.PI * 1.5, Math.PI * 2, steps));
        else pts.push({x: cx + w2, y: cy - h2});

        if (r2 > 0 && b2 > 0) pts.push(...getSimpleArc(cx + w2 - b2, cy + h2 - b2, b2, 0, Math.PI * 0.5, steps));
        else pts.push({x: cx + w2, y: cy + h2});

        if (r3 > 0 && b3 > 0) pts.push(...getSimpleArc(cx - w2 + b3, cy + h2 - b3, b3, Math.PI * 0.5, Math.PI, steps));
        else pts.push({x: cx - w2, y: cy + h2});
    }
    else if (style === 4) { // Cutout
        let x1 = cx - w2, y1 = cy - h2, x2 = cx + w2, y2 = cy + h2;

        if (r0 > 0) { pts.push({x:x1+r0, y:y1}); } else { pts.push({x:x1, y:y1}); }
        if (r1 > 0) { pts.push({x:x2-r1, y:y1}, {x:x2-r1, y:y1+r1}, {x:x2, y:y1+r1}); } else { pts.push({x:x2, y:y1}); }
        if (r2 > 0) { pts.push({x:x2, y:y2-r2}, {x:x2-r2, y:y2-r2}, {x:x2-r2, y:y2}); } else { pts.push({x:x2, y:y2}); }
        if (r3 > 0) { pts.push({x:x1+r3, y:y2}, {x:x1+r3, y:y2-r3}, {x:x1, y:y2-r3}); } else { pts.push({x:x1, y:y2}); }
        if (r0 > 0) { pts.push({x:x1, y:y1+r0}, {x:x1+r0, y:y1+r0}); }
    }

    const cb = CurveBuilder.create();
    cb.beginXY(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) cb.lineToXY(pts[i].x, pts[i].y);
    cb.close();
    const poly = new PolyCurve();
    poly.addCurve(cb.createCurve());
    return poly;
}

function isOk(res) {
    return res && (res.value === DialogResult.Ok || res.value === DialogResult.Ok.value || (res.equals && res.equals(DialogResult.Ok)));
}

function main() {
    const doc = Document.current;
    if (!doc) { alert("Please open a document first."); return; }

    const dlg1 = Dialog.create("Advanced Frame Builder (1/2)");
    dlg1.initialWidth = 360;
    const g1 = dlg1.addColumn().addGroup("Basic Setup");

    const countRadio = g1.addRadioGroup("Number of Frames", ["1 Frame", "2 Frames", "3 Frames", "4 Frames", "5 Frames"]);
    countRadio.selectedIndex = 2;

    const cornerModeRadio = g1.addRadioGroup("Corner Mode", ["Uniform (All equal)", "Independent (4 corners)"]);
    cornerModeRadio.selectedIndex = 0;

    const gapModeRadio = g1.addRadioGroup("Spacing Mode", ["Uniform (Equal visual gaps)", "Independent (Custom visual gaps)"]);
    gapModeRadio.selectedIndex = 0;

    if (!isOk(dlg1.runModal())) return;
    const lineCount = countRadio.selectedIndex + 1;
    const isUniformCorners = (cornerModeRadio.selectedIndex === 0);
    const isUniformGaps = (gapModeRadio.selectedIndex === 0);

    const dlg2 = Dialog.create("Advanced Frame Builder (2/2)");
    dlg2.initialWidth = 550;

    const groupGeom = dlg2.addColumn().addGroup("Base Size & Corners");

    function addNumber(targetGroup, label, def, min, max) {
        let ctrl = targetGroup.addUnitValueEditor(label, UnitType.Pixel, doc.units, def, min, max);
        ctrl.setShowPopupSlider(true);
        ctrl.setPrecision(0);
        return ctrl;
    }

    const ctrlW = addNumber(groupGeom, "Frame Width", 500, 10, 5000);
    const ctrlH = addNumber(groupGeom, "Frame Height", 500, 10, 5000);

    let ctrlR, ctrlR0, ctrlR1, ctrlR2, ctrlR3;

    if (isUniformCorners) {
        ctrlR = addNumber(groupGeom, "Corner Radius", 20, 0, 1000);
    } else {
        ctrlR0 = addNumber(groupGeom, "Radius (Top-Left)", 20, 0, 1000);
        ctrlR1 = addNumber(groupGeom, "Radius (Top-Right)", 20, 0, 1000);
        ctrlR2 = addNumber(groupGeom, "Radius (Bottom-Right)", 20, 0, 1000);
        ctrlR3 = addNumber(groupGeom, "Radius (Bottom-Left)", 20, 0, 1000);
    }

    const strokeGroup = dlg2.addColumn().addGroup("Frame Styles (" + lineCount + ")");

    let ctrlUniformGap;
    if (lineCount > 1 && isUniformGaps) {
        ctrlUniformGap = addNumber(strokeGroup, "Uniform Visual Gap", 8, 1, 500);
    }

    const styleOptions = ["Standard (Rectangle)", "Concave", "Bevel", "Rounded", "Cutout (Ticket)"];

    let widths = [];
    let styles = [];
    let gaps = [];

    const defaultStrokeWeights = [8, 5, 2, 1, 1];
    const defaultGaps = [8, 5, 5, 5];

    for (let i = 0; i < lineCount; i++) {
        let lineNum = i + 1;

        if (i > 0 && !isUniformGaps) {
            let dGap = (i - 1 < defaultGaps.length) ? defaultGaps[i - 1] : 5;
            gaps.push(addNumber(strokeGroup, "Visual Gap " + (i) + " -> " + lineNum, dGap, 1, 500));
        }

        let dWeight = (i < defaultStrokeWeights.length) ? defaultStrokeWeights[i] : 1;
        widths.push(addNumber(strokeGroup, lineNum + ". Stroke Weight", dWeight, 0, 50));

        let styleCtrl = strokeGroup.addRadioGroup(lineNum + ". Corner Style", styleOptions);
        styleCtrl.selectedIndex = 1;
        styles.push(styleCtrl);
    }

    if (!isOk(dlg2.runModal())) return;

    const builder = AddChildNodesCommandBuilder.create();
    const groupDef = ContainerNodeDefinition.create("Advanced Frame Group");
    builder.addContainerNode(groupDef);

    const cmd = builder.createCommand(true, NodeChildType.Main);
    doc.executeCommand(cmd);

    let newNodes = cmd.newNodes;
    if (newNodes.toArray) newNodes = newNodes.toArray();
    const groupNode = newNodes[0];
    if (!groupNode) return;

    const childBuilder = AddChildNodesCommandBuilder.create();
    childBuilder.setInsertionTarget(groupNode);

    const wVal = ctrlW.value || 500;
    const hVal = ctrlH.value || 500;

    const margin = 50;
    const cx = margin + (wVal / 2);
    const cy = margin + (hVal / 2);

    let r0, r1, r2, r3;
    if (isUniformCorners) {
        let rVal = ctrlR.value || 0;
        r0 = rVal; r1 = rVal; r2 = rVal; r3 = rVal;
    } else {
        r0 = ctrlR0.value || 0;
        r1 = ctrlR1.value || 0;
        r2 = ctrlR2.value || 0;
        r3 = ctrlR3.value || 0;
    }

    const radii = [r0, r1, r2, r3];

    const black = solid(0, 0, 0, 255);
    const transparent = noFill();

    let currentOffset = 0;
    let prevThickness = 0;
    let isFirstDrawn = true;

    for (let i = 0; i < lineCount; i++) {
        let wThickness = widths[i].value || 0;

        if (wThickness > 0) {
            if (!isFirstDrawn) {
                let visualGap = 8;
                if (isUniformGaps) {
                    visualGap = ctrlUniformGap.value || 8;
                } else {
                    visualGap = gaps[i-1].value || 8;
                }

                currentOffset += visualGap + (prevThickness / 2) + (wThickness / 2);
            }

            let poly = buildPolyForStyle(styles[i].selectedIndex, cx, cy, wVal, hVal, radii, currentOffset);
            childBuilder.addNode(PolyCurveNodeDefinition.create(poly, transparent, customLineStyle(wThickness), black, transparent));

            prevThickness = wThickness;
            isFirstDrawn = false;
        }
    }

    doc.executeCommand(childBuilder.createCommand(true, NodeChildType.Main));
}

main();
