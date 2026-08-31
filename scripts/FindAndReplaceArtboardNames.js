
const { Document } = require('/document');
const { Dialog, DialogResult } = require('/dialog');

const doc = Document.current;

if (!doc) {
    console.log("No document is currently open.");
}
else {
    try {
        const dlg = Dialog.create("Find & Replace Artboard Names");
        const col = dlg.addColumn();
        const grp = col.addGroup("Find & Replace");
        grp.addStaticText("", "Replaces text in every artboard name in the document.");
        const findBox = grp.addTextBox("Find:", "");
        const replaceBox = grp.addTextBox("Replace with:", "");

        const dlgResult = dlg.runModal();

        if (dlgResult === DialogResult.Ok) {
            const findText = findBox.text;
            const replaceText = replaceBox.text;

            if (!findText) {
                console.log("No search text was entered - nothing was replaced ;3");
            }
            else {
                let replacedCount = 0;
                for (const spread of doc.spreads) {
                    for (const artboardInterface of spread.artboards) {
                        const node = artboardInterface.node;
                        const currentName = node.userDescription;
                        if (currentName && currentName.includes(findText)) {
                            const newName = currentName.split(findText).join(replaceText);
                            node.userDescription = newName;
                            replacedCount++;
                        }
                    }
                }
                console.log(`Replaced text in ${replacedCount} artboard name(s).`);
            }
        }
        else {
            console.log("Dialog was cancelled - no changes made.");
        }
    }
    catch (e) {
        console.log("ERROR: " + e.message + "\n" + e.stack);
    }
}
