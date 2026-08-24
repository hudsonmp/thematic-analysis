'use client';

import { objectLabel, type ObjectLite, type ObjectRoles, type RoleLite } from '@/lib/actions/schema';

const SELECT = 'border border-foreground/20 bg-background px-1.5 py-0.5 text-xs focus:border-foreground focus:outline-none disabled:opacity-60';

/**
 * One row per SELECTED object: "Entity  [— no role — ▾]". Roles are optional
 * (migration 50) — the strip renders nothing when no roles are defined or no
 * object is picked, so it never nags. Shared by /actions' ActionForm and the
 * coding modal's manual composer so both assign roles the same way.
 */
export default function ObjectRolesPicker({
  objectIds,
  objects,
  roles,
  value,
  onChange,
  disabled = false,
}: {
  objectIds: string[];
  objects: ObjectLite[];
  roles: RoleLite[];
  value: ObjectRoles;
  onChange: (next: ObjectRoles) => void;
  disabled?: boolean;
}) {
  const ids = Array.from(new Set(objectIds));
  if (roles.length === 0 || ids.length === 0) return null;
  return (
    <fieldset className="border border-foreground/15 p-2">
      <legend className="px-1 text-[11px] uppercase tracking-wider text-foreground/50">
        roles <span className="normal-case tracking-normal text-foreground/40">· optional, one per object</span>
      </legend>
      <div className="flex flex-col gap-1" role="group" aria-label="Object roles">
        {ids.map((id) => {
          const current = value[id] ?? '';
          return (
            <label key={id} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{objectLabel(objects, id)}</span>
              <select
                value={current}
                disabled={disabled}
                aria-label={`Role of ${objectLabel(objects, id)}`}
                onChange={(e) => onChange({ ...value, [id]: e.target.value || null })}
                className={`${SELECT} ${current ? '' : 'text-foreground/50'}`}
              >
                <option value="">— no role —</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
