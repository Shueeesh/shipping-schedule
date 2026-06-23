/**
 * 半自动配载系统 — 订单/船期匹配器
 *
 * 职责：
 * 1. 按 POL 匹配：华南订单 → 华南船期，华东订单 → 华东船期
 * 2. 按 POD 匹配：洛杉矶渠道订单 → LGB/LAX 目的地船期
 * 3. P0 报关锁组：同报关号订单打包为原子组
 * 4. P1 同仓扩散：同 FBA 仓点订单归组
 * 5. 按测量时间排序（老货优先）
 * 6. 异常订单隔离（带电/拦截/转运）
 */

const { CHANNEL_PRIORITY, POD_REGION_MAP, ABNORMAL_ORDER_TYPES } = require('./config');

// ============================================================
// 主入口：匹配订单到船期
// ============================================================

/**
 * @param {Array} orders - 标准化订单列表
 * @param {Array} schedules - 船期列表
 * @returns {{
 *   matched: Array<{schedule, p0Groups: Array, p1Groups: Array}>,
 *   unloaded: Array,
 *   battery: Array,
 *   held: Array,
 *   transfer: Array
 * }}
 */
function matchOrdersToSchedules(orders, schedules) {
  console.log('[Matcher] 开始匹配订单到船期...');

  // 0. 异常订单隔离
  const { normal, battery, held, transfer } = isolateAbnormalOrders(orders);
  console.log(`[Matcher] 正常:${normal.length}, 带电:${battery.length}, 拦截:${held.length}, 转运:${transfer.length}`);

  // 1. 按仓库区域分：华南 / 华东
  const southOrders = normal.filter(o => o.warehouseRegion === 'south_china');
  const eastOrders = normal.filter(o => o.warehouseRegion === 'east_china');
  const unknownOrders = normal.filter(o => !o.warehouseRegion);

  console.log(`[Matcher] 华南仓:${southOrders.length}, 华东仓:${eastOrders.length}, 未知:${unknownOrders.length}`);

  // 2. 按船期区域分
  const southSchedules = schedules.filter(s => s.region === 'south_china');
  const eastSchedules = schedules.filter(s => s.region === 'east_china');

  // 3. 华南订单 → 华南船期，华东订单 → 华东船期
  const southMatches = matchByPOD(southOrders, southSchedules);
  const eastMatches = matchByPOD(eastOrders, eastSchedules);

  // 4. 未知仓库的订单按渠道直接匹配
  const otherMatches = matchByChannel(unknownOrders, schedules);

  const allMatches = [...southMatches, ...eastMatches, ...otherMatches];

  // 5. 检查是否有船期无货
  const unloaded = findUnloaded(orders, allMatches);

  return {
    matched: allMatches,
    unloaded,
    battery,
    held,
    transfer,
    stats: {
      totalOrders: orders.length,
      normal: normal.length,
      south: southOrders.length,
      east: eastOrders.length,
      matchedOrders: allMatches.reduce((sum, m) => sum + m.orders.length, 0),
      unloaded: unloaded.length,
    },
  };
}

// ============================================================
// 异常订单隔离
// ============================================================

function isolateAbnormalOrders(orders) {
  const normal = [];
  const battery = [];
  const held = [];
  const transfer = [];

  for (const order of orders) {
    const status = order.status || '';
    const remarks = order.remarks || '';
    const product = order.productName || '';

    // 带电订单
    if (product.includes('电池') || product.includes('带电') || product.includes('锂电') ||
        status.includes('带电') || remarks.includes('带电')) {
      order.abnormalType = ABNORMAL_ORDER_TYPES.BATTERY;
      battery.push(order);
      continue;
    }

    // 拦截扣货
    if (status.includes('拦截') || status.includes('扣货') ||
        remarks.includes('拦截') || remarks.includes('扣货')) {
      order.abnormalType = ABNORMAL_ORDER_TYPES.HELD;
      held.push(order);
      continue;
    }

    // 转运
    if (status.includes('转运') || remarks.includes('转运')) {
      order.abnormalType = ABNORMAL_ORDER_TYPES.TRANSFER;
      transfer.push(order);
      continue;
    }

    normal.push(order);
  }

  return { normal, battery, held, transfer };
}

// ============================================================
// 按 POD 匹配
// ============================================================

function matchByPOD(orders, schedules) {
  if (!orders.length || !schedules.length) return [];

  const results = [];

  // 按 POD 区域分组船期
  const schedulesByPOD = {};
  for (const s of schedules) {
    const podRegion = s.podRegion || 'UNKNOWN';
    if (!schedulesByPOD[podRegion]) schedulesByPOD[podRegion] = [];
    schedulesByPOD[podRegion].push(s);
  }

  // 按渠道分组订单
  const ordersByRegion = {};
  for (const o of orders) {
    const region = o.region || 'UNKNOWN';
    if (!ordersByRegion[region]) ordersByRegion[region] = [];
    ordersByRegion[region].push(o);
  }

  // 对每个区域的订单匹配对应 POD 的船期
  for (const [region, regionOrders] of Object.entries(ordersByRegion)) {
    const podSchedules = schedulesByPOD[region] || [];
    if (!podSchedules.length) {
      // 尝试跨区域匹配
      for (const [podRegion, scheds] of Object.entries(schedulesByPOD)) {
        if (scheds.length > 0) {
          console.warn(`[Matcher] 区域 ${region} 无船期，尝试使用 ${podRegion} 船期`);
          results.push({
            region,
            podRegion,
            orders: regionOrders,
            schedules: scheds,
            crossRegion: true,
          });
          break;
        }
      }
      continue;
    }

    results.push({
      region,
      podRegion: region,
      orders: regionOrders,
      schedules: podSchedules,
      crossRegion: false,
    });
  }

  return results;
}

// ============================================================
// 按渠道直接匹配（用于未知仓库区域订单）
// ============================================================

function matchByChannel(orders, schedules) {
  if (!orders.length || !schedules.length) return [];

  // 按渠道分组
  const ordersByChannel = {};
  for (const o of orders) {
    const ch = o.channel || 'UNKNOWN';
    if (!ordersByChannel[ch]) ordersByChannel[ch] = [];
    ordersByChannel[ch].push(o);
  }

  // 按渠道优先级排序
  const sortedChannels = Object.keys(ordersByChannel).sort(
    (a, b) => (CHANNEL_PRIORITY[a] || 99) - (CHANNEL_PRIORITY[b] || 99)
  );

  const results = [];
  for (const channel of sortedChannels) {
    // 尝试匹配对应 POD 的船期
    const channelOrders = ordersByChannel[channel];
    const pod = channelOrders[0]?.pod?.[0]; // 取第一个 POD

    const matchingSchedules = schedules.filter(s =>
      s.pod && pod && s.pod.toUpperCase() === pod.toUpperCase()
    );

    results.push({
      region: channelOrders[0]?.region || 'UNKNOWN',
      podRegion: channelOrders[0]?.region || 'UNKNOWN',
      orders: channelOrders,
      schedules: matchingSchedules.length ? matchingSchedules : schedules,
      crossRegion: matchingSchedules.length === 0,
    });
  }

  return results;
}

// ============================================================
// 查找未匹配订单
// ============================================================

function findUnloaded(allOrders, matches) {
  const matchedOrderNos = new Set();
  for (const m of matches) {
    for (const o of (m.orders || [])) {
      matchedOrderNos.add(o.orderNo);
    }
  }

  return allOrders.filter(o => !matchedOrderNos.has(o.orderNo));
}

// ============================================================
// P0 报关锁组
// ============================================================

function buildP0Groups(orders) {
  const groups = [];
  const customsMap = {};
  const noCustoms = [];

  for (const order of orders) {
    if (order.customsNo) {
      if (!customsMap[order.customsNo]) {
        customsMap[order.customsNo] = [];
      }
      customsMap[order.customsNo].push(order);
    } else {
      noCustoms.push(order);
    }
  }

  // 有报关号的打包为不可拆组
  for (const [customsNo, groupOrders] of Object.entries(customsMap)) {
    const totalCBM = groupOrders.reduce((s, o) => s + o.cbm, 0);
    const totalWeight = groupOrders.reduce((s, o) => s + o.actualWeight, 0);
    groups.push({
      type: 'P0',
      id: `P0-${customsNo}`,
      customsNo,
      orders: groupOrders,
      totalCBM,
      totalWeight,
      atom: true, // 不可拆分
      warehouses: [...new Set(groupOrders.map(o => o.fbaWarehouse).filter(Boolean))],
    });
  }

  // 无报关号的各自独立
  for (const order of noCustoms) {
    groups.push({
      type: 'SINGLE',
      id: `SINGLE-${order.orderNo}`,
      customsNo: null,
      orders: [order],
      totalCBM: order.cbm,
      totalWeight: order.actualWeight,
      atom: true,
      warehouses: [order.fbaWarehouse].filter(Boolean),
    });
  }

  // 按 CBM 降序排列（大货优先）
  groups.sort((a, b) => b.totalCBM - a.totalCBM);

  return groups;
}

// ============================================================
// P1 同仓扩散
// ============================================================

function buildP1Groups(p0Groups) {
  // 对每个 P0 组，如果同仓则合并到同一个 P1 组
  // 实际上 P1 是在 P0 基础上按仓加速装柜，不强制合并
  return p0Groups; // P1 逻辑在 allocator 中实现
}

// ============================================================
// 按测量时间排序
// ============================================================

function sortByMeasurementDate(groups) {
  return groups.sort((a, b) => {
    const aDate = getEarliestMeasureDate(a.orders);
    const bDate = getEarliestMeasureDate(b.orders);

    if (!aDate && !bDate) return b.totalCBM - a.totalCBM; // 都没日期，大货优先
    if (!aDate) return 1;
    if (!bDate) return -1;
    return aDate.localeCompare(bDate); // 早的先装
  });
}

function getEarliestMeasureDate(orders) {
  let earliest = null;
  for (const o of orders) {
    if (o.measurementDate && (!earliest || o.measurementDate < earliest)) {
      earliest = o.measurementDate;
    }
  }
  return earliest;
}

module.exports = {
  matchOrdersToSchedules,
  isolateAbnormalOrders,
  matchByPOD,
  matchByChannel,
  findUnloaded,
  buildP0Groups,
  buildP1Groups,
  sortByMeasurementDate,
};
