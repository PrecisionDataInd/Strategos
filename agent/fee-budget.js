const Store = require('electron-store');
const store = new Store({ name: 'strategos-fees' });

const DAILY_FEE_BUDGET_SOL = 0.5;
const WEEKLY_FEE_BUDGET_SOL = 2.0;

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

function getWeekKey() {
  const d = new Date();
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - yearStart) / 86400000) + yearStart.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

function recordFeeSpent(feeSol) {
  const today = getTodayKey();
  const week = getWeekKey();
  const daily = (store.get(`fees:${today}`, 0) || 0) + feeSol;
  const weekly = (store.get(`fees:${week}`, 0) || 0) + feeSol;
  store.set(`fees:${today}`, daily);
  store.set(`fees:${week}`, weekly);
  return { daily, weekly };
}

function getBudgetStatus() {
  const today = getTodayKey();
  const week = getWeekKey();
  const daily = store.get(`fees:${today}`, 0) || 0;
  const weekly = store.get(`fees:${week}`, 0) || 0;
  return {
    dailySpent: daily,
    dailyBudget: DAILY_FEE_BUDGET_SOL,
    dailyRemaining: Math.max(0, DAILY_FEE_BUDGET_SOL - daily),
    weeklySpent: weekly,
    weeklyBudget: WEEKLY_FEE_BUDGET_SOL,
    weeklyRemaining: Math.max(0, WEEKLY_FEE_BUDGET_SOL - weekly),
    dailyExceeded: daily >= DAILY_FEE_BUDGET_SOL,
    weeklyExceeded: weekly >= WEEKLY_FEE_BUDGET_SOL,
  };
}

function canSpendFees() {
  const status = getBudgetStatus();
  return !status.dailyExceeded && !status.weeklyExceeded;
}

function clearFeeHistory() {
  store.clear();
}

module.exports = {
  recordFeeSpent,
  getBudgetStatus,
  canSpendFees,
  clearFeeHistory,
  DAILY_FEE_BUDGET_SOL,
  WEEKLY_FEE_BUDGET_SOL,
};
