/**
 * ui/messages-designs/registry.ts — the Messages design registry.
 * Port of sandbox designs/design-registry.ts (createDesignRegistry, unchanged)
 * + rooms/Messages/messages-design-registry.ts, narrowed to the designs that
 * have actually been ported. Adding a design = port its folder + one entry in
 * DESIGNS. Unknown or missing ids deliberately fall back to the default —
 * a corrupt stored id must never crash the Messages room (M1-06).
 */
import type { MessagesDesign, RoomDesign } from './contract';
import { theBenchMessagesDesign } from './the-bench';

type DesignRegistry<DesignProps> = {
  readonly defaultDesignId: string;
  list(): readonly RoomDesign<DesignProps>[];
  resolve(requestedId?: string | null): RoomDesign<DesignProps>;
};

function findDuplicateDesignId<DesignProps>(
  designs: readonly RoomDesign<DesignProps>[],
): string | null {
  const registeredIds = new Set<string>();

  for (const design of designs) {
    if (registeredIds.has(design.id)) return design.id;
    registeredIds.add(design.id);
  }

  return null;
}

/** Creates an immutable registry with unique IDs and a deliberate fallback design. */
export function createDesignRegistry<DesignProps>(
  designs: readonly RoomDesign<DesignProps>[],
  defaultDesignId: string,
): DesignRegistry<DesignProps> {
  const registeredDesigns = Object.freeze([...designs]);
  const duplicateDesignId = findDuplicateDesignId(registeredDesigns);

  if (duplicateDesignId) {
    throw new Error(`Room design ID "${duplicateDesignId}" is registered more than once.`);
  }

  const defaultDesign = registeredDesigns.find((design) => design.id === defaultDesignId);
  if (!defaultDesign) {
    throw new Error(`Default Room design "${defaultDesignId}" is not registered.`);
  }

  return {
    defaultDesignId,
    list: () => registeredDesigns,
    resolve: (requestedId) => (
      registeredDesigns.find((design) => design.id === requestedId) ?? defaultDesign
    ),
  };
}

const DESIGNS: readonly MessagesDesign[] = [
  theBenchMessagesDesign,
];

const messagesDesignRegistry = createDesignRegistry(DESIGNS, theBenchMessagesDesign.id);

/** Lists every Messages design available to the picker. */
export function listMessagesDesigns(): readonly MessagesDesign[] {
  return messagesDesignRegistry.list();
}

/** Unknown and missing design ids deliberately fall back to The Bench. */
export function resolveMessagesDesign(requestedId?: string | null): MessagesDesign {
  return messagesDesignRegistry.resolve(requestedId);
}
