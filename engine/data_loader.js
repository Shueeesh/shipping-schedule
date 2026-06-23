/**
 * 半自动配载系统 — 数据加载器
 */
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { CHANNEL_PATTERNS, identifyPOL, identifyRegion, OA_CARRIERS } = require('./config');

function loadAllData(summaryPath, priceDir) {
  console.log('[DataLoader] 开始加载数据...');
  const orders = loadOrders(summaryPath);
  console.log(`[DataLoader] 加载订单: ${orders.length} 条 (已过滤)`);
  const schedules = loadSchedules(summaryPath);
  console.log(`[DataLoader] 加载船期: ${schedules.length} 条`);
  const priceFiles = scanPriceFiles(priceDir);
  console.log(`[DataLoader] 扫描价格表: ${priceFiles.length} 份`);
  return { orders, schedules, priceFiles };
}

function readSheet(filePath, sheetName) {
  const wb = XLSX.readFile(filePath);
  const trimmedName = sheetName.trim();
  const found = wb.SheetNames.find(n => n.trim() === trimmedName);
  if (!found) {
    const partial = wb.SheetNames.find(n => n.trim().includes(trimmedName) || trimmedName.includes(n.trim()));
    if (!partial) {
      console.warn(`[DataLoader] 未找到 sheet: ${sheetName}`);
      return [];
    }
    return XLSX.utils.sheet_to_json(wb.Sheets[partial], { defval: '', raw: false });
  }
  return XLSX.utils.sheet_to_json(wb.Sheets[found], { defval: '', raw: false });
}

function loadOrders(filePath) {
  const raw = readSheet(filePath, '美国订单 汇总');
  if (!raw.length) {
    console.error('[DataLoader] 未找到"美国订单 汇总" sheet');
    return [];
  }
  const orders = raw.map((row, idx) => normalizeOrder(row, idx)).filter(Boolean);

  // 读取华南带电表（带电待审核订单，不参与排柜）
  const batteryRaw = readSheet(filePath, '华南带电');
  const batteryOrders = batteryRaw.map(row => ({
    orderNo: cleanStr(row['订单号']),
    status: cleanStr(row['订单状态']),
  })).filter(b => b.orderNo && b.orderNo.length > 10);

  const filtered = filterOrders(orders, batteryOrders);
  console.log(`[DataLoader] 订单总数: ${orders.length}, 带电待审核: ${batteryOrders.length}, 可排柜: ${filtered.length}`);
  return filtered;
}

function normalizeOrder(row, idx) {
  const order = {
    _idx: idx,
    orderNo: cleanStr(row['订单号']),
    extOrderNo: cleanStr(row['扩展单号']),
    customerOrderNo: cleanStr(row['客户订单号']),
    trackingNo: cleanStr(row['跟踪号']),
    status: cleanStr(row['订单状态']),
    paymentStatus: cleanStr(row['欠费状态']),
    customerCode: cleanStr(row['客户编码']),
    subCustomerCode: cleanStr(row['子客户编号']),
    salesProduct: cleanStr(row['销售产品']),
    serviceProduct: cleanStr(row['服务产品']),
    company: cleanStr(row['所属公司']),
    salesRep: cleanStr(row['业务']),
    customerService: cleanStr(row['客服']),
    fbaWarehouse: cleanStr(row['FBA仓库']),
    zipCode: cleanStr(row['收件人邮编']),
    shipmentId: cleanStr(row['Shipment Id']),
    referenceId: cleanStr(row['Reference Id']),
    pieces: parseFloat(row['件数']) || 0,
    actualWeight: parseFloat(row['实重']) || 0,
    cbm: parseFloat(row['方数']) || 0,
    deliveryType: '',
    actualWarehouse: cleanStr(row['实际所在仓库']),
    customsRequired: false,
    customsNo: '',
    productName: cleanStr(row['品名']),
    measurementDate: parseDate(row['测量时间']),
    remarks: cleanStr(row['备注']),
    isBattery: false,
    isEpoxy: false,
    isExpress: false,
    isPrivate: false,
    isSelfPickup: false,
    isStorage: false,
  };

  // 报关分析：区分真实报关号(US_26_xxx)和"是"/"否"布尔标记
  const rawCustoms = cleanStr(row['报关']);
  if (rawCustoms === '是' || rawCustoms === 'yes') {
    order.customsRequired = true;
    order.customsNo = '';
  } else if (rawCustoms === '否' || rawCustoms === 'no') {
    order.customsRequired = false;
    order.customsNo = '';
  } else if (rawCustoms && rawCustoms.length > 3) {
    order.customsRequired = true;
    order.customsNo = rawCustoms;
  }

  const channel = identifyChannel(order.salesProduct);
  order.channel = channel ? channel.channel : null;
  order.region = channel ? channel.region : null;
  order.pod = channel ? channel.pod : null;

  order.pol = identifyPOL(order.actualWarehouse);
  order.warehouseRegion = identifyRegion(order.actualWarehouse);
  if (!order.warehouseRegion && !order.actualWarehouse) {
    order.actualWarehouse = '华南中心仓';
    order.pol = ['YT', 'SHK'];
    order.warehouseRegion = 'south_china';
  }

  classifyDeliveryType(order);

  if (order.productName && /环氧/.test(order.productName)) {
    order.isEpoxy = true;
  }

  return order;
}

function cleanStr(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim().replace(/\s+/g, ' ');
}

function parseDate(val) {
  if (!val) return null;
  const num = parseFloat(val);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const dt = new Date((num - 25569) * 86400 * 1000);
    return dt.toISOString().split('T')[0];
  }
  const s = String(val).trim();
  if (/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(s)) {
    return s.split(' ')[0];
  }
  return null;
}

function identifyChannel(salesProduct) {
  if (!salesProduct) return null;
  for (const cp of CHANNEL_PATTERNS) {
    if (cp.pattern.test(salesProduct)) {
      return { channel: cp.channel, region: cp.region, pod: cp.pod };
    }
  }
  return null;
}

function classifyDeliveryType(order) {
  const product = (order.salesProduct + ' ' + order.serviceProduct).toLowerCase();
  if (/快递|express/.test(product)) {
    order.isExpress = true;
    order.deliveryType = 'express';
  } else if (/自提/.test(product)) {
    order.isSelfPickup = true;
    order.deliveryType = 'self_pickup';
  } else if (/仓储/.test(product)) {
    order.isStorage = true;
    order.deliveryType = 'storage';
  } else if (/私址|私人|商业地址/.test(product) || order.fbaWarehouse === '') {
    order.isPrivate = true;
    order.deliveryType = 'private';
  } else if (/卡派|海卡/.test(product)) {
    order.deliveryType = 'truck';
  } else {
    if (order.fbaWarehouse && order.fbaWarehouse.length > 2) {
      order.deliveryType = 'truck';
    } else {
      order.isPrivate = true;
      order.deliveryType = 'private';
    }
  }
  order.isNonTruck = order.isExpress || order.isSelfPickup || order.isStorage || order.isPrivate;
}

function filterOrders(orders, batteryOrders) {
  // 构建带电订单黑名单
  const batterySet = new Set();
  if (batteryOrders) {
    for (const bo of batteryOrders) {
      batterySet.add(bo.orderNo);
    }
  }

  return orders.filter(o => {
    // 仅排"已测量"订单，待发货/转运等不排
    if (!o.status || !o.status.includes('已测量')) return false;
    if (o.status.includes('取消') || o.status.includes('删除')) return false;
    if (o.status.includes('拦截') || o.status.includes('扣货')) return false;
    // 带电订单排除（已在华南带电表中登记）
    if (batterySet.has(o.orderNo)) {
      o.isBattery = true;
      return false;
    }
    if (o.paymentStatus && o.paymentStatus.includes('欠费') && !o.paymentStatus.includes('解锁')) return false;
    if (!o.channel) return false;
    if (o.cbm <= 0) return false;
    return true;
  });
}

// =========== 船期加载 ===========

function loadSchedules(filePath) {
  // 华南SO从748行开始（目前未放舱，0条有效）
  const south = loadSOSheet(filePath, '华南美国SO汇总', 'south_china', 748);
  // 华东SO从1519行开始
  const east = loadSOSheet(filePath, '华东美国SO汇总', 'east_china', 1519);
  const all = [...south, ...east];
  const valid = all.filter(s => {
    if (s.remarks && (s.remarks.includes('取消') || s.remarks.includes('已取消'))) return false;
    if (s.status === 'cancelled') return false;
    return true;
  });
  valid.sort((a, b) => (a.etd || '').localeCompare(b.etd || ''));
  console.log(`[DataLoader] 华南船期(>=748行): ${south.length}, 华东船期(>=1519行): ${east.length}`);
  return valid;
}

function loadSOSheet(filePath, sheetName, region, startRow) {
  const wb = XLSX.readFile(filePath);
  const found = wb.SheetNames.find(n => n.trim() === sheetName.trim());
  if (!found) return [];

  const ws = wb.Sheets[found];
  // 使用 header:1 保持精确行号对应（row N in Excel → index N-2 in data array）
  const allData = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  // startRow 是 Excel 行号（1-indexed），表头占第1行
  // 数据数组 index = Excel行号 - 2（减表头行 + 转0-indexed）
  const startIndex = Math.max(0, startRow - 2);
  const data = allData.slice(startIndex);
  console.log(`[DataLoader] ${sheetName}: 总${allData.length}行(含表头), 从Excel第${startRow}行起取${data.length}行`);
  return data.map((row, idx) => normalizeSchedule(row, idx, region)).filter(Boolean);
}

function normalizeSchedule(row, idx, region) {
  const schedule = {
    _idx: idx,
    region,
    seqNo: cleanStr(row['序号']),
    remarks: cleanStr(row['备注']),
    loadingLocation: cleanStr(row['装柜地点'] || row['装柜人员']),
    loadingDate: cleanStr(row['装柜日期']),
    trucker: cleanStr(row['拖车'] || row['拖车-报关行']),
    customsBroker: cleanStr(row['报关行']),
    pol: cleanStr(row['POL']),
    pod: cleanStr(row['POD']),
    systemNo: cleanStr(row['M系统编号']),
    soNo: cleanStr(row['SO订舱号']),
    route: cleanStr(row['航线'] || row['渠道']),
    containerType: cleanStr(row['柜型']),
    containerNo: cleanStr(row['柜号']),
    sealNo: cleanStr(row['封号']),
    siCutoffText: cleanStr(row['截单时间']),
    customsCutoffText: cleanStr(row['截关时间']),
    etd: parseDate(row['ETD']),
    eta: parseDate(row['ETA']),
    vessel: cleanStr(row['船名']),
    loadingPieces: parseInt(row['装箱件数']) || 0,
    weight: parseFloat(row['重量']) || 0,
    volume: parseFloat(row['体积']) || 0,
    isOA: false,
    containerTypeKey: '40HQ',
    podRegion: null,
  };

  const ct = cleanStr(row['柜型']);
  if (ct) {
    const s = ct.toUpperCase().replace(/\s/g, '');
    if (s.includes('45')) schedule.containerTypeKey = '45HQ';
    else if (s.includes('40')) schedule.containerTypeKey = '40HQ';
    else if (s.includes('20')) schedule.containerTypeKey = '20GP';
  }

  if (schedule.vessel) {
    schedule.isOA = OA_CARRIERS.some(c => schedule.vessel.toUpperCase().includes(c.toUpperCase()));
  }
  if (!schedule.isOA && schedule.route) {
    schedule.isOA = OA_CARRIERS.some(c => schedule.route.toUpperCase().includes(c.toUpperCase()));
  }

  const { POD_REGION_MAP } = require('./config');
  if (schedule.pod) {
    schedule.podRegion = POD_REGION_MAP[schedule.pod.toUpperCase()] || null;
  }

  return schedule;
}

// =========== 扫描价格表 ===========

function scanPriceFiles(priceDir) {
  const { PRICE_TABLE_REGISTRY } = require('./config');
  const files = [];
  for (const reg of PRICE_TABLE_REGISTRY) {
    const fullPath = path.join(priceDir, reg.file);
    if (fs.existsSync(fullPath)) {
      files.push({ ...reg, fullPath });
    }
  }
  return files;
}

module.exports = {
  loadAllData, loadOrders, loadSchedules, scanPriceFiles, readSheet,
  identifyChannel, normalizeOrder,
};
