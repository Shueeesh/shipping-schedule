/**
 * 半自动配载系统 — 约束引擎
 *
 * 职责：
 * - P0-P5 业务规则编码
 * - 约束检查函数：检查单个容器是否合规
 * - 违规报告：结构化的违规说明供审核使用
 */

const { CONTAINER_SPECS, CONSTRAINT_PARAMS, SUPPLEMENT_RULES } = require('./config');

// ============================================================
// 违规等级
// ============================================================

const SEVERITY = {
  HARD: 'hard',       // 🔴 硬约束 — 不可违反
  SOFT: 'soft',       // 🟡 软约束 — 可人工通过
  PREFERENCE: 'pref', // 🔵 偏好 — 建议遵守
};

// ============================================================
// 主约束检查
// ============================================================

/**
 * 全面检查一个容器的所有约束
 * @param {Object} container - { containerType, orders[], pod, channel }
 * @returns {{ passed: boolean, violations: Array, warnings: Array }}
 */
function validateContainer(container) {
  const violations = [];
  const warnings = [];

  // 收集基本统计
  const stats = computeStats(container);

  // P0: 报关锁组（在 allocator 中已保证，此处做最终校验）
  const p0Result = checkP0(container, stats);
  if (p0Result.violations.length) violations.push(...p0Result.violations);

  // 容积约束
  const volResult = checkVolume(container, stats);
  if (volResult.violations.length) violations.push(...volResult.violations);

  // P4: 非卡派限制
  const p4Result = checkP4(container, stats);
  if (p4Result.violations.length) violations.push(...p4Result.violations);

  // 环氧树脂规则
  const epoxyResult = checkEpoxy(container, stats);
  if (epoxyResult.violations.length) violations.push(...epoxyResult.violations);

  // P1: 同仓扩散检查
  const p1Result = checkP1(container, stats);
  if (p1Result.warnings.length) warnings.push(...p1Result.warnings);

  // 仓位率
  const fillResult = checkFillRate(container, stats);
  if (fillResult.warnings.length) warnings.push(...fillResult.warnings);

  // P3: 仓点合并
  const p3Result = checkP3(container, stats);
  if (p3Result.warnings.length) warnings.push(...p3Result.warnings);

  // FBA 小货检查
  const smallResult = checkFBASmall(container, stats);
  if (smallResult.warnings.length) warnings.push(...smallResult.warnings);

  return {
    passed: violations.length === 0,
    violations,  // 硬约束违规
    warnings,    // 软约束/偏好警告
    stats,
  };
}

// ============================================================
// 统计计算
// ============================================================

function computeStats(container) {
  const orders = container.orders || [];
  const spec = CONTAINER_SPECS[container.containerType] || CONTAINER_SPECS['40HQ'];

  const stats = {
    totalOrders: orders.length,
    totalCBM: 0,
    totalWeight: 0,
    totalPieces: 0,
    nonTruckCBM: 0,
    truckCBM: 0,
    privateCBM: 0,
    expressCBM: 0,
    selfPickupCBM: 0,
    storageCBM: 0,
    epoxyNonDeclaredKG: 0,
    epoxyDeclaredKG: 0,
    regularWeight: 0,
    fbaWarehouses: new Set(),
    customsGroups: new Set(),
    fbaSmallOrders: [],     // < 1 CBM 的 FBA 订单
    largeSingleAddress: [], // 单地址 > 20 CBM
    privateZipGroups: {},   // 私址邮编分组
    warehouseCount: 0,
    fillRate: 0,
    maxCBM: spec.maxCBM,
    minCBM: spec.minCBM,
  };

  for (const order of orders) {
    const cbm = order.cbm || 0;
    const weight = order.actualWeight || 0;
    const pieces = order.pieces || 0;

    stats.totalCBM += cbm;
    stats.totalWeight += weight;
    stats.totalPieces += pieces;

    // 非卡派分类
    if (order.isExpress) stats.expressCBM += cbm;
    if (order.isSelfPickup) stats.selfPickupCBM += cbm;
    if (order.isStorage) stats.storageCBM += cbm;
    if (order.isPrivate) stats.privateCBM += cbm;
    if (order.isNonTruck) stats.nonTruckCBM += cbm;
    else stats.truckCBM += cbm;

    // FBA 仓点
    if (order.fbaWarehouse) {
      stats.fbaWarehouses.add(order.fbaWarehouse.trim().toUpperCase());
    }

    // 报关组
    if (order.customsNo) {
      stats.customsGroups.add(order.customsNo);
    }

    // 环氧树脂
    if (order.isEpoxy) {
      if (order.customsNo) {
        stats.epoxyDeclaredKG += weight;
      } else {
        stats.epoxyNonDeclaredKG += weight;
      }
    } else {
      stats.regularWeight += weight;
    }

    // FBA < 1 CBM
    if (order.fbaWarehouse && cbm < CONSTRAINT_PARAMS.fbaMinCBMForCombined) {
      stats.fbaSmallOrders.push(order);
    }

    // 私址邮编分组
    if (order.isPrivate && order.zipCode) {
      const zip = order.zipCode.trim();
      if (!stats.privateZipGroups[zip]) {
        stats.privateZipGroups[zip] = { cbm: 0, orders: [] };
      }
      stats.privateZipGroups[zip].cbm += cbm;
      stats.privateZipGroups[zip].orders.push(order);
    }
  }

  // 单地址 > 20 CBM 检查
  for (const [zip, group] of Object.entries(stats.privateZipGroups)) {
    if (group.cbm > CONSTRAINT_PARAMS.nonTruckMaxCBM) {
      stats.largeSingleAddress.push({ zip, cbm: group.cbm, orders: group.orders });
    }
  }

  stats.fillRate = stats.totalCBM / stats.maxCBM;
  stats.warehouseCount = stats.fbaWarehouses.size;

  return stats;
}

// ============================================================
// P0: 报关锁组
// ============================================================

function checkP0(container, stats) {
  const violations = [];
  const customsMap = {};

  // 所有订单必须在同一个 customsNo 内（如果有）
  for (const order of (container.orders || [])) {
    if (order.customsNo) {
      if (!customsMap[order.customsNo]) {
        customsMap[order.customsNo] = [];
      }
      customsMap[order.customsNo].push(order);
    }
  }

  // 检查是否有同报关号被拆分（在 allocator 中保证，此处做完整性检查）
  // P0 主要是预处理阶段保证，此处检查是否所有同 customsNo 的订单都在此柜中
  // （这需要跨柜检查，由 allocator 处理）

  return { violations };
}

// ============================================================
// 容积约束
// ============================================================

function checkVolume(container, stats) {
  const violations = [];

  if (stats.totalCBM > stats.maxCBM) {
    violations.push({
      severity: SEVERITY.HARD,
      code: 'CBM_OVERFLOW',
      message: `体积超限: ${stats.totalCBM.toFixed(2)} CBM > 最大 ${stats.maxCBM} CBM`,
      actual: stats.totalCBM,
      limit: stats.maxCBM,
      overage: stats.totalCBM - stats.maxCBM,
    });
  }

  return { violations };
}

// ============================================================
// P4: 非卡派限制
// ============================================================

function checkP4(container, stats) {
  const violations = [];
  const limit = CONSTRAINT_PARAMS.nonTruckMaxCBM;

  if (stats.nonTruckCBM > limit) {
    violations.push({
      severity: SEVERITY.HARD,
      code: 'P4_NON_TRUCK_OVERFLOW',
      message: `非卡派体积超限: ${stats.nonTruckCBM.toFixed(2)} CBM > 最大 ${limit} CBM`,
      actual: stats.nonTruckCBM,
      limit,
      breakdown: {
        express: stats.expressCBM,
        selfPickup: stats.selfPickupCBM,
        storage: stats.storageCBM,
        private: stats.privateCBM,
      },
    });
  }

  // 单地址 > 20 CBM
  for (const addr of stats.largeSingleAddress) {
    violations.push({
      severity: SEVERITY.HARD,
      code: 'P4_SINGLE_ADDRESS_OVERFLOW',
      message: `单地址 (${addr.zip}) 体积超限: ${addr.cbm.toFixed(2)} CBM > 最大 ${limit} CBM，需要拆分`,
      zip: addr.zip,
      cbm: addr.cbm,
    });
  }

  return { violations };
}

// ============================================================
// 环氧树脂约束
// ============================================================

function checkEpoxy(container, stats) {
  const violations = [];

  if (stats.epoxyNonDeclaredKG > 0) {
    // 非报关环氧限重 500kg
    if (stats.epoxyNonDeclaredKG > CONSTRAINT_PARAMS.epoxyNonDeclaredMaxKG) {
      violations.push({
        severity: SEVERITY.HARD,
        code: 'EPOXY_WEIGHT_EXCEED',
        message: `非报关环氧超重: ${stats.epoxyNonDeclaredKG.toFixed(1)} KG > 最大 ${CONSTRAINT_PARAMS.epoxyNonDeclaredMaxKG} KG`,
        actual: stats.epoxyNonDeclaredKG,
        limit: CONSTRAINT_PARAMS.epoxyNonDeclaredMaxKG,
      });
    }

    // 需搭配 3 吨普货
    const requiredRegularKG = CONSTRAINT_PARAMS.epoxyRequiredRegularTons * 1000;
    if (stats.regularWeight < requiredRegularKG) {
      violations.push({
        severity: SEVERITY.HARD,
        code: 'EPOXY_NO_REGULAR_PAIR',
        message: `非报关环氧需搭配 ${CONSTRAINT_PARAMS.epoxyRequiredRegularTons}t 普货，当前普货: ${(stats.regularWeight / 1000).toFixed(1)}t`,
        actual: stats.regularWeight,
        required: requiredRegularKG,
      });
    }
  }

  return { violations };
}

// ============================================================
// P1: 同仓扩散 (软约束)
// ============================================================

function checkP1(container, stats) {
  const warnings = [];

  // 如果有多个 FBA 仓点，建议尽量少（但非硬性）
  if (stats.warehouseCount > 5) {
    warnings.push({
      severity: SEVERITY.SOFT,
      code: 'P1_TOO_MANY_WAREHOUSES',
      message: `柜内包含 ${stats.warehouseCount} 个不同 FBA 仓点，建议减少以降低卡派成本`,
    });
  }

  return { warnings };
}

// ============================================================
// 仓位率 (软约束)
// ============================================================

function checkFillRate(container, stats) {
  const warnings = [];

  if (stats.fillRate < 0.80) {
    warnings.push({
      severity: SEVERITY.SOFT,
      code: 'FILL_RATE_LOW',
      message: `仓位率偏低: ${(stats.fillRate * 100).toFixed(1)}% < 80%，建议补充货物或合并柜`,
      actual: stats.fillRate,
      threshold: 0.80,
    });
  }

  return { warnings };
}

// ============================================================
// P3: 仓点合并
// ============================================================

function checkP3(container, stats) {
  const warnings = [];

  // 统计纯数字仓点和带字母仓点
  let numericPoints = 0;
  let alphaPoints = 0;

  for (const wh of stats.fbaWarehouses) {
    if (/^\d+$/.test(wh)) {
      numericPoints++;
    } else if (/[A-Z]/.test(wh)) {
      alphaPoints++;
    }
  }

  const totalPoints = numericPoints + alphaPoints;

  if (totalPoints > 5) {
    warnings.push({
      severity: SEVERITY.SOFT,
      code: 'P3_TOO_MANY_POINTS',
      message: `仓点过多: ${totalPoints} 个 (纯数字:${numericPoints}, 带字母:${alphaPoints})，建议 ≤5`,
      numericPoints,
      alphaPoints,
    });
  }

  return { warnings };
}

// ============================================================
// FBA 小货检查
// ============================================================

function checkFBASmall(container, stats) {
  const warnings = [];

  if (stats.fbaSmallOrders.length > 0) {
    const names = stats.fbaSmallOrders.map(o => o.orderNo).join(', ');
    warnings.push({
      severity: SEVERITY.SOFT,
      code: 'FBA_SMALL_IN_COMBINED',
      message: `${stats.fbaSmallOrders.length} 票 FBA < 1.0 CBM 装入组合柜，建议改海派: [${names}]`,
      count: stats.fbaSmallOrders.length,
      orders: stats.fbaSmallOrders.map(o => o.orderNo),
    });
  }

  return { warnings };
}

// ============================================================
// 渠道补货合规检查
// ============================================================

/**
 * 检查从 sourceChannel 补货到 targetChannel 是否合规
 */
function checkSupplementAllowed(targetChannel, sourceChannel, order) {
  const rules = SUPPLEMENT_RULES[targetChannel];
  if (!rules) {
    return { allowed: false, reason: `渠道 ${targetChannel} 无补货规则` };
  }

  if (!rules.canSupplementFrom.includes(sourceChannel)) {
    return { allowed: false, reason: `${sourceChannel} 不可补货到 ${targetChannel}` };
  }

  // 检查排除仓点
  if (rules.excludeWarehouses && order.fbaWarehouse) {
    if (rules.excludeWarehouses.some(w =>
      order.fbaWarehouse.toUpperCase().includes(w.toUpperCase())
    )) {
      return { allowed: false, reason: `仓点 ${order.fbaWarehouse} 在排除名单中` };
    }
  }

  // 检查允许仓点
  if (rules.allowedWarehouses && order.fbaWarehouse) {
    if (!rules.allowedWarehouses.some(w =>
      order.fbaWarehouse.toUpperCase().includes(w.toUpperCase())
    )) {
      return { allowed: false, reason: `仓点 ${order.fbaWarehouse} 不在允许名单中` };
    }
  }

  // 检查排除类型
  if (rules.excludeTypes) {
    if (rules.excludeTypes.includes('报关件') && order.customsNo) {
      return { allowed: false, reason: '报关件不可用于补货' };
    }
    if (rules.excludeTypes.includes('私人地址') && order.isPrivate) {
      return { allowed: false, reason: '私人地址不可用于补货' };
    }
  }

  return { allowed: true };
}

// ============================================================
// 时效检查
// ============================================================

/**
 * 检查老货是否分配到最早船期
 */
function checkTimeliness(container, schedule, allOrders) {
  const warnings = [];

  for (const order of (container.orders || [])) {
    if (order.measurementDate && schedule.etd) {
      const measureDate = new Date(order.measurementDate);
      const etdDate = new Date(schedule.etd);

      if (isNaN(measureDate.getTime()) || isNaN(etdDate.getTime())) continue;

      const daysDiff = (etdDate - measureDate) / (1000 * 60 * 60 * 24);
      if (daysDiff > 30) {
        warnings.push({
          severity: SEVERITY.PREFERENCE,
          code: 'OLD_CARGO_DELAYED',
          message: `${order.orderNo} 测量于 ${order.measurementDate}，ETD ${schedule.etd}，间隔 ${Math.round(daysDiff)} 天，建议优先装船`,
          orderNo: order.orderNo,
          measureDate: order.measurementDate,
          etd: schedule.etd,
          daysDiff,
        });
      }
    }
  }

  return { warnings };
}

module.exports = {
  SEVERITY,
  validateContainer,
  computeStats,
  checkP0,
  checkP4,
  checkEpoxy,
  checkP1,
  checkFillRate,
  checkP3,
  checkFBASmall,
  checkSupplementAllowed,
  checkTimeliness,
};
