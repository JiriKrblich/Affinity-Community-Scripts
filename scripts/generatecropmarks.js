const { Document } = require("/document");
const Nodes = require("/nodes");
const Commands = require("/commands");
const { Curve, PolyCurve } = require("/geometry");
const { LineStyleDescriptor } = require("/linestyle");
const { FillDescriptor, SolidFill } = require("/fills");
const { Colour } = require("/colours");
const { UnitValueConverter, UnitType } = require("/units");

function generateGridMarks() {
  const doc = Document.current;
  if (!doc) {
    console.log("ERROR: No document open");
    return;
  }
  const spread = doc.currentSpread;
  const dpi = doc.dpi;
  const sel = doc.selection;

  const selectedNodes = [];
  for (const item of sel.items) {
    if (item.node) selectedNodes.push(item.node);
  }
  if (selectedNodes.length === 0) {
    console.log("ERROR: Select one or more objects first.");
    return;
  }

  const converter = UnitValueConverter.create(dpi);
  const mmToPx = converter.getConversionFactor(
    UnitType.Millimetre,
    UnitType.Pixel,
  );
  const OFFSET = 2 * mmToPx; // 2mm gap from shape edge
  const MARK_LEN = 5 * mmToPx; // 5mm mark length
  const LINE_WT = 0.25 * (dpi / 72); // 0.25pt hairline

  let outerLeft = Infinity,
    outerTop = Infinity,
    outerRight = -Infinity,
    outerBottom = -Infinity;
  const nodeBoxes = [];
  for (const node of selectedNodes) {
    const bb = node.getSpreadBaseBox();
    if (!bb) continue;
    const { x, y, width, height } = bb;
    nodeBoxes.push({ left: x, top: y, right: x + width, bottom: y + height });
    outerLeft = Math.min(outerLeft, x);
    outerTop = Math.min(outerTop, y);
    outerRight = Math.max(outerRight, x + width);
    outerBottom = Math.max(outerBottom, y + height);
  }

  const xEdgesSet = new Set(),
    yEdgesSet = new Set();
  for (const b of nodeBoxes) {
    if (b.left > outerLeft + 1) xEdgesSet.add(Math.round(b.left));
    if (b.right < outerRight - 1) xEdgesSet.add(Math.round(b.right));
    if (b.top > outerTop + 1) yEdgesSet.add(Math.round(b.top));
    if (b.bottom < outerBottom - 1) yEdgesSet.add(Math.round(b.bottom));
  }
  const internalXs = [...xEdgesSet],
    internalYs = [...yEdgesSet];

  // Find or create Production Marks layer
  let marksLayer = null;
  for (const child of spread.children) {
    if (child.userDescription === "Production Marks") {
      marksLayer = child;
      break;
    }
  }
  if (!marksLayer) {
    const def = Nodes.ContainerNodeDefinition.createDefault();
    def.userDescription = "Production Marks";
    const lb = Commands.AddChildNodesCommandBuilder.create();
    lb.setInsertionTarget(spread);
    lb.addContainerNode(def);
    doc.executeCommand(lb.createCommand(false));
    for (const child of spread.children) {
      if (child.userDescription === "Production Marks") {
        marksLayer = child;
        break;
      }
    }
  }
  if (!marksLayer) {
    console.log("ERROR: Could not create Production Marks layer");
    return;
  }

  const black = Colour.createRGBA8(0, 0, 0, 255);
  const penFill = FillDescriptor.createSolid(SolidFill.create(black));
  const noFill = FillDescriptor.createNone();

  function addLine(x1, y1, x2, y2) {
    const lsd = LineStyleDescriptor.createDefault(LINE_WT);
    const curve = Curve.createLineXY(x1, y1, x2, y2);
    const pc = PolyCurve.create();
    pc.addCurve(curve);
    const def = Nodes.PolyCurveNodeDefinition.create(
      pc,
      noFill,
      lsd,
      penFill,
      noFill,
    );
    const b = Commands.AddChildNodesCommandBuilder.create();
    b.setInsertionTarget(marksLayer);
    b.addPolyCurveNode(def);
    doc.executeCommand(b.createCommand(false));
  }

  const L = outerLeft,
    T = outerTop,
    R = outerRight,
    B = outerBottom;

  // 4 × L-shaped corner marks (8 lines)
  addLine(L - OFFSET - MARK_LEN, T, L - OFFSET, T); // TL horizontal
  addLine(L, T - OFFSET - MARK_LEN, L, T - OFFSET); // TL vertical
  addLine(R + OFFSET, T, R + OFFSET + MARK_LEN, T); // TR horizontal
  addLine(R, T - OFFSET - MARK_LEN, R, T - OFFSET); // TR vertical
  addLine(L - OFFSET - MARK_LEN, B, L - OFFSET, B); // BL horizontal
  addLine(L, B + OFFSET, L, B + OFFSET + MARK_LEN); // BL vertical
  addLine(R + OFFSET, B, R + OFFSET + MARK_LEN, B); // BR horizontal
  addLine(R, B + OFFSET, R, B + OFFSET + MARK_LEN); // BR vertical

  // Internal column ticks (top + bottom per vertical edge)
  for (const x of internalXs) {
    addLine(x, T - OFFSET - MARK_LEN, x, T - OFFSET);
    addLine(x, B + OFFSET, x, B + OFFSET + MARK_LEN);
  }
  // Internal row ticks (left + right per horizontal edge)
  for (const y of internalYs) {
    addLine(L - OFFSET - MARK_LEN, y, L - OFFSET, y);
    addLine(R + OFFSET, y, R + OFFSET + MARK_LEN, y);
  }

  // Lock the Production Marks layer
  doc.selection = marksLayer.selfSelection;
  doc.setEditable(false, null);

  console.log(
    "Grid marks complete! Lines:",
    8 + internalXs.length * 2 + internalYs.length * 2,
    "| Internal columns:",
    internalXs.length,
    "| Internal rows:",
    internalYs.length,
  );
}

generateGridMarks();
