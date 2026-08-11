export type StorageSource = "local" | "cloud";

export interface StorageQuery<T> {
  where?: Partial<T>;
  limit?: number;
  offset?: number;
  orderBy?: keyof T;
  orderDirection?: "asc" | "desc";
}

export interface MajikStorageAdapter<T extends { id: string }> {
  save(item: T, source?: StorageSource): Promise<void>;
  getById(id: string, source?: StorageSource): Promise<T | null>;
  list(source?: StorageSource): Promise<T[]>;
  remove(id: string, source?: StorageSource): Promise<boolean>;
  clear(source?: StorageSource): Promise<void>;
  count(source?: StorageSource): Promise<number>;
  exists(id: string, source?: StorageSource): Promise<boolean>;
  bulkSave(items: T[], source?: StorageSource): Promise<void>;
  bulkRemove(ids: string[], source?: StorageSource): Promise<void>;
  query?(query: StorageQuery<T>, source?: StorageSource): Promise<T[]>;
}
