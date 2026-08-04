/**
 * Raindrop CSV imports only append URL/title bookmarks to Unsorted. They do
 * not pause existing automation and do not make the rest of the library
 * read-only while small insert chunks are applied.
 */
export function importHoldsLibrary(db: D1Database): Promise<boolean> {
  void db;
  return Promise.resolve(false);
}

export function importHoldsAi(db: D1Database): Promise<boolean> {
  void db;
  return Promise.resolve(false);
}
