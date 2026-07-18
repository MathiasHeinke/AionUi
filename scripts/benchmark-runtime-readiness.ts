export type PackagedRuntimeReadiness = {
  ready: boolean;
  commandEveRuntimeReady: boolean;
  managedRuntimeSettled: boolean;
  failureReason: string | null;
};

export function inspectPackagedRuntimeReadiness(lines: string[]): PackagedRuntimeReadiness {
  let commandEveRuntimeReady = false;
  let managedRuntimeSettled = false;
  let failureReason: string | null = null;

  for (const line of lines) {
    if (line.includes('Runtime bootstrap ready:')) {
      commandEveRuntimeReady = true;
    } else if (line.includes('Runtime bootstrap failed:')) {
      failureReason = 'Command EVE runtime bootstrap failed';
    }

    if (line.includes('startup: managed runtime background preparation completed')) {
      managedRuntimeSettled = true;
    } else if (line.includes('startup: managed runtime background preparation failed')) {
      failureReason = 'managed runtime background preparation failed';
    }
  }

  return {
    ready: commandEveRuntimeReady && managedRuntimeSettled && !failureReason,
    commandEveRuntimeReady,
    managedRuntimeSettled,
    failureReason,
  };
}
