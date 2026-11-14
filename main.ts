import * as fs from 'node:fs';
import * as path from 'node:path';

interface MarketInput {
  id: string;
  name: string;
  slug: string;
  yes_token: string;
  start: string;
  prices: number[];
}

interface InputData {
  schema: string;
  competition: string;
  case: string;
  at: string;
  horizon_minutes?: number;
  quantiles: number[];
  event: string;
  markets: MarketInput[];
}

interface ForecastOutput {
  id: string;
  q: number[][];
}

interface OutputData {
  forecasts: ForecastOutput[];
}

// Helper to clamp and round to 6 decimals, fixing -0
function clamp6(v: number): number {
  const clamped = Math.min(1, Math.max(0, v));
  const rounded = Math.round(clamped * 1000000) / 1000000;
  return rounded === 0 ? 0 : rounded;
}

// Standard normal quantiles corresponding to [0.05, 0.25, 0.5, 0.75, 0.95]
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
const SIGMA = 0.001;
const HGRID = [1, 2, 4, 7, 12, 20, 32, 50, 80, 120, 180, 240];
const TARGET_Q = [0.05, 0.25, 0.5, 0.75, 0.95];

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function linearInterpolate(arr: number[], q: number): number {
  const pos = q * (arr.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < arr.length) {
    return arr[base] + rest * (arr[base + 1] - arr[base]);
  }
  return arr[base];
}

function processFile(inputFilePath: string, outputFilePath: string): void {
  const rawContent = fs.readFileSync(inputFilePath, 'utf-8');
  const input = JSON.parse(rawContent) as InputData;

  // Check quantiles
  if (!arraysEqual(input.quantiles, TARGET_Q)) {
    throw new Error('Case asks for different quantiles');
  }

  const horizon = input.horizon_minutes || 240;
  const forecasts: ForecastOutput[] = [];

  // Pre-calculate empirical and parametric quantiles for each market
  const marketIntermediate: { id: string; x: number; rows: number[][] }[] = [];

  for (const m of input.markets) {
    const p = m.prices;
    if (p.length === 0) throw new Error(`market ${market.id} has no prices`);
      const x = p[p.length - 1];

    // (b) Empirical quantiles on grid
    const history = p.length > 720 ? p.slice(p.length - 720) : p;
    const gridQuantiles: { [h: number]: number[] | null } = {};

    for (const h of HGRID) {
      const returns: number[] = [];
      for (let i = 0; i <= history.length - h - 1; i++) {
        returns.push(history[i + h] - history[i]);
      }
      if (returns.length < 20) {
        gridQuantiles[h] = null;
      } else {
        returns.sort((a, b) => a - b);
        const eq = TARGET_Q.map(q => linearInterpolate(returns, q));
        gridQuantiles[h] = eq;
      }
    }

    // (c) Interpolate empirical quantiles in sqrt(h) across grid points
    const empiricalAtH: (number[] | null)[] = [];
    for (let h = 1; h <= horizon; h++) {
      const sqrtH = Math.sqrt(h);
      // Find surrounding grid points in HGRID
      let lowerH = HGRID[0];
      let upperH = HGRID[HGRID.length - 1];
      let found = false;

      for (let i = 0; i < HGRID.length - 1; i++) {
        if (h >= HGRID[i] && h <= HGRID[i + 1]) {
          lowerH = HGRID[i];
          upperH = HGRID[i + 1];
          found = true;
          break;
        }
      }

      const eqLower = gridQuantiles[lowerH];
      const eqUpper = gridQuantiles[upperH];

      if (eqLower && eqUpper) {
        const sqrtLower = Math.sqrt(lowerH);
        const sqrtUpper = Math.sqrt(upperH);
        const weight = sqrtUpper === sqrtLower ? 0 : (sqrtH - sqrtLower) / (sqrtUpper - sqrtLower);
        const interpolatedQ = [0, 1, 2, 3, 4].map(j => eqLower[j] + weight * (eqUpper[j] - eqLower[j]));
        empiricalAtH.push(interpolatedQ);
      } else if (eqLower) {
        empiricalAtH.push(eqLower);
      } else if (eqUpper) {
        empiricalAtH.push(eqUpper);
      } else {
        empiricalAtH.push(null);
      }
    }

    // (a), (d), (e) Build rows for this market
    const rows: number[][] = [];
    for (let h = 1; h <= horizon; h++) {
      const sqrtH = Math.sqrt(h);
      const row: number[] = [];
      const emp = empiricalAtH[h - 1];

      for (let j = 0; j < 5; j++) {
        const param_j = Z[j] * SIGMA * sqrtH;
        const empirical_j = emp ? emp[j] : param_j;
        const q_j = 0.4 * empirical_j + 0.6 * param_j;
        row.push(clamp6(x + q_j));
      }
      rows.push(row);
    }

    marketIntermediate.push({ id: m.id, x, rows });
  }

  // (f) SUM rescale across all markets in the case
  let sumX = 0;
  for (const mi of marketIntermediate) {
    sumX += mi.x;
  }
  const scale = (sumX >= 0.85 && sumX <= 1.15) ? 1 / sumX : 1;

  for (const mi of marketIntermediate) {
    const finalRows: number[][] = [];
    for (const row of mi.rows) {
      const median2 = clamp6(row[2] * scale);
      const shift = median2 - row[2];
      const shiftedRow = row.map(v => clamp6(v + shift));
      shiftedRow.sort((a, b) => a - b);
      finalRows.push(shiftedRow);
    }
    forecasts.push({ id: mi.id, q: finalRows });
  }

  const outputData: OutputData = { forecasts };
  fs.writeFileSync(outputFilePath, JSON.stringify(outputData) + '\n', 'utf-8');
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  if (!fs.existsSync(inputDir)) {
    return;
  }

  const files = fs.readdirSync(inputDir)
    .filter(f => f.endsWith('.in'))
    .sort();

  for (const file of files) {
    const id = path.basename(file, '.in');
    const inputFilePath = path.join(inputDir, file);
    const outputFilePath = path.join(outputDir, `${id}.out`);
    processFile(inputFilePath, outputFilePath);
  }
}

main();
