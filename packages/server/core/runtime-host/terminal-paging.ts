// A5-05 made `listTerminalSessions` a bounded page. Two host-internal readers
// need every session rather than a page of them — the recovery census, whose
// whole job is to miss nothing, and the output follower, which would silently
// stop following the 201st tab.
//
// So the cursor loop is spelled ONCE, here, and both read through it. The CLI
// is forbidden to re-page (A5-01); the host is not, and this is why the
// distinction matters: the host is the caller that has to be complete.
import type { AuthenticatedPrincipal, B3Result } from '@novakai/foundation/contract';
import { b3ok } from '@novakai/foundation/contract';
import type {
  TerminalContract, TerminalSessionFilter, TerminalSessionView,
} from '../../../terminal/contract/index.js';

/** The page size the host asks for; A5-05's ceiling, so the loop is shortest. */
const PAGE = 200;

export async function readAllTerminalSessions(
  terminal: Pick<TerminalContract, 'listTerminalSessions'>,
  principal: AuthenticatedPrincipal,
  filter: Omit<TerminalSessionFilter, 'cursor' | 'limit'> = {},
): Promise<B3Result<readonly TerminalSessionView[]>> {
  const views: TerminalSessionView[] = [];
  let cursor: TerminalSessionFilter['cursor'];
  do {
    const page = await terminal.listTerminalSessions(principal, {
      ...filter, ...(cursor === undefined ? {} : { cursor }), limit: PAGE,
    });
    if (!page.ok) return page;
    views.push(...page.value.items);
    cursor = page.value.nextCursor;
  } while (cursor !== undefined);
  return b3ok(views);
}
