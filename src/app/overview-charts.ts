/** Donut sectors use exact counts; rounded percentages are only display labels. */
export function donutSegments<T extends {count: number}>(rows: readonly T[]): (T & {percent: number; path: string})[] {
  const positive = rows.filter(row => Number.isFinite(row.count) && row.count > 0);
  const total = positive.reduce((sum, row) => sum + row.count, 0);
  let offset = 0;
  const point = (radius: number, fraction: number) => {
    const angle = fraction * 2 * Math.PI - Math.PI / 2;
    return `${100 + radius * Math.cos(angle)},${100 + radius * Math.sin(angle)}`;
  };
  return positive.map(row => {
    const share = row.count / total, start = offset; offset += share;
    const path = share === 1
      ? 'M100,12 A88,88 0 1,1 100,188 A88,88 0 1,1 100,12 L100,38 A62,62 0 1,0 100,162 A62,62 0 1,0 100,38 Z'
      : `M${point(88, start)} A88,88 0 ${share > .5 ? 1 : 0},1 ${point(88, offset)} L${point(62, offset)} A62,62 0 ${share > .5 ? 1 : 0},0 ${point(62, start)} Z`;
    return {...row, percent: share * 100, path};
  });
}
