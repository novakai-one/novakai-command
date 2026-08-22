export type ConversationInstrumentId = string;

export type ConversationCanvasState = 'available' | 'placed';
export type ConversationGroupBy = 'date' | 'project' | 'mission' | 'task' | 'canvas' | 'none';
export type ConversationOrder = 'newest' | 'oldest';
export type ConversationDateFilter = 'any' | 'seven-days' | 'thirty-days' | 'this-year';
export type ConversationRelationKind = 'project' | 'mission' | 'task';

type ConversationPersonSource = {
  readonly personId: ConversationInstrumentId;
  readonly label: string;
  readonly initials: string;
  readonly status: string;
};

type ConversationMessageSource = {
  readonly messageId: ConversationInstrumentId;
  readonly body: string;
  readonly createdAt: string;
};

export type ConversationRelationSource = {
  readonly relationId: ConversationInstrumentId;
  readonly kind: ConversationRelationKind;
  readonly label: string;
  readonly relation: string;
};

/** Plain read model consumed without graph, canvas, store, or framework objects. */
export type ConversationInstrumentSource = {
  readonly threadId: ConversationInstrumentId;
  readonly title: string;
  readonly createdAt: string;
  readonly people: readonly ConversationPersonSource[];
  readonly relations: readonly ConversationRelationSource[];
  readonly messages: readonly ConversationMessageSource[];
  readonly lastActivityAt: string;
  readonly unreadCount: number;
  readonly blocked: boolean;
  readonly canvasState: ConversationCanvasState;
  readonly canRemove: boolean;
};

export type ConversationInstrumentViewOptions = {
  readonly query: string;
  readonly groupBy: ConversationGroupBy;
  readonly order: ConversationOrder;
  readonly relationId: string;
  readonly dateFilter: ConversationDateFilter;
};

/** One intentional handoff from the Instrument to the Bench. */
export type ConversationInstrumentAction = {
  readonly kind: 'select' | 'locate' | 'begin-placement' | 'remove';
  readonly threadId: ConversationInstrumentId;
};

export type ConversationInstrumentProps = {
  readonly sources: readonly ConversationInstrumentSource[];
  readonly selectedThreadId: ConversationInstrumentId | null;
  readonly trailCount: number;
  readonly onAction: (action: ConversationInstrumentAction) => void;
  readonly onCreate: () => void;
  readonly onClearTrails: () => void;
};
