/**
 * AI 面板帧的旁听者（ai-remote 等用）：网页版处理每一帧之前，出错接续（recovery.ts）先看；没被接管的帧再交给这里登记的旁听者。
 * 旁听者只观察、不拦截；要在网页版渲染之后动手的自己排到下一轮事件循环。
 */
export type FrameObserver = (panel: unknown, frame: Record<string, unknown>) => void;

const observers = new Set<FrameObserver>();

export function onAgentFrame(observer: FrameObserver): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

export function notifyAgentFrame(panel: unknown, frame: Record<string, unknown>): void {
  for (const observer of observers) {
    try {
      observer(panel, frame);
    } catch (error) {
      console.error('[cloudssh-agent]', error);
    }
  }
}
