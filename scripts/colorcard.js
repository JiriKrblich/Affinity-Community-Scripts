const { app } = require('/application');
const { Document } = require('/document');
const { Colour, SVG11 } = require('/colours');
const { FillDescriptor, FillType } = require('/fills');
const { ShapeNodeDefinition, FrameTextNodeDefinition, ContainerNodeDefinition } = require('/nodes');
const { ShapeRectangle } = require('/shapes');
const { AddChildNodesCommandBuilder, CompoundCommandBuilder } = require('/commands');
const { StoryBuilder } = require('/storybuilder');
const { Font } = require('/fonts');

// --- utilidades -----------------------------------------------------------

function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    const l = (max + min) / 2;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function toHex(v) {
    return v.toString(16).padStart(2, '0').toUpperCase();
}

// Mapa "r,g,b" -> nombre, usando los ~140 colores con nombre estándar (SVG).
// Nota: la SDK de Affinity no permite leer el nombre de un color asignado
// desde el panel de Muestras/Swatches, así que solo se detecta un nombre
// cuando el color coincide exactamente con uno de estos colores estándar.
function buildNamedColourMap() {
    const map = {};
    const descriptors = Object.getOwnPropertyDescriptors(SVG11);
    for (const key of Object.keys(descriptors)) {
        const d = descriptors[key];
        if (typeof d.get !== 'function') continue;
        try {
            const rgba = SVG11[key].rgba8;
            map[rgba.r + ',' + rgba.g + ',' + rgba.b] = key;
        } catch (e) { /* ignorar */ }
    }
    return map;
}

// --- lógica principal -------------------------------------------------------

const doc = Document.current;

if (!doc) {
    app.alert("No hay ningún documento abierto en Affinity Designer.", "Tarjetas de color");
} else {
    const selectedNodes = doc.selection.nodes;

    if (!selectedNodes || selectedNodes.length === 0) {
        app.alert(
            "No hay ningún objeto seleccionado en la mesa de trabajo.\n" +
            "Selecciona uno o más objetos con relleno de color y vuelve a ejecutar el script.",
            "Tarjetas de color"
        );
    } else {
        // Solo se usan los objetos seleccionados con relleno sólido;
        // cualquier otro objeto del documento se ignora.
        const namedColours = buildNamedColourMap();
        const swatches = [];

        for (const node of selectedNodes) {
            let colour = null;
            try {
                const fd = node.brushFillDescriptor;
                if (fd && fd.fill && fd.fill.fillType && fd.fill.fillType.value === FillType.Solid.value) {
                    colour = fd.fill.colour;
                }
            } catch (e) { /* el nodo no tiene interfaz de relleno (p.ej. un grupo) */ }
            if (colour) swatches.push(colour);
        }

        if (swatches.length === 0) {
            app.alert(
                "Ninguno de los objetos seleccionados tiene un relleno sólido de color.",
                "Tarjetas de color"
            );
        } else {
            // --- medidas de la tarjeta, en puntos convertidos a píxeles de documento ---
            const ptToPx = doc.dpi / 72;
            const pad = 10 * ptToPx;
            const squareSize = 85 * ptToPx;
            const textAreaH = 62 * ptToPx;
            const cardW = squareSize + pad * 2;
            const cardH = pad * 2 + squareSize + 8 * ptToPx + textAreaH;
            const gap = 20 * ptToPx;
            const fontSizePx = 7.2 * ptToPx;

            const spread = doc.currentSpread;

            // --- 1er paso: crear un grupo (ContainerNode) vacío por cada tarjeta ---
            // Así, en el panel de capas, cada tarjeta ocupa una sola fila plegable
            // en vez de tres capas sueltas (fondo, muestra y texto).
            const groupsBuilder = AddChildNodesCommandBuilder.create();
            groupsBuilder.setInsertionTarget(spread);

            const groupNames = swatches.map((colour) => {
                const rgba = colour.rgba8;
                const hex = '#' + toHex(rgba.r) + toHex(rgba.g) + toHex(rgba.b);
                return "Tarjeta " + hex;
            });

            groupNames.forEach((name) => {
                groupsBuilder.addContainerNode(ContainerNodeDefinition.create(name));
            });

            const groupsCmd = groupsBuilder.createCommand();
            doc.executeCommand(groupsCmd);
            const groupNodes = groupsCmd.newNodes;

            // --- 2º paso: rellenar cada grupo con el fondo, la muestra y el texto ---
            const compound = CompoundCommandBuilder.create();

            swatches.forEach((colour, i) => {
                const x = i * (cardW + gap);
                const y = 0;

                const rgba = colour.rgba8;
                const cmykaf = colour.cmykaf;
                const hsl = rgbToHsl(rgba.r, rgba.g, rgba.b);
                const alphaPct = Math.round(colour.alpha * 100);
                const hex = '#' + toHex(rgba.r) + toHex(rgba.g) + toHex(rgba.b);
                const name = namedColours[rgba.r + ',' + rgba.g + ',' + rgba.b] || null;

                const builder = AddChildNodesCommandBuilder.create();
                builder.setInsertionTarget(groupNodes[i]);

                // Rectángulo contenedor de la tarjeta (fondo claro)
                const cardDef = ShapeNodeDefinition.create(
                    ShapeRectangle.create(),
                    { x: x, y: y, width: cardW, height: cardH },
                    FillDescriptor.createSolid(Colour.createRGBA8({ r: 246, g: 246, b: 246, alpha: 255 })),
                    null, null, null
                );
                cardDef.userDescription = "Fondo " + hex;
                builder.addShapeNode(cardDef);

                // Cuadro compacto con el color de relleno del objeto seleccionado
                const squareDef = ShapeNodeDefinition.create(
                    ShapeRectangle.create(),
                    { x: x + pad, y: y + pad, width: squareSize, height: squareSize },
                    FillDescriptor.createSolid(colour.clone()),
                    null, null, null
                );
                squareDef.userDescription = "Muestra " + hex;
                builder.addShapeNode(squareDef);

                // Texto con los datos del color
                const sb = StoryBuilder.create();
                sb.setToFrameTextDefaultStyle(doc.dpi, doc.format);

                const pa = sb.paragraphAtts;
                pa.spaceBefore = 0;
                pa.spaceAfter = fontSizePx * 0.35;
                sb.setParagraphAtts(pa);

                const ga = sb.glyphAtts;
                ga.height = fontSizePx;
                ga.font = Font.createDefault();
                ga.brushFill = FillDescriptor.createSolid(Colour.createRGBA8({ r: 50, g: 50, b: 50, alpha: 255 }));
                sb.setGlyphAtts(ga);

                if (name) {
                    sb.addText(name.charAt(0).toUpperCase() + name.slice(1));
                    sb.addParagraphBreak();
                }
                sb.addText("HEX  " + hex);
                sb.addParagraphBreak();
                sb.addText("RGB  " + rgba.r + ", " + rgba.g + ", " + rgba.b);
                sb.addParagraphBreak();
                sb.addText("HSL  " + hsl.h + ", " + hsl.s + ", " + hsl.l + ", \u03B1 " + alphaPct);
                sb.addParagraphBreak();
                sb.addText(
                    "CMYK " + Math.round(cmykaf.c * 100) + ", " +
                    Math.round(cmykaf.m * 100) + ", " +
                    Math.round(cmykaf.y * 100) + ", " +
                    Math.round(cmykaf.k * 100)
                );

                const textDef = FrameTextNodeDefinition.createFromStoryBuilder(
                    { x: x + pad, y: y + pad + squareSize + 8 * ptToPx, width: squareSize, height: textAreaH },
                    sb
                );
                textDef.userDescription = "Datos " + hex;
                builder.addNode(textDef);

                compound.addCommand(builder.createCommand());
            });

            doc.executeCommand(compound.createCommand());
        }
    }
}
