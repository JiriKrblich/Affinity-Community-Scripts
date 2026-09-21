
// Eindeutige Objektnamen
// Versieht doppelte Objektnamen mit einem fortlaufenden Index (Suffix),
// aufsteigend im Ebenenstapel von unten nach oben.

const { Document } = require('/document');

const doc = Document.current;
if (!doc) {
    console.log('Kein aktives Dokument gefunden.');
} else {
    // Alle Nodes rekursiv sammeln
    // doc.layers.all: children[0] = visuell oben, children[last] = visuell unten
    const allNodes = [];
    for (const node of doc.layers.all) {
        allNodes.push(node);
    }

    // Umkehren → von unten nach oben (Index 1 = unterste Ebene)
    const nodesBottomToTop = allNodes.reverse();

    // Anzeigename bestimmen (userDescription wenn gesetzt, sonst defaultDescription)
    function getDisplayName(node) {
        const ud = node.userDescription || '';
        return ud !== '' ? ud : (node.defaultDescription || '');
    }

    // Häufigkeit jedes Namens zählen
    const nameCount = new Map();
    for (const node of nodesBottomToTop) {
        const name = getDisplayName(node);
        nameCount.set(name, (nameCount.get(name) || 0) + 1);
    }

    // Nur Namen mit Duplikaten merken
    const duplicateNames = new Set();
    for (const [name, count] of nameCount) {
        if (count > 1) duplicateNames.add(name);
    }

    console.log('Doppelte Namen: ' + [...duplicateNames].join(', '));

    // Fortlaufenden Index vergeben (von unten nach oben)
    const nameIndex = new Map();
    let renamedCount = 0;

    for (const node of nodesBottomToTop) {
        const name = getDisplayName(node);
        if (!duplicateNames.has(name)) continue;

        const idx = (nameIndex.get(name) || 0) + 1;
        nameIndex.set(name, idx);

        const newName = name + '_' + idx;
        node.userDescription = newName;
        renamedCount++;
        console.log('"' + name + '" → "' + newName + '"');
    }

    console.log('Fertig: ' + renamedCount + ' Objekte umbenannt.');
}
