// Screen-space clustering for port markers at low zoom (no plugin): greedy
// grouping of points whose projected pixel positions are within `radius`.

export interface ClusterInput<T> {
  item: T;
  x: number;
  y: number;
}

export interface Cluster<T> {
  items: T[];
  x: number;
  y: number;
}

export function clusterByPixels<T>(points: ClusterInput<T>[], radius = 34): Cluster<T>[] {
  const out: Cluster<T>[] = [];
  const r2 = radius * radius;
  for (const p of points) {
    let hit: Cluster<T> | undefined;
    for (const c of out) {
      const dx = c.x - p.x;
      const dy = c.y - p.y;
      if (dx * dx + dy * dy <= r2) {
        hit = c;
        break;
      }
    }
    if (hit) {
      const n = hit.items.length;
      hit.x = (hit.x * n + p.x) / (n + 1);
      hit.y = (hit.y * n + p.y) / (n + 1);
      hit.items.push(p.item);
    } else {
      out.push({ items: [p.item], x: p.x, y: p.y });
    }
  }
  return out;
}
