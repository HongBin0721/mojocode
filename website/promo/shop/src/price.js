// cart total, with optional discount
export function total(items, discount = 0) {
  let sum = 0;
  for (const it of items) sum += it.price;
  return sum * (1 - discount);
}
