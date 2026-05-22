/**
 * name: Generate Crop Marks v2
 * description: Generates crop/cut marks for selected objects and Data Merge Layout grids. For DML nodes always asks the user for rows/columns via dialog. Adds L-shaped corner marks and internal grid ticks to a locked Production Marks layer.
 */

const { Document } = require("/document");
const Nodes = require("/nodes");
const Commands = require("/commands");
const { Curve, PolyCurve } = require("/geometry");
const { LineStyleDescriptor } = require("/linestyle");
const { FillDescriptor, SolidFill } = require("/fills");
const { Colour } = require("/colours");
const { UnitValueConverter, UnitType } = require("/units");
const { Dialog, DialogResult } = require("/dialog");

function getNodeSpreadBox(node) {
  if (node.getSpreadBaseBox) {
    const bb = node.getSpreadBaseBox();
    if (bb && bb.width > 0 && bb.height > 0) return bb;
  }
  if (node.spreadVisibleBox) {
    const sv = node.spreadVisibleBox;
    if (sv && sv.width > 0 && sv.height > 0) return sv;
  }
  if (node.children) {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity,
      found = false;
    for (const child of node.children) {
      const cb = getNodeSpreadBox(child);
      if (cb) {
        found = true;
        left = Math.min(left, cb.x);
        top = Math.min(top, cb.y);
        right = Math.max(right, cb.x + cb.width);
        bottom = Math.max(bottom, cb.y + cb.height);
      }
    }
    if (found)
      return { x: left, y: top, width: right - left, height: bottom - top };
  }
  return null;
}

function isDMLNode(node) {
  if (!node.descriptionInterface) return false;
  return (
    (node.descriptionInterface.defaultDescription || "") === "Data Merge Layout"
  );
}

// Always ask the user for DML grid dimensions — ratio-based inference is unreliable
// when objects don't fill the cell completely.
function getDMLInternalEdges(node) {
  const containerBB = node.getSpreadBaseBox ? node.getSpreadBaseBox() : null;
  if (!containerBB) return { xs: [], ys: [] };

  const dlg = Dialog.create("Data Merge Layout – mesh size");
  const col = dlg.addColumn();
  const grp = col.addGroup("Please enter the mesh size");
  const colsCtrl = grp.addUnitValueEditor(
    "Columns",
    UnitType.Unit,
    UnitType.Unit,
    2,
    1,
    20,
  );
  colsCtrl.precision = 0;
  const rowsCtrl = grp.addUnitValueEditor(
    "Rows",
    UnitType.Unit,
    UnitType.Unit,
    2,
    1,
    20,
  );
  rowsCtrl.precision = 0;

  const res = dlg.runModal();
  if (res.value !== DialogResult.Ok.value) return null;

  const cols = Math.round(colsCtrl.value);
  const rows = Math.round(rowsCtrl.value);

  const xs = [],
    ys = [];
  for (let c = 1; c < cols; c++)
    xs.push(containerBB.x + c * (containerBB.width / cols));
  for (let r = 1; r < rows; r++)
    ys.push(containerBB.y + r * (containerBB.height / rows));
  return { xs, ys };
}

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
  const OFFSET = 2 * mmToPx;
  const MARK_LEN = 5 * mmToPx;
  const LINE_WT = 0.25 * (dpi / 72);

  const nodeBoxes = [];
  const xEdgesSet = new Set(),
    yEdgesSet = new Set();

  for (const node of selectedNodes) {
    const bb = getNodeSpreadBox(node);
    if (!bb) {
      console.log("WARN: No bounding box for:", node[Symbol.toStringTag]);
      continue;
    }

    const { x, y, width, height } = bb;
    nodeBoxes.push({ left: x, top: y, right: x + width, bottom: y + height });
    xEdgesSet.add(Math.round(x));
    xEdgesSet.add(Math.round(x + width));
    yEdgesSet.add(Math.round(y));
    yEdgesSet.add(Math.round(y + height));

    if (isDMLNode(node)) {
      const edges = getDMLInternalEdges(node);
      if (edges === null) {
        console.log("INFO: Cancelled by user.");
        return;
      }
      for (const ix of edges.xs) xEdgesSet.add(Math.round(ix));
      for (const iy of edges.ys) yEdgesSet.add(Math.round(iy));
    }
  }

  if (nodeBoxes.length === 0) {
    console.log("ERROR: No valid bounding boxes.");
    return;
  }

  let outerLeft = Infinity,
    outerTop = Infinity,
    outerRight = -Infinity,
    outerBottom = -Infinity;
  for (const b of nodeBoxes) {
    outerLeft = Math.min(outerLeft, b.left);
    outerTop = Math.min(outerTop, b.top);
    outerRight = Math.max(outerRight, b.right);
    outerBottom = Math.max(outerBottom, b.bottom);
  }

  for (const x of [...xEdgesSet]) {
    if (Math.abs(x - outerLeft) <= 1 || Math.abs(x - outerRight) <= 1)
      xEdgesSet.delete(x);
  }
  for (const y of [...yEdgesSet]) {
    if (Math.abs(y - outerTop) <= 1 || Math.abs(y - outerBottom) <= 1)
      yEdgesSet.delete(y);
  }

  const internalXs = [...xEdgesSet],
    internalYs = [...yEdgesSet];

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
  addLine(L - OFFSET - MARK_LEN, T, L - OFFSET, T);
  addLine(L, T - OFFSET - MARK_LEN, L, T - OFFSET);
  addLine(R + OFFSET, T, R + OFFSET + MARK_LEN, T);
  addLine(R, T - OFFSET - MARK_LEN, R, T - OFFSET);
  addLine(L - OFFSET - MARK_LEN, B, L - OFFSET, B);
  addLine(L, B + OFFSET, L, B + OFFSET + MARK_LEN);
  addLine(R + OFFSET, B, R + OFFSET + MARK_LEN, B);
  addLine(R, B + OFFSET, R, B + OFFSET + MARK_LEN);

  for (const x of internalXs) {
    addLine(x, T - OFFSET - MARK_LEN, x, T - OFFSET);
    addLine(x, B + OFFSET, x, B + OFFSET + MARK_LEN);
  }
  for (const y of internalYs) {
    addLine(L - OFFSET - MARK_LEN, y, L - OFFSET, y);
    addLine(R + OFFSET, y, R + OFFSET + MARK_LEN, y);
  }

  doc.selection = marksLayer.selfSelection;
  doc.setEditable(false, null);

  console.log(
    "Crop marks complete! Lines:",
    8 + internalXs.length * 2 + internalYs.length * 2,
    "| Internal columns:",
    internalXs.length,
    "| Internal rows:",
    internalYs.length,
  );
}

generateGridMarks();
