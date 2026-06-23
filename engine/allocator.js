/**
 * 半自动配载系统 — 装柜分配器
 *
 * 职责：
 * - 贪心装箱算法：大货优先 → 同仓补满 → 小货填充
 * - 约束检查：容积/非卡派/环氧/仓位率
 * - 渠道补货：仓位不足时从其他渠道补货
 * - 结果输出：每柜分配的订单列表 + 统计信息
 */

const { CONTAINER_SPECS, CONSTRAINT_PARAMS, SUPPLEMENT_RULES } = require('./config');
const { validateContainer, computeStats, checkSupplementAllowed } = require('./constraint_engine');
const { buildP0Groups, sortByMeasurementDate } = require('./matcher');

// ============================================================
// 主入口
// ============================================================

/**
 * 执行装柜分配
 * @param {Object} matchResult - matcher 的输出
 * @param {Array} schedules - 船期列表
 * @returns {{
 *   containers: Array,        // 生成的柜列表
 *   unassigned: Array,        // 未分配货物
 *   transshipmentSuggestions: Array  // 转运建议
 * }}
 */
function allocateContainers(matchResult, schedules) {
  console.log('[Allocator] 开始分配装柜...');

  const allContainers = [];
  const allUnassigned = [];

  // 收集所有订单按区域重组（去重合并匹配组）
  const regionOrders = {}; // { LA: [...orders], NY: [...orders], ... }
  const regionSchedules = {}; // { LA: [...schedules], ... }

  for (const match of (matchResult.matched || [])) {
    const { orders, schedules: groupSchedules, podRegion } = match;
    if (!orders.length) continue;

    const key = podRegion || 'UNKNOWN';
    if (!regionOrders[key]) {
      regionOrders[key] = [];
      regionSchedules[key] = [];
    }
    regionOrders[key].push(...orders);
    regionSchedules[key].push(...groupSchedules);
  }

  // 全局计数器确保柜名唯一
  let globalCtIdx = 0;

  // 对每个区域
  for (const [region, orders] of Object.entries(regionOrders)) {
    // 去重订单（可能从多个匹配组重复出现）
    const uniqueOrders = deduplicateOrders(orders);
    const schedules = deduplicateSchedules(regionSchedules[region] || []);

    if (!uniqueOrders.length) continue;

    console.log(`[Allocator] ${region}: ${uniqueOrders.length} 单, ${schedules.length} 个可用船期`);

    // P0 报关锁组 + 排序
    const p0Groups = buildP0Groups(uniqueOrders);
    const sortedGroups = sortByMeasurementDate(p0Groups);

    // 计算总 CBM，预估所需柜数
    const totalCBM = sortedGroups.reduce((s, g) => s + g.totalCBM, 0);
    const maxCBM = 73; // 40HQ 默认
    const estimatedContainers = Math.ceil(totalCBM / (maxCBM * 0.85)); // 目标 85% 仓位
    const availableContainers = Math.max(schedules.length, estimatedContainers);

    console.log(`[Allocator] ${region}: 总 ${totalCBM.toFixed(2)} CBM, 预估 ${estimatedContainers} 柜, 可用 ${schedules.length} 船期`);

    // 贪心装柜：创建柜，填充到目标仓位
    let remaining = [...sortedGroups];
    const maxContainers = Math.min(availableContainers + 2, 50); // 上限

    for (let i = 0; i < maxContainers && remaining.length > 0; i++) {
      const schedule = schedules[i % Math.max(schedules.length, 1)] || createDefaultSchedule(region);
      globalCtIdx++;

      const container = {
        name: `CT${String(globalCtIdx).padStart(2, '0')}-${schedule.soNo || schedule.containerNo || 'PENDING'}`,
        containerType: schedule.containerTypeKey || '40HQ',
        maxCBM,
        pod: schedule.pod,
        podRegion: schedule.podRegion,
        pol: schedule.pol,
        scheduleSoNo: schedule.soNo,
        scheduleContainerNo: schedule.containerNo,
        scheduleSealNo: schedule.sealNo,
        scheduleVessel: schedule.vessel,
        scheduleETD: schedule.etd,
        scheduleETA: schedule.eta,
        scheduleRoute: schedule.route,
        orders: [],
        region,
        pallets: 0,
        cost: null,
      };

      // 贪心填充
      const result = greedyFill(container, remaining, region);
      remaining = result.remaining;

      if (result.filled.length === 0) break;

      // 统计与验证
      const stats = computeStats(container);
      const validation = validateContainer(container);

      // 渠道补货（仓位不足时）
      if (stats.fillRate < 0.80 && stats.fillRate > 0.30) {
        const suppResult = tryLowFillSupplement(container, remaining, region, stats);
        if (suppResult) {
          remaining = suppResult;
          const newStats = computeStats(container);
          console.log(`[Allocator] 柜 ${container.name} 补货后仓位: ${(newStats.fillRate*100).toFixed(1)}%`);
        }
      }

      const finalStats = computeStats(container);
      const finalValidation = validateContainer(container);

      allContainers.push({
        ...container,
        stats: finalStats,
        validation: finalValidation,
        schedule,
        region,
      });
    }

    // 未装货物
    for (const group of remaining) {
      for (const order of group.orders) {
        allUnassigned.push({
          ...order,
          unloadReason: `区域 ${region} 仓位不足（总${totalCBM.toFixed(1)} CBM，柜数不足）`,
        });
      }
    }
  }

  // 生成转运建议
  const transshipmentSuggestions = generateTransshipmentSuggestions(allUnassigned, matchResult);

  console.log(`[Allocator] 完成: ${allContainers.length} 个柜, ${allUnassigned.length} 单未装`);

  return {
    containers: allContainers,
    unassigned: allUnassigned,
    transshipmentSuggestions,
  };
}

// 去重辅助
function deduplicateOrders(orders) {
  const seen = new Set();
  return orders.filter(o => {
    const key = o.orderNo;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateSchedules(schedules) {
  const seen = new Set();
  const result = [];
  for (const s of schedules) {
    const key = s.soNo || s.containerNo || s._idx;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(s);
  }
  return result.sort((a, b) => (a.etd || '').localeCompare(b.etd || ''));
}

function createDefaultSchedule(region) {
  const podMap = { LA: 'LGB', NY: 'SAV', Chicago: 'CHI', Houston: 'HOU' };
  return {
    pod: podMap[region] || 'LGB',
    podRegion: region,
    containerTypeKey: '40HQ',
    soNo: 'AUTO-' + region,
    etd: new Date().toISOString().split('T')[0],
    vessel: 'TBD',
    route: 'AUTO',
    pol: region === 'NY' ? 'SHA' : 'YT',
  };
}

function tryLowFillSupplement(container, remainingGroups, region, stats) {
  const maxCBM = container.maxCBM;
  const currentCBM = stats.totalCBM;
  const gap = maxCBM - currentCBM; // 实际剩余空间

  if (gap <= 0 || gap > maxCBM * 0.3) return null; // 已经满了或不需要

  // 从 remaining 中精确填剩余空间
  const stillRemaining = [];
  let addedCBM = 0;
  for (const group of remainingGroups) {
    if (group.totalCBM <= gap - addedCBM) {
      container.orders.push(...group.orders);
      addedCBM += group.totalCBM;
    } else {
      stillRemaining.push(group);
    }
  }

  return stillRemaining.length < remainingGroups.length ? stillRemaining : null;
}

// ============================================================
// 创建容器
// ============================================================

function createContainer(schedule, idx, containerType, maxCBM) {
  const ctNo = String(idx + 1).padStart(2, '0');
  return {
    name: `CT${ctNo}-${schedule.soNo || schedule.containerNo || 'PENDING'}`,
    containerType,
    maxCBM,
    pod: schedule.pod,
    podRegion: schedule.podRegion,
    pol: schedule.pol,
    scheduleSoNo: schedule.soNo,
    scheduleContainerNo: schedule.containerNo,
    scheduleSealNo: schedule.sealNo,
    scheduleVessel: schedule.vessel,
    scheduleETD: schedule.etd,
    scheduleETA: schedule.eta,
    scheduleRoute: schedule.route,
    orders: [],
    pallets: 0,
    cost: null,
  };
}

// ============================================================
// 贪心装柜
// ============================================================

function greedyFill(container, groups, podRegion) {
  const filled = [];
  const remaining = [];
  const maxCBM = container.maxCBM;
  let currentCBM = 0;
  let nonTruckCBM = 0;

  // 分类
  const truckGroups = [];
  const nonTruckGroups = [];
  const fbaSmallGroups = [];

  for (const group of groups) {
    const hasFBA = group.orders.some(o => o.fbaWarehouse && !o.isNonTruck);
    const hasNonTruck = group.orders.some(o => o.isNonTruck);
    const isSmallFBA = hasFBA && group.totalCBM < CONSTRAINT_PARAMS.fbaMinCBMForCombined;

    if (isSmallFBA) {
      fbaSmallGroups.push(group);
    } else if (hasNonTruck && !hasFBA) {
      nonTruckGroups.push(group);
    } else {
      truckGroups.push(group);
    }
  }

  // 排序：大货优先
  truckGroups.sort((a, b) => b.totalCBM - a.totalCBM);
  nonTruckGroups.sort((a, b) => b.totalCBM - a.totalCBM);

  // 1. 大货阶段：FBA 卡派货
  for (const group of truckGroups) {
    if (group.totalCBM > maxCBM) {
      // 超大组，尝试拆分
      remaining.push(group);
      continue;
    }
    if (currentCBM + group.totalCBM <= maxCBM) {
      container.orders.push(...group.orders);
      currentCBM += group.totalCBM;
      filled.push(group);
    } else {
      remaining.push(group);
    }
  }

  // 2. 非卡派货（P4 限制 ≤ 20 CBM）
  const nonTruckLimit = CONSTRAINT_PARAMS.nonTruckMaxCBM;
  for (const group of nonTruckGroups) {
    if (nonTruckCBM + group.totalCBM <= nonTruckLimit &&
        currentCBM + group.totalCBM <= maxCBM) {
      container.orders.push(...group.orders);
      currentCBM += group.totalCBM;
      nonTruckCBM += group.totalCBM;
      filled.push(group);
    } else {
      remaining.push(group);
    }
  }

  // 3. 小货填缝
  for (const group of fbaSmallGroups) {
    if (currentCBM + group.totalCBM <= maxCBM) {
      container.orders.push(...group.orders);
      currentCBM += group.totalCBM;
      filled.push(group);
    } else {
      remaining.push(group);
    }
  }

  return { filled, remaining };
}

// ============================================================
// 渠道补货
// ============================================================

function trySupplement(container, unassignedGroups, targetRegion) {
  // 获取补货规则
  const rules = SUPPLEMENT_RULES[targetRegion];
  if (!rules || !rules.canSupplementFrom.length) return false;

  const currentCBM = container.orders.reduce((s, o) => s + o.cbm, 0);
  const maxCBM = container.maxCBM;
  const remainingSpace = maxCBM - currentCBM;

  if (remainingSpace <= 0) return false;

  let supplemented = false;

  // 从补货来源找货
  for (const sourceRegion of rules.canSupplementFrom) {
    // 在其他未分配的货中找符合补货条件的
    for (const group of unassignedGroups) {
      if (group.totalCBM > remainingSpace) continue;

      // 检查每单是否可补货
      let allAllowed = true;
      for (const order of group.orders) {
        const check = checkSupplementAllowed(targetRegion, sourceRegion, order);
        if (!check.allowed) {
          allAllowed = false;
          break;
        }
      }

      if (allAllowed) {
        container.orders.push(...group.orders);
        // 标记为已用
        group._supplemented = true;
        supplemented = true;
      }
    }
  }

  return supplemented;
}

// ============================================================
// 生成转运建议
// ============================================================

function generateTransshipmentSuggestions(unassigned, matchResult) {
  const suggestions = [];

  for (const order of unassigned) {
    const suggestion = {
      orderNo: order.orderNo,
      fbaWarehouse: order.fbaWarehouse,
      cbm: order.cbm,
      currentChannel: order.channel,
      currentRegion: order.region,
      reason: order.unloadReason || '未分配',
      alternatives: [],
    };

    // 查找可用补货渠道
    if (order.region && SUPPLEMENT_RULES[order.region]) {
      const rules = SUPPLEMENT_RULES[order.region];
      for (const alt of rules.canSupplementFrom) {
        suggestion.alternatives.push({
          channel: alt,
          note: `可尝试补货到 ${alt}`,
        });
      }
    }

    suggestions.push(suggestion);
  }

  return suggestions;
}

// ============================================================
// 批量分配总结
// ============================================================

function summarizeAllocation(result) {
  const { containers, unassigned, transshipmentSuggestions } = result;

  const summary = {
    totalContainers: containers.length,
    totalOrders: containers.reduce((s, c) => s + c.orders.length, 0),
    totalCBM: containers.reduce((s, c) => s + ((c.stats || {}).totalCBM || 0), 0),
    totalUnassigned: unassigned.length,
    unassignedCBM: unassigned.reduce((s, o) => s + (o.cbm || 0), 0),
    averageFillRate: containers.length
      ? containers.reduce((s, c) => s + ((c.stats || {}).fillRate || 0), 0) / containers.length
      : 0,
    containersByRegion: {},
    violations: [],
  };

  for (const ct of containers) {
    const region = ct.region || 'UNKNOWN';
    if (!summary.containersByRegion[region]) {
      summary.containersByRegion[region] = { count: 0, totalCBM: 0 };
    }
    summary.containersByRegion[region].count++;
    summary.containersByRegion[region].totalCBM += (ct.stats || {}).totalCBM || 0;

    // 收集违规
    if (ct.validation && ct.validation.violations.length) {
      summary.violations.push({
        container: ct.name,
        violations: ct.validation.violations,
      });
    }
  }

  return summary;
}

module.exports = {
  allocateContainers,
  createContainer,
  greedyFill,
  trySupplement,
  generateTransshipmentSuggestions,
  summarizeAllocation,
};
