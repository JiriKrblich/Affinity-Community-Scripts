/**
 * name: Type Scale Builder PT Fix 1.2
 * description: Builds a modular typography preview/specimen with direct point sizing, font choice, and repeatable updates.
 * version: 1.2.0
 * author: Codex
 */

"use strict";

const { Document } = require("/document");
const { Dialog, DialogResult } = require("/dialog");
const { UnitType } = require("/units");
const { Font } = require("/fonts");
const { StoryBuilder } = require("/storybuilder");
const { StoryDelta } = require("/storydelta");
const {
  GlyphAttDoubleType,
  LeadingOverrideType,
} = require("/glyphatts");
const {
  ParagraphAttDoubleType,
  ParagraphAttStringType,
  ParagraphLeadingType,
} = require("/paragraphatts");
const {
  AddChildNodesCommandBuilder,
  NodeChildType,
} = require("/commands");
const {
  FrameTextNodeDefinition,
  ShapeNodeDefinition,
} = require("/nodes");
const { Rectangle } = require("/geometry");
const { ShapeRectangle } = require("/shapes");
const { FillDescriptor } = require("/fills");
const { SVG11 } = require("/colours");

const SCALE_RULES = [
  { name: "Minor Second", ratio: 1.067 },
  { name: "Major Second", ratio: 1.125 },
  { name: "Minor Third", ratio: 1.2 },
  { name: "Major Third", ratio: 1.25 },
  { name: "Perfect Fourth", ratio: 1.333 },
  { name: "Golden Ratio", ratio: 1.618 },
  { name: "Custom Ratio", ratio: null },
];

const ROUNDING_MODES = [
  "No rounding",
  "Round to 0.5 pt",
  "Round to 1 pt",
];

const LINE_HEIGHT_MODES = [
  "Proportional",
  "Compact headings",
  "Baseline-friendly",
];

const DEFAULT_PREVIEW_TEXT = "The quick brown fox jumps over the lazy dog.";
const CUSTOM_RATIO_INDEX = SCALE_RULES.length - 1;
const BODY_OFFSET = 2;
const MAX_SPECIMEN_ROWS = 32;
const BUILD_ID = "PT-FIX-1.2-DIRECT-POINTS";

const PREVIEW = {
  margin: 72,
  titleSize: 24,
  metaSize: 10,
  labelSize: 9,
  leftWidth: 230,
  columnGap: 36,
  minRowHeight: 68,
  rowPadding: 18,
  dividerHeight: 0.75,
  pagePadding: 48,
};

function getUserSettings(doc) {
  const dialog = Dialog.create("Type Scale Builder PT Fix 1.2");
  dialog.initialWidth = 440;

  const col = dialog.addColumn();
  const scaleGroup = col.addGroup("Scale");

  const baseSizeCtrl = scaleGroup.addUnitValueEditor(
    "Base text size",
    UnitType.Number,
    UnitType.Number,
    16,
    1,
    400,
  );
  baseSizeCtrl.precision = 2;

  const scaleRuleCtrl = scaleGroup.addComboBox(
    "Scale rule",
    SCALE_RULES.map((rule) => `${rule.name} - ${rule.ratio || "custom"}`),
    3,
  );

  const customRatioCtrl = scaleGroup.addUnitValueEditor(
    "Custom ratio",
    UnitType.Number,
    UnitType.Number,
    1.25,
    1.001,
    4,
  );
  customRatioCtrl.precision = 3;
  customRatioCtrl.isEnabled = false;

  const rangeGroup = col.addGroup("Range");
  const belowCtrl = rangeGroup.addUnitValueEditor(
    "Steps below base",
    UnitType.Number,
    UnitType.Number,
    2,
    0,
    20,
  );
  belowCtrl.precision = 0;

  const aboveCtrl = rangeGroup.addUnitValueEditor(
    "Steps above base",
    UnitType.Number,
    UnitType.Number,
    5,
    0,
    24,
  );
  aboveCtrl.precision = 0;

  const formatGroup = col.addGroup("Formatting");
  const fontCtrl = formatGroup.addFontPicker("Font");
  fontCtrl.font = Font.createDefault();
  fontCtrl.isFullWidth = true;

  const roundingCtrl = formatGroup.addComboBox(
    "Rounding mode",
    ROUNDING_MODES,
    1,
  );
  const lineHeightCtrl = formatGroup.addComboBox(
    "Line-height mode",
    LINE_HEIGHT_MODES,
    0,
  );

  const textGroup = col.addGroup("Preview");
  const previewTextCtrl = textGroup.addTextBox("Preview text", DEFAULT_PREVIEW_TEXT);
  previewTextCtrl.isFullWidth = true;

  dialog.onControlValueChangedHandler = () => {
    customRatioCtrl.isEnabled = scaleRuleCtrl.selectedIndex === CUSTOM_RATIO_INDEX;
  };

  while (dialog.runModal().value === DialogResult.Ok.value) {
    const settings = {
      doc,
      baseSize: Number(baseSizeCtrl.value),
      scaleRuleIndex: scaleRuleCtrl.selectedIndex,
      customRatio: Number(customRatioCtrl.value),
      stepsBelow: Math.round(Number(belowCtrl.value)),
      stepsAbove: Math.round(Number(aboveCtrl.value)),
      roundingMode: ROUNDING_MODES[roundingCtrl.selectedIndex],
      lineHeightMode: LINE_HEIGHT_MODES[lineHeightCtrl.selectedIndex],
      previewText: String(previewTextCtrl.text || DEFAULT_PREVIEW_TEXT),
      font: fontCtrl.font || Font.createDefault(),
    };

    const error = validateSettings(settings);
    if (!error) return settings;
    showAlert(error);
  }

  return null;
}

function getScaleRatio(settings) {
  const rule = SCALE_RULES[settings.scaleRuleIndex] || SCALE_RULES[3];
  return {
    ruleName: rule.name,
    ratio: rule.ratio || settings.customRatio,
  };
}

function calculateTypeScale(settings) {
  const ratioInfo = getScaleRatio(settings);
  const rows = [];

  for (let step = -settings.stepsBelow; step <= settings.stepsAbove; step += 1) {
    const rawSize = step < 0
      ? settings.baseSize / Math.pow(ratioInfo.ratio, Math.abs(step))
      : settings.baseSize * Math.pow(ratioInfo.ratio, step);
    const size = roundSize(rawSize, settings.roundingMode);
    rows.push({
      step,
      size,
      lineHeight: calculateLineHeight(size, step, settings.lineHeightMode),
    });
  }

  const baseIndex = settings.stepsBelow;
  return rows.map((row, index) => {
    const styleLevel = index + BODY_OFFSET - baseIndex;
    return {
      ...row,
      index,
      styleName: getStyleName(styleLevel),
      role: getStyleRole(styleLevel),
    };
  });
}

function roundSize(value, roundingMode) {
  if (roundingMode === "Round to 0.5 pt") return Math.round(value * 2) / 2;
  if (roundingMode === "Round to 1 pt") return Math.round(value);
  return roundTo(value, 3);
}

function calculateLineHeight(size, step, mode) {
  const level = BODY_OFFSET + step;
  let multiplier;

  if (mode === "Compact headings") {
    if (level <= 1) multiplier = 1.3;
    else if (level === 2) multiplier = 1.4;
    else if (level === 3) multiplier = 1.3;
    else if (level >= 8) multiplier = 0.98;
    else multiplier = 1.08;
  } else {
    if (level <= 1) multiplier = 1.35;
    else if (level === 2) multiplier = 1.45;
    else if (level === 3) multiplier = 1.35;
    else if (level >= 8) multiplier = 1.05;
    else multiplier = 1.15;
  }

  const lineHeight = size * multiplier;
  if (mode === "Baseline-friendly") return Math.max(4, Math.round(lineHeight / 4) * 4);
  return roundTo(lineHeight, 2);
}

function createParagraphStyles(doc, scale) {
  // Affinity 3.2 JSLib exposes paragraph attributes and text formatting deltas,
  // but this install does not expose a public document text-style collection or
  // creation API. The preview uses ParagraphAttStringType.StyleName plus direct
  // formatting, so a future text-style API can be wired into this function.
  return scale.map((item) => ({
    name: item.styleName,
    size: item.size,
    lineHeight: item.lineHeight,
    created: false,
  }));
}

function createPreviewPage(doc, settings, scale, styleResults, preview) {
  const target = detectPreviewTarget(doc);
  const box = target.box;
  const builder = AddChildNodesCommandBuilder.create();
  builder.setInsertionTarget(target.node);

  const contentX = box.x + PREVIEW.margin;
  const contentY = box.y + PREVIEW.margin;
  const contentWidth = Math.max(420, box.width - PREVIEW.margin * 2);
  const rightX = contentX + PREVIEW.leftWidth + PREVIEW.columnGap;
  const rightWidth = Math.max(240, contentWidth - PREVIEW.leftWidth - PREVIEW.columnGap);

  addTextFrame(builder, "TYPE SCALE PREVIEW", {
    x: contentX,
    y: contentY,
    width: contentWidth,
    height: 42,
  }, PREVIEW.titleSize, 30, "Scale / Preview Title", settings.font);

  const ratioInfo = getScaleRatio(settings);
  const metaText = [
    `Base size: ${formatPt(settings.baseSize)}`,
    `Selected ratio: ${roundTo(ratioInfo.ratio, 4)}`,
    `Scale rule: ${ratioInfo.ruleName}`,
    `Rounding mode: ${settings.roundingMode}`,
    `Line-height mode: ${settings.lineHeightMode}`,
    `Generated styles: ${scale.length}`,
    `Build: ${BUILD_ID}`,
    "Sizing: direct point values, no 96/72 conversion",
    styleResults.every((style) => style.created)
      ? "Paragraph styles: created"
      : "Paragraph styles: direct text formatting fallback",
  ].join("\n");

  addTextFrame(builder, metaText, {
    x: contentX,
    y: contentY + 52,
    width: contentWidth,
    height: 112,
  }, PREVIEW.metaSize, 14, "Scale / Metadata", settings.font);

  let y = contentY + 186;
  const rows = scale.slice().reverse().slice(0, MAX_SPECIMEN_ROWS);

  for (const item of rows) {
    const previewHeight = Math.max(item.lineHeight * 1.55, PREVIEW.minRowHeight);
    const rowHeight = previewHeight + PREVIEW.rowPadding;

    addDivider(builder, contentX, y - 10, contentWidth);

    addTextFrame(builder, `${item.styleName}\n${formatPt(item.size)} / ${formatPt(item.lineHeight)}`, {
      x: contentX,
      y,
      width: PREVIEW.leftWidth,
      height: Math.max(rowHeight, 54),
    }, PREVIEW.labelSize, 13, "Scale / Spec Label", settings.font);

    addTextFrame(builder, settings.previewText, {
      x: rightX,
      y,
      width: rightWidth,
      height: Math.max(rowHeight, item.lineHeight * 2.2),
    }, item.size, item.lineHeight, item.styleName, settings.font);

    y += rowHeight;
  }

  doc.executeCommand(builder.createCommand(true, NodeChildType.Main), preview);
}

function applyTextFormatting(storyBuilder, size, lineHeight, styleName, font) {
  // Affinity's GlyphAttDoubleType.Height expects the same point value shown in
  // the Text panel. Do not convert 16 pt to 96-dpi pixels; that produces 21.33.
  storyBuilder.applyGlyphDelta(
    StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, size),
  );
  safeApplyFont(storyBuilder, font);
  storyBuilder.applyGlyphDelta(StoryDelta.createBrushFill(FillDescriptor.createSolid(SVG11.black)));

  if (styleName) {
    safeApplyParagraphString(storyBuilder, ParagraphAttStringType.StyleName, styleName);
  }

  // The exact leading enum name is not fully documented in the public wrapper.
  // Try known/candidate attributes; if none exist, Affinity keeps default leading.
  safeApplyLeading(storyBuilder, lineHeight);
}

function validateSettings(settings) {
  if (!settings.doc) return "Open a document before running Type Scale Builder.";
  if (!Number.isFinite(settings.baseSize) || settings.baseSize <= 0) {
    return "Base text size must be a positive number.";
  }
  if (settings.scaleRuleIndex === CUSTOM_RATIO_INDEX) {
    if (!Number.isFinite(settings.customRatio) || settings.customRatio <= 1) {
      return "Custom ratio must be greater than 1.";
    }
  }
  if (!Number.isInteger(settings.stepsBelow) || settings.stepsBelow < 0) {
    return "Steps below base must be a non-negative integer.";
  }
  if (!Number.isInteger(settings.stepsAbove) || settings.stepsAbove < 0) {
    return "Steps above base must be a non-negative integer.";
  }
  if ((settings.stepsBelow + settings.stepsAbove + 1) > MAX_SPECIMEN_ROWS) {
    return `Please generate ${MAX_SPECIMEN_ROWS} styles or fewer.`;
  }
  return null;
}

function addTextFrame(builder, text, rect, size, lineHeight, styleName, font) {
  const storyBuilder = StoryBuilder.create();
  applyTextFormatting(storyBuilder, size, lineHeight, styleName, font);
  storyBuilder.addText(text);
  builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(rect, storyBuilder));
}

function addDivider(builder, x, y, width) {
  const shape = ShapeRectangle.create();
  const rect = new Rectangle(x, y, width, PREVIEW.dividerHeight);
  builder.addShapeNode(
    ShapeNodeDefinition.create(
      shape,
      rect,
      FillDescriptor.createSolid(SVG11.lightgrey),
    ),
  );
}

function detectPreviewTarget(doc) {
  const selection = doc.selection;
  if (selection && selection.length > 0) {
    let node = selection.nodes.first;
    while (node && node[Symbol.toStringTag] !== "SpreadNode") {
      const artboardInterface = node.artboardInterface;
      if (artboardInterface && artboardInterface.isArtboardEnabled) {
        return {
          node,
          box: artboardInterface.baseBox,
        };
      }
      node = node.parent;
    }
  }

  const spread = doc.currentSpread || doc.spreads.first;
  return {
    node: spread,
    box: spread.getSpreadExtents(),
  };
}

function getStyleName(level) {
  const labels = [
    "Caption",
    "Small",
    "Body",
    "Lead",
    "Heading S",
    "Heading M",
    "Heading L",
    "Heading XL",
    "Display",
  ];

  if (level >= 0 && level < labels.length) {
    return `Scale / ${pad2(level)} ${labels[level]}`;
  }
  if (level < 0) return `Scale / ${pad2(level)} Micro ${Math.abs(level)}`;
  return `Scale / ${pad2(level)} Display ${level - 7}`;
}

function getStyleRole(level) {
  if (level <= 0) return "caption";
  if (level === 1) return "small";
  if (level === 2) return "body";
  if (level === 3) return "lead";
  if (level >= 8) return "display";
  return "heading";
}

function safeApplyLeading(storyBuilder, lineHeight) {
  const leadingTypes = ["Exact", "Exactly", "Fixed", "Absolute", "AtLeast"];
  for (const key of leadingTypes) {
    if (ParagraphLeadingType && ParagraphLeadingType[key]) {
      try {
        storyBuilder.applyParagraphDelta(StoryDelta.createLeadingType(ParagraphLeadingType[key]));
        break;
      } catch (error) {
        // Keep trying other candidates.
      }
    }
  }

  const paragraphDoubleKeys = [
    "Leading",
    "LeadingValue",
    "LineHeight",
    "LineSpacing",
  ];
  for (const key of paragraphDoubleKeys) {
    if (ParagraphAttDoubleType && ParagraphAttDoubleType[key]) {
      try {
        storyBuilder.applyParagraphDelta(
          StoryDelta.createParagraphDouble(ParagraphAttDoubleType[key], lineHeight),
        );
        return;
      } catch (error) {
        // Keep trying other candidates.
      }
    }
  }

  const glyphDoubleKeys = ["Leading", "LeadingOverride", "LineHeight"];
  for (const key of glyphDoubleKeys) {
    if (GlyphAttDoubleType && GlyphAttDoubleType[key]) {
      try {
        if (LeadingOverrideType && LeadingOverrideType.AtLeast) {
          storyBuilder.applyGlyphDelta(
            StoryDelta.createLeadingOverrideType(LeadingOverrideType.AtLeast),
          );
        }
        storyBuilder.applyGlyphDelta(
          StoryDelta.createGlyphDouble(GlyphAttDoubleType[key], lineHeight),
        );
        return;
      } catch (error) {
        // Affinity will use its default leading if this build lacks the key.
      }
    }
  }
}

function safeApplyParagraphString(storyBuilder, key, value) {
  if (!key) return;
  try {
    storyBuilder.applyParagraphDelta(StoryDelta.createParagraphString(key, value));
  } catch (error) {
    // Style names are metadata only when document style creation is unavailable.
  }
}

function safeApplyFont(storyBuilder, font) {
  if (!font || !font.isValid) return;

  try {
    if (font.postscriptName) {
      storyBuilder.applyGlyphDelta(StoryDelta.createPostscriptName(font.postscriptName));
      return;
    }
  } catch (error) {
    // Fall back to family name below.
  }

  try {
    if (font.familyName) {
      storyBuilder.applyGlyphDelta(StoryDelta.createFamilyName(font.familyName));
    }
  } catch (error) {
    // Keep the document default font if Affinity rejects the selected face.
  }
}

function formatPt(value) {
  return `${roundTo(value, 2)} pt`;
}

function roundTo(value, places) {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
}

function pad2(value) {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${abs < 10 ? "0" : ""}${abs}`;
}

function main() {
  const doc = Document.current;
  if (!doc) {
    showAlert("Open a document before running Type Scale Builder.");
    return;
  }

  let generatedInThisRun = false;

  while (true) {
    const settings = getUserSettings(doc);
    if (!settings) return;

    if (generatedInThisRun) {
      doc.undo();
      generatedInThisRun = false;
    }

    const scale = calculateTypeScale(settings);
    const styleResults = createParagraphStyles(doc, scale);
    createPreviewPage(doc, settings, scale, styleResults, false);
    generatedInThisRun = true;
  }
}

main();

module.exports.main = main;

function showAlert(message) {
  if (typeof app !== "undefined" && app.alert) {
    app.alert(message, "Type Scale Builder");
  } else {
    alert(message);
  }
}
