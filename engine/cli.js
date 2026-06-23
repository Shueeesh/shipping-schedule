/**
 * 半自动配载系统 — CLI 入口
 *
 * 用法：
 *   node engine/cli.js
 *   node engine/cli.js --output D:\排柜结果\
 *
 * 流程：
 *   加载数据 → 匹配船期 → 装柜分配 → 费用计算 → 输出 Excel
 */

const path = require('path');
const fs = require('fs');
const { loadAllData } = require('./data_loader');
const { parseAllPriceTables } = require('./price_parser');
const { matchOrdersToSchedules } = require('./matcher');
const { allocateContainers, summarizeAllocation } = require('./allocator');
const { calculateAllCosts, generateCostSummary } = require('./cost_calculator');
const { writeOutput } = require('./output_writer');

// ============================================================
// 默认路径配置
// ============================================================

const DEFAULT_CONFIG = {
  summaryFile: '美国华南汇总.xlsx',      // 船期 + 订单
  priceDir: '.',                          // 价格表目录（当前目录 = D:\价格表\）
  outputDir: './排柜结果',
};

// ============================================================
// 主函数
// ============================================================

async function main() {
  console.log('========================================');
  console.log('  半自动配载系统 - Container Loading');
  console.log('  v1.0 - Phase 1 Core Engine');
  console.log('========================================\n');

  // 解析命令行参数
  const args = parseArgs();
  const summaryFile = args.summary || DEFAULT_CONFIG.summaryFile;
  const priceDir = args.prices || DEFAULT_CONFIG.priceDir;
  const outputDir = args.output || DEFAULT_CONFIG.outputDir;

  // 确保输出目录存在
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const summaryPath = path.resolve(priceDir, summaryFile);
  console.log(`[CLI] 汇总文件: ${summaryPath}`);
  console.log(`[CLI] 价格表目录: ${path.resolve(priceDir)}`);
  console.log(`[CLI] 输出目录: ${path.resolve(outputDir)}`);

  if (!fs.existsSync(summaryPath)) {
    console.error(`[CLI] 错误: 汇总文件不存在: ${summaryPath}`);
    process.exit(1);
  }

  try {
    // ==========================================
    // Step 1: 加载数据
    // ==========================================
    console.log('\n--- Step 1: 加载数据 ---');
    const { orders, schedules, priceFiles } = loadAllData(summaryPath, priceDir);

    if (!orders.length) {
      console.error('[CLI] 错误: 没有可排柜的订单');
      process.exit(1);
    }
    if (!schedules.length) {
      console.error('[CLI] 错误: 没有可用的船期');
      process.exit(1);
    }

    // ==========================================
    // Step 2: 解析价格表
    // ==========================================
    console.log('\n--- Step 2: 解析价格表 ---');
    const priceTables = parseAllPriceTables(priceFiles);
    console.log(`[CLI] 已解析 ${Object.keys(priceTables).length} 份价格表`);

    // ==========================================
    // Step 3: 匹配订单到船期
    // ==========================================
    console.log('\n--- Step 3: 匹配订单到船期 ---');
    const matchResult = matchOrdersToSchedules(orders, schedules);
    console.log(`[CLI] 匹配结果: ${matchResult.matched.length} 个匹配组`);
    console.log(`[CLI] 带电隔离: ${matchResult.battery.length} 单`);
    console.log(`[CLI] 拦截扣货: ${matchResult.held.length} 单`);
    console.log(`[CLI] 转运: ${matchResult.transfer.length} 单`);

    // ==========================================
    // Step 4: 装柜分配
    // ==========================================
    console.log('\n--- Step 4: 装柜分配 ---');
    const allocResult = allocateContainers(matchResult, schedules);
    const summary = summarizeAllocation(allocResult);

    console.log(`[CLI] 生成 ${summary.totalContainers} 个柜`);
    console.log(`[CLI] 已装 ${summary.totalOrders} 单, ${summary.totalCBM.toFixed(2)} CBM`);
    console.log(`[CLI] 未装 ${summary.totalUnassigned} 单, ${summary.unassignedCBM.toFixed(2)} CBM`);
    console.log(`[CLI] 平均仓位率: ${(summary.averageFillRate * 100).toFixed(1)}%`);

    // 按区域统计
    for (const [region, data] of Object.entries(summary.containersByRegion)) {
      console.log(`  ${region}: ${data.count} 柜, ${data.totalCBM.toFixed(2)} CBM`);
    }

    if (summary.violations.length) {
      console.log(`[CLI] ⚠️ ${summary.violations.length} 个违规需要审核`);
      for (const v of summary.violations) {
        console.log(`  ${v.container}: ${v.violations.map(vl => vl.code).join(', ')}`);
      }
    }

    // ==========================================
    // Step 5: 费用计算
    // ==========================================
    console.log('\n--- Step 5: 费用计算 ---');
    const costedContainers = calculateAllCosts(allocResult.containers, priceTables);
    const costSummary = generateCostSummary(costedContainers);

    console.log(`[CLI] 总费用: $${costSummary.totalCost.toFixed(2)}`);
    console.log(`  提拆: $${costSummary.byCategory.deconsolidation.toFixed(0)}`);
    console.log(`  卡派: $${costSummary.byCategory.truckDispatch.toFixed(0)}`);
    console.log(`  清关: $${costSummary.byCategory.customs.toFixed(0)}`);
    console.log(`  仓储: $${costSummary.byCategory.storage.toFixed(0)}`);

    // ==========================================
    // Step 6: 生成输出 Excel
    // ==========================================
    console.log('\n--- Step 6: 生成输出 ---');
    const outputPath = writeOutput(allocResult, costSummary, outputDir);

    // ==========================================
    // 完成
    // ==========================================
    console.log('\n========================================');
    console.log(`  ✅ 排柜完成! 输出文件: ${outputPath}`);
    console.log('  请打开 Excel 进行人工审核。');
    console.log('========================================\n');

    // 返回结果供后续处理
    return {
      matchResult,
      allocResult,
      costSummary,
      outputPath,
    };

  } catch (err) {
    console.error(`[CLI] 错误: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

// ============================================================
// 命令行参数解析
// ============================================================

function parseArgs() {
  const args = {};
  const raw = process.argv.slice(2);

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '--summary' || raw[i] === '-s') {
      args.summary = raw[++i];
    } else if (raw[i] === '--prices' || raw[i] === '-p') {
      args.prices = raw[++i];
    } else if (raw[i] === '--output' || raw[i] === '-o') {
      args.output = raw[++i];
    } else if (raw[i] === '--help' || raw[i] === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
半自动配载系统 - CLI 使用说明
==============================

用法:
  node engine/cli.js [选项]

选项:
  -s, --summary <path>   汇总文件路径（默认: 美国华南汇总.xlsx）
  -p, --prices <dir>     价格表目录（默认: 当前目录）
  -o, --output <dir>     输出目录（默认: ./排柜结果）
  -h, --help             显示帮助

示例:
  node engine/cli.js
  node engine/cli.js -o D:\\排柜结果\\
  node engine/cli.js --summary 美国华南汇总_bak.xlsx --output ./输出
`);
}

// ============================================================
// 运行
// ============================================================

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
