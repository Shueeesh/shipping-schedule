/**
 * 半自动配载系统 — 价格表解析器
 *
 * 职责：
 * - 解析 6 种不同格式的价格表 Excel
 * - 统一为 { 提拆, 卡派, 组合柜, 整柜直送, 清关, 仓储 } 标准结构
 * - 按区域/仓点/柜型提供费用查询接口
 */

const XLSX = require('xlsx');
const path = require('path');

// ============================================================
// 统一价格结构
// ============================================================

/**
 * UnifiedPriceTable:
 * {
 *   region: 'LA' | 'NY' | 'Chicago' | 'Houston',
 *   supplier: 'yingcang' | 'yicifang' | 'UGD',
 *   effectiveMonth: '2026-06',
 *   deconsolidation: { '40HQ': price, '45HQ': price },   // 提拆打托
 *   truckLTL: { warehouse: { perPallet: price } },        // 散板卡派
 *   truckFTL: { warehouse: price },                       // 整车卡派
 *   combined: { groupName: { '40HQ': price, '45HQ': price, warehouses: [] } }, // 组合柜
 *   directDelivery: { warehouse: price },                  // 整柜直送
 *   customs: { perBill: price, isf: price },               // 清关
 *   storage: { perCBMperDay: price, freeDays: days },      // 仓储
 *   misc: { labeling: price, repalletizing: price, chassis: price }, // 杂费
 * }
 */

// ============================================================
// 主入口
// ============================================================

function parsePriceTable(filePath, region, supplier) {
  console.log(`[PriceParser] 解析: ${path.basename(filePath)} (${region}/${supplier})`);

  switch (supplier) {
    case 'yingcang':
      if (region === 'LA') return parseYingcangLA(filePath);
      if (region === 'NY') return parseYingcangNY(filePath);
      break;
    case 'yicifang':
      if (region === 'Chicago') return parseYicifangChicago(filePath);
      if (region === 'Houston') return parseYicifangHouston(filePath);
      break;
    case 'UGD':
      return parseUGD(filePath);
  }

  console.warn(`[PriceParser] 不支持的组合: ${region}/${supplier}`);
  return null;
}

// ============================================================
// LA 盈仓价格表
// ============================================================

function parseYingcangLA(filePath) {
  const wb = XLSX.readFile(filePath);
  const result = { region: 'LA', supplier: 'yingcang', deconsolidation: {}, truckLTL: {}, truckFTL: {}, combined: {}, directDelivery: {}, customs: {}, storage: {}, misc: {} };

  // 1. 提拆打托全包价
  const deconSheet = readSheet(wb, '提拆打托全包价');
  if (deconSheet.length) {
    // 结构：服务等级 | 40HQ价格 | 45HQ价格 | 时效
    for (const row of deconSheet) {
      const val = findPriceInRow(row);
      if (val) {
        const tierName = String(Object.values(row)[0] || '').trim();
        if (tierName.includes('T1') || val >= 1500) {
          result.deconsolidation['40HQ_T1'] = val;
          result.deconsolidation['45HQ_T1'] = val * 1.05;
        } else if (tierName.includes('T2') || (val >= 1300 && val < 1500)) {
          result.deconsolidation['40HQ_T2'] = val;
          result.deconsolidation['45HQ_T2'] = val * 1.05;
        } else if (tierName.includes('T3') || val < 1300) {
          result.deconsolidation['40HQ_T3'] = val;
          result.deconsolidation['45HQ_T3'] = val * 1.05;
        }
      }
    }
    // 默认值
    if (!result.deconsolidation['40HQ_T1']) result.deconsolidation['40HQ_T1'] = 1800;
    if (!result.deconsolidation['40HQ_T2']) result.deconsolidation['40HQ_T2'] = 1650;
    if (!result.deconsolidation['40HQ_T3']) result.deconsolidation['40HQ_T3'] = 1350;
    // 默认 T2
    result.deconsolidation['40HQ'] = result.deconsolidation['40HQ_T2'];
  }

  // 2. 组合柜价格
  const combinedSheet = readSheet(wb, '洛杉矶卡派（组合柜+散板价）');
  if (combinedSheet.length) {
    for (const row of combinedSheet) {
      const vals = Object.values(row);
      const zone = String(vals[0] || '').trim();
      const warehouse = String(vals[2] || '').trim().toUpperCase();
      const cbmPrice = parseFloat(vals[3]) || 0;
      const hq40Price = parseFloat(vals[4]) || 0;
      const hq45Price = parseFloat(vals[5]) || 0;

      if (warehouse && (hq40Price > 0 || cbmPrice > 0)) {
        const key = warehouse;
        if (!result.combined[key]) {
          result.combined[key] = { warehouse, zone, cbmPrice, hq40: hq40Price, hq45: hq45Price, groupName: zone };
        }
      }
    }
  }

  // 3. 整柜直送
  const directSheet = readSheet(wb, '洛杉矶整柜直送');
  if (directSheet.length) {
    for (const row of directSheet) {
      const vals = Object.values(row);
      const warehouse = String(vals[0] || '').trim().toUpperCase();
      const price = findPriceInRow(row);
      if (warehouse && price > 0) {
        result.directDelivery[warehouse] = price;
      }
    }
  }

  // 4. 仓储
  const storageSheet = readSheet(wb, '海外仓仓储服务');
  result.storage = { freeDays: 14, perPalletPerDay: 1, perCBMperDay: 0.5 };

  // 5. 清关
  result.customs = { perBill: 90, isf: 20, cpsc: 20, fda: 20 };

  return result;
}

// ============================================================
// 美东 NY 盈仓价格表
// ============================================================

function parseYingcangNY(filePath) {
  const wb = XLSX.readFile(filePath);
  const result = { region: 'NY', supplier: 'yingcang', deconsolidation: {}, truckLTL: {}, truckFTL: {}, combined: {}, directDelivery: {}, customs: {}, storage: {}, misc: {} };

  // 提拆全包价
  result.deconsolidation['40HQ'] = 1600; // 默认全包价

  // NJ FBA 卡派
  const njFbaSheet = readSheet(wb, 'NJ仓发车 FBA');
  if (njFbaSheet.length) {
    for (const row of njFbaSheet) {
      const vals = Object.values(row);
      const warehouse = String(vals[2] || '').trim().toUpperCase();
      // 找价格列
      const cbmPrice = parseFloat(vals[3]) || 0;
      const palletPrice = parseFloat(vals[4]) || 0;
      const bulkPrice = parseFloat(vals[5]) || 0;
      const ftlPrice = parseFloat(vals[6]) || 0;

      if (warehouse && (cbmPrice > 0 || palletPrice > 0)) {
        result.truckLTL[warehouse] = { perPallet: palletPrice, perCBM: cbmPrice, bulkRate: bulkPrice };
        if (ftlPrice > 0) result.truckFTL[warehouse] = ftlPrice;
      }
    }
  }

  // NJ 整柜直送
  const directSheet = readSheet(wb, 'NJ整柜直送');
  if (directSheet.length) {
    for (const row of directSheet) {
      const vals = Object.values(row);
      const warehouse = String(vals[0] || '').trim().toUpperCase();
      const price = findPriceInRow(row);
      if (warehouse && price > 0) {
        result.directDelivery[warehouse] = price;
      }
    }
  }

  // 清关
  result.customs = { perBill: 90, isf: 20 };

  // 仓储
  result.storage = { freeDays: 7, perPalletPerDay: 1 };

  return result;
}

// ============================================================
// 芝加哥 怡次方价格表
// ============================================================

function parseYicifangChicago(filePath) {
  const wb = XLSX.readFile(filePath);
  const result = { region: 'Chicago', supplier: 'yicifang', deconsolidation: {}, truckLTL: {}, truckFTL: {}, combined: {}, directDelivery: {}, customs: {}, storage: {}, misc: {} };

  // 提拆报价
  const deconSheet = readSheet(wb, '芝加哥提拆报价');
  if (deconSheet.length) {
    for (const row of deconSheet) {
      const vals = Object.values(row).map(v => String(v).trim());
      const text = vals.join(' ');
      // 提取价格
      if (text.includes('20GP')) {
        const price = findPriceInText(text);
        if (price) result.deconsolidation['20GP'] = price;
      }
      if (text.includes('40HQ')) {
        const price = findPriceInText(text);
        if (price) result.deconsolidation['40HQ'] = price;
      }
      if (text.includes('45HQ')) {
        const price = findPriceInText(text);
        if (price) result.deconsolidation['45HQ'] = price;
      }
    }
    if (!result.deconsolidation['40HQ']) result.deconsolidation['40HQ'] = 1450;
  }

  // 散板卡派
  const ltlSheet = readSheet(wb, '芝加哥散板卡派');
  if (ltlSheet.length) {
    for (const row of ltlSheet) {
      const vals = Object.values(row);
      const warehouse = String(vals[1] || '').trim().toUpperCase();
      const perPallet = parseFloat(vals[2]) || 0;
      const transit = String(vals[3] || '').trim();

      if (warehouse && perPallet > 0) {
        result.truckLTL[warehouse] = { perPallet, transit };
      }
    }
  }

  // 组合价
  const combinedSheet = readSheet(wb, '芝加哥组合价');
  if (combinedSheet.length) {
    for (const row of combinedSheet) {
      const vals = Object.values(row);
      const groupName = String(vals[0] || '').trim();
      const hq40 = parseFloat(vals[2]) || 0;
      const hq45 = parseFloat(vals[3]) || 0;
      const whText = String(vals[1] || '').trim();

      if (groupName && hq40 > 0) {
        result.combined[groupName] = {
          groupName,
          warehouses: whText.split('/'),
          hq40,
          hq45: hq45 || hq40 * 1.1,
        };
      }
    }
  }

  // 整柜直送
  const directSheet = readSheet(wb, '芝加哥整柜直送');
  if (directSheet.length) {
    for (const row of directSheet) {
      const vals = Object.values(row);
      const warehouse = String(vals[0] || '').trim().toUpperCase();
      const price = findPriceInRow(row);
      if (warehouse && price > 0) {
        result.directDelivery[warehouse] = price;
      }
    }
  }

  result.storage = { freeDays: 7, perPalletPerDay: 1 };
  result.customs = { perBill: 90, isf: 20 };

  return result;
}

// ============================================================
// 休斯顿 怡次方价格表
// ============================================================

function parseYicifangHouston(filePath) {
  const wb = XLSX.readFile(filePath);
  const result = { region: 'Houston', supplier: 'yicifang', deconsolidation: {}, truckLTL: {}, truckFTL: {}, combined: {}, directDelivery: {}, customs: {}, storage: {}, misc: {} };

  // 提拆
  const deconSheet = readSheet(wb, '休斯顿提拆');
  if (deconSheet.length) {
    for (const row of deconSheet) {
      const vals = Object.values(row).map(v => String(v).trim());
      const text = vals.join(' ');
      const price = findPriceInText(text);
      if (text.includes('提柜') && price) {
        result.deconsolidation['pickup'] = price;
      }
    }
    result.deconsolidation['40HQ'] = 1200; // 提拆打托默认
    result.deconsolidation['45HQ'] = 1300;
    result.misc.chassisPerDay = 40;
    result.misc.chassisSplit = 125;
  }

  // 散板卡派
  const ltlSheet = readSheet(wb, '休斯顿散板卡派');
  if (ltlSheet.length) {
    for (const row of ltlSheet) {
      const vals = Object.values(row);
      const warehouse = String(vals[0] || '').trim().toUpperCase();
      const perPallet1to3 = parseFloat(vals[1]) || 0;
      const perPallet4plus = parseFloat(vals[2]) || 0;

      if (warehouse && perPallet1to3 > 0) {
        result.truckLTL[warehouse] = { perPallet1to3, perPallet4plus };
      }
    }
  }

  // 组合价
  const combinedSheet = readSheet(wb, '休斯顿组合价');
  if (combinedSheet.length) {
    for (const row of combinedSheet) {
      const vals = Object.values(row);
      const groupName = String(vals[0] || '').trim();
      const hq40 = parseFloat(vals[1]) || 0;
      const hq45 = parseFloat(vals[2]) || 0;
      const whText = String(vals[3] || '').trim();

      if (groupName && hq40 > 0) {
        result.combined[groupName] = {
          groupName,
          warehouses: whText.split('/').filter(Boolean),
          hq40,
          hq45: hq45 || hq40 * 1.1,
        };
      }
    }
  }

  result.storage = { freeDays: 7, perPalletPerDay: 1 };
  result.customs = { perBill: 90, isf: 20 };

  return result;
}

// ============================================================
// UGD NJ 价格表
// ============================================================

function parseUGD(filePath) {
  const wb = XLSX.readFile(filePath);
  const result = { region: 'NY', supplier: 'UGD', deconsolidation: {}, truckLTL: {}, truckFTL: {}, combined: {}, directDelivery: {}, customs: {}, storage: {}, misc: {} };

  // 提柜服务
  const pickupSheet = readSheet(wb, '美东-提柜服务');
  if (pickupSheet.length) {
    for (const row of pickupSheet) {
      const text = Object.values(row).map(v => String(v)).join(' ');
      const price = findPriceInText(text);
      if (text.includes('提柜') && price) {
        result.deconsolidation['pickup'] = price;
      }
    }
    result.deconsolidation['40HQ'] = 400; // UGD 提柜默认
  }

  // 库内操作
  const opsSheet = readSheet(wb, '美东-库内操作及增值服务');
  if (opsSheet.length) {
    for (const row of opsSheet) {
      const text = Object.values(row).map(v => String(v)).join(' ');
      const price = findPriceInText(text);
      if (text.includes('20GP') && !text.includes('40')) {
        result.deconsolidation['20GP_ops'] = price;
      } else if (text.includes('40')) {
        result.deconsolidation['40HQ_ops'] = price || 400;
      }
    }
  }

  // 卡派报价
  const truckSheet = readSheet(wb, '美东-卡派报价');
  if (truckSheet.length) {
    for (const row of truckSheet) {
      const vals = Object.values(row);
      const warehouse = String(vals[1] || '').trim().toUpperCase();
      const perPallet = parseFloat(vals[3]) || 0;
      const ftl = parseFloat(vals[4]) || 0;
      const combined40 = parseFloat(vals[6]) || 0;
      const combined45 = parseFloat(vals[7]) || 0;
      const transit = String(vals[8] || '').trim();

      if (warehouse && perPallet > 0) {
        result.truckLTL[warehouse] = { perPallet, transit };
        if (ftl > 0) result.truckFTL[warehouse] = ftl;
        if (combined40 > 0) {
          result.combined[warehouse] = { warehouse, hq40: combined40, hq45: combined45 || combined40 * 1.1, transit };
        }
      }
    }
  }

  result.storage = { freeDays: 7, perPalletPerDay: 1 };
  result.customs = { perBill: 90, isf: 20 };

  return result;
}

// ============================================================
// 辅助函数
// ============================================================

function readSheet(wb, sheetName) {
  if (!wb.SheetNames.includes(sheetName)) {
    // 尝试模糊匹配
    const found = wb.SheetNames.find(n => n.includes(sheetName));
    if (found) {
      return XLSX.utils.sheet_to_json(wb.Sheets[found], { defval: '', raw: false });
    }
    return [];
  }
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false });
}

function findPriceInRow(row) {
  const vals = Object.values(row);
  for (const v of vals) {
    const num = parseFloat(v);
    if (!isNaN(num) && num > 10) return num; // 合理价格至少 > $10
  }
  return 0;
}

function findPriceInText(text) {
  // 匹配 $XXX 或 XXX 数字
  const match = text.match(/\$?\s*(\d{2,4}(?:\.\d+)?)/);
  if (match) return parseFloat(match[1]);
  return 0;
}

// ============================================================
// 批量解析
// ============================================================

function parseAllPriceTables(priceFiles) {
  const tables = {};

  for (const pf of priceFiles) {
    try {
      const table = parsePriceTable(pf.fullPath, pf.region, pf.supplier);
      if (table) {
        const key = `${pf.region}_${pf.supplier}`;
        tables[key] = table;
      }
    } catch (err) {
      console.error(`[PriceParser] 解析失败: ${pf.file}: ${err.message}`);
    }
  }

  return tables;
}

module.exports = {
  parsePriceTable,
  parseAllPriceTables,
  parseYingcangLA,
  parseYingcangNY,
  parseYicifangChicago,
  parseYicifangHouston,
  parseUGD,
};
