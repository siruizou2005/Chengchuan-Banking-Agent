// Month rules for the bill page. No imports, so they can be tested without a browser.
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// A link can carry anything; only a real month up to now may reach the header or the API.
export function resolveMonth(value: string | null, currentMonth: string) {
  return value && MONTH.test(value) && value <= currentMonth ? value : currentMonth;
}

export const monthLabel = (month: string) => `${month.slice(0, 4)}年${Number(month.slice(5))}月`;

// The server compares an unfinished month with the same days of the month before.
export function comparisonLabel(to: string) {
  const year = Number(to.slice(0, 4)), month = Number(to.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return to === lastDay ? '较上月' : '较上月同期';
}

// Months with bills: from the first entry through the current month. Without any entries only the current month exists.
export function monthGrid(year: number, firstMonth: string | null, currentMonth: string) {
  const first = firstMonth && firstMonth < currentMonth ? firstMonth : currentMonth;
  return Array.from({ length: 12 }, (_, i) => {
    const value = `${year}-${String(i + 1).padStart(2, '0')}`;
    return { value, label: `${i + 1}月`, enabled: value >= first && value <= currentMonth };
  });
}

export function yearBounds(firstMonth: string | null, currentMonth: string) {
  const first = firstMonth && firstMonth < currentMonth ? firstMonth : currentMonth;
  return { min: Number(first.slice(0, 4)), max: Number(currentMonth.slice(0, 4)) };
}
