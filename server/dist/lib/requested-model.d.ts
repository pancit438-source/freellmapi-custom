import type { Db } from '../db/types.js';
import { type ModelGroup } from '../services/model-groups.js';
export declare function registerRequestedModelMatcher(db: Db, groups: ModelGroup[]): boolean;
export declare function requestedModelHonoredSql(alias?: string, withGroups?: boolean): string;
//# sourceMappingURL=requested-model.d.ts.map