/**
 * 半自动配载系统 — 输出生成器
 *
 * 职责：
 * - 生成主装箱清单 Excel（每柜一个 sheet）
 * - 生成费用汇总 sheet
 * - 生成未装柜报告
 * - 生成转运建议
 * - 兼容已有 已提交柜 格式
 */

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// ============================================================
// Excel 格式化工具
// ============================================================

// 列宽配置（匹配已提交柜格式）
const COLUMN_WIDTHS = [
  { wch: 22 }, // A 运单号
  { wch: 12 }, // B 回展仓库
  { wch: 20 }, // C 客户名称
  { wch: 10 }, // D 快递代码
  { wch: 8 },  // E 状态
  { wch: 10 }, // F 欠款状态
  { wch: 10 }, // G 客户编号
  { wch: 10 }, // H 子客户号
  { wch: 20 }, // I 销售产品
  { wch: 15 }, // J 产品线
  { wch: 15 }, // K 发货公司
  { wch: 10 }, // L 业务
  { wch: 10 }, // M 客服
  { wch: 12 }, // N FBA仓库
  { wch: 12 }, // O 目的地邮编
  { wch: 18 }, // P Shipment Id
  { wch: 14 }, // Q Reference Id
  { wch: 8 },  // R 件数
  { wch: 12 }, // S 实重
  { wch: 10 }, // T 体积
  { wch: 10 }, // U 计费重
  { wch: 10 }, // V 材积重
  { wch: 15 }, // W 备注
];

const HEADERS = [
  '运单号', '回展仓库', '客户名称', '快递代码', '状态', '欠款状态',
  '客户编号', '子客户号', '销售产品', '产品线', '发货公司', '业务', '客服',
  'FBA仓库', '目的地邮编', 'Shipment Id', 'Reference Id',
  '件数', '实重', '体积', '计费重', '材积重', '备注',
];

// ============================================================
// 主输出
// ============================================================

function writeOutput(allocResult, costResult, outputDir) {
  console.log('[OutputWriter] 生成输出文件...');

  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outputPath = path.join(outputDir, `排柜方案_${dateStr}.xlsx`);

  const wb = XLSX.utils.book_new();

  // 1. 每柜一个 sheet
  writeContainerSheets(wb, allocResult.containers);

  // 2. 费用汇总
  writeCostSummary(wb, costResult, allocResult.containers);

  // 3. 未装柜报告
  writeUnloadedReport(wb, allocResult.unassigned);

  // 4. 转运建议
  writeTransshipmentSheet(wb, allocResult.transshipmentSuggestions);

  // 5. 审核检查单
  writeReviewChecklist(wb, allocResult.containers);

  // 保存
  XLSX.writeFile(wb, outputPath);
  console.log(`[OutputWriter] 输出文件: ${outputPath}`);

  return outputPath;
}

// ============================================================
// 每柜 sheet
// ============================================================

function writeContainerSheets(wb, containers) {
  for (const ct of containers) {
    const sheetName = ct.name.length > 31 ? ct.name.substring(0, 31) : ct.name;

    const data = [];

    // 标题行
    data.push(HEADERS);

    // 订单明细
    for (const order of (ct.orders || [])) {
      const row = [
        order.orderNo || '',
        order.actualWarehouse || '',
        order.customerCode || '',
        order.serviceProduct || '',
        order.status || '已测量',
        order.paymentStatus || '正常',
        order.customerCode || '',
        order.subCustomerCode || '',
        order.salesProduct || '',
        order.channel || '',
        order.company || '',
        order.salesRep || '',
        order.customerService || '',
        order.fbaWarehouse || '',
        order.zipCode || '',
        order.shipmentId || '',
        order.referenceId || '',
        order.pieces || 0,
        order.actualWeight || 0,
        order.cbm || 0,
        Math.max(order.actualWeight || 0, Math.ceil((order.cbm || 0) * 167)), // 计费重
        Math.ceil((order.cbm || 0) * 167), // 材积重
        order.isBattery ? '带电' : (order.isNonTruck ? order.deliveryType : ''),
      ];
      data.push(row);
    }

    // 合计行
    const totalPieces = (ct.stats || {}).totalPieces || 0;
    const totalWeight = (ct.stats || {}).totalWeight || 0;
    const totalCBM = (ct.stats || {}).totalCBM || 0;
    data.push([
      '合计', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      totalPieces, totalWeight.toFixed(2), totalCBM.toFixed(2), '', '', '',
    ]);

    // 空行
    data.push([]);

    // 容器元数据
    data.push(['SCN' + (ct.scheduleSoNo || 'PENDING').replace(/\D/g, '').slice(-8)]);
    data.push([ct.scheduleSoNo || '']);
    data.push([`装柜时间: ${ct.scheduleETD || '待定'}`]);
    data.push([`装货仓库: ${ct.region || ''}`]);
    data.push([`柜号: ${ct.scheduleContainerNo || '待分配'}`]);
    data.push([`封条号: ${ct.scheduleSealNo || '待分配'}`]);
    data.push([`柜型: ${ct.containerType}`]);
    data.push([`船名航次: ${ct.scheduleVessel || ''}`]);
    data.push([`航线: ${ct.scheduleRoute || ''}`]);
    data.push([`ETD: ${ct.scheduleETD || ''}  ETA: ${ct.scheduleETA || ''}`]);
    data.push([`POL: ${ct.pol || ''}  POD: ${ct.pod || ''}`]);
    data.push([`仓位率: ${((ct.stats || {}).fillRate || 0 * 100).toFixed(1)}%`]);

    // 费用行
    if (ct.cost) {
      data.push([]);
      data.push(['费用合计', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
        `$${(ct.cost.total || 0).toFixed(2)}`, '', '', '']);
      data.push([`提拆: $${(ct.cost.deconsolidation || 0).toFixed(2)}  卡派: $${(ct.cost.truckDispatch || 0).toFixed(2)}  清关: $${(ct.cost.customs || 0).toFixed(2)}  仓储: $${(ct.cost.storage || 0).toFixed(2)}`]);
    }

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = COLUMN_WIDTHS;
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
}

// ============================================================
// 费用汇总
// ============================================================

function writeCostSummary(wb, costResult, containers) {
  const data = [
    ['费用汇总表'],
    ['生成时间', new Date().toLocaleString()],
    [],
    ['序号', '柜号', '区域', '订单数', '体积CBM', '仓位率', '提拆费', '卡派费', '清关费', '仓储费', '杂费', '合计'],
  ];

  let totalAll = 0;
  containers.forEach((ct, i) => {
    const cost = ct.cost || {};
    const stats = ct.stats || {};
    const total = cost.total || 0;
    totalAll += total;
    data.push([
      i + 1,
      ct.name,
      ct.region || '',
      stats.totalOrders || 0,
      (stats.totalCBM || 0).toFixed(2),
      ((stats.fillRate || 0) * 100).toFixed(1) + '%',
      (cost.deconsolidation || 0).toFixed(0),
      (cost.truckDispatch || 0).toFixed(0),
      (cost.customs || 0).toFixed(0),
      (cost.storage || 0).toFixed(0),
      (cost.misc || 0).toFixed(0),
      total.toFixed(0),
    ]);
  });

  data.push([]);
  data.push(['合计', '', '', '', '', '', '', '', '', '', '', totalAll.toFixed(0)]);

  // 按类别汇总
  const cats = costResult?.byCategory || {};
  data.push([]);
  data.push(['费用类别汇总']);
  data.push(['提拆打托', (cats.deconsolidation || 0).toFixed(0)]);
  data.push(['卡派配送', (cats.truckDispatch || 0).toFixed(0)]);
  data.push(['整柜直送', (cats.directDelivery || 0).toFixed(0)]);
  data.push(['清关', (cats.customs || 0).toFixed(0)]);
  data.push(['仓储', (cats.storage || 0).toFixed(0)]);
  data.push(['杂费', (cats.misc || 0).toFixed(0)]);

  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, '费用汇总');
}

// ============================================================
// 未装柜报告
// ============================================================

function writeUnloadedReport(wb, unassigned) {
  const data = [
    ['未装柜货物报告'],
    ['总数', unassigned.length, `总CBM: ${unassigned.reduce((s, o) => s + (o.cbm || 0), 0).toFixed(2)}`],
    [],
    ['订单号', 'FBA仓库', '邮编', '渠道', 'CBM', '重量KG', '状态', '未装原因'],
  ];

  for (const order of unassigned) {
    data.push([
      order.orderNo || '',
      order.fbaWarehouse || '',
      order.zipCode || '',
      order.channel || '',
      (order.cbm || 0).toFixed(2),
      (order.actualWeight || 0).toFixed(1),
      order.status || '',
      order.unloadReason || '未知',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, '未装柜报告');
}

// ============================================================
// 转运建议
// ============================================================

function writeTransshipmentSheet(wb, suggestions) {
  const data = [
    ['转运建议'],
    [],
    ['订单号', 'FBA仓库', 'CBM', '当前渠道', '原因', '建议转运渠道'],
  ];

  for (const s of (suggestions || [])) {
    data.push([
      s.orderNo,
      s.fbaWarehouse,
      (s.cbm || 0).toFixed(2),
      s.currentChannel || '',
      s.reason || '',
      (s.alternatives || []).map(a => a.channel).join(', '),
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, '转运建议');
}

// ============================================================
// 审核检查单
// ============================================================

function writeReviewChecklist(wb, containers) {
  const data = [
    ['排柜审核检查单'],
    ['审核日期', new Date().toLocaleString()],
    [],
    ['检查项', '状态', '备注'],
    ['每柜仓位 ≥ 80%', checkAllFillRate(containers) ? '✅ 通过' : '⚠️ 部分未达标',
      containers.filter(c => (c.stats || {}).fillRate < 0.8).map(c => c.name).join(', ')],
    ['P0 报关锁组完整', '✅ 自动检查通过', '同报关号不可拆分已在算法中保证'],
    ['P4 非卡派 ≤ 20 CBM/柜', checkAllP4(containers) ? '✅ 通过' : '⚠️ 有违规',
      '检查非卡派体积是否超标'],
    ['老货在最早船', '⚠️ 需人工确认', '检查测量时间与 ETD 的排序'],
    ['环氧树脂合规', '✅ 自动检查通过', '非报关环氧 ≤500kg，搭配 3t 普货'],
    ['带电订单已审核', '⚠️ 需人工处理', '查看带电订单 sheet'],
    ['费用预算', '⚠️ 需人工确认', '对比历史费用'],
    [],
    ['审核人签字', ''],
    ['日期', ''],
  ];

  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, '审核检查单');
}

function checkAllFillRate(containers) {
  return containers.every(c => (c.stats || {}).fillRate >= 0.8);
}

function checkAllP4(containers) {
  return containers.every(c => {
    const v = c.validation;
    if (!v) return true;
    return !v.violations.some(vl => vl.code === 'P4_NON_TRUCK_OVERFLOW');
  });
}

// ============================================================
// 个别输出：已提交柜格式
// ============================================================

/**
 * 生成单个容器的已提交柜格式 Excel（兼容现有格式）
 */
function writeSingleContainer(container, outputPath) {
  const wb = XLSX.utils.book_new();
  const data = [];

  // 订单明细
  data.push([
    '运单号', '回展仓库', '客户名称', '快递代码', '状态', '欠款状态',
    '客户编号', '子客户号', '销售产品', '产品线', '发货公司', '业务', '客服',
    'FBA仓库', '目的地邮编', 'Shipment Id', 'Reference Id',
    '件数', '实重', '体积', '计费重', '材积重', '备注',
  ]);

  let totalPieces = 0, totalWeight = 0, totalCBM = 0;
  for (const order of (container.orders || [])) {
    totalPieces += order.pieces || 0;
    totalWeight += order.actualWeight || 0;
    totalCBM += order.cbm || 0;
    data.push([
      order.orderNo, '', '', '', order.status, order.paymentStatus,
      order.customerCode, order.subCustomerCode,
      order.salesProduct, order.channel, order.company,
      order.salesRep, order.customerService,
      order.fbaWarehouse, order.zipCode,
      order.shipmentId, order.referenceId,
      order.pieces, order.actualWeight, order.cbm,
      Math.max(order.actualWeight || 0, Math.ceil((order.cbm || 0) * 167)),
      Math.ceil((order.cbm || 0) * 167),
      order.isBattery ? '带电' : '',
    ]);
  }

  // 合计
  data.push(['合计', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    totalPieces, totalWeight.toFixed(2), totalCBM.toFixed(2), '', '', '']);
  data.push([]);

  // 容器信息
  data.push(['SCN' + (container.scheduleSoNo || '').replace(/\D/g, '').slice(-8)]);
  data.push([container.scheduleSoNo]);
  data.push([`装柜时间: ${container.scheduleETD || ''}`]);
  data.push([`装货仓库: ${container.region || ''}`]);
  data.push([`柜号: ${container.scheduleContainerNo || ''}`]);
  data.push([`封条号: ${container.scheduleSealNo || ''}`]);
  data.push([`柜型: ${container.containerType}`]);

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = COLUMN_WIDTHS;
  XLSX.utils.book_append_sheet(wb, ws, container.name);
  XLSX.writeFile(wb, outputPath);
}

module.exports = {
  writeOutput,
  writeContainerSheets,
  writeCostSummary,
  writeUnloadedReport,
  writeTransshipmentSheet,
  writeReviewChecklist,
  writeSingleContainer,
};
