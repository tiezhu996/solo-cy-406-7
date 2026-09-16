import { openDB, IDBPDatabase } from 'idb';
import { Amendment } from '../types/amendment';
import { Clause } from '../types/clause';
import { ContractInstance } from '../types/contract-instance';
import { Template } from '../types/template';
import { Version } from '../types/version';

export const DB_NAME = 'contract-template-editor';
/**
 * v1: templates / clauses / instances / versions
 * v2: 新增 amendments（合同变更记录），并为 versions 增加 byInstance 索引，
 *     供变更生效事务在同一事务内查询当前最大版本号。
 */
export const DB_VERSION = 2;

export const STORE_NAMES = ['templates', 'clauses', 'instances', 'versions', 'amendments'] as const;
export type StoreName = (typeof STORE_NAMES)[number];

export interface StoreValueMap {
  templates: Template;
  clauses: Clause;
  instances: ContractInstance;
  versions: Version;
  amendments: Amendment;
}

export type StoreValue<S extends StoreName> = StoreValueMap[S];

export interface ExportPayload {
  templates: Template[];
  clauses: Clause[];
  instances: ContractInstance[];
  versions: Version[];
  amendments: Amendment[];
  exportedAt: string;
}

let dbPromise: Promise<IDBPDatabase> | undefined;

export function makeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso() {
  return new Date().toISOString();
}

/** 打开（或按版本迁移）应用数据库；getDb 在此之上做单例缓存 */
export function openAppDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      for (const storeName of STORE_NAMES) {
        if (!db.objectStoreNames.contains(storeName)) {
          const store = db.createObjectStore(storeName, { keyPath: 'id' });
          // 全新建库时直接在同一升级事务内建好索引
          if (storeName === 'versions' || storeName === 'amendments') {
            store.createIndex('byInstance', 'contractInstanceId');
          }
        }
      }

      // v1 -> v2：旧库中的 versions 需要补建 byInstance 索引；
      // amendments 为新建 store，上面已带索引。
      if (oldVersion > 0 && oldVersion < 2) {
        const versions = transaction.objectStore('versions');
        if (!versions.indexNames.contains('byInstance')) {
          versions.createIndex('byInstance', 'contractInstanceId');
        }
      }
    }
  });
}

export function getDb() {
  if (!dbPromise) {
    dbPromise = openAppDb();
  }

  return dbPromise;
}

export async function getAllRecords<S extends StoreName>(storeName: S): Promise<StoreValue<S>[]> {
  const db = await getDb();
  return (await db.getAll(storeName)) as StoreValue<S>[];
}

export async function getRecord<S extends StoreName>(storeName: S, id: string): Promise<StoreValue<S> | undefined> {
  const db = await getDb();
  return (await db.get(storeName, id)) as StoreValue<S> | undefined;
}

export async function putRecord<S extends StoreName>(storeName: S, record: StoreValue<S>) {
  const db = await getDb();
  await db.put(storeName, record);
  return record;
}

export async function deleteRecord(storeName: StoreName, id: string) {
  const db = await getDb();
  await db.delete(storeName, id);
}

export async function clearStore(storeName: StoreName) {
  const db = await getDb();
  await db.clear(storeName);
}

export async function exportAllData(): Promise<ExportPayload> {
  const [templates, clauses, instances, versions, amendments] = await Promise.all([
    getAllRecords('templates'),
    getAllRecords('clauses'),
    getAllRecords('instances'),
    getAllRecords('versions'),
    getAllRecords('amendments')
  ]);

  return {
    templates,
    clauses,
    instances,
    versions,
    amendments,
    exportedAt: nowIso()
  };
}

export async function importAllData(payload: Partial<ExportPayload>) {
  const db = await getDb();
  const tx = db.transaction(STORE_NAMES, 'readwrite');

  for (const storeName of STORE_NAMES) {
    const store = tx.objectStore(storeName);
    await store.clear();
    const records = (payload[storeName] ?? []) as StoreValue<typeof storeName>[];
    for (const record of records) {
      await store.put(record);
    }
  }

  await tx.done;
}
