/**
 * 半自动配载系统 — 配置文件
 *
 * 定义：
 * - 渠道/区域/POD 映射
 * - 供应商与排柜方法
 * - 渠道补货规则
 * - 异常订单隔离规则
 * - 容器规格与约束参数
 * - 价格表文件注册表
 */

// ============================================================
// 一、渠道 → 区域 → POD 映射
// ============================================================

/**
 * 从订单"销售产品"字段识别渠道
 * 匹配优先级：越具体越靠前
 */
const CHANNEL_PATTERNS = [
  // 洛杉矶
  { pattern: /洛杉矶特惠/i, channel: 'LA_TEHY', region: 'LA', pod: ['LGB', 'LAX', 'LALB'] },
  { pattern: /洛杉矶卡派|洛杉矶海卡|洛杉矶海派|洛杉矶代发|LALB/i, channel: 'LA_CARD', region: 'LA', pod: ['LGB', 'LAX', 'LALB'] },

  // 以星CLX
  { pattern: /CLX\+/i, channel: 'CLX_PLUS', region: 'CLX', pod: ['LGB', 'LAX'] },
  { pattern: /CLX-/i, channel: 'CLX_MINUS', region: 'CLX', pod: ['LGB', 'LAX'] },

  // 纽约/美东/萨凡纳
  { pattern: /纽约.*DG|NY.*DG/i, channel: 'NY_DG', region: 'NY', pod: ['NYC', 'SAV'] },
  { pattern: /美东快线|纽约快线/i, channel: 'NY_EXPRESS', region: 'NY', pod: ['NYC', 'SAV'] },
  { pattern: /萨凡纳卡派|萨凡纳海卡|SAV/i, channel: 'NY_CARD', region: 'NY', pod: ['SAV'] },
  { pattern: /纽约卡派|纽约海卡|NY/i, channel: 'NY_CARD', region: 'NY', pod: ['NYC', 'SAV'] },

  // 半月提/半月签 (美东服务)
  { pattern: /半月提C|半月提B|半月签C|半月签B/i, channel: 'NY_CARD', region: 'NY', pod: ['NYC', 'SAV'] },

  // 芝加哥
  { pattern: /芝加哥卡派|芝加哥海卡|芝加哥海派|CHI/i, channel: 'CHI_CARD', region: 'Chicago', pod: ['CHI'] },

  // 休斯顿
  { pattern: /休斯顿卡派|休斯顿海卡|TX/i, channel: 'TX_CARD', region: 'Houston', pod: ['HOU'] },

  // 其他
  { pattern: /DG/i, channel: 'DG', region: 'Other', pod: ['LGB', 'LAX'] },
  { pattern: /GA/i, channel: 'GA', region: 'Other', pod: ['SAV'] },
  { pattern: /OAK/i, channel: 'OAK', region: 'Other', pod: ['OAK'] },
];

/**
 * 渠道排序优先级（数字越小越优先装柜）
 */
const CHANNEL_PRIORITY = {
  'LA_CARD': 1,
  'LA_TEHY': 1,    // 与洛杉矶同优先级
  'CLX_MINUS': 2,
  'CLX_PLUS': 3,
  'NY_CARD': 4,
  'NY_EXPRESS': 4,
  'NY_DG': 5,
  'CHI_CARD': 6,
  'TX_CARD': 7,
  'DG': 8,
  'GA': 9,
  'OAK': 10,
};

// ============================================================
// 二、POD ↔ 区域 ↔ 供应商 ↔ 排柜方法
// ============================================================

const POD_REGION_MAP = {
  'LGB': 'LA', 'LAX': 'LA', 'LALB': 'LA',
  'NYC': 'NY', 'SAV': 'NY',
  'CHI': 'Chicago',
  'HOU': 'Houston',
  'OAK': 'Other',
};

const REGION_SUPPLIER = {
  'LA': {
    primary: 'yingcang',    // 盈仓/港速通
    method: 'yingcang_lax', // 排柜方法
    priceFile: '6月_LA盈仓转运业务报价_VIP满天星.xlsx',
  },
  'NY': {
    primary: 'yingcang',
    method: 'yingcang_nj',
    priceFile: '6月_ LINK TRANS LOGISTICS NJ INC 美东盈仓NJ+SAV 海外仓转运业务报价 满天星.xlsx',
  },
  'Chicago': {
    primary: 'yicifang',
    method: 'yicifang_chi',
    priceFile: '满天星-芝加哥报价怡.xlsx',
  },
  'Houston': {
    primary: 'yicifang',
    method: 'yicifang_hou',
    priceFile: '满天星休斯顿报价以此份为准【5-16之后】(1).xlsx',
  },
};

/** 美东备选供应商 */
const SECONDARY_SUPPLIER = {
  region: 'NY',
  primary: 'UGD',
  method: 'ugd_nj',
  priceFile: 'UGD美国海外仓提拆派报价（20260608生效，6.8后预报柜执行新价）.xlsx',
};

// ============================================================
// 三、渠道补货规则
// ============================================================

const SUPPLEMENT_RULES = {
  'LA': {
    canSupplementFrom: ['Chicago'],
    excludeWarehouses: ['MDW6', 'RFD4'],
    excludeTypes: ['私人地址'],
    note: '洛杉矶特惠渠道与洛杉矶同优先级',
  },
  'Chicago': {
    canSupplementFrom: ['NY'],
    allowedWarehouses: ['FWA4', 'IND9'],
    note: '仅限FWA4和IND9仓点',
  },
  'CLX': {
    canSupplementFrom: ['LA', 'CLX+'],
    excludeTypes: ['报关件', '私人地址'],
    note: '本渠道优先，CLX+补货需排除报关件和私人地址',
  },
};

// ============================================================
// 四、仓库 → POL 匹配
// ============================================================

const WAREHOUSE_POL_MAP = {
  // 华南仓库 → 盐田/蛇口
  '华南中心仓': ['YT', 'SHK'],
  '凤岗': ['YT', 'SHK'],
  '凤岗西': ['YT', 'SHK'],
  '凤岗仓库': ['YT', 'SHK'],
  '深圳仓': ['YT', 'SHK'],
  '广州仓': ['YT', 'SHK'],

  // 华东仓库 → 宁波/上海
  '华东义乌仓': ['NGB', 'SHA'],
  '义乌': ['NGB', 'SHA'],
  '上海仓': ['SHA'],
  '上海装柜': ['SHA'],
  '宁波仓': ['NGB'],
};

// ============================================================
// 五、容器规格与约束参数
// ============================================================

const CONTAINER_SPECS = {
  '40HQ': { maxCBM: 73, minFillRate: 0.80, minCBM: 58.4 },
  '45HQ': { maxCBM: 85, minFillRate: 0.80, minCBM: 68 },
  '40GP': { maxCBM: 67, minFillRate: 0.80, minCBM: 53.6 },
};

const CONSTRAINT_PARAMS = {
  nonTruckMaxCBM: 20,           // P4：非卡派每柜最大 CBM
  fbaMinCBMForCombined: 1.0,   // FBA < 1.0 CBM 不装组合柜
  epoxyNonDeclaredMaxKG: 500,  // 非报关环氧树脂限重
  epoxyRequiredRegularTons: 3, // 环氧需搭配普货吨数
  maxPrivateAddressPerContainer: 73, // 私址上限（与柜容同）
  expressCostThreshold: 50,    // P2：快递费 < $50 改海派
};

// ============================================================
// 六、异常订单类型
// ============================================================

const ABNORMAL_ORDER_TYPES = {
  BATTERY: 'battery',       // 带电 — 隔离审核
  HELD: 'held',             // 拦截扣货 — 忽略
  TRANSFER: 'transfer',     // 转运 — 调整到目标仓
};

// ============================================================
// 七、价格表文件注册表
// ============================================================

const PRICE_TABLE_REGISTRY = [
  {
    file: '6月_LA盈仓转运业务报价_VIP满天星.xlsx',
    region: 'LA',
    supplier: 'yingcang',
    effectiveMonth: '2026-06',
    sheets: {
      deconsolidation: '提拆打托全包价',
      storage: '海外仓仓储服务',
      directDelivery: '洛杉矶整柜直送',
      combinedTruck: '洛杉矶卡派（组合柜+散板价）',
      commercialDelivery: '商业地址派送服务',
      airFreight: '空派+清关',
      containerPickup: '整柜提柜服务',
      oversized: '超尺寸超重货物收货须知',
    },
  },
  {
    file: '6月_ LINK TRANS LOGISTICS NJ INC 美东盈仓NJ+SAV 海外仓转运业务报价 满天星.xlsx',
    region: 'NY',
    supplier: 'yingcang',
    effectiveMonth: '2026-06',
    sheets: {
      deconsolidation: 'FBA转运收费标准NJ+SAV',
      misc: '提柜海外仓杂费',
      njFba: 'NJ仓发车 FBA',
      njFbx: 'NJ仓发车 FBX商业地址',
      savFba: 'SAV仓发车 FBA',
      njFbxLarge: 'NJ发车FBX商业地址大仓',
      savFbx: 'SAV仓发车 FBX商业地址',
      savFbxLarge: 'SAV发车商业地址大仓',
      directDelivery: 'NJ整柜直送',
      customs: '清关服务',
      returns: '退货换标收费标准',
      airFreight: '空运费用',
      storage: '存仓发货收费标准',
    },
  },
  {
    file: '5月满天星美东转运报价(1).xlsx',
    region: 'NY',
    supplier: 'yingcang',
    effectiveMonth: '2026-05',
    sheets: {}, // 同上结构但5月版
  },
  {
    file: '满天星-芝加哥报价怡.xlsx',
    region: 'Chicago',
    supplier: 'yicifang',
    effectiveMonth: '2026-06',
    sheets: {
      deconsolidation: '芝加哥提拆报价',
      ltlTruck: '芝加哥散板卡派',
      combinedPricing: '芝加哥组合价',
      directDelivery: '芝加哥整柜直送',
    },
  },
  {
    file: '满天星休斯顿报价以此份为准【5-16之后】(1).xlsx',
    region: 'Houston',
    supplier: 'yicifang',
    effectiveMonth: '2026-06',
    sheets: {
      deconsolidation: '休斯顿提拆',
      ltlTruck: '休斯顿散板卡派',
      combinedPricing: '休斯顿组合价',
    },
  },
  {
    file: 'UGD美国海外仓提拆派报价（20260608生效，6.8后预报柜执行新价）.xlsx',
    region: 'NY',
    supplier: 'UGD',
    effectiveMonth: '2026-06',
    sheets: {
      warehouseInfo: '仓库介绍',
      containerPickup: '美东-提柜服务',
      warehouseOps: '美东-库内操作及增值服务',
      truckDispatch: '美东-卡派报价',
      localDelivery: '美东-Local配送',
    },
  },
];

// ============================================================
// 八、OA 联盟船司
// ============================================================

const OA_CARRIERS = [
  'CMA', 'CMA CGM', 'CMA-CGM',
  'COSCO', 'COSCO SHIPPING',
  'EMC', 'EVERGREEN', 'EVER',
  'OOCL', 'OOCL EUROPE',
];

// ============================================================
// 九、发货仓库识别
// ============================================================

function identifyPOL(warehouseName) {
  if (!warehouseName) return null;
  const name = String(warehouseName).trim();
  for (const [wh, pols] of Object.entries(WAREHOUSE_POL_MAP)) {
    if (name.includes(wh)) return pols;
  }
  return null;
}

function identifyRegion(warehouseName) {
  const pols = identifyPOL(warehouseName);
  if (!pols) return null;
  if (pols.some(p => ['YT', 'SHK'].includes(p))) return 'south_china';
  if (pols.some(p => ['NGB', 'SHA'].includes(p))) return 'east_china';
  return null;
}

module.exports = {
  CHANNEL_PATTERNS,
  CHANNEL_PRIORITY,
  POD_REGION_MAP,
  REGION_SUPPLIER,
  SECONDARY_SUPPLIER,
  SUPPLEMENT_RULES,
  WAREHOUSE_POL_MAP,
  CONTAINER_SPECS,
  CONSTRAINT_PARAMS,
  ABNORMAL_ORDER_TYPES,
  PRICE_TABLE_REGISTRY,
  OA_CARRIERS,
  identifyPOL,
  identifyRegion,
};
