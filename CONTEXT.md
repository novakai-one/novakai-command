# Novakai Command

Novakai Command is a company workspace where people, projects, missions, conversations, and evidence share one continuous history.

## Team

**Person**:
A stable human or AI teammate identity. A Person retains the same relationships and conversation history when their runtime changes.
_Avoid_: Agent, process, session

**Presence**:
A Person's current live availability through an agent process or human connection. A Person may have no Presence or more than one Presence without changing identity.
_Avoid_: Person, teammate

**Authority**:
The decisions and actions a Person is trusted to make within a company or mission.
_Avoid_: Status, role label

## Work

**Project**:
A durable product or codebase territory containing related missions and places.
_Avoid_: Workspace, repository

**Place**:
A meaningful location within a Project where work and evidence live, such as a module, service, or runtime boundary.
_Avoid_: File, panel, tab

**Mission**:
An owned unit of intended change with status, participants, causal history, and evidence.
_Avoid_: Ticket, issue, task

**Artifact**:
Evidence produced or used by a Mission, such as a diff, terminal run, decision, or design revision.
_Avoid_: Attachment, card

## Interaction

**Bench**:
A Person's spatial working surface within the World, where Threads and related evidence are placed and acted upon.
_Avoid_: Inbox, Conversation Library, overlay

**Placement**:
The relationship that makes one object present at a meaningful position on a Bench. Removing a Placement makes the object absent from that Bench without deleting or archiving its identity or history.
_Avoid_: Recent item, search result, reveal

**Instrument**:
A temporary control that helps a Person find, place, locate, or focus objects on a Bench without becoming the surface where those objects are used.
_Avoid_: Workspace, owner, inbox

## Memory

**Thread**:
The canonical ordered history of a conversation or mission. Every message belongs to exactly one Thread, while interfaces may present that Thread in many places.
_Avoid_: Feed, transcript copy, chat surface

**Thread Item**:
A causally ordered contribution to a Thread, such as a Message, Work Update, Delegation Event, Decision Request, Decision Resolution, or Causal Reference.
_Avoid_: Feed row, card, activity

**Direct Thread**:
A Thread shared by exactly two People. It remains stable across projects, runtime restarts, and interface changes.
_Avoid_: DM lane, agent chat

**Room**:
A named multi-person Thread with explicit membership.
_Avoid_: Channel, group feed

**Mission Thread**:
The primary Thread that records a Mission's conversation, decisions, and causal development.
_Avoid_: Activity log, ticket comments

**Message**:
A single contribution owned by one Thread and one authoring Person.
_Avoid_: Envelope, projection

**Work Update**:
A factual change in work state caused by another Thread Item. It retains its initiating cause when the active Presence or runtime changes.
_Avoid_: Status badge, typing indicator

**Delegation Event**:
A Mission Event that assigns authority or responsibility from one Person to another.
_Avoid_: Assignment row, notification

**Decision Request**:
A Thread Item asking a Person with the required Authority to choose among explicit options.
_Avoid_: Approval card, prompt

**Decision Resolution**:
A Thread Item recording who answered a Decision Request, what they chose, and which request caused it.
_Avoid_: Button state, resolved flag

**Mission Event**:
A causally ordered fact in a Mission's history, including references to relevant messages and artifacts.
_Avoid_: Timeline row, copied message

**Causal Reference**:
A link from a Mission Event to an original Message or Artifact that preserves its source identity and context.
_Avoid_: Copy, cross-post, duplicate

## Company

**World**:
The navigable model of the company, its projects, people, missions, and places.
_Avoid_: Canvas, map view
