/**
 * name: swiss_calendar_creator
 * description: Calendar generator for Affinity Designer/Publisher/Photo in the International Typographic Style -- Year / Month / Week / Day views, English or Spanish, strict grid, hairline rules, one accent ink. Draws into the selected artboard, or a rectangle/frame inside one, and can fill a whole set of artboards with consecutive periods in one pass. Type sizes are automatic by default, or can be set per element in points.
 * version: 1.3.0
 * author: Victor Crespo (3dvic.com · github.com/vicc3d)
 * license: MIT
 */
'use strict';

// ============================================================================
//  Swiss Calendar Creator  --  Affinity (Designer / Publisher) 2.5+
//  Victor Crespo -- 3dvic.com -- github.com/vicc3d/swiss-calendar-creator
//  MIT License
// ----------------------------------------------------------------------------
//  Select an ARTBOARD (the calendar fills its surface) or a rectangle / frame
//  inside one (the calendar fills that shape), then run the script. First pick
//  the language (interface + calendar content), then the view (Year / Month /
//  Week / Day) and the settings. With several artboards, each one can carry
//  its own calendar.
//
//  International Typographic Style: strict grid, flush-left sans-serif,
//  hairline rules, generous whitespace, a single accent ink.
//
//  The dialog uses collapsible sections (a header with a ▶/▼ arrow, or a
//  switch if you change SECTION_HEADER). Everything is created inside one
//  container layer.
// ============================================================================

const { Document } = require('/document');
const { Dialog, DialogResult, HorizontalAlignment } = require('/dialog');
const { UnitType } = require('/units');
const { AddChildNodesCommandBuilder } = require('/commands');
const { ContainerNodeDefinition, ShapeNodeDefinition, FrameTextNodeDefinition } = require('/nodes');
const { Selection } = require('/selections');
const { ShapeRectangle } = require('/shapes');
const { Rectangle } = require('/geometry');
const { StoryBuilder } = require('/storybuilder');
const { Font, FontFamily } = require('/fonts');
const { FillDescriptor } = require('/fills');
const { RGB8 } = require('/colours');
const { ParagraphAlignXType } = require('/paragraphatts');

// Header style for the collapsible sections:
//   'arrow'  -> button with a ▶ / ▼ triangle (accordion style)
//   'switch' -> on/off toggle
const SECTION_HEADER = 'arrow';

// ----------------------------------------------------------------------------
//  Languages  --  calendar content + interface strings
// ----------------------------------------------------------------------------
const STR = {
    es: {
        // --- calendar content ---
        months: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio',
                 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
        daysLong:  ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'],
        daysShort: ['LUN', 'MAR', 'MIÉ', 'JUE', 'VIE', 'SÁB', 'DOM'],
        daysMini:  ['L', 'M', 'M', 'J', 'V', 'S', 'D'],
        week: 'SEMANA',
        weekAbbr: 'SEM',
        // --- interface ---
        ui: {
            title: 'Swiss Calendar Creator',
            secType: 'Tipo de calendario',
            view: 'Vista',
            views: ['Año', 'Mes', 'Semana', 'Día'],
            yearGrid: 'Columnas × filas (Año)',
            yearGridOpts: ['Automática', '4 × 3', '3 × 4', '6 × 2', '2 × 6', '12 × 1', '1 × 12'],
            secDate: 'Fecha',
            year: 'Año',
            month: 'Mes',
            day: 'Día (semana / día)',
            weekStart: 'La semana empieza en',
            weekStartOpts: ['Lunes', 'Domingo'],
            weekNumMode: 'Numeración de semanas',
            weekNumModeOpts: ['ISO 8601', 'Desde 1'],
            secSequence: 'Secuencia',
            seqOn: 'Un período por artboard',
            seqCount: 'Cuántos',
            seqOrder: 'Orden de artboards',
            seqOrderOpts: ['Por nombre', 'Filas', 'Columnas'],
            secElements: 'Elementos',
            showTitle: 'Título (mes / año)',
            header: 'Encabezado de días',
            grid: 'Filetes de retícula (Mes)',
            verticals: 'Líneas verticales',
            adjacent: 'Días de meses contiguos (Mes)',
            weekNumbers: 'Números de semana (Mes)',
            boldWeekend: 'Fines de semana en negrita',
            markToday: 'Marcar el día de hoy',
            accentBar: 'Barra de acento en el título',
            secAgenda: 'Agenda (vista Día)',
            agendaShow: 'Mostrar franjas horarias',
            agendaFrom: 'Desde (h)',
            agendaTo: 'Hasta (h)',
            timeFormat: 'Formato de hora',
            timeFormatOpts: ['12 h', '24 h'],
            secStyle: 'Estilo',
            font: 'Tipografía',
            sizeDay: 'Cuerpo días',
            sizeHead: 'Cuerpo encabezado',
            sizeWeek: 'Cuerpo nº de semana',
            sizeHour: 'Cuerpo horas',
            ink: 'Tinta principal',
            accent: 'Acento',
            ruleColour: 'Filetes',
            muted: 'Días atenuados',
            noDoc: 'Abre un documento primero.',
            noSel: 'Selecciona un artboard (el calendario llenará su superficie) o un rectángulo/marco dentro de él que defina el área.',
            reSel: 'La selección forma parte de un calendario ya creado.\n\nHaz clic en el artboard —o en un rectángulo/marco dentro de él— donde quieras el nuevo calendario, y vuelve a ejecutar el script.',
            errPrefix: 'Error en Swiss Calendar Creator:\n',
            calName: 'Calendario',
            targetPrefix: 'Se dibujará en:  ',
            targetDoc: 'el documento (sin artboards)',
            targetShapeIn: 'la forma seleccionada en ',
            seqNoArtboards: 'La secuencia necesita artboards y este documento no tiene ninguno.',
            seqNone: 'No queda ningún artboard libre a partir del seleccionado.\n\nTodos los siguientes ya contienen un calendario.',
            seqReport: 'Secuencia terminada: {n} calendario(s) creados.',
            seqSkipped: '\n\nSe saltaron {s} artboard(s) que ya tenían un calendario.',
            tips: {
                view: 'Año = 12 mini-meses · Mes = cuadrícula del mes · Semana = 7 columnas · Día = una jornada.',
                yearGrid: 'Cómo se reparten los 12 meses de la vista Año: columnas × filas. Solo se ofrecen retículas exactas, para que no queden celdas vacías.  ·  Automática: elige la que deja cada mini-mes más cerca de un cuadrado según la proporción del área — 3 × 4 en una página vertical, 4 × 3 en una apaisada.  ·  12 × 1 y 1 × 12 sirven para tiras largas (un faldón, una banda lateral). Los cuerpos se ajustan solos al tamaño de cada celda, salvo que los fijes en Estilo.',
                secDate: 'Qué fecha representa el calendario.',
                year: 'Año del calendario.',
                month: 'Mes a dibujar. También fija el mes de referencia para las vistas Semana y Día.',
                day: 'Día del mes. En la vista Semana indica qué semana mostrar; en la vista Día, qué día.',
                weekStart: 'Primera columna de la semana: lunes (Europa/ISO) o domingo (EE. UU.).',
                weekNumMode: 'Cómo se numera la columna SEM.  ·  ISO 8601 (norma internacional): semanas de lunes a domingo; la semana 1 es la que contiene el primer jueves del año, así que la fila parcial de principios de enero suele ser la semana 52 o 53 del año anterior. Ejemplo: en 2027 la primera fila es la semana 53 de 2026 y el lunes 4 de enero empieza la semana 1. Es lo que usan la mayoría de calendarios europeos y el software de oficina.  ·  Desde 1 (agendas y calendarios comerciales): la semana 1 es simplemente la que contiene el 1 de enero, y a partir de ahí se cuenta 1, 2, 3… hasta fin de año; nunca aparece un 52/53 al principio. Los días de diciembre que comparten fila con enero también cuentan como semana 1.',
                secSequence: 'Rellena varios artboards de una pasada, uno por período.',
                seqOn: 'En vez de un solo calendario, dibuja uno por artboard avanzando el período en cada uno: Año → años consecutivos, Mes → meses consecutivos, Semana → semanas, Día → días. Empieza en el artboard de la selección y sigue el orden elegido. El área en cada artboard es la misma posición y tamaño relativos que en el de partida (o el artboard entero, si lo que seleccionaste fue el artboard). Los artboards que ya contienen un calendario se saltan, así puedes lanzar el script otra vez sin duplicar nada.',
                seqCount: 'Cuántos períodos generar. Por ejemplo 12 para un calendario de pared de un año.',
                seqOrder: 'Cómo se ordenan los artboards.  ·  Por nombre: orden natural del nombre de capa (Artboard1, Artboard2, … Artboard10, Artboard11), que suele coincidir con el orden en que los creaste.  ·  Filas: de arriba abajo y de izquierda a derecha, como se leen en el lienzo.  ·  Columnas: de izquierda a derecha, bajando cada columna entera antes de pasar a la siguiente.  ·  Nota: el orden interno del documento NO se usa, porque suele estar desordenado respecto a nombres y posiciones.',
                secElements: 'Qué se dibuja y qué se resalta.',
                showTitle: 'Dibuja el título de la vista (p. ej. "ENERO 2027" en la vista Mes, el año en la Anual, el rango en la Semana, el día de la semana en el Día). Si lo desactivas, el título y su barra de acento desaparecen y el resto del calendario ocupa ese espacio — útil cuando quieres rotularlo a mano en Affinity.',
                header: 'Fila con las abreviaturas de los días (LUN, MAR…) sobre la cuadrícula.',
                grid: 'Líneas horizontales finas que separan las semanas (solo vista Mes).',
                verticals: 'Añade también líneas verticales entre las columnas de días.',
                adjacent: 'Rellena los huecos del principio y el final con los días del mes anterior y siguiente, atenuados.',
                weekNumbers: 'Columna "SEM" a la izquierda con el número de semana de cada fila (según "Numeración de semanas").',
                boldWeekend: 'Pone en negrita los números de sábado y domingo (además del color de acento).',
                markToday: 'Resalta la fecha de hoy: color de acento, negrita y una barra debajo.',
                accentBar: 'Línea corta y gruesa en color de acento bajo el título (detalle de diseño suizo).',
                secAgenda: 'Franjas de horas para la vista Día.',
                agendaShow: 'En la vista Día, añade franjas horarias con filetes y etiquetas de hora. En un área apaisada, la fecha va a la izquierda y las horas ocupan la columna derecha.',
                agendaFrom: 'Hora de inicio de la agenda (0–23).',
                agendaTo: 'Hora de fin de la agenda (1–24).',
                timeFormat: 'Cómo se rotulan las horas de la agenda: 12 h (8 AM, 1 PM…) o 24 h (08:00, 13:00…).',
                secStyle: 'Tipografía, cuerpos y paleta del calendario. Por defecto, estética suiza: negro y una única tinta de acento.',
                font: 'Familia tipográfica del calendario. Se eligen solos los pesos Regular, Medium y Bold. Por defecto una de palo seco (Helvetica/Inter/Arial…).',
                sizeDay: 'Cuerpo de los números de día, en puntos.  ·  Deja 0 para que se calcule solo a partir del tamaño del área — así el calendario se adapta a cualquier artboard, que es lo que permite que la secuencia funcione con formatos distintos.  ·  Aplica a la vista que estés generando: en Mes son los números de la cuadrícula, en Anual los de los mini-meses y en Semana los números grandes.',
                sizeHead: 'Cuerpo de las abreviaturas de los días (LUN, MAR…), en puntos. 0 = automático.  ·  En la vista Mes también fija el alto de la fila de encabezado y el rótulo "SEM", para que toda la fila superior quede alineada.',
                sizeWeek: 'Cuerpo de los números de la columna de semanas, en puntos. 0 = automático.  ·  Solo afecta a la vista Mes. El rótulo "SEM" de la cabecera usa el cuerpo del encabezado de días, no este, para que la fila superior quede uniforme.',
                sizeHour: 'Cuerpo de las etiquetas de hora de la agenda (08:00, 8 AM…), en puntos. 0 = automático.  ·  Solo afecta a la vista Día.',
                ink: 'Color principal del texto y de los filetes fuertes.',
                accent: 'Tinta única de acento: fines de semana, hoy, barra del título y cabecera de números de semana.',
                ruleColour: 'Color de los filetes finos de la cuadrícula.',
                muted: 'Color de los días atenuados (meses contiguos, números de semana).'
            }
        }
    },
    en: {
        months: ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                 'August', 'September', 'October', 'November', 'December'],
        daysLong:  ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
        daysShort: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
        daysMini:  ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
        week: 'WEEK',
        weekAbbr: 'WK',
        ui: {
            title: 'Swiss Calendar Creator',
            secType: 'Calendar type',
            view: 'View',
            views: ['Year', 'Month', 'Week', 'Day'],
            yearGrid: 'Columns × rows (Year)',
            yearGridOpts: ['Automatic', '4 × 3', '3 × 4', '6 × 2', '2 × 6', '12 × 1', '1 × 12'],
            secDate: 'Date',
            year: 'Year',
            month: 'Month',
            day: 'Day (week / day)',
            weekStart: 'Week starts on',
            weekStartOpts: ['Monday', 'Sunday'],
            weekNumMode: 'Week numbering',
            weekNumModeOpts: ['ISO 8601', 'From 1'],
            secSequence: 'Sequence',
            seqOn: 'One period per artboard',
            seqCount: 'How many',
            seqOrder: 'Artboard order',
            seqOrderOpts: ['By name', 'Rows', 'Columns'],
            secElements: 'Elements',
            showTitle: 'Title (month / year)',
            header: 'Weekday header',
            grid: 'Grid rules (Month)',
            verticals: 'Vertical lines',
            adjacent: 'Adjacent-month days (Month)',
            weekNumbers: 'Week numbers (Month)',
            boldWeekend: 'Bold weekends',
            markToday: 'Mark today',
            accentBar: 'Accent bar under title',
            secAgenda: 'Agenda (Day view)',
            agendaShow: 'Show hour slots',
            agendaFrom: 'From (h)',
            agendaTo: 'To (h)',
            timeFormat: 'Time format',
            timeFormatOpts: ['12 h', '24 h'],
            secStyle: 'Style',
            font: 'Typeface',
            sizeDay: 'Day size',
            sizeHead: 'Header size',
            sizeWeek: 'Week no. size',
            sizeHour: 'Hour size',
            ink: 'Primary ink',
            accent: 'Accent',
            ruleColour: 'Rules',
            muted: 'Dimmed days',
            noDoc: 'Open a document first.',
            noSel: 'Select an artboard (the calendar fills it) or a rectangle/frame inside it that defines the area.',
            reSel: 'The selection is part of a calendar you already created.\n\nClick the artboard — or a rectangle/frame inside it — where you want the new calendar, then run the script again.',
            errPrefix: 'Swiss Calendar Creator error:\n',
            calName: 'Calendar',
            targetPrefix: 'Will be drawn on:  ',
            targetDoc: 'the document (no artboards)',
            targetShapeIn: 'the selected shape in ',
            seqNoArtboards: 'The sequence needs artboards, and this document has none.',
            seqNone: 'No free artboard left from the selected one.\n\nEvery artboard after it already contains a calendar.',
            seqReport: 'Sequence finished: {n} calendar(s) created.',
            seqSkipped: '\n\n{s} artboard(s) were skipped because they already had a calendar.',
            tips: {
                view: 'Year = 12 mini-months · Month = month grid · Week = 7 columns · Day = a single day.',
                yearGrid: 'How the Year view lays out its 12 months: columns × rows. Only exact grids are offered, so no cell is left empty.  ·  Automatic: picks the one that keeps each mini-month closest to square for the area\'s proportions — 3 × 4 on a portrait page, 4 × 3 on a landscape one.  ·  12 × 1 and 1 × 12 suit long strips (a footer, a side band). Type sizes follow each cell\'s size, unless you set them in Style.',
                secDate: 'Which date the calendar represents.',
                year: 'Calendar year.',
                month: 'Month to draw. Also sets the reference month for the Week and Day views.',
                day: 'Day of the month. In the Week view it picks which week to show; in the Day view, which day.',
                weekStart: 'First column of the week: Monday (Europe/ISO) or Sunday (US).',
                weekNumMode: 'How the WK column is numbered.  ·  ISO 8601 (international standard): Monday-to-Sunday weeks; week 1 is the one containing the year\'s first Thursday, so the partial row at the start of January is usually week 52 or 53 of the previous year. Example: for 2027 the first row is week 53 of 2026, and week 1 begins on Monday 4 January. This is what most European calendars and office software use.  ·  From 1 (commercial planners and calendars): week 1 is simply the one containing January 1, then it counts 1, 2, 3… to year end; you never get a 52/53 at the start. December days sharing a row with January are also counted as week 1.',
                secSequence: 'Fill several artboards in one pass, one period each.',
                seqOn: 'Instead of a single calendar, draw one per artboard, advancing the period each time: Year → consecutive years, Month → consecutive months, Week → weeks, Day → days. It starts at the artboard of your selection and follows the chosen order. The area on each artboard is the same relative position and size as on the starting one (or the whole artboard, if that is what you selected). Artboards that already contain a calendar are skipped, so you can run the script again without duplicating anything.',
                seqCount: 'How many periods to generate. For example 12 for a one-year wall calendar.',
                seqOrder: 'How the artboards are ordered.  ·  By name: natural order of the layer name (Artboard1, Artboard2, … Artboard10, Artboard11), which usually matches the order you created them in.  ·  Rows: top to bottom, left to right, the way you read them on the canvas.  ·  Columns: left to right, going all the way down each column before moving to the next.  ·  Note: the document\'s internal order is NOT used, because it is usually scrambled relative to both names and positions.',
                secElements: 'What gets drawn and what gets emphasised.',
                showTitle: 'Draws the view\'s title (e.g. "JANUARY 2027" in the Month view, the year in the Year view, the range in the Week view, the weekday name in the Day view). Turn it off and the title and its accent bar disappear, with the rest of the calendar taking that space — handy when you want to set the heading by hand in Affinity.',
                header: 'Row of weekday abbreviations (MON, TUE…) above the grid.',
                grid: 'Thin horizontal rules separating the weeks (Month view only).',
                verticals: 'Also add vertical rules between the day columns.',
                adjacent: 'Fill the leading and trailing gaps with the previous/next month days, dimmed.',
                weekNumbers: '"WK" column on the left with the week number of each row (per "Week numbering").',
                boldWeekend: 'Set Saturday and Sunday numbers in bold (on top of the accent colour).',
                markToday: "Highlight today's date: accent colour, bold and a bar underneath.",
                accentBar: 'Short thick accent-coloured rule under the title (Swiss design detail).',
                secAgenda: 'Hour slots for the Day view.',
                agendaShow: 'In the Day view, add hour slots with rules and time labels. On a landscape area the date sits on the left and the hours fill the right column.',
                agendaFrom: 'Agenda start hour (0–23).',
                agendaTo: 'Agenda end hour (1–24).',
                timeFormat: 'How agenda hours are labelled: 12 h (8 AM, 1 PM…) or 24 h (08:00, 13:00…).',
                secStyle: 'Calendar typeface, sizes and palette. Default look: black plus a single accent ink.',
                font: 'Calendar typeface. Regular, Medium and Bold weights are chosen automatically. Defaults to a sans-serif (Helvetica/Inter/Arial…).',
                sizeDay: 'Size of the day numbers, in points.  ·  Leave it at 0 to have it derived from the area size — that is what lets the calendar adapt to any artboard, and what makes the sequence work across different formats.  ·  It applies to whichever view you are generating: the grid numbers in Month, the mini-month numbers in Year, the big numbers in Week.',
                sizeHead: 'Size of the weekday abbreviations (MON, TUE…), in points. 0 = automatic.  ·  In the Month view it also sets the height of the header row and the "WK" label, so the whole top row stays aligned.',
                sizeWeek: 'Size of the numbers in the week column, in points. 0 = automatic.  ·  Month view only. The "WK" header uses the weekday-header size, not this one, so the top row stays uniform.',
                sizeHour: 'Size of the agenda hour labels (08:00, 8 AM…), in points. 0 = automatic.  ·  Day view only.',
                ink: 'Main colour for text and the strong rules.',
                accent: 'Single accent ink: weekends, today, title bar and the week-number header.',
                ruleColour: 'Colour of the thin grid rules.',
                muted: 'Colour of the dimmed days (adjacent months, week numbers).'
            }
        }
    }
};

// ----------------------------------------------------------------------------
//  Date utilities
// ----------------------------------------------------------------------------
function daysInMonth(year, month /*0-11*/) {
    return new Date(year, month + 1, 0).getDate();
}

function columnOf(jsDay, weekStartsMonday) {
    return weekStartsMonday ? (jsDay + 6) % 7 : jsDay;
}

// ISO-8601 week number
function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return 1 + Math.round((d - firstThursday) / 604800000);
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth() === b.getMonth() &&
           a.getDate() === b.getDate();
}

// ----------------------------------------------------------------------------
//  Typography  --  resolves a sans-serif family and its weights
// ----------------------------------------------------------------------------
function pickFace(family, wantBold, wantMedium) {
    const faces = family.fonts.filter(f => !f.isItalic);
    const upright = faces.filter(f => !f.isCondensed && !f.isExpanded);
    const pool = upright.length ? upright : faces;
    const byDist = (target) => pool.slice().sort((a, b) =>
        Math.abs(a.weight - target) - Math.abs(b.weight - target))[0];
    if (wantBold)   return byDist(700) || pool[0];
    if (wantMedium) return byDist(500) || pool[0];
    return byDist(400) || pool[0];
}

function resolveFonts(preferredNameOrFamily) {
    let family = null;
    if (preferredNameOrFamily && preferredNameOrFamily.fonts) {
        family = preferredNameOrFamily;
    } else {
        const wanted = preferredNameOrFamily
            ? [String(preferredNameOrFamily)]
            : ['Helvetica Neue', 'Helvetica', 'Neue Haas Grotesk', 'Aktiv Grotesk',
               'Univers', 'Inter', 'Arial', 'Roboto'];
        // Keep symbol/dingbat/mono families out of the fuzzy match
        // (e.g. "Univers" must not capture "UniversalMath1 BT").
        const isText = f => !/math|symbol|dingbat|wing ?ding|web ?ding|emoji|icon|ornament|mono|slab/i.test(f.name);
        const all = FontFamily.all;
        for (const w of wanted) {
            family = all.find(f => f.name.toLowerCase() === w.toLowerCase());
            if (family) break;
        }
        if (!family) for (const w of wanted) {
            family = all.find(f => isText(f) && f.name.toLowerCase().includes(w.toLowerCase()));
            if (family) break;
        }
    }
    if (!family) {
        const def = Font.createDefault();
        return { regular: def, medium: def, bold: def, familyName: def.familyName };
    }
    return {
        regular: pickFace(family, false, false),
        medium:  pickFace(family, false, true),
        bold:    pickFace(family, true,  false),
        familyName: family.name
    };
}

// ----------------------------------------------------------------------------
//  Node builders
// ----------------------------------------------------------------------------
function makeBuilders(doc) {
    const pxPerPt = doc.dpi / 72;
    const fmt = doc.format;

    function rect(builder, x, y, w, h, colour) {
        if (w <= 0 || h <= 0) return;
        const def = ShapeNodeDefinition.create(
            ShapeRectangle.create(), new Rectangle(x, y, w, h), colour);
        builder.addShapeNode(def);
    }

    function rule(builder, x, y, w, thickness, colour) {
        rect(builder, x, y - thickness / 2, w, thickness, colour);
    }
    function vrule(builder, x, y, h, thickness, colour) {
        rect(builder, x - thickness / 2, y, thickness, h, colour);
    }

    // Frame text (font + size + colour + alignment already baked in)
    function text(builder, x, y, w, h, str, face, sizePx, colour, align) {
        const sb = StoryBuilder.create();
        sb.setToFrameTextDefaultStyle(doc.dpi, fmt);
        const ga = sb.glyphAtts;
        ga.height = sizePx;
        if (face) ga.font = face;
        ga.brushFill = FillDescriptor.createSolid(colour);
        sb.setGlyphAtts(ga);
        const pa = sb.paragraphAtts;
        pa.alignXType = align || ParagraphAlignXType.Left;
        sb.setParagraphAtts(pa);
        sb.addText(String(str));
        builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(
            new Rectangle(x, y, Math.max(w, 1), Math.max(h, 1)), sb));
    }

    // Multi-style text on a single line (e.g. month/year in bold followed by
    // the week number in dimmed regular). `runs` is a list of
    // { text, face, colour, size? }.
    function richText(builder, x, y, w, h, runs, sizePx, align) {
        const sb = StoryBuilder.create();
        sb.setToFrameTextDefaultStyle(doc.dpi, fmt);
        const pa = sb.paragraphAtts;
        pa.alignXType = align || ParagraphAlignXType.Left;
        sb.setParagraphAtts(pa);
        for (const r of runs) {
            const ga = sb.glyphAtts;
            ga.height = r.size || sizePx;
            if (r.face) ga.font = r.face;
            ga.brushFill = FillDescriptor.createSolid(r.colour);
            sb.setGlyphAtts(ga);
            sb.addText(String(r.text));
        }
        builder.addNode(FrameTextNodeDefinition.createFromStoryBuilder(
            new Rectangle(x, y, Math.max(w, 1), Math.max(h, 1)), sb));
    }

    return { rect, rule, vrule, text, richText, pxPerPt };
}

// ----------------------------------------------------------------------------
//  View: MONTH
// ----------------------------------------------------------------------------
function drawMonth(B, area, cfg, L) {
    const { rect, rule, vrule, text, pxPerPt } = B;
    const { year, month, weekStartsMonday, showGrid, showVerticals, showHeader,
            boldWeekend, showAdjacent, showWeekNumbers, weekNumberIso, showTitle,
            showAccentBar, sizes, today, C } = cfg;

    // A size of 0 means "work it out from the area", which keeps the calendar
    // resolution-independent; any other value is that exact size in points.
    const S = (pt, auto) => (pt > 0 ? pt * pxPerPt : auto);

    const margin = Math.min(area.w, area.h) * 0.055;
    const gx = area.x + margin;
    const gy0 = area.y + margin;
    const gw = area.w - margin * 2;

    const titleSize = area.w * 0.052;
    const titleH = titleSize * 1.25;
    if (showTitle) {
        text(B.b, gx, gy0, gw * 0.8, titleH * 1.6,
             L.months[month].toUpperCase(), cfg.fonts.bold, titleSize, C.ink);
        text(B.b, gx, gy0 + titleH * 0.02, gw, titleH * 1.6,
             String(year), cfg.fonts.regular, titleSize, C.ink, ParagraphAlignXType.Right);
        if (showAccentBar) {
            rect(B.b, gx, gy0 + titleH * 1.45, titleSize * 1.5,
                 Math.max(area.w * 0.006, 3), C.accent);
        }
    }

    const wkColW = showWeekNumbers ? Math.max(margin, gw * 0.05) : 0;
    const wkGap  = showWeekNumbers ? gw * 0.018 : 0;
    const gridX = gx + wkColW + wkGap;
    const gridW = gw - wkColW - wkGap;
    const colW = gridW / 7;

    const first = new Date(year, month, 1);
    const startCol = columnOf(first.getDay(), weekStartsMonday);
    const dim = daysInMonth(year, month);
    const numWeeks = Math.ceil((startCol + dim) / 7);

    // Without a title, the grid takes that space back.
    const gridTop = gy0 + (showTitle ? titleH * 2.0 : 0);
    const gridBottom = area.y + area.h - margin;

    const hair = Math.max(area.w * 0.0012, 1);
    const hairStrong = hair * 2;
    const inset = colW * 0.08;
    // Weekday header: size tied to the body text, with enough air above the
    // strong top rule of the grid.
    const headSize = S(sizes.head, Math.max(colW * 0.185, area.w * 0.013));
    const headerH = showHeader ? headSize * 2.3 : 0;
    const bodyTop = gridTop + headerH;
    const rowH = (gridBottom - bodyTop) / numWeeks;
    const daySize = S(sizes.day, Math.min(rowH * 0.24, colW * 0.34));
    const wkSize = S(sizes.week, daySize * 0.72);
    const cellPadTop = rowH * 0.16;   // gap between the rule and the day number

    if (showHeader) {
        const headY = gridTop + (headerH - headSize) * 0.34;
        for (let c = 0; c < 7; c++) {
            const isWknd = weekStartsMonday ? (c >= 5) : (c === 0 || c === 6);
            text(B.b, gridX + c * colW + inset, headY,
                 colW - inset * 2, headerH,
                 L.daysShort[weekStartsMonday ? c : (c + 6) % 7],
                 cfg.fonts.medium, headSize, isWknd ? C.accent : C.ink);
        }
        if (showWeekNumbers) {
            // "WK" header, same size and style as the day numbers. It gets a
            // wide right-aligned frame (right edge at gx+wkColW) so the word
            // never wraps onto two lines.
            text(B.b, gx - wkColW, headY, wkColW * 2, headerH,
                 L.weekAbbr, cfg.fonts.medium, headSize, C.muted,
                 ParagraphAlignXType.Right);
        }
    }

    if (showGrid) {
        for (let r = 0; r <= numWeeks; r++) {
            const yy = bodyTop + r * rowH;
            const strong = r === 0;
            // The top rule (under the header) also spans the week-number
            // column, for one continuous header.
            const x0 = strong && showWeekNumbers ? gx : gridX;
            const w0 = strong && showWeekNumbers ? gw : gridW;
            rule(B.b, x0, yy, w0, strong ? hairStrong : hair, strong ? C.ink : C.rule);
        }
        if (showVerticals) {
            for (let c = 0; c <= 7; c++) {
                vrule(B.b, gridX + c * colW, bodyTop, rowH * numWeeks, hair, C.rule);
            }
        }
    }

    const drawCell = (dObj, col, row, muted) => {
        const cx = gridX + col * colW;
        const cy = bodyTop + row * rowH;
        const isWknd = weekStartsMonday ? (col >= 5) : (col === 0 || col === 6);
        const isToday = today && sameDay(dObj, today);
        let colour = muted ? C.muted : (isWknd ? C.accent : C.ink);
        let face = cfg.fonts.regular;
        if (!muted && isWknd && boldWeekend) face = cfg.fonts.bold;
        if (isToday) { colour = C.accent; face = cfg.fonts.bold; }
        text(B.b, cx + inset, cy + cellPadTop, colW - inset, rowH * 0.5,
             dObj.getDate(), face, daySize, colour);
        if (isToday) {
            rect(B.b, cx + inset, cy + cellPadTop + daySize * 1.15,
                 daySize * 1.1, hairStrong * 1.5, C.accent);
        }
    };

    const prevDim = daysInMonth(month === 0 ? year - 1 : year, (month + 11) % 12);
    for (let c = 0; c < startCol; c++) {
        if (!showAdjacent) break;
        const d = prevDim - startCol + 1 + c;
        drawCell(new Date(year, month - 1, d), c, 0, true);
    }
    for (let day = 1; day <= dim; day++) {
        const cell = startCol + day - 1;
        drawCell(new Date(year, month, day), cell % 7, Math.floor(cell / 7), false);
    }
    if (showAdjacent) {
        const used = startCol + dim;
        const total = numWeeks * 7;
        for (let i = 0; i < total - used; i++) {
            drawCell(new Date(year, month + 1, i + 1),
                     (used + i) % 7, Math.floor((used + i) / 7), true);
        }
    }

    if (showWeekNumbers) {
        // "From 1": week 1 is the one containing January 1 (per the chosen
        // week-start day); from there it counts forward.
        let week1Start = null;
        if (!weekNumberIso) {
            const jan1 = new Date(year, 0, 1);
            const off = weekStartsMonday ? ((jan1.getDay() + 6) % 7) : jan1.getDay();
            week1Start = new Date(year, 0, 1 - off);
        }
        for (let r = 0; r < numWeeks; r++) {
            const firstCellDay = 1 + r * 7 - startCol;   // first cell of the row (may be <= 0)
            let wn;
            if (weekNumberIso) {
                // ISO 8601 is Monday-first: number by the Monday of that week.
                const mondayShift = weekStartsMonday ? 0 : 1;
                wn = isoWeek(new Date(year, month, firstCellDay + mondayShift));
            } else {
                const rowStart = new Date(year, month, firstCellDay);
                wn = Math.round((rowStart - week1Start) / 604800000) + 1;
            }
            text(B.b, gx, bodyTop + r * rowH + cellPadTop, wkColW,
                 rowH * 0.5, wn, cfg.fonts.regular, wkSize,
                 C.muted, ParagraphAlignXType.Right);
        }
    }
}

// ----------------------------------------------------------------------------
//  View: YEAR  (12 mini-months in a columns x rows grid)
// ----------------------------------------------------------------------------

// Exact grids for 12 months, indexed like the dialog's yearGridOpts. Index 0
// is "automatic" and is resolved by yearGridFor().
const YEAR_GRIDS = [null, [4, 3], [3, 4], [6, 2], [2, 6], [12, 1], [1, 12]];

// Automatic grid: the one whose cells come closest to a mini-month's natural
// shape (7 day columns over a title, a header and up to 6 weeks -- about as
// wide as tall). Compared on a log scale so 2x too wide and 2x too tall
// weigh the same.
function yearGridFor(idx, w, h) {
    if (YEAR_GRIDS[idx]) return YEAR_GRIDS[idx];
    const IDEAL = 1.05;
    let best = YEAR_GRIDS[1], bestErr = Infinity;
    for (let i = 1; i < YEAR_GRIDS.length; i++) {
        const [c, r] = YEAR_GRIDS[i];
        const err = Math.abs(Math.log((w / c) / (h / r) / IDEAL));
        if (err < bestErr) { bestErr = err; best = YEAR_GRIDS[i]; }
    }
    return best;
}

function drawYear(B, area, cfg, L) {
    const { text, rect, pxPerPt } = B;
    const { year, weekStartsMonday, showHeader, boldWeekend, showTitle,
            showAccentBar, yearGrid, sizes, today, C } = cfg;

    // 0 = derive from the area; anything else is that exact size in points.
    const S = (pt, auto) => (pt > 0 ? pt * pxPerPt : auto);

    const margin = Math.min(area.w, area.h) * 0.05;
    const gx = area.x + margin;
    const gy = area.y + margin;
    const gw = area.w - margin * 2;
    const gh = area.h - margin * 2;

    const titleSize = area.w * 0.032;
    const titleH = titleSize * 1.6;
    if (showTitle) {
        text(B.b, gx, gy, gw, titleH * 1.4, String(year), cfg.fonts.bold, titleSize, C.ink);
        if (showAccentBar) {
            rect(B.b, gx, gy + titleH * 1.05, titleSize * 1.4,
                 Math.max(area.w * 0.004, 3), C.accent);
        }
    }

    // Without a title, the mini-months take that space back (cellH uses areaTop - gy).
    const areaTop = gy + (showTitle ? titleH * 1.6 : 0);
    const availH = gh - (areaTop - gy);
    const [cols, rows] = yearGridFor(yearGrid || 0, gw, availH);

    // Gutters: 3.5 % of the width / 5 % of the height each, as in the original
    // 4 x 3 grid, but the total is capped at that grid's share (3 and 2 gutters)
    // so 12 columns or 12 rows don't lose a third of the area to gutters.
    const gutterX = cols > 1 ? Math.min(gw * 0.035, gw * 0.105 / (cols - 1)) : 0;
    const gutterY = rows > 1 ? Math.min(gh * 0.05, gh * 0.10 / (rows - 1)) : 0;
    const cellW = (gw - gutterX * (cols - 1)) / cols;
    const cellH = (availH - gutterY * (rows - 1)) / rows;

    // A mini-month is 7 day columns by up to 7 rows (header + 6 weeks). In a
    // cell far from that shape (12 x 1, 1 x 12 on a page) stretching it to fill
    // the cell spreads the days apart and starves the type, so:
    //  - in a wide cell the month name moves to the LEFT of the grid, where
    //    there is width to spare, instead of taking height from it;
    //  - the grid keeps a sane column/row proportion and sits top-left in its
    //    cell (flush left, like the rest of the calendar).
    // For cells close to square (4 x 3, 3 x 4) neither cap kicks in and the
    // layout is the same as before.
    const sideTitle = cellW > cellH * 2;
    const mTitleSize = sideTitle
        ? Math.min(cellH * 0.16, cellW * 0.05)
        : Math.min(cellW * 0.11, cellH * 0.11);
    const titleColW = sideTitle ? mTitleSize * 7.5 : 0;   // fits "SEPTIEMBRE"
    const titleRowH = sideTitle ? 0 : mTitleSize * 1.9;
    const rawColW = (cellW - titleColW) / 7;
    const rawRowH = (cellH - titleRowH) / 7;
    const colW = Math.min(rawColW, rawRowH * 1.8);
    const rowH = Math.min(rawRowH, colW * 1.15);
    const numSize = S(sizes.day, Math.min(colW * 0.58, rowH * 0.62));
    const headSize = S(sizes.head, Math.min(colW * 0.5, rowH * 0.54));

    for (let m = 0; m < 12; m++) {
        const cx = gx + (m % cols) * (cellW + gutterX);
        const cy = areaTop + Math.floor(m / cols) * (cellH + gutterY);

        text(B.b, cx, cy, sideTitle ? titleColW : cellW, mTitleSize * 1.4,
             L.months[m].toUpperCase(), cfg.fonts.bold, mTitleSize, C.ink);

        const gridX = cx + titleColW;
        const gridTop = cy + titleRowH;

        if (showHeader) {
            for (let c = 0; c < 7; c++) {
                const isWknd = weekStartsMonday ? (c >= 5) : (c === 0 || c === 6);
                text(B.b, gridX + c * colW, gridTop, colW, rowH,
                     L.daysMini[weekStartsMonday ? c : (c + 6) % 7],
                     cfg.fonts.medium, headSize, isWknd ? C.accent : C.muted,
                     ParagraphAlignXType.Centre);
            }
        }
        const bodyTop = gridTop + (showHeader ? rowH : 0);

        const first = new Date(year, m, 1);
        const startCol = columnOf(first.getDay(), weekStartsMonday);
        const dim = daysInMonth(year, m);
        for (let day = 1; day <= dim; day++) {
            const cell = startCol + day - 1;
            const col = cell % 7, row = Math.floor(cell / 7);
            const isWknd = weekStartsMonday ? (col >= 5) : (col === 0 || col === 6);
            const isToday = today && sameDay(new Date(year, m, day), today);
            let colour = isWknd ? C.accent : C.ink;
            let face = (isWknd && boldWeekend) ? cfg.fonts.bold : cfg.fonts.regular;
            if (isToday) { colour = C.accent; face = cfg.fonts.bold; }
            text(B.b, gridX + col * colW, bodyTop + row * rowH, colW, rowH,
                 day, face, numSize, colour, ParagraphAlignXType.Centre);
        }
    }
}

// ----------------------------------------------------------------------------
//  View: WEEK  (7 columns)
// ----------------------------------------------------------------------------
function drawWeek(B, area, cfg, L) {
    const { text, rule, vrule, rect, pxPerPt } = B;
    const { year, month, day, weekStartsMonday, showVerticals, showTitle,
            showAccentBar, sizes, today, C } = cfg;

    // 0 = derive from the area; anything else is that exact size in points.
    const S = (pt, auto) => (pt > 0 ? pt * pxPerPt : auto);

    const margin = Math.min(area.w, area.h) * 0.06;
    const gx = area.x + margin;
    const gy = area.y + margin;
    const gw = area.w - margin * 2;
    const gh = area.h - margin * 2;

    const ref = new Date(year, month, day);
    const refCol = columnOf(ref.getDay(), weekStartsMonday);
    const monday = new Date(year, month, day - refCol);

    const titleSize = area.w * 0.030;
    const titleH = titleSize * 1.6;
    const endOfWeek = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    const range = (monday.getMonth() === endOfWeek.getMonth())
        ? `${L.months[monday.getMonth()]} ${monday.getFullYear()}`
        : `${L.months[monday.getMonth()]} – ${L.months[endOfWeek.getMonth()]} ${endOfWeek.getFullYear()}`;
    if (showTitle) {
        text(B.b, gx, gy, gw * 0.7, titleH * 1.4, range.toUpperCase(),
             cfg.fonts.bold, titleSize, C.ink);
        text(B.b, gx, gy, gw, titleH * 1.4,
             `${L.week} ${isoWeek(monday)}`, cfg.fonts.regular, titleSize,
             C.accent, ParagraphAlignXType.Right);
        if (showAccentBar) {
            rect(B.b, gx, gy + titleH * 1.4, titleSize * 1.5,
                 Math.max(area.w * 0.005, 3), C.accent);
        }
    }

    const gridTop = gy + (showTitle ? titleH * 2.0 : 0);
    const gridH = (gy + gh) - gridTop;
    const colW = gw / 7;
    const hair = Math.max(area.w * 0.0012, 1);
    const inset = colW * 0.06;
    const headSize = S(sizes.head, Math.max(colW * 0.11, area.w * 0.011));
    // numSize is the final drawn size (the old code multiplied by 0.92 at the
    // point of use), so an explicit point value lands exactly.
    const numSize = S(sizes.day, colW * 0.42 * 0.92);

    rule(B.b, gx, gridTop, gw, hair * 2, C.ink);
    for (let c = 0; c < 7; c++) {
        const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + c);
        const isWknd = (d.getDay() === 0 || d.getDay() === 6);
        const isToday = today && sameDay(d, today);
        const cx = gx + c * colW;
        const colour = isWknd ? C.accent : C.ink;
        text(B.b, cx + inset, gridTop + inset, colW - inset, headSize * 1.6,
             L.daysShort[(d.getDay() + 6) % 7],
             cfg.fonts.medium, headSize, colour);
        text(B.b, cx + inset, gridTop + headSize * 2.0, colW, numSize * 1.52,
             d.getDate(), isToday ? cfg.fonts.bold : cfg.fonts.regular,
             numSize, isToday ? C.accent : colour);
        rule(B.b, cx + inset, gridTop + headSize * 2.2 + numSize * 1.467,
             colW - inset * 2, hair, C.rule);
    }
    if (showVerticals) {
        for (let c = 1; c < 7; c++) vrule(B.b, gx + c * colW, gridTop, gridH, hair, C.rule);
    }
    rule(B.b, gx, gy + gh, gw, hair, C.rule);
}

// ----------------------------------------------------------------------------
//  View: DAY
// ----------------------------------------------------------------------------
function drawDay(B, area, cfg, L) {
    const { text, richText, rule, vrule, rect, pxPerPt } = B;
    const { year, month, day, showAgenda, agendaStart, agendaEnd, agenda24h,
            showTitle, showAccentBar, sizes, today, C } = cfg;

    // 0 = derive from the area; anything else is that exact size in points.
    const S = (pt, auto) => (pt > 0 ? pt * pxPerPt : auto);

    const hourLabel = (h) => {
        if (agenda24h) return String(h).padStart(2, '0') + ':00';
        const ap = h < 12 ? 'AM' : 'PM';
        let hh = h % 12; if (hh === 0) hh = 12;
        return hh + ' ' + ap;
    };

    const margin = Math.min(area.w, area.h) * 0.08;
    const gx = area.x + margin;
    const gy = area.y + margin;
    const gw = area.w - margin * 2;
    const gh = area.h - margin * 2;

    const d = new Date(year, month, day);
    const isToday = today && sameDay(d, today);
    const weekdayName = L.daysLong[(d.getDay() + 6) % 7];
    const hair = Math.max(Math.min(area.w, area.h) * 0.0014, 1);

    // With an agenda on a landscape area, the date block goes on the left and
    // the hours fill the right column (Swiss daily planner). On a portrait
    // area (or with no agenda) everything stacks. Sizes are tied to the
    // smaller dimension so it works at any proportion.
    const wide = showAgenda && gw > gh * 1.2;
    const dateW = wide ? gw * 0.40 : gw;
    const u = Math.min(dateW, gh);

    const wSize   = Math.min(u * 0.11, gh * 0.10);
    const subSize = Math.min(u * 0.055, gh * 0.05);
    const numSize = wide
        ? Math.min(dateW * 0.82, gh * 0.52)
        : Math.min(gw * 0.32, gh * 0.42);

    // With no title the weekday name and the month/year line are dropped; the
    // big day number stays and moves up to take the space.
    let cy = gy;
    if (showTitle) {
        text(B.b, gx, cy, dateW, wSize * 1.4, weekdayName.toUpperCase(),
             cfg.fonts.bold, wSize, isToday ? C.accent : C.ink);
        if (showAccentBar) {
            rect(B.b, gx, cy + wSize * 1.25, wSize * 1.5,
                 Math.max(u * 0.012, 3), C.accent);
        }
        cy += wSize * 1.95;
    }
    text(B.b, gx, cy, dateW, numSize * 1.15, String(day),
         cfg.fonts.bold, numSize, C.ink);
    cy += numSize * 1.08;
    if (showTitle) {
        // Month/year in bold; "  ·  WEEK nn" in dimmed regular (Swiss hierarchy).
        richText(B.b, gx, cy, wide ? dateW : gw, subSize * 1.7, [
            { text: `${L.months[month]} ${year}`, face: cfg.fonts.bold, colour: C.ink },
            { text: `  ·  ${L.week} ${isoWeek(d)}`, face: cfg.fonts.regular, colour: C.muted }
        ], subSize);
        cy += subSize * 2.6;
    }

    if (!showAgenda) return;

    const agX = wide ? gx + gw * 0.46 : gx;
    const agW = wide ? gw - gw * 0.46 : gw;
    const top = wide ? gy : cy;
    const bottom = gy + gh;
    const availH = bottom - top;
    if (availH < subSize * 2) return;

    let hours = Math.max(1, Math.round(agendaEnd - agendaStart));
    const step = availH / hours;
    const gutterW = agW * 0.13;
    const labSize = S(sizes.hour, Math.max(Math.min(subSize * 0.78, step * 0.5), 9));

    for (let i = 0; i <= hours; i++) {
        const yy = top + i * step;
        rule(B.b, agX, yy, agW, i === 0 ? hair * 2 : hair, i === 0 ? C.ink : C.rule);
        if (i < hours) {
            text(B.b, agX, yy + step * 0.24, gutterW, step, hourLabel(agendaStart + i),
                 cfg.fonts.regular, labSize, C.muted);
        }
    }
    // Vertical rule separating the hours column from the writing area.
    vrule(B.b, agX + gutterW, top, step * hours, hair, C.rule);
}

// ----------------------------------------------------------------------------
//  Preset stored in the document
//
//  The script filesystem is usually PERMISSION_DENIED, so settings are kept
//  inside the document itself: an empty container node at the root of the
//  spread whose LAYER NAME is "SCC-PRESET:" + JSON. `userDescription` round-
//  trips long strings fine and has a working setter, so updating the preset is
//  just a rename -- no text-node reading required. The preset travels with the
//  .afdesign file, so reopening it on another machine keeps the settings.
// ----------------------------------------------------------------------------
const PRESET_TAG = 'SCC-PRESET:';

function findPresetNode(doc) {
    try {
        for (const ch of doc.spreads.first.children) {
            if ((ch.userDescription || '').indexOf(PRESET_TAG) === 0) return ch;
        }
    } catch (e) {}
    return null;
}

function readPreset(node) {
    if (!node) return null;
    try {
        const p = JSON.parse((node.userDescription || '').slice(PRESET_TAG.length));
        return (p && typeof p === 'object') ? p : null;
    } catch (e) { return null; }   // a corrupt preset is simply ignored
}

function writePreset(doc, node, obj) {
    try {
        const s = PRESET_TAG + JSON.stringify(obj);
        if (node) { node.userDescription = s; return; }
        const b = AddChildNodesCommandBuilder.create();
        b.setInsertionTarget(doc.spreads.first);   // root of the spread, not an artboard
        b.addContainerNode(ContainerNodeDefinition.create(s));
        doc.executeCommand(b.createCommand(true));
    } catch (e) {}   // never let preset saving break the run
}

function rgbOf(colour) {
    try { const v = colour.rgba8; return { r: v.r, g: v.g, b: v.b }; }
    catch (e) { return null; }
}

// ----------------------------------------------------------------------------
//  Artboard sequence helpers
// ----------------------------------------------------------------------------

// "Artboard2" sorts before "Artboard10".
// NOTE: String.localeCompare() throws "RangeError: Icu error" in Affinity's JS
// engine, so plain < / > comparison is used instead.
function naturalCmp(a, b) {
    const ax = String(a).match(/\d+|\D+/g) || [];
    const bx = String(b).match(/\d+|\D+/g) || [];
    for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
        const A = ax[i], B = bx[i];
        if (A === undefined) return -1;
        if (B === undefined) return 1;
        if (/^\d/.test(A) && /^\d/.test(B)) {
            const d = parseInt(A, 10) - parseInt(B, 10);
            if (d) return d;
        } else {
            const la = A.toLowerCase(), lb = B.toLowerCase();
            if (la < lb) return -1;
            if (la > lb) return 1;
        }
    }
    return 0;
}

// mode: 0 by name (natural) · 1 rows (top-to-bottom, left-to-right) · 2 columns
function sortArtboards(list, mode) {
    const box = n => { try { return n.artboardSpreadBaseBox; } catch (e) { return { x: 0, y: 0 }; } };
    const nm  = n => { try { return n.userDescription || n.name || ''; } catch (e) { return ''; } };
    const TOL = 2;   // artboards on the same row/column share the coordinate exactly
    if (mode === 1) {
        list.sort((a, b) => { const A = box(a), B = box(b);
            return Math.abs(A.y - B.y) > TOL ? A.y - B.y : A.x - B.x; });
    } else if (mode === 2) {
        list.sort((a, b) => { const A = box(a), B = box(b);
            return Math.abs(A.x - B.x) > TOL ? A.x - B.x : A.y - B.y; });
    } else {
        list.sort((a, b) => naturalCmp(nm(a), nm(b)));
    }
    return list;
}

// Node wrappers are recreated on every traversal, so identity comparison does
// not work -- match artboards by their position in the spread instead.
function sameArtboard(a, b) {
    try {
        const A = a.artboardSpreadBaseBox, B = b.artboardSpreadBaseBox;
        return Math.abs(A.x - B.x) < 0.5 && Math.abs(A.y - B.y) < 0.5;
    } catch (e) { return false; }
}

// The i-th period of the sequence, per view.
function periodStart(typeIdx, y, m, d, i) {
    if (i === 0) return { year: y, month: m, day: d };
    if (typeIdx === 0) return { year: y + i, month: m, day: d };          // Year
    if (typeIdx === 1) {                                                 // Month
        const t = new Date(y, m + i, 1);
        return { year: t.getFullYear(), month: t.getMonth(), day: d };
    }
    const t = new Date(y, m, d + (typeIdx === 2 ? 7 : 1) * i);           // Week / Day
    return { year: t.getFullYear(), month: t.getMonth(), day: t.getDate() };
}

// ----------------------------------------------------------------------------
//  Runs a dialog and returns true only for OK.
//
//  Closing a dialog with the window's X (or Esc) does not return Cancel:
//  runModal() THROWS instead -- ABORTED when run from the Scripts panel,
//  INVALID_OP from other hosts. That is a cancel, not an error, so it is
//  swallowed. A throw that comes back almost instantly, though, cannot be the
//  user closing the window (e.g. another modal is already open), so that one
//  is re-thrown and still reported.
// ----------------------------------------------------------------------------
function runDialog(dlg) {
    const t0 = Date.now();
    try {
        const r = dlg.runModal();
        return r === DialogResult.Ok || r === DialogResult.Ok.value;
    } catch (e) {
        if (Date.now() - t0 < 500) throw e;
        return false;
    }
}

// ----------------------------------------------------------------------------
//  Language dialog. Control labels are fixed when the control is created, so
//  the language is chosen before the main dialog is built.
// ----------------------------------------------------------------------------
function askLanguage(initial) {
    const dlg = Dialog.create('Idioma · Language');
    const g = dlg.addColumn().addGroup();
    const bs = g.addButtonSet('Idioma · Language', ['Español', 'English'],
                              initial === 'en' ? 1 : 0).setIsFullWidth();
    if (!runDialog(dlg)) return null;
    return bs.selectedIndex === 1 ? 'en' : 'es';
}

// ----------------------------------------------------------------------------
//  Main dialog.
//
//  Two columns -- the SDK has no scroll and sizes the dialog to its content,
//  so a single tall column pushes OK/Cancel off screen once every section is
//  open. Left column: target + view + date + sequence + agenda. Right column:
//  elements + style. Collapsible sections are emulated (Affinity has no native
//  ones): per SECTION_HEADER the header is a ▶/▼ arrow button (two buttons that
//  swap) or a switch; both show/hide the section's control group.
// ----------------------------------------------------------------------------
function buildDialog(U, months, defaults, targetLabel) {
    const T = U.tips;
    // Every initial value comes from `defaults` (the preset stored in the
    // document, if any), falling back to the hardcoded default.
    const D = (k, fallback) =>
        (defaults[k] === undefined || defaults[k] === null) ? fallback : defaults[k];
    const DC = (k, r, g, b) => {
        const c = defaults[k];
        return (c && typeof c.r === 'number') ? RGB8(c.r, c.g, c.b) : RGB8(r, g, b);
    };
    const dlg = Dialog.create(U.title);
    dlg.initialWidth = 660;
    try { dlg.isResizable = true; } catch (e) {}
    const colL = dlg.addColumn();
    const colR = dlg.addColumn();
    try { colL.widthProportion = 1;    } catch (e) {}
    try { colR.widthProportion = 1.25; } catch (e) {}

    // Shows which artboard / shape the calendar will land on, so a wrong
    // selection is caught at a glance before pressing OK.
    colL.addGroup().addStaticText(null, U.targetPrefix + targetLabel).setIsFullWidth();

    const sections = {};
    function section(col, key, title, expanded, tip) {
        let s;
        let body;

        if (SECTION_HEADER === 'arrow') {
            // Two buttons that swap: the arrow "changes" as it folds/unfolds.
            const head = col.addGroup();
            const openBtn = head.addButton('▼  ' + title)
                .setIsFullWidth().setAlignment(HorizontalAlignment.Left).setDescription(tip || '');
            const shutBtn = head.addButton('▶  ' + title)
                .setIsFullWidth().setAlignment(HorizontalAlignment.Left).setDescription(tip || '');
            body = col.addGroup();
            body.enableSeparator = true;
            const st = { open: expanded };
            const sync = () => {
                openBtn.isVisible = st.open;
                shutBtn.isVisible = !st.open;
                body.isVisible = st.open;
            };
            openBtn.onClickHandler = () => { st.open = false; sync(); };
            shutBtn.onClickHandler = () => { st.open = true;  sync(); };
            sync();
            s = { set: (on) => { st.open = on; sync(); } };
        } else {
            const sw = col.addGroup().addSwitch(title, expanded).setDescription(tip || '');
            body = col.addGroup();
            body.enableSeparator = true;
            body.isVisible = expanded;
            sw.onValueChangedHandler = () => { body.isVisible = sw.value; };
            s = { set: (on) => { sw.value = on; body.isVisible = on; } };
        }

        sections[key] = s;
        return body;
    }
    dlg.expandSection = (key, on = true) => {
        if (sections[key]) sections[key].set(on);
    };

    // --- Left column ---------------------------------------------------------
    const gType = colL.addGroup(U.secType);
    dlg.type = gType.addButtonSet(U.view, U.views, D('view', 1)).setIsFullWidth().setDescription(T.view);
    dlg.yearGrid = gType.addComboBox(U.yearGrid, U.yearGridOpts, D('yearGrid', 0)).setDescription(T.yearGrid);

    const gDate = section(colL, 'date', U.secDate, true, T.secDate);
    dlg.year  = gDate.addUnitValueEditor(U.year, UnitType.Number, UnitType.Number, defaults.year, 1900, 2200).setPrecision(0).setDescription(T.year);
    dlg.month = gDate.addComboBox(U.month, months, defaults.month).setDescription(T.month);
    dlg.day   = gDate.addUnitValueEditor(U.day, UnitType.Number, UnitType.Number, defaults.day, 1, 31).setPrecision(0).setDescription(T.day);
    dlg.weekStart = gDate.addButtonSet(U.weekStart, U.weekStartOpts, D('weekStart', 0)).setDescription(T.weekStart);
    dlg.weekNumMode = gDate.addButtonSet(U.weekNumMode, U.weekNumModeOpts, D('weekNumMode', 1)).setDescription(T.weekNumMode);

    const gSeq = section(colL, 'sequence', U.secSequence, false, T.secSequence);
    dlg.seqOn    = gSeq.addCheckBox(U.seqOn, D('seqOn', false)).setIsFullWidth().setDescription(T.seqOn);
    dlg.seqCount = gSeq.addUnitValueEditor(U.seqCount, UnitType.Number, UnitType.Number, D('seqCount', 12), 1, 60).setPrecision(0).setDescription(T.seqCount);
    dlg.seqOrder = gSeq.addButtonSet(U.seqOrder, U.seqOrderOpts, D('seqOrder', 0)).setDescription(T.seqOrder);

    const gAgenda = section(colL, 'agenda', U.secAgenda, false, T.secAgenda);
    dlg.agenda    = gAgenda.addCheckBox(U.agendaShow, D('agenda', true)).setIsFullWidth().setDescription(T.agendaShow);
    dlg.agendaFrom = gAgenda.addUnitValueEditor(U.agendaFrom, UnitType.Number, UnitType.Number, D('agendaFrom', 8), 0, 23).setPrecision(0).setDescription(T.agendaFrom);
    dlg.agendaTo   = gAgenda.addUnitValueEditor(U.agendaTo, UnitType.Number, UnitType.Number, D('agendaTo', 20), 1, 24).setPrecision(0).setDescription(T.agendaTo);
    dlg.timeFormat = gAgenda.addButtonSet(U.timeFormat, U.timeFormatOpts, D('timeFormat', 1)).setDescription(T.timeFormat);

    // --- Right column -------------------------------------------------------
    const gShow = section(colR, 'elements', U.secElements, true, T.secElements);
    const showStack = gShow.addColumnStack();
    const showL = showStack.addColumn().addGroup();
    const showR = showStack.addColumn().addGroup();
    dlg.showTitle   = showL.addCheckBox(U.showTitle, D('showTitle', true)).setIsFullWidth().setDescription(T.showTitle);
    dlg.header      = showL.addCheckBox(U.header, D('header', true)).setIsFullWidth().setDescription(T.header);
    dlg.grid        = showL.addCheckBox(U.grid, D('grid', true)).setIsFullWidth().setDescription(T.grid);
    dlg.verticals   = showL.addCheckBox(U.verticals, D('verticals', false)).setIsFullWidth().setDescription(T.verticals);
    dlg.accentBar   = showL.addCheckBox(U.accentBar, D('accentBar', true)).setIsFullWidth().setDescription(T.accentBar);
    dlg.adjacent    = showR.addCheckBox(U.adjacent, D('adjacent', true)).setIsFullWidth().setDescription(T.adjacent);
    dlg.weekNumbers = showR.addCheckBox(U.weekNumbers, D('weekNumbers', false)).setIsFullWidth().setDescription(T.weekNumbers);
    dlg.boldWeekend = showR.addCheckBox(U.boldWeekend, D('boldWeekend', false)).setIsFullWidth().setDescription(T.boldWeekend);
    dlg.markToday   = showR.addCheckBox(U.markToday, D('markToday', true)).setIsFullWidth().setDescription(T.markToday);

    const gStyle = section(colR, 'style', U.secStyle, false, T.secStyle);
    dlg.font   = gStyle.addFontPicker(U.font).setDescription(T.font);
    // Point sizes; 0 keeps the automatic, area-derived size.
    dlg.sizeDay  = gStyle.addUnitValueEditor(U.sizeDay,  UnitType.Point, UnitType.Point, D('sizeDay', 0),  0, 400).setPrecision(1).setDescription(T.sizeDay);
    dlg.sizeHead = gStyle.addUnitValueEditor(U.sizeHead, UnitType.Point, UnitType.Point, D('sizeHead', 0), 0, 400).setPrecision(1).setDescription(T.sizeHead);
    dlg.sizeWeek = gStyle.addUnitValueEditor(U.sizeWeek, UnitType.Point, UnitType.Point, D('sizeWeek', 0), 0, 400).setPrecision(1).setDescription(T.sizeWeek);
    dlg.sizeHour = gStyle.addUnitValueEditor(U.sizeHour, UnitType.Point, UnitType.Point, D('sizeHour', 0), 0, 400).setPrecision(1).setDescription(T.sizeHour);
    dlg.ink    = gStyle.addColourPicker(U.ink, DC('ink', 17, 17, 17)).setDescription(T.ink);
    dlg.accent = gStyle.addColourPicker(U.accent, DC('accent', 227, 6, 19)).setDescription(T.accent);
    dlg.rule   = gStyle.addColourPicker(U.ruleColour, DC('rule', 150, 150, 150)).setDescription(T.ruleColour);
    dlg.muted  = gStyle.addColourPicker(U.muted, DC('muted', 176, 176, 176)).setDescription(T.muted);

    if (defaults.fontFamily) {
        const fam = FontFamily.all.find(f => f.name === defaults.fontFamily);
        if (fam) dlg.font.fontFamily = fam;
    }

    // Choosing the "Day" view opens the Agenda section.
    dlg.type.onValueChangedHandler = () => {
        if (dlg.type.selectedIndex === 3) dlg.expandSection('agenda', true);
    };
    return dlg;
}

// ----------------------------------------------------------------------------
//  Main
// ----------------------------------------------------------------------------
function main() {
    const doc = Document.current;

    // Settings saved in this document last time, if any. Read before the
    // language dialog so it can preselect the language too.
    const presetNode = doc ? findPresetNode(doc) : null;
    const preset = readPreset(presetNode) || {};

    const langKey = askLanguage(preset.lang);
    if (!langKey) return;
    const L = STR[langKey];
    const U = L.ui;

    if (!doc) { alert(U.noDoc); return; }
    if (!doc.selection || doc.selection.length === 0) { alert(U.noSel); return; }

    // Walk the parent chain: is there an artboard? are we inside a calendar
    // this script already created?
    const CAL_RE = /^(Calendario|Calendar) · /;
    function context(node) {
        let n = node, artboard = null, insideCalendar = false;
        while (n) {
            try { if (!artboard && n.artboardInterface && n.artboardInterface.isArtboardEnabled) artboard = n; } catch (e) {}
            try { if (CAL_RE.test(n.userDescription || '')) insideCalendar = true; } catch (e) {}
            n = n.parent;
        }
        return { artboard, insideCalendar };
    }

    // With several selected nodes, prefer one that is NOT part of a calendar
    // already created (e.g. the rectangle the user just drew).
    const selNodes = doc.selection.nodes.toArray();
    let baseNode = selNodes.find(n => !context(n).insideCalendar) || selNodes[0];
    if (!baseNode) { alert(U.noSel); return; }
    if (context(baseNode).insideCalendar) { alert(U.reSel); return; }

    // Is the selection an artboard, or a shape inside one / a loose shape?
    const selIsArtboard = (() => {
        try { return !!baseNode.artboardInterface.isArtboardEnabled; }
        catch (e) { return false; }
    })();
    const targetArtboard = context(baseNode).artboard;

    // insertTarget: where the calendar's group goes.
    // area: the rectangle to fill, ALWAYS in SPREAD coordinates.
    //
    // The artboard gotcha: when a node is inserted inside an artboard,
    // Affinity adds a transform that cancels the artboard's own, so the
    // children's coordinates are read in spread space (not local to the
    // artboard). That's why `area` comes from `spreadBaseBox` /
    // `artboardSpreadBaseBox`, which give the real position in the spread, so
    // the calendar lands inside the right artboard even with several of them
    // offset from each other.
    let insertTarget, area;
    if (selIsArtboard) {
        // The artboard is selected -> the calendar fills its whole surface.
        insertTarget = baseNode;
        const sb = baseNode.artboardSpreadBaseBox;   // the artboard's real rect in the spread
        area = { x: sb.x, y: sb.y, w: sb.width, h: sb.height };
    } else if (targetArtboard) {
        // Shape inside an artboard -> the calendar fills its box. Insert into
        // the artboard (its transform cancels out) and use spread coordinates.
        insertTarget = targetArtboard;
        const sb = baseNode.spreadBaseBox;
        area = { x: sb.x, y: sb.y, w: sb.width, h: sb.height };
    } else {
        // Loose shape in a document with no artboards.
        insertTarget = baseNode.parent;
        const sb = baseNode.spreadBaseBox || baseNode.baseBox;
        area = { x: sb.x, y: sb.y, w: sb.width, h: sb.height };
    }
    if (!area || !isFinite(area.w) || area.w <= 0 || area.h <= 0) { alert(U.noSel); return; }
    let targetLabel;
    if (selIsArtboard) {
        targetLabel = (baseNode.userDescription || baseNode.name || '?');
    } else if (targetArtboard) {
        targetLabel = U.targetShapeIn + '«' + (targetArtboard.userDescription || targetArtboard.name || '?') + '»';
    } else {
        targetLabel = U.targetDoc;
    }

    const now = new Date();
    const base = resolveFonts(null);
    // Preset values win; anything missing falls back to "today" / the defaults.
    const defaults = Object.assign({}, preset, {
        year:  preset.year  != null ? preset.year  : now.getFullYear(),
        month: preset.month != null ? preset.month : now.getMonth(),
        day:   preset.day   != null ? preset.day   : now.getDate(),
        fontFamily: preset.font || base.familyName
    });
    const dlg = buildDialog(U, L.months, defaults, targetLabel);

    if (!runDialog(dlg)) return;

    const pickedFont = dlg.font.font;
    const fonts = resolveFonts(pickedFont ? pickedFont.familyName : base.familyName);

    const C = {
        ink:    dlg.ink.value    || RGB8(17, 17, 17),
        accent: dlg.accent.value || RGB8(227, 6, 19),
        rule:   dlg.rule.value   || RGB8(150, 150, 150),
        muted:  dlg.muted.value  || RGB8(176, 176, 176)
    };

    let agendaStart = Math.round(dlg.agendaFrom.value);
    let agendaEnd = Math.round(dlg.agendaTo.value);
    if (agendaEnd <= agendaStart) agendaEnd = agendaStart + 1;

    const cfg = {
        year: Math.round(dlg.year.value),
        month: dlg.month.selectedIndex,
        day: Math.min(Math.round(dlg.day.value),
                      daysInMonth(Math.round(dlg.year.value), dlg.month.selectedIndex)),
        weekStartsMonday: dlg.weekStart.selectedIndex === 0,
        weekNumberIso: dlg.weekNumMode.selectedIndex === 0,
        showHeader: dlg.header.value,
        showGrid: dlg.grid.value,
        showVerticals: dlg.verticals.value,
        showAdjacent: dlg.adjacent.value,
        showWeekNumbers: dlg.weekNumbers.value,
        boldWeekend: dlg.boldWeekend.value,
        showTitle: dlg.showTitle.value,
        showAccentBar: dlg.accentBar.value,
        showAgenda: dlg.agenda.value,
        agendaStart, agendaEnd,
        agenda24h: dlg.timeFormat.selectedIndex === 1,
        yearGrid: dlg.yearGrid.selectedIndex,   // index into YEAR_GRIDS; 0 = automatic
        // Point sizes; 0 means "derive it from the area" (the default).
        sizes: {
            day:  Math.max(0, dlg.sizeDay.value),
            head: Math.max(0, dlg.sizeHead.value),
            week: Math.max(0, dlg.sizeWeek.value),
            hour: Math.max(0, dlg.sizeHour.value)
        },
        today: dlg.markToday.value ? now : null,
        fonts, C
    };

    const typeIdx = dlg.type.selectedIndex;      // 0 Year, 1 Month, 2 Week, 3 Day

    // Remember everything in the document for the next run.
    writePreset(doc, presetNode, {
        v: 1,
        lang: langKey,
        view: typeIdx,
        year: cfg.year, month: cfg.month, day: cfg.day,
        weekStart: dlg.weekStart.selectedIndex,
        weekNumMode: dlg.weekNumMode.selectedIndex,
        showTitle: cfg.showTitle, header: cfg.showHeader, grid: cfg.showGrid,
        verticals: cfg.showVerticals, accentBar: cfg.showAccentBar,
        adjacent: cfg.showAdjacent, weekNumbers: cfg.showWeekNumbers,
        boldWeekend: cfg.boldWeekend, markToday: dlg.markToday.value,
        agenda: cfg.showAgenda, agendaFrom: agendaStart, agendaTo: agendaEnd,
        timeFormat: dlg.timeFormat.selectedIndex,
        yearGrid: cfg.yearGrid,
        seqOn: dlg.seqOn.value,
        seqCount: Math.round(dlg.seqCount.value),
        seqOrder: dlg.seqOrder.selectedIndex,
        font: fonts.familyName,
        sizeDay: cfg.sizes.day, sizeHead: cfg.sizes.head,
        sizeWeek: cfg.sizes.week, sizeHour: cfg.sizes.hour,
        ink: rgbOf(C.ink), accent: rgbOf(C.accent),
        rule: rgbOf(C.rule), muted: rgbOf(C.muted)
    });

    // One calendar: its own container, then all its children in one command.
    function drawOne(target, a, c) {
        const contDef = ContainerNodeDefinition.create(
            `${U.calName} · ${U.views[typeIdx]} ${c.year}` +
            (typeIdx === 1 ? ` · ${L.months[c.month]}` : ''));
        const cb = AddChildNodesCommandBuilder.create();
        if (target) cb.setInsertionTarget(target);
        cb.addContainerNode(contDef);
        doc.executeCommand(cb.createCommand(true));
        const container = doc.selection.nodes.first;

        const b = AddChildNodesCommandBuilder.create();
        b.setInsertionTarget(container);
        const B = makeBuilders(doc);
        B.b = b;
        try {
            if (typeIdx === 0)      drawYear(B, a, c, L);
            else if (typeIdx === 1) drawMonth(B, a, c, L);
            else if (typeIdx === 2) drawWeek(B, a, c, L);
            else                    drawDay(B, a, c, L);
            doc.executeCommand(b.createCommand(true));
        } catch (e) {
            // If drawing fails, don't leave an empty container in the document.
            try { doc.deleteSelection(Selection.create(doc, container)); } catch (_) {}
            throw e;
        }
    }

    if (!dlg.seqOn.value) {
        drawOne(insertTarget, area, cfg);
        return;
    }

    // --- Sequence: one period per artboard ----------------------------------
    const hasCalendar = (ab) => {
        try { for (const ch of ab.children) if (CAL_RE.test(ch.userDescription || '')) return true; }
        catch (e) {}
        return false;
    };

    const boards = [];
    try {
        for (const n of doc.spreads.first.children) {
            try { if (n.artboardInterface && n.artboardInterface.isArtboardEnabled) boards.push(n); }
            catch (e) {}
        }
    } catch (e) {}
    if (!boards.length) { alert(U.seqNoArtboards); return; }

    // The document's own child order is unreliable -- sort explicitly.
    sortArtboards(boards, dlg.seqOrder.selectedIndex);

    const startAb = selIsArtboard ? baseNode : targetArtboard;
    let startIdx = 0;
    if (startAb) {
        const k = boards.findIndex(n => sameArtboard(n, startAb));
        if (k >= 0) startIdx = k;
    }

    // Each artboard gets the same area as the starting one: the whole artboard
    // if that is what was selected, otherwise the same relative rectangle.
    let rel = null;
    if (!selIsArtboard && targetArtboard) {
        try {
            const r = targetArtboard.artboardSpreadBaseBox;
            rel = { dx: area.x - r.x, dy: area.y - r.y, w: area.w, h: area.h };
        } catch (e) {}
    }

    const count = Math.round(dlg.seqCount.value);
    let made = 0, skipped = 0, i = startIdx;
    while (made < count && i < boards.length) {
        const ab = boards[i++];
        if (hasCalendar(ab)) { skipped++; continue; }

        let a;
        try {
            const r = ab.artboardSpreadBaseBox;
            a = rel ? { x: r.x + rel.dx, y: r.y + rel.dy, w: rel.w, h: rel.h }
                    : { x: r.x, y: r.y, w: r.width, h: r.height };
        } catch (e) { continue; }
        if (!a || !isFinite(a.w) || a.w <= 0 || a.h <= 0) continue;

        const p = periodStart(typeIdx, cfg.year, cfg.month, cfg.day, made);
        const c = Object.assign({}, cfg, p);
        c.day = Math.min(c.day, daysInMonth(c.year, c.month));

        drawOne(ab, a, c);
        made++;
    }

    if (!made) { alert(U.seqNone); return; }
    let msg = U.seqReport.replace('{n}', made);
    if (skipped) msg += U.seqSkipped.replace('{s}', skipped);
    alert(msg);
}

try {
    main();
} catch (e) {
    alert('Swiss Calendar Creator:\n' + (e && e.message ? e.message : e) +
          (e && e.stack ? '\n\n' + e.stack : ''));
}
