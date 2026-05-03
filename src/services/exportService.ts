import * as XLSX from 'xlsx';
import type { CandidateSummary } from '../types/page-io';
import type { CandidateDbResult } from './candidateResultDb';
import type { ExportMode } from '../types/settings';

export interface ExportRow {
  序号: number;
  姓名: string;
  页面摘要: string;
  AI结果: string;
  推荐理由: string;
  处理时间: string;
  使用模型: string;
}

export function exportCandidatesXlsx(
  candidates: CandidateSummary[],
  resultsMap: Map<string, CandidateDbResult>,
  mode: ExportMode,
  keyFn: (name: string, previewText: string) => string,
): void {
  const rows: ExportRow[] = [];

  for (const c of candidates) {
    const key = keyFn(c.name, c.previewText);
    const result = resultsMap.get(key);

    if (mode === 'processed' && !result) continue;

    rows.push({
      序号: c.index + 1,
      姓名: c.name,
      页面摘要: c.previewText,
      AI结果: result ? (result.shouldFavorite ? '推荐跟进' : '暂不跟进') : '未处理',
      推荐理由: result?.reason ?? '',
      处理时间: result ? new Date(result.processedAt).toLocaleString('zh-CN', { hour12: false }) : '',
      使用模型: result?.model ?? '',
    });
  }

  const worksheet = XLSX.utils.json_to_sheet(rows);

  // Column widths
  worksheet['!cols'] = [
    { wch: 6 },   // 序号
    { wch: 12 },  // 姓名
    { wch: 40 },  // 页面摘要
    { wch: 12 },  // AI结果
    { wch: 40 },  // 推荐理由
    { wch: 20 },  // 处理时间
    { wch: 18 },  // 使用模型
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '候选人数据');

  const timestamp = new Date()
    .toLocaleString('zh-CN', { hour12: false })
    .replace(/[/:\s]/g, '-');

  XLSX.writeFile(workbook, `候选人数据_${timestamp}.xlsx`);
}
