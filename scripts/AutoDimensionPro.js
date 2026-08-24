'use strict';

const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');
const { AddChildNodesCommandBuilder } = require('/commands');
const { PolyCurveNodeDefinition, ArtTextNodeDefinition, NodeChildType } = require('/nodes');
const { CurveBuilder, PolyCurve } = require('/geometry');
const { FillDescriptor } = require('/fills');
const { LineStyleDescriptor, LineCap, LineJoin } = require('/linestyle');
const { Colour } = require('/colours');
const { StoryBuilder } = require('/storybuilder');
const { StoryDelta } = require('/storydelta');
const { GlyphAttDoubleType } = require('/glyphatts');
const { ParagraphAlignXType } = require('/paragraphatts');
const { UnitValueConverter, UnitType } = require('/units');
const { BlendMode } = require('affinity:common');

function runAutoDimensionTool() {
    try {
        const doc = Document.current;
        if (!doc) {
            console.error('No document open in Affinity.');
            return;
        }

        const sel = doc.selection;
        if (!sel || !sel.items) {
            console.error('Select at least one object before running the script.');
            return;
        }

        const validNodes = [];
        const source = sel.items || sel;

        try {
            for (const item of source) {
                if (!item) continue;
                const node = item.node || item;
                if (!node) continue;
                const box = node.spreadBaseBox || node.parentBaseBox || node.box;
                if (box && box.width > 0 && box.height > 0) {
                    validNodes.push({ node: node, box: box });
                }
            }
        } catch (e) {}

        if (validNodes.length === 0) {
            const count = source.length || source.count || 0;
            for (let i = 0; i < count; i++) {
                const item = source[i] || (source.item && source.item(i));
                if (!item) continue;
                const node = item.node || item;
                if (!node) continue;
                const box = node.spreadBaseBox || node.parentBaseBox || node.box;
                if (box && box.width > 0 && box.height > 0) {
                    validNodes.push({ node: node, box: box });
                }
            }
        }

        if (validNodes.length === 0) {
            console.error('No valid objects found in selection.');
            return;
        }

        const dpi = doc.dpi || 300;
        const converter = UnitValueConverter.create(dpi);
        const pxPerMm = dpi / 25.4;

        const dialog = Dialog.create('Auto Dimension');
        dialog.initialWidth = 580;
        dialog.setIsResizable(true);

        const col = dialog.addColumn();
        col.setPaddingFactor(1.25);

        const groupModo = col.addGroup('Measurement');

        const dimOptions = [
            'Width and Height (Both)',
            'Width Only (W)',
            'Height Only (H)',
            'Diameter (Ø)',
            'Area'
        ];
        const comboDim = groupModo.addComboBox('Dimensions to Measure:', dimOptions, dimOptions[0]);
        comboDim.setIsFullWidth(true);

        const groupEscala = col.addGroup('Scale & Measurement Unit');
        const unitOptions = [
            'Millimeters (mm)',
            'Centimeters (cm)',
            'Meters (m)',
            'Inches (in)',
            'Points (pt)',
            'Pixels (px)'
        ];
        let defaultUnitIdx = 0;
        if (doc.units) {
            const uName = doc.units.toString().toLowerCase();
            if (uName.includes('centimetre') || uName.includes('cm')) defaultUnitIdx = 1;
            else if (uName.includes('metre') || uName.includes('meter') || uName === 'm') defaultUnitIdx = 2;
            else if (uName.includes('inch') || uName.includes('in')) defaultUnitIdx = 3;
            else if (uName.includes('point') || uName.includes('pt')) defaultUnitIdx = 4;
            else if (uName.includes('pixel') || uName.includes('px')) defaultUnitIdx = 5;
            else defaultUnitIdx = 0;
        }
        const comboUnit = groupEscala.addComboBox('Measurement Unit:', unitOptions, unitOptions[defaultUnitIdx]);
        comboUnit.setIsFullWidth(true);

        const scaleOptions = [
            '1:1 (Real Size)',
            '1:2', '1:5', '1:10', '1:20', '1:25', '1:50', '1:75', '1:100', '1:125', '1:200', '1:250', '1:500', '1:1000',
            '2:1 (2x Magnification)', '5:1 (5x Magnification)', '10:1 (10x Magnification)'
        ];
        const comboScale = groupEscala.addComboBox('Drawing Scale:', scaleOptions, scaleOptions[0]);
        comboScale.setIsFullWidth(true);

        const precisionOptions = ['2 Decimal Places (0.00)', '3 Decimal Places (0.000)', '1 Decimal Place (0.0)', 'No Decimals (Integer)'];
        const comboPrecision = groupEscala.addComboBox('Numeric Precision:', precisionOptions, precisionOptions[0]);
        comboPrecision.setIsFullWidth(true);

        const groupEstilo = col.addGroup('Visual Style');
        const styleOptions = [
            'Oblique / Architectural Stroke (45° Tick)',
            'Technical Arrows (Lines)',
            'Technical Arrows (Filled Triangle)',
            'Dots / Bullets (Minimalist)',
            'Clean Lines (No Markers)'
        ];
        const comboStyle = groupEstilo.addComboBox('Terminators Style:', styleOptions, styleOptions[0]);
        comboStyle.setIsFullWidth(true);

        const textFormatOptions = [
            'With Technical Prefix (Ex: W: 2.50 m / H: 1.20 m)',
            'Numeric Value + Unit Only (Ex: 2.50 m)'
        ];
        const comboTextFormat = groupEstilo.addComboBox('Text Format:', textFormatOptions, textFormatOptions[0]);
        comboTextFormat.setIsFullWidth(true);

        const colourOptions = [
            'Registration Color (Registration 100/100/100/100 Overprint)',
            'Spot Dieline (100% Magenta Overprint / Cut)',
            'Technical Spot Cyan (100% Cyan Overprint)',
            'Technical Black (100% K)',
            'Technical Red (CMYK 0/100/100/0)'
        ];
        const comboColour = groupEstilo.addComboBox('Color Mode:', colourOptions, colourOptions[0]);
        comboColour.setIsFullWidth(true);

        const checkExtLines = groupEstilo.addCheckBox('Include Extension / Auxiliary Lines', true);
        checkExtLines.setIsFullWidth(true);

        const dialogResult = dialog.runModal();
        if (dialogResult && dialogResult.value === DialogResult.Cancel.value) {
            return;
        }

        const selectedDimIdx = comboDim.selectedIndex;
        const selectedUnitIdx = comboUnit.selectedIndex;
        const selectedScaleIdx = comboScale.selectedIndex;
        const selectedPrecisionIdx = comboPrecision.selectedIndex;
        const selectedStyleIdx = comboStyle.selectedIndex;
        const selectedTextFormatIdx = comboTextFormat.selectedIndex;
        const selectedColourIdx = comboColour.selectedIndex;
        const includeExt = checkExtLines.value;

        let unitFactor = 1.0;
        let unitSuffix = 'mm';
        switch (selectedUnitIdx) {
            case 0: unitFactor = converter.getConversionFactor(UnitType.Pixel, UnitType.Millimetre); unitSuffix = 'mm'; break;
            case 1: unitFactor = converter.getConversionFactor(UnitType.Pixel, UnitType.Centimetre); unitSuffix = 'cm'; break;
            case 2: unitFactor = converter.getConversionFactor(UnitType.Pixel, UnitType.Millimetre) / 1000.0; unitSuffix = 'm'; break;
            case 3: unitFactor = converter.getConversionFactor(UnitType.Pixel, UnitType.Inch); unitSuffix = 'in'; break;
            case 4: unitFactor = converter.getConversionFactor(UnitType.Pixel, UnitType.Point); unitSuffix = 'pt'; break;
            case 5: unitFactor = 1.0; unitSuffix = 'px'; break;
        }

        const scaleFactors = [1.0, 2.0, 5.0, 10.0, 20.0, 25.0, 50.0, 75.0, 100.0, 125.0, 200.0, 250.0, 500.0, 1000.0, 0.5, 0.2, 0.1];
        const scaleRatio = scaleFactors[selectedScaleIdx] || 1.0;
        const scaleLabel = scaleOptions[selectedScaleIdx].split(' ')[0];

        function formatNumber(value) {
            switch (selectedPrecisionIdx) {
                case 0: return value.toFixed(2);
                case 1: return value.toFixed(3);
                case 2: return value.toFixed(1);
                case 3: return Math.round(value).toString();
                default: return value.toFixed(2);
            }
        }

        let annotationColour;
        let colourName = 'Registration';
        if (selectedColourIdx === 0) {
            annotationColour = Colour.createCMYKA8({ c: 255, m: 255, y: 255, k: 255, alpha: 255 });
            annotationColour.overprint = true;
            colourName = 'Registration';
        } else if (selectedColourIdx === 1) {
            annotationColour = Colour.createCMYKA8({ c: 0, m: 255, y: 0, k: 0, alpha: 255 });
            annotationColour.overprint = true;
            colourName = 'Dieline';
        } else if (selectedColourIdx === 2) {
            annotationColour = Colour.createCMYKA8({ c: 255, m: 0, y: 0, k: 0, alpha: 255 });
            annotationColour.overprint = true;
            colourName = 'Cyan';
        } else if (selectedColourIdx === 3) {
            annotationColour = Colour.createCMYKA8({ c: 0, m: 0, y: 0, k: 255, alpha: 255 });
            colourName = 'Black';
        } else {
            annotationColour = Colour.createCMYKA8({ c: 0, m: 255, y: 255, k: 0, alpha: 255 });
            colourName = 'Red';
        }

        const strokeWidth = Math.max(0.5, 0.25 * pxPerMm);
        const lineStyle = LineStyleDescriptor.createDefault(strokeWidth);
        lineStyle.lineCap = LineCap.Round;
        lineStyle.lineJoin = LineJoin.Round;

        const strokeFill = FillDescriptor.createSolid(annotationColour, BlendMode.Normal);

        const boxes = [];
        for (const v of validNodes) {
            boxes.push(v.box);
        }

        const targetsToMeasure = [];
        for (const b of boxes) {
            targetsToMeasure.push({ box: b, isGlobal: false, offsetMultiplier: 1.0 });
        }

        const masterPolyCurve = new PolyCurve();
        const masterFillCurve = new PolyCurve();
        const textDefs = [];

        function addSegment(x1, y1, x2, y2) {
            const cb = CurveBuilder.create();
            cb.beginXY(x1, y1);
            cb.lineToXY(x2, y2);
            masterPolyCurve.addCurve(cb.createCurve());
        }

        function addTerminator(x, y, orientation, isStart) {
            if (selectedStyleIdx === 0) {
                const size = 1.3 * pxPerMm;
                addSegment(x - size, y + size, x + size, y - size);
            } else if (selectedStyleIdx === 1 || selectedStyleIdx === 2) {
                let tipDx = 0, tipDy = 0;
                if (orientation === 'H') {
                    tipDx = isStart ? -1 : 1;
                    tipDy = 0;
                } else if (orientation === 'V') {
                    tipDx = 0;
                    tipDy = isStart ? -1 : 1;
                } else if (orientation === 'D') {
                    tipDx = isStart ? -0.7071 : 0.7071;
                    tipDy = isStart ? 0.7071 : -0.7071;
                }

                const isFilled = (selectedStyleIdx === 2);
                const arrowLen = isFilled ? 2.8 * pxPerMm : 2.4 * pxPerMm;
                const arrowHalfW = isFilled ? 0.9 * pxPerMm : 0.8 * pxPerMm;

                const tailX = x - tipDx * arrowLen;
                const tailY = y - tipDy * arrowLen;
                const perpX = -tipDy * arrowHalfW;
                const perpY = tipDx * arrowHalfW;

                const p1x = tailX + perpX;
                const p1y = tailY + perpY;
                const p2x = tailX - perpX;
                const p2y = tailY - perpY;

                if (isFilled) {
                    const cb = CurveBuilder.create();
                    cb.beginXY(x, y);
                    cb.lineToXY(p1x, p1y);
                    cb.lineToXY(p2x, p2y);
                    cb.lineToXY(x, y);
                    masterFillCurve.addCurve(cb.createCurve());
                } else {
                    addSegment(x, y, p1x, p1y);
                    addSegment(x, y, p2x, p2y);
                }
            } else if (selectedStyleIdx === 3) {
                const dotSize = 0.8 * pxPerMm;
                const cb = CurveBuilder.create();
                cb.beginXY(x, y - dotSize);
                cb.lineToXY(x + dotSize, y);
                cb.lineToXY(x, y + dotSize);
                cb.lineToXY(x - dotSize, y);
                cb.lineToXY(x, y - dotSize);
                masterFillCurve.addCurve(cb.createCurve());
            }
        }

        function addTextNode(x, y, textStr, label) {
            const fontSize = Math.max(8, 2.8 * pxPerMm);
            const sb = StoryBuilder.create();
            sb.applyGlyphDelta(StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, fontSize));
            sb.applyParagraphDelta(StoryDelta.createAlignX(ParagraphAlignXType.Left));
            sb.addText(textStr);
            const textDef = ArtTextNodeDefinition.createFromStoryBuilder({ x: x, y: y }, sb);
            textDef.userDescription = label;
            textDefs.push(textDef);
        }

        const baseOffset = 6.0 * pxPerMm;
        const extLen = 1.8 * pxPerMm;
        const gap = 0.8 * pxPerMm;

        for (const target of targetsToMeasure) {
            const box = target.box;
            const currentOffset = baseOffset * target.offsetMultiplier;
            const isGlobal = target.isGlobal;

            const realW = box.width * unitFactor * scaleRatio;
            const realH = box.height * unitFactor * scaleRatio;
            const wFormatted = formatNumber(realW);
            const hFormatted = formatNumber(realH);

            const prefixTag = isGlobal ? '[Total] ' : '';
            const wLabel = selectedTextFormatIdx === 0 ? `${prefixTag}W: ${wFormatted} ${unitSuffix}` : `${wFormatted} ${unitSuffix}`;
            const hLabel = selectedTextFormatIdx === 0 ? `${prefixTag}H: ${hFormatted} ${unitSuffix}` : `${hFormatted} ${unitSuffix}`;

            if (selectedDimIdx === 0 || selectedDimIdx === 1) {
                const dimY = box.y - currentOffset;
                if (includeExt) {
                    addSegment(box.x, box.y - gap, box.x, dimY - extLen);
                    addSegment(box.x + box.width, box.y - gap, box.x + box.width, dimY - extLen);
                }
                addSegment(box.x, dimY, box.x + box.width, dimY);
                addTerminator(box.x, dimY, 'H', true);
                addTerminator(box.x + box.width, dimY, 'H', false);

                const textApproxHalfW = 6.0 * pxPerMm;
                addTextNode(
                    box.x + (box.width / 2) - textApproxHalfW,
                    dimY - (1.5 * pxPerMm),
                    wLabel,
                    `Width Quote: ${wFormatted} ${unitSuffix}`
                );
            }

            if (selectedDimIdx === 0 || selectedDimIdx === 2) {
                const dimX = box.x + box.width + currentOffset;
                if (includeExt) {
                    addSegment(box.x + box.width + gap, box.y, dimX + extLen, box.y);
                    addSegment(box.x + box.width + gap, box.y + box.height, dimX + extLen, box.y + box.height);
                }
                addSegment(dimX, box.y, dimX, box.y + box.height);
                addTerminator(dimX, box.y, 'V', true);
                addTerminator(dimX, box.y + box.height, 'V', false);

                addTextNode(
                    dimX + (2.0 * pxPerMm),
                    box.y + (box.height / 2) + (1.0 * pxPerMm),
                    hLabel,
                    `Height Quote: ${hFormatted} ${unitSuffix}`
                );
            }

            if (selectedDimIdx === 3) {
                const avgDim = ((box.width + box.height) / 2) * unitFactor * scaleRatio;
                const diamFormatted = formatNumber(avgDim);
                const diamLabel = selectedTextFormatIdx === 0 ? `${prefixTag}Ø: ${diamFormatted} ${unitSuffix}` : `Ø ${diamFormatted} ${unitSuffix}`;

                const cx = box.x + box.width / 2;
                const cy = box.y + box.height / 2;
                const rx = box.width / 2;
                const ry = box.height / 2;

                const x1 = cx - rx * 0.7071;
                const y1 = cy + ry * 0.7071;
                const x2 = cx + rx * 0.7071;
                const y2 = cy - ry * 0.7071;

                addSegment(x1, y1, x2, y2);
                addTerminator(x1, y1, 'D', true);
                addTerminator(x2, y2, 'D', false);

                const leadX = x2 + (4.0 * pxPerMm);
                const leadY = y2 - (4.0 * pxPerMm);
                addSegment(x2, y2, leadX, leadY);
                addSegment(leadX, leadY, leadX + (7.0 * pxPerMm), leadY);

                addTextNode(
                    leadX + (0.5 * pxPerMm),
                    leadY - (1.2 * pxPerMm),
                    diamLabel,
                    `Diameter Quote: ${diamFormatted} ${unitSuffix}`
                );
            }

            if (selectedDimIdx === 4) {
                const area = realW * realH;
                const areaFormatted = formatNumber(area);
                const areaUnitSuffix = unitSuffix + '²';
                const areaLabel = selectedTextFormatIdx === 0 ? `${prefixTag}Area: ${areaFormatted} ${areaUnitSuffix}` : `${areaFormatted} ${areaUnitSuffix}`;

                const cx = box.x + box.width / 2;
                const cy = box.y + box.height / 2;

                const textApproxHalfW = 8.0 * pxPerMm;
                addTextNode(
                    cx - textApproxHalfW,
                    cy,
                    areaLabel,
                    `Area Quote: ${areaFormatted} ${areaUnitSuffix}`
                );
            }
        }

        if (masterPolyCurve.curveCount > 0 || masterFillCurve.curveCount > 0 || textDefs.length > 0) {
            const builder = AddChildNodesCommandBuilder.create();
            const modeTag = 'Individual';

            if (masterPolyCurve.curveCount > 0) {
                const polyDef = PolyCurveNodeDefinition.create(
                    masterPolyCurve,
                    FillDescriptor.createNone(),
                    lineStyle,
                    strokeFill,
                    FillDescriptor.createNone()
                );
                polyDef.userDescription = `📐 Dimension Lines [${scaleLabel}] (${unitSuffix})`;
                builder.addPolyCurveNode(polyDef);
            }

            if (masterFillCurve.curveCount > 0) {
                const fillDef = PolyCurveNodeDefinition.create(
                    masterFillCurve,
                    strokeFill,
                    lineStyle,
                    strokeFill,
                    FillDescriptor.createNone()
                );
                fillDef.userDescription = `📐 Dimension Markers [${scaleLabel}]`;
                builder.addPolyCurveNode(fillDef);
            }

            for (const tDef of textDefs) {
                builder.addNode(tDef);
            }

            const cmd = builder.createCommand(true, NodeChildType.Main);
            doc.executeCommand(cmd);

            console.log(`✅ Dimensions successfully applied [Scale: ${scaleLabel} | Unit: ${unitSuffix}].`);
        }

    } catch (err) {
        console.error('Error running dimension script:', err);
    }
}

runAutoDimensionTool();
