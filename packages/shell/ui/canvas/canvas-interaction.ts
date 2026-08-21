/** The axis along which designs permit nodes to move. */
export type CanvasNodeDragAxis = 'both' | 'horizontal' | 'vertical';

/** Direction used when a design treats scrolling as canvas movement. */
export type CanvasScrollPanDirection = 'free' | 'horizontal' | 'vertical';

/** Framework-neutral interaction choices available to disposable spatial designs. */
export type WorldCanvasInteraction = {
  nodesDraggable?: boolean;
  nodeDragAxis?: CanvasNodeDragAxis;
  elementsSelectable?: boolean;
  selectionOnDrag?: boolean;
  panOnDrag?: boolean | number[];
  panOnScroll?: boolean;
  panOnScrollDirection?: CanvasScrollPanDirection;
  zoomOnScroll?: boolean;
  zoomOnPinch?: boolean;
  zoomOnDoubleClick?: boolean;
  minZoom?: number;
  maxZoom?: number;
  translateExtent?: [[number, number], [number, number]];
  nodeExtent?: [[number, number], [number, number]];
  rememberNodePositions?: boolean;
  rememberViewport?: boolean;
};

/** Complete interaction values consumed by the React Flow adapter. */
export type ResolvedWorldCanvasInteraction = {
  nodesDraggable: boolean;
  nodeDragAxis: CanvasNodeDragAxis;
  elementsSelectable: boolean;
  selectionOnDrag: boolean;
  panOnDrag: boolean | number[];
  panOnScroll: boolean;
  panOnScrollDirection: CanvasScrollPanDirection;
  zoomOnScroll: boolean;
  zoomOnPinch: boolean;
  zoomOnDoubleClick: boolean;
  minZoom: number;
  maxZoom: number;
  translateExtent?: [[number, number], [number, number]];
  nodeExtent?: [[number, number], [number, number]];
  rememberNodePositions: boolean;
  rememberViewport: boolean;
};

/** Fills omitted interaction choices with the established WorldCanvas behaviour. */
export function resolveWorldCanvasInteraction(
  interaction: WorldCanvasInteraction = {},
): ResolvedWorldCanvasInteraction {
  return {
    nodesDraggable: interaction.nodesDraggable ?? true,
    nodeDragAxis: interaction.nodeDragAxis ?? 'both',
    elementsSelectable: interaction.elementsSelectable ?? true,
    selectionOnDrag: interaction.selectionOnDrag ?? false,
    panOnDrag: interaction.panOnDrag ?? true,
    panOnScroll: interaction.panOnScroll ?? false,
    panOnScrollDirection: interaction.panOnScrollDirection ?? 'free',
    zoomOnScroll: interaction.zoomOnScroll ?? true,
    zoomOnPinch: interaction.zoomOnPinch ?? true,
    zoomOnDoubleClick: interaction.zoomOnDoubleClick ?? false,
    minZoom: interaction.minZoom ?? 0.2,
    maxZoom: interaction.maxZoom ?? 2.5,
    translateExtent: interaction.translateExtent,
    nodeExtent: interaction.nodeExtent,
    rememberNodePositions: interaction.rememberNodePositions ?? true,
    rememberViewport: interaction.rememberViewport ?? true,
  };
}
