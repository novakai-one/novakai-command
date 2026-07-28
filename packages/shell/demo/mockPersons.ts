// shell/demo/mockPersons.ts — G3 glitch fix: every spawned mock agent used to
// share ONE messaging person (person_mock), so all mock conversations resolved
// to the same thread and agents replied into each other's chats. Each mock
// spawn now gets a UNIQUE provisioned person — same pool pattern as
// createConversation's person_pool0..9.

export const MOCK_POOL_SIZE = 10;
export const mockAgentPersonId = (i: number): string => `person_mockagent${i}`;
export const mockAgentToken = (i: number): string => `demo-token-mockagent-${i}`;

/** Principals block for the messaging authority config. */
export function mockAgentPrincipals(): Array<{ token: string; personId: string; roles: ['Worker'] }> {
  return Array.from({ length: MOCK_POOL_SIZE }, (_, i) => ({
    token: mockAgentToken(i), personId: mockAgentPersonId(i), roles: ['Worker'] as ['Worker'],
  }));
}

/** Hands out a unique provisioned person per mock spawn; null when exhausted. */
export class MockPersonPool {
  private next = 0;
  constructor(readonly size: number = MOCK_POOL_SIZE) {}
  assign(): { personId: string; token: string } | null {
    if (this.next >= this.size) return null;
    const i = this.next++;
    return { personId: mockAgentPersonId(i), token: mockAgentToken(i) };
  }
  get used(): number { return this.next; }
}
