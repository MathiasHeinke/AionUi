export const shouldShowPendingAssistantActivity = (
  isProcessing: boolean,
  localSubmitting: boolean,
  latestMessagePosition?: string
): boolean =>
  isProcessing && (localSubmitting || latestMessagePosition === undefined || latestMessagePosition === 'right');
