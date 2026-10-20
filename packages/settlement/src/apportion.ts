/** Split `total` by share into whole numbers that add up to it: floors first, then the largest remainders get one more (ties to the earlier key). */

export function apportion(total: number, shares: Readonly<Record<string, number>>): Record<string, number> {
  const keys = Object.keys(shares);
  const sum = keys.reduce((a, k) => a + shares[k]!, 0);
  const out: Record<string, number> = {};
  const rem: { key: string; r: number }[] = [];
  let given = 0;
  for (const k of keys) {
    const exact = sum > 0 ? (total * shares[k]!) / sum : 0;
    out[k] = Math.floor(exact);
    given += out[k]!;
    rem.push({ key: k, r: exact - out[k]! });
  }
  rem.sort((a, b) => b.r - a.r || keys.indexOf(a.key) - keys.indexOf(b.key));
  for (let i = 0; i < total - given; i++) out[rem[i]!.key]! += 1;
  return out;
}
