import type { ConversationGroupBy, ConversationRelationKind } from './contract';
import type { ConversationInstrumentItem } from './model';

type ConversationSectionIdentity = {
  readonly id: string;
  readonly label: string | null;
};

type ConversationSectionRule = ConversationSectionIdentity & {
  readonly includes: (item: ConversationInstrumentItem) => boolean;
};

export type ConversationSectionRecipe = {
  readonly rules: readonly ConversationSectionRule[];
  readonly fallback: ConversationSectionIdentity;
};

export type ConversationSectionView = ConversationSectionIdentity & {
  readonly items: readonly ConversationInstrumentItem[];
};

function dateKey(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(value));
}

function canonicalRelation(
  item: ConversationInstrumentItem,
  kind: ConversationRelationKind,
) {
  const matches = item.relations.filter((relation) => relation.kind === kind);
  return matches.find((relation) => relation.relation === 'belongsTo') ?? matches[0] ?? null;
}

function dateRecipe(items: readonly ConversationInstrumentItem[]): ConversationSectionRecipe {
  const dates = new Map<string, string>();
  for (const item of items) {
    const key = dateKey(item.lastActivityAt);
    if (key && !dates.has(key)) dates.set(key, dateLabel(item.lastActivityAt));
  }
  return {
    rules: [...dates].map(([key, label]) => ({
      id: `date:${key}`,
      label,
      includes: (item) => dateKey(item.lastActivityAt) === key,
    })),
    fallback: { id: 'date:unknown', label: 'Date unavailable' },
  };
}

function relationRecipe(
  items: readonly ConversationInstrumentItem[],
  kind: ConversationRelationKind,
): ConversationSectionRecipe {
  const relations = new Map<string, string>();
  for (const item of items) {
    const relation = canonicalRelation(item, kind);
    if (relation) relations.set(relation.relationId, relation.label);
  }
  const ordered = [...relations].sort((left, right) => left[1].localeCompare(right[1]));
  return {
    rules: ordered.map(([id, label]) => ({
      id: `${kind}:${id}`,
      label,
      includes: (item) => canonicalRelation(item, kind)?.relationId === id,
    })),
    fallback: { id: `${kind}:none`, label: `No ${kind}` },
  };
}

/** Creates editable labels and formulas without placing taxonomy policy in React. */
export function sectionRecipeFor(
  groupBy: ConversationGroupBy,
  items: readonly ConversationInstrumentItem[],
): ConversationSectionRecipe {
  if (groupBy === 'date') return dateRecipe(items);
  if (groupBy === 'project' || groupBy === 'mission' || groupBy === 'task') {
    return relationRecipe(items, groupBy);
  }
  if (groupBy === 'canvas') {
    return {
      rules: [{
        id: 'canvas:placed',
        label: 'On canvas',
        includes: (item) => item.canvasState === 'placed',
      }],
      fallback: { id: 'canvas:available', label: 'Off canvas' },
    };
  }
  return { rules: [], fallback: { id: 'all', label: null } };
}

/** Partitions once in input order, so a conversation cannot appear twice. */
export function partitionConversationItems(
  items: readonly ConversationInstrumentItem[],
  recipe: ConversationSectionRecipe,
): ConversationSectionView[] {
  const definitions = [...recipe.rules, recipe.fallback];
  if (new Set(definitions.map((definition) => definition.id)).size !== definitions.length) {
    throw new Error('Conversation section IDs must be unique.');
  }
  const itemsBySection = new Map(definitions.map((definition) => (
    [definition.id, [] as ConversationInstrumentItem[]]
  )));
  for (const item of items) {
    const owner = recipe.rules.find((rule) => rule.includes(item)) ?? recipe.fallback;
    itemsBySection.get(owner.id)?.push(item);
  }
  return definitions.flatMap((definition) => {
    const sectionItems = itemsBySection.get(definition.id) ?? [];
    return sectionItems.length > 0 ? [{ ...definition, items: sectionItems }] : [];
  });
}
