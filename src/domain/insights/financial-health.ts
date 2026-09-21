import { type CurrencyCode, type Money, money } from "@/domain/money/money";

/**
 * A transparent, deterministic financial health model (product spec §8:
 * explicitly "not a meaningless AI-generated score"). Every factor is a
 * plain arithmetic function of real numbers, documented with the formula
 * and the reasoning for its weight — an AI never sees this and is asked
 * to "guess" a health score; it can only read and explain this result.
 */

export interface FinancialHealthFactor {
  key: "cashRunway" | "savingsRate" | "spendingStability" | "recurringLoad" | "receivablesHealth";
  label: string;
  /** 0–100. */
  score: number;
  status: "strong" | "moderate" | "risk";
  explanation: string;
}

export interface FinancialHealthInput {
  currency: CurrencyCode;
  cashBalanceMinor: number;
  /** Average of the last 3 full months of expenses. */
  averageMonthlyExpenseMinor: number;
  /** Average of the last 3 full months of income. */
  averageMonthlyIncomeMinor: number;
  /** Per-month expense totals for the last N months, oldest first — used
   *  for spending-stability variance. */
  monthlyExpenseTotalsMinor: number[];
  /** Total annualized cost of detected recurring payments (rent,
   *  subscriptions, etc.) — see src/domain/insights/recurring-detection. */
  recurringAnnualCostMinor: number;
  /** Money owed to the workspace on invoices. Only meaningful while
   *  invoicing is part of the product; see `includeReceivables`. */
  overdueReceivablesMinor: number;
  totalReceivablesMinor: number;
  /**
   * Whether the receivables factor is scored at all. Default true. Off at the
   * personal-only launch (src/domain/organizations/launch-scope.ts): a person
   * issues no invoices, and a factor that always scores a neutral 100 would
   * quietly inflate every score. The remaining weights are renormalised.
   */
  includeReceivables?: boolean;
}

export interface FinancialHealthResult {
  overallScore: number;
  factors: FinancialHealthFactor[];
  strengths: FinancialHealthFactor[];
  risks: FinancialHealthFactor[];
  cashRunwayMonths: number | null;
}

function statusFor(score: number): FinancialHealthFactor["status"] {
  if (score >= 70) return "strong";
  if (score >= 40) return "moderate";
  return "risk";
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function coefficientOfVariation(values: number[]): number {
  const positive = values.filter((v) => v > 0);
  if (positive.length < 2) return 0;
  const avg = positive.reduce((a, b) => a + b, 0) / positive.length;
  if (avg === 0) return 0;
  const variance = positive.reduce((sum, v) => sum + (v - avg) ** 2, 0) / positive.length;
  return Math.sqrt(variance) / avg;
}

/**
 * Weights sum to 1. Cash runway and savings rate carry the most weight —
 * they're the two numbers that most directly answer "am I okay financially
 * right now" for every user type this product serves.
 */
const WEIGHTS = {
  cashRunway: 0.3,
  savingsRate: 0.3,
  spendingStability: 0.15,
  recurringLoad: 0.15,
  receivablesHealth: 0.1,
};

export function calculateFinancialHealth(input: FinancialHealthInput): FinancialHealthResult {
  // Cash runway: months of spending the current balance would cover.
  // Scored on a 0–6+ month curve — 6 months' runway is the conventional
  // "healthy emergency fund" benchmark, so it maps to a full 100.
  const cashRunwayMonths = input.averageMonthlyExpenseMinor > 0 ? input.cashBalanceMinor / input.averageMonthlyExpenseMinor : null;
  const cashRunwayScore = clampScore(cashRunwayMonths === null ? 50 : (cashRunwayMonths / 6) * 100);
  const cashRunwayFactor: FinancialHealthFactor = {
    key: "cashRunway",
    label: "Cash runway",
    score: cashRunwayScore,
    status: statusFor(cashRunwayScore),
    explanation:
      cashRunwayMonths === null
        ? "Not enough expense history to estimate runway yet."
        : `Your current balance covers about ${cashRunwayMonths.toFixed(1)} months of average spending.`,
  };

  // Savings rate: (income - expense) / income, scored so that a 20%
  // savings rate — a common personal-finance benchmark — reaches 100.
  const savingsRate =
    input.averageMonthlyIncomeMinor > 0
      ? (input.averageMonthlyIncomeMinor - input.averageMonthlyExpenseMinor) / input.averageMonthlyIncomeMinor
      : null;
  const savingsRateScore = clampScore(savingsRate === null ? 50 : (savingsRate / 0.2) * 100);
  const savingsRateFactor: FinancialHealthFactor = {
    key: "savingsRate",
    label: "Savings rate",
    score: savingsRateScore,
    status: statusFor(savingsRateScore),
    explanation:
      savingsRate === null
        ? "Not enough income history to estimate a savings rate yet."
        : savingsRate >= 0
          ? `You're saving about ${Math.round(savingsRate * 100)}% of your income.`
          : `You're spending about ${Math.round(-savingsRate * 100)}% more than your income.`,
  };

  // Spending stability: lower month-to-month variance is healthier
  // (predictable spending is easier to plan around). Coefficient of
  // variation of 0 -> 100, 0.5+ -> 0.
  const variation = coefficientOfVariation(input.monthlyExpenseTotalsMinor);
  const spendingStabilityScore = clampScore(100 - (variation / 0.5) * 100);
  const spendingStabilityFactor: FinancialHealthFactor = {
    key: "spendingStability",
    label: "Spending stability",
    score: spendingStabilityScore,
    status: statusFor(spendingStabilityScore),
    explanation:
      input.monthlyExpenseTotalsMinor.length < 2
        ? "Not enough monthly history to assess spending stability yet."
        : variation < 0.15
          ? "Your monthly spending has been consistent."
          : "Your monthly spending has varied significantly month to month.",
  };

  // Recurring load: annualized recurring cost as a share of annual
  // income. Under 30% is comfortable (100), over 80% is a real
  // constraint on flexibility (0).
  const annualIncome = input.averageMonthlyIncomeMinor * 12;
  const recurringRatio = annualIncome > 0 ? input.recurringAnnualCostMinor / annualIncome : null;
  const recurringLoadScore = clampScore(recurringRatio === null ? 50 : 100 - ((recurringRatio - 0.3) / 0.5) * 100);
  const recurringLoadFactor: FinancialHealthFactor = {
    key: "recurringLoad",
    label: "Recurring obligations",
    score: recurringLoadScore,
    status: statusFor(recurringLoadScore),
    explanation:
      recurringRatio === null
        ? "Not enough income history to assess recurring load yet."
        : `Detected recurring payments are about ${Math.round(recurringRatio * 100)}% of your annual income.`,
  };

  // Receivables health: only meaningful when there's anything owed at
  // all — an org with no invoices scores neutrally rather than being
  // penalized for a metric that doesn't apply to it.
  const overdueRatio = input.totalReceivablesMinor > 0 ? input.overdueReceivablesMinor / input.totalReceivablesMinor : null;
  const receivablesScore = clampScore(overdueRatio === null ? 100 : 100 - overdueRatio * 100);
  const receivablesFactor: FinancialHealthFactor = {
    key: "receivablesHealth",
    label: "Receivables",
    score: receivablesScore,
    status: statusFor(receivablesScore),
    explanation:
      overdueRatio === null
        ? "No outstanding invoices."
        : `${Math.round(overdueRatio * 100)}% of what you're owed is overdue.`,
  };

  const factors = [cashRunwayFactor, savingsRateFactor, spendingStabilityFactor, recurringLoadFactor];
  if (input.includeReceivables !== false) factors.push(receivablesFactor);

  const totalWeight = factors.reduce((sum, f) => sum + WEIGHTS[f.key], 0);
  const overallScore = clampScore(
    factors.reduce((sum, f) => sum + f.score * WEIGHTS[f.key], 0) / totalWeight,
  );

  return {
    overallScore,
    factors,
    strengths: factors.filter((f) => f.status === "strong"),
    risks: factors.filter((f) => f.status === "risk"),
    cashRunwayMonths,
  };
}

export function healthLabel(score: number): string {
  if (score >= 70) return "Healthy";
  if (score >= 40) return "Needs attention";
  return "At risk";
}

export function moneyFromMinor(amountMinor: number, currency: CurrencyCode): Money {
  return money(amountMinor, currency);
}
