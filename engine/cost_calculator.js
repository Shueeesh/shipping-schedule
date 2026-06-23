/**
 * 半自动配载系统 — 费用核算
 *
 * 职责：
 * - 按价格表计算每柜费用
 * - 费用结构：提拆打托 + 卡派 + 整柜直送 + 清关 + 仓储 + 杂费
 * - 支持混装柜按体积占比计价（P5）
 */

const { REGION_SUPPLIER, CONTAINER_SPECS } = require('./config');

// ============================================================
// 主入口
// ============================================================

/**
 * 计算所有容器的费用
 * @param {Array} containers - 容器列表（含 orders）
 * @param {Object} priceTables - parseAllPriceTables 的输出
 */
function calculateAllCosts(containers, priceTables) {
  console.log(`[CostCalc] 计算 ${containers.length} 个柜的费用...`);

  for (const container of containers) {
    container.cost = calculateContainerCost(container, priceTables);
  }

  return containers;
}

// ============================================================
// 单柜费用计算
// ============================================================

function calculateContainerCost(container, priceTables) {
  const region = container.region || container.podRegion;
  const supplier = getSupplierForRegion(region);
  const tableKey = `${region}_${supplier}`;
  const table = priceTables[tableKey];

  if (!table) {
    console.warn(`[CostCalc] 无价格表: ${tableKey}，使用默认值`);
    return estimateDefaultCost(container);
  }

  const orders = container.orders || [];
  const containerType = container.containerType || '40HQ';
  const totalCBM = orders.reduce((s, o) => s + (o.cbm || 0), 0);

  // 1. 提拆打托费
  const deconCost = getDeconsolidationCost(table, containerType, totalCBM);

  // 2. 卡派费用（区分组合柜/散板/FTL）
  const truckCost = getTruckDispatchCost(container, table, totalCBM);

  // 3. 整柜直送（如果整柜到单一FBA仓）
  const directCost = getDirectDeliveryCost(container, table);

  // 4. 清关费
  const customsGroups = new Set(orders.map(o => o.customsNo).filter(Boolean));
  const customsCost = (table.customs?.perBill || 90) * Math.max(customsGroups.size, 1);

  // 5. 仓储费（预估7天）
  const storageDays = 7;
  const storageCost = (table.storage?.perCBMperDay || 0.5) * totalCBM * storageDays;

  // 6. 杂费
  const miscCost = (table.misc?.chassisPerDay || 0) * 3; // 车架费3天

  const total = deconCost + truckCost + directCost + customsCost + storageCost + miscCost;

  return {
    deconsolidation: deconCost,
    truckDispatch: truckCost,
    directDelivery: directCost,
    customs: customsCost,
    storage: storageCost,
    misc: miscCost,
    total,
    perCBM: totalCBM > 0 ? total / totalCBM : 0,
    breakdown: {
      orderCount: orders.length,
      totalCBM,
      containerType,
      warehouseCount: new Set(orders.map(o => o.fbaWarehouse).filter(Boolean)).size,
    },
  };
}

// ============================================================
// 提拆打托费
// ============================================================

function getDeconsolidationCost(table, containerType, totalCBM) {
  const decon = table.deconsolidation || {};

  // 优先精确匹配柜型
  if (decon[containerType]) return decon[containerType];

  // 按服务等级
  if (decon[`${containerType}_T2`]) return decon[`${containerType}_T2`];
  if (decon[`${containerType}_T1`]) return decon[`${containerType}_T1`];

  // 默认
  return decon['40HQ'] || 1500;
}

// ============================================================
// 卡派费（P5 路线计价）
// ============================================================

function getTruckDispatchCost(container, table, totalCBM) {
  const orders = container.orders || [];
  const warehouses = {};
  let truckCBM = 0;

  // 按FBA仓点分组
  for (const order of orders) {
    if (order.isNonTruck) continue; // 非卡派不计卡派费
    const wh = (order.fbaWarehouse || 'UNKNOWN').trim().toUpperCase();
    if (!warehouses[wh]) {
      warehouses[wh] = { cbm: 0, orderCount: 0, pallets: Math.ceil((order.pieces || 1) / 50) };
    }
    warehouses[wh].cbm += order.cbm || 0;
    warehouses[wh].orderCount++;
    truckCBM += order.cbm || 0;
  }

  if (Object.keys(warehouses).length === 0) return 0;

  const whList = Object.keys(warehouses);

  // 情况 1：单一仓点 → 整柜直送价格（已在 getDirectDeliveryCost 处理）
  // 情况 2：多仓点 → 组合柜或散板

  // 尝试匹配组合柜价格
  if (whList.length >= 2 && table.combined) {
    // P5：混装柜按组合价 × 体积占比
    return calculateCombinedCost(container, table, warehouses, totalCBM);
  }

  // 散板价：按每托计算
  let ltlCost = 0;
  if (table.truckLTL) {
    for (const [wh, data] of Object.entries(warehouses)) {
      const rates = table.truckLTL[wh];
      if (rates) {
        ltlCost += (rates.perPallet || rates.perPallet1to3 || 45) * Math.max(data.pallets, 1);
      } else {
        // 无精确价格，按区域默认
        ltlCost += 45 * Math.max(data.pallets, 1);
      }
    }
  }

  return ltlCost;
}

// ============================================================
// P5 组合柜计价
// ============================================================

function calculateCombinedCost(container, table, warehouses, totalCBM) {
  const whList = Object.keys(warehouses);
  let bestMatch = null;
  let bestScore = 0;

  // 找最佳组合匹配
  for (const [key, combined] of Object.entries(table.combined)) {
    const combinedWHs = (combined.warehouses || []).map(w => w.trim().toUpperCase());
    const matchCount = whList.filter(w => combinedWHs.some(cw => w.includes(cw) || cw.includes(w))).length;
    const score = matchCount / Math.max(combinedWHs.length, whList.length);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = combined;
    }
  }

  if (bestMatch && bestScore > 0.5) {
    // 组合价 × (卡派CBM / 总CBM) — P5 规则
    return (bestMatch.hq40 || 2700) * (totalCBM / 73); // 按柜容 73 比例
  }

  // 没有匹配的组合，按散板计算
  return 0;
}

// ============================================================
// 整柜直送
// ============================================================

function getDirectDeliveryCost(container, table) {
  const orders = container.orders || [];
  const fbaOrders = orders.filter(o => o.fbaWarehouse && !o.isNonTruck);

  if (fbaOrders.length === 0) return 0;

  // 检查是否 > 80% 货物去同一个仓
  const whCBM = {};
  for (const o of fbaOrders) {
    const wh = o.fbaWarehouse.trim().toUpperCase();
    whCBM[wh] = (whCBM[wh] || 0) + (o.cbm || 0);
  }

  const totalFba = Object.values(whCBM).reduce((s, v) => s + v, 0);
  for (const [wh, cbm] of Object.entries(whCBM)) {
    if (cbm / totalFba > 0.80 && table.directDelivery) {
      const directPrice = table.directDelivery[wh];
      if (directPrice) return directPrice;
    }
  }

  return 0; // 不是整柜直送场景
}

// ============================================================
// 辅助
// ============================================================

function getSupplierForRegion(region) {
  const info = REGION_SUPPLIER[region];
  return info ? info.primary : 'yingcang';
}

function estimateDefaultCost(container) {
  const orders = container.orders || [];
  const totalCBM = orders.reduce((s, o) => s + (o.cbm || 0), 0);
  return {
    deconsolidation: 1500,
    truckDispatch: totalCBM * 40,
    directDelivery: 0,
    customs: 90,
    storage: totalCBM * 3.5,
    misc: 100,
    total: 1500 + totalCBM * 40 + 90 + totalCBM * 3.5 + 100,
    perCBM: totalCBM > 0 ? (1500 + totalCBM * 40 + 90 + totalCBM * 3.5 + 100) / totalCBM : 0,
    estimated: true,
    breakdown: { orderCount: orders.length, totalCBM, containerType: container.containerType },
  };
}

function generateCostSummary(containers) {
  const summary = {
    totalCost: 0,
    byCategory: { deconsolidation: 0, truckDispatch: 0, directDelivery: 0, customs: 0, storage: 0, misc: 0 },
    byRegion: {},
    containers: [],
  };

  for (const ct of containers) {
    const cost = ct.cost || {};
    summary.totalCost += cost.total || 0;
    summary.byCategory.deconsolidation += cost.deconsolidation || 0;
    summary.byCategory.truckDispatch += cost.truckDispatch || 0;
    summary.byCategory.directDelivery += cost.directDelivery || 0;
    summary.byCategory.customs += cost.customs || 0;
    summary.byCategory.storage += cost.storage || 0;
    summary.byCategory.misc += cost.misc || 0;

    const region = ct.region || 'UNKNOWN';
    if (!summary.byRegion[region]) {
      summary.byRegion[region] = { containerCount: 0, totalCost: 0 };
    }
    summary.byRegion[region].containerCount++;
    summary.byRegion[region].totalCost += cost.total || 0;

    summary.containers.push({
      name: ct.name,
      region: ct.region,
      cost: cost.total || 0,
      fillRate: (ct.stats || {}).fillRate || 0,
    });
  }

  return summary;
}

module.exports = {
  calculateAllCosts,
  calculateContainerCost,
  getDeconsolidationCost,
  getTruckDispatchCost,
  getDirectDeliveryCost,
  generateCostSummary,
  estimateDefaultCost,
};
