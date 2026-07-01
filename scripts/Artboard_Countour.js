function main() {
    const { app } = require('/application');
    const { ShapeNodeDefinition, NodeChildType } = require('/nodes');
    const { AddChildNodesCommandBuilder, DocumentCommand } = require('/commands');
    const { Shape, ShapeType } = require('/shapes');
    const { Rectangle, Transform } = require('/geometry');
    const { CMYKA8 } = require('/colours');
    const { FillDescriptor } = require('/fills');
    const { Selection } = require('/selections');

    const doc = app.documents.current;
    if (!doc) { console.log("Erro: Abra um documento primeiro"); return; }

    const dpi = doc.dpi;
    const spread = doc.spreads.first;
    const magenta = CMYKA8(0, 255, 0, 0);
    const lw = 2 * dpi / 72;
    const count = spread.artboardCount;

    console.log("Processando " + count + " artboards...");

    for (let i = 0; i < count; i++) {
        const ab = spread.artboards[i];
        const abNode = ab.node;
        const sb = ab.spreadBaseBox;
        const nome = (sb.width / dpi * 25.4).toFixed(1) + 'x' + (sb.height / dpi * 25.4).toFixed(1) + 'mm';

        doc.executeCommand(DocumentCommand.createSetDescription(abNode.selfSelection, nome));

        const shapeDef = ShapeNodeDefinition.create(
            Shape.create(ShapeType.Rectangle),
            new Rectangle(0, 0, sb.width, sb.height),
            FillDescriptor.createNone(),
            null,
            null
        );

        shapeDef.transform = Transform.createTranslate(sb.x, sb.y);

        const builder = AddChildNodesCommandBuilder.create();
        builder.addNode(shapeDef);
        builder.setInsertionTarget(abNode);
        const cmd = builder.createCommand(true, NodeChildType.Main);
        doc.executeCommand(cmd);

        const rectNode = cmd.newNodes[0];
        const sel = Selection.create(doc, rectNode);

        doc.setPenFillDescriptor(magenta, sel);
        doc.setLineWeight(lw, sel);

        const rectShape = Shape.create(ShapeType.Rectangle);
        rectShape.topLeft.setRadius(0, sb.width, sb.height);
        rectShape.topRight.setRadius(0, sb.width, sb.height);
        rectShape.bottomLeft.setRadius(0, sb.width, sb.height);
        rectShape.bottomRight.setRadius(0, sb.width, sb.height);
        rectNode.shapeInterface.setShape(rectShape);
    }

    console.log("Concluido: " + count + " artboards com contorno magenta 2pt, cantos retos.");
}

main();