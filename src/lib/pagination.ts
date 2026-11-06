export type PaginatedRows<T> = {
  rows: T[];
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  start: number;
  end: number;
};

export function paginateRows<T>(
  rows: readonly T[],
  requestedPage: number,
  pageSize = 25,
): PaginatedRows<T> {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError("El tamaño de página debe ser un entero positivo.");
  }

  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const requested = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;
  const page = Math.min(pageCount, Math.max(1, requested));
  const offset = (page - 1) * pageSize;

  return {
    rows: rows.slice(offset, offset + pageSize),
    page,
    pageSize,
    pageCount,
    total,
    start: total === 0 ? 0 : offset + 1,
    end: Math.min(offset + pageSize, total),
  };
}
