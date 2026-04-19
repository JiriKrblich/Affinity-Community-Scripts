/**
 * name: Smart JPEG Export
 * description: Exports all/selected artboards, spreads or docs with max. size limit
 * version: 1.0.0
 * author: JiriKrblich
 */

const { Dialog, DialogResult } = require('/dialog.js');
const { Document, FileExportOptions, FileExportArea } = require('/document.js');
const { app } = require('/application.js');
const { File, FileSystemApi } = require('/fs.js');

function bytesFromUnit(value, unit) {
  if (unit === 0) return value * 1024;
  if (unit === 2) return value * 1024 * 1024 * 1024;
  return value * 1024 * 1024;
}

function getFileSize(path) {
  try { return File.size(path); } catch(e) { return 0; }
}

const JPEG_PRESETS = [
  'JPEG (Best quality)',
  'JPEG (High quality)',
  'JPEG (Medium quality)',
  'JPEG (Low quality)',
];

function tryExport(doc, presetName, exportArea, outPath) {
  try {
    const opts = FileExportOptions.createWithPresetName(presetName);
    doc.export(outPath, opts, exportArea, null);
    return getFileSize(outPath) > 0;
  } catch(e) { return false; }
}

function exportBestFit(doc, exportArea, maxBytes, outPath, tmpDir) {
  const tmpPath = `${tmpDir}/_tmp_size_check.jpg`;
  for (const preset of JPEG_PRESETS) {
    const ok = tryExport(doc, preset, exportArea, tmpPath);
    if (ok) {
      const sz = getFileSize(tmpPath);
      try { FileSystemApi.remove(tmpPath); } catch(e) {}
      if (sz <= maxBytes) {
        tryExport(doc, preset, exportArea, outPath);
        return { preset, size: getFileSize(outPath), warning: false };
      }
    }
  }
  tryExport(doc, 'JPEG (Low quality)', exportArea, outPath);
  return { preset: 'JPEG (Low quality)', size: getFileSize(outPath), warning: true };
}

const doc = Document.current;
if (!doc) {
  app.alert('No document is open.', 'Export with File Size Limit');
} else {
  const desktopPath = app.getUserDesktopPath;
  const hasArtboards = doc.hasArtboards;

  const dlg = Dialog.create('Export JPEG with File Size Limit');
  dlg.initialWidth = 420;
  const col = dlg.addColumn();

  const grpSize = col.addGroup('Maximum file size');
  const txtSize = grpSize.addTextBox('Value', '2');
  const cmbUnit = grpSize.addComboBox('Unit', ['KB', 'MB', 'GB'], 1);

  const grpScope = col.addGroup('Export scope');
  const scopeOptions = hasArtboards
    ? ['Whole document', 'All artboards', 'Selected artboards only']
    : ['Whole document'];
  const cmbScope = grpScope.addComboBox('Scope', scopeOptions, 0);

  const grpDest = col.addGroup('Destination folder');
  const txtDest = grpDest.addTextBox('Path', desktopPath || '');
  txtDest.isFullWidth = true;

  const grpInfo = col.addGroup('Note');
  grpInfo.addStaticText('info', 'Tries JPEG presets from best to lowest quality\nand picks the highest quality that fits the limit.');

  const dlgResult = dlg.show();
  if (dlgResult && dlgResult.value === DialogResult.Ok.value) {
    const rawVal   = parseFloat(txtSize.text) || 2;
    const unitIdx  = cmbUnit.selectedIndex;
    const maxBytes = bytesFromUnit(rawVal, unitIdx);
    const scopeIdx = cmbScope.selectedIndex;
    const destDir  = (txtDest.text || '').trim() || desktopPath;
    const docTitle = (doc.title || 'export').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_\-]/gi, '_');
    const unitNames = ['KB', 'MB', 'GB'];

    let exported = 0, errors = 0, warnings = [];

    function doOne(exportArea, outPath, label) {
      try {
        const res = exportBestFit(doc, exportArea, maxBytes, outPath, destDir);
        exported++;
        if (res.warning) warnings.push(`${label}: lowest quality still exceeds limit (${Math.round(res.size/1024)} KB)`);
      } catch(e) { errors++; }
    }

    if (scopeIdx === 0 || !hasArtboards) {
      doOne(FileExportArea.createForWholeDocument(), `${destDir}/${docTitle}.jpg`, docTitle);
    } else if (scopeIdx === 1) {
      let idx = 0;
      for (const ab of doc.artboards) {
        const abName = (ab.description || `artboard_${idx+1}`).replace(/[^a-z0-9_\-]/gi, '_');
        doOne(FileExportArea.createForArtboard(ab), `${destDir}/${docTitle}_${abName}.jpg`, abName);
        idx++;
      }
    } else {
      let found = 0;
      for (const node of doc.selection.nodes) {
        const abInt = node.artboardInterface;
        if (abInt && abInt.isArtboardEnabled) {
          const abName = (abInt.description || `artboard_${found+1}`).replace(/[^a-z0-9_\-]/gi, '_');
          doOne(FileExportArea.createForArtboard(abInt), `${destDir}/${docTitle}_${abName}.jpg`, abName);
          found++;
        }
      }
      if (found === 0)
        app.alert('No artboards are selected.\nPlease select artboards and run the script again.', 'Export with File Size Limit');
    }

    if (exported > 0 || errors > 0) {
      let msg = `Export complete\n\nSuccessful: ${exported}  |  Failed: ${errors}\nMax size: ${rawVal} ${unitNames[unitIdx]}\nFolder: ${destDir}`;
      if (warnings.length > 0) msg += '\n\nWarnings:\n' + warnings.join('\n');
      app.alert(msg, 'Export with File Size Limit');
    }
  }
}
