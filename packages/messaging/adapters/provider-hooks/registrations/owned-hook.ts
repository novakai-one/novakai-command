/** True only for a Novakai Agent-identity hook command, across executable upgrades. */
export const isNovakaiIdentityCommand = (value: unknown): value is string =>
  typeof value === 'string'
  && value.includes('NOVAKAI_AGENT_ID')
  && value.includes('novakai-agent-identity');
