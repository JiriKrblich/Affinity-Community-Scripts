/**
 * name: export all open files as jpeg
 * description: Export all open files as JPG files. Due to limitations, they can only be saved to the desktop.
 * version: 0.1.0
 * author: OpenAI Codex
 */
'use strict';

const { app } = require('/application');
const { FileExportOptions, FileExportArea } = require('/document');
const { Dialog, DialogResult } = require('/dialog');

// ============ 可选格式列表（按需增删） ============
// preset 名称必须与 FileExportOptions.allPresetNames 中的完全一致（中文系统为中文预设名）
const ALL_FORMATS = [
  { label: 'JPG（高质量）',        preset: 'JPEG (高质量)',        ext: '.jpg',  def: true  },
  { label: 'PSD（保留可编辑性）',  preset: 'PSD (保留可编辑性)',   ext: '.psd',  def: false },
  { label: 'PNG',                  preset: 'PNG',                  ext: '.png',  def: false },
  { label: 'TIFF RGB 8 位',        preset: 'TIFF RGB 8 位',        ext: '.tiff', def: false },
];
// 弹窗不可用时的默认行为
const DEFAULT_RANGE_WHOLE_DOC = true;
// ================================================

// ---------- 弹窗：选择导出格式与范围 ----------
function buildDialog() {
  const dlg = Dialog.create('导出所有打开的文档');
  const col = dlg.addColumn();

  const fmtGrp = col.addGroup('选择导出格式');
  const checks = ALL_FORMATS.map(f => fmtGrp.addCheckBox(f.label, f.def));

  const rangeGrp = col.addGroup('导出范围');
  const range = rangeGrp.addRadioGroup('范围',
    ['整个文档（所有页面）', '仅当前跨页'], 0);

  dlg.fmtChecks = checks;
  dlg.rangeRadio = range;
  return dlg;
}

// 返回 { formats, wholeDoc }；用户取消返回 null
function chooseViaDialog() {
  while (true) {
    const dlg = buildDialog();
    let result = null;
    try {
      result = dlg.runModal();
    } catch (e) {
      // 无界面环境（如 MCP）：runModal 抛 INVALID_OP → 使用默认配置
      console.log('弹窗不可用（' + (e && e.message ? e.message : e) + '），使用默认配置导出。');
      return {
        formats: ALL_FORMATS.filter(f => f.def),
        wholeDoc: DEFAULT_RANGE_WHOLE_DOC,
      };
    }
    if (result != DialogResult.Ok.value) {
      return null; // 用户点了取消
    }
    const formats = ALL_FORMATS.filter((f, i) => dlg.fmtChecks[i].value);
    if (formats.length === 0) {
      showAlert('请至少勾选一种导出格式。');
      continue; // 重新弹出，直到勾选了格式或取消
    }
    return {
      formats,
      wholeDoc: dlg.rangeRadio.selectedIndex === 0,
    };
  }
}

// ---------- 消息提示（弹窗优先，失败时降级为 console） ----------
function showAlert(message) {
  try {
    alert(message);
    return;
  } catch (e) { /* alert 不可用，继续降级 */ }
  try {
    const dlg = Dialog.create('提示');
    const col = dlg.addColumn();
    col.addStaticText(message);
    try { dlg.runModal(); } catch (e2) { /* 无界面环境 */ }
  } catch (e) { /* Dialog 也不可用 */ }
  console.log(message);
}

// ---------- 完成汇总弹窗 ----------
function showSummary(summary) {
  const lines = [
    '全部导出完成！',
    '',
    '文档：' + summary.docTotal + ' 个' +
      '（成功 ' + summary.docOk + ' / 失败 ' + summary.docFailed + '）',
    '导出文件：' + summary.fileOk + ' 个成功，' + summary.fileFailed + ' 个失败',
    '',
    '提示：当前版本 SDK 不支持用脚本关闭文档，',
    '如需关闭请手动操作（Ctrl+W）。',
  ];
  if (summary.failures.length > 0) {
    lines.push('');
    lines.push('失败详情：');
    summary.failures.slice(0, 10).forEach(f => lines.push('· ' + f));
    if (summary.failures.length > 10) {
      lines.push('… 等共 ' + summary.failures.length + ' 条');
    }
  }

  const message = lines.join('\n');

  // 优先用 Dialog 弹窗展示（可换行、有标题）
  try {
    const dlg = Dialog.create('导出完成');
    const col = dlg.addColumn();
    col.addStaticText(message);
    try {
      dlg.runModal();
      return;
    } catch (e) { /* 无界面环境（MCP）→ 降级 */ }
  } catch (e) { /* Dialog 构建失败 → 降级 */ }

  showAlert(message); // 再试 alert，最终降级 console.log
}

// ---------- 路径工具 ----------
function splitPath(p) {
  const sep = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  const dir = sep >= 0 ? p.slice(0, sep) : '';
  const file = sep >= 0 ? p.slice(sep + 1) : p;
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return { dir, file, stem };
}

function baseDirFor(doc) {
  if (doc.path) {
    const { dir } = splitPath(doc.path);
    if (dir) return dir;
  }
  return app.userDesktopPath; // 未保存的文档 → 桌面
}

// ---------- 单个文档导出单个格式 ----------
// 非 ASCII 文件名（如中文）会被沙箱拒绝，需要 ASCII 安全名兜底
function asciiSafeName(stem, docIndex) {
  const s = stem.replace(/[^\x20-\x7E]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return s || ('doc_' + (docIndex + 1));
}

function exportDoc(doc, fmt, wholeDoc, docIndex) {
  const stem = doc.path ? splitPath(doc.path).stem
    : (doc.name || 'Untitled').replace(/\.[^.]*$/, '');
  const opts = FileExportOptions.createWithPresetName(fmt.preset);
  const area = wholeDoc
    ? FileExportArea.createForWholeDocument()
    : FileExportArea.createForCurrentSpread();

  // 依次尝试：源文件旁 → 桌面；文件名先用原名，中文等非 ASCII 名被拒后用安全名
  const srcDir = baseDirFor(doc);
  const desktop = app.userDesktopPath;
  const ascii = asciiSafeName(stem, docIndex);
  const candidates = [];
  const push = (dir, name, note) => {
    const p = dir + '\\' + name + fmt.ext;
    if (!candidates.some(c => c.path === p)) candidates.push({ path: p, note });
  };
  push(srcDir, stem, '源文件旁');
  push(desktop, stem, '沙箱限制，回退到桌面');
  push(srcDir, ascii, '源文件旁（ASCII 安全名）');
  push(desktop, ascii, '沙箱限制，回退到桌面（ASCII 安全名）');

  for (const c of candidates) {
    try {
      const records = doc.export(c.path, opts, area);
      const record = records.all[0];
      if (record && record.isSuccess) {
        return { ok: true, path: record.path, note: c.note };
      }
    } catch (e) { /* 尝试下一个候选路径 */ }
  }
  return { ok: false, path: candidates[0].path, note: '' };
}

// ---------- 主流程 ----------
function main() {
  const docs = app.documents.all.slice(); // 快照
  console.log('打开的文档数:', docs.length);
  if (docs.length === 0) {
    showAlert('当前没有打开的文档，无事可做。');
    return;
  }

  const choice = chooseViaDialog();
  if (!choice) {
    console.log('已取消。');
    return;
  }

  const summary = {
    docTotal: docs.length,
    docOk: 0,
    docFailed: 0,
    fileOk: 0,
    fileFailed: 0,
    failures: [],
  };

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const label = doc.path || doc.name || '(未命名)';
    console.log('\n===== 导出:', label, '=====');

    let allOk = true;
    for (const fmt of choice.formats) {
      const r = exportDoc(doc, fmt, choice.wholeDoc, i);
      if (r.ok) {
        summary.fileOk++;
        console.log(fmt.label, 'OK ->', r.path, r.note ? '（' + r.note + '）' : '');
      } else {
        allOk = false;
        summary.fileFailed++;
        summary.failures.push(label + ' → ' + fmt.label);
        console.log(fmt.label, 'FAILED:', r.path);
      }
    }
    if (allOk) summary.docOk++;
    else summary.docFailed++;
  }

  console.log('\n全部完成。');
  showSummary(summary);
}

main();
