import { readBackup, type OrbitBackup } from './backup-data.ts';
import { sharedAppearance } from './appearance-data.ts';
import { canonical, versionGraph, type DriveFile } from './drive-data.ts';
import { DEFAULT_GOOGLE, type CalendarSource } from './google-data.ts';
import { readWorkspaceState } from './workspace-data.ts';
import { scheduleError } from './task-schedule.ts';
import type { Task, TaskConflict, TaskConflictVersion } from './models.ts';
import { taskVersionKey } from './task-conflict-data.ts';

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const calendarKey = (source: {accountId: string; calendarId: string}): string => JSON.stringify([source.accountId, source.calendarId]);

/** The newest unique ancestor shared by every branch, including this device's baseline. */
export function commonDriveAncestor(files: DriveFile[], tips: string[]): DriveFile | undefined {
  versionGraph(files);
  if (!tips.length) return undefined;
  const versions = new Map(files.map(file => [file.cloud.versionId, file]));
  const ancestors = tips.map(tip => {
    const result = new Set<string>(), pending = [tip];
    while (pending.length) {const id = pending.pop()!; if (result.has(id)) continue; result.add(id); pending.push(...versions.get(id)?.cloud.parents ?? []);}
    return result;
  });
  const common = new Set([...ancestors[0]].filter(id => versions.has(id) && ancestors.every(set => set.has(id))));
  const older = new Set([...common].flatMap(id => versions.get(id)!.cloud.parents));
  const latest = [...common].filter(id => !older.has(id)).map(id => versions.get(id)!);
  return latest.length === 1 ? latest[0] : undefined;
}

function sources(backup: OrbitBackup): CalendarSource[] {
  const grouped = new Map<string, CalendarSource>();
  for (const source of backup.kind === 'full' ? backup.google?.sources ?? [] : backup.calendarSources ?? []) {
    if (!source.workspaceIds.length) continue;
    const key = calendarKey(source), previous = grouped.get(key);
    grouped.set(key, {...source, id: key, workspaceIds: [...new Set([...(previous?.workspaceIds ?? []), ...source.workspaceIds])].sort()});
  }
  return [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
function content(backup: OrbitBackup): RecordValue {
  return {workspaces: backup.data.workspaces.map(({taskConflicts, ...workspace}) => workspace), sources: sources(backup), ...(backup.kind === 'full'
    ? {preferences: backup.preferences ? sharedAppearance(backup.preferences) : undefined, reminders: backup.reminders, refreshMinutes: backup.google?.refreshMinutes} : {})};
}

/** Dates are display metadata, never a way to decide which edit wins. */
function taskContent(value: RecordValue): RecordValue {
  const {updatedAt, deletedAt, editSource, ...fields} = value;
  return {...fields, deleted: !!deletedAt};
}
function taskEdit(value: RecordValue): RecordValue {
  const {updatedAt, deletedAt, editSource, ...fields} = value;
  return fields;
}

class Merger {
  readonly conflicts = new Set<string>();
  readonly taskConflicts = new Map<string, TaskConflict>();
  private readonly preferred: number | undefined;
  private readonly deferTasks: boolean;
  private readonly versionKeys: Map<string, (string | undefined)[]>;
  private readonly pendingTasks: Map<string, (TaskConflict | undefined)[]>;
  constructor(preferred: number | undefined, deferTasks = false, versionKeys = new Map<string, (string | undefined)[]>(), pendingTasks = new Map<string, (TaskConflict | undefined)[]>()) {this.preferred = preferred; this.deferTasks = deferTasks; this.versionKeys = versionKeys; this.pendingTasks = pendingTasks;}
  private conflict(path: string, values: unknown[]): unknown {
    this.conflicts.add(path);
    return structuredClone(values[this.preferred ?? 0]);
  }
  merge(base: unknown, values: unknown[], path: string): unknown {
    const changed = values.filter(value => !same(value, base));
    if (!changed.length) return structuredClone(base);
    if (changed.every(value => same(value, changed[0]))) return structuredClone(changed[0]);
    if (Array.isArray(base) && values.every(Array.isArray)) {
      if (path.endsWith('.workspaceIds')) {
        const ids = [...new Set([base, ...values as string[][]].flat())] as string[];
        return ids.filter(id => this.merge(base.includes(id), values.map(value => (value as string[]).includes(id)), path + '.' + id)).sort();
      }
      if ([base, ...values].every(value => (value as unknown[]).every(item => object(item) && typeof item['id'] === 'string'))) {
        return this.entities(base as RecordValue[], values as RecordValue[][], path);
      }
    }
    if (object(base) && values.every(object) && !path.endsWith('.calendarOrigin')) {
      const isTask = typeof base['title'] === 'string' && Array.isArray(base['subtasks']);
      if (isTask) {
        const tasks = values as RecordValue[];
        if (tasks.some((task, i) => !!task['deletedAt'] !== !!base['deletedAt'] && tasks.some((other, j) => i !== j && !same(taskEdit(other), taskEdit(base)) && !same(taskContent(task), taskContent(other))))) return this.conflict(path, values);
      }
      const result: RecordValue = {};
      for (const key of new Set([base, ...values as RecordValue[]].flatMap(value => Object.keys(value)))) {
        if (isTask && (key === 'updatedAt' || key === 'deletedAt' || key === 'editSource')) continue;
        const value = this.merge(base[key], values.map(value => (value as RecordValue)[key]), path + '.' + key);
        if (value !== undefined) result[key] = value;
      }
      if (isTask) {
        const edited = [...values as RecordValue[]].sort((a, b) => {const left = canonical([a['updatedAt'], a['editSource']]), right = canonical([b['updatedAt'], b['editSource']]); return left < right ? -1 : left > right ? 1 : 0;}).at(-1);
        if (edited?.['editSource']) result['editSource'] = structuredClone(edited['editSource']);
        for (const key of ['updatedAt', 'deletedAt']) {
          const dates = (values as RecordValue[]).map(value => value[key]).filter((value): value is string => typeof value === 'string').sort();
          // A restoration removes deletedAt; concurrent deletions retain a single tombstone.
          if (key === 'deletedAt' && !(this.merge(!!base[key], values.map(value => !!(value as RecordValue)[key]), path + '.' + key))) continue;
          if (dates.length) result[key] = dates.at(-1);
        }
        if (scheduleError(result as unknown as Task)) {
          this.conflicts.add(path + '.schedule');
          const chosen = values[this.preferred ?? 0] as RecordValue;
          for (const key of ['startDate', 'startTime', 'dueDate', 'dueTime']) result[key] = chosen[key];
        }
      }
      return result;
    }
    // Missing vs. modified entities and concurrent additions with the same ID require a choice.
    return this.conflict(path, values);
  }
  private entities(base: RecordValue[], values: RecordValue[][], path: string): RecordValue[] {
    const index = (items: RecordValue[]) => new Map(items.map(item => [item['id'] as string, item]));
    const original = index(base), branches = values.map(index), merged = new Map<string, RecordValue>();
    for (const id of new Set([original, ...branches].flatMap(map => [...map.keys()]))) {
      const itemPath = path + '[' + id + ']', variants = branches.map(map => map.get(id)), before = new Set(this.conflicts);
      let item = this.merge(original.get(id), variants, itemPath);
      const collisions = [...this.conflicts].filter(value => !before.has(value) && (value === itemPath || value.startsWith(itemPath + '.') || value.startsWith(itemPath + '[')));
      if (this.deferTasks && path.endsWith('.tasks') && collisions.length) {
        const versions = new Map<string, TaskConflictVersion>();
        for (let i = 0; i < variants.length; i++) {
          const pending = this.pendingTasks.get(itemPath)?.[i];
          if (pending && !pending.resolved) {
            // A provisional card is not an additional user edit. Keep its actual alternatives.
            for (const version of pending.versions) versions.set(version.key, structuredClone(version));
            continue;
          }
          const raw = variants[i] as unknown as Task | undefined;
          if (taskVersionKey(raw ?? null) === taskVersionKey(original.get(id) as unknown as Task ?? null)) continue;
          const task = new Merger(i).merge(original.get(id), variants, itemPath) as unknown as Task | undefined;
          const key = this.versionKeys.get(itemPath)?.[i] ?? taskVersionKey(raw ?? null);
          const source = {...raw?.editSource, ...(raw?.updatedAt ? {updatedAt: raw.updatedAt} : {})};
          versions.set(key, {key, task: task ?? null, source});
        }
        collisions.forEach(value => this.conflicts.delete(value));
        if (versions.size > 1) {
          this.taskConflicts.set(itemPath, {id, versions: [...versions.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)});
          // Keep a common provisional card while the alternatives wait in the side panel.
          item = new Merger(variants.length).merge(original.get(id), [...variants, original.get(id)], itemPath);
        } else item = [...versions.values()][0]?.task ?? undefined;
      }
      if (item !== undefined) merged.set(id, item as RecordValue);
    }
    const ids = [...merged.keys()], oldIds = new Set(base.map(item => item['id'] as string));
    const oldOrder = base.map(item => item['id'] as string).filter(id => merged.has(id));
    const orders = values.map(items => items.map(item => item['id'] as string).filter(id => merged.has(id)));
    const reorders = orders.filter(order => {
      const old = order.filter(id => oldIds.has(id));
      const present = new Set(old);
      return !same(old, oldOrder.filter(id => present.has(id)));
    });
    const backbone = reorders[0]?.filter(id => oldIds.has(id)) ?? oldOrder;
    const edges = new Map(ids.map(id => [id, new Set<string>()]));
    const connect = (a: string, b: string) => {if (a !== b) edges.get(a)!.add(b);};
    backbone.slice(1).forEach((id, i) => connect(backbone[i], id));
    // New entries keep their position; simultaneous entries in the same gap sort by stable ID.
    for (const order of orders) order.slice(1).forEach((id, i) => {if (!oldIds.has(order[i]) || !oldIds.has(id)) connect(order[i], id);});
    const incompatible = reorders.some(order => {
      const backboneIds = new Set(backbone), old = order.filter(id => backboneIds.has(id)), present = new Set(old);
      return !same(old, backbone.filter(id => present.has(id)));
    });
    const incoming = new Map(ids.map(id => [id, 0]));
    for (const children of edges.values()) for (const child of children) incoming.set(child, incoming.get(child)! + 1);
    const ready = ids.filter(id => !incoming.get(id)).sort(), ordered: string[] = [];
    while (ready.length) {
      const id = ready.shift()!; ordered.push(id);
      for (const child of edges.get(id)!) {incoming.set(child, incoming.get(child)! - 1); if (!incoming.get(child)) {ready.push(child); ready.sort();}}
    }
    if (incompatible || ordered.length !== ids.length) {
      this.conflicts.add(path + '.order');
      const chosen = orders[this.preferred ?? 0];
      return [...chosen, ...ids.filter(id => !chosen.includes(id)).sort()].map(id => merged.get(id)!);
    }
    return ordered.map(id => merged.get(id)!);
  }
}

function resolvedTaskChoice(base: TaskConflict | undefined, records: (TaskConflict | undefined)[], keys: Set<string>): string | undefined {
  const changed = records.filter((record): record is TaskConflict => !!record).map(record => record.resolved).filter(choice => choice !== base?.resolved);
  if (new Set(changed).size > 1) return undefined;
  const choice = changed.length ? changed[0] : base?.resolved;
  return choice && records.some(record => record?.resolved === choice && [...keys].every(key => record.versions.some(version => version.key === key))) ? choice : undefined;
}

/** Covered offline alternatives cannot undo a choice or later edits made after it. */
function normalizeResolvedTasks(base: OrbitBackup, backups: OrbitBackup[], projections: RecordValue[]): string[] {
  const unsafe: string[] = [];
  for (const original of base.data.workspaces) {
    const branches = backups.map(backup => backup.data.workspaces.find(workspace => workspace.id === original.id));
    const ids = new Set(branches.flatMap(workspace => workspace?.taskConflicts?.map(record => record.id) ?? []));
    for (const id of ids) {
      const records = branches.map(workspace => workspace?.taskConflicts?.find(record => record.id === id));
      const keys = new Set(records.flatMap(record => record?.versions.map(version => version.key) ?? []));
      const baseTask = original.tasks.find(task => task.id === id);
      if (!baseTask && records.some((record, index) => record?.resolved && !branches[index]?.tasks.some(task => task.id === id))
        && branches.some(workspace => {const task = workspace?.tasks.find(task => task.id === id); return task && !keys.has(taskVersionKey(task));})) {
        // An absent baseline cannot distinguish a later permanent deletion from a new edit.
        unsafe.push('data.workspaces[' + original.id + '].tasks[' + id + '].references');
        continue;
      }
      const choice = resolvedTaskChoice(original.taskConflicts?.find(record => record.id === id), records, keys);
      if (!choice) continue;
      const resolved = branches.flatMap((workspace, index) => records[index]?.resolved === choice ? [workspace?.tasks.find(task => task.id === id)] : []);
      const merger = new Merger(undefined), reference = merger.merge(baseTask, resolved, 'task');
      // Different new edits after the same choice still require a new task conflict.
      if (merger.conflicts.size) continue;
      branches.forEach((workspace, index) => {
        const record = records[index], task = workspace?.tasks.find(task => task.id === id);
        if (record?.resolved || (!record && !keys.has(taskVersionKey(task ?? null)))) return;
        const normalized = reference === undefined ? undefined : keys.has(taskVersionKey(task ?? null)) ? structuredClone(reference) as Task
          : new Merger(0).merge(baseTask, [reference, task], 'task') as Task | undefined;
        const projected = (projections[index]['workspaces'] as OrbitBackup['data']['workspaces']).find(value => value.id === original.id);
        if (!projected) return;
        if (normalized) projected.tasks = projected.tasks.some(value => value.id === id) ? projected.tasks.map(value => value.id === id ? normalized : value) : [...projected.tasks, normalized];
        else projected.tasks = projected.tasks.filter(value => value.id !== id);
      });
    }
  }
  return unsafe;
}

/** All branches compare with the same base. Explicit preference affects conflicting fields only. */
export function mergeDriveBackups(baseInput: OrbitBackup, inputs: OrbitBackup[], preferred?: number, deferTasks = false): {backup: OrbitBackup; conflicts: string[]} {
  if (!inputs.length || (preferred !== undefined && (!Number.isInteger(preferred) || preferred < 0 || preferred >= inputs.length))) throw new Error('請提供有效的整併內容。');
  const base = readBackup(baseInput), backups = inputs.map(readBackup), local = backups[0], selected = backups[preferred ?? 0];
  if (backups.some(backup => backup.kind !== base.kind)) return {backup: local, conflicts: ['scope']};
  const versionKeys = new Map<string, (string | undefined)[]>();
  const pendingTasks = new Map<string, (TaskConflict | undefined)[]>();
  for (const workspace of base.data.workspaces) for (const id of new Set(backups.flatMap(backup => backup.data.workspaces.find(value => value.id === workspace.id)?.taskConflicts?.map(conflict => conflict.id) ?? []))) {
    const path = 'data.workspaces[' + workspace.id + '].tasks[' + id + ']';
    pendingTasks.set(path, backups.map(backup => backup.data.workspaces.find(value => value.id === workspace.id)?.taskConflicts?.find(conflict => conflict.id === id)));
    versionKeys.set(path, backups.map(backup => {
      const current = backup.data.workspaces.find(value => value.id === workspace.id), conflict = current?.taskConflicts?.find(value => value.id === id);
      const choice = conflict?.versions.find(version => version.key === conflict.resolved);
      return choice && taskVersionKey(choice.task) === taskVersionKey(current?.tasks.find(task => task.id === id) ?? null) ? choice.key : undefined;
    }));
  }
  const projections = backups.map(content);
  const unsafe = deferTasks ? normalizeResolvedTasks(base, backups, projections) : [];
  const merger = new Merger(preferred, deferTasks, versionKeys, pendingTasks), merged = merger.merge(content(base), projections, 'data') as RecordValue;
  unsafe.forEach(path => merger.conflicts.add(path));
  let workspaces = merged['workspaces'] as OrbitBackup['data']['workspaces'];
  workspaces = workspaces.map(workspace => {
    const original = base.data.workspaces.find(value => value.id === workspace.id), branchWorkspaces = backups.map(backup => backup.data.workspaces.find(value => value.id === workspace.id));
    const ids = new Set(branchWorkspaces.flatMap(value => value?.taskConflicts?.map(conflict => conflict.id) ?? []));
    for (const task of new Set([...(original?.tasks ?? []), ...branchWorkspaces.flatMap(value => value?.tasks ?? [])].map(task => task.id))) if (merger.taskConflicts.has('data.workspaces[' + workspace.id + '].tasks[' + task + ']')) ids.add(task);
    const records: TaskConflict[] = [];
    let tasks = workspace.tasks;
    for (const id of ids) {
      const existing = branchWorkspaces.map(value => value?.taskConflicts?.find(conflict => conflict.id === id)).filter((value): value is TaskConflict => !!value);
      const generated = merger.taskConflicts.get('data.workspaces[' + workspace.id + '].tasks[' + id + ']');
      const variants = new Map<string, TaskConflictVersion>();
      for (const record of [...existing, ...(generated ? [generated] : [])]) for (const version of record.versions) {
        const previous = variants.get(version.key);
        if (!previous || canonical(version.task) > canonical(previous.task)) variants.set(version.key, structuredClone(version));
      }
      const resolution = resolvedTaskChoice(original?.taskConflicts?.find(record => record.id === id), existing, new Set(variants.keys()));
      const baseTask = original?.tasks.find(task => task.id === id), current = tasks.find(task => task.id === id);
      for (const version of variants.values()) if (!resolution && version.task && baseTask && current) version.task = new Merger(0).merge(baseTask, [version.task, current], 'task') as unknown as Task;
      // The task itself carries later edits; resolved snapshots only retain the decision history.
      if (variants.size >= 2) records.push({id, versions: [...variants.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0), ...(resolution ? {resolved: resolution} : {})});
    }
    return {...workspace, tasks, ...(records.length ? {taskConflicts: records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)} : {})};
  });
  // Interdependent changes can be individually valid yet form an invalid schedule or reference.
  workspaces = workspaces.flatMap(workspace => {
    if (readWorkspaceState({version: 1, activeWorkspaceId: workspace.id, workspaces: [workspace]})) return [workspace];
    merger.conflicts.add('data.workspaces[' + workspace.id + '].references');
    const fallback = selected.data.workspaces.find(value => value.id === workspace.id);
    return fallback ? [fallback] : [];
  });
  const workspaceIds = workspaces.map(workspace => workspace.id);
  const identities = new Map(backups.flatMap(backup => backup.kind === 'full' ? backup.google?.sources ?? [] : backup.calendarSources ?? []).reverse().map(source => [calendarKey(source), source.id]));
  let calendars = (merged['sources'] as CalendarSource[]).map(source => ({...source, id: identities.get(calendarKey(source)) ?? crypto.randomUUID()}));
  if (calendars.some(source => source.workspaceIds.some(id => !workspaceIds.includes(id)))) {
    merger.conflicts.add('data.sources.references');
    calendars = sources(selected).map(source => ({...source, id: identities.get(calendarKey(source))!, workspaceIds: source.workspaceIds.filter(id => workspaceIds.includes(id))})).filter(source => source.workspaceIds.length);
  }
  const candidate: OrbitBackup = {...local, data: {version: 1, activeWorkspaceId: workspaceIds.includes(local.data.activeWorkspaceId) ? local.data.activeWorkspaceId : workspaceIds[0], workspaces},
    ...(local.kind === 'full' ? {preferences: merged['preferences'] as OrbitBackup['preferences'], reminders: merged['reminders'] as OrbitBackup['reminders'],
      google: {...(local.google ?? DEFAULT_GOOGLE), refreshMinutes: merged['refreshMinutes'] as typeof DEFAULT_GOOGLE.refreshMinutes ?? DEFAULT_GOOGLE.refreshMinutes, sources: calendars},
      ...(local.drive ? {drive: {...local.drive, workspaceIds: local.drive.workspaceIds.filter(id => workspaceIds.includes(id))}} : {})}
      : {calendarSources: calendars})};
  try {return {backup: readBackup(candidate), conflicts: [...merger.conflicts]};}
  catch {return {backup: selected, conflicts: [...merger.conflicts, 'data.references']};}
}
