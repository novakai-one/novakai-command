/**
 * tests/capability/missionRooms.ts — a REFERENCE SECOND CAPABILITY: the
 * stand-in Mission Rooms capability for the Plan §15 P4 proof
 * ("Mission Rooms references Threads/Messages by ID and posts mission events —
 * without owning or copying Messages"). This is NOT production code and NOT a
 * test double of Messaging: it is a real (tiny) capability with its own
 * truth, its own record store, and its own logic, crossing only the Messaging
 * public contract — the same discipline as the P2/P3 external-chief client.
 *
 * What it owns and what it references (Plan §10 ownership map, DEC-04/06):
 *  - OWNS: mission truth — which missions exist and who is on each (its own
 *    roster registry below). That truth reaches Messaging ONLY as membership
 *    adapter config (declareRooms() → MembershipRoomConfig[]) — the
 *    DEC-07-style pattern: capability data in adapter config, never in
 *    Messaging core. The composition root provisions the room Threads from
 *    that config at startup (Store-Seam §11.4).
 *  - REFERENCES: Messaging Threads and Messages BY ID ONLY. Its event records
 *    hold `threadId`/`messageId` references — never copies of Message or
 *    Thread content (the anti-copy rule: Messaging is the single authority
 *    for those facts, Plan §10). Its room view is RENDERED from Messaging
 *    queries (getMessages) joined with its own ID references — it never
 *    needed to copy.
 *  - POSTS: mission events into its room Threads through the public
 *    SendMessage door — a mission event is just a Message body from
 *    Messaging's perspective (idempotent by a clientMessageId derived from
 *    the capability's own eventId, DEC-13).
 *
 * Import discipline (G4, MSG-013): this module imports NOTHING private. Its
 * only Messaging imports are TYPE-ONLY references to the published contract
 * (erased at compile time — the compiled module has ZERO runtime messaging
 * imports; the P4 architecture assertion verifies exactly that, mirroring
 * the external-chief compiled-import proof).
 *
 * The port (MissionMessagingPort) is the narrow slice of the public contract
 * this capability consumes — the capability-to-capability contract (Plan §5).
 * Two adapters exist in the P4 tests: one over the embedded session door, one
 * over the DEC-17 wire protocol client. Same capability, both integration
 * modes, no per-mode logic HERE.
 */

import type {
  MembershipRoomConfig,
  MessageId,
  PersonId,
  SendAccepted,
  Thread,
  ThreadId,
} from "../../public/index.js";
import type { Message } from "../../public/index.js";

/** This capability's authority domain — the room key's authority half (DEC-04). */
export const MISSION_ROOMS_AUTHORITY = "mission-rooms-capability";

/** The capability's own event vocabulary (Messaging never interprets it). */
export type MissionEventKind = "mission-started" | "phase-completed" | "mission-completed";

/** A mission this capability owns: its ID plus its roster (room truth). */
export interface MissionDeclaration {
  /** The mission's ID in THIS capability (the room key's externalId half). */
  missionId: string;
  /** The mission's roster — membership truth owned HERE, never by Messaging. */
  members: PersonId[];
}

/**
 * The capability's own durable record for one posted mission event. By
 * CONVENTION it holds ID references + the capability's own authored metadata
 * only — nothing structural prevents a copy (`payloadSummary` is a free
 * string, and this interface does not pretend otherwise). The anti-copy
 * guarantee lives in the render path: the room view is rebuilt from
 * Messaging's GetMessages on every render (Messaging is the render
 * authority, Plan §10), so this store is never the source of Message/Thread
 * content. The P4 test asserts the convention at the VALUE level: no field
 * here holds a posted Message body.
 */
export interface MissionEventRecord {
  eventId: string;
  threadId: ThreadId;
  messageId: MessageId;
  kind: MissionEventKind;
  /** The capability's own authored summary metadata (NOT the Message body). */
  payloadSummary: string;
  /** SendAccepted.duplicate: Messaging had already accepted this event (a retry, DEC-13). */
  duplicate: boolean;
}

/**
 * The narrow slice of the Messaging public contract this capability consumes.
 * Every operation here names a published contract operation
 * (ListThreadsForPerson, GetMessages, SendMessage) — nothing else exists
 * for a second capability to lean on.
 */
export interface MissionMessagingPort {
  /** ListThreadsForPerson for the capability's own authenticated principal. */
  listThreads(): Promise<Thread[]>;
  /** GetMessages — the room Thread's ordered history (Messaging's truth). */
  getMessages(threadId: ThreadId): Promise<Message[]>;
  /** SendMessage — the only door a mission event ever crosses. */
  send(input: {
    address: string;
    body: { text: string };
    priority: "normal" | "urgent";
    clientMessageId: string;
  }): Promise<SendAccepted>;
}

/**
 * One rendered entry of the capability's room view: its own event reference
 * joined with the Message content READ BACK FROM MESSAGING. `text` is
 * Messaging's authoritative content — the capability holds no copy of it.
 */
export interface RenderedMissionEvent {
  eventId: string;
  kind: MissionEventKind;
  /** The Message body text as served by Messaging's GetMessages. */
  text: string;
}

export class MissionRoomsCapability {
  /** Room truth: missionId → declaration (this capability is the authority). */
  private readonly missions = new Map<string, MissionDeclaration>();
  /** Learned references: missionId → the provisioned room Thread's ID. */
  private readonly threadIds = new Map<string, ThreadId>();
  /** The capability's own record store: eventId → ID-references + metadata. */
  private readonly eventStore = new Map<string, MissionEventRecord>();
  private port: MissionMessagingPort | undefined;
  /** STAND-IN ONLY: in-memory fallback event identity — see the postEvent caveat. */
  private eventCounter = 0;

  constructor(missions: MissionDeclaration[]) {
    for (const mission of missions) {
      if (this.missions.has(mission.missionId)) {
        throw new Error(`duplicate mission ${mission.missionId} in the mission registry`);
      }
      this.missions.set(mission.missionId, mission);
    }
  }

  /**
   * The DEC-07-style pattern: this capability's room/roster truth rendered as
   * membership ADAPTER CONFIG. The host's composition root consumes it
   * (EmbeddedMessagingOptions.membership) and provisions each room's Thread
   * at startup (Store-Seam §11.4). Messaging core never sees mission data.
   */
  declareRooms(): MembershipRoomConfig[] {
    return [...this.missions.values()].map((mission) => ({
      threadKind: "mission",
      authority: MISSION_ROOMS_AUTHORITY,
      externalId: mission.missionId,
      members: [...mission.members],
    }));
  }

  /**
   * Connect to Messaging and learn the provisioned room Thread IDs through
   * the public surface (ListThreadsForPerson — the §11.4 "the owner learns
   * the minted threadId through reads" path). Stores threadIds ONLY.
   */
  async attach(port: MissionMessagingPort): Promise<void> {
    this.port = port;
    const threads = await port.listThreads();
    for (const mission of this.missions.values()) {
      const thread = threads.find(
        (candidate) =>
          candidate.threadKind === "mission" &&
          candidate.room?.authority === MISSION_ROOMS_AUTHORITY &&
          candidate.room.externalId === mission.missionId,
      );
      if (thread === undefined) {
        throw new Error(
          `mission ${mission.missionId}: no provisioned room Thread found — ` +
            `the host must declare this capability's rooms in the membership config (Store-Seam §11.4)`,
        );
      }
      this.threadIds.set(mission.missionId, thread.id);
    }
  }

  /**
   * Post a mission event into the mission's room Thread — through the public
   * SendMessage door, as the capability's authenticated principal. From
   * Messaging's perspective the event is just a Message body; from this
   * capability's perspective the Message is a REFERENCE (messageId) it stores
   * alongside its own metadata. clientMessageId derives from the capability's
   * OWN event identity (eventId), so a retried post of the same event gets
   * the original acceptance back instead of duplicating (DEC-13).
   *
   * HONEST STAND-IN CAVEAT: when `eventId` is omitted, this reference
   * implementation derives one from an IN-MEMORY process counter — unique
   * within a single run, but it collides with pre-crash IDs after a restart.
   * A REAL capability must derive clientMessageId from its DURABLE event
   * identity (e.g. its persisted event log's next ID / last eventId), never
   * from a process counter — pass it explicitly here.
   */
  async postEvent(
    missionId: string,
    kind: MissionEventKind,
    payloadSummary: string,
    eventId?: string,
  ): Promise<MissionEventRecord> {
    const threadId = this.requireThread(missionId);
    if (eventId === undefined) {
      this.eventCounter += 1;
      eventId = `${missionId}/evt_${this.eventCounter}`;
    }
    const accepted = await this.requirePort().send({
      address: `thread:${threadId}`,
      body: { text: `[${kind}] ${payloadSummary}` },
      priority: "normal",
      clientMessageId: `mission-event:${eventId}`,
    });
    const record: MissionEventRecord = {
      eventId,
      threadId,
      messageId: accepted.messageId,
      kind,
      payloadSummary,
      duplicate: accepted.duplicate === true,
    };
    this.eventStore.set(eventId, record);
    return record;
  }

  /**
   * The §15 integrity assertion: re-render the room view PURELY from
   * Messaging's GetMessages (authoritative content) + this capability's own
   * ID references (which event each Message is). Entries appear in Thread
   * order (Messaging's sequence); Messages this capability did not post are
   * not its events and are skipped.
   */
  async renderRoomView(missionId: string): Promise<RenderedMissionEvent[]> {
    const threadId = this.requireThread(missionId);
    const messages = await this.requirePort().getMessages(threadId);
    const byMessageId = new Map<MessageId, MissionEventRecord>(
      [...this.eventStore.values()].map((record) => [record.messageId, record]),
    );
    const view: RenderedMissionEvent[] = [];
    for (const message of messages) {
      const record = byMessageId.get(message.id);
      if (record === undefined) continue;
      view.push({ eventId: record.eventId, kind: record.kind, text: message.body.text });
    }
    return view;
  }

  /** The provisioned room Thread ID for a mission (a learned reference). */
  threadIdFor(missionId: string): ThreadId {
    return this.requireThread(missionId);
  }

  /** Read-only view of the capability's own record store (ID references only). */
  records(): readonly MissionEventRecord[] {
    return [...this.eventStore.values()];
  }

  private requirePort(): MissionMessagingPort {
    if (this.port === undefined) {
      throw new Error("mission-rooms capability is not attached to Messaging — call attach() first");
    }
    return this.port;
  }

  private requireThread(missionId: string): ThreadId {
    const threadId = this.threadIds.get(missionId);
    if (threadId === undefined) {
      throw new Error(`mission ${missionId} has no provisioned room Thread — call attach() first`);
    }
    return threadId;
  }
}
