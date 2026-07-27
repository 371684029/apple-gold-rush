// CFTC COT 报告 — 下载 + 解析黄金期货持仓（合约号 088691）
//
// CFTC 已于 2026 年迁移数据格式：
//   - 旧 URL: fut_fin_txt_YYYY.zip (仅金融期货, 不含金)
//   - 新 URL: com_disagg_txt_YYYY.zip (商品分类报告, 含金)
//   - 旧格式: 固定宽度, 行首为 088691
//   - 新格式: CSV 带引号, code 在列 3
//
// 每周五公布截至周二的持仓数据。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import type { CftcRecord } from '../types/institutional.js';

const execFileP = promisify(execFile);

const CFTC_URL = 'https://www.cftc.gov/files/dea/history/com_disagg_txt_YYYY.zip';

function yearUrl(year: number): string {
  return CFTC_URL.replace('YYYY', String(year));
}

/** 通过 curl 下载文件（绕过 Cloudflare TLS 指纹检测） */
async function curlDownload(url: string): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileP('curl', [
      '-sS', '-L', '-f',
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      '--max-time', '60',
      '--output', '-',
      url,
    ], {
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024,
      timeout: 65_000,
    });
    if (stdout.length === 0) return null;
    return stdout;
  } catch (err: any) {
    const msg = err.stderr?.toString().slice(0, 200) || err.message || String(err);
    if (!msg.includes('curl: (22)') && !msg.includes('curl: (28)')) {
      console.warn(`[cftc-grabber] ${url} 下载失败: ${msg}`);
    }
    return null;
  }
}

/**
 * 解析新格式 CFTC CSV:
 * 列结构 (disaggregated futures-only):
 *   0: Market_and_Exchange_Names
 *   1: Report_Date_YYMMDD (如 260707)
 *   2: Report_Date_YYYY-MM-DD (如 2026-07-07)
 *   3: CFTC_Contract_Market_Code (088691 = GOLD)
 *   7: Open_Interest_All
 *   8: Prod_Merc_Positions_Long_All
 *   9: Prod_Merc_Positions_Short_All
 *  10: Swap_Positions_Long_All
 *  11: Swap_Positions_Short_All
 *  12: M_Money_Positions_Long_All    ← 投机多头 (替代旧 nonCommLong)
 *  13: M_Money_Positions_Short_All   ← 投机空头 (替代旧 nonCommShort)
 *  14: Other_Rept_Positions_Long_All
 *  15: Other_Rept_Positions_Short_All
 */
function parseCftcCsv(text: string): CftcRecord[] {
  const records: CftcRecord[] = [];
  let header = true;

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (header) { header = false; continue; } // skip header

    // 简单 CSV 解析 (字段含引号但无内嵌逗号)
    const cols = line.split(',');
    if (cols.length < 16) continue;

    const code = cols[3]?.replace(/"/g, '').trim();
    if (code !== '088691') continue; // 仅黄金

    try {
      const dateRaw = cols[2]?.replace(/"/g, '').trim(); // YYYY-MM-DD in col 2
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) continue;

      // 解析失败返回 null 而不是 0：0 手持仓是一个有含义的极端值，
      // 把损坏的单元格当成 0 会伪造出「多头全部离场」的信号
      const parse = (i: number): number | null => {
        const raw = cols[i]?.replace(/"/g, '').trim();
        if (!raw) return null;
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : null;
      };

      const openInterest = parse(7);
      const nonCommLong = parse(12);  // Managed Money Long
      const nonCommShort = parse(13); // Managed Money Short
      const prodLong = parse(8);
      const prodShort = parse(9);
      const swapLong = parse(10);
      const swapShort = parse(11);

      // 净头寸所需字段任一缺失，则整行不可信，跳过而非补零
      if (nonCommLong == null || nonCommShort == null || openInterest == null) continue;

      const commNet =
        prodLong != null && prodShort != null && swapLong != null && swapShort != null
          ? (prodLong - prodShort) + (swapLong - swapShort)
          : 0;

      records.push({
        date: dateRaw,
        publishDate: dateRaw,
        nonCommLong,
        nonCommShort,
        nonCommNet: nonCommLong - nonCommShort,
        nonCommNetChange: 0,
        commNet,
        openInterest,
      });
    } catch {
      continue;
    }
  }

  return records;
}

function computeChanges(records: CftcRecord[]): void {
  records.sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 0; i < records.length; i++) {
    if (i === 0) { records[i].nonCommNetChange = 0; continue; }
    records[i].nonCommNetChange = records[i].nonCommNet - records[i - 1].nonCommNet;
  }
}

/** 从 ZIP buffer 中提取 c_year.txt（仅取第一个匹配文件） */
function extractCsvFromZip(zipBuffer: Buffer): string | null {
  let offset = 0;
  while (offset < zipBuffer.length - 30) {
    // PK\003\004 = local file header
    if (zipBuffer[offset] !== 0x50 || zipBuffer[offset + 1] !== 0x4b
      || zipBuffer[offset + 2] !== 0x03 || zipBuffer[offset + 3] !== 0x04) {
      offset++;
      continue;
    }
    const compMethod = zipBuffer.readUInt16LE(offset + 8);
    const compSize = zipBuffer.readUInt32LE(offset + 18);
    const fileNameLen = zipBuffer.readUInt16LE(offset + 26);
    const extraLen = zipBuffer.readUInt16LE(offset + 28);
    const fileName = zipBuffer.toString('utf-8', offset + 30, offset + 30 + fileNameLen);

    const dataStart = offset + 30 + fileNameLen + extraLen;

    // 只取 c_year.txt
    if (!fileName.includes('c_year.txt') || compSize === 0 || dataStart + compSize > zipBuffer.length) {
      offset++;
      continue;
    }

    const compressed = zipBuffer.subarray(dataStart, dataStart + compSize);
    try {
      if (compMethod === 8) {
        return inflateRawSync(compressed).toString('utf-8');
      } else if (compMethod === 0) {
        return compressed.toString('utf-8');
      }
    } catch {
      return null;
    }
    break;
  }
  return null;
}

/** 拉取指定年份的 CFTC COT 报告 */
export async function fetchCftcHistory(year: number): Promise<CftcRecord[]> {
  const url = yearUrl(year);
  const buffer = await curlDownload(url);
  if (!buffer) return [];

  const text = extractCsvFromZip(buffer);
  if (!text) return [];

  const records = parseCftcCsv(text);
  if (records.length > 0) computeChanges(records);
  return records;
}

/** 获取最新一条 CFTC 记录 */
export async function fetchLatestCftc(year?: number): Promise<CftcRecord | null> {
  const y = year ?? new Date().getFullYear();
  const records = await fetchCftcHistory(y);
  if (records.length === 0) return null;
  return records[records.length - 1];
}
