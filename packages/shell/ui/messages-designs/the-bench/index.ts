import type { MessagesDesign } from '../contract';
import { TheBench } from './TheBench';

/** Spatial Messages workbench with design-owned relationship inspection. */
export const theBenchMessagesDesign: MessagesDesign = {
  id: 'the-bench',
  label: 'The Bench',
  ownsInspector: true,
  View: TheBench,
};
