import type Database from 'better-sqlite3';
import type { Db } from '../db/types.js';
import { resolveRequestedIdToTieredMembers, type ModelGroup } from '../services/model-groups.js';

const registeredGroups = new WeakMap<Db, ModelGroup[]>();

// Use exactly the routing resolver's intended members. A slug that coincides
// with another group's literal model id remains a genuine model fallback.
export function registerRequestedModelMatcher(db: Db, groups: ModelGroup[]): boolean {
  const sqlite = db as Db & Partial<Pick<Database.Database, 'function'>>;
  if (typeof sqlite.function !== 'function') return false;
  if (registeredGroups.get(db) === groups) return true;
  const knownMembers = new Set(groups.flatMap(group => group.members.map(member => member.model_db_id)));
  const cache = new Map<string, Set<number> | null>();
  sqlite.function('analytics_alias_honored', { deterministic: true }, (requested: unknown, modelDbId: unknown): number | null => {
    if (typeof requested !== 'string' || typeof modelDbId !== 'number' || !knownMembers.has(modelDbId)) return null;
    if (!cache.has(requested)) {
      const matches = resolveRequestedIdToTieredMembers(requested, groups);
      if (!matches) cache.set(requested, null);
      else {
        const literal = matches.filter(member => member.tier === 'literal');
        cache.set(requested, new Set((literal.length ? literal : matches).map(member => member.modelDbId)));
      }
    }
    const intended = cache.get(requested);
    return intended ? Number(intended.has(modelDbId)) : null;
  });
  registeredGroups.set(db, groups);
  return true;
}

export function requestedModelHonoredSql(alias = '', withGroups = false): string {
  if (alias && !/^[a-z_][a-z0-9_]*\.$/i.test(alias)) throw new Error('Invalid SQL table alias');
  const requested = `${alias}requested_model`;
  const served = `${alias}model_id`;
  const platform = `${alias}platform`;
  const model = `(CASE WHEN substr(${requested}, 1, length(${platform}) + 1) = ${platform} || ':' THEN substr(${requested}, length(${platform}) + 2) ELSE ${requested} END)`;
  const literal = `(${requested} IS NOT NULL AND ${requested} <> '' AND (
    ${requested} = ${served} OR ${model} = ${served} OR (
      instr(${model}, '/') = 0 AND instr(${model}, ':') = 0 AND ${model} <> ''
      AND substr(${served}, -length(${model}) - 1) = '/' || ${model}
    )
  ))`;
  return withGroups ? `COALESCE(analytics_alias_honored(${requested}, ${alias}model_db_id), ${literal})` : literal;
}
