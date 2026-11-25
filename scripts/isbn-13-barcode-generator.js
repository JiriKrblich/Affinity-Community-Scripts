// ISBN-13 / EAN-13 barcode from vector stripes for Affinity.
// After starting, a dialog will appear: enter the ISBN (12 digits add the check digit,
// 13 digits verify it, and set the dimensions. The digits are between the stripes,
// the ISBN text above the code is stretched to the width of the graphic.
// The code is 100% K (CMYK), below it is a white rectangle (C0 M0 Y0 K0)
// with an overlap of 2 mm from the edges of the graphic. Everything is grouped
// and the group is named "ISBN ". If no document is open, a new A4 in CMYK is created.

// ISBN-13 / EAN-13 čiarový kód z vektorových pruhov pre Affinity.
// Po spustení sa zobrazí dialóg: zadaj ISBN (12 číslic dopočíta kontrolnú číslicu,
// 13 číslic ju overí) a nastav rozmery. Číslice sú medzi pruhmi, text ISBN nad kódom
// je roztiahnutý na šírku grafiky. Kód je 100 % K (CMYK), pod ním je biely obdĺžnik
// (C0 M0 Y0 K0) s presahom 2 mm od okrajov grafiky. Všetko sa zoskupí a skupina sa
// pomenuje "ISBN <číslo>". Ak nie je otvorený dokument, vytvorí sa nový A4 v CMYK.

const { Document, DocumentPreset } = require('/document.js');
const { Dialog, DialogResult } = require('/dialog.js');
const { UnitType } = require('/units.js');
const { Curve, PolyCurve, Rectangle } = require('/geometry.js');
const { PolyCurveNodeDefinition, ArtTextNodeDefinition } = require('/nodes.js');
const { AddChildNodesCommandBuilder, DocumentCommand, InsertionMode } = require('/commands.js');
const { Selection } = require('/selections.js');
const { FillDescriptor } = require('/fills.js');
const { CMYKAf } = require('/colours.js');
const { BlendMode } = require('affinity:common');
const { StoryBuilder } = require('/storybuilder.js');
const { StoryDelta } = require('/storydelta.js');
const { GlyphAttDoubleType } = require('/glyphatts.js');

const FONT = "Menlo"; // písmo pre čísla (monospace)
const PADDING_MM = 2; // presah bieleho obdĺžnika od okrajov grafiky
const DEFAULT_ISBN = "978-80-00000-00-0";

// ---- kódovanie EAN-13 ----
const L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
const PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

function checkDigit(d12) {
let s = 0;
for (let i = 0; i < 12; i++) s += (+d12[i]) * (i % 2 ? 3 : 1);
return String((10 - s % 10) % 10);
}

function encode(d13) {
let bits = "101";
for (let i = 0; i < 6; i++)
bits += (PARITY[+d13[0]][i] == "L" ? L : G)[+d13[1 + i]];
bits += "01010";
for (let i = 0; i < 6; i++)
bits += R[+d13[7 + i]];
return bits + "101";
}

// Vráti { text, digits } alebo { error }
function parseIsbn(raw) {
let digits = raw.replace(/\D/g, "");
let text = raw.trim();
if (digits.length == 12) {
const cd = checkDigit(digits);
digits += cd;
text += (/\D$/.test(text) ? "" : "-") + cd;
}
if (digits.length != 13)
return { error: "The ISBN must be 13 digits long (or 12 without the check digit)." };
if (checkDigit(digits.slice(0, 12)) != digits[12])
return { error: "Invalid check digit. The correct one is: " + checkDigit(digits.slice(0, 12)) };
return { digits, text };
}

function askOptions() {
for (;;) {
const dlg = Dialog.create("ISBN barcode");
const col = dlg.addColumn();
const g1 = col.addGroup("Content");
const isbn = g1.addTextBox("ISBN", DEFAULT_ISBN);
const g2 = col.addGroup("Appearance");
const modW = g2.addUnitValueEditor("Module width", UnitType.Millimetre, UnitType.Millimetre, 0.33, 0.1, 2).setPrecision(3);
const barH = g2.addUnitValueEditor("Code height", UnitType.Millimetre, UnitType.Millimetre, 22, 5, 200).setPrecision(1);
const fontPt = g2.addUnitValueEditor("Digit size (pt)", UnitType.Number, UnitType.Number, 9, 4, 72).setPrecision(1);
const g3 = col.addGroup("Position");
const posX = g3.addUnitValueEditor("X", UnitType.Millimetre, UnitType.Millimetre, 20, 0, 5000).setPrecision(1);
const posY = g3.addUnitValueEditor("Y", UnitType.Millimetre, UnitType.Millimetre, 20, 0, 5000).setPrecision(1);
dlg.initialWidth = 380;

    const res = dlg.runModal();
    if ((res?.value ?? res) != DialogResult.Ok.value)
        return null;
    const parsed = parseIsbn(isbn.text);
    if (parsed.error) {
        alert(parsed.error);
        continue;
    }
    return {
        digits: parsed.digits, text: parsed.text,
        modMM: modW.value, heightMM: barH.value, fontPt: fontPt.value,
        xMM: posX.value, yMM: posY.value
    };
}
}

function main() {
const o = askOptions();
if (!o)
return;

const bits = encode(o.digits);
const doc = Document.current ||
    Document.createFromPreset(
        DocumentPreset.all.filter(p => p.name.includes("A4") && String(p.rasterFormat).includes("CMYK"))[0], true);
if (!String(doc.format).includes("CMYK"))
    alert("Warning: the document is not in CMYK mode, 100% K color can be converted to RGB.");
const K100 = CMYKAf(0, 0, 0, 1);               // čierna: C0 M0 Y0 K100
const created = [];                            // všetky vytvorené objekty na zoskupenie

const mm = doc.dpi / 25.4;
const x0 = o.xMM * mm, y0 = o.yMM * mm;
const modW = o.modMM * mm, barH = o.heightMM * mm;
const ptMM = 25.4 / 72;
const charW = 0.602 * o.fontPt * ptMM * mm;      // šírka znaku písma Menlo
const capH = 0.75 * o.fontPt * ptMM * mm;        // výška číslic
const gap = capH + 0.6 * mm;                     // pás pre číslice medzi ochrannými pruhmi
const totalW = 95 * modW;                        // šírka celej grafiky pruhov

// všetky pruhy v jednom krivkovom objekte
const poly = PolyCurve.create();
const isGuard = i => i < 3 || (i >= 45 && i < 50) || i >= 92;
for (let i = 0; i < bits.length;) {
    if (bits[i] == "1") {
        let j = i;
        while (j < bits.length && bits[j] == "1") j++;
        const h = isGuard(i) ? barH : barH - gap;   // dátové pruhy skrátené, ochranné plné
        poly.addCurve(Curve.createRectangle(new Rectangle(x0 + i * modW, y0, (j - i) * modW, h)));
        i = j;
    } else i++;
}
const black = FillDescriptor.createSolid(K100, BlendMode.Normal);
const none = FillDescriptor.createNone();
const bars = PolyCurveNodeDefinition.create(poly, black, none, null, none);
bars.userDescription = "ISBN bars";
const add = AddChildNodesCommandBuilder.create();
add.addNode(bars);
const barsCmd = add.createCommand();
doc.executeCommand(barsCmd);
created.push(...barsCmd.newNodes);

const addText = (str, x, y, pt = o.fontPt) => {
    const sb = StoryBuilder.create();
    sb.setToFrameTextDefaultStyle(doc.dpi, doc.rasterFormat);
    sb.applyGlyphDelta(StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, pt * doc.dpi / 72));
    sb.applyGlyphDelta(StoryDelta.createFamilyName(FONT));
    sb.applyGlyphDelta(StoryDelta.createBrushFill(black));   // text 100 % K
    sb.addText(str);
    const c = AddChildNodesCommandBuilder.create();
    c.addNode(ArtTextNodeDefinition.createFromStoryBuilder({ x, y }, sb));
    const cmd = c.createCommand();
    doc.executeCommand(cmd);
    created.push(...cmd.newNodes);
};

// text "ISBN ..." hneď nad kódom, veľkosť písma upravená tak, aby text vyplnil šírku pruhov
const topText = "ISBN " + o.text;
const topPt = totalW / (topText.length * 0.602 * ptMM * mm);
addText(topText, x0, y0 - 0.8 * mm, topPt);

// číslice v pásme medzi ochrannými pruhmi
const yDigits = y0 + barH - 0.3 * mm;
const centred = (str, from, to) => x0 + (from + to) / 2 * modW - str.length * charW / 2;
addText(o.digits[0], x0 - charW - 1.2 * mm, yDigits);
addText(o.digits.slice(1, 7), centred(o.digits.slice(1, 7), 3, 45), yDigits);
addText(o.digits.slice(7), centred(o.digits.slice(7), 50, 92), yDigits);

// zoskupenie všetkých častí a pomenovanie skupiny podľa kódu
const groupCmd = DocumentCommand.createGroupNodes(Selection.create(doc, created));
doc.executeCommand(groupCmd);
const group = groupCmd.newNodes[0];
group.userDescription = "ISBN " + o.text;

// biely obdĺžnik pod kódom (vnútri skupiny, úplne vzadu) s presahom od okrajov grafiky
const box = group.getSpreadVisibleBox();
const pad = PADDING_MM * mm;
const rectPoly = PolyCurve.create();
rectPoly.addCurve(Curve.createRectangle(
    new Rectangle(box.x - pad, box.y - pad, box.width + 2 * pad, box.height + 2 * pad)));
const white = FillDescriptor.createSolid(CMYKAf(0, 0, 0, 0), BlendMode.Normal);   // C0 M0 Y0 K0
const bg = PolyCurveNodeDefinition.create(rectPoly, white, none, null, none);
bg.userDescription = "ISBN background";
const bgAdd = AddChildNodesCommandBuilder.create();
bgAdd.setInsertionTarget(group);
bgAdd.setInsertionMode(InsertionMode.Inside_AtFront);   // v tomto SDK to vloží obdĺžnik úplne dozadu (overené)
bgAdd.addNode(bg);
doc.executeCommand(bgAdd.createCommand(false));
}

main();
