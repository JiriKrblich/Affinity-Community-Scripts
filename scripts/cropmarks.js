const { Document } = require("/document");
const {
  DocumentCommand,
  AddChildNodesCommandBuilder,
  InsertionMode,
} = require("/commands");
const { PolyCurveNodeDefinition, ContainerNodeDefinition } = require("/nodes");
const { CMYKf } = require("/colours");
const { FillDescriptor } = require("/fills");
const { LineStyleDescriptor } = require("/linestyle");
const { PolyCurve, Curve } = require("/geometry");

const doc = Document.current;
if (!doc) {
  console.log("Kein Dokument offen");
  return;
}

const spread = doc.currentSpread;
const root = doc.rootNode;

// Alte Cropmarks-Gruppe löschen
const toDelete = [];
function findMarks(node) {
  for (const child of node.children) {
    if (
      child.userDescription === "Cropmarks" ||
      child.userDescription === "Schneidmarke"
    )
      toDelete.push(child);
    else findMarks(child);
  }
}
findMarks(root);
for (const n of toDelete) doc.deleteSelection(n);

// Zielobjekt: ausgewähltes Objekt oder erster Layer
const selNodes = [...doc.selection.nodes];
const targetNode = selNodes.length > 0 ? selNodes[0] : spread.layers.first;
if (!targetNode) {
  console.log("Kein Objekt gefunden!");
  return;
}
const box = targetNode.getSpreadBaseBox(false);

const mmToPx = doc.dpi / 25.4;
const lineLen = 5 * mmToPx; // 5mm Linienlänge
const gap = 2 * mmToPx; // 2mm Abstand zur Trimbox

const L = box.x,
  T = box.y;
const R = box.x + box.width,
  B = box.y + box.height;

// Passerfarbe: CMYK 100/100/100/100 (CMYKf erwartet 0.0–1.0)
const passerColour = CMYKf(1.0, 1.0, 1.0, 1.0);
const stroke = FillDescriptor.createSolid(passerColour);
const none = FillDescriptor.createNone();
const lsd = LineStyleDescriptor.createDefault();

function makeLine(x1, y1, x2, y2) {
  const pc = PolyCurve.create();
  pc.addCurve(Curve.createLineXY(x1, y1, x2, y2));
  return pc;
}

// 8 Schneidmarken: Verlängerung der Trimbox-Kanten, gap Abstand nach außen
const lineDefs = [
  makeLine(L - gap - lineLen, T, L - gap, T),
  makeLine(L, T - gap - lineLen, L, T - gap),
  makeLine(R + gap, T, R + gap + lineLen, T),
  makeLine(R, T - gap - lineLen, R, T - gap),
  makeLine(L - gap - lineLen, B, L - gap, B),
  makeLine(L, B + gap, L, B + gap + lineLen),
  makeLine(R + gap, B, R + gap + lineLen, B),
  makeLine(R, B + gap, R, B + gap + lineLen),
];

// Schritt 1: Gruppe "Cropmarks" auf Spread-Ebene anlegen
// createCommand(false) ist wichtig um cmd.newNodes[0] zu erhalten!
const groupDef = ContainerNodeDefinition.create("Cropmarks");
const groupBuilder = AddChildNodesCommandBuilder.create();
groupBuilder.setInsertionTarget(spread);
groupBuilder.setInsertionMode(InsertionMode.InsertAtEnd);
groupBuilder.addContainerNode(groupDef);
const groupCmd = groupBuilder.createCommand(false);
doc.executeCommand(groupCmd);
const groupNode = groupCmd.newNodes[0];

// Schritt 2: Schneidmarken in die Gruppe einfügen (separater Builder!)
const linesBuilder = AddChildNodesCommandBuilder.create();
linesBuilder.setInsertionTarget(groupNode);
linesBuilder.setInsertionMode(InsertionMode.InsertAtEnd);
for (const curve of lineDefs) {
  linesBuilder.addPolyCurveNode(
    PolyCurveNodeDefinition.create(curve, none, lsd, stroke, none),
  );
}
const linesCmd = linesBuilder.createCommand(true);
doc.executeCommand(linesCmd);

// Styles setzen
for (const n of linesCmd.newNodes) {
  n.userDescription = "Schneidmarke";
  const sel = n.selfSelection;
  doc.executeCommand(DocumentCommand.createSetPenFill(sel, stroke));
  doc.executeCommand(DocumentCommand.createSetBrushFill(sel, none));
  n.lineWeightPts = 0.25;
}

console.log(
  'Fertig! Gruppe "Cropmarks" mit 8 Schneidmarken in Passerfarbe erstellt.',
);
